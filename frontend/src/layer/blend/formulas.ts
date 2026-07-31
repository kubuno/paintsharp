// Reference implementation of every blend mode, in TypeScript, on floats in
// [0,1] (non-premultiplied), plus the generalised Porter-Duff source-over
// composition.
//
// THIS FILE IS THE ORACLE. The GLSL in `./glsl.ts` is validated against it by
// the equivalence test suite (1×1 FBO read-back, tolerance 1e-4). When the two
// disagree, this file is right and the shader is wrong.
//
// Attribution
// -----------
// Algorithms derived from GIMP, `app/operations/layer-modes/`:
//   - gimpoperationlayermode-blend.c      (separable + luma_darken/lighten)
//   - gimpoperationlayermode-composite.c  (union / clip-to-* operators)
//   - gimpoperationdissolve.c             (stochastic alpha)
// Copyright (C) GIMP developers, GPLv3+; reimplemented here in TypeScript.
// Kubuno is AGPLv3 (compatible).
//
// Deliberate divergences from GIMP, in favour of Photoshop / PDF 1.7 §11.3.5,
// because PSD parity is a hard requirement:
//   - `soft-light` uses the PDF piecewise D(Cb), NOT GIMP's W3C variant.
//   - luma coefficients are BT.601 0.30/0.59/0.11 on *non-linear* sRGB values,
//     NOT the BT.709 linear-light coefficients GIMP pulls from babl.
//
// Colour-space contract: all functions operate on sRGB-*encoded* (non-linear)
// values. See spec §4.8 — this is what Photoshop does by default and what makes
// imported PSDs render identically.

import type { BlendMode, CompositeOp } from './modes.ts'

export type RGB = [number, number, number]

// ---------------------------------------------------------------------------
// Numeric helpers
// ---------------------------------------------------------------------------

/** GIMP `SAFE_DIV_MIN`. Below this magnitude the numerator is treated as zero. */
export const EPSILON = 1e-6
/** GIMP `SAFE_DIV_MAX`. */
export const SAFE_DIV_MAX = 1 / EPSILON

/**
 * GIMP's `safe_div`: `a / b` clamped to ±SAFE_DIV_MAX, and exactly 0 when
 * |a| <= EPSILON. This is what makes burn / dodge / divide well-defined at
 * b = 0 without producing Inf or NaN — and a single NaN pixel contaminates the
 * whole composite chain (mipmaps, blurs, PNG encoding).
 */
export function safeDiv(a: number, b: number): number {
  if (Math.abs(a) <= EPSILON) return 0
  const r = a / b
  if (r < -SAFE_DIV_MAX) return -SAFE_DIV_MAX
  if (r > SAFE_DIV_MAX) return SAFE_DIV_MAX
  return r
}

const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v

/** Lifts a scalar channel function to an RGB triple. */
const perChannel =
  (f: (cb: number, cs: number) => number) =>
  (cb: RGB, cs: RGB): RGB => [f(cb[0], cs[0]), f(cb[1], cs[1]), f(cb[2], cs[2])]

// ---------------------------------------------------------------------------
// Separable blend functions B(Cb, Cs), applied per channel.
//
// Results are intentionally NOT clamped: linear-dodge, linear-burn,
// linear-light, subtract and divide leave [0,1] by construction. GIMP does not
// clamp inside B either; the clamp belongs at the 8-bit write-out. Keeping the
// overshoot through an RGBA16F stack is what makes "Add then Multiply" correct.
// ---------------------------------------------------------------------------

export const sNormal = (_cb: number, cs: number): number => cs
export const sDarken = (cb: number, cs: number): number => Math.min(cb, cs)
export const sLighten = (cb: number, cs: number): number => Math.max(cb, cs)
export const sMultiply = (cb: number, cs: number): number => cb * cs
export const sScreen = (cb: number, cs: number): number => cb + cs - cb * cs
export const sColorBurn = (cb: number, cs: number): number => 1 - safeDiv(1 - cb, cs)
export const sColorDodge = (cb: number, cs: number): number => safeDiv(cb, 1 - cs)
export const sLinearBurn = (cb: number, cs: number): number => cb + cs - 1
export const sLinearDodge = (cb: number, cs: number): number => cb + cs
/**
 * GIMP branches on `Cs <= 0.5` with `Cb + 2Cs - 1` / `Cb + 2(Cs - 0.5)`. The two
 * branches are algebraically identical, so a single branch-free expression is
 * used — it also removes a `step()` from the shader.
 */
export const sLinearLight = (cb: number, cs: number): number => cb + 2 * cs - 1
export const sDifference = (cb: number, cs: number): number => Math.abs(cb - cs)
/**
 * GIMP writes `0.5 - 2(Cb - 0.5)(Cs - 0.5)`; expanded that is `Cb + Cs - 2CbCs`,
 * the usual PDF form, with one multiplication fewer.
 */
export const sExclusion = (cb: number, cs: number): number => cb + cs - 2 * cb * cs
export const sSubtract = (cb: number, cs: number): number => cb - cs
export const sDivide = (cb: number, cs: number): number => safeDiv(cb, cs)
/**
 * Photoshop defines Hard Mix as Vivid Light thresholded at 0.5; that reduces
 * exactly to this closed form, which is what GIMP implements.
 * Note the boundary: `Cb + Cs == 1` yields 1 (matches GLSL `step(1.0, b + s)`).
 */
export const sHardMix = (cb: number, cs: number): number => (cb + cs < 1 ? 0 : 1)

export const sOverlay = (cb: number, cs: number): number =>
  cb < 0.5 ? 2 * cb * cs : 1 - 2 * (1 - cb) * (1 - cs)

/** Hard Light is Overlay with the operands swapped (GIMP's form is identical). */
export const sHardLight = (cb: number, cs: number): number => sOverlay(cs, cb)

/**
 * PDF 1.7 §11.3.5.2 auxiliary D(Cb). Using `sqrt(Cb)` everywhere — as the
 * current renderer does — is wrong below 0.25 (up to ~0.06 of channel error in
 * the shadows).
 */
export const softLightD = (cb: number): number =>
  cb <= 0.25 ? ((16 * cb - 12) * cb + 4) * cb : Math.sqrt(cb)

/**
 * Photoshop / PDF Soft Light, NOT GIMP's `(1-Cb)·CbCs + Cb·screen` variant.
 * Low branch written in the expanded form `2·Cb·Cs + Cb²·(1 - 2·Cs)`.
 */
export const sSoftLight = (cb: number, cs: number): number =>
  cs <= 0.5
    ? 2 * cb * cs + cb * cb * (1 - 2 * cs)
    : 2 * cb * (1 - cs) + softLightD(cb) * (2 * cs - 1)

export const sVividLight = (cb: number, cs: number): number =>
  cs <= 0.5
    ? Math.max(1 - safeDiv(1 - cb, 2 * cs), 0)
    : Math.min(safeDiv(cb, 2 * (1 - cs)), 1)

export const sPinLight = (cb: number, cs: number): number =>
  cs > 0.5 ? Math.max(cb, 2 * (cs - 0.5)) : Math.min(cb, 2 * cs)

// ---------------------------------------------------------------------------
// Non-separable modes — HSY primitives, PDF 1.7 §11.3.5.3
// ---------------------------------------------------------------------------

/**
 * ITU-R BT.601 luma coefficients, as mandated by PDF 1.7 §11.3.5.3 and used by
 * Photoshop. Do NOT substitute BT.709 (0.2126/0.7152/0.0722): it changes the
 * result of every component blend mode and breaks PSD parity.
 */
export const LUM_R = 0.3
export const LUM_G = 0.59
export const LUM_B = 0.11

export const lum = (c: RGB): number => LUM_R * c[0] + LUM_G * c[1] + LUM_B * c[2]

/**
 * PDF `ClipColor`: pulls an out-of-gamut triple back into [0,1] while keeping
 * its luminance. Both denominators are strictly positive inside their guard
 * (n < 0 <= L, and x > 1 >= L), but they are still floored at EPSILON so the
 * GLSL twin — which cannot branch as cheaply — stays bit-comparable.
 */
export function clipColor(c: RGB): RGB {
  const l = lum(c)
  const n = Math.min(c[0], c[1], c[2])
  const x = Math.max(c[0], c[1], c[2])
  let out: RGB = [c[0], c[1], c[2]]
  if (n < 0) {
    const d = Math.max(l - n, EPSILON)
    out = [l + ((out[0] - l) * l) / d, l + ((out[1] - l) * l) / d, l + ((out[2] - l) * l) / d]
  }
  if (x > 1) {
    const d = Math.max(x - l, EPSILON)
    out = [
      l + ((out[0] - l) * (1 - l)) / d,
      l + ((out[1] - l) * (1 - l)) / d,
      l + ((out[2] - l) * (1 - l)) / d,
    ]
  }
  return out
}

/** PDF `SetLum`. */
export function setLum(c: RGB, l: number): RGB {
  const d = l - lum(c)
  return clipColor([c[0] + d, c[1] + d, c[2] + d])
}

/** PDF `Sat`. */
export const sat = (c: RGB): number =>
  Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2])

/**
 * PDF `SetSat`, vectorised: min channel goes to 0, max channel to s, mid
 * channel interpolated. Equivalent to the spec's sorted (min, mid, max) form.
 * The division MUST be guarded: a neutral grey would otherwise become NaN.
 */
export function setSat(c: RGB, s: number): RGB {
  const mx = Math.max(c[0], c[1], c[2])
  const mn = Math.min(c[0], c[1], c[2])
  const range = mx - mn
  if (range <= 0) return [0, 0, 0]
  return [((c[0] - mn) / range) * s, ((c[1] - mn) / range) * s, ((c[2] - mn) / range) * s]
}

export const nHue = (cb: RGB, cs: RGB): RGB => setLum(setSat(cs, sat(cb)), lum(cb))
export const nSaturation = (cb: RGB, cs: RGB): RGB => setLum(setSat(cb, sat(cs)), lum(cb))
export const nColor = (cb: RGB, cs: RGB): RGB => setLum(cs, lum(cb))
export const nLuminosity = (cb: RGB, cs: RGB): RGB => setLum(cb, lum(cs))

/**
 * Returns the whole darker/lighter triple — that is what distinguishes these
 * from `darken`/`lighten`, which work channel-wise and can synthesise a colour
 * present in neither input.
 */
export const nDarkerColor = (cb: RGB, cs: RGB): RGB =>
  lum(cb) <= lum(cs) ? [cb[0], cb[1], cb[2]] : [cs[0], cs[1], cs[2]]
export const nLighterColor = (cb: RGB, cs: RGB): RGB =>
  lum(cb) >= lum(cs) ? [cb[0], cb[1], cb[2]] : [cs[0], cs[1], cs[2]]

// ---------------------------------------------------------------------------
// Dispatch table
// ---------------------------------------------------------------------------

export type BlendFn = (cb: RGB, cs: RGB) => RGB

/**
 * `B(Cb, Cs)` for every mode. `dissolve` and `pass-through` are not colour
 * functions: `dissolve` decides on alpha (see `dissolveAlpha`) and
 * `pass-through` is resolved by the compositor before it reaches a shader, so
 * both map to `normal`'s identity-on-source.
 */
export const BLEND_FN: Record<BlendMode, BlendFn> = {
  normal: perChannel(sNormal),
  dissolve: perChannel(sNormal),
  'pass-through': perChannel(sNormal),

  darken: perChannel(sDarken),
  multiply: perChannel(sMultiply),
  'color-burn': perChannel(sColorBurn),
  'linear-burn': perChannel(sLinearBurn),
  'darker-color': nDarkerColor,

  lighten: perChannel(sLighten),
  screen: perChannel(sScreen),
  'color-dodge': perChannel(sColorDodge),
  'linear-dodge': perChannel(sLinearDodge),
  'lighter-color': nLighterColor,

  overlay: perChannel(sOverlay),
  'soft-light': perChannel(sSoftLight),
  'hard-light': perChannel(sHardLight),
  'vivid-light': perChannel(sVividLight),
  'linear-light': perChannel(sLinearLight),
  'pin-light': perChannel(sPinLight),
  'hard-mix': perChannel(sHardMix),

  difference: perChannel(sDifference),
  exclusion: perChannel(sExclusion),
  subtract: perChannel(sSubtract),
  divide: perChannel(sDivide),

  hue: nHue,
  saturation: nSaturation,
  color: nColor,
  luminosity: nLuminosity,
}

/** `B(Cb, Cs)` — non-premultiplied, unclamped. */
export function blendRGB(mode: BlendMode, cb: RGB, cs: RGB): RGB {
  return BLEND_FN[mode](cb, cs)
}

// ---------------------------------------------------------------------------
// Alpha composition
// ---------------------------------------------------------------------------

/**
 * Upper bound applied to `c / a` when un-premultiplying. With an RGBA16F
 * backdrop and an alpha near 1/65504, the quotient explodes; 64 is a generous
 * HDR width and anything beyond it is invisible anyway.
 */
export const UNPREMUL_MAX = 64

/** `Cb = ab > 0 ? clamp(cb / ab, 0, UNPREMUL_MAX) : 0` */
export function unpremultiply(c: RGB, a: number): RGB {
  if (a <= 0) return [0, 0, 0]
  return [
    clamp(c[0] / a, 0, UNPREMUL_MAX),
    clamp(c[1] / a, 0, UNPREMUL_MAX),
    clamp(c[2] / a, 0, UNPREMUL_MAX),
  ]
}

export interface PremultipliedPixel {
  /** Premultiplied colour. */
  rgb: RGB
  alpha: number
}

export interface StraightPixel {
  /** Non-premultiplied colour. */
  rgb: RGB
  alpha: number
}

/**
 * Premultiplied composition — the normative form for the shader (spec §4.6.2).
 *
 *   ar = as + ab·(1 - as)
 *   cr = (1 - as)·cb + (1 - ab)·cs + ab·as·B(Cb, Cs)
 *
 * Three terms, no division, no branch; `ab = 0` and `as = 0` fall out
 * automatically. The `(1 - ab)·cs` term is the one the current renderer is
 * missing — without it a `multiply` layer over empty canvas renders black.
 *
 * `B` takes NON-premultiplied colours, hence the guarded un-premultiplication.
 */
export function compositePremultiplied(
  mode: BlendMode,
  basePremul: RGB,
  ab: number,
  layerPremul: RGB,
  as: number,
  op: CompositeOp = 'union',
): PremultipliedPixel {
  const cb = unpremultiply(basePremul, ab)
  const cs = unpremultiply(layerPremul, as)
  // `normal` short-circuits: B = Cs makes the three terms collapse to the
  // classic `over`, and skipping the round-trip avoids the clamp at
  // UNPREMUL_MAX ever biasing an ordinary paint stroke.
  const isPassThrough = mode === 'normal' || mode === 'dissolve' || mode === 'pass-through'
  const b: RGB = isPassThrough ? cs : blendRGB(mode, cb, cs)

  switch (op) {
    case 'clip-to-backdrop': {
      // Adjustment layers / clipping: alpha of the backdrop is preserved, the
      // layer can only alter colour where colour already exists.
      const rgb: RGB = [
        basePremul[0] + as * (b[0] * ab - basePremul[0]),
        basePremul[1] + as * (b[1] * ab - basePremul[1]),
        basePremul[2] + as * (b[2] * ab - basePremul[2]),
      ]
      return { rgb, alpha: ab }
    }
    case 'clip-to-layer': {
      const rgb: RGB = [
        (1 - ab) * layerPremul[0] + ab * as * b[0],
        (1 - ab) * layerPremul[1] + ab * as * b[1],
        (1 - ab) * layerPremul[2] + ab * as * b[2],
      ]
      return { rgb, alpha: as }
    }
    case 'intersection': {
      const k = ab * as
      return { rgb: [k * b[0], k * b[1], k * b[2]], alpha: k }
    }
    case 'union':
    default: {
      const ar = as + ab * (1 - as)
      const k = ab * as
      const rgb: RGB = [
        (1 - as) * basePremul[0] + (1 - ab) * layerPremul[0] + k * b[0],
        (1 - as) * basePremul[1] + (1 - ab) * layerPremul[1] + k * b[1],
        (1 - as) * basePremul[2] + (1 - ab) * layerPremul[2] + k * b[2],
      ]
      return { rgb, alpha: ar }
    }
  }
}

/**
 * Non-premultiplied composition (PDF 1.7 §11.3.6). Convenience wrapper around
 * the premultiplied form, so the two can never drift:
 *
 *   Cr = (1 - as/ar)·Cb + (as/ar)·[ (1 - ab)·Cs + ab·B(Cb, Cs) ]
 */
export function compositeStraight(
  mode: BlendMode,
  cb: RGB,
  ab: number,
  cs: RGB,
  as: number,
  op: CompositeOp = 'union',
): StraightPixel {
  const r = compositePremultiplied(
    mode,
    [cb[0] * ab, cb[1] * ab, cb[2] * ab],
    ab,
    [cs[0] * as, cs[1] * as, cs[2] * as],
    as,
    op,
  )
  if (r.alpha <= 0) return { rgb: [0, 0, 0], alpha: 0 }
  return {
    rgb: [r.rgb[0] / r.alpha, r.rgb[1] / r.alpha, r.rgb[2] / r.alpha],
    alpha: r.alpha,
  }
}

// ---------------------------------------------------------------------------
// Dissolve — stochastic alpha (GIMP gimpoperationdissolve.c)
// ---------------------------------------------------------------------------

const u32 = (n: number): number => n >>> 0

/**
 * Integer hash, the exact TypeScript twin of `hash3` in `./glsl.ts`.
 * `Math.imul` is required: plain `*` loses the low bits past 2^53.
 */
export function hash3(x: number, y: number, z: number): number {
  let vx = u32(Math.imul(u32(x), 1664525) + 1013904223)
  let vy = u32(Math.imul(u32(y), 1664525) + 1013904223)
  let vz = u32(Math.imul(u32(z), 1664525) + 1013904223)

  vx = u32(vx + Math.imul(vy, vz))
  vy = u32(vy + Math.imul(vz, vx))
  vz = u32(vz + Math.imul(vx, vy))

  vx = u32(vx ^ (vx >>> 16))
  vy = u32(vy ^ (vy >>> 16))
  vz = u32(vz ^ (vz >>> 16))

  vx = u32(vx + Math.imul(vy, vz))
  vy = u32(vy + Math.imul(vz, vx))
  vz = u32(vz + Math.imul(vx, vy))

  return u32(vx)
}

/**
 * Deterministic per-pixel value in [0,1]. It MUST depend only on document
 * coordinates and a per-layer seed — never on time, zoom or scroll — otherwise
 * the layer flickers on every repaint and undo/redo does not restore the same
 * image.
 */
export function dissolveRand(docX: number, docY: number, seed: number): number {
  return (hash3(docX, docY, seed) & 0xffffff) / 0xffffff
}

/** `alpha` here is `αs · opacity · mask`, already folded. */
export function dissolveAlpha(rand: number, alpha: number): number {
  return rand < alpha ? 1 : 0
}

/** Stable 32-bit seed derived from a layer id, so two dissolved layers differ. */
export function dissolveSeedFromId(id: string): number {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) {
    h = u32(h ^ id.charCodeAt(i))
    h = u32(Math.imul(h, 16777619))
  }
  return h
}
