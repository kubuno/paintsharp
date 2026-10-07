// Bounds-checked binary reader. Every integer read validates its range first, so a
// truncated file raises `IoTruncatedError` instead of yielding `undefined`/`NaN` that
// then propagates into a loop bound.

import { IoTruncatedError } from './types'

export class ByteReader {
  readonly bytes: Uint8Array
  readonly view: DataView
  /** Byte order used by the `read*` helpers; TIFF flips it after the header. */
  littleEndian: boolean
  private pos = 0

  constructor(src: Uint8Array | ArrayBuffer, littleEndian = true) {
    this.bytes = src instanceof Uint8Array ? src : new Uint8Array(src)
    this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength)
    this.littleEndian = littleEndian
  }

  get length(): number {
    return this.bytes.length
  }

  get offset(): number {
    return this.pos
  }

  set offset(v: number) {
    if (!Number.isFinite(v) || v < 0 || v > this.bytes.length) {
      throw new IoTruncatedError(`seek to ${v} outside 0..${this.bytes.length}`)
    }
    this.pos = v
  }

  get remaining(): number {
    return this.bytes.length - this.pos
  }

  /** Throws unless `[off, off + len)` is inside the buffer. */
  check(off: number, len: number): void {
    if (
      !Number.isFinite(off) ||
      !Number.isFinite(len) ||
      off < 0 ||
      len < 0 ||
      off + len > this.bytes.length
    ) {
      throw new IoTruncatedError(
        `read of ${len} byte(s) at ${off} runs past end of buffer (${this.bytes.length})`,
      )
    }
  }

  /** True when the range is readable — for optional/best-effort reads. */
  has(off: number, len: number): boolean {
    return Number.isFinite(off) && Number.isFinite(len) && off >= 0 && len >= 0 && off + len <= this.bytes.length
  }

  skip(n: number): void {
    this.offset = this.pos + n
  }

  u8(): number {
    this.check(this.pos, 1)
    return this.bytes[this.pos++]
  }

  i8(): number {
    return (this.u8() << 24) >> 24
  }

  u16(): number {
    this.check(this.pos, 2)
    const v = this.view.getUint16(this.pos, this.littleEndian)
    this.pos += 2
    return v
  }

  i16(): number {
    this.check(this.pos, 2)
    const v = this.view.getInt16(this.pos, this.littleEndian)
    this.pos += 2
    return v
  }

  u32(): number {
    this.check(this.pos, 4)
    const v = this.view.getUint32(this.pos, this.littleEndian)
    this.pos += 4
    return v
  }

  i32(): number {
    this.check(this.pos, 4)
    const v = this.view.getInt32(this.pos, this.littleEndian)
    this.pos += 4
    return v
  }

  /** BigTIFF offsets. Values above 2^53 are rejected rather than silently truncated. */
  u64(): number {
    this.check(this.pos, 8)
    const v = this.view.getBigUint64(this.pos, this.littleEndian)
    this.pos += 8
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new IoTruncatedError(`64-bit value ${v} exceeds the safe integer range`)
    }
    return Number(v)
  }

  f32(): number {
    this.check(this.pos, 4)
    const v = this.view.getFloat32(this.pos, this.littleEndian)
    this.pos += 4
    return v
  }

  f64(): number {
    this.check(this.pos, 8)
    const v = this.view.getFloat64(this.pos, this.littleEndian)
    this.pos += 8
    return v
  }

  u8At(off: number): number {
    this.check(off, 1)
    return this.bytes[off]
  }

  u16At(off: number, le = this.littleEndian): number {
    this.check(off, 2)
    return this.view.getUint16(off, le)
  }

  u32At(off: number, le = this.littleEndian): number {
    this.check(off, 4)
    return this.view.getUint32(off, le)
  }

  /** Zero-copy view. The caller must not write through it. */
  subarray(off: number, len: number): Uint8Array {
    this.check(off, len)
    return this.bytes.subarray(off, off + len)
  }

  /** Owned copy. */
  slice(off: number, len: number): Uint8Array {
    this.check(off, len)
    return this.bytes.slice(off, off + len)
  }

  /** Latin-1 text, NUL-trimmed. Used for 4-character container tags and ASCII fields. */
  ascii(off: number, len: number): string {
    this.check(off, len)
    let s = ''
    for (let i = 0; i < len; i++) {
      const c = this.bytes[off + i]
      if (c === 0) break
      s += String.fromCharCode(c)
    }
    return s
  }

  read(len: number): Uint8Array {
    const v = this.subarray(this.pos, len)
    this.pos += len
    return v
  }
}

/** Compares a byte prefix without allocating. */
export function matchBytes(buf: Uint8Array, offset: number, sig: readonly number[]): boolean {
  if (offset < 0 || offset + sig.length > buf.length) return false
  for (let i = 0; i < sig.length; i++) {
    if (buf[offset + i] !== sig[i]) return false
  }
  return true
}

/** Compares against an ASCII signature. */
export function matchAscii(buf: Uint8Array, offset: number, sig: string): boolean {
  if (offset < 0 || offset + sig.length > buf.length) return false
  for (let i = 0; i < sig.length; i++) {
    if (buf[offset + i] !== sig.charCodeAt(i)) return false
  }
  return true
}

/** Latin-1 decode of a byte range, without a TextDecoder allocation for short strings. */
export function latin1(buf: Uint8Array, offset = 0, length = buf.length - offset): string {
  const end = Math.min(buf.length, offset + Math.max(0, length))
  let s = ''
  for (let i = Math.max(0, offset); i < end; i++) s += String.fromCharCode(buf[i])
  return s
}
