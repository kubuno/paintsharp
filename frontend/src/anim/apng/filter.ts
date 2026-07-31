// PNG scanline filters (0 None, 1 Sub, 2 Up, 3 Average, 4 Paeth) and Adam7.

export function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

/**
 * Undo the filters of a full image in place.
 * `raw` is <filter byte><scanline> repeated; the returned buffer holds the
 * defiltered scanlines back to back.
 */
export function unfilter(raw: Uint8Array, bytesPerRow: number, height: number, bpp: number): Uint8Array {
  const out = new Uint8Array(bytesPerRow * height)
  let src = 0
  for (let y = 0; y < height; y++) {
    if (src >= raw.length) break
    const type = raw[src++]
    const row = y * bytesPerRow
    const prev = row - bytesPerRow
    const avail = Math.min(bytesPerRow, raw.length - src)
    out.set(raw.subarray(src, src + avail), row)
    src += avail
    switch (type) {
      case 0:
        break
      case 1:
        for (let i = bpp; i < bytesPerRow; i++) out[row + i] = (out[row + i] + out[row + i - bpp]) & 0xff
        break
      case 2:
        if (y > 0) for (let i = 0; i < bytesPerRow; i++) out[row + i] = (out[row + i] + out[prev + i]) & 0xff
        break
      case 3:
        for (let i = 0; i < bytesPerRow; i++) {
          const a = i >= bpp ? out[row + i - bpp] : 0
          const b = y > 0 ? out[prev + i] : 0
          out[row + i] = (out[row + i] + ((a + b) >> 1)) & 0xff
        }
        break
      case 4:
        for (let i = 0; i < bytesPerRow; i++) {
          const a = i >= bpp ? out[row + i - bpp] : 0
          const b = y > 0 ? out[prev + i] : 0
          const c = y > 0 && i >= bpp ? out[prev + i - bpp] : 0
          out[row + i] = (out[row + i] + paeth(a, b, c)) & 0xff
        }
        break
      default:
        // Unknown filter type: treat as None rather than rejecting the file.
        break
    }
  }
  return out
}

/**
 * Filter scanlines with libpng's minimum-sum-of-absolute-differences heuristic:
 * compute all five candidates and keep the one whose bytes, read as signed,
 * have the smallest absolute sum. Empirical, but it is the de-facto standard
 * and worth 5 to 15 % of file size.
 */
export function filterScanlines(pixels: Uint8Array, bytesPerRow: number, height: number, bpp: number): Uint8Array {
  const out = new Uint8Array((bytesPerRow + 1) * height)
  const cand = [new Uint8Array(bytesPerRow), new Uint8Array(bytesPerRow), new Uint8Array(bytesPerRow), new Uint8Array(bytesPerRow), new Uint8Array(bytesPerRow)]
  for (let y = 0; y < height; y++) {
    const row = y * bytesPerRow
    const prev = row - bytesPerRow
    for (let i = 0; i < bytesPerRow; i++) {
      const x = pixels[row + i]
      const a = i >= bpp ? pixels[row + i - bpp] : 0
      const b = y > 0 ? pixels[prev + i] : 0
      const c = y > 0 && i >= bpp ? pixels[prev + i - bpp] : 0
      cand[0][i] = x
      cand[1][i] = (x - a) & 0xff
      cand[2][i] = (x - b) & 0xff
      cand[3][i] = (x - ((a + b) >> 1)) & 0xff
      cand[4][i] = (x - paeth(a, b, c)) & 0xff
    }
    let best = 0
    let bestScore = Infinity
    for (let f = 0; f < 5; f++) {
      let s = 0
      const c = cand[f]
      for (let i = 0; i < bytesPerRow; i++) s += c[i] < 128 ? c[i] : 256 - c[i]
      if (s < bestScore) {
        bestScore = s
        best = f
      }
    }
    out[y * (bytesPerRow + 1)] = best
    out.set(cand[best], y * (bytesPerRow + 1) + 1)
  }
  return out
}

export interface Adam7Pass {
  xOffset: number
  yOffset: number
  xStep: number
  yStep: number
  width: number
  height: number
}

const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
] as const

/** Geometry of the seven Adam7 passes for a `width` x `height` image. */
export function adam7Passes(width: number, height: number): Adam7Pass[] {
  return ADAM7.map(([xo, yo, xs, ys]) => ({
    xOffset: xo,
    yOffset: yo,
    xStep: xs,
    yStep: ys,
    width: Math.ceil(Math.max(0, width - xo) / xs),
    height: Math.ceil(Math.max(0, height - yo) / ys),
  }))
}
