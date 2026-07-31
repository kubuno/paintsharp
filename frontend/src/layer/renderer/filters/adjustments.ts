// Non-destructive adjustments, on GPU, one pass.
//
// ── Why this file exists ─────────────────────────────────────────────────────
// `imaging/adjustments.applyAdjustments` allocates a full copy of the layer and
// walks every pixel on the main thread, with an RGB→HSL→RGB round trip per
// pixel as soon as hue or saturation is non-zero (248–867 ms on a 4000×4000
// document, per slider frame). Worse, the result is BAKED into the layer, so
// every slider move re-quantises to 8 bits.
//
// Here an adjustment is a pure per-pixel function compiled into a fragment
// shader. It is a PASS of the composite plan, never a rewrite of the layer
// texture: undo is free and there is no 8-bit round trip.
//
// ── Working space: read this before adding an adjustment ─────────────────────
// The engine works in RGBA16F, LINEAR light, PREMULTIPLIED alpha. An adjustment
// is defined in ONE of two spaces and must declare which:
//
//   'linear'      the maths are physical: exposure (×2^stops is only exposure
//                 in linear light), luminance (Rec.709 weights are only valid
//                 in linear light), Oklab hue/saturation.
//   'perceptual'  the maths are defined on sRGB-ENCODED values: levels, curves,
//                 posterize, threshold, brightness/contrast, colour balance.
//                 These have a fixed 0..1 domain with a perceptual midpoint at
//                 0.5; running them in linear light moves the midpoint to 0.21
//                 and blows out every midtone. This is THE classic mistake.
//
// The shader wrapper does the conversion: `unpremul` → (optionally)
// `linearToSrgb` → body → (optionally) `srgbToLinear` → `premul`.
//
// INVARIANT: an adjustment NEVER touches alpha (`dest.a = src.a`). This is what
// makes the clip-to-backdrop composite mode correct for adjustment layers.
//
// ── Attribution ──────────────────────────────────────────────────────────────
// Brightness/Contrast (legacy mode), Levels, Colour Balance, Desaturate,
// Threshold and Posterize follow the formulas of GIMP (GPLv3), files
// `app/operations/gimpoperation{brightnesscontrast,levels,colorbalance,
// desaturate,threshold,posterize}.c`, reimplemented in GLSL. Oklab is Björn
// Ottosson's public-domain reference implementation.

import { GLSL_HEADER, GLSL_COLORSPACE, GLSL_OKLAB, GLSL_SAMPLING } from './glsl/common'
import type { GpuPass, LutData } from './types'
import type { UniformMap } from './device'

// ── Model ────────────────────────────────────────────────────────────────────

export type CurvePoints = readonly (readonly [number, number])[]

export interface LevelsParams {
  lowInput:   number   // 0..1
  highInput:  number   // 0..1
  gamma:      number   // 0.1..10
  lowOutput:  number   // 0..1
  highOutput: number   // 0..1
}

export const LEVELS_IDENTITY: LevelsParams =
  { lowInput: 0, highInput: 1, gamma: 1, lowOutput: 0, highOutput: 1 }

/** Photoshop's six colour families, as fractions of 100 %. */
export interface BWWeights {
  red: number; yellow: number; green: number; cyan: number; blue: number; magenta: number
}

export const BW_DEFAULT: BWWeights =
  { red: 0.4, yellow: 0.6, green: 0.4, cyan: 0.6, blue: 0.2, magenta: 0.8 }

export type RGBTriple = readonly [number, number, number]

export type AdjustmentSpec =
  | { type: 'brightnessContrast'; brightness: number; contrast: number }
  | { type: 'exposure';           exposure: number; offset: number; gammaCorrection: number }
  | { type: 'saturation';         saturation: number }
  | { type: 'hue';                hue: number }
  | { type: 'levels';             master: LevelsParams; red?: LevelsParams; green?: LevelsParams; blue?: LevelsParams }
  | { type: 'curves';             master: CurvePoints; red?: CurvePoints; green?: CurvePoints; blue?: CurvePoints }
  | { type: 'vibrance';           vibrance: number }
  | { type: 'blackAndWhite';      weights: BWWeights; tint: RGBTriple | null }
  | { type: 'colorBalance';       shadows: RGBTriple; midtones: RGBTriple; highlights: RGBTriple; preserveLuminosity: boolean }
  | { type: 'invert' }
  | { type: 'threshold';          level: number }
  | { type: 'posterize';          levels: number }

export type AdjustmentType = AdjustmentSpec['type']

export type ColorSpaceMode = 'linear' | 'perceptual'

export interface AdjustmentImpl<S extends AdjustmentSpec> {
  readonly type: S['type']
  /** Space the body's `vec3 c` is expressed in. */
  readonly space: ColorSpaceMode
  /** Uniform declarations, unique names (prefixed by the adjustment type). */
  readonly declarations: string
  /** GLSL body. Reads and writes `vec3 c`. May call helpers from the prelude. */
  readonly glsl: string
  readonly uniforms: (s: S) => UniformMap
  /** Lookup textures the adjustment needs (curves only, today). */
  readonly luts?: (s: S) => Readonly<Record<string, LutData>>
  /** CPU reference — the ground truth the shader is verified against. */
  readonly applyPixel: (s: S, r: number, g: number, b: number) => [number, number, number]
  /** Neutral parameters ⇒ the whole pass can be skipped. */
  readonly isIdentity: (s: S) => boolean
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

// ── 1. Brightness / Contrast (perceptual) ────────────────────────────────────
// GIMP `gimp_operation_brightness_contrast_map`
// (app/operations/gimpoperationbrightnesscontrast.c, GPLv3):
//   brightness /= 2;  slant = tan((contrast + 1) * PI/4)
//   v = brightness < 0 ? v * (1 + brightness) : v + (1 - v) * brightness
//   v = (v - 0.5) * slant + 0.5
// No clamping in GIMP; contrast is clamped to ±0.999 upstream because
// tan(PI/2) is infinite.
//
// DELIBERATE DEVIATION: GIMP runs this operation on "RGBA float", i.e. in
// LINEAR light (its point filter defaults to GIMP_TRC_LINEAR and this op never
// binds a "trc" property). We run it in PERCEPTUAL space because the midpoint
// of the S-curve, 0.5, must be the perceptual midtone — that is the Photoshop
// behaviour the editor's sliders are calibrated against (spec 08 §6.3: "c ∈
// [0,1] en sRGB encodé (parité Photoshop)"). Running it in linear light moves
// the pivot to 0.21 and crushes every midtone.

const brightnessContrast: AdjustmentImpl<Extract<AdjustmentSpec, { type: 'brightnessContrast' }>> = {
  type: 'brightnessContrast',
  space: 'perceptual',
  declarations: 'uniform float uBcBright; uniform float uBcSlant;',
  glsl: `
  c = mix(c + (vec3(1.0) - c) * uBcBright, c * (1.0 + uBcBright), step(uBcBright, 0.0));
  c = (c - 0.5) * uBcSlant + 0.5;`,
  uniforms: s => ({
    uBcBright: s.brightness / 2,
    uBcSlant: Math.tan((Math.min(0.999, Math.max(-0.999, s.contrast)) + 1) * Math.PI / 4),
  }),
  applyPixel: (s, r, g, b) => {
    const br = s.brightness / 2
    const slant = Math.tan((Math.min(0.999, Math.max(-0.999, s.contrast)) + 1) * Math.PI / 4)
    const f = (v: number) => ((br < 0 ? v * (1 + br) : v + (1 - v) * br) - 0.5) * slant + 0.5
    return [f(r), f(g), f(b)]
  },
  isIdentity: s => s.brightness === 0 && s.contrast === 0,
}

// ── 2. Exposure (LINEAR — this is the whole point) ───────────────────────────
// `applyAdjustments` multiplied ENCODED values by 2^(stops), which is not an
// exposure at all. Exposure is a scene-referred scale: out = (in + offset)·2^EV,
// only meaningful in linear light. Gamma correction is applied afterwards, as
// in GEGL's `exposure` operation.

const exposure: AdjustmentImpl<Extract<AdjustmentSpec, { type: 'exposure' }>> = {
  type: 'exposure',
  space: 'linear',
  declarations: 'uniform float uExpGain; uniform float uExpOffset; uniform float uExpGamma;',
  glsl: `
  c = max((c + uExpOffset) * uExpGain, vec3(0.0));
  if (uExpGamma != 1.0) c = pow(c, vec3(1.0 / uExpGamma));`,
  uniforms: s => ({
    uExpGain: Math.pow(2, s.exposure),
    uExpOffset: s.offset,
    uExpGamma: s.gammaCorrection,
  }),
  applyPixel: (s, r, g, b) => {
    const gain = Math.pow(2, s.exposure)
    const f = (v: number) => {
      const x = Math.max(0, (v + s.offset) * gain)
      return s.gammaCorrection === 1 ? x : Math.pow(x, 1 / s.gammaCorrection)
    }
    return [f(r), f(g), f(b)]
  },
  isIdentity: s => s.exposure === 0 && s.offset === 0 && s.gammaCorrection === 1,
}

// ── 3. Saturation (LINEAR, via Oklab) ────────────────────────────────────────
// HSL on encoded values (the legacy path) drifts lightness visibly on saturated
// reds and blues. Scaling Oklab chroma keeps lightness by construction.

const saturation: AdjustmentImpl<Extract<AdjustmentSpec, { type: 'saturation' }>> = {
  type: 'saturation',
  space: 'linear',
  declarations: 'uniform float uSatScale;',
  glsl: `
  {
    vec3 lab = linearToOklab(c);
    lab.yz *= uSatScale;
    c = max(oklabToLinear(lab), vec3(0.0));
  }`,
  uniforms: s => ({ uSatScale: 1 + s.saturation }),
  applyPixel: (s, r, g, b) => {
    const lab = linearToOklabJS(r, g, b)
    const k = 1 + s.saturation
    return oklabToLinearJS(lab[0], lab[1] * k, lab[2] * k)
  },
  isIdentity: s => s.saturation === 0,
}

// ── 4. Hue (LINEAR, via OkLCh rotation) ──────────────────────────────────────

const hue: AdjustmentImpl<Extract<AdjustmentSpec, { type: 'hue' }>> = {
  type: 'hue',
  space: 'linear',
  declarations: 'uniform float uHueCos; uniform float uHueSin;',
  glsl: `
  {
    vec3 lab = linearToOklab(c);
    vec2 ab = vec2(lab.y * uHueCos - lab.z * uHueSin, lab.y * uHueSin + lab.z * uHueCos);
    c = max(oklabToLinear(vec3(lab.x, ab)), vec3(0.0));
  }`,
  uniforms: s => ({ uHueCos: Math.cos(s.hue * Math.PI / 180), uHueSin: Math.sin(s.hue * Math.PI / 180) }),
  applyPixel: (s, r, g, b) => {
    const lab = linearToOklabJS(r, g, b)
    const a = s.hue * Math.PI / 180, cs = Math.cos(a), sn = Math.sin(a)
    return oklabToLinearJS(lab[0], lab[1] * cs - lab[2] * sn, lab[1] * sn + lab[2] * cs)
  },
  isIdentity: s => s.hue === 0,
}

// ── 5. Levels (perceptual) ───────────────────────────────────────────────────
// GIMP `gimp_operation_levels_map`:
//   v = (v - low_in) / (high_in - low_in)
//   if (gamma != 1) v = pow(v, 1/gamma)          [clamped to >= 0 first]
//   v = v * (high_out - low_out) + low_out

// GIMP applies the PER-CHANNEL map first, then the MASTER map on top (never on
// alpha). Both are the same `gimp_operation_levels_map`. Two evaluations of the
// same three lines, so one pass is still enough.

const levels: AdjustmentImpl<Extract<AdjustmentSpec, { type: 'levels' }>> = {
  type: 'levels',
  space: 'perceptual',
  declarations: `
uniform vec3 uLevLo; uniform vec3 uLevHi; uniform vec3 uLevGamma;
uniform vec3 uLevOutLo; uniform vec3 uLevOutHi;
uniform vec3 uLevMLo; uniform vec3 uLevMHi; uniform vec3 uLevMGamma;
uniform vec3 uLevMOutLo; uniform vec3 uLevMOutHi;
vec3 levelsMap(vec3 v, vec3 lo, vec3 hi, vec3 gamma, vec3 ol, vec3 oh) {
  vec3 d = hi - lo;
  v = mix(v - lo, (v - lo) / d, step(vec3(1e-9), abs(d)));
  v = mix(v, pow(max(v, vec3(0.0)), vec3(1.0) / gamma), step(vec3(1e-9), abs(gamma - 1.0)));
  return v * (oh - ol) + ol;
}`,
  glsl: `
  c = levelsMap(c, uLevLo, uLevHi, uLevGamma, uLevOutLo, uLevOutHi);
  c = levelsMap(c, uLevMLo, uLevMHi, uLevMGamma, uLevMOutLo, uLevMOutHi);`,
  uniforms: s => {
    const ch = (c?: LevelsParams) => c ?? LEVELS_IDENTITY
    const r = ch(s.red), g = ch(s.green), b = ch(s.blue), m = s.master
    const tri = (v: number) => [v, v, v]
    return {
      uLevLo:     [r.lowInput, g.lowInput, b.lowInput],
      uLevHi:     [r.highInput, g.highInput, b.highInput],
      uLevGamma:  [r.gamma, g.gamma, b.gamma],
      uLevOutLo:  [r.lowOutput, g.lowOutput, b.lowOutput],
      uLevOutHi:  [r.highOutput, g.highOutput, b.highOutput],
      uLevMLo:    tri(m.lowInput),
      uLevMHi:    tri(m.highInput),
      uLevMGamma: tri(m.gamma),
      uLevMOutLo: tri(m.lowOutput),
      uLevMOutHi: tri(m.highOutput),
    }
  },
  applyPixel: (s, r, g, b) => {
    const ch = (c?: LevelsParams) => c ?? LEVELS_IDENTITY
    const map = (v: number, p: LevelsParams) => {
      const d = p.highInput - p.lowInput
      let x = Math.abs(d) > 1e-9 ? (v - p.lowInput) / d : v - p.lowInput
      if (Math.abs(p.gamma - 1) > 1e-9) x = Math.pow(Math.max(0, x), 1 / p.gamma)
      return x * (p.highOutput - p.lowOutput) + p.lowOutput
    }
    return [
      map(map(r, ch(s.red)), s.master),
      map(map(g, ch(s.green)), s.master),
      map(map(b, ch(s.blue)), s.master),
    ]
  },
  isIdentity: s => [s.master, s.red, s.green, s.blue].every(l =>
    !l || (l.lowInput === 0 && l.highInput === 1 && l.gamma === 1 && l.lowOutput === 0 && l.highOutput === 1)),
}

// ── 6. Curves (perceptual, 1-D LUT texture) ──────────────────────────────────
// One 256×1 RGBA texture: rgb = the per-channel curves, a = the master curve.
// Per-channel is applied first, then master — GIMP's channel order.

export const CURVE_LUT_SIZE = 256

/** Monotone cubic interpolation (Fritsch–Carlson) — no overshoot on curves. */
export function buildCurveLut(points: CurvePoints, size = CURVE_LUT_SIZE): Float32Array {
  const pts = [...points].sort((a, b) => a[0] - b[0])
  const out = new Float32Array(size)
  if (pts.length === 0) { for (let i = 0; i < size; i++) out[i] = i / (size - 1); return out }
  if (pts.length === 1) { out.fill(clamp01(pts[0][1])); return out }

  const n = pts.length
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1])
  const dx: number[] = [], dy: number[] = [], slope: number[] = []
  for (let i = 0; i < n - 1; i++) {
    dx.push(Math.max(1e-6, xs[i + 1] - xs[i]))
    dy.push(ys[i + 1] - ys[i])
    slope.push(dy[i] / dx[i])
  }
  const m: number[] = new Array(n)
  m[0] = slope[0]
  m[n - 1] = slope[n - 2]
  for (let i = 1; i < n - 1; i++) {
    if (slope[i - 1] * slope[i] <= 0) m[i] = 0
    else m[i] = (slope[i - 1] + slope[i]) / 2
  }
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) { m[i] = 0; m[i + 1] = 0; continue }
    const a = m[i] / slope[i], b = m[i + 1] / slope[i]
    const s = a * a + b * b
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * slope[i]; m[i + 1] = t * b * slope[i] }
  }
  for (let i = 0; i < size; i++) {
    const x = i / (size - 1)
    if (x <= xs[0]) { out[i] = clamp01(ys[0]); continue }
    if (x >= xs[n - 1]) { out[i] = clamp01(ys[n - 1]); continue }
    let k = 0
    while (k < n - 2 && x > xs[k + 1]) k++
    const t = (x - xs[k]) / dx[k]
    const t2 = t * t, t3 = t2 * t
    const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2
    out[i] = clamp01(h00 * ys[k] + h10 * dx[k] * m[k] + h01 * ys[k + 1] + h11 * dx[k] * m[k + 1])
  }
  return out
}

const IDENTITY_CURVE: CurvePoints = [[0, 0], [1, 1]]

function sampleLut(lut: Float32Array, v: number): number {
  const x = clamp01(v) * (lut.length - 1)
  const i = Math.floor(x), f = x - i
  const a = lut[i], b = lut[Math.min(lut.length - 1, i + 1)]
  return a + (b - a) * f
}

const curves: AdjustmentImpl<Extract<AdjustmentSpec, { type: 'curves' }>> = {
  type: 'curves',
  space: 'perceptual',
  declarations: `
uniform sampler2D uCurveLut;
// Texel-centre addressing: sample i sits at (i + 0.5) / N, so the hardware
// bilinear filter reproduces GIMP's gimp_curve_map_value_inline() interpolation
// exactly. Sampling at uv = value would be off by half a texel.
vec2 lutUV(float v) { return vec2((clamp(v, 0.0, 1.0) * ${CURVE_LUT_SIZE - 1}.0 + 0.5) / ${CURVE_LUT_SIZE}.0, 0.5); }`,
  glsl: `
  {
    // Per-channel curve, then the master curve (GIMP's order in
    // gimp_curve_map_pixels: master(per_channel(x))).
    vec3 t = vec3(
      texture(uCurveLut, lutUV(c.r)).r,
      texture(uCurveLut, lutUV(c.g)).g,
      texture(uCurveLut, lutUV(c.b)).b);
    c = vec3(
      texture(uCurveLut, lutUV(t.r)).a,
      texture(uCurveLut, lutUV(t.g)).a,
      texture(uCurveLut, lutUV(t.b)).a);
  }`,
  uniforms: () => ({}),
  luts: s => {
    const r = buildCurveLut(s.red ?? IDENTITY_CURVE)
    const g = buildCurveLut(s.green ?? IDENTITY_CURVE)
    const b = buildCurveLut(s.blue ?? IDENTITY_CURVE)
    const m = buildCurveLut(s.master ?? IDENTITY_CURVE)
    const data = new Float32Array(CURVE_LUT_SIZE * 4)
    for (let i = 0; i < CURVE_LUT_SIZE; i++) {
      data[i * 4] = r[i]; data[i * 4 + 1] = g[i]; data[i * 4 + 2] = b[i]; data[i * 4 + 3] = m[i]
    }
    return { uCurveLut: { width: CURVE_LUT_SIZE, data } }
  },
  applyPixel: (s, r, g, b) => {
    const lr = buildCurveLut(s.red ?? IDENTITY_CURVE)
    const lg = buildCurveLut(s.green ?? IDENTITY_CURVE)
    const lb = buildCurveLut(s.blue ?? IDENTITY_CURVE)
    const lm = buildCurveLut(s.master ?? IDENTITY_CURVE)
    return [
      sampleLut(lm, sampleLut(lr, r)),
      sampleLut(lm, sampleLut(lg, g)),
      sampleLut(lm, sampleLut(lb, b)),
    ]
  },
  isIdentity: s => [s.master, s.red, s.green, s.blue].every(
    p => !p || (p.length === 2 && p[0][0] === 0 && p[0][1] === 0 && p[1][0] === 1 && p[1][1] === 1)),
}

// ── 7. Vibrance (perceptual) ─────────────────────────────────────────────────
// Saturation weighted by how UNsaturated the pixel already is, so skies and
// skin are not pushed into clipping. Formulation: distance of the pixel from
// its own maximum channel, which is 0 for a fully saturated colour.

const vibrance: AdjustmentImpl<Extract<AdjustmentSpec, { type: 'vibrance' }>> = {
  type: 'vibrance',
  space: 'perceptual',
  declarations: 'uniform float uVibrance;',
  glsl: `
  {
    float mx  = maxc(c);
    float avg = (c.r + c.g + c.b) / 3.0;
    float amt = (mx - avg) * (-uVibrance * 3.0);
    c = clamp(mix(c, vec3(mx), amt), 0.0, 1.0);
  }`,
  uniforms: s => ({ uVibrance: s.vibrance }),
  applyPixel: (s, r, g, b) => {
    const mx = Math.max(r, g, b)
    const avg = (r + g + b) / 3
    const amt = (mx - avg) * (-s.vibrance * 3)
    const mix = (a: number) => clamp01(a + (mx - a) * amt)
    return [mix(r), mix(g), mix(b)]
  },
  isIdentity: s => s.vibrance === 0,
}

// ── 8. Black and White (perceptual, six colour families) ─────────────────────
// Photoshop's model: the pixel is split into an achromatic part (its minimum
// channel) and a chromatic part whose weight is interpolated between the two
// families bracketing its hue. Defaults are Photoshop's
// (R 40, Y 60, G 40, C 60, B 20, M 80).

const blackAndWhite: AdjustmentImpl<Extract<AdjustmentSpec, { type: 'blackAndWhite' }>> = {
  type: 'blackAndWhite',
  space: 'perceptual',
  declarations: 'uniform float uBwW[6]; uniform vec3 uBwTint; uniform int uBwTinted;',
  glsl: `
  {
    float mx = maxc(c), mn = minc(c);
    float chroma = mx - mn;
    float gray = mn;
    if (chroma > 0.0) {
      float mid = c.r + c.g + c.b - mx - mn;
      float t = (mid - mn) / chroma;            // 0 = primary, 1 = secondary
      int prim, sec;
      if (mx == c.r)      { if (c.g >= c.b) { prim = 0; sec = 1; } else { prim = 0; sec = 5; } }
      else if (mx == c.g) { if (c.b >= c.r) { prim = 2; sec = 3; } else { prim = 2; sec = 1; } }
      else                { if (c.r >= c.g) { prim = 4; sec = 5; } else { prim = 4; sec = 3; } }
      float w = mix(uBwW[prim], uBwW[sec], t);
      gray = mn + chroma * w;
    }
    c = uBwTinted == 1 ? uBwTint * gray : vec3(gray);
  }`,
  uniforms: s => ({
    uBwW: [s.weights.red, s.weights.yellow, s.weights.green, s.weights.cyan, s.weights.blue, s.weights.magenta],
    uBwTint: s.tint ?? [1, 1, 1],
    uBwTinted: s.tint ? 1 : 0,
  }),
  applyPixel: (s, r, g, b) => {
    const w = [s.weights.red, s.weights.yellow, s.weights.green, s.weights.cyan, s.weights.blue, s.weights.magenta]
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b)
    const chroma = mx - mn
    let gray = mn
    if (chroma > 0) {
      const mid = r + g + b - mx - mn
      const t = (mid - mn) / chroma
      let prim: number, sec: number
      if (mx === r) { if (g >= b) { prim = 0; sec = 1 } else { prim = 0; sec = 5 } }
      else if (mx === g) { if (b >= r) { prim = 2; sec = 3 } else { prim = 2; sec = 1 } }
      else { if (r >= g) { prim = 4; sec = 5 } else { prim = 4; sec = 3 } }
      gray = mn + chroma * (w[prim] + (w[sec] - w[prim]) * t)
    }
    return s.tint ? [s.tint[0] * gray, s.tint[1] * gray, s.tint[2] * gray] : [gray, gray, gray]
  },
  isIdentity: () => false,
}

// ── 9. Colour balance (perceptual) ───────────────────────────────────────────
// GIMP `gimp_operation_color_balance_map`
// (app/operations/gimpoperationcolorbalance.c, GPLv3), transcribed literally:
//
//   const float a = 0.25, b = 0.333, scale = 0.7;
//   shadows    *= CLAMP((lightness - b)     / -a + 0.5, 0, 1) * scale;
//   midtones   *= CLAMP((lightness - b)     /  a + 0.5, 0, 1) *
//                 CLAMP((lightness + b - 1) / -a + 0.5, 0, 1) * scale;
//   highlights *= CLAMP((lightness + b - 1) /  a + 0.5, 0, 1) * scale;
//   value = CLAMP(value + shadows + midtones + highlights, 0, 1);
//
// `lightness` is the HSL L of the SOURCE pixel (GIMP converts the run to HSLA
// first), and the three masks sum to 1 over [0,1]. `preserveLuminosity`
// re-converts the result to HSL and puts the original L back — that is GIMP's
// actual behaviour, not a Rec.709 luminance rescale.
// Input format in GIMP: "R'G'B'A float" ⇒ PERCEPTUAL.

const colorBalance: AdjustmentImpl<Extract<AdjustmentSpec, { type: 'colorBalance' }>> = {
  type: 'colorBalance',
  space: 'perceptual',
  declarations: `
uniform vec3 uCbShadows; uniform vec3 uCbMidtones; uniform vec3 uCbHighlights;
uniform int uCbPreserveLum;
vec3 rgbToHsl(vec3 c) {
  float mx = maxc(c), mn = minc(c), l = (mx + mn) * 0.5, d = mx - mn;
  float s = d <= 0.0 ? 0.0 : d / (1.0 - abs(2.0 * l - 1.0));
  float h = 0.0;
  if (d > 0.0) {
    if (mx == c.r)      h = mod((c.g - c.b) / d, 6.0);
    else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
    else                h = (c.r - c.g) / d + 4.0;
    h /= 6.0;
  }
  return vec3(h, s, l);
}
vec3 hslToRgb(vec3 hsl) {
  float cc = (1.0 - abs(2.0 * hsl.z - 1.0)) * hsl.y;
  float hp = hsl.x * 6.0;
  float x = cc * (1.0 - abs(mod(hp, 2.0) - 1.0));
  vec3 rgb;
  if      (hp < 1.0) rgb = vec3(cc, x, 0.0);
  else if (hp < 2.0) rgb = vec3(x, cc, 0.0);
  else if (hp < 3.0) rgb = vec3(0.0, cc, x);
  else if (hp < 4.0) rgb = vec3(0.0, x, cc);
  else if (hp < 5.0) rgb = vec3(x, 0.0, cc);
  else               rgb = vec3(cc, 0.0, x);
  return rgb + (hsl.z - cc * 0.5);
}`,
  glsl: `
  {
    const float cbA = 0.25, cbB = 0.333, cbScale = 0.7;
    float lightness = rgbToHsl(c).z;
    vec3 sh = uCbShadows    * clamp((lightness - cbB) / -cbA + 0.5, 0.0, 1.0) * cbScale;
    vec3 mt = uCbMidtones   * clamp((lightness - cbB) /  cbA + 0.5, 0.0, 1.0)
                            * clamp((lightness + cbB - 1.0) / -cbA + 0.5, 0.0, 1.0) * cbScale;
    vec3 hi = uCbHighlights * clamp((lightness + cbB - 1.0) /  cbA + 0.5, 0.0, 1.0) * cbScale;
    vec3 outc = clamp(c + sh + mt + hi, 0.0, 1.0);
    if (uCbPreserveLum == 1) {
      vec3 h2 = rgbToHsl(outc);
      h2.z = lightness;
      outc = clamp(hslToRgb(h2), 0.0, 1.0);
    }
    c = outc;
  }`,
  uniforms: s => ({
    uCbShadows: [...s.shadows],
    uCbMidtones: [...s.midtones],
    uCbHighlights: [...s.highlights],
    uCbPreserveLum: s.preserveLuminosity ? 1 : 0,
  }),
  applyPixel: (s, r, g, b) => {
    const A = 0.25, B = 0.333, SCALE = 0.7
    const lightness = rgbToHslJS(r, g, b)[2]
    const ws = clamp01((lightness - B) / -A + 0.5) * SCALE
    const wm = clamp01((lightness - B) / A + 0.5) * clamp01((lightness + B - 1) / -A + 0.5) * SCALE
    const wh = clamp01((lightness + B - 1) / A + 0.5) * SCALE
    const out: [number, number, number] = [
      clamp01(r + s.shadows[0] * ws + s.midtones[0] * wm + s.highlights[0] * wh),
      clamp01(g + s.shadows[1] * ws + s.midtones[1] * wm + s.highlights[1] * wh),
      clamp01(b + s.shadows[2] * ws + s.midtones[2] * wm + s.highlights[2] * wh),
    ]
    if (!s.preserveLuminosity) return out
    const h2 = rgbToHslJS(out[0], out[1], out[2])
    const back = hslToRgbJS(h2[0], h2[1], lightness)
    return [clamp01(back[0]), clamp01(back[1]), clamp01(back[2])]
  },
  isIdentity: s => [...s.shadows, ...s.midtones, ...s.highlights].every(v => v === 0),
}

// ── 10. Invert (perceptual — Photoshop's Invert is on encoded values) ────────

const invert: AdjustmentImpl<Extract<AdjustmentSpec, { type: 'invert' }>> = {
  type: 'invert',
  space: 'perceptual',
  declarations: '',
  glsl: '  c = vec3(1.0) - c;',
  uniforms: () => ({}),
  applyPixel: (_s, r, g, b) => [1 - r, 1 - g, 1 - b],
  isIdentity: () => false,
}

// ── 11. Threshold (perceptual, NTSC luma to match the legacy filter) ─────────

const threshold: AdjustmentImpl<Extract<AdjustmentSpec, { type: 'threshold' }>> = {
  type: 'threshold',
  space: 'perceptual',
  declarations: 'uniform float uThreshLevel;',
  glsl: '  c = vec3(step(uThreshLevel, luma601(c)));',
  uniforms: s => ({ uThreshLevel: s.level }),
  applyPixel: (s, r, g, b) => {
    const v = 0.299 * r + 0.587 * g + 0.114 * b >= s.level ? 1 : 0
    return [v, v, v]
  },
  isIdentity: () => false,
}

// ── 12. Posterize (perceptual) ───────────────────────────────────────────────
// GIMP `gimp_operation_posterize`: RINT(value · (levels - 1)) / (levels - 1).

const posterize: AdjustmentImpl<Extract<AdjustmentSpec, { type: 'posterize' }>> = {
  type: 'posterize',
  space: 'perceptual',
  declarations: 'uniform float uPostLevels;',
  glsl: `
  {
    float n = max(uPostLevels - 1.0, 1.0);
    c = floor(clamp(c, 0.0, 1.0) * n + 0.5) / n;
  }`,
  uniforms: s => ({ uPostLevels: s.levels }),
  applyPixel: (s, r, g, b) => {
    const n = Math.max(s.levels - 1, 1)
    const f = (v: number) => Math.round(clamp01(v) * n) / n
    return [f(r), f(g), f(b)]
  },
  isIdentity: s => s.levels >= 256,
}

// ── Registry ─────────────────────────────────────────────────────────────────

// The map is heterogeneous by construction; every accessor below re-narrows on
// the discriminant, which is why the lookups need one cast each.
const IMPLS: { [K in AdjustmentType]: AdjustmentImpl<Extract<AdjustmentSpec, { type: K }>> } = {
  brightnessContrast, exposure, saturation, hue, levels, curves,
  vibrance, blackAndWhite, colorBalance, invert, threshold, posterize,
}

export function adjustmentImpl<S extends AdjustmentSpec>(spec: S): AdjustmentImpl<S> {
  return IMPLS[spec.type] as unknown as AdjustmentImpl<S>
}

export function isIdentityAdjustment(spec: AdjustmentSpec): boolean {
  const impl = adjustmentImpl(spec)
  return impl.isIdentity(spec as never)
}

/** CPU reference: apply one adjustment to a colour EXPRESSED IN ITS OWN SPACE. */
export function applyAdjustmentPixel(
  spec: AdjustmentSpec, r: number, g: number, b: number,
): [number, number, number] {
  return adjustmentImpl(spec).applyPixel(spec as never, r, g, b)
}

/** Space an adjustment operates in — needed by the fusion logic and the tests. */
export function adjustmentSpace(spec: AdjustmentSpec): ColorSpaceMode {
  return adjustmentImpl(spec).space
}

// ── Pass construction ────────────────────────────────────────────────────────

/**
 * Build ONE fragment pass applying `specs` in order. Adjustments of the same
 * space are chained without a round trip; a space change inserts a single
 * `linearToSrgb` / `srgbToLinear`. Fusing consecutive adjustment layers into
 * one pass is the §6.6 optimisation: 4–6 fullscreen passes saved on a typical
 * retouching document.
 *
 * Identity adjustments are dropped; if everything is identity the caller gets
 * `null` and must skip the pass entirely.
 */
export function adjustmentPass(specs: readonly AdjustmentSpec[], passName = 'adjust'): GpuPass | null {
  const active = specs.filter(s => !isIdentityAdjustment(s))
  if (active.length === 0) return null
  // Only one curves LUT can be bound per pass (single sampler name).
  const curveCount = active.filter(s => s.type === 'curves').length
  if (curveCount > 1) throw new Error('adjustmentPass: at most one curves adjustment per pass')

  const decls: string[] = []
  const seen = new Set<string>()
  let body = ''
  let space: ColorSpaceMode = 'linear'
  for (const spec of active) {
    const impl = adjustmentImpl(spec)
    if (!seen.has(impl.type)) {
      seen.add(impl.type)
      if (impl.declarations) decls.push(impl.declarations)
    }
    if (impl.space !== space) {
      body += impl.space === 'perceptual' ? '\n  c = linearToSrgb(c);' : '\n  c = srgbToLinear(c);'
      space = impl.space
    }
    // The newline after the comment is load-bearing: a single-line body
    // (invert, threshold) would otherwise be commented out.
    body += `\n  // ${impl.type} (${impl.space})\n` + impl.glsl
  }
  if (space === 'perceptual') body += '\n  c = srgbToLinear(c);'

  const glsl = GLSL_HEADER + GLSL_COLORSPACE + GLSL_OKLAB + GLSL_SAMPLING + decls.join('\n') + `
void main() {
  vec4 s = texture(uSrc, vUv);
  if (s.a <= 0.0) { fragColor = s; return; }
  vec3 c = unpremul(s);          // straight, LINEAR
${body}
  fragColor = premul(max(c, vec3(0.0)), s.a);   // alpha is never modified
}
`
  const key = 'adjust/' + active.map(s => s.type).join('+') + '/' + active.map(s => adjustmentImpl(s).space).join('')

  const uniforms: Record<string, unknown> = {}
  for (const spec of active) Object.assign(uniforms, adjustmentImpl(spec).uniforms(spec as never))

  // LUT textures are NOT part of the pass: the caller uploads them with
  // `adjustmentLuts(specs)` and binds them by name, because their lifetime is
  // the adjustment's, not the pass's (they only change when a curve changes).
  return { name: passName, key, glsl, uniforms: () => uniforms as UniformMap }
}

/** LUTs required by a fused adjustment pass (uploaded by the caller). */
export function adjustmentLuts(specs: readonly AdjustmentSpec[]): Record<string, LutData> {
  const out: Record<string, LutData> = {}
  for (const spec of specs) {
    if (isIdentityAdjustment(spec)) continue
    const l = adjustmentImpl(spec).luts?.(spec as never)
    if (l) Object.assign(out, l)
  }
  return out
}

// ── JS mirrors of the Oklab helpers (CPU reference path) ─────────────────────

export function linearToOklabJS(r: number, g: number, b: number): [number, number, number] {
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b
  const cb = (v: number) => Math.sign(v) * Math.cbrt(Math.abs(v))
  const l_ = cb(l), m_ = cb(m), s_ = cb(s)
  return [
    0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
  ]
}

/** HSL, matching the GLSL helper bit for bit (used by the colour-balance path). */
export function rgbToHslJS(r: number, g: number, b: number): [number, number, number] {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b)
  const l = (mx + mn) / 2, d = mx - mn
  const s = d <= 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
  let h = 0
  if (d > 0) {
    if (mx === r) h = (((g - b) / d) % 6 + 6) % 6
    else if (mx === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h /= 6
  }
  return [h, s, l]
}

export function hslToRgbJS(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const hp = h * 6
  const x = c * (1 - Math.abs((hp % 2) - 1))
  let rgb: [number, number, number]
  if (hp < 1) rgb = [c, x, 0]
  else if (hp < 2) rgb = [x, c, 0]
  else if (hp < 3) rgb = [0, c, x]
  else if (hp < 4) rgb = [0, x, c]
  else if (hp < 5) rgb = [x, 0, c]
  else rgb = [c, 0, x]
  const m = l - c / 2
  return [rgb[0] + m, rgb[1] + m, rgb[2] + m]
}

export function oklabToLinearJS(L: number, a: number, bb: number): [number, number, number] {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * bb
  const m_ = L - 0.1055613458 * a - 0.0638541728 * bb
  const s_ = L - 0.0894841775 * a - 1.2914855480 * bb
  const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_
  return [
    Math.max(0, +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    Math.max(0, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    Math.max(0, -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s),
  ]
}
