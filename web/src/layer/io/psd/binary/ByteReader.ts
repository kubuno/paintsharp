/*
 * PSD/PSB bounds-checked binary cursor.
 *
 * The binary layout decoded here was derived from the GIMP PSD plug-in
 * (file-psd), Copyright 2007 John Marshall, GPLv3+, and from Adobe's public
 * "Photoshop File Formats Specification". Independent TypeScript
 * re-implementation; no GIMP source was copied. Kubuno is AGPLv3.
 *
 * Reference: gimp/plug-ins/file-psd/psd-util.c (fread_* helpers).
 */
import { PsdError, allocBytes } from '../errors.ts'

/**
 * Big-endian by default; `littleEndian` exists only for the `ibm_pc_format`
 * quirk described in spec §1.7 (third-party writers that emit the Layer & Mask
 * section little-endian). ASCII signatures are never byte-swapped.
 *
 * EVERY read validates against `end`, so a lying length can never make the
 * parser walk past the block it belongs to. Sub-readers (`sub()`) are the main
 * structural protection: each block, descriptor and channel gets a cursor
 * clamped to its declared length.
 */
export class ByteReader {
  readonly data: Uint8Array
  readonly view: DataView
  readonly start: number
  readonly end: number
  littleEndian: boolean
  pos: number

  constructor(data: Uint8Array, start = 0, end = data.length, littleEndian = false) {
    this.data = data
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    this.start = clampIndex(start, 0, data.length)
    this.end = clampIndex(end, this.start, data.length)
    this.pos = this.start
    this.littleEndian = littleEndian
  }

  get remaining(): number {
    return this.end - this.pos
  }

  get eof(): boolean {
    return this.pos >= this.end
  }

  private need(n: number): number {
    const p = this.pos
    if (n < 0 || p + n > this.end) {
      throw new PsdError('UNEXPECTED_EOF', { pos: p, need: n, end: this.end })
    }
    this.pos = p + n
    return p
  }

  u8(): number {
    return this.data[this.need(1)]
  }

  i8(): number {
    const v = this.data[this.need(1)]
    return v > 127 ? v - 256 : v
  }

  u16(): number {
    return this.view.getUint16(this.need(2), this.littleEndian)
  }

  i16(): number {
    return this.view.getInt16(this.need(2), this.littleEndian)
  }

  u32(): number {
    return this.view.getUint32(this.need(4), this.littleEndian)
  }

  i32(): number {
    return this.view.getInt32(this.need(4), this.littleEndian)
  }

  u64(): bigint {
    return this.view.getBigUint64(this.need(8), this.littleEndian)
  }

  f32(): number {
    return this.view.getFloat32(this.need(4), this.littleEndian)
  }

  f64(): number {
    return this.view.getFloat64(this.need(8), this.littleEndian)
  }

  /** 16.16 fixed point, as used by ResolutionInfo and the legacy effects. */
  fixed32(): number {
    return this.i32() / 65536
  }

  /**
   * A 64-bit length narrowed to a JS number. Throws rather than silently
   * truncating: a value above 2^53 is always a corrupt or hostile file.
   */
  u64AsNumber(): number {
    const v = this.u64()
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new PsdError('TOO_LARGE', { length: v.toString() })
    }
    return Number(v)
  }

  /** Length-prefixed read helper: `u32` in PSD, `u64` in PSB. */
  length(isPsb: boolean): number {
    return isPsb ? this.u64AsNumber() : this.u32()
  }

  /** Fixed-width ASCII, used for signatures and 4-character keys. */
  ascii(n: number): string {
    const p = this.need(n)
    let s = ''
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.data[p + i])
    return s
  }

  /** Copies `n` bytes out. Use for anything kept beyond the parse. */
  bytes(n: number): Uint8Array {
    const p = this.need(n)
    // slice() copies: keeping a subarray alive would pin the whole source
    // ArrayBuffer (a 500 MB file) for as long as the document lives (§9.3-2).
    const out = allocBytes(n)
    out.set(this.data.subarray(p, p + n))
    return out
  }

  /** Zero-copy view of `n` bytes. Only for data consumed immediately. */
  peekBytes(n: number): Uint8Array {
    const p = this.need(n)
    return this.data.subarray(p, p + n)
  }

  skip(n: number): void {
    this.seekTo(this.pos + n)
  }

  /** Absolute seek, clamped to `[start, end]`. Never throws. */
  seekTo(abs: number): void {
    this.pos = clampIndex(abs, this.start, this.end)
  }

  /**
   * A cursor clamped to `[pos, pos + length]`. Does NOT advance this reader —
   * callers must `seekTo()` the declared end afterwards, which is what makes
   * mis-declared block lengths harmless.
   */
  sub(length: number): ByteReader {
    const from = this.pos
    const to = length < 0 ? from : Math.min(this.end, from + length)
    return new ByteReader(this.data, from, to, this.littleEndian)
  }
}

function clampIndex(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo
  const i = Math.trunc(v)
  return i < lo ? lo : i > hi ? hi : i
}
