// Layer model — the internal, enriched representation of a Paintsharp/Layer document.
//
// Attribution
// -----------
// The data model is reimplemented in TypeScript from the public PSD file-format
// documentation and from GIMP's layer core (`app/core/gimplayer.c`,
// `app/core/gimpdrawable*.c`, GPLv3+). Kubuno is AGPLv3, which is compatible.
// Where GIMP and Photoshop diverge, Photoshop is normative (PSD parity).
//
// Position in the architecture
// ----------------------------
// This file is PURE DATA. It must never import React, the DOM, WebGL, the
// renderer or the network layer. Its only outside dependency is the blend-mode
// vocabulary (`../blend/modes.ts`), which is itself dependency-free. This is
// what makes the whole model testable under plain Node and reusable by an
// off-screen PSD/PNG exporter.
//
// Relationship with the wire type
// -------------------------------
// `LayerStructureItem` in `src/api.ts` is the TRANSPORT type. It is shared with
// Apex, Vertex, Keyframe, Motion and PdfWriter and must not change. The types
// below are the INTERNAL model: richer, stricter, and versioned per node. The
// bridge between the two lives in `./schema/` (`fromWire` / `toWire`).

import type { BlendMode } from '../blend/modes.ts'

export type { BlendMode }

// ─────────────────────────────────────────────────────────────────────────────
// Primitives
// ─────────────────────────────────────────────────────────────────────────────

/** Stable, opaque layer identifier. Never reused, never order-dependent. */
export type LayerId = string & { readonly __brand: 'LayerId' }

/** Position in the tree: child indices from the root, e.g. `[2, 0, 3]`. */
export type LayerPath = readonly number[]

/** Integer rectangle in document space. */
export interface RectI { x: number; y: number; w: number; h: number }

/** 8-bit RGBA colour. Channels and alpha are 0..255. */
export interface RGBA { r: number; g: number; b: number; a: number }

/**
 * Row-major 2x3 affine transform: `[a, b, c, d, e, f]` meaning
 * `x' = a*x + c*y + e` and `y' = b*x + d*y + f` (same order as
 * `CanvasRenderingContext2D.setTransform`).
 */
export type Mat2x3 = readonly [number, number, number, number, number, number]

export const MAT_IDENTITY: Mat2x3 = [1, 0, 0, 1, 0, 0]

/** Reference to a pixel surface owned by the TileStore, never by the tree. */
export interface RasterSurfaceRef {
  /** Key into the tile store. Opaque; never parsed. */
  surfaceId: string
  /** Bounds in document space. May be smaller than the document (sparse layer). */
  bounds: RectI
  /** Bumped on every pixel mutation; drives thumbnail and PNG-encode caches. */
  version: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Masks
// ─────────────────────────────────────────────────────────────────────────────

/** Raster (paintable) layer mask. 255 = fully revealed, 0 = fully hidden. */
export interface LayerMask {
  surface: RasterSurfaceRef
  /** false -> the mask is stored but not applied (shift-click on the thumbnail). */
  enabled: boolean
  /** Inverted at sampling time; the stored pixels are untouched. */
  inverted: boolean
  /** Moving/transforming the layer also moves the mask. Photoshop default: true. */
  linked: boolean
  /** 0..255. `m' = 1 - (1 - m) * density/255`; 0 = the mask hides nothing. */
  density: number
  /** Non-destructive blur radius, in document pixels. */
  feather: number
  /** Value sampled outside `surface.bounds`. 255 = revealed (Photoshop default). */
  outsideValue: 0 | 255
  /** Red-overlay preview (the `\` key). View state, persisted like Photoshop. */
  previewAsRubylith: boolean
  rubylithColor: RGBA
}

/** Vector (path) mask. Rasterised to antialiased coverage at composite time. */
export interface VectorMask {
  path: VectorPath
  enabled: boolean
  inverted: boolean
  linked: boolean
  /** Same semantics as `LayerMask.density`. */
  density: number
  feather: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Vector geometry
// ─────────────────────────────────────────────────────────────────────────────

export interface VectorNode {
  x: number; y: number
  /** Incoming control point (absolute, document space). */
  inX: number; inY: number
  /** Outgoing control point (absolute, document space). */
  outX: number; outY: number
}

export interface SubPath {
  closed: boolean
  nodes: VectorNode[]
  /** Boolean op against the accumulated result of the previous sub-paths. */
  op: 'add' | 'subtract' | 'intersect' | 'exclude'
}

export interface VectorPath {
  subpaths: SubPath[]
  fillRule: 'nonzero' | 'evenodd'
}

export interface VectorStroke {
  color: FillContent
  width: number
  align: 'inside' | 'center' | 'outside'
  cap: 'butt' | 'round' | 'square'
  join: 'miter' | 'round' | 'bevel'
  miterLimit: number
  dash: { pattern: number[]; offset: number } | null
}

// ─────────────────────────────────────────────────────────────────────────────
// Gradients and fills
// ─────────────────────────────────────────────────────────────────────────────

/** Segment shape functions, taken from GIMP `gimpgradient.c` (GPLv3+). */
export type GradientSegmentShape =
  | 'linear' | 'curved' | 'sine' | 'sphereIncreasing' | 'sphereDecreasing' | 'step'

export interface GradientColorStop {
  /** 0..1 along the ramp. */
  position: number
  color: RGBA
  /** Midpoint of the segment starting at this stop, 0..1 relative to it. */
  midpoint: number
  shape: GradientSegmentShape
}

export interface GradientOpacityStop {
  position: number
  /** 0..255. */
  opacity: number
  midpoint: number
}

export interface GradientSpec {
  colorStops: GradientColorStop[]
  opacityStops: GradientOpacityStop[]
  /** Interpolation space of the ramp. */
  interpolation: 'rgb' | 'hsvCw' | 'hsvCcw' | 'perceptual'
  /** Optional preset identifier, purely informational. */
  presetId: string | null
}

export type GradientStyle = 'linear' | 'radial' | 'angle' | 'reflected' | 'diamond'

export type FillContent =
  | { type: 'solid'; color: RGBA }
  | {
      type: 'gradient'
      gradient: GradientSpec
      style: GradientStyle
      angle: number
      scale: number
      reverse: boolean
      dither: boolean
      alignWithLayer: boolean
      offset: { x: number; y: number }
    }
  | {
      type: 'pattern'
      patternId: string
      scale: number
      angle: number
      linkWithLayer: boolean
      offset: { x: number; y: number }
    }

// ─────────────────────────────────────────────────────────────────────────────
// Text
// ─────────────────────────────────────────────────────────────────────────────

export interface TextRun {
  /** UTF-16 code-unit offsets into `TextLayerData.content`. */
  start: number
  end: number
  fontFamily: string
  fontSize: number
  fontWeight: number
  italic: boolean
  underline: boolean
  strikethrough: boolean
  color: RGBA
  /** 1/1000 em. */
  tracking: number
  /** Multiplier of the font size; null = auto. */
  leading: number | null
  baselineShift: number
  caps: 'none' | 'small' | 'all'
}

export interface ParagraphStyle {
  start: number
  end: number
  align: 'left' | 'center' | 'right' | 'justify'
  indentFirst: number
  indentLeft: number
  indentRight: number
  spaceBefore: number
  spaceAfter: number
  hyphenate: boolean
}

export interface TextWarpSpec {
  style: string
  bend: number
  horizontalDistortion: number
  verticalDistortion: number
}

export interface TextLayerData {
  /** Full plain text; runs index into it by UTF-16 code-unit offsets. */
  content: string
  runs: TextRun[]
  paragraphs: ParagraphStyle[]
  /** 'point' = auto-sized around the anchor; 'paragraph' = flows inside `box`. */
  mode: 'point' | 'paragraph'
  box: RectI | null
  orientation: 'horizontal' | 'vertical'
  warp: TextWarpSpec | null
  /** Optional path the baseline follows (type on a path). */
  pathId: string | null
  /** Bumped on any content/format change; invalidates the shaped-text cache. */
  version: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Smart filters
// ─────────────────────────────────────────────────────────────────────────────

export interface SmartFilter {
  id: string
  /** Matches a `FilterDef.id` from `layerFilters.ts` (the CPU backend). */
  filterId: string
  params: Record<string, number>
  enabled: boolean
  /** Blend of this filter's output back onto its own input. */
  blendMode: BlendMode
  /** 0..255. */
  opacity: number
}

export interface SmartFilterStack {
  enabled: boolean
  /** Applied bottom-to-top: `filters[0]` runs first. */
  filters: SmartFilter[]
  /** A single mask restricting ALL smart filters (Photoshop semantics). */
  mask: LayerMask | null
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer styles
// ─────────────────────────────────────────────────────────────────────────────

/** A contour curve, sampled to a 256-entry LUT at render time. */
export interface ContourSpec {
  /** Control points in [0,1]^2, sorted by x. */
  points: { x: number; y: number; corner: boolean }[]
  presetId: string | null
}

export interface EffectBase {
  enabled: boolean
  blendMode: BlendMode
  /** 0..255. */
  opacity: number
}

export interface DropShadow extends EffectBase {
  color: RGBA
  /** Degrees; 0 = right, counter-clockwise. */
  angle: number
  useGlobalLight: boolean
  distance: number
  /** 0..1. */
  spread: number
  size: number
  contour: ContourSpec
  antiAliased: boolean
  /** 0..1. */
  noise: number
  /** "Layer knocks out drop shadow" — Photoshop default: true. */
  layerKnocksOut: boolean
}

export interface InnerShadow extends EffectBase {
  color: RGBA
  angle: number
  useGlobalLight: boolean
  distance: number
  /** 0..1 (called "choke" in the UI). */
  choke: number
  size: number
  contour: ContourSpec
  antiAliased: boolean
  noise: number
}

export interface OuterGlow extends EffectBase {
  fill: { type: 'solid'; color: RGBA } | { type: 'gradient'; gradient: GradientSpec }
  technique: 'softer' | 'precise'
  spread: number
  size: number
  contour: ContourSpec
  antiAliased: boolean
  /** 0..1 — which part of the contour maps to the edge. */
  range: number
  /** 0..1 — gradient dithering. */
  jitter: number
  noise: number
}

export interface InnerGlow extends EffectBase {
  fill: { type: 'solid'; color: RGBA } | { type: 'gradient'; gradient: GradientSpec }
  technique: 'softer' | 'precise'
  choke: number
  size: number
  contour: ContourSpec
  antiAliased: boolean
  range: number
  jitter: number
  noise: number
  source: 'center' | 'edge'
}

export interface BevelEmboss {
  enabled: boolean
  style: 'outerBevel' | 'innerBevel' | 'emboss' | 'pillowEmboss' | 'strokeEmboss'
  technique: 'smooth' | 'chiselHard' | 'chiselSoft'
  /** 1..1000 %, as a height scale. */
  depth: number
  direction: 'up' | 'down'
  size: number
  /** Blur applied to the NORMAL map, 0..16 px. */
  soften: number
  angle: number
  /** Degrees, 0..90. */
  altitude: number
  useGlobalLight: boolean
  glossContour: ContourSpec
  glossAntiAliased: boolean
  highlightMode: BlendMode
  highlightColor: RGBA
  /** 0..255. */
  highlightOpacity: number
  shadowMode: BlendMode
  shadowColor: RGBA
  shadowOpacity: number
  contour: { contour: ContourSpec; range: number; antiAliased: boolean } | null
  texture: {
    patternId: string
    scale: number
    depth: number
    invert: boolean
    linkWithLayer: boolean
    offset: { x: number; y: number }
  } | null
}

export interface Satin extends EffectBase {
  color: RGBA
  angle: number
  distance: number
  size: number
  contour: ContourSpec
  antiAliased: boolean
  invert: boolean
}

export interface ColorOverlay extends EffectBase { color: RGBA }

export interface GradientOverlay extends EffectBase {
  gradient: GradientSpec
  style: GradientStyle
  angle: number
  /** 10..150 %. */
  scale: number
  reverse: boolean
  dither: boolean
  alignWithLayer: boolean
  offset: { x: number; y: number }
}

export interface PatternOverlay extends EffectBase {
  patternId: string
  /** 1..1000 %. */
  scale: number
  angle: number
  linkWithLayer: boolean
  offset: { x: number; y: number }
}

export interface StrokeEffect extends EffectBase {
  /** 1..250 px. */
  size: number
  position: 'outside' | 'inside' | 'center'
  fill: FillContent
  overprint: boolean
}

/** "Blend If" sliders. Each range is `[blackLow, blackHigh, whiteLow, whiteHigh]`. */
export interface BlendIfSpec {
  channel: 'gray' | 'r' | 'g' | 'b'
  thisLayer: [number, number, number, number]
  underlyingLayer: [number, number, number, number]
}

export type KnockoutMode = 'none' | 'shallow' | 'deep'

export interface LayerStyleStack {
  enabled: boolean
  /** 1 = 100 %; scales every distance and size uniformly. */
  scale: number
  dropShadow: DropShadow[]
  innerShadow: InnerShadow[]
  outerGlow: OuterGlow | null
  innerGlow: InnerGlow | null
  bevelEmboss: BevelEmboss | null
  satin: Satin | null
  colorOverlay: ColorOverlay[]
  gradientOverlay: GradientOverlay[]
  patternOverlay: PatternOverlay[]
  stroke: StrokeEffect[]
  /** Advanced blending options that live with the styles. */
  blendClippedAsGroup: boolean
  blendInteriorEffectsAsGroup: boolean
  transparencyShapesLayer: boolean
  layerMaskHidesEffects: boolean
  vectorMaskHidesEffects: boolean
  knockout: KnockoutMode
  blendIf: BlendIfSpec | null
}

// ─────────────────────────────────────────────────────────────────────────────
// Adjustments
// ─────────────────────────────────────────────────────────────────────────────

export type LevelsChannel = 'master' | 'r' | 'g' | 'b'
export type CurvesChannel = 'master' | 'r' | 'g' | 'b' | 'a'

export interface LevelsParams {
  lowInput: number
  highInput: number
  gamma: number
  lowOutput: number
  highOutput: number
  clampInput: boolean
  clampOutput: boolean
}

export interface CurvePoint { x: number; y: number; type: 'smooth' | 'corner' }
export interface CurvePoints { points: CurvePoint[] }

export interface HSLBand {
  hue: number
  saturation: number
  lightness: number
  /** Four handles in degrees, `a < b < c < d`. Absent on `master`. */
  range: [number, number, number, number] | null
}

export interface RGBTriple { cyanRed: number; magentaGreen: number; yellowBlue: number }

export interface BWWeights {
  reds: number; yellows: number; greens: number
  cyans: number; blues: number; magentas: number
}

export interface MixerRow { r: number; g: number; b: number; constant: number }

export type SelectiveFamily =
  | 'reds' | 'yellows' | 'greens' | 'cyans' | 'blues' | 'magentas'
  | 'whites' | 'neutrals' | 'blacks'

export interface CMYKTriple { cyan: number; magenta: number; yellow: number; black: number }

/** The 16 non-destructive adjustments. Every variant is flat and serialisable. */
export type AdjustmentSpec =
  | { type: 'brightnessContrast'; brightness: number; contrast: number; useLegacy: boolean }
  | { type: 'levels'; channels: Record<LevelsChannel, LevelsParams> }
  | { type: 'curves'; channels: Record<CurvesChannel, CurvePoints> }
  | { type: 'exposure'; exposure: number; offset: number; gammaCorrection: number }
  | { type: 'vibrance'; vibrance: number; saturation: number }
  | { type: 'hueSaturation'; colorize: boolean; master: HSLBand; bands: HSLBand[] }
  | {
      type: 'colorBalance'
      shadows: RGBTriple; midtones: RGBTriple; highlights: RGBTriple
      preserveLuminosity: boolean
    }
  | { type: 'blackAndWhite'; weights: BWWeights; tint: RGBA | null }
  | { type: 'photoFilter'; color: RGBA; density: number; preserveLuminosity: boolean }
  | { type: 'channelMixer'; monochrome: boolean; out: Record<'r' | 'g' | 'b' | 'gray', MixerRow> }
  | { type: 'colorLookup'; lutId: string; dither: boolean; amount: number }
  | { type: 'invert' }
  | { type: 'posterize'; levels: number }
  | { type: 'threshold'; level: number }
  | { type: 'gradientMap'; gradient: GradientSpec; reverse: boolean; dither: boolean }
  | { type: 'selectiveColor'; method: 'relative' | 'absolute'; families: Record<SelectiveFamily, CMYKTriple> }

export type AdjustmentKind = AdjustmentSpec['type']

// ─────────────────────────────────────────────────────────────────────────────
// Locks and metadata
// ─────────────────────────────────────────────────────────────────────────────

export interface LayerLocks {
  /** Lock transparent pixels: painting may not create or destroy alpha. */
  transparency: boolean
  /** Lock image pixels: no painting, no filters, no destructive edit. */
  pixels: boolean
  /** Lock position: no move, no transform. */
  position: boolean
  /** Prevent auto-nesting: the layer cannot be dragged into or out of a group. */
  nesting: boolean
  /** Lock all: implies every other lock and blocks delete/rename/reorder. */
  all: boolean
}

/** Photoshop exposes 7 colours plus "none". A free-form hex breaks theming. */
export type LayerColorLabel =
  | 'none' | 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'violet' | 'gray'

export const LAYER_COLOR_LABELS: readonly LayerColorLabel[] = [
  'none', 'red', 'orange', 'yellow', 'green', 'blue', 'violet', 'gray',
]

// ─────────────────────────────────────────────────────────────────────────────
// The layer node
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fields shared by EVERY layer kind.
 *
 * Opacity vs fill opacity (gap E9 of the audit)
 * ---------------------------------------------
 * The current editor multiplies the two into a single factor, which makes the
 * canonical Photoshop case impossible: "fill at 0 %, drop shadow still visible".
 * They are two DIFFERENT notions and are modelled as such here:
 *
 *   - `fillOpacity` scales the layer's own CONTENT only. Layer styles read the
 *     silhouette BEFORE it is applied, so they survive `fillOpacity = 0`.
 *   - `opacity` scales the whole aggregate (content + styles) afterwards.
 *
 * `contentAlphaFactor()` / `styleAlphaFactor()` below are the only sanctioned
 * way to turn the pair into rendering factors; collapsing them into a product is
 * valid ONLY when the layer carries no styles (`hasStyles(layer) === false`).
 */
export interface LayerBase {
  readonly id: LayerId
  /** Per-node schema version; enables partial migration. See `./schema/`. */
  schemaVersion: number
  name: string

  // Visibility and compositing
  visible: boolean
  /** 0..255 in memory (0..100 on the wire — see `./schema/`). */
  opacity: number
  /** 0..255. Fill opacity — does NOT affect layer styles. */
  fillOpacity: number
  blendMode: BlendMode
  /** Clipped to the alpha of the sibling below (the clipping base). */
  clipping: boolean

  // Masks
  layerMask: LayerMask | null
  vectorMask: VectorMask | null

  // Styles and non-destructive effects
  styles: LayerStyleStack | null
  smartFilters: SmartFilterStack | null

  // Locks and metadata
  locks: LayerLocks
  colorLabel: LayerColorLabel
  /** Layers sharing a `linkGroup` move and transform together. */
  linkGroup: string | null

  /** Affine transform of the layer's own content, in document space. */
  transform: Mat2x3

  /**
   * Forward compatibility: keys written by a NEWER client, preserved verbatim
   * across read -> edit -> write. Never inspected by this client. Also carries
   * the legacy `data` / `mask_data` pixel payloads until the TileStore owns them.
   */
  _unknown?: Record<string, unknown>
}

export interface RasterLayer extends LayerBase {
  kind: 'raster'
  surface: RasterSurfaceRef
  /** The bottom "Background" layer: opaque, unmovable, no alpha. */
  isBackground: boolean
}

export interface GroupLayer extends LayerBase {
  kind: 'group'
  /** Index 0 is the TOP of the stack (PSD / layers-panel convention). */
  children: Layer[]
  expanded: boolean
  /**
   * true  -> composited in isolation, then blended as a unit.
   * false -> pass-through: children blend against the outer backdrop.
   * Derived from `blendMode === 'pass-through'`, kept explicit for clarity.
   */
  isolated: boolean
  knockout: KnockoutMode
}

export interface AdjustmentLayer extends LayerBase {
  kind: 'adjustment'
  adjustment: AdjustmentSpec
}

export interface FillLayer extends LayerBase {
  kind: 'fill'
  fill: FillContent
}

export interface TextLayer extends LayerBase {
  kind: 'text'
  text: TextLayerData
  /** Cache of the shaped text. A CACHE, never the source of truth. */
  raster: RasterSurfaceRef | null
}

export type LiveShape =
  | { type: 'rect'; radii: [number, number, number, number] }
  | { type: 'ellipse' }
  | { type: 'polygon'; sides: number; starRatio: number | null; radius: number }
  | { type: 'line'; thickness: number }
  | { type: 'custom'; presetId: string }

export interface ShapeLayer extends LayerBase {
  kind: 'shape'
  path: VectorPath
  fill: FillContent | null
  stroke: VectorStroke | null
  /** null once the user has edited individual anchors ("free path"). */
  liveShape: LiveShape | null
  raster: RasterSurfaceRef | null
}

export type SmartObjectSource =
  | { type: 'embedded'; contentId: string }
  | { type: 'linked'; fileId: string }

export interface SmartObjectLayer extends LayerBase {
  kind: 'smartObject'
  source: SmartObjectSource
  /** Intrinsic size of the source, before `transform`. */
  sourceSize: { w: number; h: number }
  interpolation:
    | 'nearest' | 'bilinear' | 'bicubic' | 'bicubicSharper' | 'bicubicSmoother'
  raster: RasterSurfaceRef | null
}

export interface ArtboardLayer extends LayerBase {
  kind: 'artboard'
  /** Artboard frame in document space. Children are clipped to it. */
  frame: RectI
  children: Layer[]
  expanded: boolean
  background: { type: 'transparent' } | { type: 'solid'; color: RGBA }
  /** Preset name for the UI ("iPhone 15", "A4"). Purely informational. */
  presetName: string | null
}

export type Layer =
  | RasterLayer | GroupLayer | AdjustmentLayer | FillLayer
  | TextLayer | ShapeLayer | SmartObjectLayer | ArtboardLayer

export type LayerKind = Layer['kind']

/**
 * A partial update of a layer. `Partial<Layer>` cannot be used: `Layer` is a
 * discriminated union, so `Partial` distributes over it and a patch touching
 * only base fields fails to match any member. A patch carries base fields plus,
 * optionally, kind-specific ones — the caller is responsible for applying it to
 * a node of the right kind.
 */
export type LayerPatch = Partial<LayerBase> & { readonly [k: string]: unknown }

export const LAYER_KINDS: readonly LayerKind[] = [
  'raster', 'group', 'adjustment', 'fill', 'text', 'shape', 'smartObject', 'artboard',
]

/** A node that owns a child list (group or artboard). */
export type ContainerLayer = GroupLayer | ArtboardLayer

// ─────────────────────────────────────────────────────────────────────────────
// Selection
// ─────────────────────────────────────────────────────────────────────────────

export interface LayerSelection {
  /** Ordered by document position (top first). Never empty in normal use. */
  ids: readonly LayerId[]
  /** The "primary" layer: target of single-target ops, anchor of range ops. */
  primaryId: LayerId | null
  /** Anchor for shift-click range selection. */
  anchorId: LayerId | null
}

export const EMPTY_SELECTION: LayerSelection = { ids: [], primaryId: null, anchorId: null }

// ─────────────────────────────────────────────────────────────────────────────
// Narrowing helpers (no behaviour, only type refinement)
// ─────────────────────────────────────────────────────────────────────────────

export function isContainer(l: Layer): l is ContainerLayer {
  return l.kind === 'group' || l.kind === 'artboard'
}

export function isGroup(l: Layer): l is GroupLayer { return l.kind === 'group' }
export function isArtboard(l: Layer): l is ArtboardLayer { return l.kind === 'artboard' }
export function isRaster(l: Layer): l is RasterLayer { return l.kind === 'raster' }
export function isAdjustment(l: Layer): l is AdjustmentLayer { return l.kind === 'adjustment' }

/** Children of a container, or `null` for a leaf. Never allocates. */
export function childrenOf(l: Layer): Layer[] | null {
  return isContainer(l) ? l.children : null
}

/** Does this layer own a cached raster surface it does not author itself? */
export function cachedRasterOf(l: Layer): RasterSurfaceRef | null {
  switch (l.kind) {
    case 'raster': return l.surface
    case 'text': case 'shape': case 'smartObject': return l.raster
    default: return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Opacity semantics (gap E9)
// ─────────────────────────────────────────────────────────────────────────────

export function hasStyles(l: Layer): boolean {
  const s = l.styles
  if (!s || !s.enabled) return false
  return (
    s.dropShadow.some(e => e.enabled) ||
    s.innerShadow.some(e => e.enabled) ||
    (s.outerGlow?.enabled ?? false) ||
    (s.innerGlow?.enabled ?? false) ||
    (s.bevelEmboss?.enabled ?? false) ||
    (s.satin?.enabled ?? false) ||
    s.colorOverlay.some(e => e.enabled) ||
    s.gradientOverlay.some(e => e.enabled) ||
    s.patternOverlay.some(e => e.enabled) ||
    s.stroke.some(e => e.enabled)
  )
}

/**
 * Alpha factor applied to the layer's own CONTENT, before styles are stacked.
 * This is `fillOpacity` alone: styles must not shrink with it.
 */
export function contentAlphaFactor(l: Layer): number {
  return l.fillOpacity / 255
}

/**
 * Alpha factor applied to the whole aggregate (content + styles) at step (8) of
 * the normative order. This is `opacity` alone.
 */
export function styleAlphaFactor(l: Layer): number {
  return l.opacity / 255
}

/**
 * Single-pass fast path: valid ONLY when the layer carries no enabled style.
 * Kept as an explicit, guarded function so no caller re-derives `opacity*fill`
 * by hand and silently reintroduces gap E9.
 */
export function collapsedAlphaFactor(l: Layer): number {
  return hasStyles(l)
    ? styleAlphaFactor(l)                       // styles must be stacked separately
    : styleAlphaFactor(l) * contentAlphaFactor(l)
}

/**
 * A pass-through group must be isolated as soon as anything makes the
 * unisolated result undefined. See spec 2.3.
 */
export function needsIsolation(g: GroupLayer): boolean {
  return (
    g.blendMode !== 'pass-through' ||
    g.opacity < 255 ||
    g.fillOpacity < 255 ||
    g.layerMask !== null ||
    g.vectorMask !== null ||
    hasStyles(g) ||
    g.knockout !== 'none'
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Small geometric helpers used across the model
// ─────────────────────────────────────────────────────────────────────────────

export const EMPTY_RECT: RectI = { x: 0, y: 0, w: 0, h: 0 }

export function rectIsEmpty(r: RectI): boolean { return r.w <= 0 || r.h <= 0 }

export function rectUnion(a: RectI, b: RectI): RectI {
  if (rectIsEmpty(a)) return { ...b }
  if (rectIsEmpty(b)) return { ...a }
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  const x2 = Math.max(a.x + a.w, b.x + b.w)
  const y2 = Math.max(a.y + a.h, b.y + b.h)
  return { x, y, w: x2 - x, h: y2 - y }
}

export function rectEquals(a: RectI, b: RectI): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h
}
