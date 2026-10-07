/*
 * PSD/PSB growable big-endian writer with placeholder/patch support.
 *
 * The placeholder-then-patch strategy mirrors the GIMP PSD exporter
 * (psd-export.c: LayerMaskPos / LayerInfoPos / ExtraDataPos / ChannelLengthPos
 * plus g_seekable_seek), Copyright 2007 John Marshall, GPLv3+. Independent
 * TypeScript re-implementation; no GIMP source was copied. Kubuno is AGPLv3.
 */
import { PsdError } from '../errors.ts'
import { LIMITS } from '../constants.ts'

export class ByteWriter {
  private buf: Uint8Array
  private view: DataView
  private len = 0
  private readonly max: number

  constructor(initialCapacity = 64 * 1024, max: number = LIMITS.MAX_WRITE_BUFFER) {
    const cap = Math.max(64, Math.min(initialCapacity, max))
    this.buf = new Uint8Array(cap)
    this.view = new DataView(this.buf.buffer)
    this.max = max
  }

  get length(): number {
    return this.len
  }

  private grow(extra: number): number {
    const need = this.len + extra
    if (need > this.max) throw new PsdError('OUTPUT_TOO_LARGE', { need, max: this.max })
    if (need > this.buf.length) {
      let cap = this.buf.length
      while (cap < need) cap = Math.min(this.max, cap * 2)
      let next: Uint8Array
      try {
        next = new Uint8Array(cap)
      } catch {
        throw new PsdError('OUT_OF_MEMORY', { requested: cap })
      }
      next.set(this.buf.subarray(0, this.len))
      this.buf = next
      this.view = new DataView(next.buffer)
    }
    const at = this.len
    this.len = need
    return at
  }

  // ⚠️ `grow()` may REPLACE `this.buf` / `this.view`. JavaScript evaluates the
  // member-expression base before the arguments, so `this.view.setX(this.grow(n))`
  // would write into the STALE view. Every writer below therefore calls `grow()`
  // on its own line first.
  u8(v: number): void {
    const at = this.grow(1)
    this.buf[at] = v & 0xff
  }

  u16(v: number): void {
    const at = this.grow(2)
    this.view.setUint16(at, v & 0xffff, false)
  }

  i16(v: number): void {
    const at = this.grow(2)
    this.view.setInt16(at, clampInt(v, -32768, 32767), false)
  }

  u32(v: number): void {
    const at = this.grow(4)
    this.view.setUint32(at, v >>> 0, false)
  }

  i32(v: number): void {
    const at = this.grow(4)
    this.view.setInt32(at, clampInt(v, -2147483648, 2147483647), false)
  }

  u64(v: bigint): void {
    const at = this.grow(8)
    this.view.setBigUint64(at, v, false)
  }

  f32(v: number): void {
    const at = this.grow(4)
    this.view.setFloat32(at, v, false)
  }

  f64(v: number): void {
    const at = this.grow(8)
    this.view.setFloat64(at, v, false)
  }

  /** 16.16 fixed point. */
  fixed32(v: number): void {
    this.i32(Math.round(v * 65536))
  }

  /** Writes a length: `u32` in PSD, `u64` in PSB. */
  length64(isPsb: boolean, v: number): void {
    if (isPsb) this.u64(BigInt(v))
    else this.u32(v)
  }

  /**
   * ASCII bytes. When `exactLength` is given the string is truncated or padded
   * with spaces — blend keys such as `'mul '` rely on the space padding.
   */
  ascii(s: string, exactLength?: number): void {
    const n = exactLength ?? s.length
    const at = this.grow(n)
    for (let i = 0; i < n; i++) {
      const c = i < s.length ? s.charCodeAt(i) : 0x20
      this.buf[at + i] = c < 0x100 ? c : 0x3f // '?'
    }
  }

  bytes(b: Uint8Array): void {
    if (b.length === 0) return
    const at = this.grow(b.length)
    this.buf.set(b, at)
  }

  zeros(n: number): void {
    if (n <= 0) return
    const at = this.grow(n)
    this.buf.fill(0, at, at + n)
  }

  placeholderU32(): number {
    const at = this.grow(4)
    this.view.setUint32(at, 0, false)
    return at
  }

  placeholderU64(): number {
    const at = this.grow(8)
    this.view.setBigUint64(at, 0n, false)
    return at
  }

  /** `u32` placeholder in PSD, `u64` in PSB. */
  placeholderLength(isPsb: boolean): number {
    return isPsb ? this.placeholderU64() : this.placeholderU32()
  }

  patchU32(offset: number, v: number): void {
    if (offset < 0 || offset + 4 > this.len) throw new PsdError('OUTPUT_TOO_LARGE', { offset })
    this.view.setUint32(offset, v >>> 0, false)
  }

  patchU16(offset: number, v: number): void {
    if (offset < 0 || offset + 2 > this.len) throw new PsdError('OUTPUT_TOO_LARGE', { offset })
    this.view.setUint16(offset, v & 0xffff, false)
  }

  patchU64(offset: number, v: bigint): void {
    if (offset < 0 || offset + 8 > this.len) throw new PsdError('OUTPUT_TOO_LARGE', { offset })
    this.view.setBigUint64(offset, v, false)
  }

  patchLength(isPsb: boolean, offset: number, v: number): void {
    if (isPsb) this.patchU64(offset, BigInt(v))
    else this.patchU32(offset, v)
  }

  /** Pads with zeros until the length is a multiple of `n`. Returns bytes added. */
  align(n: 2 | 4): number {
    const pad = (n - (this.len % n)) % n
    this.zeros(pad)
    return pad
  }

  finish(): ArrayBuffer {
    // `buf` is always created here via `new Uint8Array(n)`, so its backing
    // store is a plain ArrayBuffer, never a SharedArrayBuffer.
    return (this.buf.buffer as ArrayBuffer).slice(0, this.len)
  }
}

function clampInt(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return 0
  const i = Math.trunc(v)
  return i < lo ? lo : i > hi ? hi : i
}
