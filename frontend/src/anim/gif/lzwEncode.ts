// GIF LZW encoder.
//
// Algorithm reimplemented in TypeScript from GIMP's
// plug-ins/common/file-gif-export.c (GPL-3.0-or-later), itself derived from
// compress(1): open hash table of 5003 entries with secondary probing, a clear
// code emitted first, and a clear when the 4096-entry table fills up.
// Kubuno is AGPL-3.0-or-later, into which GPLv3 code may be combined.

const HSIZE = 5003

/**
 * @param indices     one byte per pixel, values < 2**minCodeSize
 * @param minCodeSize 2..8 (2 even for a two-colour image — the format demands it)
 * @returns the raw LZW byte stream, WITHOUT the sub-block framing
 */
export function lzwEncode(indices: Uint8Array, minCodeSize: number): Uint8Array {
  const mcs = Math.max(2, Math.min(8, minCodeSize | 0))
  const clearCode = 1 << mcs
  const endCode = clearCode + 1

  const htab = new Int32Array(HSIZE)
  const codetab = new Int32Array(HSIZE)
  htab.fill(-1)

  let next = endCode + 1
  let codeSize = mcs + 1

  let out = new Uint8Array(Math.max(64, indices.length >> 1))
  let outLen = 0
  let acc = 0
  let accBits = 0

  const emitByte = (b: number): void => {
    if (outLen === out.length) {
      const grown = new Uint8Array(out.length * 2)
      grown.set(out)
      out = grown
    }
    out[outLen++] = b
  }

  const output = (code: number): void => {
    acc |= code << accBits
    accBits += codeSize
    while (accBits >= 8) {
      emitByte(acc & 0xff)
      acc >>>= 8
      accBits -= 8
    }
  }

  const resetTable = (): void => {
    htab.fill(-1)
    next = endCode + 1
  }

  // Not strictly required by the specification, but several decoders (and every
  // old browser) assume a leading clear code. GIMP writes one; so do we.
  output(clearCode)

  if (indices.length === 0) {
    output(endCode)
    flush()
    return out.slice(0, outLen)
  }

  let prefix = indices[0]
  for (let i = 1; i < indices.length; i++) {
    const suffix = indices[i]
    const fcode = (suffix << 12) | prefix
    let h = (suffix << 4) ^ prefix
    if (h >= HSIZE) h %= HSIZE
    let found = false
    for (;;) {
      if (htab[h] === fcode) {
        prefix = codetab[h]
        found = true
        break
      }
      if (htab[h] < 0) break
      // Secondary displacement, decrementing and wrapping.
      const disp = h === 0 ? 1 : HSIZE - h
      h -= disp
      if (h < 0) h += HSIZE
    }
    if (found) continue

    output(prefix)
    prefix = suffix
    if (next < 4096) {
      htab[h] = fcode
      codetab[h] = next
      next++
      if (next > 1 << codeSize && codeSize < 12) codeSize++
    } else {
      // Table full: emit a clear code and start over. Emitting it BEFORE the
      // code size resets matters — the decoder reads it at the current width.
      output(clearCode)
      codeSize = mcs + 1
      resetTable()
    }
  }

  output(prefix)
  output(endCode)
  flush()
  return out.slice(0, outLen)

  function flush(): void {
    // Trailing padding bits are zero, as the format requires.
    while (accBits > 0) {
      emitByte(acc & 0xff)
      acc >>>= 8
      accBits -= 8
    }
    acc = 0
    accBits = 0
  }
}

/** Smallest legal LZW minimum code size for a palette of `size` entries. */
export function minCodeSizeFor(size: number): number {
  let bits = 2
  while (1 << bits < size) bits++
  return Math.max(2, Math.min(8, bits))
}
