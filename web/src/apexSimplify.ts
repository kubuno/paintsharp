/**
 * Post-trace path simplification: drop anchor points whose removal does not
 * change the shape (within a pixel tolerance).
 *
 *  - Collinear pruning: an anchor sitting on the straight line between its two
 *    line-segment neighbours carries no information — removed, no handles added.
 *  - Curve merging (Schneider): two adjacent Bézier segments joining smoothly
 *    at an anchor are refitted as ONE cubic (tangent directions preserved,
 *    handle lengths solved by least squares); the anchor is removed only when
 *    the refit stays within the tolerance everywhere.
 *
 * Runs on the tracer output before it lands in the document, so a long straight
 * edge is 2 anchors instead of 6, and a smooth arc keeps only the anchors that
 * actually shape it.
 */
import type { PathPoint } from './api'

type V = { x: number; y: number }
const sub = (a: V, b: V): V => ({ x: a.x - b.x, y: a.y - b.y })
const dot = (a: V, b: V): number => a.x * b.x + a.y * b.y
const dist = (a: V, b: V): number => Math.hypot(a.x - b.x, a.y - b.y)
function norm(a: V): V | null {
  const l = Math.hypot(a.x, a.y)
  return l < 1e-9 ? null : { x: a.x / l, y: a.y / l }
}

// Cubic control polygon for the segment between two anchors. A missing handle
// means a straight leg — its control point sits at the 1/3 chord position, so
// the cubic degenerates to the exact line.
function cubicOf(a: PathPoint, b: PathPoint): [V, V, V, V] {
  const c1: V = a.hOut ? { x: a.x + a.hOut[0], y: a.y + a.hOut[1] }
                       : { x: a.x + (b.x - a.x) / 3, y: a.y + (b.y - a.y) / 3 }
  const c2: V = b.hIn ? { x: b.x + b.hIn[0], y: b.y + b.hIn[1] }
                      : { x: b.x - (b.x - a.x) / 3, y: b.y - (b.y - a.y) / 3 }
  return [{ x: a.x, y: a.y }, c1, c2, { x: b.x, y: b.y }]
}
function evalCubic(c: [V, V, V, V], t: number): V {
  const s = 1 - t
  const b0 = s * s * s, b1 = 3 * s * s * t, b2 = 3 * s * t * t, b3 = t * t * t
  return {
    x: b0 * c[0].x + b1 * c[1].x + b2 * c[2].x + b3 * c[3].x,
    y: b0 * c[0].y + b1 * c[1].y + b2 * c[2].y + b3 * c[3].y,
  }
}

// True when B lies on the straight run A—C (all legs are lines) within eps.
function collinearDrop(A: PathPoint, B: PathPoint, C: PathPoint, eps: number): boolean {
  if (A.hOut || B.hIn || B.hOut || C.hIn) return false
  const ac = sub(C, A)
  const l = Math.hypot(ac.x, ac.y)
  if (l < 1e-9) return dist(B, A) <= eps
  // Perpendicular distance of B to the AC line, clamped to the segment.
  const t = Math.max(0, Math.min(1, (dot(sub(B, A), ac)) / (l * l)))
  return dist(B, { x: A.x + ac.x * t, y: A.y + ac.y * t }) <= eps
}

// Try replacing the two segments A→B→C by a single cubic A→C. Returns the new
// handle vectors for A and C, or null when B is a real corner / the refit
// deviates more than eps.
function tryMerge(A: PathPoint, B: PathPoint, C: PathPoint, eps: number):
  { hOut: [number, number]; hIn: [number, number] } | null {
  // Direction of travel arriving at / leaving B — a kink there is a feature.
  const inB = norm(B.hIn ? { x: -B.hIn[0], y: -B.hIn[1] } : sub(B, A))
  const outB = norm(B.hOut ? { x: B.hOut[0], y: B.hOut[1] } : sub(C, B))
  if (!inB || !outB || dot(inB, outB) < 0.985) return null   // > ~10°: keep the corner

  // End tangents of the candidate (tC points backward, into the curve).
  const tA = norm(A.hOut ? { x: A.hOut[0], y: A.hOut[1] } : sub(B, A))
  const tC = norm(C.hIn ? { x: C.hIn[0], y: C.hIn[1] } : sub(B, C))
  if (!tA || !tC) return null

  // Sample the original pair of segments, chord-length parameterised.
  const c1 = cubicOf(A, B), c2 = cubicOf(B, C)
  const S: V[] = []
  const N = 12
  for (let i = 0; i <= N; i++) S.push(evalCubic(c1, i / N))
  for (let i = 1; i <= N; i++) S.push(evalCubic(c2, i / N))
  const u: number[] = [0]
  for (let i = 1; i < S.length; i++) u.push(u[i - 1] + dist(S[i], S[i - 1]))
  const total = u[u.length - 1]
  if (total < 1e-9) return null
  for (let i = 0; i < u.length; i++) u[i] /= total

  // Least-squares handle lengths α, β with fixed tangent directions
  // (Schneider, "An Algorithm for Automatically Fitting Digitized Curves").
  const P0: V = { x: A.x, y: A.y }, P3: V = { x: C.x, y: C.y }
  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0
  for (let i = 0; i < S.length; i++) {
    const t = u[i], s = 1 - t
    const b0 = s * s * s, b1 = 3 * s * s * t, b2 = 3 * s * t * t, b3 = t * t * t
    const a1: V = { x: tA.x * b1, y: tA.y * b1 }
    const a2: V = { x: tC.x * b2, y: tC.y * b2 }
    const d: V = { x: S[i].x - (P0.x * (b0 + b1) + P3.x * (b2 + b3)),
                   y: S[i].y - (P0.y * (b0 + b1) + P3.y * (b2 + b3)) }
    c00 += dot(a1, a1); c01 += dot(a1, a2); c11 += dot(a2, a2)
    x0 += dot(a1, d);   x1 += dot(a2, d)
  }
  const det = c00 * c11 - c01 * c01
  let alpha: number, beta: number
  if (Math.abs(det) > 1e-9) {
    alpha = (x0 * c11 - x1 * c01) / det
    beta  = (c00 * x1 - c01 * x0) / det
  } else {
    alpha = beta = total / 3                     // singular: heuristic fallback
  }
  // Retrograde or wild handles produce loops — reject instead of clamping.
  if (alpha <= 0 || beta <= 0 || alpha > total * 2 || beta > total * 2) return null

  const cand: [V, V, V, V] = [
    P0,
    { x: P0.x + tA.x * alpha, y: P0.y + tA.y * alpha },
    { x: P3.x + tC.x * beta,  y: P3.y + tC.y * beta },
    P3,
  ]
  // Parameter-matched deviation against every original sample.
  for (let i = 0; i < S.length; i++) {
    if (dist(evalCubic(cand, u[i]), S[i]) > eps) return null
  }
  return { hOut: [tA.x * alpha, tA.y * alpha], hIn: [tC.x * beta, tC.y * beta] }
}

function simplifySubpath(pts: PathPoint[], closed: boolean, eps: number): PathPoint[] {
  const min = closed ? 3 : 2
  if (pts.length <= min) return pts
  const cur = pts.map(p => ({
    ...p,
    hIn: p.hIn ? [p.hIn[0], p.hIn[1]] as [number, number] : undefined,
    hOut: p.hOut ? [p.hOut[0], p.hOut[1]] as [number, number] : undefined,
  }))
  let changed = true, guard = 0
  while (changed && guard++ < 40) {
    changed = false
    // Open paths keep their endpoints; closed paths consider every anchor.
    let i = closed ? 0 : 1
    while (cur.length > min && i < (closed ? cur.length : cur.length - 1)) {
      const A = cur[(i - 1 + cur.length) % cur.length]
      const B = cur[i]
      const C = cur[(i + 1) % cur.length]
      if (collinearDrop(A, B, C, eps)) {
        cur.splice(i, 1)
        changed = true
        continue                                  // re-test the same index
      }
      const m = tryMerge(A, B, C, eps)
      if (m) {
        A.hOut = m.hOut
        C.hIn = m.hIn
        cur.splice(i, 1)
        changed = true
        continue
      }
      i++
    }
  }
  return cur
}

/** Simplify a (possibly compound) path's anchors in place-order. eps ≤ 0 = off. */
export function simplifyTracedPoints(points: PathPoint[], closed: boolean, eps: number): PathPoint[] {
  if (eps <= 0 || points.length < 3) return points
  // Split on `move` markers, simplify each subpath, restore the markers.
  const subs: PathPoint[][] = []
  let cur: PathPoint[] = []
  for (const p of points) {
    if (p.move && cur.length) { subs.push(cur); cur = [] }
    cur.push(p)
  }
  if (cur.length) subs.push(cur)
  const out: PathPoint[] = []
  for (const sp of subs) {
    const simplified = simplifySubpath(sp, closed, eps)
    for (let i = 0; i < simplified.length; i++) {
      out.push({ ...simplified[i], move: out.length > 0 && i === 0 ? true : undefined })
    }
  }
  return out
}
