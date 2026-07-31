// Advanced selection tools: single row, single column, polygonal lasso,
// magnetic lasso, quick select and object select.
//
// ─── Attribution ────────────────────────────────────────────────────────────
// Two of the algorithms below are re-implementations, in TypeScript, of code
// from GIMP (Copyright (C) 1995-2025 Spencer Kimball, Peter Mattis and the GIMP
// developers), released under the GNU General Public License version 3 or
// later:
//
//   * the magnetic lasso ports GIMP's "Intelligent Scissors"
//       app/tools/gimpiscissorstool.c          (cost model, link cost, snapping)
//       app/tools/gimptilehandleriscissors.c   (blur + Sobel gradient/cost map)
//     including its OMEGA_G / OMEGA_D weighting, its diagonal weight table, its
//     direction-value table and its "gradient becomes cost through 255 - g" rule.
//     The dynamic-programming sweep of `find_optimal_path()` is replaced by a
//     Dijkstra search over the same cost function — same result, simpler to keep
//     correct in a single-threaded browser.
//
//   * quick select ports the region-growing core of GIMP's bucket fill
//       app/core/gimppickable-contiguous-region.cc
//     (`pixel_difference()`, including the antialiasing ramp, and the seeded
//     contiguous region walk), applied under a brush disc instead of a click.
//
// Kubuno is licensed AGPLv3, which carries the GPLv3 obligations forward; the
// derivation is acknowledged here as the licence requires.
//
// ─── Scope ──────────────────────────────────────────────────────────────────
// Nothing here touches layer pixels: these tools only ever produce a selection
// mask and hand it to `ctx.combineSelection()`, so they push no pixel undo
// entry. Every gesture honours the Photoshop combine modifiers through
// `ctx.selectModeFor()`.
import { registerTool } from './registry'
import type { SelectMode, ToolContext, ToolHandler, ToolPointer } from './types'

// ─────────────────────────────────────────────────────────────────────────────
// Shared types & small helpers
// ─────────────────────────────────────────────────────────────────────────────

interface Pt { x: number; y: number }

interface Box { x0: number; y0: number; x1: number; y1: number }   // x1/y1 exclusive

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

/** Document-space box of a tool gesture, clamped and integer, x1/y1 exclusive. */
function clampBox(x0: number, y0: number, x1: number, y1: number, w: number, h: number): Box {
  return {
    x0: clamp(Math.floor(Math.min(x0, x1)), 0, w),
    y0: clamp(Math.floor(Math.min(y0, y1)), 0, h),
    x1: clamp(Math.ceil(Math.max(x0, x1)), 0, w),
    y1: clamp(Math.ceil(Math.max(y0, y1)), 0, h),
  }
}

/**
 * Pixels the automatic tools sample. The active layer when it has a texture,
 * else the topmost visible raster layer that does — a tool must degrade rather
 * than throw when the user is sitting on a group or an adjustment layer.
 */
function sampleSource(ctx: ToolContext): Uint8Array | null {
  const active = ctx.activeId ? ctx.readTex(ctx.activeId) : null
  if (active) return active
  const stack = [...ctx.layers]
  while (stack.length > 0) {
    const layer = stack.shift()
    if (!layer) break
    if (layer.children && layer.children.length > 0) { stack.unshift(...layer.children); continue }
    if (!layer.visible) continue
    const px = ctx.readTex(layer.id)
    if (px) return px
  }
  return null
}

/** Screen-space distance between a document point and a pointer sample. */
function screenDist(ctx: ToolContext, a: Pt, p: ToolPointer): number {
  const [ax, ay] = ctx.docToScreen(a.x, a.y)
  return Math.hypot(ax - p.sx, ay - p.sy)
}

/** True when the mask holds at least one non-zero byte. */
function maskIsEmpty(mask: Uint8Array): boolean {
  for (let i = 0; i < mask.length; i++) if (mask[i] !== 0) return false
  return true
}

/**
 * Hands the mask to the editor, or clears the selection when the gesture
 * produced nothing at all in `replace` mode (an empty add/subtract must leave
 * the previous selection alone).
 */
function commitMask(ctx: ToolContext, mask: Uint8Array, mode: SelectMode): void {
  if (maskIsEmpty(mask)) {
    if (mode === 'replace') ctx.setSelection(null)
    return
  }
  ctx.combineSelection(mask, mode)
}

// ─────────────────────────────────────────────────────────────────────────────
// Overlay helpers
//
// The preview callback receives a context already scaled to CSS pixels, so a
// document-space overlay needs the view transform. Three probe points give the
// full affine matrix (zoom, pan AND view rotation) without the tool ever seeing
// the editor's view state.
// ─────────────────────────────────────────────────────────────────────────────

/** Applies the doc→screen affine on top of the overlay's own DPR transform. */
function withDocTransform(ctx: ToolContext, g: CanvasRenderingContext2D, draw: () => void): void {
  const [ox, oy] = ctx.docToScreen(0, 0)
  const [ax, ay] = ctx.docToScreen(1, 0)
  const [bx, by] = ctx.docToScreen(0, 1)
  g.save()
  g.transform(ax - ox, ay - oy, bx - ox, by - oy, ox, oy)
  draw()
  g.restore()
}

interface MaskOverlay { canvas: HTMLCanvasElement; g2d: CanvasRenderingContext2D }

/** Offscreen tint canvas for live mask previews; null outside a DOM (tests). */
function createMaskOverlay(w: number, h: number): MaskOverlay | null {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const g2d = canvas.getContext('2d')
  if (!g2d) return null
  return { canvas, g2d }
}

/** Repaints `box` of the tint canvas from the mask (same blue as the editor). */
function paintMaskBox(ov: MaskOverlay, mask: Uint8Array, w: number, box: Box): void {
  const bw = box.x1 - box.x0
  const bh = box.y1 - box.y0
  if (bw <= 0 || bh <= 0) return
  const img = ov.g2d.createImageData(bw, bh)
  const d = img.data
  for (let y = 0; y < bh; y++) {
    const src = (box.y0 + y) * w + box.x0
    const dst = y * bw * 4
    for (let x = 0; x < bw; x++) {
      const v = mask[src + x]
      const o = dst + x * 4
      d[o] = 90; d[o + 1] = 160; d[o + 2] = 255
      d[o + 3] = (v * 150) / 255
    }
  }
  ov.g2d.putImageData(img, box.x0, box.y0)
}

/** Dashed polyline preview shared by both lassos. */
function strokePreviewPath(ctx: ToolContext, g: CanvasRenderingContext2D, pts: Pt[], close: boolean): void {
  if (pts.length === 0) return
  g.beginPath()
  for (let i = 0; i < pts.length; i++) {
    const [sx, sy] = ctx.docToScreen(pts[i].x, pts[i].y)
    if (i === 0) g.moveTo(sx, sy)
    else g.lineTo(sx, sy)
  }
  if (close) g.closePath()
  g.lineWidth = 1
  g.setLineDash([])
  g.strokeStyle = 'rgba(0,0,0,0.65)'
  g.stroke()
  g.setLineDash([4, 3])
  g.strokeStyle = 'rgba(120,190,255,0.95)'
  g.stroke()
  g.setLineDash([])
}

/** Small square handle drawn at a lasso vertex / magnetic anchor. */
function drawAnchor(ctx: ToolContext, g: CanvasRenderingContext2D, p: Pt, first: boolean): void {
  const [sx, sy] = ctx.docToScreen(p.x, p.y)
  const r = first ? 4 : 2.5
  g.beginPath()
  g.rect(Math.round(sx) - r, Math.round(sy) - r, r * 2, r * 2)
  g.fillStyle = first ? 'rgba(120,190,255,0.95)' : 'rgba(255,255,255,0.95)'
  g.fill()
  g.lineWidth = 1
  g.strokeStyle = 'rgba(0,0,0,0.75)'
  g.stroke()
}

// ─────────────────────────────────────────────────────────────────────────────
// Polygon rasteriser
//
// Even-odd scanline fill with 4 sub-scanlines per row and exact horizontal
// coverage, so a lasso lands soft (graded) edges instead of a staircase. A
// pixel fully inside still gets exactly 255, which keeps the pixel counts of
// axis-aligned shapes exact.
// ─────────────────────────────────────────────────────────────────────────────

const SUB_SCANLINES = 4

function addSpan(cov: Float32Array, xa: number, xb: number, w: number, weight: number): void {
  const a = Math.max(0, xa)
  const b = Math.min(w, xb)
  if (b <= a) return
  const ia = Math.floor(a)
  const ib = Math.min(w - 1, Math.ceil(b) - 1)
  if (ia === ib) { cov[ia] += (b - a) * weight; return }
  cov[ia] += (ia + 1 - a) * weight
  for (let x = ia + 1; x < ib; x++) cov[x] += weight
  cov[ib] += (b - ib) * weight
}

/** Rasterises a closed polygon (implicit last→first edge) into a new mask. */
export function rasterisePolygon(pts: Pt[], w: number, h: number): Uint8Array {
  const mask = new Uint8Array(w * h)
  const n = pts.length
  if (n < 3 || w <= 0 || h <= 0) return mask

  let minY = Infinity
  let maxY = -Infinity
  for (const p of pts) {
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  const y0 = clamp(Math.floor(minY), 0, h - 1)
  const y1 = clamp(Math.ceil(maxY), 0, h - 1)

  const cov = new Float32Array(w)
  const xs: number[] = []
  const weight = 1 / SUB_SCANLINES

  for (let y = y0; y <= y1; y++) {
    cov.fill(0)
    let touched = false
    for (let s = 0; s < SUB_SCANLINES; s++) {
      const sy = y + (s + 0.5) / SUB_SCANLINES
      xs.length = 0
      for (let i = 0; i < n; i++) {
        const a = pts[i]
        const b = pts[(i + 1) % n]
        if ((a.y <= sy && b.y > sy) || (b.y <= sy && a.y > sy)) {
          const t = (sy - a.y) / (b.y - a.y)
          xs.push(a.x + t * (b.x - a.x))
        }
      }
      if (xs.length < 2) continue
      xs.sort((p, q) => p - q)
      for (let k = 0; k + 1 < xs.length; k += 2) { addSpan(cov, xs[k], xs[k + 1], w, weight); touched = true }
    }
    if (!touched) continue
    const row = y * w
    for (let x = 0; x < w; x++) {
      const v = cov[x]
      if (v <= 0) continue
      mask[row + x] = v >= 1 ? 255 : Math.round(v * 255)
    }
  }
  return mask
}

// ─────────────────────────────────────────────────────────────────────────────
// Cost map — port of GIMP's gimptilehandleriscissors.c
//
// 3×3 smoothing, then a Sobel pair; per pixel the strongest response across the
// four channels wins (GIMP does the same over R'G'B'A). Byte 0 is the gradient
// magnitude, byte 1 the edge direction (255 = "too weak to have a direction").
// GIMP computes this lazily per tile; we build it once per gesture over the
// whole document, which is simpler and fast enough for editable sizes.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_GRADIENT = 179.606          // sqrt(127² + 127²), GIMP's normaliser
const MIN_GRADIENT = 63               // below this a pixel is directionless

export interface GradientMap {
  grad: Uint8Array
  dir: Uint8Array
  w: number
  h: number
  /** Lazy maps compute the tiles covering `box` before it is read. */
  ensure?(box: Box): void
}

/** Blur + Sobel cost map of `box` (document coordinates, x1/y1 exclusive). */
export function buildGradientMap(px: Uint8Array, docW: number, docH: number, box: Box): GradientMap {
  const w = Math.max(0, box.x1 - box.x0)
  const h = Math.max(0, box.y1 - box.y0)
  const grad = new Uint8Array(w * h)
  const dir = new Uint8Array(w * h)
  if (w === 0 || h === 0) return { grad, dir, w, h }
  dir.fill(255)

  // Source sample, clamped to the document so the box borders read real pixels.
  const at = (x: number, y: number, c: number): number =>
    px[(clamp(y, 0, docH - 1) * docW + clamp(x, 0, docW - 1)) * 4 + c]

  // Pass 1 — GIMP's blur_32 kernel: centre 24, neighbours 1, divisor 32.
  // The interior takes a branch-free path with plain index arithmetic; only the
  // rows and columns that need document clamping go through `at()`.
  const blur = new Uint8Array(w * h * 4)
  const rowStride = docW * 4
  for (let y = 0; y < h; y++) {
    const dy = box.y0 + y
    const fastRow = dy >= 1 && dy < docH - 1
    for (let x = 0; x < w; x++) {
      const dx = box.x0 + x
      const o = (y * w + x) * 4
      if (fastRow && dx >= 1 && dx < docW - 1) {
        const p = (dy * docW + dx) * 4
        for (let c = 0; c < 4; c++) {
          const i = p + c
          const sum =
            px[i - rowStride - 4] + px[i - rowStride] + px[i - rowStride + 4] +
            px[i - 4] + px[i] * 24 + px[i + 4] +
            px[i + rowStride - 4] + px[i + rowStride] + px[i + rowStride + 4]
          blur[o + c] = (sum + 16) >> 5
        }
        continue
      }
      for (let c = 0; c < 4; c++) {
        const sum =
          at(dx - 1, dy - 1, c) + at(dx, dy - 1, c) + at(dx + 1, dy - 1, c) +
          at(dx - 1, dy, c) + at(dx, dy, c) * 24 + at(dx + 1, dy, c) +
          at(dx - 1, dy + 1, c) + at(dx, dy + 1, c) + at(dx + 1, dy + 1, c)
        blur[o + c] = clamp(Math.round(sum / 32), 0, 255)
      }
    }
  }

  // Pass 2 — Sobel pair, strongest channel wins, u8-clamped exactly like GIMP
  // (its convolution stores the derivative in a byte around 128). Only interior
  // pixels are evaluated, so every tap is in range: no clamping needed.
  const bStride = w * 4
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) { grad[i] = 0; dir[i] = 255; continue }
      let hmax = 0
      let vmax = 0
      const p = i * 4
      for (let c = 0; c < 4; c++) {
        const k = p + c
        const tl = blur[k - bStride - 4], tc = blur[k - bStride], tr = blur[k - bStride + 4]
        const ml = blur[k - 4], mrr = blur[k + 4]
        const bl = blur[k + bStride - 4], bc = blur[k + bStride], br = blur[k + bStride + 4]
        const hv = tl - tr + 2 * (ml - mrr) + bl - br
        const vv = tl + 2 * tc + tr - (bl + 2 * bc + br)
        const hc = hv < -128 ? -128 : hv > 127 ? 127 : hv
        const vc = vv < -128 ? -128 : vv > 127 ? 127 : vv
        if (Math.abs(hc) > Math.abs(hmax)) hmax = hc
        if (Math.abs(vc) > Math.abs(vmax)) vmax = vc
      }
      const g = Math.sqrt(hmax * hmax + vmax * vmax)
      grad[i] = clamp(Math.round((g * 255) / MAX_GRADIENT), 0, 255)
      if (g > MIN_GRADIENT) {
        const angle = hmax === 0 ? (vmax > 0 ? Math.PI / 2 : -Math.PI / 2) : Math.atan(vmax / hmax)
        dir[i] = clamp(Math.round((254 * (angle + Math.PI / 2)) / Math.PI), 0, 254)
      } else {
        dir[i] = 255
      }
    }
  }
  return { grad, dir, w, h }
}

/**
 * Lazily-built document-wide cost map.
 *
 * GIMP never computes the whole map either: its `GimpTileHandlerIscissors`
 * validates tiles on demand as the wire visits them. Same idea here — building
 * a 3 MP map up front costs seconds, while the handful of 128 px tiles a
 * gesture actually walks costs milliseconds. Tiles are computed with a two
 * pixel margin that is then discarded, so a tile seam never shows up as a fake
 * zero-gradient line.
 */
export class LazyCostMap implements GradientMap {
  readonly grad: Uint8Array
  readonly dir: Uint8Array
  readonly w: number
  readonly h: number
  private readonly px: Uint8Array
  private readonly tile: number
  private readonly tilesX: number
  private readonly ready: Uint8Array

  constructor(px: Uint8Array, w: number, h: number, tile = 128) {
    this.px = px
    this.w = w
    this.h = h
    this.tile = tile
    this.grad = new Uint8Array(w * h)
    this.dir = new Uint8Array(w * h).fill(255)
    this.tilesX = Math.ceil(w / tile)
    this.ready = new Uint8Array(this.tilesX * Math.ceil(h / tile))
  }

  ensure(box: Box): void {
    const t = this.tile
    const tx0 = clamp(Math.floor(box.x0 / t), 0, this.tilesX - 1)
    const tx1 = clamp(Math.floor((box.x1 - 1) / t), 0, this.tilesX - 1)
    const tilesY = Math.ceil(this.h / t)
    const ty0 = clamp(Math.floor(box.y0 / t), 0, tilesY - 1)
    const ty1 = clamp(Math.floor((box.y1 - 1) / t), 0, tilesY - 1)
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const slot = ty * this.tilesX + tx
        if (this.ready[slot]) continue
        this.ready[slot] = 1
        this.build(tx * t, ty * t, Math.min((tx + 1) * t, this.w), Math.min((ty + 1) * t, this.h))
      }
    }
  }

  private build(x0: number, y0: number, x1: number, y1: number): void {
    const m = 2
    const ex0 = clamp(x0 - m, 0, this.w)
    const ey0 = clamp(y0 - m, 0, this.h)
    const ex1 = clamp(x1 + m, 0, this.w)
    const ey1 = clamp(y1 + m, 0, this.h)
    const sub = buildGradientMap(this.px, this.w, this.h, { x0: ex0, y0: ey0, x1: ex1, y1: ey1 })
    for (let y = y0; y < y1; y++) {
      const src = (y - ey0) * sub.w + (x0 - ex0)
      const dst = y * this.w + x0
      for (let x = 0; x < x1 - x0; x++) {
        this.grad[dst + x] = sub.grad[src + x]
        this.dir[dst + x] = sub.dir[src + x]
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Least-cost path — port of gimpiscissorstool.c's cost model
// ─────────────────────────────────────────────────────────────────────────────

const OMEGA_D = 0.2
const OMEGA_G = 0.8
const EXTEND_BY = 0.2
const FIXED = 5
/** Above this many pixels in its search box, a segment falls back to a straight line. */
const MAX_PATH_PIXELS = 240_000

const DIAGONAL_WEIGHT = new Float64Array(256)
const DIRECTION_VALUE: Int32Array[] = []
for (let i = 0; i < 256; i++) {
  DIAGONAL_WEIGHT[i] = i * Math.SQRT2
  const row = new Int32Array(4)
  row[0] = (127 - Math.abs(127 - i)) * 2
  row[1] = Math.abs(127 - i) * 2
  row[2] = Math.abs(191 - i) * 2
  row[3] = Math.abs(63 - i) * 2
  DIRECTION_VALUE.push(row)
}
// 255 marks a directionless pixel: worst cost in every direction.
DIRECTION_VALUE[255].fill(255)

/** GIMP's link index: 0/1 axis-aligned, 2/3 diagonal. */
function linkIndex(dx: number, dy: number): number {
  if (dy === 0) return 0
  if (dx === 0) return 1
  return dx * dy < 0 ? 2 : 3
}

/** Cost of stepping from pixel `a` to neighbour `b` (GIMP `calculate_link`). */
function linkCost(map: GradientMap, ai: number, bi: number, link: number): number {
  // A strong gradient must be cheap to walk on: cost = 255 - gradient.
  const g1 = 255 - map.grad[ai]
  let value = (link > 1 ? DIAGONAL_WEIGHT[g1] : g1) * OMEGA_G
  const d1 = map.dir[ai]
  const d2 = map.dir[bi]
  value += (DIRECTION_VALUE[d1][link] + DIRECTION_VALUE[d2][link]) * OMEGA_D
  return value
}

/** Growable binary min-heap over (cost, node) pairs. */
class MinHeap {
  private cost = new Float64Array(64)
  private node = new Int32Array(64)
  private size = 0

  push(cost: number, node: number): void {
    if (this.size === this.cost.length) {
      const c = new Float64Array(this.size * 2)
      const n = new Int32Array(this.size * 2)
      c.set(this.cost); n.set(this.node)
      this.cost = c; this.node = n
    }
    let i = this.size++
    this.cost[i] = cost
    this.node[i] = node
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (this.cost[parent] <= this.cost[i]) break
      this.swap(parent, i)
      i = parent
    }
  }

  pop(): number {
    if (this.size === 0) return -1
    const top = this.node[0]
    this.size--
    if (this.size > 0) {
      this.cost[0] = this.cost[this.size]
      this.node[0] = this.node[this.size]
      let i = 0
      for (;;) {
        const l = i * 2 + 1
        const r = l + 1
        let m = i
        if (l < this.size && this.cost[l] < this.cost[m]) m = l
        if (r < this.size && this.cost[r] < this.cost[m]) m = r
        if (m === i) break
        this.swap(m, i)
        i = m
      }
    }
    return top
  }

  get length(): number { return this.size }

  private swap(a: number, b: number): void {
    const c = this.cost[a]; this.cost[a] = this.cost[b]; this.cost[b] = c
    const n = this.node[a]; this.node[a] = this.node[b]; this.node[b] = n
  }
}

/**
 * Cheapest path from `from` to `to` across the cost map, as pixel centres.
 *
 * GIMP runs a dynamic-programming sweep over the segment's bounding box; the
 * cost function is identical here but the search is a plain Dijkstra, which is
 * the textbook formulation of the same "live wire" problem and is much easier
 * to keep correct. The box is expanded exactly like GIMP's (20 % + 5 px) so the
 * wire may bulge outside the two end points and follow a real edge.
 */
export function leastCostPath(map: GradientMap, from: Pt, to: Pt): Pt[] {
  const w = map.w
  const h = map.h
  const xs = clamp(Math.round(from.x), 0, w - 1)
  const ys = clamp(Math.round(from.y), 0, h - 1)
  const xe = clamp(Math.round(to.x), 0, w - 1)
  const ye = clamp(Math.round(to.y), 0, h - 1)
  if (w <= 0 || h <= 0) return [{ x: xs, y: ys }, { x: xe, y: ye }]
  if (xs === xe && ys === ye) return [{ x: xs, y: ys }]

  const ex = Math.round((Math.abs(xe - xs) + 1) * EXTEND_BY) + FIXED
  const ey = Math.round((Math.abs(ye - ys) + 1) * EXTEND_BY) + FIXED
  const bx0 = clamp(Math.min(xs, xe) - ex, 0, w - 1)
  const by0 = clamp(Math.min(ys, ye) - ey, 0, h - 1)
  const bx1 = clamp(Math.max(xs, xe) + ex + 1, 1, w)
  const by1 = clamp(Math.max(ys, ye) + ey + 1, 1, h)
  const bw = bx1 - bx0
  const bh = by1 - by0
  // Straight fallback rather than a multi-second freeze on a huge segment.
  if (bw * bh > MAX_PATH_PIXELS) return [{ x: xs, y: ys }, { x: xe, y: ye }]
  map.ensure?.({ x0: bx0, y0: by0, x1: bx1, y1: by1 })

  const total = bw * bh
  const dist = new Float64Array(total).fill(Infinity)
  const prev = new Int32Array(total).fill(-1)
  const done = new Uint8Array(total)
  const heap = new MinHeap()

  const startLocal = (ys - by0) * bw + (xs - bx0)
  const goalLocal = (ye - by0) * bw + (xe - bx0)
  dist[startLocal] = 0
  heap.push(0, startLocal)

  while (heap.length > 0) {
    const cur = heap.pop()
    if (cur < 0) break
    if (done[cur]) continue
    done[cur] = 1
    if (cur === goalLocal) break
    const lx = cur % bw
    const ly = (cur - lx) / bw
    const gx = bx0 + lx
    const gy = by0 + ly
    const gi = gy * w + gx
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue
        const nx = lx + dx
        const ny = ly + dy
        if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue
        const nLocal = ny * bw + nx
        if (done[nLocal]) continue
        const nGlobal = (gy + dy) * w + (gx + dx)
        const nd = dist[cur] + linkCost(map, gi, nGlobal, linkIndex(dx, dy))
        if (nd < dist[nLocal]) {
          dist[nLocal] = nd
          prev[nLocal] = cur
          heap.push(nd, nLocal)
        }
      }
    }
  }

  if (!done[goalLocal] && prev[goalLocal] < 0) return [{ x: xs, y: ys }, { x: xe, y: ye }]
  const out: Pt[] = []
  let node = goalLocal
  let guard = total + 2
  while (node >= 0 && guard-- > 0) {
    const lx = node % bw
    const ly = (node - lx) / bw
    out.push({ x: bx0 + lx, y: by0 + ly })
    if (node === startLocal) break
    node = prev[node]
  }
  out.reverse()
  return out
}

/**
 * Nudges a point onto the strongest edge within `radius`, weighting candidates
 * by 1 / (1 + distance) — GIMP's `find_max_gradient()` and its distance table.
 */
export function snapToEdge(map: GradientMap, x: number, y: number, radius: number): Pt {
  const cx = clamp(Math.round(x), 0, map.w - 1)
  const cy = clamp(Math.round(y), 0, map.h - 1)
  const r = Math.max(1, Math.round(radius))
  const x0 = clamp(cx - r, 0, map.w - 1)
  const y0 = clamp(cy - r, 0, map.h - 1)
  const x1 = clamp(cx + r, 0, map.w - 1)
  const y1 = clamp(cy + r, 0, map.h - 1)
  map.ensure?.({ x0, y0, x1: x1 + 1, y1: y1 + 1 })
  let best = 0
  let bx = cx
  let by = cy
  for (let py = y0; py <= y1; py++) {
    for (let pxx = x0; pxx <= x1; pxx++) {
      const g = map.grad[py * map.w + pxx] / (1 + Math.hypot(pxx - cx, py - cy))
      if (g > best) { best = g; bx = pxx; by = py }
    }
  }
  return { x: bx, y: by }
}

// ─────────────────────────────────────────────────────────────────────────────
// Contiguous region growing — port of gimppickable-contiguous-region.cc
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GIMP's `pixel_difference()` with the composite criterion: the largest channel
 * distance, turned into a coverage through the antialiasing ramp so a region
 * fades out over the last half-threshold instead of ending on a hard step.
 * Returns 0..1. Fully transparent pixels never match (GIMP does the same unless
 * "select transparent" is on).
 */
function pixelCoverage(px: Uint8Array, i: number, ref: Int32Array, threshold: number): number {
  if (px[i + 3] === 0) return 0
  let max = Math.abs(px[i] - ref[0])
  const dg = Math.abs(px[i + 1] - ref[1])
  if (dg > max) max = dg
  const db = Math.abs(px[i + 2] - ref[2])
  if (db > max) max = db
  const da = Math.abs(px[i + 3] - ref[3])
  if (da > max) max = da
  if (threshold <= 0) return max === 0 ? 1 : 0
  const aa = 1.5 - max / threshold
  if (aa <= 0) return 0
  if (aa < 0.5) return aa * 2
  return 1
}

/**
 * Four-connected region growing from `seeds`, bounded by `box` and by
 * `maxPixels`. Uses an explicit stack — no recursion, so a full-page region can
 * never blow the JS stack. Writes graded coverage into `out` (document-sized)
 * and returns how many pixels it added.
 */
export function growRegion(
  px: Uint8Array, w: number, h: number,
  seeds: number[], ref: Int32Array, threshold: number,
  box: Box, out: Uint8Array, maxPixels: number,
): number {
  const bw = box.x1 - box.x0
  const bh = box.y1 - box.y0
  if (bw <= 0 || bh <= 0 || seeds.length === 0) return 0
  const seen = new Uint8Array(bw * bh)
  const stack: number[] = []
  for (const s of seeds) {
    const x = s % w
    const y = (s - x) / w
    if (x < box.x0 || y < box.y0 || x >= box.x1 || y >= box.y1) continue
    const local = (y - box.y0) * bw + (x - box.x0)
    if (seen[local]) continue
    seen[local] = 1
    stack.push(local)
  }
  let added = 0
  let visited = 0
  while (stack.length > 0) {
    const local = stack.pop()
    if (local === undefined) break
    if (++visited > maxPixels) break
    const lx = local % bw
    const ly = (local - lx) / bw
    const gx = box.x0 + lx
    const gy = box.y0 + ly
    const gi = gy * w + gx
    const cov = pixelCoverage(px, gi * 4, ref, threshold)
    if (cov <= 0) continue
    const v = cov >= 1 ? 255 : Math.round(cov * 255)
    if (v > out[gi]) out[gi] = v
    added++
    if (cov < 1) continue      // soft rim: do not grow past it
    if (lx > 0 && !seen[local - 1]) { seen[local - 1] = 1; stack.push(local - 1) }
    if (lx + 1 < bw && !seen[local + 1]) { seen[local + 1] = 1; stack.push(local + 1) }
    if (ly > 0 && !seen[local - bw]) { seen[local - bw] = 1; stack.push(local - bw) }
    if (ly + 1 < bh && !seen[local + bw]) { seen[local + bw] = 1; stack.push(local + bw) }
  }
  return added
}

// ─────────────────────────────────────────────────────────────────────────────
// Keyboard fallback
//
// `ToolHandler` exposes `onCancel` / `onCommit` / `onDoubleClick`, but the
// editor only dispatches pointer events today. So a path in progress listens for
// Backspace (drop last vertex), Enter (close) and Escape (abort) itself. The
// listener exists only while a path is open and every entry point is idempotent,
// so nothing breaks the day the shell wires those callbacks up.
// ─────────────────────────────────────────────────────────────────────────────

interface KeyActions { backspace(): void; commit(): void; cancel(): void }

let keyActions: KeyActions | null = null
let keyListener: ((e: KeyboardEvent) => void) | null = null

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null
  if (!el || typeof el.tagName !== 'string') return false
  const tag = el.tagName.toUpperCase()
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true
}

function bindKeys(actions: KeyActions): void {
  keyActions = actions
  if (keyListener || typeof window === 'undefined') return
  keyListener = (e: KeyboardEvent) => {
    const a = keyActions
    if (!a || isTypingTarget(e.target)) return
    if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); a.backspace() }
    else if (e.key === 'Enter') { e.preventDefault(); a.commit() }
    else if (e.key === 'Escape') { e.preventDefault(); a.cancel() }
  }
  window.addEventListener('keydown', keyListener)
}

function unbindKeys(): void {
  keyActions = null
  if (keyListener && typeof window !== 'undefined') window.removeEventListener('keydown', keyListener)
  keyListener = null
}

// ─────────────────────────────────────────────────────────────────────────────
// 1 & 2 — single row / single column marquee
// ─────────────────────────────────────────────────────────────────────────────

interface BandState { mode: SelectMode; pos: number }

/** One shared implementation; `vertical` picks the column flavour. */
function makeBandTool(vertical: boolean): ToolHandler {
  let state: BandState | null = null

  const bandBox = (ctx: ToolContext, pos: number): Box => vertical
    ? { x0: pos, y0: 0, x1: pos + 1, y1: ctx.docH }
    : { x0: 0, y0: pos, x1: ctx.docW, y1: pos + 1 }

  const preview = (ctx: ToolContext): void => {
    const s = state
    if (!s) { ctx.setPreview(null); return }
    const box = bandBox(ctx, s.pos)
    ctx.setPreview(g => {
      withDocTransform(ctx, g, () => {
        g.fillStyle = 'rgba(90,160,255,0.45)'
        g.fillRect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0)
      })
    })
  }

  const track = (ctx: ToolContext, p: ToolPointer): void => {
    if (!state) return
    const limit = vertical ? ctx.docW : ctx.docH
    state.pos = clamp(Math.floor(vertical ? p.x : p.y), 0, limit - 1)
    ctx.setStatus(`${state.pos}`)
    preview(ctx)
  }

  return {
    cursor: 'crosshair',

    onDown(ctx, p) {
      state = { mode: ctx.selectModeFor(p), pos: 0 }
      track(ctx, p)
    },

    onMove(ctx, p) {
      if (!state) return
      track(ctx, p)
    },

    onUp(ctx, p) {
      const s = state
      state = null
      ctx.setPreview(null)
      ctx.setStatus(null)
      if (!s) return
      const limit = vertical ? ctx.docW : ctx.docH
      const pos = clamp(Math.floor(vertical ? p.x : p.y), 0, limit - 1)
      if (ctx.docW <= 0 || ctx.docH <= 0) return
      // The band is one pixel thick and spans the whole document, exactly like
      // Photoshop's single row / single column marquee.
      const mask = new Uint8Array(ctx.docW * ctx.docH)
      if (vertical) for (let y = 0; y < ctx.docH; y++) mask[y * ctx.docW + pos] = 255
      else mask.fill(255, pos * ctx.docW, (pos + 1) * ctx.docW)
      commitMask(ctx, mask, s.mode)
    },

    onCancel(ctx) {
      state = null
      ctx.setPreview(null)
      ctx.setStatus(null)
    },
  }
}

registerTool('marquee-row', makeBandTool(false))
registerTool('marquee-column', makeBandTool(true))

// ─────────────────────────────────────────────────────────────────────────────
// 3 — polygonal lasso
// ─────────────────────────────────────────────────────────────────────────────

/** Screen-space radius, in px, of the "click the first vertex to close" target. */
const CLOSE_RADIUS_PX = 8

interface PolyState { pts: Pt[]; mode: SelectMode; cursor: Pt }

const polyTool = ((): ToolHandler => {
  let state: PolyState | null = null
  let lastCtx: ToolContext | null = null

  const refresh = (ctx: ToolContext): void => {
    const s = state
    if (!s || s.pts.length === 0) { ctx.setPreview(null); return }
    ctx.setPreview(g => {
      strokePreviewPath(ctx, g, [...s.pts, s.cursor], s.pts.length >= 2)
      for (let i = 0; i < s.pts.length; i++) drawAnchor(ctx, g, s.pts[i], i === 0)
    })
    ctx.setStatus(`${s.pts.length} pts`)
  }

  const reset = (ctx: ToolContext | null): void => {
    state = null
    unbindKeys()
    ctx?.setPreview(null)
    ctx?.setStatus(null)
  }

  const close = (ctx: ToolContext | null): void => {
    const s = state
    if (!ctx || !s) { reset(ctx); return }
    const pts = s.pts
    reset(ctx)
    if (pts.length < 3) return
    commitMask(ctx, rasterisePolygon(pts, ctx.docW, ctx.docH), s.mode)
  }

  return {
    cursor: 'crosshair',

    onDown(ctx, p) {
      lastCtx = ctx
      if (!state) {
        const fresh: PolyState = { mode: ctx.selectModeFor(p), pts: [], cursor: { x: p.x, y: p.y } }
        state = fresh
        bindKeys({
          backspace: () => {
            if (!state) return
            state.pts.pop()
            if (state.pts.length === 0) reset(lastCtx)
            else if (lastCtx) refresh(lastCtx)
          },
          commit: () => close(lastCtx),
          cancel: () => reset(lastCtx),
        })
      }
      const s = state
      if (!s) return
      s.cursor = { x: p.x, y: p.y }
      // Clicking the first vertex closes the polygon (Photoshop behaviour).
      if (s.pts.length >= 3 && screenDist(ctx, s.pts[0], p) <= CLOSE_RADIUS_PX) { close(ctx); return }
      const last = s.pts[s.pts.length - 1]
      if (!last || Math.hypot(last.x - p.x, last.y - p.y) > 0.5) s.pts.push({ x: p.x, y: p.y })
      refresh(ctx)
    },

    onMove(ctx, p) {
      lastCtx = ctx
      if (!state) return
      state.cursor = { x: p.x, y: p.y }
      refresh(ctx)
    },

    onUp(ctx) { lastCtx = ctx },                        // vertices land on down

    onDoubleClick(ctx) { lastCtx = ctx; close(ctx) },

    onCommit(ctx) { lastCtx = ctx; close(ctx) },

    onCancel(ctx) { lastCtx = ctx; reset(ctx) },
  }
})()

registerTool('lasso-poly', polyTool)

// ─────────────────────────────────────────────────────────────────────────────
// 4 — magnetic lasso (GIMP "Intelligent Scissors")
//
// The option bar carries "width", "contrast" and "frequency", but `ToolContext`
// does not (yet) hand tool option VALUES to a handler — so the live tunable is
// the brush size, which maps naturally onto the search width; contrast and
// frequency use the defaults declared in `toolDefs.ts`. The moment the contract
// grows a `values` field these three constants are the only thing to swap.
// ─────────────────────────────────────────────────────────────────────────────

const MAGNETIC_DEFAULT_WIDTH = 10        // px, mirrors `magnetic-width`
const MAGNETIC_DEFAULT_CONTRAST = 10     // %, mirrors `magnetic-contrast`
const MAGNETIC_DEFAULT_FREQUENCY = 57    // mirrors `magnetic-frequency`

interface MagneticState {
  mode: SelectMode
  /** Committed anchors; `segs[i]` is the traced path from anchor i-1 to i. */
  anchors: Pt[]
  segs: Pt[][]
  /** Path from the last anchor to the cursor, recomputed on every move. */
  live: Pt[]
  cursor: Pt
  map: GradientMap | null
  width: number
  /** Distance between two automatic anchors, in document pixels. */
  spacing: number
}

const magneticTool = ((): ToolHandler => {
  let state: MagneticState | null = null
  let lastCtx: ToolContext | null = null

  const fullPath = (s: MagneticState): Pt[] => {
    const pts: Pt[] = []
    for (let i = 0; i < s.anchors.length; i++) {
      if (i === 0) { pts.push(s.anchors[0]); continue }
      const seg = s.segs[i]
      if (seg && seg.length > 0) for (const p of seg) pts.push(p)
      else pts.push(s.anchors[i])
    }
    return pts
  }

  const refresh = (ctx: ToolContext): void => {
    const s = state
    if (!s || s.anchors.length === 0) { ctx.setPreview(null); return }
    const traced = fullPath(s)
    ctx.setPreview(g => {
      strokePreviewPath(ctx, g, [...traced, ...s.live.slice(1)], s.anchors.length >= 2)
      for (let i = 0; i < s.anchors.length; i++) drawAnchor(ctx, g, s.anchors[i], i === 0)
    })
    ctx.setStatus(`${s.anchors.length} pts`)
  }

  const reset = (ctx: ToolContext | null): void => {
    state = null
    unbindKeys()
    ctx?.setPreview(null)
    ctx?.setStatus(null)
  }

  /** Recomputes the wire from the last anchor to the cursor. */
  const retrace = (s: MagneticState): void => {
    const last = s.anchors[s.anchors.length - 1]
    if (!last) { s.live = []; return }
    if (!s.map) { s.live = [last, s.cursor]; return }
    const target = snapToEdge(s.map, s.cursor.x, s.cursor.y, s.width / 2)
    s.live = leastCostPath(s.map, last, target)
  }

  const close = (ctx: ToolContext | null): void => {
    const s = state
    if (!ctx || !s) { reset(ctx); return }
    const anchors = s.anchors
    if (anchors.length >= 3) {
      // Trace the closing segment back to the first anchor as well.
      const last = anchors[anchors.length - 1]
      const closing = s.map ? leastCostPath(s.map, last, anchors[0]) : [last, anchors[0]]
      const pts = [...fullPath(s), ...closing.slice(1, -1)]
      reset(ctx)
      commitMask(ctx, rasterisePolygon(pts, ctx.docW, ctx.docH), s.mode)
      return
    }
    reset(ctx)
  }

  const addAnchor = (s: MagneticState, at: Pt): void => {
    s.anchors.push(at)
    s.segs.push(s.live.length > 1 ? s.live.slice() : [at])
    s.live = [at]
  }

  return {
    cursor: 'crosshair',

    onDown(ctx, p) {
      lastCtx = ctx
      if (!state) {
        const width = clamp(Math.round(ctx.brushSize > 0 ? ctx.brushSize : MAGNETIC_DEFAULT_WIDTH), 2, 64)
        // Higher "frequency" = anchors closer together (Photoshop's meaning).
        const spacing = clamp(Math.round(120 - MAGNETIC_DEFAULT_FREQUENCY), 8, 120)
        const px = sampleSource(ctx)
        // Lazy: the first click costs nothing, tiles land as the wire needs them.
        const map = px && ctx.docW > 0 && ctx.docH > 0
          ? new LazyCostMap(px, ctx.docW, ctx.docH)
          : null
        const fresh: MagneticState = {
          mode: ctx.selectModeFor(p),
          anchors: [], segs: [], live: [],
          cursor: { x: p.x, y: p.y },
          map, width, spacing,
        }
        state = fresh
        bindKeys({
          backspace: () => {
            const s = state
            if (!s) return
            s.anchors.pop()
            s.segs.pop()
            if (s.anchors.length === 0) { reset(lastCtx); return }
            retrace(s)
            if (lastCtx) refresh(lastCtx)
          },
          commit: () => close(lastCtx),
          cancel: () => reset(lastCtx),
        })
        const first = fresh.map
          ? snapToEdge(fresh.map, p.x, p.y, fresh.width / 2)
          : { x: Math.round(p.x), y: Math.round(p.y) }
        fresh.anchors.push(first)
        fresh.segs.push([first])
        fresh.live = [first]
        refresh(ctx)
        return
      }

      const s = state
      if (!s) return
      s.cursor = { x: p.x, y: p.y }
      if (s.anchors.length >= 3 && screenDist(ctx, s.anchors[0], p) <= CLOSE_RADIUS_PX) { close(ctx); return }
      retrace(s)
      const at = s.live.length > 0 ? s.live[s.live.length - 1] : { x: Math.round(p.x), y: Math.round(p.y) }
      addAnchor(s, at)
      refresh(ctx)
    },

    onMove(ctx, p) {
      lastCtx = ctx
      const s = state
      if (!s) return
      if (Math.abs(s.cursor.x - p.x) < 0.5 && Math.abs(s.cursor.y - p.y) < 0.5) return
      s.cursor = { x: p.x, y: p.y }
      retrace(s)
      // Automatic anchors: the wire is frozen once the cursor has travelled far
      // enough from the last anchor, so an old segment never gets recomputed.
      const last = s.anchors[s.anchors.length - 1]
      if (last && Math.hypot(last.x - s.cursor.x, last.y - s.cursor.y) >= s.spacing) {
        addAnchor(s, s.live.length > 0 ? s.live[s.live.length - 1] : { x: Math.round(p.x), y: Math.round(p.y) })
      }
      refresh(ctx)
    },

    onUp(ctx) { lastCtx = ctx },                        // anchors land on down/move

    onDoubleClick(ctx) { lastCtx = ctx; close(ctx) },

    onCommit(ctx) { lastCtx = ctx; close(ctx) },

    onCancel(ctx) { lastCtx = ctx; reset(ctx) },
  }
})()

registerTool('lasso-magnetic', magneticTool)

// ─────────────────────────────────────────────────────────────────────────────
// 5 — quick select
// ─────────────────────────────────────────────────────────────────────────────

/** Colour distance, 0..255, that still belongs to the painted region. */
const QUICK_BASE_TOLERANCE = 30
/** Region growth stays inside this many brush radii around the dab. */
const QUICK_REACH = 6
/** Hard ceiling on pixels visited per dab — bounds a pathological flood. */
const QUICK_MAX_PIXELS = 600_000

interface QuickState {
  mode: SelectMode
  px: Uint8Array
  acc: Uint8Array
  overlay: MaskOverlay | null
  radius: number
  last: Pt | null
  dirty: Box | null
}

const quickSelectTool = ((): ToolHandler => {
  let state: QuickState | null = null

  const refresh = (ctx: ToolContext): void => {
    const s = state
    if (!s) { ctx.setPreview(null); return }
    const ov = s.overlay
    if (!ov) return
    if (s.dirty) { paintMaskBox(ov, s.acc, ctx.docW, s.dirty); s.dirty = null }
    ctx.setPreview(g => {
      withDocTransform(ctx, g, () => {
        g.imageSmoothingEnabled = false
        g.drawImage(ov.canvas, 0, 0)
      })
    })
  }

  /** One brush dab: seed under the disc, then grow to neighbouring colours. */
  const dab = (ctx: ToolContext, at: Pt): void => {
    const s = state
    if (!s) return
    const w = ctx.docW
    const h = ctx.docH
    const r = s.radius
    const cx = at.x
    const cy = at.y

    // Seeds = the pixels under the brush; reference colour = their mean, so the
    // region follows what the user actually painted over.
    const seeds: number[] = []
    let sr = 0, sg = 0, sb = 0, sa = 0
    const dx0 = clamp(Math.floor(cx - r), 0, w)
    const dy0 = clamp(Math.floor(cy - r), 0, h)
    const dx1 = clamp(Math.ceil(cx + r) + 1, 0, w)
    const dy1 = clamp(Math.ceil(cy + r) + 1, 0, h)
    for (let y = dy0; y < dy1; y++) {
      for (let x = dx0; x < dx1; x++) {
        if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) > r) continue
        const i = y * w + x
        seeds.push(i)
        sr += s.px[i * 4]; sg += s.px[i * 4 + 1]; sb += s.px[i * 4 + 2]; sa += s.px[i * 4 + 3]
      }
    }
    if (seeds.length === 0) return
    const ref = new Int32Array(4)
    ref[0] = Math.round(sr / seeds.length)
    ref[1] = Math.round(sg / seeds.length)
    ref[2] = Math.round(sb / seeds.length)
    ref[3] = Math.round(sa / seeds.length)

    // Local contrast widens the tolerance a little on noisy material.
    let dev = 0
    for (const i of seeds) {
      const o = i * 4
      dev += Math.max(
        Math.abs(s.px[o] - ref[0]),
        Math.abs(s.px[o + 1] - ref[1]),
        Math.abs(s.px[o + 2] - ref[2]),
      )
    }
    dev /= seeds.length
    const threshold = clamp(QUICK_BASE_TOLERANCE + dev, 8, 96)

    const reach = Math.round(r * QUICK_REACH + 24)
    const box = clampBox(cx - reach, cy - reach, cx + reach, cy + reach, w, h)
    growRegion(s.px, w, h, seeds, ref, threshold, box, s.acc, QUICK_MAX_PIXELS)
    s.dirty = s.dirty
      ? { x0: Math.min(s.dirty.x0, box.x0), y0: Math.min(s.dirty.y0, box.y0), x1: Math.max(s.dirty.x1, box.x1), y1: Math.max(s.dirty.y1, box.y1) }
      : box
  }

  /** Dabs along the segment so a fast drag leaves no gap. */
  const stroke = (ctx: ToolContext, to: Pt): void => {
    const s = state
    if (!s) return
    const from = s.last ?? to
    const dist = Math.hypot(to.x - from.x, to.y - from.y)
    const step = Math.max(1, s.radius * 0.75)
    const n = Math.min(256, Math.max(1, Math.ceil(dist / step)))
    for (let i = 1; i <= n; i++) {
      const t = i / n
      dab(ctx, { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t })
    }
    s.last = to
  }

  const finish = (ctx: ToolContext, commit: boolean): void => {
    const s = state
    state = null
    ctx.setPreview(null)
    ctx.setStatus(null)
    if (!s || !commit) return
    commitMask(ctx, s.acc, s.mode)
  }

  return {
    cursor: 'brush-outline',

    onDown(ctx, p) {
      const px = sampleSource(ctx)
      if (!px || ctx.docW <= 0 || ctx.docH <= 0) { state = null; return }
      state = {
        mode: ctx.selectModeFor(p),
        px,
        acc: new Uint8Array(ctx.docW * ctx.docH),
        overlay: createMaskOverlay(ctx.docW, ctx.docH),
        radius: Math.max(1, (ctx.brushSize > 0 ? ctx.brushSize : 30) / 2),
        last: null,
        dirty: null,
      }
      stroke(ctx, { x: p.x, y: p.y })
      refresh(ctx)
    },

    onMove(ctx, p) {
      if (!state) return
      stroke(ctx, { x: p.x, y: p.y })
      refresh(ctx)
    },

    onUp(ctx, p) {
      if (!state) return
      stroke(ctx, { x: p.x, y: p.y })
      finish(ctx, true)
    },

    onCancel(ctx) { finish(ctx, false) },
  }
})()

registerTool('quick-select', quickSelectTool)

// ─────────────────────────────────────────────────────────────────────────────
// 6 — object select
//
// HONEST DISCLAIMER: this is NOT semantic segmentation. There is no model here
// and nothing understands what a "subject" is. What the tool does is classical
// and predictable:
//
//   1. grow a BACKGROUND region inwards from the border ring of the marquee,
//      following colour continuity (GIMP's contiguous-region rule) and stopping
//      wherever the Sobel gradient says an edge crosses;
//   2. everything the background failed to reach is declared the subject, which
//      fills interior holes for free;
//   3. a 3×3 open/close removes speckles and a light blur softens the rim.
//
// It isolates a well-contrasted object on a reasonably uniform background. It
// will happily fail on a cluttered one, and it then falls back to the plain
// rectangle rather than returning nonsense.
// ─────────────────────────────────────────────────────────────────────────────

/** Pixels above this share of the marquee mean "background growth escaped". */
const OBJECT_MAX_SUBJECT_RATIO = 0.985
const OBJECT_MAX_PIXELS = 4_000_000

interface ObjectState { mode: SelectMode; start: Pt; cur: Pt }

/** 3×3 min (erode) or max (dilate) on a local byte mask. */
function morph(src: Uint8Array, w: number, h: number, grow: boolean): Uint8Array {
  const out = new Uint8Array(src.length)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = src[y * w + x]
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy
        if (ny < 0 || ny >= h) continue
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx
          if (nx < 0 || nx >= w) continue
          const s = src[ny * w + nx]
          v = grow ? Math.max(v, s) : Math.min(v, s)
        }
      }
      out[y * w + x] = v
    }
  }
  return out
}

/** 3×3 box blur — turns the binary subject edge into a one-pixel soft rim. */
function soften(src: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(src.length)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0
      let n = 0
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy
        if (ny < 0 || ny >= h) continue
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx
          if (nx < 0 || nx >= w) continue
          sum += src[ny * w + nx]
          n++
        }
      }
      out[y * w + x] = n > 0 ? Math.round(sum / n) : src[y * w + x]
    }
  }
  return out
}

/**
 * Segments `box` into subject / background. Exported for the test bench; the
 * returned mask is document-sized. `null` means "no usable subject found".
 */
export function segmentObject(px: Uint8Array, w: number, h: number, box: Box): Uint8Array | null {
  const bw = box.x1 - box.x0
  const bh = box.y1 - box.y0
  if (bw < 4 || bh < 4 || bw * bh > OBJECT_MAX_PIXELS) return null

  const map = buildGradientMap(px, w, h, box)

  // ── Border statistics: what the background looks like, and how busy it is ──
  const ring: number[] = []
  for (let x = 0; x < bw; x++) { ring.push(x); ring.push((bh - 1) * bw + x) }
  for (let y = 1; y < bh - 1; y++) { ring.push(y * bw); ring.push(y * bw + bw - 1) }

  let mr = 0, mg = 0, mb = 0, mgrad = 0
  for (const local of ring) {
    const lx = local % bw
    const ly = (local - lx) / bw
    const o = ((box.y0 + ly) * w + box.x0 + lx) * 4
    mr += px[o]; mg += px[o + 1]; mb += px[o + 2]
    mgrad += map.grad[local]
  }
  const n = ring.length
  mr /= n; mg /= n; mb /= n; mgrad /= n

  let variance = 0
  for (const local of ring) {
    const lx = local % bw
    const ly = (local - lx) / bw
    const o = ((box.y0 + ly) * w + box.x0 + lx) * 4
    const d = Math.max(Math.abs(px[o] - mr), Math.abs(px[o + 1] - mg), Math.abs(px[o + 2] - mb))
    variance += d * d
  }
  const sigma = Math.sqrt(variance / n)

  // Adaptive thresholds — deliberately generous on colour, strict on edges.
  const globalTol = clamp(3 * sigma + 20, 24, 110)
  const localTol = clamp(sigma + 10, 10, 48)
  const gradTol = clamp(mgrad * 2 + 30, 30, 170)

  // ── Background flood from the border ring (explicit stack, bounded) ───────
  const bg = new Uint8Array(bw * bh)
  const stack: number[] = []
  for (const local of ring) {
    if (bg[local]) continue
    bg[local] = 1
    stack.push(local)
  }
  const colourAt = (local: number, c: number): number => {
    const lx = local % bw
    const ly = (local - lx) / bw
    return px[((box.y0 + ly) * w + box.x0 + lx) * 4 + c]
  }
  let guard = bw * bh + 8
  while (stack.length > 0 && guard-- > 0) {
    const cur = stack.pop()
    if (cur === undefined) break
    const cr = colourAt(cur, 0), cg = colourAt(cur, 1), cb = colourAt(cur, 2)
    const lx = cur % bw
    const ly = (cur - lx) / bw
    const push = (nx: number, ny: number): void => {
      if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) return
      const nl = ny * bw + nx
      if (bg[nl]) return
      if (map.grad[nl] >= gradTol) return                             // an edge: stop
      const nr = colourAt(nl, 0), ng = colourAt(nl, 1), nb = colourAt(nl, 2)
      const local = Math.max(Math.abs(nr - cr), Math.abs(ng - cg), Math.abs(nb - cb))
      if (local > localTol) return                                    // colour break
      const global = Math.max(Math.abs(nr - mr), Math.abs(ng - mg), Math.abs(nb - mb))
      if (global > globalTol) return                                  // drifted away
      bg[nl] = 1
      stack.push(nl)
    }
    push(lx - 1, ly); push(lx + 1, ly); push(lx, ly - 1); push(lx, ly + 1)
  }

  // ── Subject = whatever the background never reached ──────────────────────
  // Annotated: `morph`/`soften` return a plain `Uint8Array`, which TS 6 keeps
  // distinct from the `Uint8Array<ArrayBuffer>` a constructor call infers.
  let subject: Uint8Array = new Uint8Array(bw * bh)
  let count = 0
  for (let i = 0; i < subject.length; i++) if (!bg[i]) { subject[i] = 255; count++ }
  const area = bw * bh
  if (count === 0 || count / area > OBJECT_MAX_SUBJECT_RATIO) return null

  // ── Collar refinement ────────────────────────────────────────────────────
  // The flood halts one or two pixels short of the object because the Sobel
  // halo around an edge is wider than the edge itself, so the raw subject wears
  // a collar of background-coloured pixels. Reclassify by nearest mean colour:
  // the subject's own colour is measured on its eroded core, which the collar
  // cannot reach.
  const core = morph(morph(subject, bw, bh, false), bw, bh, false)
  let cr = 0, cg = 0, cb = 0, cn = 0
  for (let i = 0; i < core.length; i++) {
    if (!core[i]) continue
    const lx = i % bw
    const ly = (i - lx) / bw
    const o = ((box.y0 + ly) * w + box.x0 + lx) * 4
    cr += px[o]; cg += px[o + 1]; cb += px[o + 2]; cn++
  }
  if (cn >= 16) {
    cr /= cn; cg /= cn; cb /= cn
    // Only worth doing when subject and background actually differ in colour.
    const separation = Math.max(Math.abs(cr - mr), Math.abs(cg - mg), Math.abs(cb - mb))
    if (separation > 24) {
      count = 0
      for (let i = 0; i < subject.length; i++) {
        if (!subject[i]) continue
        const lx = i % bw
        const ly = (i - lx) / bw
        const o = ((box.y0 + ly) * w + box.x0 + lx) * 4
        const dSub = Math.hypot(px[o] - cr, px[o + 1] - cg, px[o + 2] - cb)
        const dBg = Math.hypot(px[o] - mr, px[o + 1] - mg, px[o + 2] - mb)
        if (dBg < dSub) subject[i] = 0
        else count++
      }
      if (count === 0) return null
    }
  }

  subject = morph(morph(subject, bw, bh, false), bw, bh, true)        // open: kill speckles
  subject = morph(morph(subject, bw, bh, true), bw, bh, false)        // close: fill pinholes
  subject = soften(subject, bw, bh)

  let kept = 0
  const mask = new Uint8Array(w * h)
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const v = subject[y * bw + x]
      if (v === 0) continue
      mask[(box.y0 + y) * w + box.x0 + x] = v
      kept++
    }
  }
  return kept > 0 ? mask : null
}

const objectSelectTool = ((): ToolHandler => {
  let state: ObjectState | null = null

  const refresh = (ctx: ToolContext): void => {
    const s = state
    if (!s) { ctx.setPreview(null); return }
    ctx.setPreview(g => {
      withDocTransform(ctx, g, () => {
        g.fillStyle = 'rgba(90,160,255,0.14)'
        g.fillRect(Math.min(s.start.x, s.cur.x), Math.min(s.start.y, s.cur.y),
          Math.abs(s.cur.x - s.start.x), Math.abs(s.cur.y - s.start.y))
      })
      const [ax, ay] = ctx.docToScreen(s.start.x, s.start.y)
      const [bx, by] = ctx.docToScreen(s.cur.x, s.cur.y)
      g.beginPath()
      g.rect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay))
      g.lineWidth = 1
      g.strokeStyle = 'rgba(0,0,0,0.65)'
      g.stroke()
      g.setLineDash([4, 3])
      g.strokeStyle = 'rgba(120,190,255,0.95)'
      g.stroke()
      g.setLineDash([])
    })
    ctx.setStatus(`${Math.round(Math.abs(s.cur.x - s.start.x))} × ${Math.round(Math.abs(s.cur.y - s.start.y))}`)
  }

  return {
    cursor: 'crosshair',

    onDown(ctx, p) {
      state = { mode: ctx.selectModeFor(p), start: { x: p.x, y: p.y }, cur: { x: p.x, y: p.y } }
      refresh(ctx)
    },

    onMove(ctx, p) {
      if (!state) return
      state.cur = { x: p.x, y: p.y }
      refresh(ctx)
    },

    onUp(ctx, p) {
      const s = state
      state = null
      ctx.setPreview(null)
      ctx.setStatus(null)
      if (!s) return
      const box = clampBox(s.start.x, s.start.y, p.x, p.y, ctx.docW, ctx.docH)
      if (box.x1 - box.x0 < 1 || box.y1 - box.y0 < 1) return
      const px = sampleSource(ctx)
      const subject = px ? segmentObject(px, ctx.docW, ctx.docH, box) : null
      if (subject) { commitMask(ctx, subject, s.mode); return }
      // Honest fallback: no subject could be isolated, keep the marquee.
      const mask = new Uint8Array(ctx.docW * ctx.docH)
      for (let y = box.y0; y < box.y1; y++) mask.fill(255, y * ctx.docW + box.x0, y * ctx.docW + box.x1)
      commitMask(ctx, mask, s.mode)
    },

    onCancel(ctx) {
      state = null
      ctx.setPreview(null)
      ctx.setStatus(null)
    },
  }
})()

registerTool('object-select', objectSelectTool)
