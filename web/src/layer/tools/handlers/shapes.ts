// Shape family (F18) and the gradient tool (F12) of the Layer editor.
//
// ── Attribution ──────────────────────────────────────────────────────────────
// The gradient geometry — the five Photoshop shapes — is a TypeScript
// re-implementation of GIMP's gradient operation:
//   app/operations/gimpoperationgradient.c  (`gradient_calc_*_factor`,
//                                            `gradient_dither_pixel`)
//   app/core/gimpdrawable-gradient.c        (gradient application to a drawable)
// GIMP is free software distributed under the GNU General Public License v3 or
// later, © Spencer Kimball, Peter Mattis and the GIMP development team. Kubuno
// is licensed under the GNU AGPL v3, which is compatible with the GPL v3, so
// this derived work keeps the same copyleft. The formulas below follow the
// original closely (including the `offset` parameter and the pixel-centre
// +0.5 shift) so that Kubuno gradients match GIMP's output.
//
// Photoshop's five shapes map onto GIMP's types as:
//   linear    → GIMP_GRADIENT_LINEAR
//   radial    → GIMP_GRADIENT_RADIAL
//   angle     → GIMP_GRADIENT_CONICAL_ASYMMETRIC  (one full turn)
//   reflected → GIMP_GRADIENT_BILINEAR
//   diamond   → GIMP_GRADIENT_SQUARE              (max(|x|,|y|) metric)
//
// ── Rasterisation ────────────────────────────────────────────────────────────
// Shapes are converted to closed polygons and rasterised through one scanline
// coverage sampler: exact analytic coverage horizontally, `SUB_ROWS` sub-scan
// lines vertically, non-zero winding. Overlapping polygons of the same
// orientation therefore union exactly, which is what lets a stroke be expressed
// as "one quad per segment + one disc per joint" without double-counting.
//
// This file is self-contained on purpose: a tool only ever talks to the editor
// through `ToolContext`.
import type { ToolId } from '../types'
import { registerTool } from './registry'
import type { Rect, ToolContext, ToolHandler, ToolPointer } from './types'

// ─────────────────────────────────────────────────────────────────────────────
// Options
//
// `ToolContext` deliberately exposes no option bag, so the tool keeps its own
// and the options bar pushes values in through `applyToolValues()`. Defaults
// mirror `toolDefs.ts`, which stays the single source of truth for the UI.
// ─────────────────────────────────────────────────────────────────────────────

/** The five Photoshop gradient shapes. */
export type GradientShape = 'linear' | 'radial' | 'angle' | 'reflected' | 'diamond'

/** Colour ramps the tool can build without a gradient library. */
export type GradientPreset = 'fg-bg' | 'fg-transparent' | 'bg-transparent' | 'black-white'

/** Interpolation space of the ramp. */
export type GradientMethod = 'perceptual' | 'linear' | 'classic'

export interface GradientOptions {
  preset: GradientPreset
  shape: GradientShape
  /** 0…100. */
  opacity: number
  reverse: boolean
  dither: boolean
  /** When false the ramp's alpha is ignored (Photoshop's "Transparency"). */
  transparency: boolean
  method: GradientMethod
}

export type ShapeKind = 'rect' | 'rrect' | 'ellipse' | 'polygon' | 'line' | 'custom'

/** `'fg'` / `'bg'` resolve against the context, `'none'` disables the pass. */
export type PaintSource = 'fg' | 'bg' | 'none' | string

export interface ShapeOptions {
  fill: PaintSource
  stroke: PaintSource
  strokeWidth: number
  strokeStyle: 'solid' | 'dashed' | 'dotted'
  antialias: boolean
  /** 0…100, applied on top of the resolved colours. */
  opacity: number
  /** Rounded-rectangle corner radius. */
  cornerRadius: number
  /** The plain rectangle's own corner radius — 0 by default, unlike `rrect`. */
  rectRadius: number
  /** Regular polygon: 3…100 sides. */
  sides: number
  star: boolean
  /** Star waist as a percentage of the outer radius (1…99). */
  starIndent: number
  /** Line tool thickness. */
  lineWeight: number
  arrowStart: boolean
  arrowEnd: boolean
  /** Arrowhead width / length as a percentage of the line weight. */
  arrowWidth: number
  arrowLength: number
  /** Id of the preset used by `shape-custom`. */
  customShape: string
}

const DEFAULT_GRADIENT: GradientOptions = {
  preset: 'fg-bg', shape: 'linear', opacity: 100,
  reverse: false, dither: true, transparency: true, method: 'perceptual',
}

const DEFAULT_SHAPE: ShapeOptions = {
  fill: 'fg', stroke: 'none', strokeWidth: 1, strokeStyle: 'solid', antialias: true,
  opacity: 100, cornerRadius: 8, rectRadius: 0, sides: 5, star: false, starIndent: 50,
  lineWeight: 5, arrowStart: false, arrowEnd: false, arrowWidth: 500, arrowLength: 1000,
  customShape: 'star',
}

let gradientOpts: GradientOptions = { ...DEFAULT_GRADIENT }
let shapeOpts: ShapeOptions = { ...DEFAULT_SHAPE }

export const getGradientOptions = (): GradientOptions => ({ ...gradientOpts })
export const getShapeOptions = (): ShapeOptions => ({ ...shapeOpts })

export function setGradientOptions(patch: Partial<GradientOptions>): void {
  gradientOpts = { ...gradientOpts, ...patch }
}

export function setShapeOptions(patch: Partial<ShapeOptions>): void {
  shapeOpts = { ...shapeOpts, ...patch }
}

/** Resets both option sets — used by the tests and by "reset tool". */
export function resetShapeToolOptions(): void {
  gradientOpts = { ...DEFAULT_GRADIENT }
  shapeOpts = { ...DEFAULT_SHAPE }
}

/** A raw option bag as the options bar holds it (`ToolValues`-shaped). */
export type OptionValues = Readonly<Record<string, string | number | boolean>>

const asNum = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback
const asBool = (v: unknown, fallback: boolean): boolean =>
  typeof v === 'boolean' ? v : fallback
const asStr = (v: unknown, fallback: string): string =>
  typeof v === 'string' && v.length > 0 ? v : fallback

const GRADIENT_SHAPES: readonly GradientShape[] = ['linear', 'radial', 'angle', 'reflected', 'diamond']
const GRADIENT_METHODS: readonly GradientMethod[] = ['perceptual', 'linear', 'classic']
const STROKE_STYLES: readonly ShapeOptions['strokeStyle'][] = ['solid', 'dashed', 'dotted']

/**
 * Bridges the declarative options bar onto the tool's own state. The editor may
 * call it whenever values change; unknown ids are ignored, so `toolDefs.ts` can
 * grow without breaking the tool.
 */
export function applyToolValues(tool: ToolId, values: OptionValues): void {
  if (tool === 'gradient') {
    const shape = asStr(values['gradient-type'], gradientOpts.shape)
    const method = asStr(values['gradient-method'], gradientOpts.method)
    setGradientOptions({
      preset: asStr(values['gradient'], gradientOpts.preset) as GradientPreset,
      shape: (GRADIENT_SHAPES as readonly string[]).includes(shape) ? (shape as GradientShape) : gradientOpts.shape,
      opacity: asNum(values['opacity'], gradientOpts.opacity),
      reverse: asBool(values['reverse'], gradientOpts.reverse),
      dither: asBool(values['dither'], gradientOpts.dither),
      transparency: asBool(values['transparency'], gradientOpts.transparency),
      method: (GRADIENT_METHODS as readonly string[]).includes(method) ? (method as GradientMethod) : gradientOpts.method,
    })
    return
  }
  if (!tool.startsWith('shape-')) return
  const style = asStr(values['stroke-style'], shapeOpts.strokeStyle)
  setShapeOptions({
    fill: asStr(values['fill'], shapeOpts.fill),
    stroke: asStr(values['stroke'], shapeOpts.stroke),
    strokeWidth: asNum(values['stroke-width'], shapeOpts.strokeWidth),
    strokeStyle: (STROKE_STYLES as readonly string[]).includes(style)
      ? (style as ShapeOptions['strokeStyle'])
      : shapeOpts.strokeStyle,
    antialias: asBool(values['antialias'], shapeOpts.antialias),
    opacity: asNum(values['opacity'], shapeOpts.opacity),
    // `corner-radius` exists on both rectangle tools with different defaults, so
    // each keeps its own slot instead of stomping the other's value.
    cornerRadius: tool === 'shape-rrect' ? asNum(values['corner-radius'], shapeOpts.cornerRadius) : shapeOpts.cornerRadius,
    rectRadius: tool === 'shape-rect' ? asNum(values['corner-radius'], shapeOpts.rectRadius) : shapeOpts.rectRadius,
    sides: asNum(values['sides'], shapeOpts.sides),
    star: asBool(values['star'], shapeOpts.star),
    starIndent: asNum(values['star-indent'], shapeOpts.starIndent),
    lineWeight: asNum(values['line-weight'], shapeOpts.lineWeight),
    arrowStart: asBool(values['arrow-start'], shapeOpts.arrowStart),
    arrowEnd: asBool(values['arrow-end'], shapeOpts.arrowEnd),
    arrowWidth: asNum(values['arrow-width'], shapeOpts.arrowWidth),
    arrowLength: asNum(values['arrow-length'], shapeOpts.arrowLength),
    customShape: asStr(values['custom-shape'], shapeOpts.customShape),
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Colour helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Straight, non-premultiplied RGBA in 0…1. */
export interface RGBA { r: number; g: number; b: number; a: number }

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

/** `#rgb`, `#rrggbb`, `#rrggbbaa`; anything unparsable falls back to opaque black. */
export function parseColor(hex: string): RGBA {
  const s = hex.trim().replace(/^#/, '')
  const hx = (at: number, len: number): number => {
    const part = len === 1 ? s[at] + s[at] : s.slice(at, at + 2)
    const n = parseInt(part, 16)
    return Number.isFinite(n) ? n / 255 : 0
  }
  if (/^[0-9a-fA-F]{3}$/.test(s)) return { r: hx(0, 1), g: hx(1, 1), b: hx(2, 1), a: 1 }
  if (/^[0-9a-fA-F]{6}$/.test(s)) return { r: hx(0, 2), g: hx(2, 2), b: hx(4, 2), a: 1 }
  if (/^[0-9a-fA-F]{8}$/.test(s)) return { r: hx(0, 2), g: hx(2, 2), b: hx(4, 2), a: hx(6, 2) }
  return { r: 0, g: 0, b: 0, a: 1 }
}

/** sRGB transfer function, used by the `linear` interpolation method. */
const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
const toSrgb = (c: number): number => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055)

/** Resolves a `fill`/`stroke` option against the current fore/background. */
function resolveSource(src: PaintSource, ctx: ToolContext): RGBA | null {
  if (src === 'none') return null
  if (src === 'fg') return parseColor(ctx.foreground)
  if (src === 'bg') return parseColor(ctx.background)
  return parseColor(src)
}

// ─────────────────────────────────────────────────────────────────────────────
// Geometry primitives
// ─────────────────────────────────────────────────────────────────────────────

/** A closed polygon: flat `[x0, y0, x1, y1, …]` in document space. */
export type Polygon = number[]

interface Edge { x0: number; y0: number; x1: number; y1: number; ymin: number; ymax: number }

/** Vertical sub-samples per pixel row. Horizontal coverage is exact. */
const SUB_ROWS = 16

/** Integer bounding box of a set of polygons, expanded to whole pixels. */
export function polysBBox(polys: readonly Polygon[]): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const p of polys) {
    for (let i = 0; i + 1 < p.length; i += 2) {
      if (p[i] < x0) x0 = p[i]
      if (p[i] > x1) x1 = p[i]
      if (p[i + 1] < y0) y0 = p[i + 1]
      if (p[i + 1] > y1) y1 = p[i + 1]
    }
  }
  if (!Number.isFinite(x0)) return { x: 0, y: 0, w: 0, h: 0 }
  const ix0 = Math.floor(x0), iy0 = Math.floor(y0)
  return { x: ix0, y: iy0, w: Math.ceil(x1) - ix0 + 1, h: Math.ceil(y1) - iy0 + 1 }
}

function buildEdges(polys: readonly Polygon[]): Edge[] {
  const edges: Edge[] = []
  for (const p of polys) {
    const n = p.length >> 1
    if (n < 2) continue
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      const x0 = p[i * 2], y0 = p[i * 2 + 1], x1 = p[j * 2], y1 = p[j * 2 + 1]
      if (y0 === y1) continue // horizontal edges never cross a sub-scanline
      if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) || !Number.isFinite(y1)) continue
      edges.push({ x0, y0, x1, y1, ymin: Math.min(y0, y1), ymax: Math.max(y0, y1) })
    }
  }
  return edges
}

/** Adds the exact horizontal coverage of `[xa, xb)` on one row of the map. */
function addSpan(cov: Float32Array, base: number, w: number, xa: number, xb: number, weight: number): void {
  let a = xa, b = xb
  if (b <= a) return
  if (a < 0) a = 0
  if (b > w) b = w
  if (b <= a) return
  const ia = Math.floor(a)
  const ib = Math.min(w - 1, Math.floor(b - 1e-9))
  if (ia < 0 || ia > ib) return
  if (ia === ib) {
    cov[base + ia] += (b - a) * weight
    return
  }
  cov[base + ia] += (ia + 1 - a) * weight
  for (let i = ia + 1; i < ib; i++) cov[base + i] += weight
  cov[base + ib] += (b - ib) * weight
}

/**
 * Anti-aliased coverage of `polys` over `rect`, non-zero winding.
 * Returns one float per pixel in 0…1 — 0 outside, 1 fully inside, anything in
 * between on an edge. `aa = false` snaps to a hard 0/1 test (a 1-sample mask).
 */
export function rasterizePolys(polys: readonly Polygon[], rect: Rect, aa = true): Float32Array {
  const { x, y, w, h } = rect
  const cov = new Float32Array(Math.max(0, w * h))
  if (w <= 0 || h <= 0) return cov
  const edges = buildEdges(polys)
  if (edges.length === 0) return cov

  const rows = aa ? SUB_ROWS : 1
  const weight = 1 / rows
  const xs: number[] = []
  const dirs: number[] = []

  // Active-edge sweep: sub-scanlines are visited in increasing Y, so each edge
  // enters the active set once and leaves once. Without it a stroke made of a
  // few thousand quads would rescan every edge on every sub-scanline.
  edges.sort((a, b) => a.ymin - b.ymin)
  let pending = 0
  let active: Edge[] = []

  for (let py = 0; py < h; py++) {
    const base = py * w
    for (let k = 0; k < rows; k++) {
      const sy = y + py + (k + 0.5) / rows
      while (pending < edges.length && edges[pending].ymin <= sy) active.push(edges[pending++])
      if (active.length === 0) continue
      let live = 0
      for (let i = 0; i < active.length; i++) if (active[i].ymax > sy) active[live++] = active[i]
      if (live !== active.length) active = active.slice(0, live)
      xs.length = 0
      dirs.length = 0
      for (let e = 0; e < active.length; e++) {
        const ed = active[e]
        if (sy < ed.ymin) continue
        const t = (sy - ed.y0) / (ed.y1 - ed.y0)
        xs.push(ed.x0 + t * (ed.x1 - ed.x0))
        dirs.push(ed.y1 > ed.y0 ? 1 : -1)
      }
      const n = xs.length
      if (n < 2) continue
      // Insertion sort: crossing counts are tiny and mostly already ordered.
      for (let i = 1; i < n; i++) {
        const cx = xs[i], cd = dirs[i]
        let j = i - 1
        while (j >= 0 && xs[j] > cx) { xs[j + 1] = xs[j]; dirs[j + 1] = dirs[j]; j-- }
        xs[j + 1] = cx; dirs[j + 1] = cd
      }
      let winding = 0
      let spanStart = 0
      for (let i = 0; i < n; i++) {
        const before = winding
        winding += dirs[i]
        if (before === 0 && winding !== 0) spanStart = xs[i]
        else if (before !== 0 && winding === 0) addSpan(cov, base, w, spanStart - x, xs[i] - x, weight)
      }
    }
  }
  if (!aa) for (let i = 0; i < cov.length; i++) cov[i] = cov[i] >= 0.5 ? 1 : 0
  else for (let i = 0; i < cov.length; i++) if (cov[i] > 1) cov[i] = 1
  return cov
}

// ── Shape builders ───────────────────────────────────────────────────────────

/** Rectangle → one polygon, wound counter-clockwise in maths orientation. */
export function rectPoly(r: Rect): Polygon[] {
  if (r.w <= 0 || r.h <= 0) return []
  const { x, y, w, h } = r
  return [[x, y + h, x + w, y + h, x + w, y, x, y]]
}

/** Arc samples for a corner of radius `r`, ~1 px chords, at least 3 points. */
const arcSteps = (r: number): number => Math.max(3, Math.min(64, Math.ceil(r * 0.8) + 3))

export function roundRectPoly(r: Rect, radius: number): Polygon[] {
  if (r.w <= 0 || r.h <= 0) return []
  const rad = clamp(radius, 0, Math.min(r.w, r.h) / 2)
  if (rad <= 0.01) return rectPoly(r)
  const { x, y, w, h } = r
  const steps = arcSteps(rad)
  const pts: number[] = []
  // Counter-clockwise in maths orientation, i.e. visually clockwise from the
  // bottom-left corner because document Y grows downward.
  const corner = (cx: number, cy: number, from: number, to: number): void => {
    for (let i = 0; i <= steps; i++) {
      const a = from + (to - from) * (i / steps)
      pts.push(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad)
    }
  }
  corner(x + rad, y + h - rad, Math.PI, Math.PI / 2)          // bottom-left
  corner(x + w - rad, y + h - rad, Math.PI / 2, 0)            // bottom-right
  corner(x + w - rad, y + rad, 0, -Math.PI / 2)               // top-right
  corner(x + rad, y + rad, -Math.PI / 2, -Math.PI)            // top-left
  return [pts]
}

export function ellipsePoly(r: Rect): Polygon[] {
  if (r.w <= 0 || r.h <= 0) return []
  const rx = r.w / 2, ry = r.h / 2
  const cx = r.x + rx, cy = r.y + ry
  // One vertex per ~0.5 px of perimeter keeps the polygonal error far below the
  // coverage sampler's own resolution.
  const steps = clamp(Math.ceil(Math.PI * (rx + ry) * 2), 24, 2048)
  const pts: number[] = []
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2
    pts.push(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry)
  }
  return [pts]
}

/** Regular polygon (or star) inscribed in `r`, first vertex pointing up. */
export function polygonPoly(r: Rect, sides: number, star: boolean, indentPct: number): Polygon[] {
  if (r.w <= 0 || r.h <= 0) return []
  const n = Math.round(clamp(sides, 3, 100))
  const rx = r.w / 2, ry = r.h / 2
  const cx = r.x + rx, cy = r.y + ry
  const inner = clamp(indentPct, 1, 99) / 100
  const pts: number[] = []
  const count = star ? n * 2 : n
  for (let i = 0; i < count; i++) {
    const a = -Math.PI / 2 + (i / count) * Math.PI * 2
    const k = star && i % 2 === 1 ? inner : 1
    pts.push(cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k)
  }
  return [pts]
}

function reversePoly(p: Polygon): Polygon {
  const out: number[] = []
  for (let i = (p.length >> 1) - 1; i >= 0; i--) out.push(p[i * 2], p[i * 2 + 1])
  return out
}

/** Shoelace area; positive means counter-clockwise in maths orientation. */
export function signedArea(p: Polygon): number {
  let s = 0
  const n = p.length >> 1
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    s += p[i * 2] * p[j * 2 + 1] - p[j * 2] * p[i * 2 + 1]
  }
  return s / 2
}

/** Forces the orientation the rasteriser's union relies on. */
const orient = (p: Polygon): Polygon => (signedArea(p) < 0 ? reversePoly(p) : p)

// ── Stroking ─────────────────────────────────────────────────────────────────

/** A polyline: flat coordinates, `closed` repeats the first point implicitly. */
export interface Polyline { pts: number[]; closed: boolean }

const discPoly = (cx: number, cy: number, r: number): Polygon => {
  const steps = clamp(Math.ceil(r * 4), 8, 64)
  const pts: number[] = []
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2
    pts.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r)
  }
  return pts
}

/**
 * Stroke outline as a union of per-segment quads and per-joint discs. The
 * rasteriser's non-zero rule turns that soup into one clean outline, and round
 * joins/caps come for free.
 */
export function strokePolys(lines: readonly Polyline[], width: number): Polygon[] {
  const hw = width / 2
  if (!(hw > 0)) return []
  const out: Polygon[] = []
  for (const line of lines) {
    const n = line.pts.length >> 1
    if (n === 0) continue
    if (n === 1) { out.push(orient(discPoly(line.pts[0], line.pts[1], hw))); continue }
    const segs = line.closed ? n : n - 1
    for (let i = 0; i < segs; i++) {
      const j = (i + 1) % n
      const ax = line.pts[i * 2], ay = line.pts[i * 2 + 1]
      const bx = line.pts[j * 2], by = line.pts[j * 2 + 1]
      const dx = bx - ax, dy = by - ay
      const len = Math.hypot(dx, dy)
      if (len < 1e-9) continue
      const nx = (dy / len) * hw, ny = (-dx / len) * hw
      out.push(orient([ax + nx, ay + ny, bx + nx, by + ny, bx - nx, by - ny, ax - nx, ay - ny]))
    }
    // Round joins (and caps on open polylines: cheap, and visually the closest
    // to Photoshop's default round-join stroke).
    const first = line.closed ? 0 : 1
    const last = line.closed ? n : n - 1
    for (let i = first; i < last; i++) out.push(orient(discPoly(line.pts[i * 2], line.pts[i * 2 + 1], hw)))
    if (!line.closed && hw > 0.75) {
      out.push(orient(discPoly(line.pts[0], line.pts[1], hw)))
      out.push(orient(discPoly(line.pts[(n - 1) * 2], line.pts[(n - 1) * 2 + 1], hw)))
    }
  }
  return out
}

/** Splits a polyline into dashes; `on`/`off` are in document pixels. */
export function dashPolyline(line: Polyline, on: number, off: number): Polyline[] {
  if (!(on > 0) || !(off > 0)) return [line]
  const n = line.pts.length >> 1
  if (n < 2) return [line]
  const out: Polyline[] = []
  let cur: number[] = [line.pts[0], line.pts[1]]
  let remaining = on
  let drawing = true
  const segs = line.closed ? n : n - 1
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n
    let ax = line.pts[i * 2], ay = line.pts[i * 2 + 1]
    const bx = line.pts[j * 2], by = line.pts[j * 2 + 1]
    let len = Math.hypot(bx - ax, by - ay)
    while (len > remaining) {
      const t = remaining / len
      const mx = ax + (bx - ax) * t, my = ay + (by - ay) * t
      if (drawing) { cur.push(mx, my); out.push({ pts: cur, closed: false }); cur = [] }
      else cur = [mx, my]
      ax = mx; ay = my
      len -= remaining
      drawing = !drawing
      remaining = drawing ? on : off
    }
    remaining -= len
    if (drawing) cur.push(bx, by)
  }
  if (drawing && cur.length >= 4) out.push({ pts: cur, closed: false })
  return out
}

// ── Custom shape library ─────────────────────────────────────────────────────

/**
 * A preset stored in a normalised [0,1]² box, Y downward. Splitting the library
 * out like this is what lets a richer shape set (an imported .csh library, a
 * server-side catalogue…) plug in later: it only has to call
 * `registerCustomShape`.
 */
export interface CustomShapeDef {
  id: string
  /** One or more closed subpaths of normalised coordinates. */
  paths: readonly (readonly number[])[]
}

const CUSTOM_SHAPES = new Map<string, CustomShapeDef>()

export function registerCustomShape(def: CustomShapeDef): void {
  CUSTOM_SHAPES.set(def.id, def)
}

export const customShapeIds = (): string[] => [...CUSTOM_SHAPES.keys()]
export const getCustomShape = (id: string): CustomShapeDef | undefined => CUSTOM_SHAPES.get(id)

/** Five-branch star, outer radius 0.5, waist at 0.42 of it. */
function starPath(): number[] {
  const pts: number[] = []
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i / 10) * Math.PI * 2
    const r = i % 2 === 0 ? 0.5 : 0.21
    pts.push(0.5 + Math.cos(a) * r, 0.5 + Math.sin(a) * r)
  }
  return pts
}

/** Classic parametric heart, sampled and normalised into the unit box. */
function heartPath(): number[] {
  const raw: number[] = []
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  const steps = 120
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2
    const x = 16 * Math.pow(Math.sin(t), 3)
    // Negated: the curve is defined Y-up, the document is Y-down.
    const y = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t))
    raw.push(x, y)
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (y < minY) minY = y; if (y > maxY) maxY = y
  }
  const sx = maxX - minX, sy = maxY - minY
  const out: number[] = []
  for (let i = 0; i < raw.length; i += 2) out.push((raw[i] - minX) / sx, (raw[i + 1] - minY) / sy)
  return out
}

registerCustomShape({ id: 'star', paths: [starPath()] })
registerCustomShape({ id: 'heart', paths: [heartPath()] })
registerCustomShape({
  id: 'arrow',
  paths: [[0, 0.3, 0.6, 0.3, 0.6, 0.05, 1, 0.5, 0.6, 0.95, 0.6, 0.7, 0, 0.7]],
})
registerCustomShape({ id: 'triangle', paths: [[0.5, 0, 1, 1, 0, 1]] })
registerCustomShape({
  id: 'lightning',
  paths: [[0.55, 0, 0.15, 0.55, 0.45, 0.55, 0.3, 1, 0.85, 0.4, 0.5, 0.4, 0.75, 0]],
})

/**
 * Maps a preset into `r`. Winding is preserved verbatim: with the non-zero
 * rule, a subpath wound against the others becomes a HOLE, which is how a
 * richer library can express rings and cut-outs.
 */
export function customPoly(r: Rect, id: string): Polygon[] {
  if (r.w <= 0 || r.h <= 0) return []
  const def = CUSTOM_SHAPES.get(id) ?? CUSTOM_SHAPES.get('star')
  if (!def) return []
  return def.paths.map(path => {
    const pts: number[] = []
    for (let i = 0; i + 1 < path.length; i += 2) pts.push(r.x + path[i] * r.w, r.y + path[i + 1] * r.h)
    return pts
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Gradient — GIMP-derived factor functions
//
// `dist` is the gradient length, `(x, y)` the pixel offset from the start
// point, `offset` the ramp's dead zone in percent (0 for the Photoshop tool).
// Faithful ports of `gradient_calc_*_factor` in gimpoperationgradient.c.
// ─────────────────────────────────────────────────────────────────────────────

export function calcLinearFactor(dist: number, vx: number, vy: number, offset: number, x: number, y: number): number {
  if (dist === 0) return 0
  const off = offset / 100
  const rat = (vx * x + vy * y) / dist
  if (rat >= 0 && rat < off) return 0
  if (off === 1) return rat > 1 ? 2 : rat < 0 ? -1 : rat === 1 ? 1 : 0
  if (rat < 0) return rat / (1 - off)
  return (rat - off) / (1 - off)
}

/** Photoshop "reflected" — GIMP's bilinear. */
export function calcBilinearFactor(dist: number, vx: number, vy: number, offset: number, x: number, y: number): number {
  if (dist === 0) return 0
  const off = offset / 100
  const rat = (vx * x + vy * y) / dist
  const ar = Math.abs(rat)
  if (ar < off) return 0
  if (off === 1) return ar > 1 ? 2 : ar === 1 ? 1 : 0
  return (ar - off) / (1 - off)
}

export function calcRadialFactor(dist: number, offset: number, x: number, y: number): number {
  if (dist === 0) return 0
  const off = offset / 100
  const rat = Math.sqrt(x * x + y * y) / dist
  if (rat < off) return 0
  if (off === 1) return rat > 1 ? 2 : rat === 1 ? 1 : 0
  return (rat - off) / (1 - off)
}

/** Photoshop "diamond" — GIMP's square: the Chebyshev metric. */
export function calcSquareFactor(dist: number, offset: number, x: number, y: number): number {
  if (dist === 0) return 0
  const off = offset / 100
  const rat = Math.max(Math.abs(x), Math.abs(y)) / dist
  if (rat < off) return 0
  if (off === 1) return rat > 1 ? 2 : rat === 1 ? 1 : 0
  return (rat - off) / (1 - off)
}

/** Photoshop "angle" — GIMP's asymmetric conical: one full turn around the start. */
export function calcConicalAsymFactor(dist: number, ax: number, ay: number, offset: number, x: number, y: number): number {
  if (dist === 0) return 0
  if (x === 0 && y === 0) return 0.5
  const ang0 = Math.atan2(ax, ay) + Math.PI
  const ang1 = Math.atan2(x, y) + Math.PI
  let ang = ang1 - ang0
  if (ang < 0) ang += 2 * Math.PI
  const rat = Math.pow(ang / (2 * Math.PI), offset / 10 + 1)
  return clamp01(rat)
}

/**
 * Compiles the per-gradient constants once and returns the per-pixel factor
 * function. Hoisting `dist`, the unit axis and the conical reference angle out
 * of the inner loop is what keeps a full-page gradient interactive.
 */
export function makeFactorFn(
  shape: GradientShape, sx: number, sy: number, ex: number, ey: number,
): (x: number, y: number) => number {
  const dx = ex - sx, dy = ey - sy
  if (shape === 'diamond') {
    const dist = Math.max(Math.abs(dx), Math.abs(dy))
    if (dist === 0) return () => 0
    return (x, y) => {
      const r = Math.max(Math.abs(x - sx), Math.abs(y - sy)) / dist
      return r > 1 ? 1 : r
    }
  }
  const dist = Math.hypot(dx, dy)
  if (dist === 0) return () => 0
  const vx = dx / dist, vy = dy / dist
  switch (shape) {
    case 'radial':
      return (x, y) => {
        const px = x - sx, py = y - sy
        const r = Math.sqrt(px * px + py * py) / dist
        return r > 1 ? 1 : r
      }
    case 'reflected':
      return (x, y) => {
        const r = Math.abs((vx * (x - sx) + vy * (y - sy)) / dist)
        return r > 1 ? 1 : r
      }
    case 'angle': {
      const ang0 = Math.atan2(vx, vy) + Math.PI
      const TAU = 2 * Math.PI
      return (x, y) => {
        const px = x - sx, py = y - sy
        if (px === 0 && py === 0) return 0.5
        let ang = Math.atan2(px, py) + Math.PI - ang0
        if (ang < 0) ang += TAU
        return clamp01(ang / TAU)
      }
    }
    default:
      return (x, y) => {
        const r = (vx * (x - sx) + vy * (y - sy)) / dist
        return r < 0 ? 0 : r > 1 ? 1 : r
      }
  }
}

/**
 * Blend factor of one pixel centre, for any of the five shapes. Kept as the
 * readable reference implementation (and the one the tests pin down);
 * `renderGradient` goes through `makeFactorFn` for speed.
 */
export function gradientFactor(
  shape: GradientShape, x: number, y: number,
  sx: number, sy: number, ex: number, ey: number,
): number {
  const dx = ex - sx, dy = ey - sy
  const px = x - sx, py = y - sy
  if (shape === 'diamond') {
    return clamp01(calcSquareFactor(Math.max(Math.abs(dx), Math.abs(dy)), 0, px, py))
  }
  const dist = Math.hypot(dx, dy)
  if (dist === 0) return 0
  const vx = dx / dist, vy = dy / dist
  if (shape === 'radial') return clamp01(calcRadialFactor(dist, 0, px, py))
  if (shape === 'reflected') return clamp01(calcBilinearFactor(dist, vx, vy, 0, px, py))
  if (shape === 'angle') return clamp01(calcConicalAsymFactor(dist, vx, vy, 0, px, py))
  return clamp01(calcLinearFactor(dist, vx, vy, 0, px, py))
}

// ── Ramp ─────────────────────────────────────────────────────────────────────

const RAMP_SIZE = 1024

/** The two stops a preset resolves to. */
export function presetStops(preset: GradientPreset, fg: RGBA, bg: RGBA): [RGBA, RGBA] {
  switch (preset) {
    case 'fg-transparent': return [fg, { ...fg, a: 0 }]
    case 'bg-transparent': return [bg, { ...bg, a: 0 }]
    case 'black-white':    return [{ r: 0, g: 0, b: 0, a: 1 }, { r: 1, g: 1, b: 1, a: 1 }]
    case 'fg-bg':
    default:               return [fg, bg]
  }
}

/**
 * Pre-computed ramp, GIMP's `gradient_cache` idea: sampling a LUT instead of
 * interpolating per pixel keeps the inner loop tight and the output stable.
 * Layout is RGBA floats in 0…1, `RAMP_SIZE` entries.
 */
export function buildRamp(
  a: RGBA, b: RGBA, method: GradientMethod, reverse: boolean, transparency: boolean,
): Float32Array {
  const ramp = new Float32Array(RAMP_SIZE * 4)
  const lin = method === 'linear'
  for (let i = 0; i < RAMP_SIZE; i++) {
    const t0 = i / (RAMP_SIZE - 1)
    const t = reverse ? 1 - t0 : t0
    const alpha = transparency ? a.a + (b.a - a.a) * t : 1
    let r: number, g: number, bl: number
    if (lin) {
      // Interpolate in linear light, then return to sRGB — no dark band in the
      // middle of complementary ramps.
      r = toSrgb(toLinear(a.r) + (toLinear(b.r) - toLinear(a.r)) * t)
      g = toSrgb(toLinear(a.g) + (toLinear(b.g) - toLinear(a.g)) * t)
      bl = toSrgb(toLinear(a.b) + (toLinear(b.b) - toLinear(a.b)) * t)
    } else if (method === 'perceptual') {
      // Premultiplied sRGB interpolation: a stop fading to transparent keeps
      // its hue instead of drifting towards the other stop's colour.
      const pa = a.a, pb = b.a
      const wa = pa * (1 - t), wb = pb * t
      const sum = wa + wb
      r = sum > 0 ? (a.r * wa + b.r * wb) / sum : a.r + (b.r - a.r) * t
      g = sum > 0 ? (a.g * wa + b.g * wb) / sum : a.g + (b.g - a.g) * t
      bl = sum > 0 ? (a.b * wa + b.b * wb) / sum : a.b + (b.b - a.b) * t
    } else {
      r = a.r + (b.r - a.r) * t
      g = a.g + (b.g - a.g) * t
      bl = a.b + (b.b - a.b) * t
    }
    ramp[i * 4] = clamp01(r)
    ramp[i * 4 + 1] = clamp01(g)
    ramp[i * 4 + 2] = clamp01(bl)
    ramp[i * 4 + 3] = clamp01(alpha)
  }
  return ramp
}

/**
 * Deterministic 32-bit xorshift. GIMP seeds `GRand` randomly; a fixed seed keeps
 * a redraw (and a test run) reproducible, which matters far more here.
 */
export class Xorshift {
  private s: number
  constructor(seed = 0x9e3779b9) { this.s = seed >>> 0 || 1 }
  next(): number {
    let x = this.s
    x ^= x << 13; x >>>= 0
    x ^= x >>> 17
    x ^= x << 5; x >>>= 0
    this.s = x
    return x
  }
}

/**
 * GIMP's `gradient_dither_pixel`: uniform noise of ±half an 8-bit code added
 * before quantisation. Without it an 8-bit ramp shows visible banding wherever
 * the gradient is longer than 256 px.
 */
function ditherChannel(v: number, noise: number): number {
  return clamp01(v + noise / 65536 - 0.5 / 256)
}

// ─────────────────────────────────────────────────────────────────────────────
// Pixel writing
// ─────────────────────────────────────────────────────────────────────────────

interface Target {
  layerId: string
  px: Uint8Array
  lockAlpha: boolean
}

/** Active layer, once every guard has passed. Null means "do nothing". */
function acquireTarget(ctx: ToolContext): Target | null {
  const id = ctx.activeId
  if (!id) return null
  const layer = ctx.layerById(id)
  if (!layer) return null
  if (layer.locked) return null
  if (layer.type === 'group' || layer.type === 'adjustment') return null
  const px = ctx.readTex(id)
  if (!px || px.length < ctx.docW * ctx.docH * 4) return null
  return { layerId: id, px, lockAlpha: !!layer.lockAlpha }
}

/** Clips a rect to the document; returns null when nothing is left. */
function clipRect(r: Rect, docW: number, docH: number): Rect | null {
  const x0 = Math.max(0, Math.floor(r.x))
  const y0 = Math.max(0, Math.floor(r.y))
  const x1 = Math.min(docW, Math.ceil(r.x + r.w))
  const y1 = Math.min(docH, Math.ceil(r.y + r.h))
  if (x1 <= x0 || y1 <= y0) return null
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/** Source-over of one straight-RGBA sample, honouring `lockAlpha`. */
function blendPixel(px: Uint8Array, di: number, r: number, g: number, b: number, sA: number, lockAlpha: boolean): void {
  if (sA <= 0) return
  const origA = px[di + 3]
  if (lockAlpha && origA === 0) return
  const dA = origA / 255
  const outA = sA + dA * (1 - sA)
  if (outA < 1e-4) { if (!lockAlpha) px[di + 3] = 0; return }
  px[di] = Math.round(clamp((r * 255 * sA + px[di] * dA * (1 - sA)) / outA, 0, 255))
  px[di + 1] = Math.round(clamp((g * 255 * sA + px[di + 1] * dA * (1 - sA)) / outA, 0, 255))
  px[di + 2] = Math.round(clamp((b * 255 * sA + px[di + 2] * dA * (1 - sA)) / outA, 0, 255))
  px[di + 3] = lockAlpha ? origA : Math.round(clamp(outA * 255, 0, 255))
}

/** Copies a sub-rectangle out of a full-document buffer. */
function cropRect(src: Uint8Array, docW: number, r: Rect): Uint8Array {
  const out = new Uint8Array(r.w * r.h * 4)
  for (let row = 0; row < r.h; row++) {
    const so = ((r.y + row) * docW + r.x) * 4
    out.set(src.subarray(so, so + r.w * 4), row * r.w * 4)
  }
  return out
}

/** Paints a coverage map with a single colour. */
function paintCoverage(
  ctx: ToolContext, target: Target, rect: Rect, cov: Float32Array, colour: RGBA, opacity: number,
): void {
  const { docW } = ctx
  const sel = ctx.selection
  const { px, lockAlpha } = target
  for (let y = 0; y < rect.h; y++) {
    const dy = rect.y + y
    for (let x = 0; x < rect.w; x++) {
      const c = cov[y * rect.w + x]
      if (c <= 0) continue
      const dxi = (dy * docW + rect.x + x)
      const di = dxi << 2
      if (di + 3 >= px.length) continue
      const selCov = sel ? sel[dxi] / 255 : 1
      if (selCov <= 0) continue
      blendPixel(px, di, colour.r, colour.g, colour.b, clamp01(c) * colour.a * opacity * selCov, lockAlpha)
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Drag geometry
// ─────────────────────────────────────────────────────────────────────────────

interface DragState {
  layerId: string
  x0: number
  y0: number
  x1: number
  y1: number
  shift: boolean
  alt: boolean
}

/**
 * The rectangle a drag defines. Shift constrains it to a square, Alt anchors it
 * on the press point instead of one of its corners.
 */
export function dragRect(x0: number, y0: number, x1: number, y1: number, shift: boolean, alt: boolean): Rect {
  let dx = x1 - x0, dy = y1 - y0
  if (shift) {
    const m = Math.max(Math.abs(dx), Math.abs(dy))
    dx = dx < 0 ? -m : m
    dy = dy < 0 ? -m : m
  }
  if (alt) return { x: x0 - Math.abs(dx), y: y0 - Math.abs(dy), w: Math.abs(dx) * 2, h: Math.abs(dy) * 2 }
  return { x: Math.min(x0, x0 + dx), y: Math.min(y0, y0 + dy), w: Math.abs(dx), h: Math.abs(dy) }
}

/** Snaps a vector to the nearest multiple of 45°, keeping its length. */
export function snap45(x0: number, y0: number, x1: number, y1: number): [number, number] {
  const dx = x1 - x0, dy = y1 - y0
  const len = Math.hypot(dx, dy)
  if (len < 1e-9) return [x1, y1]
  const step = Math.PI / 4
  const a = Math.round(Math.atan2(dy, dx) / step) * step
  return [x0 + Math.cos(a) * len, y0 + Math.sin(a) * len]
}

/** The two endpoints of a line/gradient drag (Shift → 45°, Alt → centred). */
export function dragLine(d: DragState): [number, number, number, number] {
  let [ex, ey] = d.shift ? snap45(d.x0, d.y0, d.x1, d.y1) : [d.x1, d.y1]
  let sx = d.x0, sy = d.y0
  if (d.alt) { sx = d.x0 - (ex - d.x0); sy = d.y0 - (ey - d.y0) }
  if (!Number.isFinite(sx) || !Number.isFinite(sy)) { sx = d.x0; sy = d.y0 }
  if (!Number.isFinite(ex) || !Number.isFinite(ey)) { ex = d.x0; ey = d.y0 }
  return [sx, sy, ex, ey]
}

// ─────────────────────────────────────────────────────────────────────────────
// Shape tools
// ─────────────────────────────────────────────────────────────────────────────

/** Fill polygons of a shape for the current drag and options. */
export function shapeGeometry(kind: ShapeKind, d: DragState, o: ShapeOptions): Polygon[] {
  if (kind === 'line') return [] // the line tool only has a stroke
  const r = dragRect(d.x0, d.y0, d.x1, d.y1, d.shift, d.alt)
  if (r.w <= 0 || r.h <= 0) return []
  switch (kind) {
    case 'rect':    return o.rectRadius > 0 ? roundRectPoly(r, o.rectRadius) : rectPoly(r)
    case 'rrect':   return roundRectPoly(r, o.cornerRadius)
    case 'ellipse': return ellipsePoly(r)
    case 'polygon': return polygonPoly(r, o.sides, o.star, o.starIndent)
    case 'custom':  return customPoly(r, o.customShape)
  }
}

/** Closed outlines of a shape, used to build its stroke. */
function shapeOutlines(kind: ShapeKind, d: DragState, o: ShapeOptions): Polyline[] {
  if (kind === 'line') {
    const [sx, sy, ex, ey] = dragLine(d)
    return [{ pts: [sx, sy, ex, ey], closed: false }]
  }
  return shapeGeometry(kind, d, o).map(p => ({ pts: p, closed: true }))
}

/** Arrowhead triangle at `(tx, ty)` pointing away from `(fx, fy)`. */
function arrowHead(tx: number, ty: number, fx: number, fy: number, o: ShapeOptions): Polygon | null {
  const dx = tx - fx, dy = ty - fy
  const len = Math.hypot(dx, dy)
  if (len < 1e-6) return null
  const ux = dx / len, uy = dy / len
  const w = (o.arrowWidth / 100) * o.lineWeight
  const l = (o.arrowLength / 100) * o.lineWeight
  if (!(w > 0) || !(l > 0)) return null
  const bx = tx - ux * l, by = ty - uy * l
  const nx = -uy * (w / 2), ny = ux * (w / 2)
  return orient([tx, ty, bx + nx, by + ny, bx - nx, by - ny])
}

/** Every polygon a shape contributes, split by the colour that paints it. */
interface ShapePass { polys: Polygon[]; colour: RGBA }

function shapePasses(kind: ShapeKind, d: DragState, o: ShapeOptions, ctx: ToolContext): ShapePass[] {
  const passes: ShapePass[] = []
  const fill = resolveSource(o.fill, ctx)
  const stroke = resolveSource(o.stroke, ctx)

  if (kind === 'line') {
    // The line tool paints with its fill colour (Photoshop's shape line uses the
    // stroke slot, but the brief asks for the foreground colour by default).
    const colour = fill ?? stroke ?? parseColor(ctx.foreground)
    const [sx, sy, ex, ey] = dragLine(d)
    if (Math.hypot(ex - sx, ey - sy) < 0.5) return passes // a click draws nothing
    const weight = Math.max(0.1, o.lineWeight)
    let lines: Polyline[] = [{ pts: [sx, sy, ex, ey], closed: false }]
    if (o.strokeStyle !== 'solid') {
      const on = o.strokeStyle === 'dotted' ? weight : weight * 3
      lines = lines.flatMap(l => dashPolyline(l, on, weight * 2))
    }
    const polys = strokePolys(lines, weight)
    if (o.arrowEnd) { const h = arrowHead(ex, ey, sx, sy, o); if (h) polys.push(h) }
    if (o.arrowStart) { const h = arrowHead(sx, sy, ex, ey, o); if (h) polys.push(h) }
    if (polys.length) passes.push({ polys, colour })
    return passes
  }

  const geo = shapeGeometry(kind, d, o)
  if (geo.length === 0) return passes
  if (fill) passes.push({ polys: geo, colour: fill })
  if (stroke && o.strokeWidth > 0) {
    let lines: Polyline[] = geo.map(p => ({ pts: p, closed: true }))
    if (o.strokeStyle !== 'solid') {
      const on = o.strokeStyle === 'dotted' ? o.strokeWidth : o.strokeWidth * 3
      lines = lines.flatMap(l => dashPolyline(l, on, o.strokeWidth * 2))
    }
    const sp = strokePolys(lines, o.strokeWidth)
    if (sp.length) passes.push({ polys: sp, colour: stroke })
  }
  return passes
}

/** Union bbox of every pass, already clipped to the document. */
function passesBBox(passes: readonly ShapePass[], ctx: ToolContext): Rect | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const pass of passes) {
    const b = polysBBox(pass.polys)
    if (b.w <= 0 || b.h <= 0) continue
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y)
    x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h)
  }
  if (!Number.isFinite(x0)) return null
  // One pixel of slack: coverage of an edge can bleed into the next pixel.
  return clipRect({ x: x0 - 1, y: y0 - 1, w: x1 - x0 + 2, h: y1 - y0 + 2 }, ctx.docW, ctx.docH)
}

function commitShape(kind: ShapeKind, ctx: ToolContext, d: DragState): void {
  const o = getShapeOptions()
  const passes = shapePasses(kind, d, o, ctx)
  if (passes.length === 0) return
  const rect = passesBBox(passes, ctx)
  if (!rect) return

  const target = acquireTarget(ctx)
  if (!target || target.layerId !== d.layerId) return

  // History BEFORE the first write, on the bounding box only.
  ctx.pushUndoRect(target.layerId, target.px, { x0: rect.x, y0: rect.y, x1: rect.x + rect.w, y1: rect.y + rect.h })

  const opacity = clamp(o.opacity, 0, 100) / 100
  for (const pass of passes) {
    const cov = rasterizePolys(pass.polys, rect, o.antialias)
    paintCoverage(ctx, target, rect, cov, pass.colour, opacity)
  }
  ctx.writeTexRect(target.layerId, rect.x, rect.y, rect.w, rect.h, cropRect(target.px, ctx.docW, rect))
  ctx.invalidate()
}

/** Screen-space outline drawn while dragging. */
function drawShapePreview(kind: ShapeKind, ctx: ToolContext, d: DragState): (c: CanvasRenderingContext2D) => void {
  const o = getShapeOptions()
  const outlines = shapeOutlines(kind, d, o)
  return (c: CanvasRenderingContext2D) => {
    if (outlines.length === 0) return
    c.save()
    c.lineWidth = 1
    c.setLineDash([4, 3])
    for (const pass of [0, 1]) {
      c.strokeStyle = pass === 0 ? 'rgba(0,0,0,0.8)' : 'rgba(255,255,255,0.9)'
      c.lineDashOffset = pass === 0 ? 0 : 4
      for (const line of outlines) {
        const n = line.pts.length >> 1
        if (n < 2) continue
        c.beginPath()
        for (let i = 0; i < n; i++) {
          const [sx, sy] = ctx.docToScreen(line.pts[i * 2], line.pts[i * 2 + 1])
          if (i === 0) c.moveTo(sx, sy); else c.lineTo(sx, sy)
        }
        if (line.closed) c.closePath()
        c.stroke()
      }
    }
    c.restore()
  }
}

function shapeStatus(kind: ShapeKind, d: DragState): string {
  if (kind === 'line') {
    const [sx, sy, ex, ey] = dragLine(d)
    const len = Math.hypot(ex - sx, ey - sy)
    const ang = (Math.atan2(-(ey - sy), ex - sx) * 180) / Math.PI
    return `${len.toFixed(1)} px · ${ang.toFixed(1)}°`
  }
  const r = dragRect(d.x0, d.y0, d.x1, d.y1, d.shift, d.alt)
  return `${Math.round(r.w)} × ${Math.round(r.h)} px`
}

function makeShapeTool(kind: ShapeKind): ToolHandler {
  let drag: DragState | null = null

  const clear = (ctx: ToolContext): void => {
    drag = null
    ctx.setPreview(null)
    ctx.setStatus(null)
  }

  return {
    cursor: 'crosshair',

    onDown(ctx, p) {
      const target = acquireTarget(ctx)
      if (!target) { drag = null; return }
      drag = { layerId: target.layerId, x0: p.x, y0: p.y, x1: p.x, y1: p.y, shift: p.shiftKey, alt: p.altKey }
    },

    onMove(ctx, p) {
      if (!drag) return
      drag.x1 = p.x; drag.y1 = p.y; drag.shift = p.shiftKey; drag.alt = p.altKey
      ctx.setPreview(drawShapePreview(kind, ctx, drag))
      ctx.setStatus(shapeStatus(kind, drag))
    },

    onUp(ctx, p) {
      if (!drag) return
      drag.x1 = p.x; drag.y1 = p.y; drag.shift = p.shiftKey; drag.alt = p.altKey
      const d = drag
      clear(ctx)
      commitShape(kind, ctx, d)
    },

    onCancel(ctx) { clear(ctx) },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Gradient tool
// ─────────────────────────────────────────────────────────────────────────────

/** Region a gradient fills: the selection's bounds, else the whole document. */
function gradientRect(ctx: ToolContext): Rect | null {
  const sel = ctx.selection
  if (!sel || sel.length < ctx.docW * ctx.docH) return clipRect({ x: 0, y: 0, w: ctx.docW, h: ctx.docH }, ctx.docW, ctx.docH)
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
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }
}

/**
 * Renders the gradient into `px` (a full-document buffer) over `rect`.
 * Exported so the test bench can drive it without a `ToolContext`.
 */
export function renderGradient(
  px: Uint8Array, docW: number, rect: Rect, sel: Uint8Array | null, lockAlpha: boolean,
  sx: number, sy: number, ex: number, ey: number, o: GradientOptions, fg: RGBA, bg: RGBA,
  seed = 0x9e3779b9,
): void {
  const [c0, c1] = presetStops(o.preset, fg, bg)
  const ramp = buildRamp(c0, c1, o.method, o.reverse, o.transparency)
  const opacity = clamp(o.opacity, 0, 100) / 100
  if (opacity <= 0) return
  const rnd = new Xorshift(seed)
  const last = RAMP_SIZE - 1
  const factorAt = makeFactorFn(o.shape, sx, sy, ex, ey)

  for (let y = 0; y < rect.h; y++) {
    const dy = rect.y + y
    for (let x = 0; x < rect.w; x++) {
      const dx = rect.x + x
      const idxPix = dy * docW + dx
      const di = idxPix << 2
      if (di + 3 >= px.length) continue
      const selCov = sel ? sel[idxPix] / 255 : 1
      if (selCov <= 0) continue
      // GIMP samples the pixel CENTRE.
      const f = factorAt(dx + 0.5, dy + 0.5)
      const ri = Math.round(f * last) * 4
      let r = ramp[ri], g = ramp[ri + 1], b = ramp[ri + 2]
      let a = ramp[ri + 3]
      if (o.dither) {
        const n = rnd.next()
        if (r === g && g === b) {
          const d = n & 0xff
          r = ditherChannel(r, d); g = ditherChannel(g, d); b = ditherChannel(b, d)
        } else {
          r = ditherChannel(r, n & 0xff)
          g = ditherChannel(g, (n >>> 8) & 0xff)
          b = ditherChannel(b, (n >>> 16) & 0xff)
        }
        if (a > 0 && a < 1) a = ditherChannel(a, (n >>> 24) & 0xff)
      }
      blendPixel(px, di, r, g, b, a * opacity * selCov, lockAlpha)
    }
  }
}

function commitGradient(ctx: ToolContext, d: DragState): void {
  const [sx, sy, ex, ey] = dragLine(d)
  if (Math.hypot(ex - sx, ey - sy) < 0.5) return // zero-length drag: nothing to do
  const target = acquireTarget(ctx)
  if (!target || target.layerId !== d.layerId) return
  const rect = gradientRect(ctx)
  if (!rect) return

  ctx.pushUndoRect(target.layerId, target.px, { x0: rect.x, y0: rect.y, x1: rect.x + rect.w, y1: rect.y + rect.h })
  renderGradient(
    target.px, ctx.docW, rect, ctx.selection, target.lockAlpha,
    sx, sy, ex, ey, getGradientOptions(), parseColor(ctx.foreground), parseColor(ctx.background),
  )
  ctx.writeTexRect(target.layerId, rect.x, rect.y, rect.w, rect.h, cropRect(target.px, ctx.docW, rect))
  ctx.invalidate()
}

function drawGradientPreview(ctx: ToolContext, d: DragState): (c: CanvasRenderingContext2D) => void {
  const [sx, sy, ex, ey] = dragLine(d)
  return (c: CanvasRenderingContext2D) => {
    const [ax, ay] = ctx.docToScreen(sx, sy)
    const [bx, by] = ctx.docToScreen(ex, ey)
    c.save()
    c.lineWidth = 1
    for (const pass of [0, 1]) {
      c.strokeStyle = pass === 0 ? 'rgba(0,0,0,0.8)' : 'rgba(255,255,255,0.9)'
      c.setLineDash(pass === 0 ? [] : [4, 4])
      c.beginPath(); c.moveTo(ax, ay); c.lineTo(bx, by); c.stroke()
    }
    c.setLineDash([])
    // Handles: filled square on the start, hollow circle on the end.
    c.fillStyle = 'rgba(255,255,255,0.95)'
    c.strokeStyle = 'rgba(0,0,0,0.85)'
    c.fillRect(ax - 3, ay - 3, 6, 6); c.strokeRect(ax - 3, ay - 3, 6, 6)
    c.beginPath(); c.arc(bx, by, 4, 0, Math.PI * 2); c.fill(); c.stroke()
    c.restore()
  }
}

const gradientTool: ToolHandler = (() => {
  let drag: DragState | null = null
  const clear = (ctx: ToolContext): void => { drag = null; ctx.setPreview(null); ctx.setStatus(null) }
  return {
    cursor: 'crosshair',
    onDown(ctx: ToolContext, p: ToolPointer) {
      const target = acquireTarget(ctx)
      if (!target) { drag = null; return }
      drag = { layerId: target.layerId, x0: p.x, y0: p.y, x1: p.x, y1: p.y, shift: p.shiftKey, alt: p.altKey }
    },
    onMove(ctx: ToolContext, p: ToolPointer) {
      if (!drag) return
      drag.x1 = p.x; drag.y1 = p.y; drag.shift = p.shiftKey; drag.alt = p.altKey
      const [sx, sy, ex, ey] = dragLine(drag)
      ctx.setPreview(drawGradientPreview(ctx, drag))
      const ang = (Math.atan2(-(ey - sy), ex - sx) * 180) / Math.PI
      ctx.setStatus(`${Math.hypot(ex - sx, ey - sy).toFixed(1)} px · ${ang.toFixed(1)}°`)
    },
    onUp(ctx: ToolContext, p: ToolPointer) {
      if (!drag) return
      drag.x1 = p.x; drag.y1 = p.y; drag.shift = p.shiftKey; drag.alt = p.altKey
      const d = drag
      clear(ctx)
      commitGradient(ctx, d)
    },
    onCancel(ctx: ToolContext) { clear(ctx) },
  }
})()

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

registerTool('gradient', gradientTool)
registerTool('shape-rect', makeShapeTool('rect'))
registerTool('shape-rrect', makeShapeTool('rrect'))
registerTool('shape-ellipse', makeShapeTool('ellipse'))
registerTool('shape-polygon', makeShapeTool('polygon'))
registerTool('shape-line', makeShapeTool('line'))
registerTool('shape-custom', makeShapeTool('custom'))

/** Handlers this file owns — handy for the integrator's smoke tests. */
export const SHAPE_TOOL_IDS: readonly ToolId[] = [
  'gradient', 'shape-rect', 'shape-rrect', 'shape-ellipse', 'shape-polygon', 'shape-line', 'shape-custom',
]
