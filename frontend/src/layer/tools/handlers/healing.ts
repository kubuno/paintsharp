// F07 — the healing family: spot-heal, heal, patch, content-move, red-eye.
//
// Everything here goes through `ToolContext`; nothing imports the editor. The
// five tools share one numeric core:
//
//   • `laplaceSolve` — a membrane (Laplace) solver over an arbitrary mask, with
//     Dirichlet conditions taken from the untouched pixels around it. Used raw it
//     reconstructs a region from its own border (spot-heal, the hole left by
//     content-move); applied to the DIFFERENCE between a destination and a source
//     it performs seamless (Poisson) cloning, i.e. it keeps the source TEXTURE
//     while adopting the destination's low frequencies — luminosity and colour.
//     That is what `heal`, `patch` and `content-move` do.
//
// ─── Attribution ─────────────────────────────────────────────────────────────
// `laplaceSolve` is a TypeScript re-implementation of GIMP's
// `gimp_heal_laplace_loop()` / `gimp_heal()` from `app/paint/gimpheal.c`
//   Copyright (C) Jean-Yves Couleaud <cjyves@free.fr>
//   Copyright (C) 2013 Loren Merritt
//   GNU General Public License v3 or later.
// The original algorithm is described in T. Georgiev, "Photoshop Healing Brush:
// a Tool for Seamless Cloning" (see developer.gimp.org/core/algorithm/healing/).
// The checkerboard (red/black) Gauss-Seidel ordering, the over-relaxation factor
// `w = 2 - 1/(0.1575*sqrt(n) + 0.8)`, the dummy "zero" pixel standing in for
// off-canvas neighbours and the convergence threshold are taken from that file.
//
// `redEyeReduce` ports the red-eye removal formula of GIMP's
// `plug-ins/common/red-eye-removal.c` (now shipped as the `gegl:red-eye-removal`
// operation), Copyright (C) 2004-2008 Robert Merkel / Andrew Kieschnick,
// GNU General Public License v3 or later.
//
// Kubuno is licensed under the AGPLv3, which is compatible with those GPLv3
// sources for this derivation.
// ─────────────────────────────────────────────────────────────────────────────
import { registerTool } from './registry'
import type { LayerStructureItem } from '../../../api'
import type { ToolContext, ToolHandler } from './types'

// ── Small geometry helpers ───────────────────────────────────────────────────

interface Pt { x: number; y: number }

/** Half-open rectangle in document space: `x1` and `y1` are EXCLUSIVE. */
interface Bounds { x0: number; y0: number; x1: number; y1: number }

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

const boundsW = (b: Bounds): number => b.x1 - b.x0
const boundsH = (b: Bounds): number => b.y1 - b.y0
const boundsArea = (b: Bounds): number => Math.max(0, boundsW(b)) * Math.max(0, boundsH(b))
const boundsEmpty = (b: Bounds): boolean => b.x1 <= b.x0 || b.y1 <= b.y0

/** `b` grown by `pad` pixels then clipped to the document. */
function padClip(b: Bounds, pad: number, docW: number, docH: number): Bounds {
  return {
    x0: clamp(Math.floor(b.x0) - pad, 0, docW),
    y0: clamp(Math.floor(b.y0) - pad, 0, docH),
    x1: clamp(Math.ceil(b.x1) + pad, 0, docW),
    y1: clamp(Math.ceil(b.y1) + pad, 0, docH),
  }
}

const unionBounds = (a: Bounds, b: Bounds): Bounds => ({
  x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0),
  x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1),
})

const offsetBounds = (b: Bounds, dx: number, dy: number): Bounds =>
  ({ x0: b.x0 + dx, y0: b.y0 + dy, x1: b.x1 + dx, y1: b.y1 + dy })

/**
 * Option values live in the editor, not in `ToolContext`; the brush figures we
 * do get may be expressed either as 0..1 or as a percentage depending on the
 * caller, so normalise defensively. A bare `1` is read as "100 %".
 */
function norm01(v: number, fallback: number): number {
  if (!Number.isFinite(v)) return fallback
  if (v <= 0) return 0
  return v > 1 ? clamp(v / 100, 0, 1) : clamp(v, 0, 1)
}

// ── Guard rails ──────────────────────────────────────────────────────────────

/**
 * Largest region the solver will accept. The solve allocates ~40 bytes per
 * pixel (4 float channels + a 5-entry index row + the diagonal), so one mega
 * pixel already costs ~40 MB of transient memory: healing is a local operation,
 * anything larger is a mistake rather than an intent.
 */
const MAX_SOLVE_PIXELS = 1_048_576

/** Above this, the undo snapshot falls back to a full-layer `pushUndo`. */
const MAX_SNAPSHOT_PIXELS = 8_388_608

/** Upper bound on Gauss-Seidel work, so a big region degrades in time, not in safety. */
const MAX_SOLVE_OPS = 40_000_000

/** Width, in pixels, of the band content-move blends along the border of a move. */
const SEAM_RING = 4

// ── The membrane solver (GIMP `gimp_heal_laplace_loop`) ──────────────────────

/** Tolerate a total deviation-from-smoothness of 0.1 LSB at 8-bit depth. */
const EPSILON = 0.1 / 255
const MAX_ITER = 500
const MIN_ITER = 24

/**
 * Solves ΔI = 0 inside `mask`, in place, with Dirichlet conditions supplied by
 * the values already stored outside it. `values` is `depth`-interleaved and MUST
 * be `depth * (width * height + 1)` long: the extra trailing pixel is the dummy
 * "zero" neighbour that stands in for anything off the canvas.
 *
 * Port of `gimp_heal_laplace_loop()` — see the attribution header.
 */
function laplaceSolve(
  values: Float32Array,
  width: number,
  height: number,
  depth: number,
  mask: Uint8Array,
): void {
  const n = width * height
  if (n <= 0 || depth <= 0) return

  const zero = depth * n
  for (let k = 0; k < depth; k++) values[zero + k] = 0

  const aDiag = new Float32Array(n)
  const aIdx = new Int32Array(5 * n)

  // All off-diagonal coefficients are -1, so only the neighbour indices are
  // stored. Rows are laid out in checkerboard order, which turns one linear pass
  // over `aIdx` into "all red cells, then all black cells" — that is what makes
  // plain Gauss-Seidel converge like its red/black variant.
  let nmask = 0
  for (let parity = 0; parity < 2; parity++) {
    for (let i = 0; i < height; i++) {
      for (let j = (i & 1) ^ parity; j < width; j += 2) {
        if (mask[j + i * width] === 0) continue
        const row = nmask * 5
        // Dirichlet conditions are omitted for neighbours off the canvas edge.
        aDiag[nmask] = 4 - (i === 0 ? 1 : 0) - (j === 0 ? 1 : 0)
          - (i === height - 1 ? 1 : 0) - (j === width - 1 ? 1 : 0)
        aIdx[row] = (i * width + j) * depth
        aIdx[row + 1] = j === width - 1 ? zero : (i * width + j + 1) * depth
        aIdx[row + 2] = i === height - 1 ? zero : ((i + 1) * width + j) * depth
        aIdx[row + 3] = j === 0 ? zero : (i * width + j - 1) * depth
        aIdx[row + 4] = i === 0 ? zero : ((i - 1) * width + j) * depth
        nmask++
      }
    }
  }
  if (nmask === 0) return

  // Empirically optimal over-relaxation factor (GIMP, benchmarked on round brushes).
  let w = 2.0 - 1.0 / (0.1575 * Math.sqrt(nmask) + 0.8)
  w *= 0.25
  for (let i = 0; i < nmask; i++) aDiag[i] *= w

  // Bound the total work: a huge region loses accuracy, never responsiveness.
  const maxIter = clamp(
    Math.floor(MAX_SOLVE_OPS / Math.max(1, nmask * depth)),
    MIN_ITER,
    MAX_ITER,
  )
  const tolerance = EPSILON * EPSILON * w * w

  for (let iter = 0; iter < maxIter; iter++) {
    let err = 0
    for (let i = 0; i < nmask; i++) {
      const row = i * 5
      const j0 = aIdx[row]
      const j1 = aIdx[row + 1]
      const j2 = aIdx[row + 2]
      const j3 = aIdx[row + 3]
      const j4 = aIdx[row + 4]
      const a = aDiag[i]
      for (let k = 0; k < depth; k++) {
        const diff = a * values[j0 + k]
          - w * (values[j1 + k] + values[j2 + k] + values[j3 + k] + values[j4 + k])
        values[j0 + k] -= diff
        err += diff * diff
      }
    }
    if (err < tolerance) break
  }
}

// ── Layer access ─────────────────────────────────────────────────────────────

interface Target {
  id: string
  layer: LayerStructureItem
  lockAlpha: boolean
}

/**
 * The layer a healing gesture may write to, or `null`. Groups own no pixels,
 * locked layers refuse every edit, and only raster layers have a texture.
 */
function activeTarget(ctx: ToolContext): Target | null {
  const id = ctx.activeId
  if (!id) return null
  const layer = ctx.layerById(id)
  if (!layer) return null
  if (layer.locked) return null
  if (layer.children) return null
  if (layer.type !== 'raster') return null
  return { id, layer, lockAlpha: layer.lockAlpha === true }
}

/**
 * Straight RGBA of `b`, edge-clamped when the rectangle overflows the document
 * (GIMP's `GEGL_ABYSS_CLAMP`, which is what keeps healing usable near a border).
 * Returns `null` when the rectangle misses the document entirely.
 */
function readRectClamped(ctx: ToolContext, id: string, b: Bounds): Uint8Array | null {
  const w = boundsW(b)
  const h = boundsH(b)
  if (w <= 0 || h <= 0) return null

  const ix0 = clamp(b.x0, 0, ctx.docW)
  const iy0 = clamp(b.y0, 0, ctx.docH)
  const ix1 = clamp(b.x1, 0, ctx.docW)
  const iy1 = clamp(b.y1, 0, ctx.docH)
  if (ix1 <= ix0 || iy1 <= iy0) return null

  const iw = ix1 - ix0
  const ih = iy1 - iy0
  const inner = ctx.readTexRect(id, ix0, iy0, iw, ih)
  if (!inner) return null
  if (iw === w && ih === h) return inner

  const out = new Uint8Array(w * h * 4)
  for (let ry = 0; ry < h; ry++) {
    const sy = clamp(b.y0 + ry, iy0, iy1 - 1) - iy0
    for (let rx = 0; rx < w; rx++) {
      const sx = clamp(b.x0 + rx, ix0, ix1 - 1) - ix0
      const s = (sy * iw + sx) * 4
      const d = (ry * w + rx) * 4
      out[d] = inner[s]
      out[d + 1] = inner[s + 1]
      out[d + 2] = inner[s + 2]
      out[d + 3] = inner[s + 3]
    }
  }
  return out
}

// ── Mask building ────────────────────────────────────────────────────────────

/** Bounding box of a stroke of disks of radius `r`. */
function strokeBounds(points: readonly Pt[], r: number): Bounds {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const p of points) {
    if (p.x < x0) x0 = p.x
    if (p.y < y0) y0 = p.y
    if (p.x > x1) x1 = p.x
    if (p.y > y1) y1 = p.y
  }
  if (!Number.isFinite(x0)) return { x0: 0, y0: 0, x1: 0, y1: 0 }
  return { x0: x0 - r, y0: y0 - r, x1: x1 + r + 1, y1: y1 + r + 1 }
}

/** Bounding box of a polyline. */
function polyBounds(points: readonly Pt[]): Bounds {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const p of points) {
    if (p.x < x0) x0 = p.x
    if (p.y < y0) y0 = p.y
    if (p.x > x1) x1 = p.x
    if (p.y > y1) y1 = p.y
  }
  if (!Number.isFinite(x0)) return { x0: 0, y0: 0, x1: 0, y1: 0 }
  return { x0, y0, x1: x1 + 1, y1: y1 + 1 }
}

/**
 * 0..255 coverage of a stroke of soft disks, rasterised inside `b`. Dabs are
 * interpolated along the path so a fast gesture leaves no gap; the number of
 * dabs is capped, which bounds the cost of a very long stroke.
 */
function buildStrokeMask(
  points: readonly Pt[],
  radius: number,
  hardness: number,
  b: Bounds,
): Uint8Array {
  const w = boundsW(b)
  const h = boundsH(b)
  const mask = new Uint8Array(Math.max(0, w * h))
  if (w <= 0 || h <= 0 || points.length === 0 || radius <= 0) return mask

  const inner = radius * clamp(hardness, 0, 1)
  const soft = Math.max(1e-3, radius - inner)

  const stamp = (cx: number, cy: number): void => {
    const px0 = Math.max(b.x0, Math.floor(cx - radius))
    const px1 = Math.min(b.x1 - 1, Math.ceil(cx + radius))
    const py0 = Math.max(b.y0, Math.floor(cy - radius))
    const py1 = Math.min(b.y1 - 1, Math.ceil(cy + radius))
    for (let y = py0; y <= py1; y++) {
      const dy = y + 0.5 - cy
      const rowBase = (y - b.y0) * w - b.x0
      for (let x = px0; x <= px1; x++) {
        const dx = x + 0.5 - cx
        const d = Math.sqrt(dx * dx + dy * dy)
        if (d > radius) continue
        const t = d <= inner ? 1 : 1 - (d - inner) / soft
        const c = Math.round(255 * clamp(t, 0, 1))
        const idx = rowBase + x
        if (c > mask[idx]) mask[idx] = c
      }
    }
  }

  // Total path length first, so the dab spacing can be widened on a long stroke
  // instead of letting the dab count grow without bound.
  let length = 0
  for (let i = 1; i < points.length; i++) {
    length += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
  }
  const MAX_DABS = 4096
  const step = Math.max(Math.max(0.5, radius * 0.35), length / MAX_DABS)

  stamp(points[0].x, points[0].y)
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const c = points[i]
    const seg = Math.hypot(c.x - a.x, c.y - a.y)
    const steps = Math.min(MAX_DABS, Math.max(1, Math.ceil(seg / step)))
    for (let s = 1; s <= steps; s++) {
      const t = s / steps
      stamp(a.x + (c.x - a.x) * t, a.y + (c.y - a.y) * t)
    }
  }
  return mask
}

/** Even-odd scanline fill of a closed polygon, rasterised inside `b`. */
function buildPolygonMask(points: readonly Pt[], b: Bounds): Uint8Array {
  const w = boundsW(b)
  const h = boundsH(b)
  const mask = new Uint8Array(Math.max(0, w * h))
  const n = points.length
  if (w <= 0 || h <= 0 || n < 3) return mask

  const xs: number[] = []
  for (let row = 0; row < h; row++) {
    const y = b.y0 + row + 0.5
    xs.length = 0
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const a = points[j]
      const c = points[i]
      if ((a.y <= y && c.y > y) || (c.y <= y && a.y > y)) {
        xs.push(a.x + ((y - a.y) / (c.y - a.y)) * (c.x - a.x))
      }
    }
    if (xs.length < 2) continue
    xs.sort((p, q) => p - q)
    const rowBase = row * w
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const sx = clamp(Math.round(xs[k] - b.x0), 0, w)
      const ex = clamp(Math.round(xs[k + 1] - b.x0), 0, w)
      if (ex > sx) mask.fill(255, rowBase + sx, rowBase + ex)
    }
  }
  return mask
}

/**
 * The mask actually handed to the solver: coverage, restricted to the active
 * selection when there is one. Restricting the SOLVE (and not only the write)
 * matters: it keeps the Dirichlet border on pixels that really stay untouched.
 */
function solveMaskFor(
  ctx: ToolContext,
  coverage: Uint8Array,
  b: Bounds,
  honourSelection: boolean,
): { mask: Uint8Array; count: number } {
  const w = boundsW(b)
  const h = boundsH(b)
  const mask = new Uint8Array(Math.max(0, w * h))
  const sel = honourSelection ? ctx.selection : null
  let count = 0
  for (let y = 0; y < h; y++) {
    const docRow = (b.y0 + y) * ctx.docW
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (coverage[i] === 0) continue
      if (sel && sel[docRow + b.x0 + x] === 0) continue
      mask[i] = 1
      count++
    }
  }
  return { mask, count }
}

// ── Writing results back ─────────────────────────────────────────────────────

interface ApplyArgs {
  ctx: ToolContext
  bounds: Bounds
  /** Rect RGBA as it was before the operation. */
  orig: Uint8Array
  /** Rect RGBA to be written; starts as a copy of `orig`. */
  out: Uint8Array
  /** 0..255 per-pixel strength of the effect. */
  coverage: Uint8Array
  /** Interleaved RGBA result of the operation, same rect. */
  result: Float32Array
  opacity: number
  lockAlpha: boolean
  /** When false, the active selection does not gate this write (see content-move). */
  honourSelection: boolean
  /** Alpha is left untouched — heal must not change a layer's opacity. */
  keepAlpha: boolean
}

/** Blends `result` into `out` under `coverage`, honouring selection and locks. */
function applyResult(args: ApplyArgs): boolean {
  const { ctx, bounds, orig, out, coverage, result, opacity, lockAlpha, keepAlpha } = args
  const w = boundsW(bounds)
  const h = boundsH(bounds)
  const sel = args.honourSelection ? ctx.selection : null
  let touched = false

  for (let y = 0; y < h; y++) {
    const docRow = (bounds.y0 + y) * ctx.docW + bounds.x0
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const cov = coverage[i]
      if (cov === 0) continue
      let a = (cov / 255) * opacity
      if (sel) a *= sel[docRow + x] / 255
      if (a <= 0) continue
      const p = i * 4
      // Locked transparency: a fully transparent pixel stays untouched.
      if (lockAlpha && orig[p + 3] === 0) continue
      for (let k = 0; k < 3; k++) {
        const v = orig[p + k] + (result[p + k] - orig[p + k]) * a
        out[p + k] = clamp(Math.round(v), 0, 255)
      }
      if (!keepAlpha && !lockAlpha) {
        const v = orig[p + 3] + (result[p + 3] - orig[p + 3]) * a
        out[p + 3] = clamp(Math.round(v), 0, 255)
      }
      touched = true
    }
  }
  return touched
}

/**
 * Records the undo entry for `b` — always BEFORE any pixel is written. Uses the
 * cheap rectangle form, falling back to a full-layer snapshot only when the
 * rectangle is so large that copying it would be the expensive option.
 */
function pushUndoFor(ctx: ToolContext, layerId: string, b: Bounds, snapshot: Uint8Array | null): void {
  if (snapshot && boundsArea(b) <= MAX_SNAPSHOT_PIXELS) {
    ctx.pushUndoRect(layerId, snapshot, { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 })
  } else {
    ctx.pushUndo(layerId)
  }
}

// ── The two reconstruction primitives ────────────────────────────────────────

/**
 * Rebuilds the masked pixels from their own border: a Laplace membrane pinned to
 * the surrounding pixels. This is the "it just disappears" behaviour — the blob
 * is replaced by the smooth continuation of what surrounds it.
 */
function diffuseFromBorder(
  orig: Uint8Array,
  width: number,
  height: number,
  mask: Uint8Array,
): Float32Array {
  const n = width * height
  const values = new Float32Array(4 * (n + 1))
  for (let i = 0; i < n * 4; i++) values[i] = orig[i]
  laplaceSolve(values, width, height, 4, mask)
  return values
}

/**
 * Seamless clone of `src` into `dest` over `mask`: the high frequencies (the
 * TEXTURE) come from the source, the low frequencies (luminosity and colour)
 * from the destination, because the solved correction matches the destination
 * exactly on the mask border. This is `gimp_heal()`.
 *
 * `verbatim` opts a sub-area out of the correction: its difference is pinned to
 * zero, so the source is reproduced exactly there and the solve only spans what
 * is left — the seam. That is what separates MOVING content (keep the object,
 * hide the join) from HEALING it (dissolve the object into its surroundings).
 */
function poissonClone(
  dest: Uint8Array,
  src: Uint8Array,
  width: number,
  height: number,
  mask: Uint8Array,
  verbatim: Uint8Array | null = null,
): Float32Array {
  const n = width * height
  const values = new Float32Array(4 * (n + 1))
  // diff = destination - source …
  for (let i = 0; i < n * 4; i++) values[i] = dest[i] - src[i]
  if (verbatim) {
    for (let i = 0; i < n; i++) {
      if (verbatim[i] === 0) continue
      const p = i * 4
      values[p] = 0; values[p + 1] = 0; values[p + 2] = 0; values[p + 3] = 0
    }
  }
  // … solved for ΔI = 0 with the untouched diff as boundary condition …
  laplaceSolve(values, width, height, 4, mask)
  // … then added back to the source.
  for (let i = 0; i < n * 4; i++) values[i] += src[i]
  return values
}

/** Mask shrunk by `iterations` pixels (4-neighbour); outside the rect counts as empty. */
function erodeMask(mask: Uint8Array, width: number, height: number, iterations: number): Uint8Array {
  let cur = Uint8Array.from(mask)
  for (let it = 0; it < iterations; it++) {
    const next = new Uint8Array(width * height)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x
        if (cur[i] === 0) continue
        if (x === 0 || y === 0 || x === width - 1 || y === height - 1) continue
        if (cur[i - 1] === 0 || cur[i + 1] === 0 || cur[i - width] === 0 || cur[i + width] === 0) continue
        next[i] = 1
      }
    }
    cur = next
  }
  return cur
}

// ── Preview drawing ──────────────────────────────────────────────────────────

const PREVIEW_LIGHT = 'rgba(255,255,255,0.9)'
const PREVIEW_DARK = 'rgba(0,0,0,0.65)'

function tracePath(g: CanvasRenderingContext2D, ctx: ToolContext, pts: readonly Pt[], close: boolean): void {
  if (pts.length === 0) return
  g.beginPath()
  const [sx, sy] = ctx.docToScreen(pts[0].x, pts[0].y)
  g.moveTo(sx, sy)
  for (let i = 1; i < pts.length; i++) {
    const [x, y] = ctx.docToScreen(pts[i].x, pts[i].y)
    g.lineTo(x, y)
  }
  if (close) g.closePath()
}

/** Dashed two-tone outline — readable over any image. */
function strokeOutline(g: CanvasRenderingContext2D): void {
  g.save()
  g.lineWidth = 1
  g.setLineDash([])
  g.strokeStyle = PREVIEW_DARK
  g.stroke()
  g.setLineDash([4, 4])
  g.strokeStyle = PREVIEW_LIGHT
  g.stroke()
  g.restore()
}

function drawBrushCursor(g: CanvasRenderingContext2D, ctx: ToolContext, p: Pt, radius: number): void {
  const [cx, cy] = ctx.docToScreen(p.x, p.y)
  const r = Math.max(1, radius * ctx.zoom)
  g.save()
  g.lineWidth = 1
  g.strokeStyle = PREVIEW_DARK
  g.beginPath()
  g.arc(cx, cy, r + 0.5, 0, Math.PI * 2)
  g.stroke()
  g.strokeStyle = PREVIEW_LIGHT
  g.beginPath()
  g.arc(cx, cy, r, 0, Math.PI * 2)
  g.stroke()
  g.restore()
}

function drawStrokeTrail(g: CanvasRenderingContext2D, ctx: ToolContext, pts: readonly Pt[], radius: number): void {
  if (pts.length === 0) return
  g.save()
  g.lineCap = 'round'
  g.lineJoin = 'round'
  g.lineWidth = Math.max(1, radius * 2 * ctx.zoom)
  g.strokeStyle = 'rgba(120,190,255,0.35)'
  if (pts.length === 1) {
    const [x, y] = ctx.docToScreen(pts[0].x, pts[0].y)
    g.beginPath()
    g.arc(x, y, g.lineWidth / 2, 0, Math.PI * 2)
    g.fillStyle = 'rgba(120,190,255,0.35)'
    g.fill()
  } else {
    tracePath(g, ctx, pts, false)
    g.stroke()
  }
  g.restore()
}

function drawCrosshair(g: CanvasRenderingContext2D, ctx: ToolContext, p: Pt): void {
  const [x, y] = ctx.docToScreen(p.x, p.y)
  g.save()
  g.lineWidth = 1
  g.strokeStyle = PREVIEW_DARK
  g.beginPath()
  g.moveTo(x - 8, y); g.lineTo(x + 8, y)
  g.moveTo(x, y - 8); g.lineTo(x, y + 8)
  g.stroke()
  g.strokeStyle = PREVIEW_LIGHT
  g.beginPath()
  g.arc(x, y, 4, 0, Math.PI * 2)
  g.stroke()
  g.restore()
}

// ── Brush-driven tools (spot-heal, heal, red-eye) ────────────────────────────

/**
 * Shared state of a painted gesture. Pixels are only written on release: the
 * whole stroke is reconstructed in one solve, which is both cheaper than one
 * solve per dab and free of the intermediate states a partial stroke would
 * otherwise push through the compositor.
 */
interface StrokeState {
  layerId: string
  points: Pt[]
  radius: number
  hardness: number
  cursor: Pt
  /** Heal only: offset from the destination to the sampled source. */
  offsetX: number
  offsetY: number
}

/** Points are deduplicated and capped so an endless gesture cannot grow memory. */
const MAX_STROKE_POINTS = 20_000

function pushStrokePoint(state: StrokeState, x: number, y: number): void {
  const last = state.points[state.points.length - 1]
  if (last && Math.abs(last.x - x) < 0.75 && Math.abs(last.y - y) < 0.75) return
  if (state.points.length >= MAX_STROKE_POINTS) {
    state.points[state.points.length - 1] = { x, y }
    return
  }
  state.points.push({ x, y })
}

function brushRadius(ctx: ToolContext): number {
  const size = Number.isFinite(ctx.brushSize) && ctx.brushSize > 0 ? ctx.brushSize : 19
  return Math.max(0.5, size / 2)
}

/** Rect + coverage + solve mask of a finished stroke, or `null` when there is nothing to do. */
function strokeRegion(
  ctx: ToolContext,
  state: StrokeState,
): { bounds: Bounds; coverage: Uint8Array; mask: Uint8Array; count: number } | null {
  const raw = strokeBounds(state.points, state.radius)
  // One pixel of padding so the solver always has a real border to pin to.
  const bounds = padClip(raw, 1, ctx.docW, ctx.docH)
  if (boundsEmpty(bounds) || boundsArea(bounds) > MAX_SOLVE_PIXELS) return null
  const coverage = buildStrokeMask(state.points, state.radius, state.hardness, bounds)
  const { mask, count } = solveMaskFor(ctx, coverage, bounds, true)
  if (count === 0) return null
  return { bounds, coverage, mask, count }
}

// ── 1. spot-heal ─────────────────────────────────────────────────────────────

let spotState: StrokeState | null = null

function applySpotHeal(ctx: ToolContext, state: StrokeState): void {
  const target = activeTarget(ctx)
  if (!target || target.id !== state.layerId) return

  const region = strokeRegion(ctx, state)
  if (!region) return

  const orig = readRectClamped(ctx, target.id, region.bounds)
  if (!orig) return

  const w = boundsW(region.bounds)
  const h = boundsH(region.bounds)
  const result = diffuseFromBorder(orig, w, h, region.mask)

  const out = orig.slice()
  const touched = applyResult({
    ctx,
    bounds: region.bounds,
    orig,
    out,
    coverage: region.coverage,
    result,
    opacity: norm01(ctx.brushOpacity, 1),
    lockAlpha: target.lockAlpha,
    honourSelection: true,
    // Alpha is diffused too, so a hole punched in a layer heals over.
    keepAlpha: false,
  })
  if (!touched) return

  pushUndoFor(ctx, target.id, region.bounds, orig)
  ctx.writeTexRect(target.id, region.bounds.x0, region.bounds.y0, w, h, out)
  ctx.invalidate()
}

registerTool('spot-heal', {
  onDown(ctx, p) {
    const target = activeTarget(ctx)
    if (!target) return
    const state: StrokeState = {
      layerId: target.id,
      points: [{ x: p.x, y: p.y }],
      radius: brushRadius(ctx),
      hardness: norm01(ctx.brushHardness, 1),
      cursor: { x: p.x, y: p.y },
      offsetX: 0,
      offsetY: 0,
    }
    spotState = state
    ctx.setPreview(g => {
      drawStrokeTrail(g, ctx, state.points, state.radius)
      drawBrushCursor(g, ctx, state.cursor, state.radius)
    })
  },
  onMove(ctx, p) {
    const state = spotState
    if (!state) return
    state.cursor = { x: p.x, y: p.y }
    pushStrokePoint(state, p.x, p.y)
    ctx.repaintOverlay()
  },
  onUp(ctx, p) {
    const state = spotState
    spotState = null
    if (!state) return
    pushStrokePoint(state, p.x, p.y)
    ctx.setPreview(null)
    applySpotHeal(ctx, state)
  },
  onCancel(ctx) {
    spotState = null
    ctx.setPreview(null)
  },
} satisfies ToolHandler)

// ── 2. heal ──────────────────────────────────────────────────────────────────

/** Source anchor picked with Alt+click; kept between strokes, like GIMP. */
let healSource: Pt | null = null
let healState: StrokeState | null = null

function applyHeal(ctx: ToolContext, state: StrokeState): void {
  const target = activeTarget(ctx)
  if (!target || target.id !== state.layerId) return

  const region = strokeRegion(ctx, state)
  if (!region) return

  const w = boundsW(region.bounds)
  const h = boundsH(region.bounds)

  const dest = readRectClamped(ctx, target.id, region.bounds)
  if (!dest) return
  const src = readRectClamped(ctx, target.id, offsetBounds(region.bounds, state.offsetX, state.offsetY))
  if (!src) return

  const result = poissonClone(dest, src, w, h, region.mask)

  const out = dest.slice()
  const touched = applyResult({
    ctx,
    bounds: region.bounds,
    orig: dest,
    out,
    coverage: region.coverage,
    result,
    opacity: norm01(ctx.brushOpacity, 1),
    lockAlpha: target.lockAlpha,
    honourSelection: true,
    // Healing transfers texture, never opacity.
    keepAlpha: true,
  })
  if (!touched) return

  pushUndoFor(ctx, target.id, region.bounds, dest)
  ctx.writeTexRect(target.id, region.bounds.x0, region.bounds.y0, w, h, out)
  ctx.invalidate()
}

registerTool('heal', {
  onDown(ctx, p) {
    const target = activeTarget(ctx)
    if (!target) return

    // Alt+click picks the source, exactly like the clone tools.
    if (p.altKey) {
      healSource = { x: p.x, y: p.y }
      const anchor = healSource
      ctx.setPreview(g => drawCrosshair(g, ctx, anchor))
      ctx.repaintOverlay()
      return
    }

    const source = healSource
    if (!source) {
      // No source yet: show where the modifier goes instead of failing silently.
      ctx.setStatus('Alt + ⌖')
      return
    }
    ctx.setStatus(null)

    const state: StrokeState = {
      layerId: target.id,
      points: [{ x: p.x, y: p.y }],
      radius: brushRadius(ctx),
      hardness: norm01(ctx.brushHardness, 1),
      cursor: { x: p.x, y: p.y },
      // Non-aligned: every stroke samples from the anchor again.
      offsetX: source.x - p.x,
      offsetY: source.y - p.y,
    }
    healState = state
    ctx.setPreview(g => {
      drawStrokeTrail(g, ctx, state.points, state.radius)
      drawBrushCursor(g, ctx, state.cursor, state.radius)
      drawCrosshair(g, ctx, { x: state.cursor.x + state.offsetX, y: state.cursor.y + state.offsetY })
    })
  },
  onMove(ctx, p) {
    const state = healState
    if (!state) return
    state.cursor = { x: p.x, y: p.y }
    pushStrokePoint(state, p.x, p.y)
    ctx.repaintOverlay()
  },
  onUp(ctx, p) {
    const state = healState
    healState = null
    if (!state) return
    pushStrokePoint(state, p.x, p.y)
    ctx.setPreview(null)
    applyHeal(ctx, state)
  },
  onCancel(ctx) {
    healState = null
    ctx.setPreview(null)
    ctx.setStatus(null)
  },
} satisfies ToolHandler)

// ── 3 & 4. Region tools: patch and content-move ──────────────────────────────

interface RegionState {
  layerId: string
  /** 0..255 coverage of the region, inside `bounds`. */
  mask: Uint8Array
  bounds: Bounds
  /** Lasso outline, kept for the preview; `null` when the region came from the selection. */
  outline: Pt[] | null
  dragging: boolean
  dragFrom: Pt
  dx: number
  dy: number
}

const insideRegion = (r: RegionState, x: number, y: number): boolean => {
  const px = Math.floor(x)
  const py = Math.floor(y)
  if (px < r.bounds.x0 || px >= r.bounds.x1 || py < r.bounds.y0 || py >= r.bounds.y1) return false
  return r.mask[(py - r.bounds.y0) * boundsW(r.bounds) + (px - r.bounds.x0)] > 0
}

function selectionAt(ctx: ToolContext, x: number, y: number): boolean {
  const sel = ctx.selection
  if (!sel) return false
  const px = Math.floor(x)
  const py = Math.floor(y)
  if (px < 0 || py < 0 || px >= ctx.docW || py >= ctx.docH) return false
  return sel[py * ctx.docW + px] > 0
}

/** Turns the active selection into a draggable region (Photoshop drags an existing selection). */
function regionFromSelection(ctx: ToolContext, layerId: string): RegionState | null {
  const sel = ctx.selection
  if (!sel) return null
  let x0 = ctx.docW, y0 = ctx.docH, x1 = -1, y1 = -1
  for (let y = 0; y < ctx.docH; y++) {
    const row = y * ctx.docW
    for (let x = 0; x < ctx.docW; x++) {
      if (sel[row + x] === 0) continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  if (x1 < x0 || y1 < y0) return null
  const bounds: Bounds = { x0, y0, x1: x1 + 1, y1: y1 + 1 }
  const w = boundsW(bounds)
  const h = boundsH(bounds)
  const mask = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const row = (bounds.y0 + y) * ctx.docW + bounds.x0
    for (let x = 0; x < w; x++) mask[y * w + x] = sel[row + x]
  }
  return { layerId, mask, bounds, outline: null, dragging: false, dragFrom: { x: 0, y: 0 }, dx: 0, dy: 0 }
}

/**
 * patch — the lasso marks the area to repair, the drag says where to take the
 * replacement from. On release the marked area is rebuilt from the pixels under
 * the dragged position, with the same seamless blend as `heal`.
 */
function applyPatch(ctx: ToolContext, region: RegionState): void {
  const target = activeTarget(ctx)
  if (!target || target.id !== region.layerId) return
  if (region.dx === 0 && region.dy === 0) return

  const bounds = padClip(region.bounds, 1, ctx.docW, ctx.docH)
  if (boundsEmpty(bounds) || boundsArea(bounds) > MAX_SOLVE_PIXELS) return

  const w = boundsW(bounds)
  const h = boundsH(bounds)

  // Re-project the region coverage onto the padded rectangle.
  const coverage = new Uint8Array(w * h)
  const rw = boundsW(region.bounds)
  for (let y = 0; y < h; y++) {
    const ry = bounds.y0 + y - region.bounds.y0
    if (ry < 0 || ry >= boundsH(region.bounds)) continue
    for (let x = 0; x < w; x++) {
      const rx = bounds.x0 + x - region.bounds.x0
      if (rx < 0 || rx >= rw) continue
      coverage[y * w + x] = region.mask[ry * rw + rx]
    }
  }
  const { mask, count } = solveMaskFor(ctx, coverage, bounds, true)
  if (count === 0) return

  const dest = readRectClamped(ctx, target.id, bounds)
  if (!dest) return
  const src = readRectClamped(ctx, target.id, offsetBounds(bounds, region.dx, region.dy))
  if (!src) return

  const result = poissonClone(dest, src, w, h, mask)
  const out = dest.slice()
  const touched = applyResult({
    ctx,
    bounds,
    orig: dest,
    out,
    coverage,
    result,
    opacity: 1,
    lockAlpha: target.lockAlpha,
    honourSelection: true,
    keepAlpha: true,
  })
  if (!touched) return

  pushUndoFor(ctx, target.id, bounds, dest)
  ctx.writeTexRect(target.id, bounds.x0, bounds.y0, w, h, out)
  ctx.invalidate()
}

/**
 * content-move — the selected content is moved, and the hole it leaves is filled
 * by continuation of its neighbourhood (Laplace diffusion from the hole border).
 * The moved content is pasted with the same seamless blend as `heal`, so it takes
 * the colour and luminosity of its new surroundings while keeping its texture.
 *
 * Note on the selection: the destination of the move sits OUTSIDE the selection
 * by construction (the selection IS what is being moved), so gating the paste on
 * the selection mask would make the tool a no-op. The paste therefore only obeys
 * the region and the layer locks; the hole fill obeys the selection as usual.
 */
function applyContentMove(ctx: ToolContext, region: RegionState): void {
  const target = activeTarget(ctx)
  if (!target || target.id !== region.layerId) return
  const dx = region.dx
  const dy = region.dy
  if (dx === 0 && dy === 0) return

  const holeBounds = padClip(region.bounds, 1, ctx.docW, ctx.docH)
  const pasteBounds = padClip(offsetBounds(region.bounds, dx, dy), 1, ctx.docW, ctx.docH)
  if (boundsEmpty(holeBounds) && boundsEmpty(pasteBounds)) return
  if (boundsArea(holeBounds) > MAX_SOLVE_PIXELS || boundsArea(pasteBounds) > MAX_SOLVE_PIXELS) return

  // Read both rectangles BEFORE writing anything: the paste must sample the
  // pixels as they were, not the ones the hole fill just produced.
  const holeOrig = boundsEmpty(holeBounds) ? null : readRectClamped(ctx, target.id, holeBounds)
  const pasteOrig = boundsEmpty(pasteBounds) ? null : readRectClamped(ctx, target.id, pasteBounds)

  // Region coverage sampled in an arbitrary rectangle, shifted by (sx, sy).
  const rw = boundsW(region.bounds)
  const rh = boundsH(region.bounds)
  const coverageIn = (b: Bounds, sx: number, sy: number): Uint8Array => {
    const w = boundsW(b)
    const h = boundsH(b)
    const cov = new Uint8Array(Math.max(0, w * h))
    for (let y = 0; y < h; y++) {
      const ry = b.y0 + y - sy - region.bounds.y0
      if (ry < 0 || ry >= rh) continue
      for (let x = 0; x < w; x++) {
        const rx = b.x0 + x - sx - region.bounds.x0
        if (rx < 0 || rx >= rw) continue
        cov[y * w + x] = region.mask[ry * rw + rx]
      }
    }
    return cov
  }

  const undoBounds = unionBounds(
    boundsEmpty(holeBounds) ? pasteBounds : holeBounds,
    boundsEmpty(pasteBounds) ? holeBounds : pasteBounds,
  )
  const undoSnapshot = boundsArea(undoBounds) <= MAX_SNAPSHOT_PIXELS
    ? readRectClamped(ctx, target.id, undoBounds)
    : null

  // ── 1. the hole, rebuilt from its own border ──
  let holeOut: Uint8Array | null = null
  let holeCov: Uint8Array | null = null
  if (holeOrig) {
    const w = boundsW(holeBounds)
    const h = boundsH(holeBounds)
    holeCov = coverageIn(holeBounds, 0, 0)
    const { mask, count } = solveMaskFor(ctx, holeCov, holeBounds, true)
    if (count > 0) {
      const result = diffuseFromBorder(holeOrig, w, h, mask)
      const out = holeOrig.slice()
      if (applyResult({
        ctx, bounds: holeBounds, orig: holeOrig, out, coverage: holeCov, result,
        opacity: 1, lockAlpha: target.lockAlpha, honourSelection: true, keepAlpha: false,
      })) holeOut = out
    }
  }

  // ── 2. the content, pasted and blended into its new surroundings ──
  let pasteOut: Uint8Array | null = null
  if (pasteOrig) {
    const w = boundsW(pasteBounds)
    const h = boundsH(pasteBounds)
    const cov = coverageIn(pasteBounds, dx, dy)
    const { mask, count } = solveMaskFor(ctx, cov, pasteBounds, false)
    if (count > 0) {
      // The moved pixels, sampled from the pre-move image at (x - dx, y - dy).
      const moved = readRectClamped(ctx, target.id, offsetBounds(pasteBounds, -dx, -dy))
      if (moved) {
        // Only a ring along the region border is solved: the object keeps its own
        // colours, and just the join with its new surroundings is smoothed out.
        const interior = erodeMask(mask, w, h, SEAM_RING)
        const ring = new Uint8Array(mask.length)
        let seam = 0
        for (let i = 0; i < mask.length; i++) {
          if (mask[i] !== 0 && interior[i] === 0) { ring[i] = 1; seam++ }
        }
        // A region too small to have an interior falls back to a full blend.
        const result = seam > 0
          ? poissonClone(pasteOrig, moved, w, h, ring, interior)
          : poissonClone(pasteOrig, moved, w, h, mask)
        const out = pasteOrig.slice()
        if (applyResult({
          ctx, bounds: pasteBounds, orig: pasteOrig, out, coverage: cov, result,
          opacity: 1, lockAlpha: target.lockAlpha, honourSelection: false, keepAlpha: false,
        })) pasteOut = out
      }
    }
  }

  if (!holeOut && !pasteOut) return

  pushUndoFor(ctx, target.id, undoBounds, undoSnapshot)
  // Hole first, paste second: where the two rectangles overlap, the moved
  // content must be what remains visible.
  if (holeOut) {
    ctx.writeTexRect(target.id, holeBounds.x0, holeBounds.y0, boundsW(holeBounds), boundsH(holeBounds), holeOut)
  }
  if (pasteOut) {
    ctx.writeTexRect(target.id, pasteBounds.x0, pasteBounds.y0, boundsW(pasteBounds), boundsH(pasteBounds), pasteOut)
  }
  ctx.invalidate()
}

/** Both region tools share one lasso-then-drag state machine. */
function createRegionTool(kind: 'patch' | 'content-move'): ToolHandler {
  let region: RegionState | null = null
  let lasso: Pt[] | null = null

  const preview = (ctx: ToolContext) => (g: CanvasRenderingContext2D) => {
    if (lasso && lasso.length > 1) {
      tracePath(g, ctx, lasso, true)
      strokeOutline(g)
      return
    }
    const r = region
    if (!r) return
    if (r.outline && r.outline.length > 1) {
      tracePath(g, ctx, r.outline, true)
      strokeOutline(g)
      if (r.dragging && (r.dx !== 0 || r.dy !== 0)) {
        tracePath(g, ctx, r.outline.map(p => ({ x: p.x + r.dx, y: p.y + r.dy })), true)
        strokeOutline(g)
      }
    } else {
      // Region taken from the selection: outline its bounding box instead.
      const box = r.dragging ? offsetBounds(r.bounds, r.dx, r.dy) : r.bounds
      tracePath(g, ctx, [
        { x: box.x0, y: box.y0 }, { x: box.x1, y: box.y0 },
        { x: box.x1, y: box.y1 }, { x: box.x0, y: box.y1 },
      ], true)
      strokeOutline(g)
    }
  }

  const reset = (ctx: ToolContext): void => {
    region = null
    lasso = null
    ctx.setPreview(null)
    ctx.setStatus(null)
  }

  return {
    cursor: kind === 'content-move' ? 'move' : 'crosshair',

    onDown(ctx, p) {
      const target = activeTarget(ctx)
      if (!target) return

      // Dragging an existing region (ours, or the current selection).
      if (region && region.layerId === target.id && insideRegion(region, p.x, p.y)) {
        region.dragging = true
        region.dragFrom = { x: p.x, y: p.y }
        region.dx = 0
        region.dy = 0
        ctx.setPreview(preview(ctx))
        return
      }
      if (!region && selectionAt(ctx, p.x, p.y)) {
        const fromSel = regionFromSelection(ctx, target.id)
        if (fromSel) {
          fromSel.dragging = true
          fromSel.dragFrom = { x: p.x, y: p.y }
          region = fromSel
          ctx.setPreview(preview(ctx))
          return
        }
      }

      // Otherwise: draw a new lasso.
      region = null
      lasso = [{ x: p.x, y: p.y }]
      ctx.setPreview(preview(ctx))
    },

    onMove(ctx, p) {
      if (lasso) {
        const last = lasso[lasso.length - 1]
        if (!last || Math.abs(last.x - p.x) >= 0.75 || Math.abs(last.y - p.y) >= 0.75) {
          if (lasso.length >= MAX_STROKE_POINTS) lasso[lasso.length - 1] = { x: p.x, y: p.y }
          else lasso.push({ x: p.x, y: p.y })
        }
        ctx.repaintOverlay()
        return
      }
      const r = region
      if (r?.dragging) {
        r.dx = Math.round(p.x - r.dragFrom.x)
        r.dy = Math.round(p.y - r.dragFrom.y)
        ctx.setStatus(`Δ ${r.dx}, ${r.dy}`)
        ctx.repaintOverlay()
      }
    },

    onUp(ctx, p) {
      const target = activeTarget(ctx)

      if (lasso) {
        const pts = lasso
        lasso = null
        if (!target || pts.length < 3) { reset(ctx); return }
        const bounds = padClip(polyBounds(pts), 0, ctx.docW, ctx.docH)
        if (boundsEmpty(bounds) || boundsArea(bounds) > MAX_SOLVE_PIXELS) { reset(ctx); return }
        const mask = buildPolygonMask(pts, bounds)
        let any = false
        for (let i = 0; i < mask.length; i++) if (mask[i] !== 0) { any = true; break }
        if (!any) { reset(ctx); return }
        region = {
          layerId: target.id, mask, bounds, outline: pts,
          dragging: false, dragFrom: { x: p.x, y: p.y }, dx: 0, dy: 0,
        }
        ctx.setPreview(preview(ctx))
        ctx.repaintOverlay()
        return
      }

      const r = region
      if (!r?.dragging) return
      r.dragging = false
      r.dx = Math.round(p.x - r.dragFrom.x)
      r.dy = Math.round(p.y - r.dragFrom.y)
      ctx.setStatus(null)

      if (kind === 'patch') {
        applyPatch(ctx, r)
        // The repaired area stays selected so it can be re-sampled elsewhere.
        r.dx = 0
        r.dy = 0
        ctx.setPreview(preview(ctx))
        ctx.repaintOverlay()
      } else {
        applyContentMove(ctx, r)
        // The content is gone from where it was: drop the region rather than
        // leave a marquee around a hole that no longer holds it.
        reset(ctx)
      }
    },

    onCancel(ctx) {
      reset(ctx)
    },

    onCommit(ctx) {
      reset(ctx)
    },
  }
}

registerTool('patch', createRegionTool('patch'))
registerTool('content-move', createRegionTool('content-move'))

// ── 5. red-eye ───────────────────────────────────────────────────────────────

/*
 * Ported from GIMP's red-eye removal (`plug-ins/common/red-eye-removal.c`, now
 * the `gegl:red-eye-removal` operation), GPLv3+. The weights below are the
 * plug-in's own; a pixel is treated as red-eye when its weighted red beats both
 * its weighted green and its weighted blue, and its red channel is then pulled
 * down to the weighted mean of the other two.
 */
const RED_FACTOR = 0.5133333
const GREEN_FACTOR = 1.0
const BLUE_FACTOR = 0.1933333

/** GIMP's neutral default; `(threshold - 0.4) * 2` is the slack in the comparison. */
const RED_EYE_THRESHOLD = 0.4

/** Returns the corrected red channel (0..255), or `null` when the pixel is not red-eye. */
function redEyeReduce(r: number, g: number, b: number, threshold: number): number | null {
  const adjustedRed = (r / 255) * RED_FACTOR
  const adjustedGreen = (g / 255) * GREEN_FACTOR
  const adjustedBlue = (b / 255) * BLUE_FACTOR
  const slack = (threshold - 0.4) * 2
  if (adjustedRed < adjustedGreen - slack || adjustedRed < adjustedBlue - slack) return null
  const fixed = (adjustedGreen + adjustedBlue) / (2.0 * RED_FACTOR)
  return clamp(Math.round(fixed * 255), 0, 255)
}

let redEyeState: StrokeState | null = null

function applyRedEye(ctx: ToolContext, state: StrokeState): void {
  const target = activeTarget(ctx)
  if (!target || target.id !== state.layerId) return

  let bounds: Bounds
  let coverage: Uint8Array

  // A single click with an active selection treats the whole selection as the
  // pupil — the usual way to correct an eye that has already been selected.
  const singleClick = state.points.length <= 1
  const fromSelection = singleClick && ctx.selection !== null
    ? regionFromSelection(ctx, target.id)
    : null

  if (fromSelection) {
    bounds = fromSelection.bounds
    coverage = fromSelection.mask
  } else {
    bounds = padClip(strokeBounds(state.points, state.radius), 0, ctx.docW, ctx.docH)
    if (boundsEmpty(bounds)) return
    coverage = buildStrokeMask(state.points, state.radius, state.hardness, bounds)
  }
  if (boundsEmpty(bounds) || boundsArea(bounds) > MAX_SOLVE_PIXELS) return

  const w = boundsW(bounds)
  const h = boundsH(bounds)
  const orig = readRectClamped(ctx, target.id, bounds)
  if (!orig) return

  // The correction is per-pixel, so the "result" buffer is just the original
  // with its red channel rewritten where the test fires.
  const result = new Float32Array(4 * (w * h + 1))
  const effective = new Uint8Array(w * h)
  let any = false
  for (let i = 0; i < w * h; i++) {
    const p = i * 4
    result[p] = orig[p]
    result[p + 1] = orig[p + 1]
    result[p + 2] = orig[p + 2]
    result[p + 3] = orig[p + 3]
    if (coverage[i] === 0) continue
    const fixed = redEyeReduce(orig[p], orig[p + 1], orig[p + 2], RED_EYE_THRESHOLD)
    if (fixed === null) continue
    result[p] = fixed
    effective[i] = coverage[i]
    any = true
  }
  if (!any) return

  const out = orig.slice()
  const touched = applyResult({
    ctx,
    bounds,
    orig,
    out,
    coverage: effective,
    result,
    opacity: 1,
    lockAlpha: target.lockAlpha,
    honourSelection: true,
    keepAlpha: true,
  })
  if (!touched) return

  pushUndoFor(ctx, target.id, bounds, orig)
  ctx.writeTexRect(target.id, bounds.x0, bounds.y0, w, h, out)
  ctx.invalidate()
}

registerTool('red-eye', {
  cursor: 'crosshair',
  onDown(ctx, p) {
    const target = activeTarget(ctx)
    if (!target) return
    const state: StrokeState = {
      layerId: target.id,
      points: [{ x: p.x, y: p.y }],
      radius: brushRadius(ctx),
      hardness: norm01(ctx.brushHardness, 1),
      cursor: { x: p.x, y: p.y },
      offsetX: 0,
      offsetY: 0,
    }
    redEyeState = state
    ctx.setPreview(g => {
      drawStrokeTrail(g, ctx, state.points, state.radius)
      drawBrushCursor(g, ctx, state.cursor, state.radius)
    })
  },
  onMove(ctx, p) {
    const state = redEyeState
    if (!state) return
    state.cursor = { x: p.x, y: p.y }
    pushStrokePoint(state, p.x, p.y)
    ctx.repaintOverlay()
  },
  onUp(ctx, p) {
    const state = redEyeState
    redEyeState = null
    if (!state) return
    pushStrokePoint(state, p.x, p.y)
    ctx.setPreview(null)
    applyRedEye(ctx, state)
  },
  onCancel(ctx) {
    redEyeState = null
    ctx.setPreview(null)
  },
} satisfies ToolHandler)
