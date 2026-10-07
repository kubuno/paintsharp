// 5-5-5 colour histogram with stratified sampling across frames.
//
// 32768 bins fit in a few hundred kB and, more importantly, they are what makes
// median cut and the three Lloyd passes work on *bins* instead of on *pixels*:
// refinement then costs milliseconds regardless of image size.

import type { RgbaImage } from '../types.ts'

/** Default sampling ceiling, in pixels, spread evenly over all frames. */
export const DEFAULT_SAMPLE_BUDGET = 2_000_000

export interface Histogram {
  /** Population of each 5-5-5 bin. */
  counts: Uint32Array
  /** Per-bin sums of the original 8-bit channels, for weighted means. */
  sumR: Float64Array
  sumG: Float64Array
  sumB: Float64Array
  /** Indices of the non-empty bins, ascending — deterministic by construction. */
  used: Int32Array
  usedCount: number
  /** Number of sampled opaque pixels. */
  total: number
}

export function bin555(r: number, g: number, b: number): number {
  return ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)
}

/**
 * Build the histogram over every frame.
 *
 * Sampling is STRATIFIED: each frame gets the same share of the budget. Taking
 * "the first N pixels" or "the first k frames" would miss a fade-out or a scene
 * change entirely and produce a palette that collapses on the second half of
 * the animation.
 *
 * Fully transparent pixels are skipped: they never need a palette entry.
 */
export function buildHistogram(frames: readonly RgbaImage[], budget = DEFAULT_SAMPLE_BUDGET): Histogram {
  const counts = new Uint32Array(32768)
  const sumR = new Float64Array(32768)
  const sumG = new Float64Array(32768)
  const sumB = new Float64Array(32768)
  let total = 0

  const n = Math.max(1, frames.length)
  const perFrame = Math.max(1, Math.floor(Math.max(1, budget) / n))

  for (const img of frames) {
    const px = img.data
    const pixels = (px.length / 4) | 0
    if (pixels <= 0) continue
    const step = Math.max(1, Math.floor(pixels / perFrame))
    for (let i = 0; i < pixels; i += step) {
      const o = i * 4
      if (px[o + 3] === 0) continue
      const r = px[o]
      const g = px[o + 1]
      const b = px[o + 2]
      const k = bin555(r, g, b)
      counts[k]++
      sumR[k] += r
      sumG[k] += g
      sumB[k] += b
      total++
    }
  }

  let usedCount = 0
  for (let i = 0; i < 32768; i++) if (counts[i] !== 0) usedCount++
  const used = new Int32Array(usedCount)
  let w = 0
  for (let i = 0; i < 32768; i++) if (counts[i] !== 0) used[w++] = i

  return { counts, sumR, sumG, sumB, used, usedCount, total }
}

/**
 * Exact distinct-colour census with early exit.
 *
 * When it succeeds we can use the exact palette: zero loss, zero dithering, and
 * the only way to guarantee that GIF -> Layer -> GIF leaves colours untouched.
 * Covers pixel art, screenshots, logos, line art — i.e. most real GIFs.
 * Returns null as soon as the limit is exceeded.
 */
export function exactColors(frames: readonly RgbaImage[], limit: number): Uint32Array | null {
  const seen = new Set<number>()
  for (const img of frames) {
    const px = img.data
    for (let o = 0; o < px.length; o += 4) {
      if (px[o + 3] === 0) continue
      // Pack as 0x00RRGGBB; alpha is binary at this point and lives elsewhere.
      const key = (px[o] << 16) | (px[o + 1] << 8) | px[o + 2]
      if (!seen.has(key)) {
        seen.add(key)
        if (seen.size > limit) return null
      }
    }
  }
  // Sorted for determinism: Set iteration order is insertion order, which would
  // depend on which frame happened to be scanned first.
  return Uint32Array.from([...seen].sort((a, b) => a - b))
}
