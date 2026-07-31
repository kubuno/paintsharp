// Blur family — a real separable Gaussian, plus box, directional, radial and
// average (reduction) blurs.
//
// What this replaces: `layerFilters.boxBlur3` — three box iterations on CPU
// Float32Arrays, 512 MiB of transient allocation on a 4000×4000 document, and
// `r = max(1, round(radius/3))` which silently ignores any radius below 4.5 px.
// Three boxes only converge to a Gaussian asymptotically; the error is visible
// on gradients and on unsharp-mask halos.
//
// The replacement is a true Gaussian, separated into two 1-D passes, with
// BILINEAR TAP MERGING: two adjacent texels are fetched in one `texture()` call
// at a weighted offset, so a radius-r kernel costs ceil((2r+1)/2) fetches
// instead of 2r+1. Everything runs on premultiplied linear samples, which is
// what makes blurring across transparent edges correct without the
// premultiply/unpremultiply dance the CPU version does per pixel.
//
// Radius→sigma follows the GIMP/GEGL convention (gegl gaussian-blur:
// `std_dev = radius / 3` for the "radius" UI parameter, kernel truncated at 3σ,
// i.e. < 0.3 % of the kernel mass discarded).

import { fragmentShader, GLSL_HASH } from './glsl/common'
import type { GpuPass, ParamValues } from './types'

/** Uniform array size in the tap shaders. Must match `MAX_TAPS` in the GLSL. */
export const MAX_TAPS = 32

/**
 * Largest kernel half-width still expressible with MAX_TAPS merged taps.
 * taps = 1 + ceil(K/2) ≤ 32 ⇒ K ≤ 62. 48 is used to keep a safety margin and
 * because past that the LOD path is cheaper anyway.
 */
export const MAX_RADIUS_PER_LEVEL = 48

export interface GaussianTaps {
  /** Tap offsets in PIXELS along the blur axis, offsets[0] === 0. */
  offsets: Float32Array
  /** Weights, normalised so w0 + 2·Σw(i>0) === 1. */
  weights: Float32Array
  /** Number of valid entries (≤ MAX_TAPS). */
  count: number
}

/**
 * Gaussian weights with bilinear tap merging.
 * sigma = radius / 3 gives a kernel whose truncation error is < 0.3 %.
 * Adjacent taps i, i+1 are merged into one fetch at
 *   offset = (i·w_i + (i+1)·w_{i+1}) / (w_i + w_{i+1}),  weight = w_i + w_{i+1}.
 */
export function gaussianTaps(radius: number, maxTaps: number = MAX_TAPS): GaussianTaps {
  const r = Math.max(0, radius)
  const sigma = Math.max(1e-3, r / 3)
  const half = Math.max(1, Math.ceil(3 * sigma))

  // Discrete Gaussian samples, index 0..half.
  const g = new Float64Array(half + 2)
  for (let i = 0; i <= half; i++) g[i] = Math.exp(-(i * i) / (2 * sigma * sigma))

  const offsets = new Float32Array(maxTaps)
  const weights = new Float32Array(maxTaps)
  offsets[0] = 0
  weights[0] = g[0]
  let n = 1
  let total = g[0]
  for (let i = 1; i <= half && n < maxTaps; i += 2) {
    const w1 = g[i]
    const w2 = i + 1 <= half ? g[i + 1] : 0
    const w = w1 + w2
    if (w <= 0) break
    offsets[n] = (i * w1 + (i + 1) * w2) / w
    weights[n] = w
    total += 2 * w
    n++
  }
  for (let i = 0; i < n; i++) weights[i] /= total
  return { offsets, weights, count: n }
}

/** Box (uniform) weights with the same bilinear merging, 1 iteration. */
export function boxTaps(radius: number, maxTaps: number = MAX_TAPS): GaussianTaps {
  const half = Math.max(1, Math.round(radius))
  const offsets = new Float32Array(maxTaps)
  const weights = new Float32Array(maxTaps)
  offsets[0] = 0
  weights[0] = 1
  let n = 1
  let total = 1
  for (let i = 1; i <= half && n < maxTaps; i += 2) {
    const w2 = i + 1 <= half ? 1 : 0
    const w = 1 + w2
    // Equal weights ⇒ the merged offset is the midpoint of the two texels.
    offsets[n] = (i * 1 + (i + 1) * w2) / w
    weights[n] = w
    total += 2 * w
    n++
  }
  for (let i = 0; i < n; i++) weights[i] /= total
  return { offsets, weights, count: n }
}

export interface GaussianPlan {
  /** Number of 2× reductions applied before blurring (0 = full resolution). */
  level: number
  /** Radius to use at that level. */
  radius: number
}

/**
 * Large radii are done on a reduced LOD: a Gaussian of radius 128 at level 0 is
 * a Gaussian of radius 32 at level 2, to within a sampling error that is
 * invisible for a blur. Cost becomes bounded and independent of radius.
 */
export function planGaussian(radius: number): GaussianPlan {
  let level = 0
  let r = radius
  while (r > MAX_RADIUS_PER_LEVEL && level < 5) { r /= 2; level++ }
  return { level, radius: r }
}

// ── Shaders ───────────────────────────────────────────────────────────────────

/**
 * Symmetric separable tap shader. Works on premultiplied linear samples, so no
 * unpremultiply is needed and transparent neighbours cannot bleed colour.
 */
export const BLUR_TAPS_FRAG = fragmentShader(`
uniform vec2  uDir;                  // (texel.x, 0) horizontal, (0, texel.y) vertical
uniform int   uTaps;
uniform float uOffsets[${MAX_TAPS}];
uniform float uWeights[${MAX_TAPS}];

void main() {
  vec4 acc = texture(uSrc, vUv) * uWeights[0];
  for (int i = 1; i < ${MAX_TAPS}; i++) {
    if (i >= uTaps) break;
    vec2 o = uDir * uOffsets[i];
    acc += (texture(uSrc, clamp(vUv + o, vec2(0.0), vec2(1.0)))
          + texture(uSrc, clamp(vUv - o, vec2(0.0), vec2(1.0)))) * uWeights[i];
  }
  fragColor = acc;
}
`)

/**
 * One-sided / asymmetric tap shader used by motion blur: every tap is applied
 * once, at a signed offset, so a trailing profile is just a weight table.
 */
export const BLUR_DIRECTIONAL_FRAG = fragmentShader(`
uniform vec2  uDir;                  // unit direction × pixel step, in UV
uniform int   uTaps;
uniform float uOffsets[${MAX_TAPS}];
uniform float uWeights[${MAX_TAPS}];

void main() {
  vec4 acc = vec4(0.0);
  for (int i = 0; i < ${MAX_TAPS}; i++) {
    if (i >= uTaps) break;
    acc += texture(uSrc, clamp(vUv + uDir * uOffsets[i], vec2(0.0), vec2(1.0))) * uWeights[i];
  }
  fragColor = acc;
}
`)

/** Exact 2×2 box reduction: one bilinear fetch at the centre of the 4 texels. */
export const DOWNSAMPLE_FRAG = fragmentShader(`
void main() { fragColor = texture(uSrc, vUv); }
`)

/** Bilinear magnification back to full resolution (blur output only). */
export const UPSAMPLE_FRAG = DOWNSAMPLE_FRAG

/**
 * Radial blur — spin (rotation) and zoom (scale) about the layer centre.
 * Ports `layerFilters.radialBlur` (12 point samples on CPU) with the same
 * geometry, plus: adaptive sample count and a hashed offset dither that removes
 * the concentric banding visible at low sample counts.
 */
export const RADIAL_BLUR_FRAG = fragmentShader(`
uniform float uAmount;      // legacy "strength" slider
uniform int   uSamples;
uniform int   uSpin;        // 1 = spin, 0 = zoom
uniform int   uDither;

void main() {
  vec2 c = uSize * 0.5;
  vec2 p = pixelCoord();
  float n = float(uSamples);
  float jitter = uDither == 1 ? (rand2(ivec2(gl_FragCoord.xy), uint(uSeed)) - 0.5) : 0.0;
  vec4 acc = vec4(0.0);
  for (int k = 0; k < 256; k++) {
    if (k >= uSamples) break;
    float t = ((float(k) + jitter) / (n - 1.0) - 0.5) * uAmount;
    vec2 s;
    if (uSpin == 1) {
      float a = t * 0.05;
      float cs = cos(a), sn = sin(a);
      vec2 d = p - c;
      s = c + vec2(d.x * cs - d.y * sn, d.x * sn + d.y * cs);
    } else {
      s = c + (p - c) * (1.0 + t * 0.02);
    }
    acc += fetchPixel(clamp(s, vec2(0.0), uSize - 1.0));
  }
  fragColor = acc / n;
}
`, [GLSL_HASH])

/** Broadcast a 1×1 average over the layer, keeping the original alpha. */
export const AVERAGE_APPLY_FRAG = fragmentShader(`
uniform sampler2D uAvg;
void main() {
  vec4 s = texture(uSrc, vUv);
  vec4 m = texture(uAvg, vec2(0.5));
  vec3 avg = unpremul(m);
  fragColor = premul(avg, s.a);
}
`)

// ── Pass builders ─────────────────────────────────────────────────────────────

const half = (v: number) => Math.max(1, Math.ceil(v / 2))

function reduceChain(level: number): GpuPass[] {
  const passes: GpuPass[] = []
  for (let l = 1; l <= level; l++) {
    const lv = l
    passes.push({
      name: `down${lv}`,
      key: 'blur/down',
      glsl: DOWNSAMPLE_FRAG,
      size: (_p, w, h) => {
        let nw = w, nh = h
        for (let i = 0; i < lv; i++) { nw = half(nw); nh = half(nh) }
        return [nw, nh]
      },
    })
  }
  return passes
}

function tapUniforms(taps: GaussianTaps, dir: 'x' | 'y') {
  return (ctx: { width: number; height: number }) => ({
    uDir: dir === 'x' ? [1 / ctx.width, 0] : [0, 1 / ctx.height],
    uTaps: taps.count,
    uOffsets: taps.offsets,
    uWeights: taps.weights,
  })
}

/**
 * Two separable passes (plus a LOD reduce/expand pair for large radii).
 * `kind` selects the weight profile: a true Gaussian or a true single-iteration
 * box (the legacy "box blur" entry actually ran the 3-iteration Gaussian).
 */
export function blurPasses(radius: number, kind: 'gaussian' | 'box' = 'gaussian'): GpuPass[] {
  if (radius <= 0) return [{ name: 'copy', key: 'blur/copy', glsl: DOWNSAMPLE_FRAG }]
  const plan = kind === 'gaussian' ? planGaussian(radius) : { level: 0, radius }
  const taps = kind === 'gaussian' ? gaussianTaps(plan.radius) : boxTaps(plan.radius)
  const lodSize = (_p: ParamValues, w: number, h: number): readonly [number, number] => {
    let nw = w, nh = h
    for (let i = 0; i < plan.level; i++) { nw = half(nw); nh = half(nh) }
    return [nw, nh]
  }
  const passes: GpuPass[] = [...reduceChain(plan.level)]
  passes.push(
    { name: 'blurX', key: 'blur/taps', glsl: BLUR_TAPS_FRAG, uniforms: tapUniforms(taps, 'x'), size: lodSize },
    { name: 'blurY', key: 'blur/taps', glsl: BLUR_TAPS_FRAG, uniforms: tapUniforms(taps, 'y'), size: lodSize },
  )
  if (plan.level > 0) passes.push({ name: 'expand', key: 'blur/expand', glsl: UPSAMPLE_FRAG })
  return passes
}

/**
 * Motion blur: one oriented pass instead of the CPU's `2·steps+1` point samples
 * (up to 241 per pixel at distance 120). `trail` in [0,1] biases the profile to
 * one side (0 = symmetric streak, 1 = pure trailing smear).
 */
export function motionTaps(distance: number, trail: number): GaussianTaps {
  const d = Math.max(1, Math.round(distance))
  // One tap per two pixels of streak (bilinear merging), clamped to MAX_TAPS.
  const n = Math.min(MAX_TAPS, Math.max(2, Math.ceil(d) + 1))
  const offsets = new Float32Array(MAX_TAPS)
  const weights = new Float32Array(MAX_TAPS)
  let total = 0
  for (let i = 0; i < n; i++) {
    const u = n === 1 ? 0 : i / (n - 1)            // 0..1 along the streak
    const t = (u - 0.5) * 2                        // -1..1
    offsets[i] = t * d
    // Symmetric box profile blended towards a one-sided ramp.
    const w = (1 - trail) + trail * Math.max(0, 0.5 * (1 - t))
    weights[i] = w
    total += w
  }
  for (let i = 0; i < n; i++) weights[i] /= total
  return { offsets, weights, count: n }
}

export function motionPasses(angleDeg: number, distance: number, trail = 0): GpuPass[] {
  const taps = motionTaps(distance, trail)
  const rad = (angleDeg * Math.PI) / 180
  const dx = Math.cos(rad), dy = Math.sin(rad)
  return [{
    name: 'motion',
    key: 'blur/directional',
    glsl: BLUR_DIRECTIONAL_FRAG,
    uniforms: ctx => ({
      uDir: [dx / ctx.width, dy / ctx.height],
      uTaps: taps.count,
      uOffsets: taps.offsets,
      uWeights: taps.weights,
    }),
  }]
}

export function radialPasses(amount: number, spin: boolean): GpuPass[] {
  // Adaptive quality: more samples as the streak grows, capped at 64.
  const samples = Math.max(12, Math.min(64, Math.round(12 + amount * 0.5)))
  return [{
    name: 'radial',
    key: 'blur/radial',
    glsl: RADIAL_BLUR_FRAG,
    uniforms: () => ({ uAmount: amount, uSamples: samples, uSpin: spin ? 1 : 0, uDither: 1 }),
  }]
}

/**
 * Average blur as a GPU reduction: a chain of 2× box reductions down to 1×1,
 * then one pass that broadcasts the alpha-weighted mean colour while keeping
 * the original alpha (identical definition to the CPU version).
 */
export function averagePasses(width: number, height: number): GpuPass[] {
  const passes: GpuPass[] = []
  let w = width, h = height, i = 0
  while (w > 1 || h > 1) {
    w = half(w); h = half(h); i++
    const tw = w, th = h
    passes.push({ name: `reduce${i}`, key: 'blur/down', glsl: DOWNSAMPLE_FRAG, size: () => [tw, th] })
  }
  passes.push({
    name: 'apply',
    key: 'blur/averageApply',
    glsl: AVERAGE_APPLY_FRAG,
    inputs: { uSrc: 'source', uAvg: { pass: passes.length ? `reduce${i}` : 'source' } },
  })
  return passes
}
