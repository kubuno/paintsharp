// Pen family (F15) and path-selection family (F17) of the Layer editor.
//
// The eight tools registered here — `pen`, `pen-free`, `pen-curvature`,
// `anchor-add`, `anchor-remove`, `anchor-convert`, `path-select` and
// `direct-select` — all drive ONE path model that lives in this module. Nothing
// about it leaks into the editor: paths are pure data, every pixel of feedback
// goes through `ctx.setPreview`, and no tool here ever writes a layer texture or
// pushes a pixel history entry.
//
// ── Attribution ─────────────────────────────────────────────────────────────
// The path model (anchors carrying two control handles, De Casteljau insertion
// that leaves the curve untouched, symmetric handle mirroring, anchor deletion
// that drops an anchor together with its two handles, the EDGE "collapse the
// handles onto the anchor" conversion) is a TypeScript re-implementation of
// GIMP's vector core:
//   app/path/gimpanchor.h, app/path/gimpstroke.c,
//   app/path/gimpbezierstroke.c, app/tools/gimppathtool.c
// GIMP is Copyright (C) 1995-2025 Spencer Kimball, Peter Mattis and the GIMP
// developers, and is licensed under the GNU General Public License version 3 or
// later. Kubuno is licensed under the GNU Affero General Public License version
// 3 or later, which is compatible with that origin.
//
// One deliberate difference: GIMP keeps handles as separate `GimpAnchor`s of
// type CONTROL inside a single flat list ordered "handle, anchor, handle, …",
// which forces a lot of list walking. We fold both handles into the anchor
// record. The geometry is identical; only the bookkeeping is simpler.
//
// The free-hand pen fits the captured polyline with the classic least-squares
// cubic fitting algorithm of Philip J. Schneider, "An Algorithm for
// Automatically Fitting Digitized Curves", Graphics Gems (1990) — a real curve
// fit, not a polyline simplification.
import { registerTool } from './registry'
import type { ToolContext, ToolHandler, ToolPointer } from './types'

// ═══════════════════════════════════════════════════════════════════════════
//  Path model
// ═══════════════════════════════════════════════════════════════════════════

/** A point in DOCUMENT space. Every coordinate in this module is document space. */
export interface Vec { x: number; y: number }

/**
 * `smooth` keeps the two handles collinear and mirrored when one is dragged
 * (GIMP's `GIMP_ANCHOR_FEATURE_SYMMETRIC`); `corner` lets them move freely.
 */
export type AnchorKind = 'smooth' | 'corner'

/**
 * One anchor point and its two control handles, in ABSOLUTE document
 * coordinates (as GIMP stores them, rather than as offsets).
 *
 * `in` controls the segment ARRIVING at the anchor, `out` the segment LEAVING
 * it. A handle sitting exactly on the anchor means "no tangent on that side",
 * which is how a freshly clicked pen point starts out.
 */
export interface Anchor {
  x: number
  y: number
  ix: number
  iy: number
  ox: number
  oy: number
  kind: AnchorKind
}

/** A single sub-path: an ordered anchor list, open or closed. */
export interface Path {
  anchors: Anchor[]
  closed: boolean
}

/** A cubic Bézier segment: start, first control, second control, end. */
export type Cubic = readonly [Vec, Vec, Vec, Vec]

/** Which part of an anchor a reference points at. */
export type PointPart = 'anchor' | 'in' | 'out'

/** Identifies one draggable point in the model. */
export interface PointRef {
  path: number
  anchor: number
  part: PointPart
}

// ── Construction ────────────────────────────────────────────────────────────

/** A fresh anchor whose handles sit on the point itself (a corner). */
export function makeAnchor(x: number, y: number, kind: AnchorKind = 'corner'): Anchor {
  return { x, y, ix: x, iy: y, ox: x, oy: y, kind }
}

export const makePath = (anchors: Anchor[] = [], closed = false): Path => ({ anchors, closed })

const cloneAnchor = (a: Anchor): Anchor => ({ ...a })

export const clonePath = (p: Path): Path => ({ anchors: p.anchors.map(cloneAnchor), closed: p.closed })

/** Number of drawable segments: `n` when closed, `n - 1` when open. */
export function segmentCount(p: Path): number {
  const n = p.anchors.length
  if (n < 2) return 0
  return p.closed ? n : n - 1
}

/** The two anchor indices bounding segment `i`. */
export function segmentEnds(p: Path, i: number): [number, number] | null {
  const n = p.anchors.length
  if (i < 0 || i >= segmentCount(p)) return null
  return [i, (i + 1) % n]
}

/** Control polygon of segment `i`, or null when the index is out of range. */
export function segmentCubic(p: Path, i: number): Cubic | null {
  const ends = segmentEnds(p, i)
  if (!ends) return null
  const a = p.anchors[ends[0]]
  const b = p.anchors[ends[1]]
  return [
    { x: a.x, y: a.y },
    { x: a.ox, y: a.oy },
    { x: b.ix, y: b.iy },
    { x: b.x, y: b.y },
  ]
}

// ── Small vector helpers ────────────────────────────────────────────────────

const dist2 = (a: Vec, b: Vec): number => {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return dx * dx + dy * dy
}
const dist = (a: Vec, b: Vec): number => Math.sqrt(dist2(a, b))
const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y })
const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y })
const scale = (a: Vec, k: number): Vec => ({ x: a.x * k, y: a.y * k })
const dot = (a: Vec, b: Vec): number => a.x * b.x + a.y * b.y
function normalize(v: Vec): Vec {
  const len = Math.hypot(v.x, v.y)
  return len > 1e-12 ? { x: v.x / len, y: v.y / len } : { x: 0, y: 0 }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Bézier geometry
// ═══════════════════════════════════════════════════════════════════════════

/** Point of a cubic at parameter `t`, evaluated with the Bernstein basis. */
export function cubicAt(c: Cubic, t: number): Vec {
  const mt = 1 - t
  const a = mt * mt * mt
  const b = 3 * mt * mt * t
  const d = 3 * mt * t * t
  const e = t * t * t
  return {
    x: a * c[0].x + b * c[1].x + d * c[2].x + e * c[3].x,
    y: a * c[0].y + b * c[1].y + d * c[2].y + e * c[3].y,
  }
}

/** First derivative of a cubic at `t` (the tangent vector, not normalised). */
export function cubicTangent(c: Cubic, t: number): Vec {
  const mt = 1 - t
  const a = 3 * mt * mt
  const b = 6 * mt * t
  const d = 3 * t * t
  return {
    x: a * (c[1].x - c[0].x) + b * (c[2].x - c[1].x) + d * (c[3].x - c[2].x),
    y: a * (c[1].y - c[0].y) + b * (c[2].y - c[1].y) + d * (c[3].y - c[2].y),
  }
}

const mix = (a: Vec, b: Vec, t: number): Vec => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
})

/**
 * De Casteljau subdivision at `t`. The two returned cubics reproduce the
 * original curve EXACTLY (up to floating-point round-off): the left one covers
 * `[0, t]`, the right one `[t, 1]`. This is the operation that makes
 * `anchor-add` non-destructive, and it mirrors
 * `gimp_bezier_stroke_anchor_insert()`.
 */
export function splitCubic(c: Cubic, t: number): [Cubic, Cubic] {
  const p01 = mix(c[0], c[1], t)
  const p12 = mix(c[1], c[2], t)
  const p23 = mix(c[2], c[3], t)
  const p012 = mix(p01, p12, t)
  const p123 = mix(p12, p23, t)
  const mid = mix(p012, p123, t)
  return [
    [c[0], p01, p012, mid],
    [mid, p123, p23, c[3]],
  ]
}

/** True when the control polygon is flat enough to be drawn as a line. */
function isFlat(c: Cubic, tol: number): boolean {
  // Distance of both control points from the chord, compared without a sqrt.
  const ux = 3 * c[1].x - 2 * c[0].x - c[3].x
  const uy = 3 * c[1].y - 2 * c[0].y - c[3].y
  const vx = 3 * c[2].x - c[0].x - 2 * c[3].x
  const vy = 3 * c[2].y - c[0].y - 2 * c[3].y
  const m = Math.max(ux * ux, vx * vx) + Math.max(uy * uy, vy * vy)
  return m <= 16 * tol * tol
}

/** Adaptive flattening; appends every point but the first one to `out`. */
function flattenCubic(c: Cubic, tol: number, out: Vec[], depth = 0): void {
  if (depth > 16 || isFlat(c, tol)) {
    out.push({ x: c[3].x, y: c[3].y })
    return
  }
  const [l, r] = splitCubic(c, 0.5)
  flattenCubic(l, tol, out, depth + 1)
  flattenCubic(r, tol, out, depth + 1)
}

/**
 * Polyline approximation of a path, in document space. The first point is
 * included; a closed path does NOT repeat its first point at the end.
 */
export function flattenPath(p: Path, tol = 0.15): Vec[] {
  const out: Vec[] = []
  if (p.anchors.length === 0) return out
  out.push({ x: p.anchors[0].x, y: p.anchors[0].y })
  const segs = segmentCount(p)
  for (let i = 0; i < segs; i++) {
    const c = segmentCubic(p, i)
    if (c) flattenCubic(c, tol, out)
  }
  if (p.closed && out.length > 1) out.pop() // the last point is the first one again
  return out
}

/** Closest point of one segment to `pt`, by coarse sampling then refinement. */
function nearestOnCubic(c: Cubic, pt: Vec): { t: number; d: number } {
  const STEPS = 24
  let bestT = 0
  let bestD = Infinity
  for (let i = 0; i <= STEPS; i++) {
    const t = i / STEPS
    const d = dist2(cubicAt(c, t), pt)
    if (d < bestD) {
      bestD = d
      bestT = t
    }
  }
  // Ternary refinement over the bracketing interval — the distance function is
  // unimodal there for any reasonable segment.
  let lo = Math.max(0, bestT - 1 / STEPS)
  let hi = Math.min(1, bestT + 1 / STEPS)
  for (let i = 0; i < 40 && hi - lo > 1e-7; i++) {
    const m1 = lo + (hi - lo) / 3
    const m2 = hi - (hi - lo) / 3
    if (dist2(cubicAt(c, m1), pt) < dist2(cubicAt(c, m2), pt)) hi = m2
    else lo = m1
  }
  const t = (lo + hi) / 2
  return { t, d: dist(cubicAt(c, t), pt) }
}

/** Closest point over a whole path. */
export function nearestOnPath(p: Path, pt: Vec): { seg: number; t: number; d: number } | null {
  const segs = segmentCount(p)
  if (segs === 0) return null
  let best: { seg: number; t: number; d: number } | null = null
  for (let i = 0; i < segs; i++) {
    const c = segmentCubic(p, i)
    if (!c) continue
    const hit = nearestOnCubic(c, pt)
    if (!best || hit.d < best.d) best = { seg: i, t: hit.t, d: hit.d }
  }
  return best
}

/** Non-zero winding containment test against the flattened outline. */
export function pathContains(p: Path, pt: Vec): boolean {
  const poly = flattenPath(p)
  if (poly.length < 3) return false
  let winding = 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    if (a.y <= pt.y) {
      if (b.y > pt.y && (b.x - a.x) * (pt.y - a.y) - (pt.x - a.x) * (b.y - a.y) > 0) winding++
    } else if (b.y <= pt.y && (b.x - a.x) * (pt.y - a.y) - (pt.x - a.x) * (b.y - a.y) < 0) {
      winding--
    }
  }
  return winding !== 0
}

// ═══════════════════════════════════════════════════════════════════════════
//  Path edition — the primitives the eight tools share
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Insert an anchor on segment `seg` at parameter `t`, WITHOUT deforming the
 * curve: the segment is split with De Casteljau and the neighbouring handles
 * are retracted to the values the subdivision produced. Returns the index of
 * the new anchor, or -1 when the segment does not exist.
 *
 * Port of `gimp_bezier_stroke_anchor_insert()`.
 */
export function insertAnchor(p: Path, seg: number, t: number): number {
  const ends = segmentEnds(p, seg)
  const c = segmentCubic(p, seg)
  if (!ends || !c) return -1
  const clamped = Math.min(1, Math.max(0, t))
  const [left, right] = splitCubic(c, clamped)

  const a = p.anchors[ends[0]]
  const b = p.anchors[ends[1]]
  a.ox = left[1].x
  a.oy = left[1].y
  b.ix = right[2].x
  b.iy = right[2].y

  const mid: Anchor = {
    x: left[3].x,
    y: left[3].y,
    ix: left[2].x,
    iy: left[2].y,
    ox: right[1].x,
    oy: right[1].y,
    kind: 'smooth',
  }
  const at = ends[0] + 1
  p.anchors.splice(at, 0, mid)
  return at
}

/**
 * Delete an anchor. In GIMP an anchor always comes with its two handles and
 * `gimp_bezier_stroke_anchor_delete()` removes the three together, which joins
 * the neighbours through the handles they already own. Same here.
 *
 * A closed path that would drop under three anchors is re-opened; an empty
 * path is left empty for the caller to discard.
 */
export function removeAnchor(p: Path, index: number): boolean {
  if (index < 0 || index >= p.anchors.length) return false
  p.anchors.splice(index, 1)
  if (p.closed && p.anchors.length < 3) p.closed = false
  return true
}

/** Move an anchor to `to`, carrying its two handles along (GIMP semantics). */
export function moveAnchor(a: Anchor, to: Vec): void {
  const dx = to.x - a.x
  const dy = to.y - a.y
  a.x = to.x
  a.y = to.y
  a.ix += dx
  a.iy += dy
  a.ox += dx
  a.oy += dy
}

/**
 * Move one handle. When `symmetric` the opposite handle is mirrored through
 * the anchor, exactly like `GIMP_ANCHOR_FEATURE_SYMMETRIC`.
 */
export function moveHandle(a: Anchor, part: 'in' | 'out', to: Vec, symmetric: boolean): void {
  if (part === 'in') {
    a.ix = to.x
    a.iy = to.y
    if (symmetric) {
      a.ox = 2 * a.x - to.x
      a.oy = 2 * a.y - to.y
    }
  } else {
    a.ox = to.x
    a.oy = to.y
    if (symmetric) {
      a.ix = 2 * a.x - to.x
      a.iy = 2 * a.y - to.y
    }
  }
}

/** True when both handles rest on the anchor — a hard corner with no tangent. */
export function isEdgeAnchor(a: Anchor): boolean {
  const e = 1e-9
  return Math.abs(a.ix - a.x) < e && Math.abs(a.iy - a.y) < e
    && Math.abs(a.ox - a.x) < e && Math.abs(a.oy - a.y) < e
}

/**
 * Tangent an anchor would get from a Catmull-Rom interpolation of its
 * neighbours: `(P[i+1] - P[i-1]) / 6`, the value that turns a uniform
 * Catmull-Rom spline into C¹-continuous cubic Béziers. Endpoints of an open
 * path use the anchor itself as the missing neighbour.
 */
function catmullTangent(p: Path, i: number): Vec {
  const n = p.anchors.length
  if (n < 2) return { x: 0, y: 0 }
  const cur = p.anchors[i]
  const prev = p.closed ? p.anchors[(i - 1 + n) % n] : p.anchors[Math.max(0, i - 1)]
  const next = p.closed ? p.anchors[(i + 1) % n] : p.anchors[Math.min(n - 1, i + 1)]
  return { x: (next.x - prev.x) / 6, y: (next.y - prev.y) / 6 }
}

/**
 * Recompute every tangent so the path passes smoothly through all its anchors
 * — the behaviour of the curvature pen. Anchors explicitly marked `corner`
 * keep their handles.
 */
export function smoothTangents(p: Path): void {
  const n = p.anchors.length
  for (let i = 0; i < n; i++) {
    const a = p.anchors[i]
    if (a.kind === 'corner' && !isEdgeAnchor(a)) continue
    const t = catmullTangent(p, i)
    a.kind = 'smooth'
    a.ox = a.x + t.x
    a.oy = a.y + t.y
    a.ix = a.x - t.x
    a.iy = a.y - t.y
  }
}

/**
 * Toggle one anchor between corner and smooth. Collapsing the handles onto the
 * anchor is GIMP's `GIMP_ANCHOR_FEATURE_EDGE`; the reverse direction rebuilds a
 * tangent from the neighbours.
 */
export function toggleAnchorKind(p: Path, i: number): void {
  const a = p.anchors[i]
  if (!a) return
  if (!isEdgeAnchor(a)) {
    a.kind = 'corner'
    a.ix = a.x
    a.iy = a.y
    a.ox = a.x
    a.oy = a.y
    return
  }
  const t = catmullTangent(p, i)
  if (Math.hypot(t.x, t.y) < 1e-9) return // nothing sensible to derive
  a.kind = 'smooth'
  a.ox = a.x + t.x
  a.oy = a.y + t.y
  a.ix = a.x - t.x
  a.iy = a.y - t.y
}

// ═══════════════════════════════════════════════════════════════════════════
//  Schneider curve fitting — the free-hand pen
// ═══════════════════════════════════════════════════════════════════════════

const B0 = (u: number): number => (1 - u) ** 3
const B1 = (u: number): number => 3 * u * (1 - u) ** 2
const B2 = (u: number): number => 3 * u * u * (1 - u)
const B3 = (u: number): number => u ** 3

/** Chord-length parameterisation of `pts[first..last]`, normalised to [0,1]. */
function chordLengthParameterize(pts: Vec[], first: number, last: number): number[] {
  const u: number[] = [0]
  for (let i = first + 1; i <= last; i++) u.push(u[i - first - 1] + dist(pts[i], pts[i - 1]))
  const total = u[u.length - 1]
  if (total <= 0) return u.map((_, i) => (u.length > 1 ? i / (u.length - 1) : 0))
  return u.map(v => v / total)
}

/** Least-squares fit of one cubic to `pts[first..last]` with fixed end tangents. */
function generateBezier(pts: Vec[], first: number, last: number, uPrime: number[], tHat1: Vec, tHat2: Vec): Cubic {
  const nPts = last - first + 1
  const a: [Vec, Vec][] = []
  for (let i = 0; i < nPts; i++) a.push([scale(tHat1, B1(uPrime[i])), scale(tHat2, B2(uPrime[i]))])

  let c00 = 0
  let c01 = 0
  let c11 = 0
  let x0 = 0
  let x1 = 0
  for (let i = 0; i < nPts; i++) {
    c00 += dot(a[i][0], a[i][0])
    c01 += dot(a[i][0], a[i][1])
    c11 += dot(a[i][1], a[i][1])
    const u = uPrime[i]
    const base = {
      x: pts[first].x * (B0(u) + B1(u)) + pts[last].x * (B2(u) + B3(u)),
      y: pts[first].y * (B0(u) + B1(u)) + pts[last].y * (B2(u) + B3(u)),
    }
    const tmp = sub(pts[first + i], base)
    x0 += dot(a[i][0], tmp)
    x1 += dot(a[i][1], tmp)
  }

  const detC0C1 = c00 * c11 - c01 * c01
  const detC0X = c00 * x1 - c01 * x0
  const detXC1 = x0 * c11 - c01 * x1

  let alphaL = detC0C1 === 0 ? 0 : detXC1 / detC0C1
  let alphaR = detC0C1 === 0 ? 0 : detC0X / detC0C1

  // Degenerate system, or a fit that folds back on itself: fall back on the
  // Wu/Barsky heuristic of a third of the chord length (as Graphics Gems does).
  const segLength = dist(pts[last], pts[first])
  const epsilon = 1e-6 * segLength
  if (alphaL < epsilon || alphaR < epsilon) {
    alphaL = segLength / 3
    alphaR = segLength / 3
  }
  return [
    { x: pts[first].x, y: pts[first].y },
    add(pts[first], scale(tHat1, alphaL)),
    add(pts[last], scale(tHat2, alphaR)),
    { x: pts[last].x, y: pts[last].y },
  ]
}

/** One Newton-Raphson step towards the parameter whose point is closest to `p`. */
function newtonRaphsonRootFind(c: Cubic, p: Vec, u: number): number {
  const q = cubicAt(c, u)
  const q1: Vec[] = []
  for (let i = 0; i <= 2; i++) q1.push(scale(sub(c[i + 1], c[i]), 3))
  const q2: Vec[] = []
  for (let i = 0; i <= 1; i++) q2.push(scale(sub(q1[i + 1], q1[i]), 2))

  const evalQuad = (pts: Vec[], t: number): Vec => {
    const mt = 1 - t
    return {
      x: mt * mt * pts[0].x + 2 * mt * t * pts[1].x + t * t * pts[2].x,
      y: mt * mt * pts[0].y + 2 * mt * t * pts[1].y + t * t * pts[2].y,
    }
  }
  const evalLin = (pts: Vec[], t: number): Vec => mix(pts[0], pts[1], t)

  const d = sub(q, p)
  const qu = evalQuad(q1, u)
  const quu = evalLin(q2, u)
  const numerator = d.x * qu.x + d.y * qu.y
  const denominator = qu.x * qu.x + qu.y * qu.y + d.x * quu.x + d.y * quu.y
  if (Math.abs(denominator) < 1e-12) return u
  return u - numerator / denominator
}

function reparameterize(pts: Vec[], first: number, last: number, u: number[], c: Cubic): number[] {
  return u.map((ui, i) => newtonRaphsonRootFind(c, pts[first + i], ui))
}

function computeMaxError(pts: Vec[], first: number, last: number, c: Cubic, u: number[]): { error: number; split: number } {
  let maxDist = 0
  let split = Math.floor((last - first + 1) / 2)
  for (let i = first + 1; i < last; i++) {
    const d = dist2(cubicAt(c, u[i - first]), pts[i])
    if (d >= maxDist) {
      maxDist = d
      split = i
    }
  }
  return { error: maxDist, split }
}

function fitCubicRec(pts: Vec[], first: number, last: number, tHat1: Vec, tHat2: Vec, error: number, out: Cubic[], depth: number): void {
  const nPts = last - first + 1

  // Two points: no fitting needed, the Wu/Barsky heuristic is exact enough.
  if (nPts === 2) {
    const d = dist(pts[last], pts[first]) / 3
    out.push([
      { x: pts[first].x, y: pts[first].y },
      add(pts[first], scale(tHat1, d)),
      add(pts[last], scale(tHat2, d)),
      { x: pts[last].x, y: pts[last].y },
    ])
    return
  }

  let u = chordLengthParameterize(pts, first, last)
  let bez = generateBezier(pts, first, last, u, tHat1, tHat2)
  let { error: maxError, split } = computeMaxError(pts, first, last, bez, u)
  if (maxError < error * error) {
    out.push(bez)
    return
  }

  // Close enough to converge: try reparameterising before giving up and splitting.
  if (maxError < (error * error) * 16) {
    for (let i = 0; i < 4; i++) {
      const uPrime = reparameterize(pts, first, last, u, bez)
      const nextBez = generateBezier(pts, first, last, uPrime, tHat1, tHat2)
      const next = computeMaxError(pts, first, last, nextBez, uPrime)
      u = uPrime
      bez = nextBez
      maxError = next.error
      split = next.split
      if (maxError < error * error) {
        out.push(bez)
        return
      }
    }
  }

  if (depth > 24 || split <= first || split >= last) {
    // Refuse to recurse forever on pathological input; keep the best fit found.
    out.push(bez)
    return
  }

  // Split at the worst point, with a tangent taken from its two neighbours.
  const tHatCenter = normalize(sub(pts[split - 1], pts[split + 1]))
  fitCubicRec(pts, first, split, tHat1, tHatCenter, error, out, depth + 1)
  fitCubicRec(pts, split, last, scale(tHatCenter, -1), tHat2, error, out, depth + 1)
}

/**
 * Fit a polyline with cubic Béziers so that no sample is farther than
 * `tolerance` document pixels from the result (Schneider, Graphics Gems).
 */
export function fitCurve(points: readonly Vec[], tolerance: number): Cubic[] {
  // Drop consecutive duplicates: they break the tangent estimation.
  const pts: Vec[] = []
  for (const p of points) {
    const prev = pts[pts.length - 1]
    if (!prev || dist2(prev, p) > 1e-12) pts.push({ x: p.x, y: p.y })
  }
  if (pts.length < 2) return []
  const tol = Math.max(0.05, tolerance)
  const tHat1 = normalize(sub(pts[1], pts[0]))
  const tHat2 = normalize(sub(pts[pts.length - 2], pts[pts.length - 1]))
  const out: Cubic[] = []
  fitCubicRec(pts, 0, pts.length - 1, tHat1, tHat2, tol, out, 0)
  return out
}

/** Turn a chain of cubics (each starting where the previous ended) into a path. */
export function pathFromCubics(cubics: readonly Cubic[], closed = false): Path {
  const path = makePath([], false)
  if (cubics.length === 0) return path
  for (let i = 0; i < cubics.length; i++) {
    const c = cubics[i]
    if (i === 0) {
      path.anchors.push({ x: c[0].x, y: c[0].y, ix: c[0].x, iy: c[0].y, ox: c[1].x, oy: c[1].y, kind: 'smooth' })
    } else {
      const prev = path.anchors[path.anchors.length - 1]
      prev.ox = c[1].x
      prev.oy = c[1].y
      // Collinear enough on both sides → the join really is smooth.
      const inV = normalize(sub({ x: prev.ix, y: prev.iy }, prev))
      const outV = normalize(sub({ x: prev.ox, y: prev.oy }, prev))
      prev.kind = dot(inV, outV) < -0.9 ? 'smooth' : 'corner'
    }
    path.anchors.push({ x: c[3].x, y: c[3].y, ix: c[2].x, iy: c[2].y, ox: c[3].x, oy: c[3].y, kind: 'smooth' })
  }
  if (closed && path.anchors.length > 2) {
    // Merge the last anchor into the first one and wrap the tangents around.
    const last = path.anchors.pop()
    if (last) {
      path.anchors[0].ix = last.ix
      path.anchors[0].iy = last.iy
      path.anchors[0].kind = 'smooth'
    }
    path.closed = true
  }
  return path
}

// ═══════════════════════════════════════════════════════════════════════════
//  Rasterisation — "path → selection"
// ═══════════════════════════════════════════════════════════════════════════

interface RasterEdge {
  ymin: number
  ymax: number
  xAtYmin: number
  dxdy: number
  dir: number
}

function collectEdges(p: Path, edges: RasterEdge[]): void {
  const poly = flattenPath(p)
  if (poly.length < 3) return
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    if (a.y === b.y) continue
    const up = a.y < b.y
    const top = up ? a : b
    const bottom = up ? b : a
    edges.push({
      ymin: top.y,
      ymax: bottom.y,
      xAtYmin: top.x,
      dxdy: (bottom.x - top.x) / (bottom.y - top.y),
      dir: up ? 1 : -1,
    })
  }
}

/** Accumulate the horizontal coverage of `[xa, xb)` into one scan-line row. */
function addSpan(acc: Float32Array, xa: number, xb: number, weight: number, w: number): void {
  const a = Math.max(0, xa)
  const b = Math.min(w, xb)
  if (b <= a) return
  const i0 = Math.floor(a)
  const i1 = Math.min(w, Math.ceil(b))
  if (i1 - i0 <= 1) {
    acc[i0] += (b - a) * weight
    return
  }
  acc[i0] += (i0 + 1 - a) * weight
  for (let i = i0 + 1; i < i1 - 1; i++) acc[i] += weight
  acc[i1 - 1] += (b - (i1 - 1)) * weight
}

export interface RasterOptions {
  /** Anti-alias the edges (default true). */
  antialias?: boolean
  /** Vertical sub-samples per pixel row, 1..16 (default 4 with AA). */
  samples?: number
}

/**
 * Rasterise paths into an 8-bit coverage mask, one byte per document pixel —
 * the exact shape `ctx.setSelection` / `ctx.combineSelection` expect. Filling
 * follows the NON-ZERO winding rule; open paths are filled as if closed, the
 * way SVG and PostScript do.
 *
 * Horizontal coverage is computed analytically (exact fractional spans) and
 * combined over `samples` sub-scanlines, so an axis-aligned rectangle comes out
 * with its exact area and oblique edges get real intermediate coverage.
 */
export function rasterizePathsToMask(
  paths: readonly Path[],
  w: number,
  h: number,
  opts: RasterOptions = {},
): Uint8Array {
  const width = Math.max(0, Math.floor(w))
  const height = Math.max(0, Math.floor(h))
  const out = new Uint8Array(width * height)
  if (width === 0 || height === 0) return out

  const aa = opts.antialias !== false
  const samples = Math.max(1, Math.min(16, Math.floor(opts.samples ?? (aa ? 4 : 1))))

  const edges: RasterEdge[] = []
  for (const p of paths) collectEdges(p, edges)
  if (edges.length === 0) return out

  let minY = Infinity
  let maxY = -Infinity
  for (const e of edges) {
    if (e.ymin < minY) minY = e.ymin
    if (e.ymax > maxY) maxY = e.ymax
  }
  const y0 = Math.max(0, Math.floor(minY))
  const y1 = Math.min(height, Math.ceil(maxY))
  if (y1 <= y0) return out

  edges.sort((a, b) => a.ymin - b.ymin)

  const acc = new Float32Array(width)
  const weight = 1 / samples
  const crossings: { x: number; dir: number }[] = []
  let active: RasterEdge[] = []
  let next = 0

  for (let y = y0; y < y1; y++) {
    acc.fill(0)
    for (let s = 0; s < samples; s++) {
      const sy = aa ? y + (s + 0.5) / samples : y + 0.5

      while (next < edges.length && edges[next].ymin <= sy) active.push(edges[next++])
      if (active.length === 0) continue
      if (active.some(e => e.ymax <= sy)) active = active.filter(e => e.ymax > sy)

      crossings.length = 0
      for (const e of active) {
        if (sy < e.ymin || sy >= e.ymax) continue
        crossings.push({ x: e.xAtYmin + (sy - e.ymin) * e.dxdy, dir: e.dir })
      }
      if (crossings.length < 2) continue
      crossings.sort((a, b) => a.x - b.x)

      let winding = 0
      let spanStart = 0
      for (const c of crossings) {
        const was = winding
        winding += c.dir
        if (was === 0 && winding !== 0) spanStart = c.x
        else if (was !== 0 && winding === 0) {
          // Aliased mode keeps whole pixels: a pixel is in when its centre is.
          if (aa) addSpan(acc, spanStart, c.x, weight, width)
          else addSpan(acc, Math.ceil(spanStart - 0.5), Math.ceil(c.x - 0.5), weight, width)
        }
      }
    }
    const row = y * width
    for (let x = 0; x < width; x++) {
      const v = acc[x]
      if (v <= 0) continue
      out[row + x] = v >= 1 ? 255 : Math.round(v * 255)
    }
  }
  return out
}

/**
 * Push the current paths into the editor's selection. Kept here so the future
 * "path → selection" command has a single, tested entry point.
 */
export function applyPathsAsSelection(ctx: ToolContext, mode: 'replace' | 'add' | 'sub' | 'intersect' = 'replace'): void {
  const mask = rasterizePathsToMask(state.paths, ctx.docW, ctx.docH)
  if (mode === 'replace') ctx.setSelection(mask)
  else ctx.combineSelection(mask, mode)
}

// ═══════════════════════════════════════════════════════════════════════════
//  Shared tool state
// ═══════════════════════════════════════════════════════════════════════════

type DragKind =
  | 'pen-handle' // pulling the handles of the anchor just dropped
  | 'anchor' // moving one or several anchors
  | 'handle' // moving a single control handle
  | 'path' // moving whole paths
  | 'free' // free-hand capture
  | 'pull' // anchor-convert: pulling handles out of a corner

interface Drag {
  kind: DragKind
  /** Where the gesture started, document space. */
  origin: Vec
  /** Last pointer position, document space. */
  last: Vec
  /** Point being dragged, for the single-point kinds. */
  ref?: PointRef
  /** True once the pointer travelled more than the click slop. */
  moved: boolean
}

interface PenState {
  paths: Path[]
  /** Index of the path tools act on, or -1. */
  active: number
  /** True while `pen` / `pen-curvature` are still extending `active`. */
  drawing: boolean
  sel: PointRef[]
  drag: Drag | null
  /** Latest pointer position, for the rubber band. */
  hover: Vec | null
  /** Raw capture of the free-hand pen. */
  raw: Vec[]
}

const state: PenState = {
  paths: [],
  active: -1,
  drawing: false,
  sel: [],
  drag: null,
  hover: null,
  raw: [],
}

/** Options the tool-options bar can push in (it owns no reference to us). */
const options = {
  /** Free-hand fitting tolerance, document pixels. */
  fitTolerance: 2,
  /** Draw the rubber band between the last anchor and the cursor. */
  rubberBand: true,
  /** Show handles in `direct-select`. */
  showHandles: true,
}

export function setPathToolOptions(patch: Partial<typeof options>): void {
  Object.assign(options, patch)
}

/** Read-only view of the paths, for tests and for future commands. */
export const getPaths = (): readonly Path[] => state.paths

/** Drop every path and every transient bit of state. */
export function resetPaths(): void {
  state.paths = []
  state.active = -1
  state.drawing = false
  state.sel = []
  state.drag = null
  state.hover = null
  state.raw = []
}

/** Test seam: install a known path set. */
export function setPaths(paths: Path[], active = paths.length ? 0 : -1): void {
  state.paths = paths
  state.active = active
  state.drawing = false
  state.sel = []
  state.drag = null
}

const activePath = (): Path | null => state.paths[state.active] ?? null

function startPath(): Path {
  const p = makePath([], false)
  state.paths.push(p)
  state.active = state.paths.length - 1
  state.drawing = true
  return p
}

/** Remove paths left without a usable anchor after an edition. */
function pruneEmptyPaths(): void {
  for (let i = state.paths.length - 1; i >= 0; i--) {
    if (state.paths[i].anchors.length === 0) {
      state.paths.splice(i, 1)
      state.sel = state.sel.filter(r => r.path !== i).map(r => (r.path > i ? { ...r, path: r.path - 1 } : r))
      if (state.active === i) state.active = -1
      else if (state.active > i) state.active--
    }
  }
  if (state.active >= state.paths.length) state.active = state.paths.length - 1
}

// ── Selection helpers ───────────────────────────────────────────────────────

const sameRef = (a: PointRef, b: PointRef): boolean =>
  a.path === b.path && a.anchor === b.anchor && a.part === b.part

const isSelected = (ref: PointRef): boolean => state.sel.some(r => sameRef(r, ref))

function selectOnly(refs: PointRef[]): void {
  state.sel = refs
}

function toggleSelected(ref: PointRef): void {
  if (isSelected(ref)) state.sel = state.sel.filter(r => !sameRef(r, ref))
  else state.sel = [...state.sel, ref]
}

const anchorRefsOf = (pathIndex: number): PointRef[] => {
  const p = state.paths[pathIndex]
  if (!p) return []
  return p.anchors.map((_, i) => ({ path: pathIndex, anchor: i, part: 'anchor' as const }))
}

/** True when a path has at least one selected point (drives handle display). */
const pathHasSelection = (pathIndex: number): boolean => state.sel.some(r => r.path === pathIndex)

// ── Hit testing ─────────────────────────────────────────────────────────────

/** Hit radius in document units, so the grab area stays constant on screen. */
const hitRadius = (ctx: ToolContext): number => 7 / Math.max(0.05, ctx.zoom)

/** Closest anchor within `r`, with its distance (topmost path wins a tie). */
function findAnchorAt(pt: Vec, r: number): { ref: PointRef; d: number } | null {
  let best: { ref: PointRef; d: number } | null = null
  let bestD = r * r
  // Walk from the last path down so the topmost/most recent one wins.
  for (let pi = state.paths.length - 1; pi >= 0; pi--) {
    const anchors = state.paths[pi].anchors
    for (let ai = 0; ai < anchors.length; ai++) {
      const d = dist2(anchors[ai], pt)
      if (d <= bestD) {
        bestD = d
        best = { ref: { path: pi, anchor: ai, part: 'anchor' }, d }
      }
    }
  }
  return best
}

/**
 * Closest control handle within `r`. Handles that rest on their anchor carry no
 * tangent and are not drawn, so they are not grabbable either; with
 * `requireVisible` only the paths whose handles the overlay shows are probed.
 */
function findHandleAt(pt: Vec, r: number, requireVisible: boolean): { ref: PointRef; d: number } | null {
  let best: { ref: PointRef; d: number } | null = null
  let bestD = r * r
  for (let pi = state.paths.length - 1; pi >= 0; pi--) {
    if (requireVisible && !pathHasSelection(pi) && pi !== state.active) continue
    const anchors = state.paths[pi].anchors
    for (let ai = 0; ai < anchors.length; ai++) {
      const a = anchors[ai]
      for (const part of ['in', 'out'] as const) {
        const h = part === 'in' ? { x: a.ix, y: a.iy } : { x: a.ox, y: a.oy }
        if (dist2(h, a) < 1e-12) continue // collapsed onto the anchor
        const d = dist2(h, pt)
        if (d <= bestD) {
          bestD = d
          best = { ref: { path: pi, anchor: ai, part }, d }
        }
      }
    }
  }
  return best
}

/**
 * Anchor-or-handle pick for the editing tools. Anchors win ties, the way GIMP
 * hit-tests with `preferred = GIMP_ANCHOR_ANCHOR`, so a handle parked next to
 * its anchor never steals the click.
 */
function pickPoint(pt: Vec, r: number, requireVisible: boolean): PointRef | null {
  const anchor = findAnchorAt(pt, r)
  const handle = findHandleAt(pt, r, requireVisible)
  if (anchor && handle) return handle.d < anchor.d ? handle.ref : anchor.ref
  return anchor?.ref ?? handle?.ref ?? null
}

function findSegmentAt(pt: Vec, r: number): { path: number; seg: number; t: number; d: number } | null {
  let best: { path: number; seg: number; t: number; d: number } | null = null
  for (let pi = state.paths.length - 1; pi >= 0; pi--) {
    const hit = nearestOnPath(state.paths[pi], pt)
    if (!hit || hit.d > r) continue
    if (!best || hit.d < best.d) best = { path: pi, seg: hit.seg, t: hit.t, d: hit.d }
  }
  return best
}

const ptOf = (p: ToolPointer): Vec => ({ x: p.x, y: p.y })

// ═══════════════════════════════════════════════════════════════════════════
//  Overlay
// ═══════════════════════════════════════════════════════════════════════════

/** Latest context, captured so the preview callback can map to screen space. */
let view: ToolContext | null = null

const COL_HALO = 'rgba(0, 0, 0, 0.72)'
const COL_LINE = 'rgba(255, 255, 255, 0.95)'
const COL_SEL = '#3b82f6'

function screenOf(x: number, y: number): [number, number] {
  if (!view) return [x, y]
  return view.docToScreen(x, y)
}

/** Trace the whole path onto the 2D context, in screen space. */
function traceSegments(c: CanvasRenderingContext2D, p: Path): void {
  if (p.anchors.length < 2) return
  const first = screenOf(p.anchors[0].x, p.anchors[0].y)
  c.moveTo(first[0], first[1])
  const segs = segmentCount(p)
  for (let i = 0; i < segs; i++) {
    const cu = segmentCubic(p, i)
    if (!cu) continue
    const c1 = screenOf(cu[1].x, cu[1].y)
    const c2 = screenOf(cu[2].x, cu[2].y)
    const p3 = screenOf(cu[3].x, cu[3].y)
    c.bezierCurveTo(c1[0], c1[1], c2[0], c2[1], p3[0], p3[1])
  }
  if (p.closed) c.closePath()
}

/** Two-pass stroke: a dark halo first, then the light core over it. */
function strokeTwice(c: CanvasRenderingContext2D, build: () => void): void {
  c.lineJoin = 'round'
  c.lineCap = 'round'
  c.strokeStyle = COL_HALO
  c.lineWidth = 3
  c.beginPath()
  build()
  c.stroke()
  c.strokeStyle = COL_LINE
  c.lineWidth = 1
  c.beginPath()
  build()
  c.stroke()
}

function drawAnchorMark(c: CanvasRenderingContext2D, x: number, y: number, selected: boolean): void {
  const half = selected ? 3.5 : 3
  c.beginPath()
  c.rect(x - half, y - half, half * 2, half * 2)
  c.fillStyle = selected ? COL_SEL : '#ffffff'
  c.fill()
  c.lineWidth = 1
  c.strokeStyle = COL_HALO
  c.stroke()
}

function drawHandleMark(c: CanvasRenderingContext2D, x: number, y: number, selected: boolean): void {
  c.beginPath()
  c.arc(x, y, selected ? 3.2 : 2.6, 0, Math.PI * 2)
  c.fillStyle = selected ? COL_SEL : '#ffffff'
  c.fill()
  c.lineWidth = 1
  c.strokeStyle = COL_HALO
  c.stroke()
}

/** Handles show on selected anchors, and on everything of the path being drawn. */
function handlesVisibleFor(pathIndex: number, anchorIndex: number): boolean {
  if (state.drawing && pathIndex === state.active) return true
  if (!options.showHandles) return false
  if (isSelected({ path: pathIndex, anchor: anchorIndex, part: 'anchor' })) return true
  return state.sel.some(r => r.path === pathIndex && r.anchor === anchorIndex)
}

function drawOverlay(c: CanvasRenderingContext2D): void {
  if (!view) return
  c.save()

  for (let pi = 0; pi < state.paths.length; pi++) {
    const p = state.paths[pi]
    if (p.anchors.length >= 2) strokeTwice(c, () => traceSegments(c, p))
  }

  // Rubber band from the last anchor of the path being drawn to the cursor.
  const cur = activePath()
  if (options.rubberBand && state.drawing && cur && cur.anchors.length > 0 && state.hover && !state.drag) {
    const a = cur.anchors[cur.anchors.length - 1]
    const from = screenOf(a.x, a.y)
    const ctrl = screenOf(a.ox, a.oy)
    const to = screenOf(state.hover.x, state.hover.y)
    c.save()
    c.globalAlpha = 0.7
    strokeTwice(c, () => {
      c.moveTo(from[0], from[1])
      c.bezierCurveTo(ctrl[0], ctrl[1], to[0], to[1], to[0], to[1])
    })
    c.restore()
  }

  // Free-hand capture, drawn raw while the gesture is running.
  if (state.raw.length > 1) {
    strokeTwice(c, () => {
      const p0 = screenOf(state.raw[0].x, state.raw[0].y)
      c.moveTo(p0[0], p0[1])
      for (let i = 1; i < state.raw.length; i++) {
        const s = screenOf(state.raw[i].x, state.raw[i].y)
        c.lineTo(s[0], s[1])
      }
    })
  }

  // Handles, then anchors on top of them.
  for (let pi = 0; pi < state.paths.length; pi++) {
    const p = state.paths[pi]
    for (let ai = 0; ai < p.anchors.length; ai++) {
      const a = p.anchors[ai]
      if (isEdgeAnchor(a) || !handlesVisibleFor(pi, ai)) continue
      const at = screenOf(a.x, a.y)
      for (const part of ['in', 'out'] as const) {
        const h = part === 'in' ? screenOf(a.ix, a.iy) : screenOf(a.ox, a.oy)
        strokeTwice(c, () => {
          c.moveTo(at[0], at[1])
          c.lineTo(h[0], h[1])
        })
        drawHandleMark(c, h[0], h[1], isSelected({ path: pi, anchor: ai, part }))
      }
    }
  }
  for (let pi = 0; pi < state.paths.length; pi++) {
    const p = state.paths[pi]
    for (let ai = 0; ai < p.anchors.length; ai++) {
      const a = p.anchors[ai]
      const s = screenOf(a.x, a.y)
      drawAnchorMark(c, s[0], s[1], isSelected({ path: pi, anchor: ai, part: 'anchor' }))
    }
  }

  c.restore()
}

/** Point count status — kept numeric so it needs no translation. */
function statusText(): string | null {
  const p = activePath()
  if (!p) return null
  if (state.drawing) return `${p.anchors.length} pts`
  const sel = state.sel.filter(r => r.part === 'anchor').length
  return sel > 0 ? `${sel}/${p.anchors.length} pts` : null
}

/** Re-arm the preview and repaint. Every mutating entry point ends with this. */
function sync(ctx: ToolContext): void {
  view = ctx
  ctx.setPreview(drawOverlay)
  ctx.setStatus(statusText())
  ctx.repaintOverlay()
}

/** Stop extending the active path, keeping it around for the anchor tools. */
function finishDrawing(ctx: ToolContext): void {
  const p = activePath()
  if (p && p.anchors.length < 2) {
    // A single click that never became a path is not worth keeping.
    state.paths.splice(state.active, 1)
    state.active = state.paths.length - 1
  }
  state.drawing = false
  state.drag = null
  state.raw = []
  pruneEmptyPaths()
  sync(ctx)
}

/** Escape: throw away whatever the gesture was building. */
function cancelGesture(ctx: ToolContext): void {
  if (state.drawing && state.active >= 0) {
    state.paths.splice(state.active, 1)
    state.active = state.paths.length - 1
  }
  state.drawing = false
  state.drag = null
  state.raw = []
  state.hover = null
  state.sel = []
  pruneEmptyPaths()
  sync(ctx)
}

/** Slop under which a press/release counts as a click rather than a drag. */
const clickSlop = (ctx: ToolContext): number => 3 / Math.max(0.05, ctx.zoom)

// ═══════════════════════════════════════════════════════════════════════════
//  1. `pen` — Bézier pen
// ═══════════════════════════════════════════════════════════════════════════

const penTool: ToolHandler = {
  cursor: 'crosshair',

  onDown(ctx, p) {
    view = ctx
    const pt = ptOf(p)
    const r = hitRadius(ctx)
    const cur = activePath()

    // Clicking the first anchor of the path in progress closes it.
    if (state.drawing && cur && cur.anchors.length >= 2 && !cur.closed) {
      if (dist(cur.anchors[0], pt) <= r) {
        cur.closed = true
        state.drawing = false
        state.drag = null
        selectOnly(anchorRefsOf(state.active))
        sync(ctx)
        return
      }
    }

    // Clicking the free end of an existing open path resumes it.
    if (!state.drawing) {
      const hit = findAnchorAt(pt, r)?.ref ?? null
      const hitPath = hit ? state.paths[hit.path] : null
      if (hit && hitPath && !hitPath.closed && hit.anchor === hitPath.anchors.length - 1 && hitPath.anchors.length >= 1) {
        state.active = hit.path
        state.drawing = true
        state.drag = { kind: 'pen-handle', origin: pt, last: pt, ref: hit, moved: false }
        sync(ctx)
        return
      }
    }

    const path = state.drawing && cur ? cur : startPath()
    path.anchors.push(makeAnchor(pt.x, pt.y, 'corner'))
    const ref: PointRef = { path: state.active, anchor: path.anchors.length - 1, part: 'anchor' }
    selectOnly([ref])
    state.drag = { kind: 'pen-handle', origin: pt, last: pt, ref, moved: false }
    sync(ctx)
  },

  onMove(ctx, p) {
    view = ctx
    state.hover = ptOf(p)
    const drag = state.drag
    if (drag && drag.kind === 'pen-handle' && drag.ref) {
      const path = state.paths[drag.ref.path]
      const a = path?.anchors[drag.ref.anchor]
      if (a) {
        if (dist(state.hover, drag.origin) > clickSlop(ctx)) drag.moved = true
        if (drag.moved) {
          // Drag pulls the outgoing handle; the incoming one mirrors it unless
          // Alt asks for a broken tangent (GIMP's non-SYMMETRIC move).
          a.ox = state.hover.x
          a.oy = state.hover.y
          if (p.altKey) {
            a.kind = 'corner'
          } else {
            a.kind = 'smooth'
            a.ix = 2 * a.x - a.ox
            a.iy = 2 * a.y - a.oy
          }
        }
      }
    }
    sync(ctx)
  },

  onUp(ctx) {
    state.drag = null
    sync(ctx)
  },

  onDoubleClick(ctx) {
    finishDrawing(ctx)
  },

  onCommit(ctx) {
    finishDrawing(ctx)
  },

  onCancel(ctx) {
    cancelGesture(ctx)
  },
}

// ═══════════════════════════════════════════════════════════════════════════
//  2. `pen-free` — free-hand pen, fitted with Schneider's algorithm
// ═══════════════════════════════════════════════════════════════════════════

const penFreeTool: ToolHandler = {
  cursor: 'crosshair',

  onDown(ctx, p) {
    view = ctx
    const pt = ptOf(p)
    state.raw = [pt]
    state.drag = { kind: 'free', origin: pt, last: pt, moved: false }
    sync(ctx)
  },

  onMove(ctx, p) {
    view = ctx
    const pt = ptOf(p)
    state.hover = pt
    if (state.drag?.kind === 'free') {
      const prev = state.raw[state.raw.length - 1]
      // One sample per document pixel is plenty: the fit smooths the rest.
      if (!prev || dist2(prev, pt) >= 1) {
        state.raw.push(pt)
        state.drag.moved = true
      }
    }
    sync(ctx)
  },

  onUp(ctx, p) {
    view = ctx
    if (state.drag?.kind !== 'free') {
      state.drag = null
      sync(ctx)
      return
    }
    const pt = ptOf(p)
    const prev = state.raw[state.raw.length - 1]
    if (!prev || dist2(prev, pt) > 1e-9) state.raw.push(pt)

    const raw = state.raw
    state.raw = []
    state.drag = null

    if (raw.length < 2) {
      sync(ctx)
      return
    }
    // A gesture that ends where it started is meant to be a closed path.
    const closeIt = raw.length > 8 && dist(raw[0], raw[raw.length - 1]) <= hitRadius(ctx) * 1.5
    const pts = closeIt ? [...raw, raw[0]] : raw
    const cubics = fitCurve(pts, options.fitTolerance)
    if (cubics.length === 0) {
      sync(ctx)
      return
    }
    const path = pathFromCubics(cubics, closeIt)
    state.paths.push(path)
    state.active = state.paths.length - 1
    state.drawing = false
    selectOnly(anchorRefsOf(state.active))
    sync(ctx)
  },

  onCancel(ctx) {
    state.raw = []
    state.drag = null
    sync(ctx)
  },

  onCommit(ctx) {
    finishDrawing(ctx)
  },
}

// ═══════════════════════════════════════════════════════════════════════════
//  3. `pen-curvature` — clicks only, tangents derived from the neighbours
// ═══════════════════════════════════════════════════════════════════════════

const penCurvatureTool: ToolHandler = {
  cursor: 'crosshair',

  onDown(ctx, p) {
    view = ctx
    const pt = ptOf(p)
    const r = hitRadius(ctx)
    const cur = activePath()

    if (state.drawing && cur && cur.anchors.length >= 2 && !cur.closed && dist(cur.anchors[0], pt) <= r) {
      cur.closed = true
      smoothTangents(cur)
      state.drawing = false
      state.drag = null
      selectOnly(anchorRefsOf(state.active))
      sync(ctx)
      return
    }

    // Grabbing an existing anchor moves it and re-derives the tangents live.
    const hit = findAnchorAt(pt, r)?.ref ?? null
    if (hit) {
      state.active = hit.path
      selectOnly([hit])
      state.drag = { kind: 'anchor', origin: pt, last: pt, ref: hit, moved: false }
      sync(ctx)
      return
    }

    const path = state.drawing && cur ? cur : startPath()
    path.anchors.push(makeAnchor(pt.x, pt.y, 'smooth'))
    smoothTangents(path)
    selectOnly([{ path: state.active, anchor: path.anchors.length - 1, part: 'anchor' }])
    sync(ctx)
  },

  onMove(ctx, p) {
    view = ctx
    const pt = ptOf(p)
    state.hover = pt
    const drag = state.drag
    if (drag?.kind === 'anchor' && drag.ref) {
      const path = state.paths[drag.ref.path]
      const a = path?.anchors[drag.ref.anchor]
      if (a) {
        moveAnchor(a, pt)
        smoothTangents(path)
        drag.moved = true
      }
    }
    sync(ctx)
  },

  onUp(ctx) {
    state.drag = null
    sync(ctx)
  },

  onDoubleClick(ctx) {
    finishDrawing(ctx)
  },

  onCommit(ctx) {
    finishDrawing(ctx)
  },

  onCancel(ctx) {
    cancelGesture(ctx)
  },
}

// ═══════════════════════════════════════════════════════════════════════════
//  4. `anchor-add` — De Casteljau insertion, shape preserved
// ═══════════════════════════════════════════════════════════════════════════

const anchorAddTool: ToolHandler = {
  cursor: 'crosshair',

  onDown(ctx, p) {
    view = ctx
    const pt = ptOf(p)
    const r = hitRadius(ctx)
    // Never add a second anchor on top of an existing one.
    if (findAnchorAt(pt, r)) {
      sync(ctx)
      return
    }
    const hit = findSegmentAt(pt, r * 1.5)
    if (!hit) {
      sync(ctx)
      return
    }
    const path = state.paths[hit.path]
    const at = insertAnchor(path, hit.seg, hit.t)
    if (at >= 0) {
      state.active = hit.path
      selectOnly([{ path: hit.path, anchor: at, part: 'anchor' }])
      state.drag = { kind: 'anchor', origin: pt, last: pt, ref: state.sel[0], moved: false }
    }
    sync(ctx)
  },

  onMove(ctx, p) {
    view = ctx
    const pt = ptOf(p)
    state.hover = pt
    const drag = state.drag
    if (drag?.kind === 'anchor' && drag.ref) {
      const a = state.paths[drag.ref.path]?.anchors[drag.ref.anchor]
      if (a && dist(pt, drag.origin) > clickSlop(ctx)) {
        moveAnchor(a, pt)
        drag.moved = true
      }
    }
    sync(ctx)
  },

  onUp(ctx) {
    state.drag = null
    sync(ctx)
  },

  onCancel(ctx) {
    state.drag = null
    sync(ctx)
  },
}

// ═══════════════════════════════════════════════════════════════════════════
//  5. `anchor-remove`
// ═══════════════════════════════════════════════════════════════════════════

const anchorRemoveTool: ToolHandler = {
  cursor: 'crosshair',

  onDown(ctx, p) {
    view = ctx
    const pt = ptOf(p)
    const hit = findAnchorAt(pt, hitRadius(ctx))?.ref ?? null
    if (!hit) {
      sync(ctx)
      return
    }
    const path = state.paths[hit.path]
    removeAnchor(path, hit.anchor)
    state.sel = []
    state.active = hit.path
    pruneEmptyPaths()
    sync(ctx)
  },

  onMove(ctx, p) {
    view = ctx
    state.hover = ptOf(p)
    sync(ctx)
  },

  onCancel(ctx) {
    state.drag = null
    sync(ctx)
  },
}

// ═══════════════════════════════════════════════════════════════════════════
//  6. `anchor-convert` — corner ⇄ smooth, and handle editing
// ═══════════════════════════════════════════════════════════════════════════

const anchorConvertTool: ToolHandler = {
  cursor: 'crosshair',

  onDown(ctx, p) {
    view = ctx
    const pt = ptOf(p)
    const r = hitRadius(ctx)

    const hit = pickPoint(pt, r, false)
    if (hit && hit.part !== 'anchor') {
      state.active = hit.path
      selectOnly([hit])
      state.drag = { kind: 'handle', origin: pt, last: pt, ref: hit, moved: false }
      sync(ctx)
      return
    }
    if (hit) {
      state.active = hit.path
      selectOnly([hit])
      // The toggle happens on release; a drag pulls handles out instead.
      state.drag = { kind: 'pull', origin: pt, last: pt, ref: hit, moved: false }
    } else {
      state.sel = []
    }
    sync(ctx)
  },

  onMove(ctx, p) {
    view = ctx
    const pt = ptOf(p)
    state.hover = pt
    const drag = state.drag
    if (!drag?.ref) {
      sync(ctx)
      return
    }
    const a = state.paths[drag.ref.path]?.anchors[drag.ref.anchor]
    if (!a) {
      sync(ctx)
      return
    }
    if (dist(pt, drag.origin) > clickSlop(ctx)) drag.moved = true
    if (!drag.moved) {
      sync(ctx)
      return
    }
    if (drag.kind === 'handle' && (drag.ref.part === 'in' || drag.ref.part === 'out')) {
      moveHandle(a, drag.ref.part, pt, a.kind === 'smooth' && !p.altKey)
      if (p.altKey) a.kind = 'corner'
    } else if (drag.kind === 'pull') {
      a.ox = pt.x
      a.oy = pt.y
      if (p.altKey) {
        a.kind = 'corner'
      } else {
        a.kind = 'smooth'
        a.ix = 2 * a.x - a.ox
        a.iy = 2 * a.y - a.oy
      }
    }
    sync(ctx)
  },

  onUp(ctx) {
    const drag = state.drag
    if (drag && !drag.moved && drag.kind === 'pull' && drag.ref) {
      const path = state.paths[drag.ref.path]
      if (path) toggleAnchorKind(path, drag.ref.anchor)
    }
    state.drag = null
    sync(ctx)
  },

  onCancel(ctx) {
    state.drag = null
    sync(ctx)
  },
}

// ═══════════════════════════════════════════════════════════════════════════
//  7. `path-select` — pick and move whole paths
// ═══════════════════════════════════════════════════════════════════════════

/** Move every point of `refs` by a delta, without moving a handle twice. */
function moveSelection(refs: readonly PointRef[], dx: number, dy: number): void {
  const movedAnchors = new Set<string>()
  for (const ref of refs) {
    const a = state.paths[ref.path]?.anchors[ref.anchor]
    if (!a) continue
    if (ref.part === 'anchor') {
      moveAnchor(a, { x: a.x + dx, y: a.y + dy })
      movedAnchors.add(`${ref.path}:${ref.anchor}`)
    }
  }
  for (const ref of refs) {
    if (ref.part === 'anchor') continue
    if (movedAnchors.has(`${ref.path}:${ref.anchor}`)) continue
    const a = state.paths[ref.path]?.anchors[ref.anchor]
    if (!a) continue
    if (ref.part === 'in') {
      a.ix += dx
      a.iy += dy
    } else {
      a.ox += dx
      a.oy += dy
    }
  }
}

function hitWholePath(pt: Vec, r: number): number {
  const seg = findSegmentAt(pt, r * 1.5)
  if (seg) return seg.path
  for (let pi = state.paths.length - 1; pi >= 0; pi--) {
    const p = state.paths[pi]
    if (p.closed && pathContains(p, pt)) return pi
  }
  return -1
}

const pathSelectTool: ToolHandler = {
  cursor: 'default',

  onDown(ctx, p) {
    view = ctx
    const pt = ptOf(p)
    const pi = hitWholePath(pt, hitRadius(ctx))
    if (pi < 0) {
      if (!p.shiftKey) state.sel = []
      state.drag = null
      sync(ctx)
      return
    }
    state.active = pi
    state.drawing = false
    const refs = anchorRefsOf(pi)
    if (p.shiftKey) {
      const known = new Set(state.sel.map(r => `${r.path}:${r.anchor}:${r.part}`))
      selectOnly([...state.sel, ...refs.filter(r => !known.has(`${r.path}:${r.anchor}:${r.part}`))])
    } else if (!pathHasSelection(pi)) {
      selectOnly(refs)
    }
    state.drag = { kind: 'path', origin: pt, last: pt, moved: false }
    sync(ctx)
  },

  onMove(ctx, p) {
    view = ctx
    const pt = ptOf(p)
    state.hover = pt
    const drag = state.drag
    if (drag?.kind === 'path') {
      const dx = pt.x - drag.last.x
      const dy = pt.y - drag.last.y
      if (dx !== 0 || dy !== 0) {
        // Whole paths move as a block: every anchor of every touched path.
        const paths = new Set(state.sel.map(r => r.path))
        for (const pi of paths) moveSelection(anchorRefsOf(pi), dx, dy)
        drag.last = pt
        drag.moved = true
      }
    }
    sync(ctx)
  },

  onUp(ctx) {
    state.drag = null
    sync(ctx)
  },

  onCancel(ctx) {
    state.drag = null
    state.sel = []
    sync(ctx)
  },
}

// ═══════════════════════════════════════════════════════════════════════════
//  8. `direct-select` — pick and move a single anchor or handle
// ═══════════════════════════════════════════════════════════════════════════

const directSelectTool: ToolHandler = {
  cursor: 'default',

  onDown(ctx, p) {
    view = ctx
    const pt = ptOf(p)
    const r = hitRadius(ctx)

    const hit = pickPoint(pt, r, true)
    if (hit && hit.part !== 'anchor') {
      state.active = hit.path
      selectOnly([hit])
      state.drag = { kind: 'handle', origin: pt, last: pt, ref: hit, moved: false }
      sync(ctx)
      return
    }

    if (hit) {
      state.active = hit.path
      state.drawing = false
      if (p.shiftKey) toggleSelected(hit)
      else if (!isSelected(hit)) selectOnly([hit])
      state.drag = { kind: 'anchor', origin: pt, last: pt, ref: hit, moved: false }
      sync(ctx)
      return
    }

    // On a segment: grab its two ends, which drags the segment as a whole.
    const seg = findSegmentAt(pt, r * 1.5)
    if (seg) {
      const path = state.paths[seg.path]
      const ends = segmentEnds(path, seg.seg)
      if (ends) {
        state.active = seg.path
        selectOnly(ends.map(i => ({ path: seg.path, anchor: i, part: 'anchor' as const })))
        state.drag = { kind: 'anchor', origin: pt, last: pt, moved: false }
        sync(ctx)
        return
      }
    }

    if (!p.shiftKey) state.sel = []
    state.drag = null
    sync(ctx)
  },

  onMove(ctx, p) {
    view = ctx
    const pt = ptOf(p)
    state.hover = pt
    const drag = state.drag
    if (!drag) {
      sync(ctx)
      return
    }
    if (dist(pt, drag.origin) > clickSlop(ctx)) drag.moved = true
    if (!drag.moved) {
      sync(ctx)
      return
    }
    if (drag.kind === 'handle' && drag.ref && (drag.ref.part === 'in' || drag.ref.part === 'out')) {
      const a = state.paths[drag.ref.path]?.anchors[drag.ref.anchor]
      if (a) {
        moveHandle(a, drag.ref.part, pt, a.kind === 'smooth' && !p.altKey)
        if (p.altKey) a.kind = 'corner'
      }
    } else if (drag.kind === 'anchor') {
      const dx = pt.x - drag.last.x
      const dy = pt.y - drag.last.y
      if (dx !== 0 || dy !== 0) moveSelection(state.sel, dx, dy)
    }
    drag.last = pt
    sync(ctx)
  },

  onUp(ctx) {
    state.drag = null
    sync(ctx)
  },

  onCancel(ctx) {
    state.drag = null
    state.sel = []
    sync(ctx)
  },
}

// ═══════════════════════════════════════════════════════════════════════════
//  Registration
// ═══════════════════════════════════════════════════════════════════════════

registerTool('pen', penTool)
registerTool('pen-free', penFreeTool)
registerTool('pen-curvature', penCurvatureTool)
registerTool('anchor-add', anchorAddTool)
registerTool('anchor-remove', anchorRemoveTool)
registerTool('anchor-convert', anchorConvertTool)
registerTool('path-select', pathSelectTool)
registerTool('direct-select', directSelectTool)

export {
  penTool,
  penFreeTool,
  penCurvatureTool,
  anchorAddTool,
  anchorRemoveTool,
  anchorConvertTool,
  pathSelectTool,
  directSelectTool,
}
