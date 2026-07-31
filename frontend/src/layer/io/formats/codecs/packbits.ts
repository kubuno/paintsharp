// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PackBits (TIFF compression 32773, also used by TGA-adjacent Apple formats).
// Algorithm from the TIFF 6.0 specification; behaviour cross-checked against GIMP's
// libtiff usage in plug-ins/file-tiff/file-tiff-load.c. GIMP is Copyright (C) 1995-2025
// Spencer Kimball, Peter Mattis and the GIMP developers, GPL-3.0-or-later; Kubuno is
// AGPL-3.0-or-later, which is compatible. Reimplemented in TypeScript; no code copied.

/**
 * Decompresses one strip/tile. Stops at the end of either buffer, so a truncated strip
 * yields a partially-filled row rather than an exception or an overrun.
 *
 * @returns the number of bytes actually written.
 */
export function unpackBits(src: Uint8Array, out: Uint8Array): number {
  let s = 0
  let d = 0
  while (s < src.length && d < out.length) {
    // Sign-extend to int8: >= 0 means a literal run, < 0 a repeat.
    const n = (src[s++] << 24) >> 24
    if (n >= 0) {
      const count = Math.min(n + 1, src.length - s, out.length - d)
      for (let i = 0; i < count; i++) out[d++] = src[s++]
      if (count < n + 1) break // truncated
    } else if (n !== -128) {
      if (s >= src.length) break
      const b = src[s++]
      const count = Math.min(1 - n, out.length - d)
      for (let i = 0; i < count; i++) out[d++] = b
    }
    // n === -128 is a documented no-op filler.
  }
  return d
}

/**
 * Compresses one row/strip. Literal runs are capped at 128 bytes and repeats at 128, per
 * the specification. Worst case output is `len + ceil(len / 128)`.
 */
export function packBits(src: Uint8Array): Uint8Array {
  const out = new Uint8Array(src.length + Math.ceil(src.length / 128) + 1)
  let o = 0
  let i = 0
  while (i < src.length) {
    // Count the run of identical bytes starting at i.
    let run = 1
    while (i + run < src.length && src[i + run] === src[i] && run < 128) run++
    if (run >= 3) {
      out[o++] = 256 - (run - 1) // (1 - run) as a signed byte
      out[o++] = src[i]
      i += run
      continue
    }
    // Otherwise gather literals until a run of 3+ appears or we hit 128 bytes.
    let lit = 0
    while (i + lit < src.length && lit < 128) {
      if (
        i + lit + 2 < src.length &&
        src[i + lit] === src[i + lit + 1] &&
        src[i + lit] === src[i + lit + 2]
      ) {
        break
      }
      lit++
    }
    if (lit === 0) lit = 1
    out[o++] = lit - 1
    for (let k = 0; k < lit; k++) out[o++] = src[i + k]
    i += lit
  }
  return out.subarray(0, o)
}
