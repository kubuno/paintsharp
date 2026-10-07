// Pure geometry helpers shared by the FontEditor page and the OTF exporter.
// Coordinates are FONT UNITS with y pointing UP (baseline = 0); contours are
// implicitly closed (last point connects back to the first).
import polygonClipping from 'polygon-clipping'
import type { FontContour, FontData, FontGlyph, FontGlyphPoint } from './api'

// ── Bézier sampling ─────────────────────────────────────────────────────────────

function cubicAt(p0: number, c1: number, c2: number, p1: number, t: number): number {
  const mt = 1 - t
  return mt * mt * mt * p0 + 3 * mt * mt * t * c1 + 3 * mt * t * t * c2 + t * t * t * p1
}

/** Segment i → j of a contour, expanded to its cubic control points. */
export function segmentControls(a: FontGlyphPoint, b: FontGlyphPoint):
  { c1: [number, number]; c2: [number, number]; curved: boolean } {
  const c1: [number, number] = a.hOut ?? [a.x, a.y]
  const c2: [number, number] = b.hIn ?? [b.x, b.y]
  return { c1, c2, curved: !!(a.hOut || b.hIn) }
}

/** Flattens a closed contour into a polygon (for hit tests / winding). */
export function flattenContour(contour: FontContour, steps = 12): [number, number][] {
  const out: [number, number][] = []
  const n = contour.length
  for (let i = 0; i < n; i++) {
    const a = contour[i], b = contour[(i + 1) % n]
    const { c1, c2, curved } = segmentControls(a, b)
    out.push([a.x, a.y])
    if (curved) {
      for (let s = 1; s < steps; s++) {
        const t = s / steps
        out.push([cubicAt(a.x, c1[0], c2[0], b.x, t), cubicAt(a.y, c1[1], c2[1], b.y, t)])
      }
    }
  }
  return out
}

export function signedArea(poly: [number, number][]): number {
  let area = 0
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length]
    area += x1 * y2 - x2 * y1
  }
  return area / 2
}

export function pointInPolygon(pt: [number, number], poly: [number, number][]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j]
    if ((yi > pt[1]) !== (yj > pt[1]) &&
        pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** Reverses a contour (point order + swapped in/out handles). */
export function reverseContour(contour: FontContour): FontContour {
  return contour.slice().reverse().map(p => ({
    x: p.x, y: p.y,
    ...(p.hOut ? { hIn:  [p.hOut[0], p.hOut[1]] as [number, number] } : {}),
    ...(p.hIn  ? { hOut: [p.hIn[0],  p.hIn[1]]  as [number, number] } : {}),
  }))
}

/**
 * Normalizes fill windings for a nonzero rasterizer (PostScript/CFF convention:
 * outer contours counter-clockwise, holes clockwise). Depth = number of other
 * contours containing the contour; even depth = outer.
 */
export function normalizeWindings(contours: FontContour[]): FontContour[] {
  const polys = contours.map(c => flattenContour(c))
  return contours.map((c, i) => {
    if (c.length < 3) return c
    const sample = polys[i][0]
    let depth = 0
    for (let j = 0; j < polys.length; j++) {
      if (j !== i && polys[j].length >= 3 && pointInPolygon(sample, polys[j])) depth++
    }
    const ccw = signedArea(polys[i]) > 0
    const wantCcw = depth % 2 === 0
    return ccw === wantCcw ? c : reverseContour(c)
  })
}

// ── Bounds / Path2D ─────────────────────────────────────────────────────────────

export interface Bounds { minX: number; minY: number; maxX: number; maxY: number }

export function contoursBounds(contours: FontContour[]): Bounds | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const c of contours) {
    for (const [x, y] of flattenContour(c, 8)) {
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null
}

/**
 * Builds a Path2D from glyph contours in SCREEN space through the given mapping
 * (font units → pixels). Used by the editor canvas, the grid cells and previews.
 */
export function buildGlyphPath(
  contours: FontContour[],
  tx: (x: number, y: number) => [number, number],
): Path2D {
  const path = new Path2D()
  for (const contour of contours) {
    if (contour.length < 2) continue
    const first = contour[0]
    const [sx, sy] = tx(first.x, first.y)
    path.moveTo(sx, sy)
    for (let i = 0; i < contour.length; i++) {
      const a = contour[i], b = contour[(i + 1) % contour.length]
      const { c1, c2, curved } = segmentControls(a, b)
      const [bx, by] = tx(b.x, b.y)
      if (curved) {
        const [c1x, c1y] = tx(c1[0], c1[1])
        const [c2x, c2y] = tx(c2[0], c2[1])
        path.bezierCurveTo(c1x, c1y, c2x, c2y, bx, by)
      } else {
        path.lineTo(bx, by)
      }
    }
    path.closePath()
  }
  return path
}

// ── Segment hit-testing / splitting ─────────────────────────────────────────────

/** Closest point (t ∈ [0,1]) on segment i→i+1 of a contour to `pt`, with distance. */
export function closestOnSegment(
  a: FontGlyphPoint, b: FontGlyphPoint, pt: [number, number], samples = 24,
): { t: number; dist: number } {
  const { c1, c2 } = segmentControls(a, b)
  let best = { t: 0, dist: Infinity }
  for (let s = 0; s <= samples; s++) {
    const t = s / samples
    const x = cubicAt(a.x, c1[0], c2[0], b.x, t)
    const y = cubicAt(a.y, c1[1], c2[1], b.y, t)
    const d = Math.hypot(x - pt[0], y - pt[1])
    if (d < best.dist) best = { t, dist: d }
  }
  return best
}

/** de Casteljau split of segment i→j at t; returns the new middle point + updated handles. */
export function splitSegment(a: FontGlyphPoint, b: FontGlyphPoint, t: number): {
  a: FontGlyphPoint; mid: FontGlyphPoint; b: FontGlyphPoint
} {
  const { c1, c2 } = segmentControls(a, b)
  const lerp = (p: [number, number], q: [number, number]): [number, number] =>
    [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]
  const p0: [number, number] = [a.x, a.y]
  const p3: [number, number] = [b.x, b.y]
  const q0 = lerp(p0, c1), q1 = lerp(c1, c2), q2 = lerp(c2, p3)
  const r0 = lerp(q0, q1), r1 = lerp(q1, q2)
  const m  = lerp(r0, r1)
  const round2 = (v: [number, number]): [number, number] => [Math.round(v[0]), Math.round(v[1])]
  return {
    a:   { ...a, hOut: round2(q0) },
    mid: { x: Math.round(m[0]), y: Math.round(m[1]), hIn: round2(r0), hOut: round2(r1) },
    b:   { ...b, hIn: round2(q2) },
  }
}

// ── Boolean pathfinder (polygon-clipping, Apex-style) ───────────────────────────

type Ring = [number, number][]

/**
 * Groups a set of contours into polygons-with-holes by containment parity so
 * an « O » keeps its counter through boolean operations.
 */
function contourSetToMultiPoly(contours: FontContour[]): Ring[][] {
  const rings = contours.filter(c => c.length >= 3).map(c => flattenContour(c, 16))
  // FULL containment only — a partial overlap is a sibling shape, not a hole.
  const inside = (r: Ring, o: Ring) => r.every(pt => pointInPolygon(pt, o))
  const depth = rings.map((r, i) =>
    rings.reduce((d, o, j) => (j !== i && inside(r, o) ? d + 1 : d), 0))
  const polys: Ring[][] = []
  const polyOf = new Map<number, number>()   // outer ring index → polys index
  rings.forEach((r, i) => {
    if (depth[i] % 2 === 0) { polyOf.set(i, polys.length); polys.push([r]) }
  })
  rings.forEach((r, i) => {
    if (depth[i] % 2 === 0) return
    // Attach the hole to its immediate container (depth-1, containing it).
    const parent = rings.findIndex((o, j) =>
      j !== i && depth[j] === depth[i] - 1 && inside(r, o))
    const slot = parent >= 0 ? polyOf.get(parent) : undefined
    if (slot != null) polys[slot].push(r)
    else polys.push([r])
  })
  return polys
}

export type PathfinderOp = 'union' | 'subtract' | 'intersect' | 'exclude'

/**
 * Boolean operation between two contour sets, PRESERVING the Bézier curves:
 * curve/curve intersections → de Casteljau splits → inside/outside classification
 * → re-chaining. Only the pieces around the intersections change; every untouched
 * curve keeps its exact control points. Falls back to the polygonal clipper when
 * the curve solver cannot close a result.
 */
export function pathfinderContours(a: FontContour[], b: FontContour[], op: PathfinderOp): FontContour[] | null {
  // Self-union of a contour SET (the editor passes every selected contour as `a`):
  // fold the shapes one into another, so an « O » keeps its counter.
  if (op === 'union' && !b.length) {
    const shapes = groupShapes(a)
    if (shapes.length <= 1) return a.length ? a : null
    let acc = shapes[0]
    for (let i = 1; i < shapes.length; i++) {
      const r = booleanContours(acc, shapes[i], 'union') ?? polygonalPathfinder(acc, shapes[i], 'union')
      if (!r) return polygonalPathfinder(a, [], 'union')
      acc = r
    }
    return acc
  }
  return booleanContours(a, b, op) ?? polygonalPathfinder(a, b, op)
}

/** Groups contours into shapes (an outer contour + the holes it contains). */
function groupShapes(contours: FontContour[]): FontContour[][] {
  const cs = contours.filter(c => c.length >= 2)
  const polys = cs.map(c => flattenContour(c, 16))
  const inside = (i: number, j: number) => polys[i].every(pt => pointInPolygon(pt, polys[j]))
  const depth = cs.map((_, i) => cs.reduce((d, _c, j) => (j !== i && inside(i, j) ? d + 1 : d), 0))
  const shapes: FontContour[][] = []
  const slotOf = new Map<number, number>()
  cs.forEach((c, i) => {
    if (depth[i] % 2 === 0) { slotOf.set(i, shapes.length); shapes.push([c]) }
  })
  cs.forEach((c, i) => {
    if (depth[i] % 2 === 0) return
    const parent = cs.findIndex((_o, j) => j !== i && depth[j] === depth[i] - 1 && inside(i, j))
    const slot = parent >= 0 ? slotOf.get(parent) : undefined
    if (slot != null) shapes[slot].push(c)
    else shapes.push([c])
  })
  return shapes
}

/** Polygonal fallback (polygon-clipping): robust but drops the curves. */
function polygonalPathfinder(a: FontContour[], b: FontContour[], op: PathfinderOp): FontContour[] | null {
  const A = contourSetToMultiPoly(a)
  const B = contourSetToMultiPoly(b)
  let res: Ring[][]
  try {
    switch (op) {
      case 'union': {
        // Each polygon must be its own geometry — a single MultiPolygon argument
        // is treated as already-disjoint and would not self-merge.
        const all = [...A, ...B].map(p => [p])
        if (!all.length) return null
        res = polygonClipping.union(all[0] as never, ...(all.slice(1) as never[])) as unknown as Ring[][]
        break
      }
      case 'subtract':  res = polygonClipping.difference(A as never, B as never) as unknown as Ring[][]; break
      case 'intersect': res = polygonClipping.intersection(A as never, B as never) as unknown as Ring[][]; break
      case 'exclude':   res = polygonClipping.xor(A as never, B as never) as unknown as Ring[][]; break
    }
  } catch { return null }
  const out: FontContour[] = []
  for (const poly of res) {
    for (const ring of poly) {
      const r = ring.slice()
      if (r.length >= 2 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]) r.pop()
      if (r.length >= 3) out.push(r.map(([x, y]) => ({ x: Math.round(x), y: Math.round(y) })))
    }
  }
  return out.length ? out : null
}

// ── Curve-preserving boolean ────────────────────────────────────────────────────
//
// Same shape as paper.js' path boolean: intersect the cubics pairwise, split them
// at the hits, keep the pieces the operator asks for, then chain the pieces back
// into closed contours. Untouched curves survive with their exact control points.

type Pt = [number, number]
interface Seg { p0: Pt; c1: Pt; c2: Pt; p3: Pt; curved: boolean }

/** Geometric tolerance in font units (coordinates are integers). */
const BOOL_TOL = 0.02
/** Endpoints closer than this are the same node when chaining. */
const JOIN_TOL = 0.35

function contourToSegs(c: FontContour): Seg[] {
  const segs: Seg[] = []
  const n = c.length
  for (let i = 0; i < n; i++) {
    const a = c[i], b = c[(i + 1) % n]
    const { c1, c2, curved } = segmentControls(a, b)
    segs.push({ p0: [a.x, a.y], c1: [c1[0], c1[1]], c2: [c2[0], c2[1]], p3: [b.x, b.y], curved })
  }
  return segs
}

function segAt(s: Seg, t: number): Pt {
  return [cubicAt(s.p0[0], s.c1[0], s.c2[0], s.p3[0], t),
          cubicAt(s.p0[1], s.c1[1], s.c2[1], s.p3[1], t)]
}

/** de Casteljau: the piece of `s` between t0 and t1. */
function subSeg(s: Seg, t0: number, t1: number): Seg {
  const lerp = (p: Pt, q: Pt, t: number): Pt => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]
  // Right part at t0, then left part of the remainder at the remapped t1.
  const q0 = lerp(s.p0, s.c1, t0), q1 = lerp(s.c1, s.c2, t0), q2 = lerp(s.c2, s.p3, t0)
  const r0 = lerp(q0, q1, t0), r1 = lerp(q1, q2, t0)
  const m0 = lerp(r0, r1, t0)
  const right: Seg = { p0: m0, c1: r1, c2: q2, p3: s.p3, curved: s.curved }
  const tt = t1 >= 1 ? 1 : (t1 - t0) / (1 - t0)
  const u0 = lerp(right.p0, right.c1, tt), u1 = lerp(right.c1, right.c2, tt), u2 = lerp(right.c2, right.p3, tt)
  const v0 = lerp(u0, u1, tt), v1 = lerp(u1, u2, tt)
  const m1 = lerp(v0, v1, tt)
  return { p0: right.p0, c1: u0, c2: v0, p3: m1, curved: s.curved }
}

function segBox(s: Seg): [number, number, number, number] {
  const xs = [s.p0[0], s.c1[0], s.c2[0], s.p3[0]]
  const ys = [s.p0[1], s.c1[1], s.c2[1], s.p3[1]]
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

function isLine(s: Seg): boolean {
  return !s.curved
}

/** All (t, u) hits between two cubics, by recursive bounding-box subdivision. */
function segIntersections(a: Seg, b: Seg): { t: number; u: number }[] {
  const hits: { t: number; u: number }[] = []
  // Straight/straight is solved analytically (recursing on parallels never ends).
  if (isLine(a) && isLine(b)) {
    const r: Pt = [a.p3[0] - a.p0[0], a.p3[1] - a.p0[1]]
    const s: Pt = [b.p3[0] - b.p0[0], b.p3[1] - b.p0[1]]
    const qp: Pt = [b.p0[0] - a.p0[0], b.p0[1] - a.p0[1]]
    const denom = r[0] * s[1] - r[1] * s[0]
    if (Math.abs(denom) < 1e-9) {
      // Parallel. If COLLINEAR and overlapping (shared edges: extremely common
      // with integer coordinates), cut each segment at the other's endpoints so
      // the coincident piece gets classified on its own.
      const rl = Math.hypot(r[0], r[1]) || 1
      if (Math.abs(qp[0] * r[1] - qp[1] * r[0]) / rl > BOOL_TOL) return hits
      const rr = r[0] * r[0] + r[1] * r[1] || 1
      const ss = s[0] * s[0] + s[1] * s[1] || 1
      const tB0 = ((b.p0[0] - a.p0[0]) * r[0] + (b.p0[1] - a.p0[1]) * r[1]) / rr
      const tB1 = ((b.p3[0] - a.p0[0]) * r[0] + (b.p3[1] - a.p0[1]) * r[1]) / rr
      const uA0 = ((a.p0[0] - b.p0[0]) * s[0] + (a.p0[1] - b.p0[1]) * s[1]) / ss
      const uA1 = ((a.p3[0] - b.p0[0]) * s[0] + (a.p3[1] - b.p0[1]) * s[1]) / ss
      if (tB0 > 1e-4 && tB0 < 1 - 1e-4) hits.push({ t: tB0, u: 0 })
      if (tB1 > 1e-4 && tB1 < 1 - 1e-4) hits.push({ t: tB1, u: 1 })
      if (uA0 > 1e-4 && uA0 < 1 - 1e-4) hits.push({ t: 0, u: uA0 })
      if (uA1 > 1e-4 && uA1 < 1 - 1e-4) hits.push({ t: 1, u: uA1 })
      return hits
    }
    const t = (qp[0] * s[1] - qp[1] * s[0]) / denom
    const u = (qp[0] * r[1] - qp[1] * r[0]) / denom
    if (t >= -1e-9 && t <= 1 + 1e-9 && u >= -1e-9 && u <= 1 + 1e-9) {
      hits.push({ t: Math.min(1, Math.max(0, t)), u: Math.min(1, Math.max(0, u)) })
    }
    return hits
  }

  const walk = (sa: Seg, ta0: number, ta1: number, sb: Seg, tb0: number, tb1: number, depth: number) => {
    const [ax0, ay0, ax1, ay1] = segBox(sa)
    const [bx0, by0, bx1, by1] = segBox(sb)
    if (ax1 + BOOL_TOL < bx0 || bx1 + BOOL_TOL < ax0 || ay1 + BOOL_TOL < by0 || by1 + BOOL_TOL < ay0) return
    const da = Math.max(ax1 - ax0, ay1 - ay0)
    const db = Math.max(bx1 - bx0, by1 - by0)
    if (depth >= 32 || (da <= BOOL_TOL && db <= BOOL_TOL)) {
      hits.push({ t: (ta0 + ta1) / 2, u: (tb0 + tb1) / 2 })
      return
    }
    if (da >= db) {
      const tm = (ta0 + ta1) / 2
      walk(subSeg(sa, 0, 0.5), ta0, tm, sb, tb0, tb1, depth + 1)
      walk(subSeg(sa, 0.5, 1), tm, ta1, sb, tb0, tb1, depth + 1)
    } else {
      const um = (tb0 + tb1) / 2
      walk(sa, ta0, ta1, subSeg(sb, 0, 0.5), tb0, um, depth + 1)
      walk(sa, ta0, ta1, subSeg(sb, 0.5, 1), um, tb1, depth + 1)
    }
  }
  walk(a, 0, 1, b, 0, 1, 0)

  // Merge the clusters the subdivision produces around a single crossing.
  const merged: { t: number; u: number }[] = []
  for (const h of hits) {
    const p = segAt(a, h.t)
    if (merged.some(m => {
      const q = segAt(a, m.t)
      return Math.hypot(p[0] - q[0], p[1] - q[1]) < JOIN_TOL
    })) continue
    merged.push(h)
  }
  return merged
}

/** Even-odd inside test against a whole contour set (so holes read as outside). */
function insideSet(pt: Pt, polys: Pt[][]): boolean {
  let inside = false
  for (const poly of polys) if (poly.length >= 3 && pointInPolygon(pt, poly)) inside = !inside
  return inside
}

function reverseSeg(s: Seg): Seg {
  return { p0: s.p3, c1: s.c2, c2: s.c1, p3: s.p0, curved: s.curved }
}

/** Cubic derivative at t (falls back to the chord when the controls degenerate). */
function segTangent(s: Seg, t: number): Pt {
  const mt = 1 - t
  let dx = 3 * (mt * mt * (s.c1[0] - s.p0[0]) + 2 * mt * t * (s.c2[0] - s.c1[0]) + t * t * (s.p3[0] - s.c2[0]))
  let dy = 3 * (mt * mt * (s.c1[1] - s.p0[1]) + 2 * mt * t * (s.c2[1] - s.c1[1]) + t * t * (s.p3[1] - s.c2[1]))
  if (Math.hypot(dx, dy) < 1e-9) { dx = s.p3[0] - s.p0[0]; dy = s.p3[1] - s.p0[1] }
  return [dx, dy]
}

/** Result-region membership per operator. */
const MEMBER: Record<Exclude<PathfinderOp, never>, (inA: boolean, inB: boolean) => boolean> = {
  union:     (a, b) => a || b,
  intersect: (a, b) => a && b,
  subtract:  (a, b) => a && !b,
  exclude:   (a, b) => a !== b,
}

/** Sampling offset for the side test, in font units (coordinates are integers). */
const SIDE_EPS = 0.5

/**
 * Keeps exactly the pieces that separate inside from outside of the RESULT
 * region: sample both sides of each piece's midpoint. Robust to shared edges,
 * tangencies and reversed input windings (unlike a midpoint inside-test).
 * Kept pieces are oriented with the filled side on their LEFT (y-up), which
 * makes outer contours CCW and holes CW automatically.
 */
function classifyPieces(
  pieces: Seg[], polysA: Pt[][], polysB: Pt[][], member: (a: boolean, b: boolean) => boolean,
): Seg[] {
  const keep: Seg[] = []
  for (const seg of pieces) {
    const m = segAt(seg, 0.5)
    const [tx, ty] = segTangent(seg, 0.5)
    const tl = Math.hypot(tx, ty) || 1
    const nx = -ty / tl, ny = tx / tl                 // left normal (y-up)
    const L: Pt = [m[0] + nx * SIDE_EPS, m[1] + ny * SIDE_EPS]
    const R: Pt = [m[0] - nx * SIDE_EPS, m[1] - ny * SIDE_EPS]
    const fL = member(insideSet(L, polysA), insideSet(L, polysB))
    const fR = member(insideSet(R, polysA), insideSet(R, polysB))
    if (fL === fR) continue                           // interior or exterior piece
    keep.push(fL ? seg : reverseSeg(seg))
  }
  // Coincident edges survive once from A and once from B → drop the duplicate.
  const out: Seg[] = []
  for (const s of keep) {
    const m = segAt(s, 0.5)
    const dup = out.some(o => {
      const mo = segAt(o, 0.5)
      return Math.hypot(s.p0[0] - o.p0[0], s.p0[1] - o.p0[1]) < JOIN_TOL &&
             Math.hypot(s.p3[0] - o.p3[0], s.p3[1] - o.p3[1]) < JOIN_TOL &&
             Math.hypot(m[0] - mo[0], m[1] - mo[1]) < JOIN_TOL
    })
    if (!dup) out.push(s)
  }
  return out
}

/**
 * Chains pieces into closed contours by endpoint matching. At a junction with
 * several candidates (tangency points) the smoothest continuation wins. Open
 * chains are DROPPED — their total length is reported so the caller can decide
 * whether the result is still trustworthy.
 */
function chainSegs(pieces: Seg[]): { contours: FontContour[]; droppedLen: number } {
  const CELL = 1.0
  const key = (cx: number, cy: number) => `${cx}:${cy}`
  const starts = new Map<string, number[]>()
  pieces.forEach((s, i) => {
    const k = key(Math.round(s.p0[0] / CELL), Math.round(s.p0[1] / CELL))
    const arr = starts.get(k)
    if (arr) arr.push(i)
    else starts.set(k, [i])
  })
  // Endpoint buckets can split two nearby points — search the 3×3 neighborhood.
  const candidatesNear = (p: Pt, used: boolean[]): number[] => {
    const cx = Math.round(p[0] / CELL), cy = Math.round(p[1] / CELL)
    const cands: number[] = []
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const j of starts.get(key(cx + dx, cy + dy)) ?? []) {
        if (!used[j]) {
          const q = pieces[j].p0
          if (Math.hypot(q[0] - p[0], q[1] - p[1]) < JOIN_TOL) cands.push(j)
        }
      }
    }
    return cands
  }

  const segLen = (s: Seg) => Math.hypot(s.p3[0] - s.p0[0], s.p3[1] - s.p0[1])
  const used = new Array<boolean>(pieces.length).fill(false)
  const contours: FontContour[] = []
  let droppedLen = 0

  for (let i = 0; i < pieces.length; i++) {
    if (used[i]) continue
    const chain: Seg[] = []
    let cur = i
    let closed = false
    while (cur >= 0) {
      used[cur] = true
      chain.push(pieces[cur])
      const end = pieces[cur].p3
      if (chain.length > 1 &&
          Math.hypot(end[0] - chain[0].p0[0], end[1] - chain[0].p0[1]) < JOIN_TOL) { closed = true; break }
      const cands = candidatesNear(end, used)
      if (!cands.length) break
      if (cands.length === 1) { cur = cands[0]; continue }
      // Tangency junction: prefer the smoothest continuation.
      const [ix, iy] = segTangent(pieces[cur], 1)
      const il = Math.hypot(ix, iy) || 1
      cur = cands.reduce((best, j) => {
        const score = (k: number) => {
          const [ox, oy] = segTangent(pieces[k], 0)
          const ol = Math.hypot(ox, oy) || 1
          return (ix * ox + iy * oy) / (il * ol)
        }
        return score(j) > score(best) ? j : best
      }, cands[0])
    }

    if (!closed || chain.length < 2) {
      droppedLen += chain.reduce((l, s) => l + segLen(s), 0)
      continue
    }
    // Drop specks (rounding debris).
    const flatArea = Math.abs(signedArea(chain.map(s => s.p0 as [number, number])))
    if (chain.length <= 4 && flatArea < 2 && chain.every(s => !s.curved)) continue

    // Segments → contour points (handles are absolute; straight pieces have none).
    const R = (v: number) => Math.round(v)
    const contour: FontContour = chain.map((s, j) => {
      const prev = chain[(j - 1 + chain.length) % chain.length]
      const p: FontGlyphPoint = { x: R(s.p0[0]), y: R(s.p0[1]) }
      if (s.curved) p.hOut = [R(s.c1[0]), R(s.c1[1])]
      if (prev.curved) p.hIn = [R(prev.c2[0]), R(prev.c2[1])]
      return p
    })
    if (contour.length >= 2) contours.push(contour)
  }
  return { contours, droppedLen }
}

/**
 * Boolean on Béziers. Returns null when it cannot produce a trustworthy result
 * (caller then falls back to the polygonal clipper). Input winding direction
 * does not matter; output is CCW outers / CW holes.
 */
function booleanContours(a: FontContour[], b: FontContour[], op: PathfinderOp): FontContour[] | null {
  const A = a.filter(c => c.length >= 2)
  const B = b.filter(c => c.length >= 2)
  if (!A.length) return op === 'intersect' || op === 'subtract' ? [] : B.length ? B.map(c => c.slice()) : null
  if (!B.length) return op === 'intersect' ? [] : A.map(c => c.slice())

  const segsA = A.flatMap(contourToSegs)
  const segsB = B.flatMap(contourToSegs)
  if (segsA.length * segsB.length > 40000) return null    // too heavy: use the clipper

  // 1. Pairwise intersections, gathered as cut parameters per segment.
  const cutsA: number[][] = segsA.map(() => [])
  const cutsB: number[][] = segsB.map(() => [])
  for (let i = 0; i < segsA.length; i++) {
    for (let j = 0; j < segsB.length; j++) {
      for (const h of segIntersections(segsA[i], segsB[j])) {
        cutsA[i].push(h.t)
        cutsB[j].push(h.u)
      }
    }
  }

  // 2. Split at the cuts. Uncut segments stay whole — exact control points.
  const split = (segs: Seg[], cuts: number[][]): Seg[] => {
    const out: Seg[] = []
    segs.forEach((s, i) => {
      const ts = [0, ...cuts[i].filter(t => t > 1e-4 && t < 1 - 1e-4).sort((x, y) => x - y), 1]
      for (let k = 0; k < ts.length - 1; k++) {
        if (ts[k + 1] - ts[k] < 1e-4) continue
        out.push(subSeg(s, ts[k], ts[k + 1]))
      }
    })
    return out
  }

  // Flatten finely: the side test samples SIDE_EPS away from the true curve,
  // so the polygon sag must stay well below it (48 steps ≈ 0.1 u at upem 2048).
  const polysA = A.map(c => flattenContour(c, 48))
  const polysB = B.map(c => flattenContour(c, 48))

  // 3-4. Classify both sides of every piece, keep the result boundary.
  const kept = classifyPieces(
    [...split(segsA, cutsA), ...split(segsB, cutsB)],
    polysA, polysB, MEMBER[op],
  )
  if (!kept.length) return op === 'union' ? null : []

  // 5. Chain into closed contours; give up if a non-trivial chain failed.
  const { contours, droppedLen } = chainSegs(kept)
  if (droppedLen > 3) return null
  if (!contours.length) return op === 'union' ? null : []
  return contours
}

// ── Simplify / smooth / offset ──────────────────────────────────────────────────

function rdp(points: [number, number][], eps: number): [number, number][] {
  if (points.length < 3) return points
  const [ax, ay] = points[0]
  const [bx, by] = points[points.length - 1]
  let maxD = -1, idx = -1
  const dx = bx - ax, dy = by - ay
  const len = Math.hypot(dx, dy) || 1
  for (let i = 1; i < points.length - 1; i++) {
    const d = Math.abs((points[i][0] - ax) * dy - (points[i][1] - ay) * dx) / len
    if (d > maxD) { maxD = d; idx = i }
  }
  if (maxD <= eps) return [points[0], points[points.length - 1]]
  const left = rdp(points.slice(0, idx + 1), eps)
  const right = rdp(points.slice(idx), eps)
  return [...left.slice(0, -1), ...right]
}

/** Reduces a contour to fewer corner points (RDP over the flattened outline). */
export function simplifyContour(contour: FontContour, eps: number): FontContour {
  const flat = flattenContour(contour, 16)
  if (flat.length < 4) return contour
  // Closed RDP: split at the two most distant points, simplify both halves.
  let far = 1, best = -1
  for (let i = 1; i < flat.length; i++) {
    const d = Math.hypot(flat[i][0] - flat[0][0], flat[i][1] - flat[0][1])
    if (d > best) { best = d; far = i }
  }
  const h1 = rdp(flat.slice(0, far + 1), eps)
  const h2 = rdp([...flat.slice(far), flat[0]], eps)
  const pts = [...h1.slice(0, -1), ...h2.slice(0, -1)]
  if (pts.length < 3) return contour
  return pts.map(([x, y]) => ({ x: Math.round(x), y: Math.round(y) }))
}

/** Gives every point symmetric Catmull-Rom-style handles (Apex « lisser »). */
export function smoothContour(contour: FontContour): FontContour {
  const n = contour.length
  if (n < 3) return contour
  return contour.map((p, i) => {
    const prev = contour[(i - 1 + n) % n], next = contour[(i + 1) % n]
    const tx = (next.x - prev.x) / 6, ty = (next.y - prev.y) / 6
    return {
      x: p.x, y: p.y,
      hIn:  [Math.round(p.x - tx), Math.round(p.y - ty)] as [number, number],
      hOut: [Math.round(p.x + tx), Math.round(p.y + ty)] as [number, number],
    }
  })
}

/**
 * Offsets every contour along its outward normal — positive `d` fattens the
 * shape (outer contours grow, holes shrink), negative thins it. Polygonal
 * result (Apex-style vertex-normal offset with miter compensation).
 */
export function offsetContours(contours: FontContour[], d: number): FontContour[] {
  const out: FontContour[] = []
  for (const c of normalizeWindings(contours)) {
    const ring = flattenContour(c, 16)
    const n = ring.length
    if (n < 3) { out.push(c); continue }
    // Outer contours are CCW after normalization (positive area, y-up):
    // for them the outward normal of edge (dx,dy) is (dy,-dx).
    const sign = signedArea(ring) > 0 ? 1 : -1
    const off: FontContour = []
    for (let i = 0; i < n; i++) {
      const [px, py] = ring[(i - 1 + n) % n]
      const [cx, cy] = ring[i]
      const [nx, ny] = ring[(i + 1) % n]
      const e1x = cx - px, e1y = cy - py
      const e2x = nx - cx, e2y = ny - cy
      const l1 = Math.hypot(e1x, e1y) || 1, l2 = Math.hypot(e2x, e2y) || 1
      const n1x = (e1y / l1) * sign, n1y = (-e1x / l1) * sign
      const n2x = (e2y / l2) * sign, n2y = (-e2x / l2) * sign
      let bx = n1x + n2x, by = n1y + n2y
      const bl = Math.hypot(bx, by) || 1
      bx /= bl; by /= bl
      const cos = Math.max(0.3, n1x * bx + n1y * by)   // miter compensation, clamped
      off.push({ x: Math.round(cx + (bx * d) / cos), y: Math.round(cy + (by * d) / cos) })
    }
    if (off.length >= 3) out.push(off)
  }
  return out
}

// ── Misc ────────────────────────────────────────────────────────────────────────

export function getGlyph(font: FontData, cp: number): FontGlyph | undefined {
  return font.glyphs[String(cp)]
}

export function countDrawnGlyphs(font: FontData): number {
  return Object.values(font.glyphs).filter(g => g.contours.length > 0).length
}

/** Default advance width for a codepoint yet to be drawn. */
export function defaultAdvance(font: FontData, cp: number): number {
  if (cp === 32) return Math.round(font.unitsPerEm * 0.3)
  return Math.round(font.unitsPerEm * 0.55)
}
