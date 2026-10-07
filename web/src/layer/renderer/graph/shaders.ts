// GLSL sources for the composition stage.
//
// The blend formulas are NOT written here. They come from `layer/blend/glsl.ts`
// (`blendModeChunk()`), which is the GLSL twin of `layer/blend/formulas.ts`, so
// the shader and the TypeScript oracle cannot drift. This file only wires that
// chunk into the passes the graph needs.
//
//
// THE BUG THIS FILE FIXES
// -----------------------
// The shader in `layer/renderer/shaders.ts` (`FRAG_COMPOSITE`) ends with:
//
//     float a = lay.a + base.a * (1. - lay.a);
//     vec3  c = a < .0001 ? vec3(0.) : (bl * lay.a + base.rgb * base.a * (1. - lay.a)) / a;
//
// The PDF 1.7 §11.3.6 composition has THREE terms:
//
//     Co = as*(1-ab)*Cs  +  as*ab*B(Cb,Cs)  +  (1-as)*ab*Cb
//
// The first one, `as*(1-ab)*Cs`, is missing. It is the term that says: where the
// backdrop is transparent there is nothing to blend with, so the result must be
// the source colour raw. Without it, `B(0, Cs)` is taken at face value, and a
// `multiply` / `color-burn` / `darken` layer over empty canvas renders BLACK
// instead of its own colour.
//
// `blendComposite()` in `layer/blend/glsl.ts` implements the premultiplied form
//
//     cr = (1-as)*cb + (1-ab)*cs + ab*as*B(Cb,Cs)
//
// which carries all three terms, with no division and no branch. This file
// calls it and nothing else.
//
//
// WORKING SPACE — and the one place the blend space is decided
// ------------------------------------------------------------
// Storage and composition are LINEAR, PREMULTIPLIED, RGBA16F (spec 09 §4.1 /
// §4.4). Two consequences the passes below rely on: reducing coverage is a
// plain scalar multiply of `vec4(rgb, a)`, and 2x2 reduction for LOD and
// thumbnails is correct by construction.
//
// THE ARBITRATION (decided 2026-07-27, do not re-litigate without reading this)
// ----------------------------------------------------------------------------
// The two specs disagreed, and the disagreement was real, not editorial:
//
//   * 09-rendu §4.1 requires a LINEAR blend space. Its argument is physical
//     correctness, and it is the argument GIMP accepted: GIMP's modern layer
//     modes declare `composite_space = GIMP_LAYER_COLOR_SPACE_RGB_LINEAR`
//     (app/operations/layer-modes/gimp-layer-modes.c) and keep the non-linear
//     space only for `*_LEGACY` compatibility.
//
//   * 08-modele-calques §4.8 requires B() to be evaluated on sRGB-ENCODED
//     values. Its argument is Photoshop parity, and it is the argument PSD
//     import lives or dies by.
//
// DECISION: **Photoshop parity.** An imported PSD that does not look like the
// PSD is a broken import, and that is the feature users are paying for. This is
// also the compromise Photoshop itself makes.
//
// The decision is NARROW, and the narrowness is the whole point:
//
//   * evaluated in sRGB-encoded space:  ONLY the blend function B(Cb, Cs)
//   * evaluated in linear space:        EVERYTHING else — Porter-Duff alpha
//     composition, coverage, opacity, fill, group resolution, interpolation,
//     gradients, 2x2 LOD and thumbnail reduction
//
// Concretely, per fragment: un-premultiply to linear, encode to sRGB, apply B,
// decode back to linear, then compose in linear premultiplied. The alpha
// algebra never sees an sRGB value, which is what keeps the fix for the missing
// `as*(1-ab)*Cs` term intact — that term is pure composition and does not go
// through B() at all.
//
// Two invariants follow, and both are asserted by the GPU tests:
//   1. `normal` / `dissolve` / `pass-through` are IDENTICAL in both spaces,
//      because B = Cs there and the encode/decode round-trip is the identity;
//   2. the OUTPUT ALPHA is identical in both spaces for every mode, because
//      `ar = as + ab*(1-as)` contains no colour term.
//
// The switch stays live in both directions: a future HDR / scene-linear mode
// only has to pass `blendSpace: 'linear'`, and nothing in the graph changes.

import { blendModeChunk } from '../../blend/index.ts'
import type { BlendMode } from '../../blend/index.ts'

/**
 * Space in which the blend function B(Cb, Cs) is evaluated. Composition is
 * linear in BOTH cases — this only ever selects how B sees its inputs.
 */
export type BlendSpace = 'linear' | 'srgb-encoded'

/**
 * Photoshop parity (spec 08 §4.8), per the arbitration above.
 * Set to `'linear'` for the physically-correct rendering of spec 09 §4.1.
 */
export const DEFAULT_BLEND_SPACE: BlendSpace = 'srgb-encoded'

/** @deprecated Kept as the historical name of the decision point. */
export const BLEND_SPACE: BlendSpace = DEFAULT_BLEND_SPACE

/**
 * Contract with `gl/quad.ts`: the shared VAO exposes one vec2 attribute at
 * location 0, holding a fullscreen quad in clip space [-1,1]. Every pass in
 * this folder uses this vertex shader and nothing else.
 */
export const VERT_QUAD = `#version 300 es
layout(location = 0) in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`

/**
 * sRGB transfer functions, exact (spec 09 §4.3) — never `pow(c, 2.2)`: the
 * error on the linear segment near black is several 8-bit codes and shows in
 * the shadows.
 *
 * NaN hazard, and why the `max()` is not decoration: `mix()` evaluates BOTH
 * arms, so a `pow(negative, 2.4)` in the arm that `step()` discards still
 * produces a NaN, and `mix(a, NaN, 0.0)` is `a + 0*(NaN - a)` = NaN. Blend
 * functions legitimately leave [0,1] — `color-burn` returns large negatives by
 * construction — so `srgbToLinear` WILL be handed negative values on the
 * Photoshop-parity path. Clamping the `pow` argument keeps the discarded arm
 * finite while the linear arm (`c / 12.92`) still carries negatives through
 * with their sign, which is what the overshoot-preserving RGBA16F stack wants.
 */
export const GLSL_TRANSFER = `
vec3 srgbToLinear(vec3 c) {
  vec3 hi = pow(max((c + 0.055) / 1.055, vec3(0.0)), vec3(2.4));
  return mix(c / 12.92, hi, step(vec3(0.04045), c));
}
vec3 linearToSrgb(vec3 c) {
  c = max(c, vec3(0.0));
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}`

/**
 * Ordered dithering for the RGBA8 fallback. Applied AT STORE TIME, not at
 * display: the fallback keeps linear values in 8 bits, and without a dither the
 * shadows band badly (spec 09 §4.5).
 */
export const GLSL_DITHER = `
float bayer8(vec2 p) {
  ivec2 i = ivec2(mod(p, 8.0));
  int b = (i.x & 4) >> 2 | (i.y & 4) >> 1 | (i.x & 2) << 1 | (i.y & 2) << 2
        | (i.x & 1) << 5 | (i.y & 1) << 4;
  // The bit interleave above is the standard 8x8 Bayer index; /64 puts it in [0,1).
  return float(b) / 64.0;
}
vec4 ditherStore(vec4 c) {
  float d = (bayer8(gl_FragCoord.xy) - 0.5) / 255.0;
  return vec4(c.rgb + d, c.a + d);
}`

/**
 * Coverage: the algebraic collapse of ORDER steps 4, 5 and 7 into one scalar.
 * Density attenuates how much a mask can HIDE, never how much it reveals —
 * `m' = 1 - (1 - m) * density` (spec 08 §3.1).
 */
const GLSL_COVERAGE = `
uniform sampler2D uMask;
uniform sampler2D uVecMask;
uniform sampler2D uClip;
uniform int   uHasMask, uMaskInverted;
uniform float uMaskDensity;
uniform int   uHasVecMask, uVecMaskInverted;
uniform float uVecMaskDensity;
uniform int   uHasClip;

float coverageAt(vec2 uv) {
  float cov = 1.0;
  if (uHasMask == 1) {
    float m = texture(uMask, uv).r;
    if (uMaskInverted == 1) m = 1.0 - m;
    cov *= 1.0 - (1.0 - m) * uMaskDensity;
  }
  if (uHasVecMask == 1) {
    float m = texture(uVecMask, uv).r;
    if (uVecMaskInverted == 1) m = 1.0 - m;
    cov *= 1.0 - (1.0 - m) * uVecMaskDensity;
  }
  if (uHasClip == 1) cov *= texture(uClip, uv).r;
  return cov;
}`

/**
 * `fill` (ORDER step 6, content half). Two regimes:
 *   uFillMode 0 — scale alpha: the ordinary case.
 *   uFillMode 1 — interpolate the source colour toward the mode's neutral
 *                 colour, leaving alpha alone. This is what Photoshop does for
 *                 the dodge/burn/light/difference family, and it is the only
 *                 way "fill 50 % + Color Dodge" matches (spec 08 §5.3).
 */
const GLSL_FILL = `
uniform float uFill;
uniform int   uFillMode;
uniform float uFillNeutral;

vec4 applyFill(vec4 premul) {
  if (uFillMode == 0) return premul * uFill;
  float a = premul.a;
  if (a <= 0.0) return premul;
  vec3 Cs = clamp(premul.rgb / a, 0.0, BLEND_UNPREMUL_MAX);
  Cs = mix(vec3(uFillNeutral), Cs, uFill);
  return vec4(Cs * a, a);
}`

/**
 * Composition wrapper — the ONLY place the blend space is applied.
 *
 * The alpha algebra and the three colour terms below are transcribed from
 * `GLSL_COMPOSITE` in `layer/blend/glsl.ts`, which is the reference. The single
 * difference is the two lines that compute `B`: everything around them is
 * linear premultiplied, in both spaces.
 *
 * Because that transcription could drift from the reference if `blend/` ever
 * changes, the shader keeps a permanent test seam: `uUseReferenceComposite`
 * routes to the untouched `blendComposite()` from `blend/`, and a GPU test
 * asserts the two agree exactly in linear mode across every blend mode. If the
 * reference moves, that test fails instead of the rendering quietly diverging.
 *
 * Note what is NOT here: no `as*(1-ab)*Cs` special case, no `a < 0.0001`
 * branch, no division. The three-term premultiplied form has none of them, and
 * that is precisely why the "Multiply over empty canvas renders black" bug
 * cannot come back through this path, in either space.
 */
function glslGraphComposite(space: BlendSpace): string {
  const bExpr =
    space === 'srgb-encoded'
      ? // Photoshop parity: B sees sRGB-ENCODED values, its result comes back
        // to linear before touching the composition. See the header note.
        'srgbToLinear(blendMode(mode, linearToSrgb(Cb), linearToSrgb(Cs)))'
      : 'blendMode(mode, Cb, Cs)'

  return `
BlendPixel graphComposite(int mode, int compOp, vec3 cbP, float ab, vec3 csP, float as) {
  // Un-premultiply to straight LINEAR colours (guarded at UNPREMUL_MAX).
  vec3 Cb = blendUnpremul(cbP, ab);
  vec3 Cs = blendUnpremul(csP, as);

  // B(Cb, Cs) — the ONLY step affected by the blend space.
  // normal / dissolve / pass-through short-circuit to Cs, so they are provably
  // identical in both spaces: encode followed by decode is the identity.
  vec3 B = (mode == M_NORMAL || mode == M_DISSOLVE || mode == M_PASS_THROUGH)
         ? Cs
         : ${bExpr};

  // Everything below is LINEAR PREMULTIPLIED, in both spaces.
  BlendPixel o;
  if (compOp == COMP_CLIP_TO_BACKDROP) {
    o.a   = ab;
    o.rgb = mix(cbP, B * ab, as);
  } else if (compOp == COMP_CLIP_TO_LAYER) {
    o.a   = as;
    o.rgb = (1.0 - ab) * csP + (ab * as) * B;
  } else if (compOp == COMP_INTERSECTION) {
    o.a   = ab * as;
    o.rgb = (ab * as) * B;
  } else {
    // union. Three colour terms: the first is the one the current renderer is
    // missing, the second is the backdrop, the third is the blend proper.
    o.a   = as + ab * (1.0 - as);
    o.rgb = (1.0 - as) * cbP + (1.0 - ab) * csP + (ab * as) * B;
  }
  return o;
}`
}

export interface CompositeShaderOptions {
  /** Emit a branch-free single-mode `blendMode()` instead of the dispatch. */
  mode?: BlendMode
  /** RGBA8 fallback: dither at store time. */
  dither?: boolean
  /** Space in which B() is evaluated. Composition is linear regardless. */
  space?: BlendSpace
}

export function compositeShaderKey(o: CompositeShaderOptions): string {
  return `composite/${o.mode ?? '*'}/${o.dither ? 'd' : 'n'}/${o.space ?? DEFAULT_BLEND_SPACE}`
}

/**
 * One layer onto the accumulator. This is the pass that implements ORDER steps
 * 4 through 9 for a single source.
 */
export function compositeFragment(o: CompositeShaderOptions = {}): string {
  const space = o.space ?? DEFAULT_BLEND_SPACE
  return `#version 300 es
precision highp float;   // MANDATORY: mediump destroys color-burn / divide.

${blendModeChunk(o.mode)}
${GLSL_TRANSFER}
${glslGraphComposite(space)}
${GLSL_COVERAGE}
${GLSL_FILL}
${o.dither ? GLSL_DITHER : ''}

uniform sampler2D uBase;
uniform sampler2D uSrc;
uniform float uOpacity;
uniform int   uMode;
uniform int   uCompOp;
/**
 * 1 = emit the coverage-scaled premultiplied SOURCE and let the fixed-function
 * blender do the composition (the exact-hardware path, and the eraser).
 * 0 = do the whole PDF composition here against uBase.
 */
uniform int   uEmitSourceOnly;
/**
 * Test seam, permanent and free (uniform branch, warp-uniform). 1 routes to the
 * untouched blendComposite() of layer/blend/glsl.ts so a GPU test can prove the
 * graph's composition has not drifted from the reference. Always 0 in
 * production.
 */
uniform int   uUseReferenceComposite;
/** Document-space origin and span of this tile, for dissolve. */
uniform vec2  uTileOrigin;
uniform vec2  uTileSpan;
uniform uint  uSeed;

in vec2 vUv;
out vec4 fragColor;

void main() {
  vec4 src = texture(uSrc, vUv);

  src = applyFill(src);                        // (6) fill — content only
  src *= coverageAt(vUv) * uOpacity;           // (4)(5)(7) coverage, (6) opacity

  if (uMode == M_DISSOLVE) {
    // Drawn in DOCUMENT coordinates: in screen coordinates the pattern would
    // stick to the viewport and crawl while panning.
    ivec2 dp = ivec2(floor(uTileOrigin + vUv * uTileSpan));
    float a = src.a;
    float k = dissolveRand(dp, uSeed) < a ? 1.0 : 0.0;
    src = a > 0.0 ? vec4(src.rgb * (k / a), k) : vec4(0.0);
  }

  vec4 outc;
  if (uEmitSourceOnly == 1) {
    outc = src;
  } else {
    // (9) blend mode + the full three-term PDF composition.
    // NOTE: an if/else, not a ternary — GLSL forbids the ternary operator on
    // struct types (ANGLE rejects it outright).
    vec4 base = texture(uBase, vUv);
    BlendPixel o;
    if (uUseReferenceComposite == 1) {
      o = blendComposite(uMode, uCompOp, base.rgb, base.a, src.rgb, src.a);
    } else {
      o = graphComposite(uMode, uCompOp, base.rgb, base.a, src.rgb, src.a);
    }
    outc = vec4(o.rgb, o.a);
  }

  // NaN flush: isnan() is unreliable across drivers, a wide clamp is not.
  outc = vec4(clamp(outc.rgb, -64.0, 64.0), clamp(outc.a, 0.0, 1.0));
  ${o.dither ? 'outc = ditherStore(outc);' : ''}
  fragColor = outc;
}`
}

/**
 * Fused run of N plain `normal` layers (spec 09 §7.1). Exact, not an
 * approximation: `source-over` is associative, and every fused source is
 * unmasked, unclipped and at full opacity by construction.
 *
 * Deliberately free of any blend-space handling: `normal` has B = Cs, so it is
 * identical in both spaces and the fold stays pure linear `source-over`.
 */
export function fusedFragment(count: number, dither = false): string {
  const decls = Array.from({ length: count }, (_, i) => `uniform sampler2D uSrc${i};`).join('\n')
  const folds = Array.from(
    { length: count },
    (_, i) => `  { vec4 s = texture(uSrc${i}, vUv); acc = vec4(s.rgb + acc.rgb * (1.0 - s.a), s.a + acc.a * (1.0 - s.a)); }`,
  ).join('\n')
  return `#version 300 es
precision highp float;
${dither ? GLSL_DITHER : ''}
uniform sampler2D uBase;
${decls}
in vec2 vUv;
out vec4 fragColor;
void main() {
  vec4 acc = texture(uBase, vUv);
${folds}
  vec4 outc = vec4(clamp(acc.rgb, -64.0, 64.0), clamp(acc.a, 0.0, 1.0));
  ${dither ? 'outc = ditherStore(outc);' : ''}
  fragColor = outc;
}`
}

export const fusedShaderKey = (count: number, dither: boolean): string =>
  `fused/${count}/${dither ? 'd' : 'n'}`

/**
 * Alpha snapshot for clipping.
 *
 * With a baseline, the base's OWN alpha is recovered exactly, because
 * `source-over` is invertible in alpha:
 *
 *     a_after = a_base + a_before * (1 - a_base)
 *  => a_base  = (a_after - a_before) / (1 - a_before)
 *
 * so the snapshot is correct even when the base was drawn onto a non-empty
 * accumulator, and even when back-placed styles were drawn before it.
 */
export const FRAG_SNAPSHOT_ALPHA = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform sampler2D uBaseline;
uniform int uHasBaseline;
in vec2 vUv;
out vec4 fragColor;
void main() {
  float after = texture(uSrc, vUv).a;
  float a = after;
  if (uHasBaseline == 1) {
    float before = texture(uBaseline, vUv).a;
    a = clamp((after - before) / max(1.0 - before, 1e-6), 0.0, 1.0);
  }
  fragColor = vec4(a, a, a, a);
}`

/** Straight copy — seeds a `backdrop` group register, and blits registers. */
export const FRAG_BLIT = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
in vec2 vUv;
out vec4 fragColor;
void main() { fragColor = texture(uSrc, vUv); }`

/**
 * Resolve pixel mask x vector mask x densities into one coverage texture, so a
 * layer carrying both samples one texture instead of two.
 */
export const FRAG_MASK_RESOLVE = `#version 300 es
precision highp float;
${GLSL_COVERAGE}
in vec2 vUv;
out vec4 fragColor;
void main() { float c = coverageAt(vUv); fragColor = vec4(c, c, c, c); }`

/**
 * `pass-through` group whose contribution must still be scaled: the children
 * already composited against the backdrop, so the resolution is a MIX between
 * backdrop and result, not an `over`.
 *
 * Photoshop forces isolation in this situation, so `compilePlan` never emits
 * it; the pass exists because the PDF model does allow it and a future document
 * flag may want it.
 */
export const FRAG_GROUP_LERP = `#version 300 es
precision highp float;
${GLSL_COVERAGE}
uniform sampler2D uBase;
uniform sampler2D uSrc;
uniform float uOpacity;
in vec2 vUv;
out vec4 fragColor;
void main() {
  vec4 b = texture(uBase, vUv);
  vec4 s = texture(uSrc, vUv);
  fragColor = mix(b, s, uOpacity * coverageAt(vUv));
}`

/**
 * Adjustment layer. Reads the accumulator, un-premultiplies, runs the LUT,
 * re-premultiplies. The composite operator is `clip-to-backdrop`: alpha is
 * preserved exactly (`ar = ab`), so an adjustment can never add or remove
 * opacity — which is what makes it a no-op over empty canvas.
 */
export const FRAG_ADJUST = `#version 300 es
precision highp float;
${GLSL_COVERAGE}
uniform sampler2D uBase;
/** 256x1 per-channel LUT, or a tiled 3D LUT flattened to 2D. */
uniform sampler2D uLut;
uniform float uOpacity;
uniform int   uLut3D;
uniform float uLutSize;
in vec2 vUv;
out vec4 fragColor;

vec3 lut1D(vec3 c) {
  return vec3(
    texture(uLut, vec2(clamp(c.r, 0.0, 1.0), 0.5)).r,
    texture(uLut, vec2(clamp(c.g, 0.0, 1.0), 0.5)).g,
    texture(uLut, vec2(clamp(c.b, 0.0, 1.0), 0.5)).b);
}
vec3 lut3D(vec3 c) {
  float n = uLutSize;
  c = clamp(c, 0.0, 1.0);
  float b = c.b * (n - 1.0);
  float b0 = floor(b), b1 = min(b0 + 1.0, n - 1.0), f = b - b0;
  vec2 uvA = vec2((b0 + c.r * (n - 1.0) / n) / n, c.g);
  vec2 uvB = vec2((b1 + c.r * (n - 1.0) / n) / n, c.g);
  return mix(texture(uLut, uvA).rgb, texture(uLut, uvB).rgb, f);
}

void main() {
  vec4 base = texture(uBase, vUv);
  float ab = base.a;
  vec3 Cb = ab > 0.0 ? clamp(base.rgb / ab, 0.0, 64.0) : vec3(0.0);
  vec3 Cf = uLut3D == 1 ? lut3D(Cb) : lut1D(Cb);
  float k = uOpacity * coverageAt(vUv);
  vec3 Cr = mix(Cb, Cf, k);
  // clip-to-backdrop: alpha is untouched, by definition.
  fragColor = vec4(Cr * ab, ab);
}`

/**
 * GPU thumbnail reduction — the fix for goulet G2.
 *
 * Today a 44x32 thumbnail is produced by a synchronous full-document
 * `readPixels` (64 MiB per thumbnail, 1.88 GiB for 30 layers, with a measured
 * 395-804 ms `getImageData`). This pass reduces the coarsest available LOD into
 * a 128x128 target with a 2x2 box filter, in linear premultiplied space where
 * averaging is actually correct, then encodes to sRGB for the DOM.
 *
 * Cost: a few thousand fragments, and a 64 KiB async readback. About x1000 less.
 */
export const FRAG_THUMBNAIL = `#version 300 es
precision highp float;
${GLSL_TRANSFER}
uniform sampler2D uSrc;
uniform vec2 uTexel;
/** 1 = encode to sRGB for display; 0 = keep linear. */
uniform int uEncode;
in vec2 vUv;
out vec4 fragColor;
void main() {
  // Box 2x2 on premultiplied values: correct by construction, no dark halo.
  vec4 c = texture(uSrc, vUv + vec2(-0.25, -0.25) * uTexel)
         + texture(uSrc, vUv + vec2( 0.25, -0.25) * uTexel)
         + texture(uSrc, vUv + vec2(-0.25,  0.25) * uTexel)
         + texture(uSrc, vUv + vec2( 0.25,  0.25) * uTexel);
  c *= 0.25;
  if (uEncode == 1) {
    float a = c.a;
    vec3 straight = a > 0.0 ? clamp(c.rgb / a, 0.0, 1.0) : vec3(0.0);
    c = vec4(linearToSrgb(straight) * a, a);
  }
  fragColor = c;
}`
