# Filter inventory — what is on the GPU, what is not, and why

Scope: every entry of the legacy catalogue `src/layerFilters.ts` (`FILTER_GROUPS`),
plus the non-destructive adjustments that replace `layer/imaging/adjustments.ts`.

**Counts.** The legacy catalogue has **55 registry entries** (the specification
counts 47 because it merges variants such as *radial spin* / *radial zoom* and
*add noise* / *add noise mono*). Of those 55:

| Route | Count | Meaning |
|---|---|---|
| `gpu` | **44** | fully expressed as fragment passes, implemented here |
| `worker` | **7** | needs a sort, a per-pixel histogram or a sequential scan |
| `hybrid` | **4** | GPU chain with exactly one worker link (always a median) |

Against the specification's own grouping this is **40/47 on GPU and 7 in the
worker**, exactly the split §9.5 predicts. The four `hybrid` entries
(cutout, watercolor, sponge, dry brush) are counted by the spec inside the
"artistic — mixte" row.

The adjustments are a separate axis: **12 of 12 on GPU**, one pass, fusable.

---

## 1. Colour space — read this first

The engine works in **RGBA16F, linear light, premultiplied alpha**. Every filter
declares the space its arithmetic is defined in (`GpuFilterDef.space`), and the
shader wrapper does the conversion. Getting this wrong is silent and ugly, so it
is stated per filter.

* **`linear`** — anything that *averages, interpolates or scales light*: blurs,
  distortions (they resample), mosaic/fragment (they average), exposure,
  Oklab hue/saturation. Averaging encoded values darkens the result; that is the
  single most visible legacy bug this port fixes.
* **`perceptual`** — anything whose 0..1 domain has a perceptual midpoint at 0.5:
  levels, curves, posterize, threshold, brightness/contrast, colour balance,
  solarize, emboss and the whole sketch family, plus noise amplitude (constant
  amplitude in linear light is invisible in shadows and violent in highlights).

**Consequence, and it is intended**: filters that resample or average now
disagree with the legacy CPU output *at hard edges*, by up to ~74/255 on a
black/white checkerboard. That is the correction, not a regression — it is the
same effect the specification predicts for the blur in §9.3 ("il sera plus clair
au milieu du dégradé : c'est la correction attendue").

---

## 2. The catalogue

Legend — **Route**: `GPU` (here), `WORKER` (Rust/WASM, later), `HYBRID`.
**Δ**: maximum per-channel deviation from the legacy CPU filter, in 8-bit units,
measured on a **smooth opaque** 256×256 image (the hard-edge image is reported in
the session notes; its larger deltas are the linear-light resampling effect
described above). `0` means bit-identical after the 8-bit round trip.

### blur

| Filter | Route | Passes | Δ | Notes |
|---|---|---|---|---|
| gaussian | GPU | 2 (+2 for r>48) | 1–2 | True separable Gaussian, σ=r/3, bilinear tap merging. Replaces `boxBlur3`. Radii > 48 px run on a reduced LOD, so cost is bounded. |
| box | GPU | 2 | 2 | A *real* single-iteration box. The legacy entry called the 3-iteration Gaussian, so "box" and "gaussian" were the same filter. |
| motion | GPU | 1 | 2 | One oriented pass, bilinear taps. Legacy: up to 241 point samples/pixel. Gains a `trail` profile. |
| radial spin | GPU | 1 | 20–24 | Same geometry; sample count now adapts to strength and the offset is dithered (legacy: 12 fixed samples ⇒ visible concentric banding). |
| radial zoom | GPU | 1 | 6–7 | idem. |
| average | GPU | log₂(n)+1 | 16–23 | Mip-style reduction to 1×1 then broadcast. Δ is the linear-light mean vs the legacy encoded mean. |

### sharpen

| Filter | Route | Passes | Δ | Notes |
|---|---|---|---|---|
| sharpen | GPU | 3 | 2 | One parameterised unsharp mask now serves all four entries; the legacy code had **three** copies of the maths. |
| sharpen more | GPU | 3 | 3 | |
| unsharp mask | GPU | 3 | 2 | **New parameter: threshold** (Photoshop has one, the legacy filter did not) — stops the filter amplifying grain in flat areas. |
| high pass | GPU | 3 | 1 | Same chain, `0.5 + (src − blur)`. |

### noise

| Filter | Route | Passes | Δ | Notes |
|---|---|---|---|---|
| add noise | GPU | 1 | n/a | Deterministic PCG hash of (pixel, seed). **Not comparable to the legacy output**: the legacy LCG is consumed in raster order and *skips transparent pixels*, so its sequence depends on the alpha channel and no parallel implementation can reproduce it. New options: gaussian vs uniform, grain size. |
| add noise mono | GPU | 1 | n/a | idem. |
| **median** | WORKER | — | — | Per-pixel sort of (2r+1)² samples. A GPU sorting network is only viable up to r=2 (25 elements); the slider goes to 10 (441 elements). |
| **despeckle** | WORKER | — | — | Median r=1. The 9-element sorting network *is* portable — kept in the worker for now so that one implementation serves both, flagged in the registry as a candidate GPU fast path. |
| **dust & scratches** | WORKER | — | — | Median + threshold; inherits the median verdict. |

### distort — all 7 ported, all Δ ≤ 1

| Filter | Route | Passes | Δ | Notes |
|---|---|---|---|---|
| pinch, spherize, twirl, ripple, wave, zigzag, polar | GPU | 1 each | 1 | Inverse mapping in pixel space, hardware bilinear. Because the working space is premultiplied, transparent neighbours cannot bleed colour — the CPU version had to premultiply and unpremultiply inside every sample. |

### pixelate

| Filter | Route | Passes | Δ | Notes |
|---|---|---|---|---|
| mosaic | GPU | 2 | 1 | Cell mean rendered into a `ceil(w/cell)` target, then a nearest lookup. Exact for cells ≤ 16 px, 16×16 stratified above (legacy was O(cell²) per cell). |
| **crystallize** | WORKER | — | — | Voronoi cell assignment. A GPU port needs jump flooding (2·log₂n passes) plus a colour gather; not worth a first pass. |
| **pointillize** | WORKER | — | — | idem. |
| colour halftone | GPU | 2 | 255 on 60 px | Binary output: a sub-LSB difference in the cell mean flips a pixel between 0 and 255 at the dot boundary. Mean deviation 0.08. |
| fragment | GPU | 1 | 1 | Four offset copies averaged. |

### stylize

| Filter | Route | Passes | Δ | Notes |
|---|---|---|---|---|
| emboss | GPU | 1 | **0** | 3×3 convolution. |
| find edges | GPU | 1 | 1 | Sobel per channel. |
| solarize | GPU | 1 | **0** | |
| trace contour | GPU | 1 | 255 on 1196 px | Binary output, same threshold-flip effect as halftone. Mean 1.56. |
| **wind** | WORKER | — | — | **Sequential dependency**: pixel *x* is smeared from the value already written at *x−1*. Not expressible as a fragment program at any radius. |
| diffuse | GPU | 1 | n/a | Deterministic hash instead of the serial LCG. |
| **oil paint** | WORKER | — | — | 20-bin histogram per pixel; at r=8 that is 289 samples and 20 accumulators per pixel. Portable at r ≤ 4 if ever needed. |

### render

| Filter | Route | Passes | Δ | Notes |
|---|---|---|---|---|
| clouds, difference clouds, fibers | GPU | 1 each | n/a | Procedural. Structure preserved (6 octaves, lattice 64→2, amplitude halved) but **not bit-comparable**: the legacy lattice is filled by a serial JS LCG. What matters is that the GPU version is *deterministic from a seed*, which the legacy `Math.random()` path in `applyFilters` was not. |
| lens flare | GPU | 1 | 41–59 on 2590 px | Faithful port of the geometry. The deviation is in the ghost circles: the legacy loop iterates with **fractional** loop bounds (`for (y = gy - gr; ...)` with a float `gy`), indexing the array at non-integer offsets. The GPU version is the correct one. |

### artistic

| Filter | Route | Passes | Δ | Notes |
|---|---|---|---|---|
| poster edges | GPU | 3 | 2 | posterize × edge mask, two source branches and a combine. |
| **cutout** | HYBRID | — | — | posterize → **median r=2**. |
| **watercolor** | HYBRID | — | — | **median r=2** → posterize → edge modulation. |
| **sponge** | HYBRID | — | — | **median r=2** → hashed darkening. |
| **dry brush** | HYBRID | — | — | **median r=1** → posterize. |
| film grain | GPU | 1 | n/a | = monochrome noise. |

### sketch

| Filter | Route | Passes | Δ | Notes |
|---|---|---|---|---|
| photocopy | GPU | 4 | **0** | grayscale → blur → local-ratio clip. |
| stamp | GPU | 4 | 255 on 545 px | Binary output (threshold of a blur). Mean 2.12. |
| bas relief | GPU | 1 | 4 | emboss on grayscale, one pass instead of two CPU allocations. |
| chalk & charcoal | GPU | 2 | n/a | contains hashed noise. |
| halftone pattern | GPU | 2 | 255 on 212 px | binary output. Mean 0.82. |
| note paper | GPU | 2 | n/a | contains hashed noise. |

### other

| Filter | Route | Passes | Δ | Notes |
|---|---|---|---|---|
| posterize | GPU | 1 | **0** | |
| threshold | GPU | 1 | 255 on 1 px | One pixel of the test image sits exactly on the threshold. |
| maximum | GPU | 2 | **0** | Chebyshev dilation is **separable** — 2 passes of O(r) instead of the legacy `rankFilter`, which sorted (2r+1)² values per pixel to take the last one. |
| minimum | GPU | 2 | **0** | idem, erosion. |
| offset | GPU | 1 | **0** | |

---

## 3. Adjustments — 12/12 on GPU, one pass, non destructive

Verified against a CPU reference implementation of the *same* formula
(`AdjustmentImpl.applyPixel`), so any deviation is a shader bug, not a
specification difference. Max per-channel deviation over the whole test image:

| Adjustment | Space | Δ | Formula source |
|---|---|---|---|
| brightness / contrast | perceptual | 1 | GIMP `gimp_operation_brightness_contrast_map` (see the deliberate space deviation noted in `adjustments.ts`) |
| exposure | **linear** | 1 | `(c + offset)·2^EV`, then gamma. The legacy version multiplied *encoded* values, which is not an exposure. |
| saturation | **linear** | 1 | Oklab chroma scaling (legacy: HSL on encoded values, which drifts lightness on saturated reds and blues) |
| hue | **linear** | 1 | OkLCh rotation |
| levels | perceptual | 1 | GIMP `gimp_operation_levels_map`, per-channel then master |
| curves | perceptual | 1 | 256×1 RGBA LUT, monotone cubic; GIMP order `master(per_channel(x))`; texel-centre addressing reproduces GIMP's linear interpolation |
| vibrance | perceptual | 1 | saturation weighted by how unsaturated the pixel already is (no GIMP equivalent — GIMP has no vibrance op) |
| black & white | perceptual | **0** | six colour families, Photoshop defaults, optional tint |
| colour balance | perceptual | 1 | GIMP `gimp_operation_color_balance_map` (a=0.25, b=0.333, scale=0.7, masks driven by HSL lightness) |
| colour balance + preserve luminosity | perceptual | 1 | GIMP's actual behaviour: HSL round trip restoring the original L |
| invert | perceptual | **0** | |
| threshold | perceptual | **0** | NTSC luma, matching the legacy filter |
| posterize | perceptual | **0** | GIMP `RINT(v·(n−1))/(n−1)` |
| **fused** exposure + brightness/contrast + saturation | mixed | 1 | one pass, with the linear↔perceptual transitions inserted automatically |

Δ = 1 is the float→8-bit rounding boundary; it is the noise floor of the
comparison, not a disagreement.

---

## 4. What the worker pool must implement

Seven entries, with the reason each one is not a fragment program. The registry
exposes this list programmatically (`nonPortableFilters()`), so the router never
has to hard-code it:

1. **median** — per-pixel sort.
2. **despeckle** — median r=1 (GPU sorting network possible; kept together).
3. **dust & scratches** — median + threshold.
4. **wind** — sequential dependency along the scanline.
5. **oil paint** — 20-bin histogram per pixel.
6. **crystallize** — Voronoi (jump flooding not retained).
7. **pointillize** — Voronoi.

Plus the four `hybrid` chains whose only non-portable link is a median:
**cutout, watercolor, sponge, dry brush**. Once the worker exposes a tiled
median, those become GPU chains with one worker call in the middle.

---

## 5. Deliberate deviations, in one list

Anyone comparing old and new output will see these; none of them is a bug.

1. **Blur is a true Gaussian** (σ = r/3, truncated at 3σ) instead of three box
   iterations, and the legacy `r = max(1, round(radius/3))` meant any radius
   below 4.5 px was silently ignored. Small radii now do what the slider says.
2. **Everything that averages or resamples does so in linear light**: blurs,
   distortions, mosaic, fragment, average, halftone cell means.
3. **Exposure is a linear-light gain**, not a multiplication of encoded values.
4. **Saturation and hue go through Oklab**, not HSL on encoded values.
5. **Desaturation uses Rec.709 in linear light** where luminance is meant;
   the NTSC 0.299/0.587/0.114 weights are kept only where the legacy filter's
   *look* is the specification (threshold, grayscale for the sketch family).
6. **Noise is a hash, not a stream.** The sequence changes, but it becomes
   reproducible — which the legacy `Math.random()` path in
   `imaging/filters.applyFilters` never was, making undo replay impossible.
7. **Unsharp mask gains a threshold**, defaulting to 0 (= legacy behaviour).
8. **Box blur is now actually a box blur.**
9. **Lens flare ghosts are geometrically correct** (the legacy loop indexed the
   array at fractional offsets).

---

## 6. Measurements

Environment: Chrome 150 headless, **ANGLE / SwiftShader (software rasteriser)** —
the only WebGL2 available on this machine (the shared CDP Chrome cannot create
any GL context; see spec §12.2). Per that same section, SwiftShader validates
**correctness** but is **not a performance bench**.

**What could not be measured, honestly stated**: device-side GPU execution time.
Under SwiftShader `gl.finish()` does not force the pipeline (50 blur chains of
1000×1000 "complete" in 5.6 ms) and `readPixels` timings are dominated by format
conversion and IPC (17.8 s for a single 1000×1000 RGBA/FLOAT readback). Any
"GPU milliseconds" figure from this environment would be fiction. A real
GPU-backed Chrome is required, per §12.2.

**What is measured and meaningful — MAIN-THREAD OCCUPANCY**, which is exactly
what goulet G3 is about ("l'interface est gelée pendant ce temps"). For the CPU
path this is the whole filter; for the GPU path it is the pass construction and
submission. Median of 10–30 repetitions, same page, same image:

| Operation | Size | CPU main thread | GPU main thread | Ratio |
|---|---|---|---|---|
| gaussian r=2 | 1000² | 337.7 ms | 0.050 ms | ×6 754 |
| gaussian r=6 | 1000² | 239.5 ms | 0.143 ms | ×1 671 |
| gaussian r=60 | 1000² | 253.0 ms | 0.043 ms | ×5 838 |
| gaussian r=2 | **4000²** | **2 651 ms** | 0.020 ms | ×132 560 |
| gaussian r=6 | **4000²** | **4 102 ms** | 0.060 ms | ×68 363 |
| gaussian r=60 | **4000²** | **4 983 ms** | 0.030 ms | ×166 110 |
| 4 adjustments (exposure + b/c + saturation + hue), **fused into one pass** | 4000² | 30 139 ms¹ | 0.030 ms | ×1 004 640 |

¹ that figure is the CPU reference of *these four* adjustments (Oklab included),
not of the legacy `applyAdjustments`, whose lighter HSL set the audit measured at
248–867 ms. The comparable claim is the second column: submitting the fused GPU
pass costs **0.03 ms of main-thread time** instead of hundreds of milliseconds.

The CPU blur figures reproduce the audit's G3 range (2.3–14.9 s on 4000×4000)
and confirm the diagnosis: the cost is not merely large, it is on the thread
that has to stay responsive. A single 4000×4000 `boxBlur3` also allocates
2 × 256 MiB of `Float32Array`; the GPU path allocates **two pooled textures,
reused across every subsequent invocation**.

**Structural cost, which is environment-independent and can be stated with
confidence**: a Gaussian of any radius ≤ 48 px is **2 fullscreen passes**, with
`1 + ceil(r/2)` bilinear fetches per pixel per pass (7 at r=6). Above 48 px it is
4 passes at a reduced LOD, so the cost stops growing with the radius. The legacy
path is 6 complete sweeps over the layer (3 box iterations × 2 directions) in
scalar JavaScript, whatever the radius.

---

## 7. Design notes for whoever extends this

* **Adding a filter is adding a record** to `registry.ts`: id, params, and a
  function returning the pass list. No new module, no switch case.
* **The device is an interface** (`GLDeviceLike`, four operations). The stage is
  developed against `TestDevice` (records draws, catches leaked textures and
  program-cache key collisions) and runs on `WebGL2Device`. When the engine's
  own `GLDevice` lands it only has to satisfy the interface.
* **The texel-centre rule** is written at the top of `glsl/common.ts` and is
  worth reading before writing any neighbourhood shader: a fragment for output
  pixel *x* has `vUv·uSize == x + 0.5`, so a port of a CPU loop must start from
  `pixelCoord()`. Ignoring it shifts every tap by half a texel, which with
  LINEAR filtering silently averages two neighbours — it looks like a slightly
  soft image, not like a bug.
* **Tiling** is not implemented here. Each filter declares its kernel support
  implicitly through its passes; when the tile scheduler lands, gather filters
  need a halo equal to their radius, and the whole-layer filters (average, and
  the distortions, which sample arbitrarily far) must run per band or on the
  full layer.
