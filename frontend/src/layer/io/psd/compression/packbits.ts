/*
 * PSD/PSB PackBits (RLE) codec.
 *
 * The decoding/encoding algorithms implemented here were derived from the GIMP
 * PSD plug-in (file-psd), Copyright 2007 John Marshall, licensed under the GNU
 * General Public License v3 or later — `decode_packbits()` and
 * `encode_packbits()` in psd-util.c — and from Adobe's public "Photoshop File
 * Formats Specification".
 *
 * This is an independent TypeScript re-implementation; no GIMP source code was
 * copied. Kubuno is distributed under the GNU Affero General Public License v3,
 * which is compatible with the GPLv3 (GPLv3 §13).
 */

/**
 * Decodes one PackBits run into `dst`.
 *
 * Never throws on malformed input: it stops early and zero-fills the remainder,
 * mirroring GIMP's behaviour. The four `packLeft`/`unpackLeft` guards are what
 * make a forged row length harmless.
 *
 * @returns the number of bytes actually written (before the zero padding).
 */
export function decodePackBits(
  src: Uint8Array,
  srcOff: number,
  packedLen: number,
  dst: Uint8Array,
  dstOff: number,
  unpackedLen: number,
): number {
  let s = srcOff
  let d = dstOff
  let packLeft = Math.max(0, Math.min(packedLen, src.length - srcOff))
  let unpackLeft = Math.max(0, Math.min(unpackedLen, dst.length - dstOff))
  const total = unpackLeft

  while (unpackLeft > 0 && packLeft > 0) {
    let n = src[s++]
    packLeft--
    if (n === 128) continue // no-op, per spec: Photoshop never emits it, others do
    if (n > 128) n -= 256 // interpret as int8

    if (n < 0) {
      // Replicate the next byte (1 - n) times, i.e. 2..128 times.
      const count = 1 - n
      if (packLeft < 1) break
      if (unpackLeft < count) break
      dst.fill(src[s], d, d + count)
      s++
      packLeft--
      d += count
      unpackLeft -= count
    } else {
      // Copy the next (n + 1) bytes literally, i.e. 1..128 bytes.
      const count = n + 1
      if (packLeft < count) break
      if (unpackLeft < count) break
      dst.set(src.subarray(s, s + count), d)
      s += count
      packLeft -= count
      d += count
      unpackLeft -= count
    }
  }
  if (unpackLeft > 0) dst.fill(0, d, d + unpackLeft)
  return total - unpackLeft
}

/** Worst-case encoded size for `n` bytes: every 128-byte block costs 1 extra. */
export function packBitsWorstCase(n: number): number {
  return n + Math.ceil(n / 128) + 1
}

/**
 * PackBits encoder. `dst` must hold at least `packBitsWorstCase(src.length)`
 * bytes from `dstOff`.
 *
 * @returns the number of bytes written.
 */
export function encodePackBits(src: Uint8Array, dst: Uint8Array, dstOff: number): number {
  const n = src.length
  let d = dstOff
  let i = 0

  while (i < n) {
    // 1. Measure the run starting at i (capped at 128).
    let run = 1
    while (i + run < n && src[i + run] === src[i] && run < 128) run++

    if (run >= 3) {
      dst[d++] = 257 - run // -(run - 1) as an unsigned byte
      dst[d++] = src[i]
      i += run
      continue
    }

    // 2. Otherwise accumulate literals until a run of >= 3 starts, or 128 bytes.
    let lit = 0
    while (i + lit < n && lit < 128) {
      if (
        lit + 2 < n - i &&
        src[i + lit] === src[i + lit + 1] &&
        src[i + lit] === src[i + lit + 2]
      ) {
        break // a run begins here: close the literal block
      }
      lit++
    }
    dst[d++] = lit - 1
    dst.set(src.subarray(i, i + lit), d)
    d += lit
    i += lit
  }
  return d - dstOff
}
