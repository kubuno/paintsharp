// Colour -> palette index mapping.
//
// Two implementations, deliberately:
//
//  * ExactMapper — a hash of the real 24-bit colours. Used on the "exact
//    palette" fast path (<= 256 distinct colours), where any approximation
//    would break the lossless GIF -> Layer -> GIF round-trip.
//  * NearestCache — a 5-5-5 lookup table filled lazily by exhaustive search
//    over <= 256 entries. 64 kB fits in L2, there is no pointer chasing and the
//    256-comparison loop vectorises well: in practice faster than a k-d tree at
//    this palette size.
//
// The cache is deliberately keyed on the palette, not on the frame: with a
// global palette it is SHARED by every frame, so colour lookup is amortised
// over the whole animation instead of being paid 200 times. That, far more than
// the quantiser itself, is what makes a 200-frame export tractable.

import type { Palette } from '../types.ts'

export interface ColorMapper {
  /** Palette index for an 8-bit RGB triplet. Never returns the transparent index. */
  map(r: number, g: number, b: number): number
}

export class NearestCache implements ColorMapper {
  private readonly rgb: Uint8Array
  private readonly size: number
  private readonly skip: number
  // Int16 rather than the more obvious Uint8Array with a 0xFF sentinel: palette
  // index 255 is perfectly legal and would collide with that sentinel.
  private readonly cache = new Int16Array(32768).fill(-1)

  constructor(palette: Palette) {
    this.rgb = palette.rgb
    this.size = palette.size
    this.skip = palette.transparentIndex
  }

  map(r: number, g: number, b: number): number {
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)
    const hit = this.cache[key]
    if (hit >= 0) return hit
    let best = 0
    let bestD = Infinity
    for (let i = 0; i < this.size; i++) {
      if (i === this.skip) continue
      const dr = r - this.rgb[i * 3]
      const dg = g - this.rgb[i * 3 + 1]
      const db = b - this.rgb[i * 3 + 2]
      const d = dr * dr + dg * dg + db * db
      // Strict `<`: ties go to the lowest index, so the result is reproducible.
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    this.cache[key] = best
    return best
  }
}

export class ExactMapper implements ColorMapper {
  private readonly table = new Map<number, number>()
  private readonly fallback: NearestCache

  constructor(palette: Palette) {
    for (let i = 0; i < palette.size; i++) {
      if (i === palette.transparentIndex) continue
      const key = (palette.rgb[i * 3] << 16) | (palette.rgb[i * 3 + 1] << 8) | palette.rgb[i * 3 + 2]
      // First index wins: a duplicated colour must always map to the same slot.
      if (!this.table.has(key)) this.table.set(key, i)
    }
    this.fallback = new NearestCache(palette)
  }

  map(r: number, g: number, b: number): number {
    const hit = this.table.get((r << 16) | (g << 8) | b)
    // A colour outside the exact set can only appear when the caller dithered;
    // fall back to nearest rather than returning garbage.
    return hit === undefined ? this.fallback.map(r, g, b) : hit
  }
}

/** Mean squared error of mapping `pixels` (RGBA) through `mapper`. */
export function paletteError(pixels: Uint8ClampedArray, palette: Palette, mapper: ColorMapper): number {
  let sum = 0
  let n = 0
  for (let o = 0; o < pixels.length; o += 4) {
    if (pixels[o + 3] === 0) continue
    const i = mapper.map(pixels[o], pixels[o + 1], pixels[o + 2])
    const dr = pixels[o] - palette.rgb[i * 3]
    const dg = pixels[o + 1] - palette.rgb[i * 3 + 1]
    const db = pixels[o + 2] - palette.rgb[i * 3 + 2]
    sum += dr * dr + dg * dg + db * db
    n++
  }
  return n === 0 ? 0 : sum / n
}
