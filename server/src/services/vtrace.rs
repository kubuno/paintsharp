//! Raster → vector tracing on the visioncortex engine.
//!
//! The clustering/curve-fitting pipeline below is vendored from VTracer
//! (https://github.com/visioncortex/vtracer, © Tsang Hao Fung, MIT/Apache-2.0)
//! so this module only depends on the `visioncortex` crate — the `vtracer`
//! wrapper crate drags in clap 2 and image 0.23, which we don't want. File I/O
//! and CLI parts were dropped; the SVG serialisation was reworked to emit a
//! plain <svg> body the frontend importer turns into editable shapes.

use fastrand::Rng;
use visioncortex::color_clusters::{KeyingAction, Runner, RunnerConfig, HIERARCHICAL_MAX};
use visioncortex::{Color, ColorImage, ColorName, CompoundPath, PathSimplifyMode, PointF64};

const NUM_UNUSED_COLOR_ITERATIONS: usize = 6;
/// The fraction of pixels in sampled rows that need to be transparent before
/// the entire image will be keyed (transparent background discarded).
const KEYING_THRESHOLD: f32 = 0.2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColorMode {
    Color,
    Binary,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Hierarchical {
    Stacked,
    Cutout,
}

/// Converter config — same knobs and defaults as VTracer's.
#[derive(Debug, Clone)]
pub struct Config {
    pub color_mode: ColorMode,
    pub hierarchical: Hierarchical,
    pub filter_speckle: usize,
    pub color_precision: i32,
    pub layer_difference: i32,
    pub mode: PathSimplifyMode,
    pub corner_threshold: i32,
    pub length_threshold: f64,
    pub max_iterations: usize,
    pub splice_threshold: i32,
    pub path_precision: Option<u32>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            color_mode: ColorMode::Color,
            hierarchical: Hierarchical::Stacked,
            mode: PathSimplifyMode::Spline,
            filter_speckle: 4,
            color_precision: 6,
            layer_difference: 16,
            corner_threshold: 60,
            length_threshold: 4.0,
            splice_threshold: 45,
            max_iterations: 10,
            path_precision: Some(2),
        }
    }
}

struct ConverterConfig {
    color_mode: ColorMode,
    hierarchical: Hierarchical,
    filter_speckle_area: usize,
    color_precision_loss: i32,
    layer_difference: i32,
    mode: PathSimplifyMode,
    corner_threshold: f64,
    length_threshold: f64,
    max_iterations: usize,
    splice_threshold: f64,
    path_precision: Option<u32>,
}

impl Config {
    fn into_converter_config(self) -> ConverterConfig {
        ConverterConfig {
            color_mode: self.color_mode,
            hierarchical: self.hierarchical,
            filter_speckle_area: self.filter_speckle * self.filter_speckle,
            color_precision_loss: 8 - self.color_precision,
            layer_difference: self.layer_difference,
            mode: self.mode,
            corner_threshold: deg2rad(self.corner_threshold),
            length_threshold: self.length_threshold,
            max_iterations: self.max_iterations,
            splice_threshold: deg2rad(self.splice_threshold),
            path_precision: self.path_precision,
        }
    }
}

fn deg2rad(deg: i32) -> f64 {
    deg as f64 / 180.0 * std::f64::consts::PI
}

/// One traced region: an SVG path `d` string, its translate offset and fill.
pub struct TracedPath {
    pub d: String,
    pub offset: (f64, f64),
    pub color: String,
}

pub struct TraceResult {
    pub width: usize,
    pub height: usize,
    pub paths: Vec<TracedPath>,
}

impl TraceResult {
    /// Serialise to a standalone SVG document (the frontend importer parses it
    /// back into editable vector shapes).
    pub fn to_svg(&self) -> String {
        let mut out = String::with_capacity(self.paths.iter().map(|p| p.d.len() + 64).sum::<usize>() + 128);
        out.push_str(&format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="{}" height="{}" viewBox="0 0 {} {}">"#,
            self.width, self.height, self.width, self.height,
        ));
        out.push('\n');
        for p in &self.paths {
            let tr = if p.offset.0 != 0.0 || p.offset.1 != 0.0 {
                format!(r#" transform="translate({},{})""#, p.offset.0, p.offset.1)
            } else {
                String::new()
            };
            out.push_str(&format!("<path d=\"{}\" fill=\"{}\"{}/>\n", p.d, p.color, tr));
        }
        out.push_str("</svg>\n");
        out
    }
}

/// Convert an in-memory RGBA image into traced vector paths.
pub fn convert(img: ColorImage, config: Config) -> Result<TraceResult, String> {
    let config = config.into_converter_config();
    match config.color_mode {
        ColorMode::Color => color_image_to_svg(img, config),
        ColorMode::Binary => binary_image_to_svg(img, config),
    }
}

fn color_exists_in_image(img: &ColorImage, color: Color) -> bool {
    for y in 0..img.height {
        for x in 0..img.width {
            let pixel_color = img.get_pixel(x, y);
            if pixel_color.r == color.r && pixel_color.g == color.g && pixel_color.b == color.b {
                return true;
            }
        }
    }
    false
}

fn find_unused_color_in_image(img: &ColorImage) -> Result<Color, String> {
    let special_colors = IntoIterator::into_iter([
        Color::new(255, 0, 0),
        Color::new(0, 255, 0),
        Color::new(0, 0, 255),
        Color::new(255, 255, 0),
        Color::new(0, 255, 255),
        Color::new(255, 0, 255),
    ]);
    let mut rng = Rng::new();
    let random_colors =
        (0..NUM_UNUSED_COLOR_ITERATIONS).map(|_| Color::new(rng.u8(..), rng.u8(..), rng.u8(..)));
    for color in special_colors.chain(random_colors) {
        if !color_exists_in_image(img, color) {
            return Ok(color);
        }
    }
    Err(String::from("unable to find unused color in image to use as key"))
}

fn should_key_image(img: &ColorImage) -> bool {
    if img.width == 0 || img.height == 0 {
        return false;
    }
    // Check for transparency at several scanlines
    let threshold = ((img.width * 2) as f32 * KEYING_THRESHOLD) as usize;
    let mut num_transparent_pixels = 0;
    let y_positions = [0, img.height / 4, img.height / 2, 3 * img.height / 4, img.height - 1];
    for y in y_positions {
        for x in 0..img.width {
            if img.get_pixel(x, y).a == 0 {
                num_transparent_pixels += 1;
            }
            if num_transparent_pixels >= threshold {
                return true;
            }
        }
    }
    false
}

fn path_to_svg(paths: CompoundPath, color: Color, precision: Option<u32>) -> TracedPath {
    let (string, offset) = paths.to_svg_string(true, PointF64::default(), precision);
    TracedPath { d: string, offset: (offset.x, offset.y), color: color.to_hex_string() }
}

fn color_image_to_svg(mut img: ColorImage, config: ConverterConfig) -> Result<TraceResult, String> {
    let width = img.width;
    let height = img.height;

    let key_color = if should_key_image(&img) {
        let key_color = find_unused_color_in_image(&img)?;
        for y in 0..height {
            for x in 0..width {
                if img.get_pixel(x, y).a == 0 {
                    img.set_pixel(x, y, &key_color);
                }
            }
        }
        key_color
    } else {
        // All-zeroes is a visioncortex sentinel meaning "no keying".
        Color::default()
    };

    let runner = Runner::new(
        RunnerConfig {
            diagonal: config.layer_difference == 0,
            hierarchical: HIERARCHICAL_MAX,
            batch_size: 25600,
            good_min_area: config.filter_speckle_area,
            good_max_area: width * height,
            is_same_color_a: config.color_precision_loss,
            is_same_color_b: 1,
            deepen_diff: config.layer_difference,
            hollow_neighbours: 1,
            key_color,
            keying_action: if matches!(config.hierarchical, Hierarchical::Cutout) {
                KeyingAction::Keep
            } else {
                KeyingAction::Discard
            },
        },
        img,
    );

    let mut clusters = runner.run();

    if matches!(config.hierarchical, Hierarchical::Cutout) {
        let view = clusters.view();
        let image = view.to_color_image();
        let runner = Runner::new(
            RunnerConfig {
                diagonal: false,
                hierarchical: 64,
                batch_size: 25600,
                good_min_area: 0,
                good_max_area: image.width * image.height,
                is_same_color_a: 0,
                is_same_color_b: 1,
                deepen_diff: 0,
                hollow_neighbours: 0,
                key_color,
                keying_action: KeyingAction::Discard,
            },
            image,
        );
        clusters = runner.run();
    }

    let view = clusters.view();

    let mut paths = Vec::new();
    for &cluster_index in view.clusters_output.iter().rev() {
        let cluster = view.get_cluster(cluster_index);
        let compound = cluster.to_compound_path(
            &view,
            false,
            config.mode,
            config.corner_threshold,
            config.length_threshold,
            config.max_iterations,
            config.splice_threshold,
        );
        paths.push(path_to_svg(compound, cluster.residue_color(), config.path_precision));
    }

    Ok(TraceResult { width, height, paths })
}

fn binary_image_to_svg(img: ColorImage, config: ConverterConfig) -> Result<TraceResult, String> {
    // Upstream thresholds on the red channel alone (r < 128 = ink), which counts
    // TRANSPARENT pixels (r = 0) as ink and traces the background of any cut-out
    // PNG as a solid black slab. Require opacity before calling a pixel dark.
    let img = img.to_binary_image(|x| x.a >= 128 && x.r < 128);
    let width = img.width;
    let height = img.height;

    let clusters = img.to_clusters(false);

    let mut paths = Vec::new();
    for i in 0..clusters.len() {
        let cluster = clusters.get_cluster(i);
        if cluster.size() >= config.filter_speckle_area {
            let compound = cluster.to_compound_path(
                config.mode,
                config.corner_threshold,
                config.length_threshold,
                config.max_iterations,
                config.splice_threshold,
            );
            paths.push(path_to_svg(compound, Color::color(&ColorName::Black), config.path_precision));
        }
    }

    Ok(TraceResult { width, height, paths })
}
