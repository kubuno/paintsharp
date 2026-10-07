// SPDX-License-Identifier: AGPL-3.0-or-later
//
// XCF decoding logic derived from the GIMP source code (app/xcf/xcf-read.c,
// app/xcf/xcf-load.c), Copyright (C) 1995 Spencer Kimball and Peter Mattis and the GIMP
// contributors, licensed GPL-3.0-or-later. Reimplemented in TypeScript for Kubuno
// (AGPL-3.0-or-later). No line of GIMP's code is copied.
//
// XCF is big-endian throughout: `xcf-read.c` only ever uses g_ntohs/g_ntohl/
// GINT64_FROM_BE. The single exception is *tile component* order for files written by
// GIMP 2.9 development versions (v <= 11), handled in `pixels.ts`, not here.

import { ByteReader } from '../../formats/reader'
import { ImportError } from '../errors'

/** GIMP's MAX_XCF_STRING_LEN — a length field above this means the file is corrupt. */
export const MAX_XCF_STRING_LEN = 16 * 1024 * 1024

/**
 * Big-endian cursor over an XCF file, plus the two things that make XCF parsing
 * version-dependent: pointer width (4 or 8 bytes) and the forward-only offset rule.
 */
export class XcfReader {
  private readonly r: ByteReader
  /** 4 for XCF <= 10, 8 for XCF >= 11. Set once the header is parsed. */
  bytesPerOffset: 4 | 8 = 4
  /** Guards against pathological offset chasing on a crafted file (§4.2). */
  private jumps = 0
  private jumpBudget = 1 << 20

  constructor(bytes: Uint8Array) {
    // `false` = big-endian: every multi-byte field of the container is network order.
    this.r = new ByteReader(bytes, false)
  }

  get size(): number {
    return this.r.length
  }

  get pos(): number {
    return this.r.offset
  }

  set pos(v: number) {
    this.r.offset = v
  }

  get bytes(): Uint8Array {
    return this.r.bytes
  }

  has(off: number, len: number): boolean {
    return this.r.has(off, len)
  }

  u8(): number {
    return this.r.u8()
  }

  u32(): number {
    return this.r.u32()
  }

  i32(): number {
    return this.r.i32()
  }

  f32(): number {
    return this.r.f32()
  }

  skip(n: number): void {
    this.r.skip(n)
  }

  subarray(off: number, len: number): Uint8Array {
    return this.r.subarray(off, len)
  }

  read(len: number): Uint8Array {
    return this.r.read(len)
  }

  latin1(off: number, len: number): string {
    return this.r.ascii(off, len)
  }

  /** Reads a file pointer, whose width depends on the XCF version. */
  offset(): number {
    if (this.bytesPerOffset === 4) return this.r.u32()
    const hi = this.r.u32()
    const lo = this.r.u32()
    const v = hi * 0x1_0000_0000 + lo
    if (!Number.isSafeInteger(v)) {
      throw new ImportError('corrupt', 'layer.io.err.corrupt', undefined, `offset ${hi}:${lo} out of range`)
    }
    return v
  }

  /**
   * GIMP refuses any pointer that goes backwards (`xcf-load.c` checks
   * `offset >= info->cp` in three places). That single rule is what makes an XCF parser
   * immune to infinite loops on a corrupt or hostile file; we add a file-size bound and
   * a global jump budget on top.
   *
   * Returns false instead of throwing: the caller decides whether a bad pointer costs
   * one layer or the whole document.
   */
  validOffset(offset: number, minPos: number): boolean {
    if (!Number.isSafeInteger(offset) || offset <= 0) return false
    if (offset < minPos || offset >= this.r.length) return false
    if (++this.jumps > this.jumpBudget) return false
    return true
  }

  /** Sizes the jump budget from the file, so tiny files get a tiny budget. */
  setJumpBudget(expectedItems: number): void {
    this.jumpBudget = Math.max(4096, Math.min(1 << 22, expectedItems * 8))
  }

  /**
   * `xcf_read_string`: u32 length INCLUDING the trailing NUL, then that many bytes.
   * Length 0 means a null string. Decoded as non-fatal UTF-8, because GIMP itself runs
   * old files through `gimp_any_to_utf8` and tolerates Latin-1 leftovers.
   */
  string(): string {
    const len = this.u32()
    if (len === 0) return ''
    if (len > MAX_XCF_STRING_LEN) {
      throw new ImportError('corrupt', 'layer.io.err.corrupt', undefined, `string length ${len}`)
    }
    const raw = this.read(len)
    // Drop the trailing NUL (and any run of them) before decoding.
    let end = raw.length
    while (end > 0 && raw[end - 1] === 0) end -= 1
    return new TextDecoder('utf-8', { fatal: false }).decode(raw.subarray(0, end))
  }
}
