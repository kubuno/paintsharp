// Local-retouch brushes: blur, sharpen, smudge (F13 "focus") and dodge, burn,
// sponge (F14 "tone").
//
// The six tools share one skeleton — a spaced-dab brush stroke that mutates an
// in-memory mirror of the layer and flushes the touched rectangle back — and
// differ only by the per-dab pixel operator. Nothing here reaches into the
// editor: every capability arrives through `ToolContext`.
//
// ── Attribution ─────────────────────────────────────────────────────────────
// The blur/sharpen convolution matrix and rate mapping, the smudge accumulator
// model, and the three dodge/burn tonal-range transfer functions are
// reimplementations of GIMP (GNU Image Manipulation Program), which is
// Copyright (C) 1995 Spencer Kimball, Peter Mattis and the GIMP developers and
// is released under the GNU General Public License v3 or later. The source
// files this code follows are:
//   app/paint/gimpconvolve.c          — convolve matrix + MIN/MAX_BLUR rates
//   app/paint/gimpsmudge.c            — the accumulator model
//   app/paint/gimpdodgeburn.c         — dodge/burn paint core
//   app/gegl/gimp-gegl-loops.cc       — gimp_gegl_convolve(), gimp_gegl_dodgeburn(),
//                                       gimp_gegl_smudge_with_paint()
// Kubuno is licensed under the AGPLv3, which is compatible with the GPLv3 for
// this derivation. The sponge has no GIMP counterpart and is our own HSL
// saturation brush.
import { registerTool } from './registry'
import type { ToolContext, ToolHandler, ToolPointer } from './types'

// ─────────────────────────────────────────────────────────────────────────────
// Small numeric helpers
// ─────────────────────────────────────────────────────────────────────────────

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

/**
 * Brush percentages arrive as 0..100 from the editor's brush panel. Values that
 * are already normalised (0..1) are accepted too, so a caller that hands over a
 * ratio does not silently get a 1 % brush.
 */
const pct01 = (v: number): number => clamp01(v > 1 ? v / 100 : v)

/** sRGB byte → linear light. */
const SRGB_TO_LINEAR: Float32Array = (() => {
  const t = new Float32Array(256)
  for (let i = 0; i < 256; i++) {
    const c = i / 255
    t[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }
  return t
})()

/** Linear light → sRGB, sampled on 4096 steps (max error well under 1/255). */
const LINEAR_TO_SRGB: Float32Array = (() => {
  const n = 4096
  const t = new Float32Array(n + 1)
  for (let i = 0; i <= n; i++) {
    const c = i / n
    t[i] = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055
  }
  return t
})()

const linToSrgb = (v: number): number => LINEAR_TO_SRGB[Math.round(clamp01(v) * 4096)]

/** Rec. 709 luma of gamma-encoded components. */
const luma = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b

/** RGB (0..1) → HSL (h in 0..1). Hue is preserved verbatim for achromatic input. */
function rgbToHsl(r: number, g: number, b: number, out: Float64Array): void {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  let h = 0
  let s = 0
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0)
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h /= 6
  }
  out[0] = h
  out[1] = s
  out[2] = l
}

const hue2rgb = (p: number, q: number, tIn: number): number => {
  let t = tIn
  if (t < 0) t += 1
  if (t > 1) t -= 1
  if (t < 1 / 6) return p + (q - p) * 6 * t
  if (t < 1 / 2) return q
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
  return p
}

/** HSL (h in 0..1) → RGB (0..1). */
function hslToRgb(h: number, s: number, l: number, out: Float64Array): void {
  if (s <= 0) {
    out[0] = out[1] = out[2] = l
    return
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  out[0] = hue2rgb(p, q, h + 1 / 3)
  out[1] = hue2rgb(p, q, h)
  out[2] = hue2rgb(p, q, h - 1 / 3)
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool options
//
// `ToolContext` deliberately exposes only the brush, not the options bar, so a
// tool cannot depend on the editor's state shape. The options bar persists its
// values under the key below (`TOOL_VALUES_PREF_KEY` in `layer/tools/types.ts`,
// duplicated here as a literal on purpose: reading a string is not a coupling,
// importing the toolbox model would be). When nothing is stored — which is the
// case until the editor wires persistence up — the declared defaults from
// `toolDefs.ts` apply, and Alt still flips the tool the Photoshop way.
// ─────────────────────────────────────────────────────────────────────────────

const TOOL_VALUES_KEY = 'paintsharp:layer:toolValues'

type OptionValue = string | number | boolean
type OptionBag = Record<string, OptionValue>

function readStoredOptions(toolId: string): OptionBag {
  try {
    const store: Storage | undefined = typeof localStorage === 'undefined' ? undefined : localStorage
    const raw = store?.getItem(TOOL_VALUES_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return {}
    const forTool: unknown = (parsed as Record<string, unknown>)[toolId]
    if (typeof forTool !== 'object' || forTool === null) return {}
    const bag: OptionBag = {}
    for (const [k, v] of Object.entries(forTool as Record<string, unknown>)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') bag[k] = v
    }
    return bag
  } catch {
    // A malformed preference must never break a brush stroke.
    return {}
  }
}

const optNum = (bag: OptionBag, id: string, def: number): number => {
  const v = bag[id]
  return typeof v === 'number' && Number.isFinite(v) ? v : def
}
const optBool = (bag: OptionBag, id: string, def: boolean): boolean => {
  const v = bag[id]
  return typeof v === 'boolean' ? v : def
}
const optStr = <T extends string>(bag: OptionBag, id: string, def: T, allowed: readonly T[]): T => {
  const v = bag[id]
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : def
}

/** Blend of the effect with the original pixels — mirrors `FOCUS_MODE_CHOICES`. */
type FocusMode = 'normal' | 'lighten' | 'darken' | 'hue' | 'saturation' | 'color' | 'luminosity'
const FOCUS_MODES: readonly FocusMode[] = [
  'normal', 'lighten', 'darken', 'hue', 'saturation', 'color', 'luminosity',
]

/** Tonal range a dodge/burn dab acts on — mirrors `GimpTransferMode`. */
type ToneRange = 'shadows' | 'midtones' | 'highlights'
const TONE_RANGES: readonly ToneRange[] = ['shadows', 'midtones', 'highlights']

type SpongeMode = 'desaturate' | 'saturate'
const SPONGE_MODES: readonly SpongeMode[] = ['desaturate', 'saturate']

// ─────────────────────────────────────────────────────────────────────────────
// Stroke scaffolding
// ─────────────────────────────────────────────────────────────────────────────

interface BBox { x0: number; y0: number; x1: number; y1: number }

/** Rectangle covered by one dab, already clipped to the document. */
interface DabRect { x: number; y: number; w: number; h: number; cx: number; cy: number }

interface Stroke {
  layerId: string
  /** Pre-stroke pixels of the whole layer — the history snapshot, never mutated. */
  base: Uint8Array
  /** Live mirror the dabs mutate; flushed back rectangle by rectangle. */
  buf: Uint8Array
  w: number
  h: number
  /** Union of every dab of the stroke — what undo will cost. */
  bbox: BBox | null
  /** Region written since the last flush. */
  dirty: BBox | null
  lastX: number
  lastY: number
  /** Distance still owed before the next dab lands. */
  carry: number
  radius: number
  /** Radius from which the falloff starts, in document pixels. */
  inner: number
  spacing: number
  /** Per-dab gain baked into the coverage: flow × pressure. */
  flowGain: number
  /**
   * Stroke ceiling. Incremental tools (blur, sharpen, smudge) fold it into each
   * dab; constant ones (dodge, burn, sponge) use it as the maximum a single
   * stroke may reach — Photoshop's flow/opacity split.
   */
  opacity: number
  lockAlpha: boolean
  sel: Uint8Array | null
  /** Scratch coverage buffer, grown on demand and reused across dabs. */
  cov: Float32Array
}

/** Layer states that forbid painting. */
function paintableLayerId(ctx: ToolContext): string | null {
  const id = ctx.activeId
  if (!id) return null
  const layer = ctx.layerById(id)
  if (!layer) return null
  if (layer.type !== 'raster') return null
  if (layer.locked) return null
  return id
}

function beginStroke(ctx: ToolContext, p: ToolPointer): Stroke | null {
  const layerId = paintableLayerId(ctx)
  if (!layerId) return null
  const layer = ctx.layerById(layerId)
  const base = ctx.readTex(layerId)
  if (!base) return null

  const w = ctx.docW
  const h = ctx.docH
  if (base.length < w * h * 4) return null

  const radius = Math.max(0.5, ctx.brushSize / 2)
  const hardness = pct01(ctx.brushHardness)
  return {
    layerId,
    base,
    buf: base.slice(),
    w,
    h,
    bbox: null,
    dirty: null,
    lastX: p.x,
    lastY: p.y,
    carry: 0,
    radius,
    // A perfectly hard brush would divide by zero and alias; half a pixel of
    // falloff is what keeps the dab edge antialiased.
    inner: Math.min(radius * hardness, radius - 0.5),
    spacing: Math.max(0.5, radius * 0.2),
    flowGain: 0,
    opacity: pct01(ctx.brushOpacity),
    lockAlpha: layer?.lockAlpha === true,
    sel: ctx.selection,
    cov: new Float32Array(0),
  }
}

/** Per-segment flow gain. Pens modulate with pressure; mouse and touch do not. */
function gainFor(ctx: ToolContext, p: ToolPointer): number {
  const pressure = p.pointerType === 'pen' ? clamp01(p.pressure) : 1
  return pct01(ctx.brushFlow) * pressure
}

/** Selection weight of a document pixel, 0..1. */
const selAt = (s: Stroke, x: number, y: number): number =>
  (s.sel ? s.sel[y * s.w + x] / 255 : 1)

function growBBox(b: BBox | null, r: DabRect): BBox {
  if (!b) return { x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h }
  b.x0 = Math.min(b.x0, r.x)
  b.y0 = Math.min(b.y0, r.y)
  b.x1 = Math.max(b.x1, r.x + r.w)
  b.y1 = Math.max(b.y1, r.y + r.h)
  return b
}

type DabApply = (s: Stroke, r: DabRect, cov: Float32Array) => void

/** Lays one dab: computes its coverage, hands it to the operator, marks it dirty. */
function dabAt(s: Stroke, cx: number, cy: number, apply: DabApply): void {
  const r = s.radius
  const x0 = Math.max(0, Math.floor(cx - r))
  const y0 = Math.max(0, Math.floor(cy - r))
  const x1 = Math.min(s.w, Math.ceil(cx + r) + 1)
  const y1 = Math.min(s.h, Math.ceil(cy + r) + 1)
  const rw = x1 - x0
  const rh = y1 - y0
  if (rw <= 0 || rh <= 0) return

  if (s.cov.length < rw * rh) s.cov = new Float32Array(rw * rh)
  const cov = s.cov
  const inner = s.inner
  const span = Math.max(1e-6, r - inner)
  let any = false
  for (let y = 0; y < rh; y++) {
    const dy = y0 + y + 0.5 - cy
    for (let x = 0; x < rw; x++) {
      const dx = x0 + x + 0.5 - cx
      const d = Math.sqrt(dx * dx + dy * dy)
      let c: number
      if (d <= inner) c = 1
      else if (d >= r) c = 0
      else {
        const t = (d - inner) / span
        c = 1 - t * t * (3 - 2 * t) // smoothstep falloff
      }
      if (c > 0) {
        c *= s.flowGain
        if (s.sel) c *= s.sel[(y0 + y) * s.w + (x0 + x)] / 255
      }
      if (c > 0) any = true
      cov[y * rw + x] = c
    }
  }
  if (!any) return

  const rect: DabRect = { x: x0, y: y0, w: rw, h: rh, cx, cy }
  apply(s, rect, cov)
  s.bbox = growBBox(s.bbox, rect)
  s.dirty = growBBox(s.dirty, rect)
}

/** Walks from the last sample to `(x, y)`, laying evenly spaced dabs. */
function strokeTo(s: Stroke, x: number, y: number, apply: DabApply): void {
  const dx = x - s.lastX
  const dy = y - s.lastY
  const dist = Math.hypot(dx, dy)
  if (dist <= 0) return
  let t = s.carry
  while (t <= dist) {
    const f = t / dist
    dabAt(s, s.lastX + dx * f, s.lastY + dy * f, apply)
    t += s.spacing
  }
  s.carry = t - dist
  s.lastX = x
  s.lastY = y
}

/** Copies a rectangle out of the full-document mirror, tightly packed. */
function cropRect(src: Uint8Array, docW: number, x: number, y: number, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h * 4)
  for (let row = 0; row < h; row++) {
    const from = ((y + row) * docW + x) * 4
    out.set(src.subarray(from, from + w * 4), row * w * 4)
  }
  return out
}

/** Pushes the pixels touched since the last flush back to the layer. */
function flush(ctx: ToolContext, s: Stroke): void {
  const d = s.dirty
  if (!d) return
  s.dirty = null
  const w = d.x1 - d.x0
  const h = d.y1 - d.y0
  if (w <= 0 || h <= 0) return
  ctx.writeTexRect(s.layerId, d.x0, d.y0, w, h, cropRect(s.buf, s.w, d.x0, d.y0, w, h))
  ctx.invalidate()
}

/**
 * Commits the stroke. History holds the PRE-STROKE pixels — captured in
 * `beginStroke` before a single byte was written — cropped to the rectangle the
 * stroke really touched, so a dab in a corner never costs a full-document
 * snapshot. This mirrors how the editor commits its own brush strokes.
 */
function endStroke(ctx: ToolContext, s: Stroke): void {
  flush(ctx, s)
  if (s.bbox) ctx.pushUndoRect(s.layerId, s.base, s.bbox)
}

/** Aborts: the layer goes back to the pixels captured before the first dab. */
function cancelStroke(ctx: ToolContext, s: Stroke): void {
  if (!s.bbox) return
  const b = s.bbox
  const w = b.x1 - b.x0
  const h = b.y1 - b.y0
  if (w <= 0 || h <= 0) return
  ctx.writeTexRect(s.layerId, b.x0, b.y0, w, h, cropRect(s.base, s.w, b.x0, b.y0, w, h))
  ctx.invalidate()
}

// ─────────────────────────────────────────────────────────────────────────────
// Result blending
// ─────────────────────────────────────────────────────────────────────────────

const hslA = new Float64Array(3)
const hslB = new Float64Array(3)
const rgbTmp = new Float64Array(3)

/**
 * Combines the effect result with the source the way the tool's "mode" option
 * asks. Everything is gamma-encoded here, which is the space the options bar
 * (and Photoshop) reason in. Writes back into `out`.
 */
function applyFocusMode(mode: FocusMode, sr: number, sg: number, sb: number, out: Float64Array): void {
  if (mode === 'normal') return
  if (mode === 'lighten') {
    out[0] = Math.max(sr, out[0]); out[1] = Math.max(sg, out[1]); out[2] = Math.max(sb, out[2])
    return
  }
  if (mode === 'darken') {
    out[0] = Math.min(sr, out[0]); out[1] = Math.min(sg, out[1]); out[2] = Math.min(sb, out[2])
    return
  }
  rgbToHsl(sr, sg, sb, hslA)
  rgbToHsl(out[0], out[1], out[2], hslB)
  let h = hslA[0]
  let s = hslA[1]
  let l = hslA[2]
  switch (mode) {
    case 'hue':        h = hslB[0]; break
    case 'saturation': s = hslB[1]; break
    case 'color':      h = hslB[0]; s = hslB[1]; break
    case 'luminosity': l = hslB[2]; break
  }
  hslToRgb(h, s, l, out)
}

/**
 * Writes `out` over the pixel at `i`, weighted by coverage `c`. The mix happens
 * in PREMULTIPLIED space: mixing straight colours would drag the (meaningless)
 * colour of transparent pixels into the result, which is exactly how blur and
 * smudge grow a black fringe along a transparent edge.
 *
 * `sr…sa` and `or…oa` are gamma-encoded 0..1 components; alpha is 0..1.
 */
function writeMixed(
  s: Stroke, i: number,
  sr: number, sg: number, sb: number, sa: number,
  or_: number, og: number, ob: number, oaIn: number,
  c: number,
): void {
  // Locking transparency freezes alpha; the colour must then be mixed against
  // the source alpha too, or the premultiplied division darkens the pixel.
  const oa = s.lockAlpha ? sa : clamp01(oaIn)
  const na = sa + (oa - sa) * c
  const buf = s.buf
  if (na <= 0) {
    buf[i + 3] = 0
    return
  }
  const psr = sr * sa, psg = sg * sa, psb = sb * sa
  const r = (psr + (or_ * oa - psr) * c) / na
  const g = (psg + (og * oa - psg) * c) / na
  const b = (psb + (ob * oa - psb) * c) / na
  buf[i]     = Math.round(clamp01(r) * 255)
  buf[i + 1] = Math.round(clamp01(g) * 255)
  buf[i + 2] = Math.round(clamp01(b) * 255)
  buf[i + 3] = Math.round(na * 255)
}

// ─────────────────────────────────────────────────────────────────────────────
// Blur / sharpen — port of GIMP's convolve tool
// ─────────────────────────────────────────────────────────────────────────────

// gimpconvolve.c: the centre weight of the 3×3 matrix is interpolated between
// these bounds by the tool's rate; the eight neighbours stay at 1.0 and the
// divisor is the matrix sum, so a flat region is left untouched.
const MIN_BLUR = 64      // 8/9 of the original pixel
const MAX_BLUR = 0.25    // 1/33 of the original pixel
const MIN_SHARPEN = -512
const MAX_SHARPEN = -64

interface ConvState {
  kernel: Float32Array
  divisor: number
  mode: FocusMode
  /** Sharpen only: forbid over/undershoot beyond the 3×3 neighbourhood. */
  protectDetail: boolean
  /** Scratch source region, reused between dabs. */
  src: Float32Array
}

function convolveMatrix(sharpen: boolean, rate: number): { kernel: Float32Array; divisor: number } {
  const percent = Math.min(rate / 100, 1)
  const centre = sharpen
    ? MIN_SHARPEN + percent * (MAX_SHARPEN - MIN_SHARPEN)
    : MIN_BLUR + percent * (MAX_BLUR - MIN_BLUR)
  const kernel = new Float32Array([1, 1, 1, 1, centre, 1, 1, 1, 1])
  let divisor = 0
  for (let i = 0; i < 9; i++) divisor += kernel[i]
  return { kernel, divisor }
}

function convolveApply(st: ConvState, s: Stroke, r: DabRect, cov: Float32Array): void {
  // Source region with a one-pixel margin, clipped to the document. Reading
  // from a copy (never from `buf` in flight) keeps the convolution symmetric:
  // an in-place pass would feed already-filtered pixels back into the kernel.
  const sx0 = Math.max(0, r.x - 1)
  const sy0 = Math.max(0, r.y - 1)
  const sx1 = Math.min(s.w, r.x + r.w + 1)
  const sy1 = Math.min(s.h, r.y + r.h + 1)
  const sw = sx1 - sx0
  const sh = sy1 - sy0
  const need = sw * sh * 4
  if (st.src.length < need) st.src = new Float32Array(need)
  const src = st.src
  // Straight linear-light RGBA — GIMP convolves in linear too, and blurring in
  // gamma space visibly darkens the mid-tones of a bright/dark transition.
  for (let y = 0; y < sh; y++) {
    let o = y * sw * 4
    let i = ((sy0 + y) * s.w + sx0) * 4
    for (let x = 0; x < sw; x++, o += 4, i += 4) {
      src[o]     = SRGB_TO_LINEAR[s.buf[i]]
      src[o + 1] = SRGB_TO_LINEAR[s.buf[i + 1]]
      src[o + 2] = SRGB_TO_LINEAR[s.buf[i + 2]]
      src[o + 3] = s.buf[i + 3] / 255
    }
  }

  const k = st.kernel
  const divisor = st.divisor
  const out = rgbTmp
  for (let dy = 0; dy < r.h; dy++) {
    for (let dx = 0; dx < r.w; dx++) {
      // Incremental, like GIMP's convolve: every dab filters what the previous
      // one left, so passing over the same spot keeps blurring (or sharpening).
      const c = cov[dy * r.w + dx] * s.opacity
      if (c <= 0) continue
      const lx = r.x + dx - sx0
      const ly = r.y + dy - sy0

      // gimp_gegl_convolve() with alpha weighting: each tap is weighted by its
      // own alpha, so transparent neighbours contribute nothing to the colour
      // instead of pulling it toward black.
      let tr = 0, tg = 0, tb = 0, ta = 0, wd = 0
      let mnR = 1, mxR = 0, mnG = 1, mxG = 0, mnB = 1, mxB = 0
      let m = 0
      for (let j = -1; j <= 1; j++) {
        const yy = clamp(ly + j, 0, sh - 1)
        for (let i = -1; i <= 1; i++, m++) {
          const xx = clamp(lx + i, 0, sw - 1)
          const o = (yy * sw + xx) * 4
          const a = src[o + 3]
          if (a > 0) {
            const ma = k[m] * a
            wd += ma
            tr += ma * src[o]
            tg += ma * src[o + 1]
            tb += ma * src[o + 2]
            ta += ma
            if (st.protectDetail) {
              if (src[o] < mnR) mnR = src[o]
              if (src[o] > mxR) mxR = src[o]
              if (src[o + 1] < mnG) mnG = src[o + 1]
              if (src[o + 1] > mxG) mxG = src[o + 1]
              if (src[o + 2] < mnB) mnB = src[o + 2]
              if (src[o + 2] > mxB) mxB = src[o + 2]
            }
          }
        }
      }
      if (wd === 0) wd = divisor

      let lr = tr / wd, lg = tg / wd, lb = tb / wd
      if (st.protectDetail && mxR >= mnR) {
        // Halo guard: an unsharp mask that stays inside the local range
        // steepens edges without ringing around them.
        lr = clamp(lr, mnR, mxR); lg = clamp(lg, mnG, mxG); lb = clamp(lb, mnB, mxB)
      }
      const la = clamp01(ta / divisor)

      const si = (ly * sw + lx) * 4
      const sr = linToSrgb(src[si]), sg = linToSrgb(src[si + 1]), sb = linToSrgb(src[si + 2])
      out[0] = linToSrgb(lr); out[1] = linToSrgb(lg); out[2] = linToSrgb(lb)
      applyFocusMode(st.mode, sr, sg, sb, out)
      writeMixed(s, ((r.y + dy) * s.w + (r.x + dx)) * 4,
        sr, sg, sb, src[si + 3], out[0], out[1], out[2], la, c)
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Smudge — port of GIMP's accumulator model
// ─────────────────────────────────────────────────────────────────────────────

interface SmudgeState {
  /** Brush-local accumulator (straight linear RGBA), it travels with the dab. */
  accum: Float32Array
  size: number
  half: number
  /** How much of the accumulator survives one dab: pickup persistence. */
  rate: number
  /** Finger painting mixes the foreground colour in at this rate. */
  finger: number
  fg: [number, number, number]
  mode: FocusMode
  primed: boolean
}

/**
 * gimp_gegl_smudge_with_paint_blend(): alpha-weighted mix of two straight RGBA
 * samples. Working on `a·colour` and renormalising is what keeps a transparent
 * neighbour from bleeding black into the smear.
 */
function smudgeBlend(
  dst: Float32Array, di: number,
  r1: number, g1: number, b1: number, a1: number, rate1: number,
  r2: number, g2: number, b2: number, a2: number, rate2: number,
): void {
  const wa = rate1 * a1
  const wb = rate2 * a2
  const na = wa + wb
  if (na === 0) {
    dst[di] = dst[di + 1] = dst[di + 2] = dst[di + 3] = 0
    return
  }
  dst[di]     = (r1 * wa + r2 * wb) / na
  dst[di + 1] = (g1 * wa + g2 * wb) / na
  dst[di + 2] = (b1 * wa + b2 * wb) / na
  dst[di + 3] = na
}

/** Fills the accumulator with the canvas under the brush (GIMP's smudge start). */
function primeSmudge(st: SmudgeState, s: Stroke, cx: number, cy: number): void {
  const ox = Math.round(cx) - st.half
  const oy = Math.round(cy) - st.half
  const acc = st.accum
  for (let y = 0; y < st.size; y++) {
    const py = clamp(oy + y, 0, s.h - 1)
    for (let x = 0; x < st.size; x++) {
      const px = clamp(ox + x, 0, s.w - 1)
      const i = (py * s.w + px) * 4
      const o = (y * st.size + x) * 4
      acc[o]     = SRGB_TO_LINEAR[s.buf[i]]
      acc[o + 1] = SRGB_TO_LINEAR[s.buf[i + 1]]
      acc[o + 2] = SRGB_TO_LINEAR[s.buf[i + 2]]
      acc[o + 3] = s.buf[i + 3] / 255
    }
  }
  st.primed = true
}

function smudgeApply(st: SmudgeState, s: Stroke, r: DabRect, cov: Float32Array): void {
  if (!st.primed) primeSmudge(st, s, r.cx, r.cy)
  // The accumulator is indexed in brush-local coordinates, so its content
  // follows the pointer — that travelling colour IS the smear.
  const ox = Math.round(r.cx) - st.half
  const oy = Math.round(r.cy) - st.half
  const acc = st.accum
  const size = st.size
  const rate = st.rate
  const out = rgbTmp

  for (let dy = 0; dy < r.h; dy++) {
    const ay = r.y + dy - oy
    if (ay < 0 || ay >= size) continue
    for (let dx = 0; dx < r.w; dx++) {
      const c = cov[dy * r.w + dx] * s.opacity
      if (c <= 0) continue
      const ax = r.x + dx - ox
      if (ax < 0 || ax >= size) continue

      const i = ((r.y + dy) * s.w + (r.x + dx)) * 4
      const cr = SRGB_TO_LINEAR[s.buf[i]]
      const cg = SRGB_TO_LINEAR[s.buf[i + 1]]
      const cb = SRGB_TO_LINEAR[s.buf[i + 2]]
      const ca = s.buf[i + 3] / 255

      // Accum = rate·Accum + (1 - rate)·Canvas
      const ai = (ay * size + ax) * 4
      smudgeBlend(acc, ai,
        acc[ai], acc[ai + 1], acc[ai + 2], acc[ai + 3], rate,
        cr, cg, cb, ca, 1 - rate)

      let pr = acc[ai], pg = acc[ai + 1], pb = acc[ai + 2], pa = acc[ai + 3]
      if (st.finger > 0) {
        // Paint = flow·Foreground + (1 - flow)·Accum
        const f = st.finger
        const wa = f
        const wb = (1 - f) * pa
        const na = wa + wb
        if (na > 0) {
          pr = (st.fg[0] * wa + pr * wb) / na
          pg = (st.fg[1] * wa + pg * wb) / na
          pb = (st.fg[2] * wa + pb * wb) / na
          pa = na
        }
      }

      const sr = linToSrgb(cr), sg = linToSrgb(cg), sb = linToSrgb(cb)
      out[0] = linToSrgb(pr); out[1] = linToSrgb(pg); out[2] = linToSrgb(pb)
      applyFocusMode(st.mode, sr, sg, sb, out)
      writeMixed(s, i, sr, sg, sb, ca, out[0], out[1], out[2], clamp01(pa), c)
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Dodge / burn — port of gimp_gegl_dodgeburn()
// ─────────────────────────────────────────────────────────────────────────────

interface ToneState {
  range: ToneRange
  /** Signed exposure: positive dodges, negative burns. */
  exposure: number
  factor: number
  /** Keep hue and saturation, move luminance only (Photoshop's Protect Tones). */
  protectTones: boolean
  /** Coverage reached so far — see `constantCoverage()`. */
  cover: Uint8Array
}

/**
 * GIMP's GIMP_PAINT_CONSTANT application mode, which is what dodge, burn and
 * sponge use (`gimp_dodge_burn_motion` reads `gimp_paint_core_get_orig_image`).
 * Instead of stacking one transfer function on top of the previous result —
 * which would drive a whole stroke to pure white in a few dabs — each pixel
 * remembers how much of the stroke it has received, and the effect is always
 * recomputed from the PRE-STROKE pixels at that coverage. Flow builds the
 * coverage up, opacity caps it, and a second stroke starts over from there.
 *
 * Returns the new coverage, or -1 when this dab adds nothing.
 */
function constantCoverage(s: Stroke, cover: Uint8Array, ci: number, c: number): number {
  const ceiling = s.opacity * selAt(s, ci % s.w, (ci / s.w) | 0)
  const prev = cover[ci] / 255
  if (prev >= ceiling) return -1
  const next = Math.min(ceiling, prev + c)
  if (next <= prev) return -1
  cover[ci] = Math.round(next * 255)
  return next
}

/** GIMP's odd_powf(): keeps the sign of a value raised to a fractional power. */
const oddPow = (x: number, y: number): number => (x >= 0 ? Math.pow(x, y) : -Math.pow(-x, y))

function toneFactor(range: ToneRange, exposure: number): number {
  switch (range) {
    case 'highlights':
      return 1 + exposure * (1 / 3)
    case 'midtones':
      return exposure < 0 ? 1 - exposure * (1 / 3) : 1 / (1 + exposure)
    case 'shadows':
      return exposure >= 0 ? (1 / 3) * exposure : -(1 / 3) * exposure
  }
}

/** Transfer function of one gamma-encoded component, per tonal range. */
function toneMap(st: ToneState, v: number): number {
  switch (st.range) {
    case 'highlights':
      // Multiplicative: a dark pixel barely moves, a bright one moves a lot.
      return clamp01(v * st.factor)
    case 'midtones':
      return clamp01(oddPow(v, st.factor))
    case 'shadows': {
      const f = st.factor
      if (st.exposure >= 0) return clamp01(f + v - f * v)
      return v < f ? 0 : clamp01((v - f) / (1 - f))
    }
  }
}

function toneApply(st: ToneState, s: Stroke, r: DabRect, cov: Float32Array): void {
  const out = rgbTmp
  for (let dy = 0; dy < r.h; dy++) {
    for (let dx = 0; dx < r.w; dx++) {
      const raw = cov[dy * r.w + dx]
      if (raw <= 0) continue
      const ci = (r.y + dy) * s.w + (r.x + dx)
      const c = constantCoverage(s, st.cover, ci, raw)
      if (c < 0) continue
      const i = ci * 4
      const a = s.base[i + 3] / 255
      if (a <= 0) continue
      const sr = s.base[i] / 255, sg = s.base[i + 1] / 255, sb = s.base[i + 2] / 255

      if (st.protectTones) {
        // Move the luma and rescale the channels: hue stays exactly where it
        // was, saturation almost. Capping the gain at the point where the
        // brightest channel would clip is what keeps a clipped highlight from
        // rotating toward yellow.
        const l = luma(sr, sg, sb)
        if (l > 0) {
          let k = toneMap(st, l) / l
          const mx = Math.max(sr, sg, sb)
          if (k > 1 && mx * k > 1) k = 1 / mx
          out[0] = clamp01(sr * k); out[1] = clamp01(sg * k); out[2] = clamp01(sb * k)
        } else {
          const v = toneMap(st, 0)
          out[0] = v; out[1] = v; out[2] = v
        }
      } else {
        out[0] = toneMap(st, sr); out[1] = toneMap(st, sg); out[2] = toneMap(st, sb)
      }
      writeMixed(s, i, sr, sg, sb, a, out[0], out[1], out[2], a, c)
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sponge — saturation brush (no GIMP counterpart)
// ─────────────────────────────────────────────────────────────────────────────

interface SpongeState {
  saturate: boolean
  /** Full-stroke saturation step, 0..1. */
  rate: number
  /** Protect already saturated pixels from clipping. */
  vibrance: boolean
  /** Coverage reached so far — the sponge builds up like dodge and burn. */
  cover: Uint8Array
}

/**
 * Saturation below this (≈ 1/255) is quantisation noise, not a colour: boosting
 * it would invent a hue and turn a grey area into confetti.
 */
const ACHROMATIC = 2 / 255

function spongeApply(st: SpongeState, s: Stroke, r: DabRect, cov: Float32Array): void {
  const out = rgbTmp
  for (let dy = 0; dy < r.h; dy++) {
    for (let dx = 0; dx < r.w; dx++) {
      const raw = cov[dy * r.w + dx]
      if (raw <= 0) continue
      const ci = (r.y + dy) * s.w + (r.x + dx)
      const c = constantCoverage(s, st.cover, ci, raw)
      if (c < 0) continue
      const i = ci * 4
      const a = s.base[i + 3] / 255
      if (a <= 0) continue
      const sr = s.base[i] / 255, sg = s.base[i + 1] / 255, sb = s.base[i + 2] / 255

      rgbToHsl(sr, sg, sb, hslA)
      const sat = hslA[1]
      if (st.saturate && sat < ACHROMATIC) continue
      let step = st.rate
      // Hue and lightness are carried over untouched, so the colour never
      // drifts — only its distance to the grey axis changes.
      let ns: number
      if (st.saturate) {
        if (st.vibrance) step *= 1 - sat
        ns = clamp01(sat + step * (1 - sat))
      } else {
        ns = clamp01(sat * (1 - step))
      }
      hslToRgb(hslA[0], ns, hslA[2], out)
      writeMixed(s, i, sr, sg, sb, a, out[0], out[1], out[2], a, c)
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler factory
// ─────────────────────────────────────────────────────────────────────────────

/** Foreground colour as linear-light components, for finger painting. */
function hexToLinear(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return [0, 0, 0]
  const n = parseInt(m[1], 16)
  return [
    SRGB_TO_LINEAR[(n >> 16) & 255],
    SRGB_TO_LINEAR[(n >> 8) & 255],
    SRGB_TO_LINEAR[n & 255],
  ]
}

interface EffectTool<S> {
  /** Per-stroke setup: reads the options bar and allocates scratch buffers. */
  begin(ctx: ToolContext, s: Stroke, p: ToolPointer, opts: OptionBag): S
  apply(st: S, s: Stroke, r: DabRect, cov: Float32Array): void
}

/** Draws the brush outline on the overlay, in screen space. */
function brushPreview(ctx: ToolContext, x: number, y: number): (c2d: CanvasRenderingContext2D) => void {
  const [sx, sy] = ctx.docToScreen(x, y)
  const rad = Math.max(1.5, (ctx.brushSize / 2) * ctx.zoom)
  return (c2d: CanvasRenderingContext2D) => {
    c2d.save()
    c2d.beginPath()
    c2d.arc(sx, sy, rad, 0, Math.PI * 2)
    c2d.lineWidth = 3
    c2d.strokeStyle = 'rgba(0,0,0,0.45)'
    c2d.stroke()
    c2d.lineWidth = 1
    c2d.strokeStyle = 'rgba(255,255,255,0.95)'
    c2d.stroke()
    c2d.restore()
  }
}

function makeHandler<S>(toolId: string, tool: EffectTool<S>): ToolHandler {
  let stroke: Stroke | null = null
  let state: S | null = null

  const applyDab: DabApply = (s, r, cov) => {
    if (state !== null) tool.apply(state, s, r, cov)
  }

  return {
    // No CSS cursor on purpose: the editor keeps its drawn crosshair, and the
    // brush outline below adds the size the crosshair cannot show.
    onDown(ctx, p) {
      ctx.setPreview(brushPreview(ctx, p.x, p.y))
      const s = beginStroke(ctx, p)
      if (!s) return
      s.flowGain = gainFor(ctx, p)
      state = tool.begin(ctx, s, p, readStoredOptions(toolId))
      stroke = s
      dabAt(s, p.x, p.y, applyDab)
      s.carry = s.spacing
      flush(ctx, s)
    },

    onMove(ctx, p) {
      ctx.setPreview(brushPreview(ctx, p.x, p.y))
      const s = stroke
      if (!s) return
      s.flowGain = gainFor(ctx, p)
      strokeTo(s, p.x, p.y, applyDab)
      flush(ctx, s)
    },

    onUp(ctx, p) {
      const s = stroke
      if (s) {
        s.flowGain = gainFor(ctx, p)
        strokeTo(s, p.x, p.y, applyDab)
        endStroke(ctx, s)
      }
      stroke = null
      state = null
      ctx.setPreview(null)
    },

    onCancel(ctx) {
      const s = stroke
      if (s) cancelStroke(ctx, s)
      stroke = null
      state = null
      ctx.setPreview(null)
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The six tools
// ─────────────────────────────────────────────────────────────────────────────

function convolveTool(toolId: 'blur' | 'sharpen'): ToolHandler {
  const sharpen = toolId === 'sharpen'
  return makeHandler<ConvState>(toolId, {
    begin(_ctx, _s, _p, opts) {
      const { kernel, divisor } = convolveMatrix(sharpen, optNum(opts, 'strength', 50))
      return {
        kernel,
        divisor,
        mode: optStr(opts, 'focus-mode', 'normal', FOCUS_MODES),
        protectDetail: sharpen && optBool(opts, 'protect-detail', true),
        src: new Float32Array(0),
      }
    },
    apply: convolveApply,
  })
}

registerTool('blur', convolveTool('blur'))
registerTool('sharpen', convolveTool('sharpen'))

registerTool('smudge', makeHandler<SmudgeState>('smudge', {
  begin(ctx, s, _p, opts) {
    // GIMP sizes the accumulator from the brush; one extra pixel of margin
    // keeps a dab that lands between two pixels inside it.
    const size = Math.ceil(s.radius * 2) + 3
    const strength = clamp01(optNum(opts, 'strength', 50) / 100)
    // GIMP's raw rate decays per DAB, so the smear length would depend on the
    // spacing (and therefore on the brush size). Expressing it as a half-life
    // in document pixels makes the smear proportional to the brush instead.
    const halfLife = Math.max(0.5, s.radius * (0.08 + 2.4 * strength * strength))
    return {
      accum: new Float32Array(size * size * 4),
      size,
      half: size >> 1,
      rate: clamp(Math.pow(0.5, s.spacing / halfLife), 0, 0.995),
      finger: optBool(opts, 'finger-paint', false) ? pct01(ctx.brushFlow) : 0,
      fg: hexToLinear(ctx.foreground),
      mode: optStr(opts, 'focus-mode', 'normal', FOCUS_MODES),
      primed: false,
    }
  },
  apply: smudgeApply,
}))

function toneTool(toolId: 'dodge' | 'burn'): ToolHandler {
  return makeHandler<ToneState>(toolId, {
    begin(_ctx, s, p, opts) {
      // Alt swaps dodge and burn, the way Photoshop does.
      const burn = (toolId === 'burn') !== p.altKey
      const range = optStr(opts, 'tone-range', 'midtones', TONE_RANGES)
      const exposure = (burn ? -1 : 1) * clamp01(optNum(opts, 'exposure', 50) / 100)
      return {
        range,
        exposure,
        factor: toneFactor(range, exposure),
        protectTones: optBool(opts, 'protect-tones', true),
        cover: new Uint8Array(s.w * s.h),
      }
    },
    apply: toneApply,
  })
}

registerTool('dodge', toneTool('dodge'))
registerTool('burn', toneTool('burn'))

registerTool('sponge', makeHandler<SpongeState>('sponge', {
  begin(_ctx, s, p, opts) {
    const mode = optStr(opts, 'sponge-mode', 'desaturate', SPONGE_MODES)
    return {
      // Alt flips saturate and desaturate without a trip to the options bar.
      saturate: (mode === 'saturate') !== p.altKey,
      rate: clamp01(optNum(opts, 'flow', 50) / 100),
      vibrance: optBool(opts, 'vibrance', true),
      cover: new Uint8Array(s.w * s.h),
    }
  },
  apply: spongeApply,
}))
