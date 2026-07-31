// Dithering. Three modes, and the default depends on whether we are writing an
// animation or a still image — which is not a matter of taste.
//
// Floyd-Steinberg diffuses the quantisation error to neighbours that have not
// been processed yet, so a pixel's final value depends on ITS NEIGHBOURS.
// Between two frames, an area that is visually identical but ADJACENT to an
// area that moved receives a different error and changes value. Two
// consequences, both bad:
//
//   1. The minimal difference rectangle explodes and ends up covering nearly the
//      whole image, cancelling the most profitable optimisation of the pipeline
//      (up to a factor 5 on file size).
//   2. On playback the dither noise crawls from frame to frame — a temporal
//      artefact far more visible than the banding it was meant to remove.
//
// Bayer thresholds on POSITION only, `(x & 7, y & 7)` in ABSOLUTE canvas
// coordinates (note: absolute, not rectangle-relative — otherwise a moving
// difference rectangle would shift the pattern and reintroduce the crawl). Same
// colour at the same position always gives the same index, so the inter-frame
// diff stays clean.
//
//   animation -> Bayer 8x8      still image -> Floyd-Steinberg serpentine
//
// Alpha is NEVER dithered: thresholding is hard. Dithering alpha produces a
// halo of isolated pixels along every antialiased edge.

import type { DitherKind, Palette } from '../types.ts'
import type { ColorMapper } from './nearest.ts'

/**
 * Bayer 8x8, built by the recurrence M(2n) = [[4M, 4M+2], [4M+3, 4M+1]] rather
 * than hard-coded, so the construction is auditable.
 */
export const BAYER8 = buildBayer(8)

function buildBayer(n: number): Int32Array {
  let m = Int32Array.of(0)
  let size = 1
  while (size < n) {
    const next = new Int32Array(size * 2 * size * 2)
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const v = m[y * size + x] * 4
        next[y * size * 2 + x] = v
        next[y * size * 2 + (x + size)] = v + 2
        next[(y + size) * size * 2 + x] = v + 3
        next[(y + size) * size * 2 + (x + size)] = v + 1
      }
    }
    m = next
    size *= 2
  }
  return m
}

export interface DitherOptions {
  /** Frame rectangle pixels, RGBA8. */
  src: Uint8ClampedArray
  w: number
  h: number
  /** Absolute canvas coordinates of the rectangle's top-left corner. */
  originX: number
  originY: number
  palette: Palette
  mapper: ColorMapper
  kind: DitherKind
  /** 0..100. */
  strength: number
  /** 1 = write the transparent index and skip this pixel entirely. */
  transparentMask: Uint8Array
}

/** Quantise a frame rectangle to palette indices. */
export function ditherToIndices(o: DitherOptions): Uint8Array {
  const out = new Uint8Array(o.w * o.h)
  const ti = o.palette.transparentIndex >= 0 ? o.palette.transparentIndex : 0
  if (o.kind === 'floydSteinberg') return floydSteinberg(o, out, ti)
  if (o.kind === 'bayer') return bayer(o, out, ti)
  return plain(o, out, ti)
}

function plain(o: DitherOptions, out: Uint8Array, ti: number): Uint8Array {
  const { src, w, h, mapper, transparentMask } = o
  for (let i = 0, n = w * h; i < n; i++) {
    if (transparentMask[i]) {
      out[i] = ti
      continue
    }
    out[i] = mapper.map(src[i * 4], src[i * 4 + 1], src[i * 4 + 2])
  }
  return out
}

function bayer(o: DitherOptions, out: Uint8Array, ti: number): Uint8Array {
  const { src, w, h, mapper, transparentMask, originX, originY } = o
  // Amplitude is derived from the palette's mean spacing: a 256-colour palette
  // spread over the cube has roughly 255 / cbrt(256) ~= 40 between neighbours.
  const amp = (255 / Math.cbrt(Math.max(2, o.palette.size))) * (Math.max(0, Math.min(100, o.strength)) / 100)
  for (let y = 0; y < h; y++) {
    const by = (originY + y) & 7
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (transparentMask[i]) {
        out[i] = ti
        continue
      }
      const t = (BAYER8[by * 8 + ((originX + x) & 7)] / 64 - 0.5) * amp
      const o4 = i * 4
      out[i] = mapper.map(clamp255(src[o4] + t), clamp255(src[o4 + 1] + t), clamp255(src[o4 + 2] + t))
    }
  }
  return out
}

function floydSteinberg(o: DitherOptions, out: Uint8Array, ti: number): Uint8Array {
  const { src, w, h, mapper, palette, transparentMask } = o
  const k = (Math.max(0, Math.min(100, o.strength)) / 100) / 16
  // One extra cell on each side so the edge taps need no bounds test.
  const stride = w + 2
  let cur = new Float32Array(stride * 3)
  let next = new Float32Array(stride * 3)

  for (let y = 0; y < h; y++) {
    // Serpentine. Without it the error drifts steadily rightwards and leaves
    // the characteristic diagonal streaks.
    const dir = (y & 1) === 0 ? 1 : -1
    const start = dir === 1 ? 0 : w - 1
    next.fill(0)
    for (let n = 0; n < w; n++) {
      const x = start + dir * n
      const i = y * w + x
      if (transparentMask[i]) {
        out[i] = ti
        continue
      }
      const c = (x + 1) * 3
      const o4 = i * 4
      const r = clamp255(src[o4] + cur[c])
      const g = clamp255(src[o4 + 1] + cur[c + 1])
      const b = clamp255(src[o4 + 2] + cur[c + 2])
      const idx = mapper.map(r, g, b)
      out[i] = idx
      const er = (r - palette.rgb[idx * 3]) * k
      const eg = (g - palette.rgb[idx * 3 + 1]) * k
      const eb = (b - palette.rgb[idx * 3 + 2]) * k
      const fwd = (x + 1 + dir) * 3
      const back = (x + 1 - dir) * 3
      cur[fwd] += er * 7
      cur[fwd + 1] += eg * 7
      cur[fwd + 2] += eb * 7
      next[back] += er * 3
      next[back + 1] += eg * 3
      next[back + 2] += eb * 3
      next[c] += er * 5
      next[c + 1] += eg * 5
      next[c + 2] += eb * 5
      next[fwd] += er
      next[fwd + 1] += eg
      next[fwd + 2] += eb
    }
    const swap = cur
    cur = next
    next = swap
  }
  return out
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v
}
