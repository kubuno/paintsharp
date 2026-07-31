// Population-weighted median cut (Heckbert 1982) followed by Lloyd refinement.
//
// Chosen over NeuQuant because DETERMINISM is a functional requirement here: an
// animation shares ONE global palette, so a non-deterministic quantiser yields
// a byte-different file for identical content on every export — no caching, no
// regression test by output comparison, and a confusing experience. Median cut
// picks good boundaries but mediocre representatives; three Lloyd passes over
// the 32768 histogram bins (not over n pixels) close the quality gap with
// NeuQuant for a few milliseconds.
//
// Every tie-break below is explicit so two runs on the same input produce the
// same palette byte for byte.

import type { Histogram } from './histogram.ts'

interface Box {
  /** Span [start, end) into the working order array. */
  start: number
  end: number
  count: number
  rMin: number
  rMax: number
  gMin: number
  gMax: number
  bMin: number
  bMax: number
}

/** Number of Lloyd (k-means) refinement passes. */
export const LLOYD_PASSES = 3

/**
 * @param hist   histogram to quantise
 * @param maxColors 1..256
 * @returns packed RGB triplets, length = 3 * size
 */
export function medianCutPalette(hist: Histogram, maxColors: number): { rgb: Uint8Array; size: number } {
  const k = Math.max(1, Math.min(256, Math.floor(maxColors)))
  const n = hist.usedCount
  if (n === 0) return { rgb: new Uint8Array([0, 0, 0]), size: 1 }

  // Per-bin weighted mean colour and population, in bin order (ascending index).
  const br = new Float64Array(n)
  const bg = new Float64Array(n)
  const bb = new Float64Array(n)
  const bc = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const idx = hist.used[i]
    const c = hist.counts[idx]
    bc[i] = c
    br[i] = hist.sumR[idx] / c
    bg[i] = hist.sumG[idx] / c
    bb[i] = hist.sumB[idx] / c
  }

  if (n <= k) {
    const rgb = new Uint8Array(n * 3)
    for (let i = 0; i < n; i++) {
      rgb[i * 3] = clamp255(Math.round(br[i]))
      rgb[i * 3 + 1] = clamp255(Math.round(bg[i]))
      rgb[i * 3 + 2] = clamp255(Math.round(bb[i]))
    }
    return { rgb, size: n }
  }

  const order = new Int32Array(n)
  for (let i = 0; i < n; i++) order[i] = i

  const boxes: Box[] = [makeBox(order, 0, n, br, bg, bb, bc)]

  while (boxes.length < k) {
    // Pick the box worth splitting: largest population times longest side.
    // Ties resolve on the box's start offset, which is stable.
    let best = -1
    let bestScore = -1
    for (let i = 0; i < boxes.length; i++) {
      const bx = boxes[i]
      if (bx.end - bx.start < 2) continue
      const side = Math.max(bx.rMax - bx.rMin, bx.gMax - bx.gMin, bx.bMax - bx.bMin)
      if (side <= 0) continue
      const score = side * bx.count
      if (score > bestScore) {
        bestScore = score
        best = i
      }
    }
    if (best < 0) break

    const bx = boxes[best]
    const dr = bx.rMax - bx.rMin
    const dg = bx.gMax - bx.gMin
    const db = bx.bMax - bx.bMin
    // Longest axis wins; on a tie prefer R, then G, then B — fixed order.
    const axis = dr >= dg && dr >= db ? 0 : dg >= db ? 1 : 2
    const key = axis === 0 ? br : axis === 1 ? bg : bb

    const span = Array.from(order.subarray(bx.start, bx.end))
    span.sort((a, b) => {
      const d = key[a] - key[b]
      if (d !== 0) return d
      // Deterministic tie-break: bin index order.
      return a - b
    })
    order.set(span, bx.start)

    // Split at the population median, always leaving at least one bin per side.
    const half = bx.count / 2
    let acc = 0
    let cut = bx.start + 1
    for (let i = bx.start; i < bx.end - 1; i++) {
      acc += bc[order[i]]
      if (acc >= half) {
        cut = i + 1
        break
      }
      cut = i + 2
    }
    if (cut <= bx.start) cut = bx.start + 1
    if (cut >= bx.end) cut = bx.end - 1

    boxes[best] = makeBox(order, bx.start, cut, br, bg, bb, bc)
    boxes.push(makeBox(order, cut, bx.end, br, bg, bb, bc))
  }

  // Representatives: population-weighted centroid of each box.
  const size = boxes.length
  const pr = new Float64Array(size)
  const pg = new Float64Array(size)
  const pb = new Float64Array(size)
  for (let i = 0; i < size; i++) {
    const bx = boxes[i]
    let sr = 0
    let sg = 0
    let sb = 0
    let sc = 0
    for (let j = bx.start; j < bx.end; j++) {
      const bi = order[j]
      const c = bc[bi]
      sr += br[bi] * c
      sg += bg[bi] * c
      sb += bb[bi] * c
      sc += c
    }
    if (sc > 0) {
      pr[i] = sr / sc
      pg[i] = sg / sc
      pb[i] = sb / sc
    } else {
      pr[i] = br[order[bx.start]]
      pg[i] = bg[order[bx.start]]
      pb[i] = bb[order[bx.start]]
    }
  }

  lloyd(pr, pg, pb, size, br, bg, bb, bc, n)

  const rgb = new Uint8Array(size * 3)
  for (let i = 0; i < size; i++) {
    rgb[i * 3] = clamp255(Math.round(pr[i]))
    rgb[i * 3 + 1] = clamp255(Math.round(pg[i]))
    rgb[i * 3 + 2] = clamp255(Math.round(pb[i]))
  }
  return sortPalette(rgb, size)
}

/**
 * Lloyd / k-means refinement over histogram bins. Nearest ties go to the lowest
 * palette index (strict `<`), which keeps the result reproducible.
 */
function lloyd(
  pr: Float64Array,
  pg: Float64Array,
  pb: Float64Array,
  size: number,
  br: Float64Array,
  bg: Float64Array,
  bb: Float64Array,
  bc: Float64Array,
  n: number,
): void {
  const sr = new Float64Array(size)
  const sg = new Float64Array(size)
  const sb = new Float64Array(size)
  const sc = new Float64Array(size)
  for (let pass = 0; pass < LLOYD_PASSES; pass++) {
    sr.fill(0)
    sg.fill(0)
    sb.fill(0)
    sc.fill(0)
    for (let i = 0; i < n; i++) {
      const r = br[i]
      const g = bg[i]
      const b = bb[i]
      let best = 0
      let bestD = Infinity
      for (let p = 0; p < size; p++) {
        const dr = r - pr[p]
        const dg = g - pg[p]
        const db = b - pb[p]
        const d = dr * dr + dg * dg + db * db
        if (d < bestD) {
          bestD = d
          best = p
        }
      }
      const c = bc[i]
      sr[best] += r * c
      sg[best] += g * c
      sb[best] += b * c
      sc[best] += c
    }
    for (let p = 0; p < size; p++) {
      // An empty cluster keeps its previous representative rather than being
      // reseeded: reseeding would depend on iteration order and break
      // determinism for no measurable quality gain.
      if (sc[p] > 0) {
        pr[p] = sr[p] / sc[p]
        pg[p] = sg[p] / sc[p]
        pb[p] = sb[p] / sc[p]
      }
    }
  }
}

function makeBox(
  order: Int32Array,
  start: number,
  end: number,
  br: Float64Array,
  bg: Float64Array,
  bb: Float64Array,
  bc: Float64Array,
): Box {
  let rMin = Infinity
  let rMax = -Infinity
  let gMin = Infinity
  let gMax = -Infinity
  let bMin = Infinity
  let bMax = -Infinity
  let count = 0
  for (let i = start; i < end; i++) {
    const bi = order[i]
    const r = br[bi]
    const g = bg[bi]
    const b = bb[bi]
    if (r < rMin) rMin = r
    if (r > rMax) rMax = r
    if (g < gMin) gMin = g
    if (g > gMax) gMax = g
    if (b < bMin) bMin = b
    if (b > bMax) bMax = b
    count += bc[bi]
  }
  if (count === 0) {
    rMin = rMax = gMin = gMax = bMin = bMax = 0
  }
  return { start, end, count, rMin, rMax, gMin, gMax, bMin, bMax }
}

/**
 * Order the palette canonically (R, then G, then B). Median cut's box order
 * depends on the split sequence; sorting removes that last source of variation
 * so identical input yields a byte-identical colour table.
 */
export function sortPalette(rgb: Uint8Array, size: number): { rgb: Uint8Array; size: number } {
  const idx = Array.from({ length: size }, (_, i) => i)
  idx.sort((a, b) => {
    const ka = (rgb[a * 3] << 16) | (rgb[a * 3 + 1] << 8) | rgb[a * 3 + 2]
    const kb = (rgb[b * 3] << 16) | (rgb[b * 3 + 1] << 8) | rgb[b * 3 + 2]
    return ka - kb || a - b
  })
  const out = new Uint8Array(size * 3)
  for (let i = 0; i < size; i++) {
    out[i * 3] = rgb[idx[i] * 3]
    out[i * 3 + 1] = rgb[idx[i] * 3 + 1]
    out[i * 3 + 2] = rgb[idx[i] * 3 + 2]
  }
  return { rgb: out, size }
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v
}
