// Complementary paint tools and the special erasers: pencil, colour replacement,
// mixer brush, background eraser and magic eraser.
//
// Everything here talks to the editor through `ToolContext` only — no React, no
// GL, no import from `LayerEditorPage`. Pixels are STRAIGHT (non-premultiplied)
// RGBA, which is what `readTex`/`writeTex` exchange, and document row `y` maps
// directly to texture row `y`.
//
// Algorithms are ported from the GNU Image Manipulation Program (GPLv3):
//   * hard, alias-free stamping ....... app/paint/gimppencil.c (a paintbrush
//     forced to the "hard" brush application mode: a pixel is painted or not).
//   * mixer accumulator ............... app/paint/gimpsmudge.c, whose recurrence
//     is  Accum = rate·Accum + (1-rate)·Canvas ,
//         Paint = (1-flow)·Accum + flow·BrushColour .
//     The mixer brush below is that model plus a colour reservoir.
//   * contiguous region growth ........ app/core/gimppickable-contiguous-region.cc
//     (re-implemented with an explicit stack — never recursive).
// Kubuno is AGPLv3, which is compatible with reusing those GPLv3 designs.
import type { LayerStructureItem } from '../../../api'
import { registerTool } from './registry'
import type { ToolContext, ToolHandler } from './types'

// ─────────────────────────────────────────────────────────────────────────────
// Tunables
//
// `ToolContext` carries the brush trio (size / hardness / opacity / flow) but not
// the per-tool option values, so the settings the options bar will drive live
// here behind a single mutable record. Defaults mirror `toolDefs.ts`.
// ─────────────────────────────────────────────────────────────────────────────

/** How a sampling tool refreshes its reference colour. */
export type SamplingMode = 'continuous' | 'once'
/** Whether a match spreads only through touching pixels. */
export type Limits = 'contiguous' | 'discontiguous'
/** Which channels the colour replacement rewrites. */
export type ReplaceMode = 'hue' | 'saturation' | 'color' | 'luminosity'

export interface PencilOptions {
  /** GIMP's auto-erase: starting on the foreground colour paints the background. */
  autoErase: boolean
}

export interface ColorReplaceOptions {
  /** 0..100 %, compared against the largest per-channel difference. */
  tolerance: number
  sampling: SamplingMode
  limits: Limits
  mode: ReplaceMode
}

export interface MixerBrushOptions {
  /** 0..100 % — share of the canvas colour taken into the brush at every dab. */
  wet: number
  /** 0..100 % — share of the reservoir colour in the paint that is laid down. */
  load: number
  /** 0..100 % — how much of that paint replaces the canvas at every dab. */
  mix: number
  /** Reservoir colour (`#rrggbb`), or null to load the foreground colour. */
  reservoir: string | null
}

export interface BgEraserOptions {
  /** 0..100 %, compared against the largest per-channel difference (alpha included). */
  tolerance: number
  sampling: SamplingMode
  limits: Limits
  /** Never erase pixels close to the foreground colour. */
  protectForeground: boolean
}

export interface MagicEraserOptions {
  /** 0..255, like the magic wand. */
  tolerance: number
  contiguous: boolean
  antialias: boolean
  /** 0..100 % — how much alpha a single click removes. */
  opacity: number
}

export interface PaintExtraOptions {
  pencil: PencilOptions
  colorReplace: ColorReplaceOptions
  mixerBrush: MixerBrushOptions
  bgEraser: BgEraserOptions
  magicEraser: MagicEraserOptions
}

export const paintExtraOptions: PaintExtraOptions = {
  pencil: { autoErase: false },
  colorReplace: { tolerance: 30, sampling: 'continuous', limits: 'contiguous', mode: 'color' },
  mixerBrush: { wet: 50, load: 50, mix: 50, reservoir: null },
  bgEraser: { tolerance: 50, sampling: 'continuous', limits: 'contiguous', protectForeground: false },
  magicEraser: { tolerance: 32, contiguous: true, antialias: true, opacity: 100 },
}

/** Shallow per-tool patch, so the options bar can push one control at a time. */
export function setPaintExtraOptions(patch: {
  [K in keyof PaintExtraOptions]?: Partial<PaintExtraOptions[K]>
}): void {
  for (const key of Object.keys(patch) as (keyof PaintExtraOptions)[]) {
    const part = patch[key]
    if (part) Object.assign(paintExtraOptions[key], part)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Colour helpers
// ─────────────────────────────────────────────────────────────────────────────

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)
const clampByte = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v))

/** `#rgb` / `#rrggbb` → three bytes. Unparsable input falls back to black. */
export function hexToRgb(hex: string): [number, number, number] {
  const s = hex.trim().replace(/^#/, '')
  if (s.length === 3) {
    const r = parseInt(s[0] + s[0], 16), g = parseInt(s[1] + s[1], 16), b = parseInt(s[2] + s[2], 16)
    if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) return [r, g, b]
  }
  if (s.length >= 6) {
    const r = parseInt(s.slice(0, 2), 16), g = parseInt(s.slice(2, 4), 16), b = parseInt(s.slice(4, 6), 16)
    if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) return [r, g, b]
  }
  return [0, 0, 0]
}

// Non-separable blend primitives, exactly as specified for the Hue / Saturation /
// Colour / Luminosity modes (PDF 1.7 §11.3.5.3, reused verbatim by CSS
// compositing and by Photoshop). `Lum` is the quantity the colour replacement
// preserves: keeping it fixed is what makes a repainted subject keep every one of
// its shades. Components are floats in 0..255.
type Triple = [number, number, number]

/** Luminosity used by the non-separable blend modes. */
export const luma = (r: number, g: number, b: number): number => 0.3 * r + 0.59 * g + 0.11 * b

/** Pulls an out-of-gamut colour back into 0..255 while holding its luminosity. */
function clipColor(c: Triple): Triple {
  const l = luma(c[0], c[1], c[2])
  const n = Math.min(c[0], c[1], c[2])
  const x = Math.max(c[0], c[1], c[2])
  let out = c
  if (n < 0 && l - n !== 0) {
    const k = l / (l - n)
    out = [l + (out[0] - l) * k, l + (out[1] - l) * k, l + (out[2] - l) * k]
  }
  if (x > 255 && x - l !== 0) {
    const k = (255 - l) / (x - l)
    out = [l + (out[0] - l) * k, l + (out[1] - l) * k, l + (out[2] - l) * k]
  }
  return out
}

/** `c` shifted to the requested luminosity. */
function setLum(c: Triple, l: number): Triple {
  const d = l - luma(c[0], c[1], c[2])
  return clipColor([c[0] + d, c[1] + d, c[2] + d])
}

const sat = (c: Triple): number => Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2])

/** `c` rescaled to the requested saturation, keeping the mid component's rank. */
function setSat(c: Triple, s: number): Triple {
  const idx: [number, number, number] = [0, 1, 2]
  idx.sort((a, b) => c[a] - c[b])
  const [lo, mid, hi] = idx
  const out: Triple = [0, 0, 0]
  if (c[hi] > c[lo]) {
    out[mid] = ((c[mid] - c[lo]) * s) / (c[hi] - c[lo])
    out[hi] = s
  }
  out[lo] = 0
  return out
}

/**
 * Largest per-channel difference between a pixel and a reference RGBA, alpha
 * included — that is what keeps a transparent pixel out of an opaque reference's
 * tolerance, and it is the metric GIMP uses in "composite" mode.
 */
export function colorDist(px: Uint8Array, i: number, ref: RGBA): number {
  const dr = Math.abs(px[i] - ref[0])
  const dg = Math.abs(px[i + 1] - ref[1])
  const db = Math.abs(px[i + 2] - ref[2])
  const da = Math.abs(px[i + 3] - ref[3])
  return Math.max(dr, dg, db, da)
}

export type RGBA = [number, number, number, number]

/** The pixel at a document position, or null when it falls outside. */
function pixelAt(px: Uint8Array, docW: number, docH: number, x: number, y: number): RGBA | null {
  const ix = Math.floor(x), iy = Math.floor(y)
  if (ix < 0 || iy < 0 || ix >= docW || iy >= docH) return null
  const i = (iy * docW + ix) * 4
  return [px[i], px[i + 1], px[i + 2], px[i + 3]]
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer targeting
// ─────────────────────────────────────────────────────────────────────────────

interface PaintTarget {
  id: string
  layer: LayerStructureItem
  /** Working copy of the whole layer: dabs mutate it, flushes upload sub-rects. */
  px: Uint8Array
  lockAlpha: boolean
}

/** The layer a paint gesture may write to, or null when it must be refused. */
function resolveTarget(ctx: ToolContext): PaintTarget | null {
  const id = ctx.activeId
  if (!id) return null
  const layer = ctx.layerById(id)
  if (!layer) return null
  // Groups, adjustment and text layers hold no paintable raster; a locked layer
  // refuses every edit, whatever the tool.
  if (layer.locked || layer.children || layer.type !== 'raster') return null
  const px = ctx.readTex(id)
  if (!px) return null
  return { id, layer, px, lockAlpha: layer.lockAlpha === true }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stroke engine
// ─────────────────────────────────────────────────────────────────────────────

interface Box { x0: number; y0: number; x1: number; y1: number }

interface Stroke {
  layerId: string
  docW: number
  docH: number
  /** Live pixels; also the buffer every dab reads its "canvas" colour from. */
  px: Uint8Array
  /** Pre-stroke copy, captured BEFORE the first write — history and undo of a cancel. */
  before: Uint8Array
  /**
   * Per-pixel coverage already laid down by this stroke, 0..65535. Flow builds up
   * towards the opacity ceiling exactly like a real brush, and a 16-bit store
   * keeps small increments from rounding back to zero.
   */
  cov: Uint16Array
  radius: number
  /** Fraction of the radius that stays fully covered; the rest is the falloff. */
  solid: number
  /** True for the pencil: coverage is 0 or 1, never in between. */
  hard: boolean
  opacity: number
  flow: number
  spacing: number
  lockAlpha: boolean
  sel: Uint8Array | null
  /** Stamps one dab; installed by the tool right after the stroke is opened. */
  dab: ((cx: number, cy: number) => void) | null
  last: { x: number; y: number } | null
  /** Leftover arc length carried between move events so spacing stays even. */
  carry: number
  /** Union of every touched pixel; drives the history rectangle. */
  dirty: Box | null
  /** Touched since the last upload. */
  pending: Box | null
}

const growBox = (b: Box | null, x0: number, y0: number, x1: number, y1: number): Box =>
  b === null
    ? { x0, y0, x1, y1 }
    : { x0: Math.min(b.x0, x0), y0: Math.min(b.y0, y0), x1: Math.max(b.x1, x1), y1: Math.max(b.y1, y1) }

/** Opens a stroke on the active layer, or returns null when painting is refused. */
function startStroke(ctx: ToolContext, opts: { hard?: boolean; opacity?: number; flow?: number }): Stroke | null {
  const target = resolveTarget(ctx)
  if (!target) return null
  const docW = ctx.docW, docH = ctx.docH
  if (docW <= 0 || docH <= 0 || target.px.length < docW * docH * 4) return null

  const size = Math.max(1, ctx.brushSize)
  const hard = opts.hard === true
  const hardness = hard ? 100 : Math.max(0, Math.min(100, ctx.brushHardness))
  return {
    layerId: target.id,
    docW, docH,
    px: target.px,
    before: target.px.slice(),
    cov: new Uint16Array(docW * docH),
    radius: size / 2,
    // A soft brush keeps a thin anti-aliased rim even at hardness 100 %, which is
    // exactly the difference the pencil below does away with.
    solid: Math.min(0.98, hardness / 100),
    hard,
    opacity: clamp01((opts.opacity ?? ctx.brushOpacity) / 100),
    flow: clamp01((opts.flow ?? ctx.brushFlow) / 100),
    spacing: Math.max(0.75, size * 0.1),
    lockAlpha: target.lockAlpha,
    sel: ctx.selection,
    dab: null,
    last: null,
    carry: 0,
    dirty: null,
    pending: null,
  }
}

/** Clipped integer bounds of a dab, one pixel of slack for the falloff. */
function dabBox(st: Stroke, cx: number, cy: number): Box {
  const r = st.radius + 1
  return {
    x0: Math.max(0, Math.floor(cx - r)),
    y0: Math.max(0, Math.floor(cy - r)),
    x1: Math.min(st.docW, Math.ceil(cx + r) + 1),
    y1: Math.min(st.docH, Math.ceil(cy + r) + 1),
  }
}

/** Geometric coverage of the pixel centred on (px,py), 0..1. */
function coverage(st: Stroke, cx: number, cy: number, px: number, py: number): number {
  const dx = px - cx, dy = py - cy
  const d = Math.sqrt(dx * dx + dy * dy)
  // Pencil: inside or outside, nothing between — no anti-aliased rim at all.
  if (st.hard) return d <= st.radius ? 1 : 0
  // Every other brush keeps at least one pixel of falloff even at hardness 100 %,
  // exactly like the editor's own dab sprite — that rim IS the anti-aliasing.
  const inner = Math.min(st.radius * st.solid, Math.max(0, st.radius - 1))
  if (d <= inner) return 1
  if (d >= st.radius) return 0
  return (st.radius - d) / (st.radius - inner)
}

/**
 * Alpha this dab may still lay on pixel `i`, honouring the selection, the flow
 * build-up and the opacity ceiling. Updates the stroke's coverage record.
 */
function dabAlpha(st: Stroke, i: number, cov: number): number {
  let c = cov
  if (st.sel) c *= st.sel[i >> 2] / 255
  if (c <= 0) return 0
  const prev = st.cov[i >> 2] / 65535
  const target = st.opacity
  if (prev >= target || prev >= 1) return 0
  const desired = Math.min(target, prev + (target - prev) * Math.min(1, c * st.flow))
  st.cov[i >> 2] = Math.round(desired * 65535)
  return (desired - prev) / (1 - prev)
}

/** Straight-alpha source-over of one colour on one pixel. */
function paintPixel(px: Uint8Array, i: number, r: number, g: number, b: number, a: number, lockAlpha: boolean): void {
  if (a <= 0) return
  const dA = px[i + 3] / 255
  if (lockAlpha) {
    // Locked transparency: the alpha channel is frozen and empty pixels stay empty.
    if (dA <= 0) return
    px[i] = clampByte(px[i] + (r - px[i]) * a)
    px[i + 1] = clampByte(px[i + 1] + (g - px[i + 1]) * a)
    px[i + 2] = clampByte(px[i + 2] + (b - px[i + 2]) * a)
    return
  }
  const oA = a + dA * (1 - a)
  if (oA <= 0) {
    px[i] = 0; px[i + 1] = 0; px[i + 2] = 0; px[i + 3] = 0
    return
  }
  // cOut = (cSrc·a + cDst·dA·(1-a)) / oA, rewritten as a lerp of weight a/oA so a
  // fully opaque dab writes the source colour byte for byte.
  const w = a / oA
  px[i] = clampByte(px[i] + (r - px[i]) * w)
  px[i + 1] = clampByte(px[i + 1] + (g - px[i + 1]) * w)
  px[i + 2] = clampByte(px[i + 2] + (b - px[i + 2]) * w)
  px[i + 3] = clampByte(oA * 255)
}

/**
 * Straight-alpha erase: only the alpha channel moves, colours stay put (that is
 * what "straight" buys us). With locked transparency this is a no-op, since an
 * eraser may never lower the alpha of a layer that protects it.
 */
function erasePixel(px: Uint8Array, i: number, a: number, lockAlpha: boolean): void {
  if (lockAlpha || a <= 0) return
  px[i + 3] = clampByte(px[i + 3] * (1 - a))
}

/** Per-pixel body of a dab: receives the buffer index and the dab alpha. */
type DabPixel = (i: number, a: number) => void

/**
 * Stamps one dab. `prepare` runs once per dab (sampling, region matching, mixing…)
 * and may veto it; `accept` filters pixels BEFORE they consume any of the stroke's
 * opacity budget — a pixel a tool skips must stay paintable later on; `apply`
 * runs on every pixel that made it through.
 */
function stampDab(
  st: Stroke,
  cxIn: number,
  cyIn: number,
  prepare: ((box: Box, cx: number, cy: number) => boolean) | null,
  accept: ((i: number) => boolean) | null,
  apply: DabPixel,
): void {
  // The pencil snaps to the pixel grid: its nib is made of whole pixels, so a
  // 1 px pencil always marks the pixel under the pointer.
  const cx = st.hard ? Math.floor(cxIn) + 0.5 : cxIn
  const cy = st.hard ? Math.floor(cyIn) + 0.5 : cyIn
  const box = dabBox(st, cx, cy)
  if (box.x1 <= box.x0 || box.y1 <= box.y0) return
  if (prepare && !prepare(box, cx, cy)) return
  // Only the pixels actually written count as touched, so the history rectangle
  // stays as tight as the mark itself.
  let tx0 = box.x1, ty0 = box.y1, tx1 = box.x0, ty1 = box.y0
  for (let y = box.y0; y < box.y1; y++) {
    for (let x = box.x0; x < box.x1; x++) {
      const cov = coverage(st, cx, cy, x + 0.5, y + 0.5)
      if (cov <= 0) continue
      const i = (y * st.docW + x) * 4
      if (accept && !accept(i)) continue
      const a = dabAlpha(st, i, cov)
      if (a <= 0) continue
      apply(i, a)
      if (x < tx0) tx0 = x
      if (y < ty0) ty0 = y
      if (x + 1 > tx1) tx1 = x + 1
      if (y + 1 > ty1) ty1 = y + 1
    }
  }
  if (tx1 <= tx0 || ty1 <= ty0) return
  st.dirty = growBox(st.dirty, tx0, ty0, tx1, ty1)
  st.pending = growBox(st.pending, tx0, ty0, tx1, ty1)
}

/**
 * Walks the segment from the previous sample to (x,y), stamping a dab every
 * `spacing` document pixels. The carry remembers how far past the last dab the
 * segment ended, so the rhythm survives across events and a fast stroke never
 * degenerates into a dotted line.
 */
function strokeTo(st: Stroke, x: number, y: number): void {
  const dab = st.dab
  if (!dab) return
  if (!st.last) {
    dab(x, y)
    st.last = { x, y }
    st.carry = 0
    return
  }
  const dx = x - st.last.x, dy = y - st.last.y
  const len = Math.sqrt(dx * dx + dy * dy)
  if (len <= 0) return
  const ux = dx / len, uy = dy / len
  // Spacing is bounded away from zero, so the loop below always terminates.
  const step = Math.max(0.25, st.spacing)
  // Distance along this segment to the first dab.
  let at = Math.max(0, step - st.carry)
  // Belt and braces: an upper bound on the number of dabs this segment can hold.
  let guard = Math.ceil(len / step) + 2
  while (at <= len && guard-- > 0) {
    dab(st.last.x + ux * at, st.last.y + uy * at)
    at += step
  }
  // `at - step` is the position of the last dab, or a negative number when none
  // was stamped — in which case the carry simply keeps growing.
  st.carry = Math.max(0, len - (at - step))
  st.last = { x, y }
}

/**
 * Final dab on the release point. Spacing normally leaves the last fraction of a
 * segment unstamped; without this a short click, or the tail of a stroke, would
 * fall short of the pixel under the pointer.
 */
function strokeFinish(st: Stroke): void {
  if (st.dab && st.last && st.carry > 0) st.dab(st.last.x, st.last.y)
}

/** Uploads the pixels touched since the last flush. */
function flush(ctx: ToolContext, st: Stroke): void {
  const p = st.pending
  if (!p) return
  st.pending = null
  const w = p.x1 - p.x0, h = p.y1 - p.y0
  if (w <= 0 || h <= 0) return
  const out = new Uint8Array(w * h * 4)
  for (let row = 0; row < h; row++) {
    const so = ((p.y0 + row) * st.docW + p.x0) * 4
    out.set(st.px.subarray(so, so + w * 4), row * w * 4)
  }
  ctx.writeTexRect(st.layerId, p.x0, p.y0, w, h, out)
  ctx.invalidate()
}

/**
 * Closes a stroke. `commit` registers the history entry built on the snapshot
 * taken before the very first write; otherwise the touched rectangle is restored
 * from that same snapshot, so an aborted gesture leaves nothing behind.
 */
function endStroke(ctx: ToolContext, st: Stroke, commit: boolean): void {
  flush(ctx, st)
  const d = st.dirty
  if (!d) return
  if (commit) {
    ctx.pushUndoRect(st.layerId, st.before, d)
    return
  }
  const w = d.x1 - d.x0, h = d.y1 - d.y0
  if (w <= 0 || h <= 0) return
  const out = new Uint8Array(w * h * 4)
  for (let row = 0; row < h; row++) {
    const so = ((d.y0 + row) * st.docW + d.x0) * 4
    out.set(st.before.subarray(so, so + w * 4), row * w * 4)
  }
  st.px.set(st.before)
  ctx.writeTexRect(st.layerId, d.x0, d.y0, w, h, out)
  ctx.invalidate()
}

// ─────────────────────────────────────────────────────────────────────────────
// Region helpers (ported from gimppickable-contiguous-region.cc, iterative)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pixels of `box` within `tol` of `ref`, as a byte mask indexed by
 * `(y - box.y0) * boxW + (x - box.x0)`. `contiguous` restricts the answer to the
 * 4-connected blob touching (seedX, seedY).
 *
 * The growth uses an explicit index stack and marks a pixel before pushing it, so
 * every pixel is visited at most once: no recursion, no unbounded loop.
 */
export function matchRegion(
  px: Uint8Array,
  docW: number,
  box: Box,
  ref: RGBA,
  tol: number,
  contiguous: boolean,
  seedX: number,
  seedY: number,
): { mask: Uint8Array; w: number; h: number } {
  const w = Math.max(0, box.x1 - box.x0), h = Math.max(0, box.y1 - box.y0)
  const mask = new Uint8Array(w * h)
  if (w === 0 || h === 0) return { mask, w, h }

  if (!contiguous) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = ((box.y0 + y) * docW + box.x0 + x) * 4
        if (colorDist(px, i, ref) <= tol) mask[y * w + x] = 255
      }
    }
    return { mask, w, h }
  }

  const sx = Math.floor(seedX) - box.x0, sy = Math.floor(seedY) - box.y0
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return { mask, w, h }
  const seed = sy * w + sx
  if (colorDist(px, ((box.y0 + sy) * docW + box.x0 + sx) * 4, ref) > tol) return { mask, w, h }

  const stack = new Int32Array(w * h)
  let top = 0
  stack[top++] = seed
  mask[seed] = 255
  while (top > 0) {
    const at = stack[--top]
    const x = at % w, y = (at - x) / w
    // 4-connected neighbourhood, bounds checked before every push.
    if (x > 0) pushIf(at - 1)
    if (x + 1 < w) pushIf(at + 1)
    if (y > 0) pushIf(at - w)
    if (y + 1 < h) pushIf(at + w)
  }
  return { mask, w, h }

  function pushIf(n: number): void {
    if (mask[n] !== 0) return
    const nx = n % w, ny = (n - nx) / w
    const i = ((box.y0 + ny) * docW + box.x0 + nx) * 4
    if (colorDist(px, i, ref) > tol) {
      mask[n] = 1 // visited and rejected — 1 never reads as coverage
      return
    }
    mask[n] = 255
    stack[top++] = n
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Previews
// ─────────────────────────────────────────────────────────────────────────────

/** Two-pass ring (dark halo + light core) so it reads over any document. */
function brushRing(ctx: ToolContext, x: number, y: number, sizeDoc: number, crosshair: boolean): void {
  const zoom = ctx.zoom
  const toScreen = ctx.docToScreen
  ctx.setPreview(c => {
    const [sx, sy] = toScreen(x, y)
    const r = Math.max(2, (sizeDoc / 2) * zoom)
    c.save()
    c.lineJoin = 'round'
    c.lineCap = 'round'
    const ring = () => { c.beginPath(); c.arc(sx, sy, r, 0, Math.PI * 2) }
    c.strokeStyle = 'rgba(0,0,0,0.75)'; c.lineWidth = 3; ring(); c.stroke()
    c.strokeStyle = 'rgba(255,255,255,0.95)'; c.lineWidth = 1; ring(); c.stroke()
    if (crosshair) {
      // The sampling hot spot of the background eraser: erasing follows THIS pixel.
      const px = Math.round(sx) + 0.5, py = Math.round(sy) + 0.5
      const cross = () => {
        c.beginPath()
        c.moveTo(px - 5, py); c.lineTo(px + 5, py)
        c.moveTo(px, py - 5); c.lineTo(px, py + 5)
      }
      c.strokeStyle = 'rgba(0,0,0,0.75)'; c.lineWidth = 3; cross(); c.stroke()
      c.strokeStyle = 'rgba(255,255,255,0.95)'; c.lineWidth = 1; cross(); c.stroke()
    }
    c.restore()
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 1 — Pencil
// ─────────────────────────────────────────────────────────────────────────────

interface PencilState { st: Stroke; r: number; g: number; b: number }
let pencilState: PencilState | null = null

const pencil: ToolHandler = {
  cursor: 'crosshair',

  onDown(ctx, p) {
    const st = startStroke(ctx, { hard: true })
    if (!st) return
    let [r, g, b] = hexToRgb(ctx.foreground)
    if (paintExtraOptions.pencil.autoErase) {
      // GIMP's auto-erase: a stroke started on the foreground colour draws with
      // the background colour instead, which turns the pencil into its own rubber.
      const under = pixelAt(st.px, st.docW, st.docH, p.x, p.y)
      const near = under !== null && under[3] > 0 &&
        Math.max(Math.abs(under[0] - r), Math.abs(under[1] - g), Math.abs(under[2] - b)) <= 8
      if (near) [r, g, b] = hexToRgb(ctx.background)
    }
    const state: PencilState = { st, r, g, b }
    pencilState = state
    st.dab = (cx, cy) => stampDab(st, cx, cy, null, null, (i, a) => paintPixel(st.px, i, r, g, b, a, st.lockAlpha))
    strokeTo(st, p.x, p.y)
    flush(ctx, st)
    brushRing(ctx, p.x, p.y, ctx.brushSize, false)
  },

  onMove(ctx, p) {
    const state = pencilState
    if (!state) { brushRing(ctx, p.x, p.y, ctx.brushSize, false); return }
    strokeTo(state.st, p.x, p.y)
    flush(ctx, state.st)
    brushRing(ctx, p.x, p.y, ctx.brushSize, false)
  },

  onUp(ctx, p) {
    if (pencilState) {
      strokeTo(pencilState.st, p.x, p.y)
      strokeFinish(pencilState.st)
      endStroke(ctx, pencilState.st, true)
    }
    pencilState = null
    ctx.setPreview(null)
  },

  onCancel(ctx) {
    if (pencilState) endStroke(ctx, pencilState.st, false)
    pencilState = null
    ctx.setPreview(null)
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// 2 — Colour replacement
// ─────────────────────────────────────────────────────────────────────────────

interface ReplaceState {
  st: Stroke
  /** Reference colour: fixed at first contact, or refreshed under the cursor. */
  ref: RGBA
  /** Foreground the replacement paints with. */
  fg: [number, number, number]
  /** Membership of the current dab, sized to its box. */
  mask: Uint8Array | null
  maskBox: Box | null
}
let replaceState: ReplaceState | null = null

/**
 * The colour the replacement writes on one pixel: the foreground colour re-lit
 * with the destination's own luminosity, so every shade, fold and shadow of the
 * repainted area survives the change of hue.
 */
function replacementColor(mode: ReplaceMode, fg: Triple, dr: number, dg: number, db: number): Triple {
  const dst: Triple = [dr, dg, db]
  switch (mode) {
    case 'hue': return setLum(setSat(fg, sat(dst)), luma(dr, dg, db))
    case 'saturation': return setLum(setSat(dst, sat(fg)), luma(dr, dg, db))
    case 'luminosity': return setLum(dst, luma(fg[0], fg[1], fg[2]))
    case 'color':
    default: return setLum(fg, luma(dr, dg, db))
  }
}

/** Membership test shared by the two sampling tools, on the current dab mask. */
function inMask(st: Stroke, box: Box | null, mask: Uint8Array | null, i: number): boolean {
  if (!box || !mask) return false
  const pix = i >> 2
  const x = pix % st.docW, y = (pix - x) / st.docW
  return mask[(y - box.y0) * (box.x1 - box.x0) + (x - box.x0)] === 255
}

function replaceDab(state: ReplaceState, cx: number, cy: number): void {
  const { st } = state
  const o = paintExtraOptions.colorReplace
  const tol = Math.max(0, Math.min(100, o.tolerance)) * 2.55
  stampDab(
    st, cx, cy,
    (box, dx, dy) => {
      if (o.sampling === 'continuous') {
        // Continuous sampling re-reads the colour under the brush centre; "once"
        // keeps the colour picked at first contact for the whole stroke.
        const under = pixelAt(st.px, st.docW, st.docH, dx, dy)
        if (under) state.ref = under
      }
      const region = matchRegion(st.px, st.docW, box, state.ref, tol, o.limits === 'contiguous', dx, dy)
      state.mask = region.mask
      state.maskBox = box
      return true
    },
    i => inMask(st, state.maskBox, state.mask, i),
    (i, a) => {
      const [r, g, b] = replacementColor(o.mode, state.fg, st.px[i], st.px[i + 1], st.px[i + 2])
      // Alpha is deliberately left alone: replacing a colour must not carve into
      // the subject's silhouette, and it makes the tool safe under lockAlpha.
      paintPixel(st.px, i, r, g, b, a, true)
    },
  )
}

const colorReplace: ToolHandler = {
  cursor: 'crosshair',

  onDown(ctx, p) {
    const st = startStroke(ctx, {})
    if (!st) return
    const ref = pixelAt(st.px, st.docW, st.docH, p.x, p.y)
    if (!ref) return
    const state: ReplaceState = { st, ref, fg: hexToRgb(ctx.foreground), mask: null, maskBox: null }
    replaceState = state
    st.dab = (cx, cy) => replaceDab(state, cx, cy)
    strokeTo(st, p.x, p.y)
    flush(ctx, st)
    brushRing(ctx, p.x, p.y, ctx.brushSize, true)
  },

  onMove(ctx, p) {
    const state = replaceState
    if (!state) { brushRing(ctx, p.x, p.y, ctx.brushSize, true); return }
    strokeTo(state.st, p.x, p.y)
    flush(ctx, state.st)
    brushRing(ctx, p.x, p.y, ctx.brushSize, true)
  },

  onUp(ctx, p) {
    if (replaceState) {
      strokeTo(replaceState.st, p.x, p.y)
      strokeFinish(replaceState.st)
      endStroke(ctx, replaceState.st, true)
    }
    replaceState = null
    ctx.setPreview(null)
  },

  onCancel(ctx) {
    if (replaceState) endStroke(ctx, replaceState.st, false)
    replaceState = null
    ctx.setPreview(null)
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// 3 — Mixer brush
// ─────────────────────────────────────────────────────────────────────────────

interface MixerState {
  st: Stroke
  /** Reservoir colour the brush carries. */
  res: [number, number, number]
  /** Accumulator: the paint currently on the bristles (gimpsmudge's Accum). */
  acc: [number, number, number] | null
}
let mixerState: MixerState | null = null

/** Alpha-weighted mean colour of the disc under the brush. */
function sampleDisc(st: Stroke, cx: number, cy: number): [number, number, number] | null {
  const box = dabBox(st, cx, cy)
  let wr = 0, wg = 0, wb = 0, wsum = 0
  for (let y = box.y0; y < box.y1; y++) {
    for (let x = box.x0; x < box.x1; x++) {
      const cov = coverage(st, cx, cy, x + 0.5, y + 0.5)
      if (cov <= 0) continue
      const i = (y * st.docW + x) * 4
      const w = cov * (st.px[i + 3] / 255)
      if (w <= 0) continue
      wr += st.px[i] * w; wg += st.px[i + 1] * w; wb += st.px[i + 2] * w; wsum += w
    }
  }
  if (wsum <= 0) return null
  return [wr / wsum, wg / wsum, wb / wsum]
}

function mixerDab(state: MixerState, cx: number, cy: number): void {
  const { st } = state
  const o = paintExtraOptions.mixerBrush
  const wet = clamp01(o.wet / 100)
  const load = clamp01(o.load / 100)
  const mix = clamp01(o.mix / 100)
  let paint: [number, number, number] = state.res
  stampDab(
    st, cx, cy,
    (_box, dx, dy) => {
      const canvas = sampleDisc(st, dx, dy)
      // gimpsmudge: Accum = rate·Accum + (1-rate)·Canvas, here with "wet" as the
      // share of canvas the bristles take up at each dab.
      if (canvas) {
        state.acc = state.acc
          ? [
              state.acc[0] * (1 - wet) + canvas[0] * wet,
              state.acc[1] * (1 - wet) + canvas[1] * wet,
              state.acc[2] * (1 - wet) + canvas[2] * wet,
            ]
          : [canvas[0], canvas[1], canvas[2]]
      } else if (!state.acc) {
        state.acc = [state.res[0], state.res[1], state.res[2]]
      }
      const acc = state.acc
      // …and Paint = load·Reservoir + (1-load)·Accum — the reservoir is what makes
      // this a mixer brush rather than a smudge.
      paint = [
        state.res[0] * load + acc[0] * (1 - load),
        state.res[1] * load + acc[1] * (1 - load),
        state.res[2] * load + acc[2] * (1 - load),
      ]
      return true
    },
    null,
    (i, a) => {
      // "Mix" is how much of that paint actually replaces the canvas per dab.
      paintPixel(st.px, i, paint[0], paint[1], paint[2], a * mix, st.lockAlpha)
    },
  )
}

const mixerBrush: ToolHandler = {
  cursor: 'crosshair',

  onDown(ctx, p) {
    const st = startStroke(ctx, {})
    if (!st) return
    const o = paintExtraOptions.mixerBrush
    const state: MixerState = { st, res: hexToRgb(o.reservoir ?? ctx.foreground), acc: null }
    mixerState = state
    st.dab = (cx, cy) => mixerDab(state, cx, cy)
    strokeTo(st, p.x, p.y)
    flush(ctx, st)
    brushRing(ctx, p.x, p.y, ctx.brushSize, false)
  },

  onMove(ctx, p) {
    const state = mixerState
    if (!state) { brushRing(ctx, p.x, p.y, ctx.brushSize, false); return }
    strokeTo(state.st, p.x, p.y)
    flush(ctx, state.st)
    brushRing(ctx, p.x, p.y, ctx.brushSize, false)
  },

  onUp(ctx, p) {
    if (mixerState) {
      strokeTo(mixerState.st, p.x, p.y)
      strokeFinish(mixerState.st)
      endStroke(ctx, mixerState.st, true)
    }
    mixerState = null
    ctx.setPreview(null)
  },

  onCancel(ctx) {
    if (mixerState) endStroke(ctx, mixerState.st, false)
    mixerState = null
    ctx.setPreview(null)
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// 4 — Background eraser
// ─────────────────────────────────────────────────────────────────────────────

interface BgEraserState {
  st: Stroke
  ref: RGBA
  fg: [number, number, number]
  mask: Uint8Array | null
  maskBox: Box | null
}
let bgEraserState: BgEraserState | null = null

function bgEraserDab(state: BgEraserState, cx: number, cy: number): void {
  const { st } = state
  const o = paintExtraOptions.bgEraser
  const tol = Math.max(0, Math.min(100, o.tolerance)) * 2.55
  // Protecting the foreground colour uses a fixed, deliberately tight window:
  // the point is to spare the subject, not to open a second tolerance.
  const protectTol = 32
  stampDab(
    st, cx, cy,
    (box, dx, dy) => {
      if (o.sampling === 'continuous') {
        // Sampling follows the CENTRE of the brush, the hot spot the preview shows.
        const under = pixelAt(st.px, st.docW, st.docH, dx, dy)
        if (under) state.ref = under
      }
      const region = matchRegion(st.px, st.docW, box, state.ref, tol, o.limits === 'contiguous', dx, dy)
      state.mask = region.mask
      state.maskBox = box
      return true
    },
    i => {
      if (!inMask(st, state.maskBox, state.mask, i)) return false
      if (o.protectForeground) {
        const d = Math.max(
          Math.abs(st.px[i] - state.fg[0]),
          Math.abs(st.px[i + 1] - state.fg[1]),
          Math.abs(st.px[i + 2] - state.fg[2]),
        )
        if (d <= protectTol) return false
      }
      return true
    },
    (i, a) => erasePixel(st.px, i, a, st.lockAlpha),
  )
}

const bgEraser: ToolHandler = {
  cursor: 'crosshair',

  onDown(ctx, p) {
    const st = startStroke(ctx, {})
    if (!st) return
    // Locked transparency freezes the alpha channel: an eraser has nothing left
    // to do, so it must not open a stroke (nor a history entry) at all.
    if (st.lockAlpha) return
    const ref = pixelAt(st.px, st.docW, st.docH, p.x, p.y)
    if (!ref) return
    const state: BgEraserState = { st, ref, fg: hexToRgb(ctx.foreground), mask: null, maskBox: null }
    bgEraserState = state
    st.dab = (cx, cy) => bgEraserDab(state, cx, cy)
    strokeTo(st, p.x, p.y)
    flush(ctx, st)
    brushRing(ctx, p.x, p.y, ctx.brushSize, true)
  },

  onMove(ctx, p) {
    const state = bgEraserState
    if (!state) { brushRing(ctx, p.x, p.y, ctx.brushSize, true); return }
    strokeTo(state.st, p.x, p.y)
    flush(ctx, state.st)
    brushRing(ctx, p.x, p.y, ctx.brushSize, true)
  },

  onUp(ctx, p) {
    if (bgEraserState) {
      strokeTo(bgEraserState.st, p.x, p.y)
      strokeFinish(bgEraserState.st)
      endStroke(ctx, bgEraserState.st, true)
    }
    bgEraserState = null
    ctx.setPreview(null)
  },

  onCancel(ctx) {
    if (bgEraserState) endStroke(ctx, bgEraserState.st, false)
    bgEraserState = null
    ctx.setPreview(null)
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// 5 — Magic eraser
// ─────────────────────────────────────────────────────────────────────────────

const magicEraser: ToolHandler = {
  cursor: 'crosshair',

  onDown(ctx, p) {
    const target = resolveTarget(ctx)
    if (!target) return
    // Locked transparency would forbid every alpha change: refuse rather than
    // pretend, and never touch the history for a no-op.
    if (target.lockAlpha) return
    const docW = ctx.docW, docH = ctx.docH
    if (docW <= 0 || docH <= 0 || target.px.length < docW * docH * 4) return
    const px = target.px
    const ref = pixelAt(px, docW, docH, p.x, p.y)
    if (!ref) return

    const o = paintExtraOptions.magicEraser
    const tol = Math.max(0, Math.min(255, o.tolerance))
    const strength = clamp01(o.opacity / 100)
    if (strength <= 0) return
    const full = { x0: 0, y0: 0, x1: docW, y1: docH }
    const { mask } = matchRegion(px, docW, full, ref, tol, o.contiguous, p.x, p.y)

    // Touched rectangle, computed BEFORE anything is written so the history entry
    // is registered ahead of the first pixel change.
    let box: Box | null = null
    for (let y = 0; y < docH; y++) {
      const row = y * docW
      for (let x = 0; x < docW; x++) {
        if (mask[row + x] !== 255) continue
        box = growBox(box, x, y, x + 1, y + 1)
      }
    }
    if (!box) return
    const sel = ctx.selection
    const snapshot = px.slice()
    ctx.pushUndoRect(target.id, snapshot, box)

    // Soft edge: membership fades over the last quarter of the tolerance window,
    // which is what keeps a magic erase from leaving a staircase behind.
    const ramp = o.antialias ? Math.max(1, tol * 0.25) : 0
    for (let y = box.y0; y < box.y1; y++) {
      for (let x = box.x0; x < box.x1; x++) {
        const pix = y * docW + x
        if (mask[pix] !== 255) continue
        const i = pix * 4
        let a = strength
        if (ramp > 0) {
          const d = colorDist(px, i, ref)
          a *= clamp01((tol - d) / ramp)
        }
        if (sel) a *= sel[pix] / 255
        erasePixel(px, i, a, false)
      }
    }

    const w = box.x1 - box.x0, h = box.y1 - box.y0
    const out = new Uint8Array(w * h * 4)
    for (let row = 0; row < h; row++) {
      const so = ((box.y0 + row) * docW + box.x0) * 4
      out.set(px.subarray(so, so + w * 4), row * w * 4)
    }
    ctx.writeTexRect(target.id, box.x0, box.y0, w, h, out)
    ctx.invalidate()
    ctx.setPreview(null)
  },

  onCancel(ctx) {
    ctx.setPreview(null)
  },
}

// ─────────────────────────────────────────────────────────────────────────────

registerTool('pencil', pencil)
registerTool('color-replace', colorReplace)
registerTool('mixer-brush', mixerBrush)
registerTool('bg-eraser', bgEraser)
registerTool('magic-eraser', magicEraser)

/**
 * Drops every in-flight stroke without touching the document. The editor never
 * needs it (each tool cleans up on up/cancel); it is the safety valve for the
 * test bench and for a hard reset of the page.
 */
export function __resetStrokes(): void {
  pencilState = null
  replaceState = null
  mixerState = null
  bgEraserState = null
}

