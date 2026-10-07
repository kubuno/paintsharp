// Bit-level helpers shared by the TIFF, BMP, ICO and PNM decoders.

/** Precomputed bit-reversal table, for TIFF `FillOrder = 2` (LSB-first bit streams). */
const REVERSE = (() => {
  const t = new Uint8Array(256)
  for (let i = 0; i < 256; i++) {
    let v = i
    let r = 0
    for (let b = 0; b < 8; b++) {
      r = (r << 1) | (v & 1)
      v >>= 1
    }
    t[i] = r
  }
  return t
})()

/** Reverses the bit order of every byte, in place. */
export function reverseBits(data: Uint8Array): void {
  for (let i = 0; i < data.length; i++) data[i] = REVERSE[data[i]]
}

/**
 * Expands sub-byte samples (1, 2 or 4 bits, MSB-first) to one byte each.
 *
 * Rows are padded to a whole byte in TIFF — never to 4 bytes, that is BMP's rule — so
 * the row start is recomputed for every row instead of walking the stream linearly.
 *
 * @param scale when true the value is stretched to 0..255 (grayscale/RGB); when false the
 *              raw index is kept (palette images, where scaling would destroy the index)
 */
export function unpackSubByteSamples(
  src: Uint8Array,
  dst: Uint8Array,
  width: number,
  height: number,
  channels: number,
  bitsPerSample: number,
  scale: boolean,
): void {
  const samplesPerRow = width * channels
  const bytesPerRow = Math.ceil((samplesPerRow * bitsPerSample) / 8)
  const max = (1 << bitsPerSample) - 1
  const mul = scale ? 255 / max : 1
  let d = 0
  for (let y = 0; y < height; y++) {
    const rowStart = y * bytesPerRow
    let bitPos = 0
    for (let i = 0; i < samplesPerRow; i++) {
      const byteIndex = rowStart + (bitPos >> 3)
      if (byteIndex >= src.length || d >= dst.length) return
      const shift = 8 - bitsPerSample - (bitPos & 7)
      const v = (src[byteIndex] >> shift) & max
      dst[d++] = scale ? Math.round(v * mul) : v
      bitPos += bitsPerSample
    }
  }
}

/** Packs 8-bit samples back into 1/2/4-bit rows padded to a byte (TIFF/PNG writers). */
export function packSubByteSamples(
  src: Uint8Array,
  width: number,
  height: number,
  channels: number,
  bitsPerSample: number,
): Uint8Array {
  const samplesPerRow = width * channels
  const bytesPerRow = Math.ceil((samplesPerRow * bitsPerSample) / 8)
  const out = new Uint8Array(bytesPerRow * height)
  const max = (1 << bitsPerSample) - 1
  for (let y = 0; y < height; y++) {
    const rowStart = y * bytesPerRow
    let bitPos = 0
    for (let i = 0; i < samplesPerRow; i++) {
      const v = Math.min(max, src[y * samplesPerRow + i] ?? 0)
      const shift = 8 - bitsPerSample - (bitPos & 7)
      out[rowStart + (bitPos >> 3)] |= (v & max) << shift
      bitPos += bitsPerSample
    }
  }
  return out
}

/** IEEE 754 binary16 → number. Portable, ~15 lines, no reliance on `Float16Array`. */
export function halfToFloat(bits: number): number {
  const sign = (bits & 0x8000) !== 0 ? -1 : 1
  const exponent = (bits >> 10) & 0x1f
  const mantissa = bits & 0x3ff
  if (exponent === 0) return sign * mantissa * 2 ** -24
  if (exponent === 31) return mantissa === 0 ? sign * Infinity : NaN
  return sign * (mantissa + 1024) * 2 ** (exponent - 25)
}

/** number → IEEE 754 binary16 bits, round-to-nearest-even on the mantissa. */
export function floatToHalf(value: number): number {
  if (Number.isNaN(value)) return 0x7e00
  const sign = value < 0 || Object.is(value, -0) ? 0x8000 : 0
  const v = Math.abs(value)
  if (v === Infinity) return sign | 0x7c00
  if (v === 0) return sign
  if (v >= 65520) return sign | 0x7c00
  if (v < 2 ** -24) return sign
  if (v < 2 ** -14) {
    // Subnormal.
    return sign | Math.round(v / 2 ** -24)
  }
  const exponent = Math.floor(Math.log2(v))
  const mantissa = Math.round((v / 2 ** exponent - 1) * 1024)
  if (mantissa === 1024) return sign | ((exponent + 16) << 10)
  return sign | ((exponent + 15) << 10) | mantissa
}
