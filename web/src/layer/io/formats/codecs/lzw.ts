// SPDX-License-Identifier: AGPL-3.0-or-later
//
// LZW, the TIFF variant (compression 5) — NOT the GIF variant.
//
// Five traps sink naive implementations (spec 05 §4.4):
//   1. Bits are packed MSB-first (GIF is LSB-first).
//   2. ClearCode = 256, EndOfInformation = 257, first free code = 258.
//   3. Adobe's "early change": the code width grows one code early, at 511/1023/2047
//      instead of 512/1024/2048. Files without early change exist, so a stream that
//      turns incoherent is retried the other way round.
//   4. The dictionary is reset on every ClearCode AND at the start of every strip/tile.
//   5. `code === nextCode` (the string is not in the table yet) must be handled as
//      `entry = previous + previous[0]`.
//
// Algorithm from the TIFF 6.0 specification; behaviour cross-checked against libtiff as
// used by GIMP (plug-ins/file-tiff/, GPL-3.0-or-later, Copyright (C) 1995-2025 Spencer
// Kimball, Peter Mattis and the GIMP developers). Reimplemented; no code copied.

const CLEAR_CODE = 256
const EOI_CODE = 257
const FIRST_FREE = 258
const MAX_CODE = 4096

export interface LzwResult {
  readonly data: Uint8Array
  /** True when the stream ended cleanly (EOI or exhausted input at a code boundary). */
  readonly complete: boolean
}

function decodeOnce(src: Uint8Array, maxOut: number, earlyChange: boolean): LzwResult {
  const out = new Uint8Array(maxOut)
  let outPos = 0

  // Dictionary as prefix/suffix chains: no per-entry allocation, no string building.
  const prefix = new Int32Array(MAX_CODE)
  const suffix = new Uint8Array(MAX_CODE)
  const length = new Int32Array(MAX_CODE)
  for (let i = 0; i < 256; i++) {
    prefix[i] = -1
    suffix[i] = i
    length[i] = 1
  }

  let next = FIRST_FREE
  let codeWidth = 9
  let old = -1
  let bitBuf = 0
  let bitCount = 0
  let s = 0
  const stack = new Uint8Array(MAX_CODE + 1)
  let complete = false

  const grow = (): void => {
    // Early change widens one code early: at 511/1023/2047 instead of 512/1024/2048.
    const limit = earlyChange ? (1 << codeWidth) - 1 : 1 << codeWidth
    if (next >= limit && codeWidth < 12) codeWidth++
  }

  /** Writes the string of `code` to the output; returns false when the output is full. */
  const emitString = (code: number, appendFirstOf: number): boolean => {
    let sp = 0
    let c = code
    let guard = 0
    while (c >= 0 && guard++ <= MAX_CODE) {
      stack[sp++] = suffix[c]
      c = prefix[c]
    }
    const extra = appendFirstOf >= 0 ? 1 : 0
    if (outPos + sp + extra > maxOut) {
      while (sp > 0 && outPos < maxOut) out[outPos++] = stack[--sp]
      return false
    }
    while (sp > 0) out[outPos++] = stack[--sp]
    if (extra) out[outPos++] = firstByte(prefix, suffix, appendFirstOf)
    return true
  }

  for (;;) {
    while (bitCount < codeWidth) {
      if (s >= src.length) {
        // Input exhausted at a code boundary: a clean end.
        return { data: out.subarray(0, outPos), complete: true }
      }
      bitBuf = ((bitBuf << 8) | src[s++]) >>> 0
      bitCount += 8
    }
    const code = (bitBuf >>> (bitCount - codeWidth)) & ((1 << codeWidth) - 1)
    bitCount -= codeWidth

    if (code === EOI_CODE) {
      complete = true
      break
    }
    if (code === CLEAR_CODE) {
      next = FIRST_FREE
      codeWidth = 9
      old = -1
      continue
    }
    if (old < 0) {
      // First code after a clear must be a literal.
      if (code >= 256) break
      if (!emitString(code, -1)) return { data: out.subarray(0, outPos), complete: true }
      old = code
      continue
    }
    if (code < next) {
      if (!emitString(code, -1)) return { data: out.subarray(0, outPos), complete: true }
      if (next < MAX_CODE) {
        prefix[next] = old
        suffix[next] = firstByte(prefix, suffix, code)
        length[next] = length[old] + 1
        next++
        grow()
      }
      old = code
    } else if (code === next) {
      // The string is not in the table yet: entry = string(old) + firstByte(old).
      if (!emitString(old, old)) return { data: out.subarray(0, outPos), complete: true }
      if (next < MAX_CODE) {
        prefix[next] = old
        suffix[next] = firstByte(prefix, suffix, old)
        length[next] = length[old] + 1
        next++
        grow()
      }
      old = code
    } else {
      // Corrupt stream, or the early-change assumption is wrong.
      break
    }
  }

  return { data: out.subarray(0, outPos), complete }
}

function firstByte(prefix: Int32Array, suffix: Uint8Array, code: number): number {
  let c = code
  let guard = 0
  while (prefix[c] >= 0 && guard++ <= MAX_CODE) c = prefix[c]
  return suffix[c]
}

/**
 * Decompresses one strip/tile. `maxOut` is the exact expected size (rows × bytes/row),
 * which is what bounds the allocation — the compressed data never dictates it.
 *
 * When the stream turns incoherent under Adobe's early-change rule and produced less
 * than 90 % of the expected bytes, it is retried without early change and the longer
 * result wins. Real-world files written by old encoders need this.
 */
export function lzwDecode(src: Uint8Array, maxOut: number): Uint8Array {
  if (maxOut <= 0) return new Uint8Array(0)
  const first = decodeOnce(src, maxOut, true)
  if (first.complete && first.data.length >= maxOut) return first.data
  if (first.data.length >= maxOut * 0.9) return first.data
  const second = decodeOnce(src, maxOut, false)
  return second.data.length > first.data.length ? second.data : first.data
}

// ---------------------------------------------------------------------------
// Encoder — same variant (MSB-first, early change), emitting a ClearCode whenever the
// dictionary fills up. Deflate compresses better and costs nothing, so LZW output exists
// only for compatibility with older software (spec 05 §4.4).
// ---------------------------------------------------------------------------

export function lzwEncode(src: Uint8Array): Uint8Array {
  const out: number[] = []
  let bitBuf = 0
  let bitCount = 0

  const write = (code: number, width: number): void => {
    bitBuf = (bitBuf << width) | code
    bitCount += width
    while (bitCount >= 8) {
      out.push((bitBuf >>> (bitCount - 8)) & 0xff)
      bitCount -= 8
    }
  }

  // Dictionary keyed by "prefixCode,byte"; a Map keeps the encoder short and is fast
  // enough for strip-sized inputs (~64 KiB).
  let dict = new Map<number, number>()
  let next = FIRST_FREE
  let width = 9

  write(CLEAR_CODE, width)
  if (src.length === 0) {
    write(EOI_CODE, width)
    if (bitCount > 0) out.push((bitBuf << (8 - bitCount)) & 0xff)
    return new Uint8Array(out)
  }

  let prev = src[0]
  for (let i = 1; i < src.length; i++) {
    const b = src[i]
    const key = prev * 256 + b
    const found = dict.get(key)
    if (found !== undefined) {
      prev = found
      continue
    }
    write(prev, width)
    dict.set(key, next)
    next++
    if (next >= MAX_CODE - 2) {
      // Dictionary full: reset both sides. The clear is emitted at the current width.
      write(CLEAR_CODE, width)
      dict = new Map()
      next = FIRST_FREE
      width = 9
    } else if (next >= 1 << width && width < 12) {
      // The decoder is exactly one entry behind (it only starts adding on the SECOND code
      // after a clear), so it widens at 511/1023/2047 while the encoder widens at
      // 512/1024/2048. That one-code offset IS Adobe's "early change" — matching libtiff,
      // whose encoder uses MAXCODE(n) and whose decoder uses MAXCODE(n) - 1.
      width++
    }
    prev = b
  }
  write(prev, width)
  write(EOI_CODE, width)
  if (bitCount > 0) out.push((bitBuf << (8 - bitCount)) & 0xff)
  return new Uint8Array(out)
}
