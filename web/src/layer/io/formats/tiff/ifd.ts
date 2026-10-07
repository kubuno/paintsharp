// SPDX-License-Identifier: AGPL-3.0-or-later
//
// TIFF / BigTIFF IFD reader — written ONCE and reused three ways (spec 05 §4.1, §6.2):
//   * the TIFF decoder (each IFD is a page),
//   * the EXIF parser (an EXIF block *is* a small TIFF file),
//   * the RAW/DNG sniffer's IFD0 peek.
//
// Robustness rules, from the specification and from GIMP's tolerance of real-world files
// (plug-ins/file-tiff/file-tiff-load.c has a dedicated `is_non_conformant_tiff`;
// GPL-3.0-or-later, Copyright (C) 1995-2025 Spencer Kimball, Peter Mattis and the GIMP
// developers — reimplemented in TypeScript, no code copied):
//   * an unknown field type does NOT fail the IFD: the entry is skipped with a warning,
//   * an offset outside the file does NOT fail the IFD: same treatment,
//   * IFD chains are cycle-checked and page-capped (a classic TIFF denial-of-service).

import { EXIF_TYPE_SIZE, ExifType } from '../../metadata/types'
import { MAX_IFD_ENTRIES, MAX_PAGES, MAX_TAG_COUNT } from '../limits'
import { ByteReader } from '../reader'
import { IoInvalidError, ioWarn, type IoWarning } from '../types'

export interface TiffHeader {
  readonly littleEndian: boolean
  readonly bigTiff: boolean
  readonly firstIfdOffset: number
  /** 4 for classic TIFF, 8 for BigTIFF. */
  readonly offsetSize: number
}

export interface IfdEntry {
  readonly tag: number
  readonly type: number
  readonly count: number
  /** Numeric values; rationals are stored as their quotient. Empty for ASCII/bytes. */
  readonly numbers?: readonly number[]
  /** ASCII fields, trailing NULs removed. */
  readonly text?: string
  /** BYTE / SBYTE / UNDEFINED payloads, and any value we chose not to interpret. */
  readonly bytes?: Uint8Array
  /** Exact numerator/denominator pairs, so a serializer can round-trip them. */
  readonly rationals?: readonly (readonly [number, number])[]
  /** Absolute file offset of the payload (or of the inline field). */
  readonly valueOffset: number
}

export interface Ifd {
  readonly offset: number
  readonly entries: ReadonlyMap<number, IfdEntry>
  /** 0 terminates the chain. */
  readonly nextOffset: number
}

export type WarnFn = (w: IoWarning) => void

/** Parses the 8-byte (classic) or 16-byte (BigTIFF) file header. */
export function readTiffHeader(bytes: Uint8Array): TiffHeader {
  if (bytes.length < 8) throw new IoInvalidError('TIFF header truncated')
  const le = bytes[0] === 0x49 && bytes[1] === 0x49
  const be = bytes[0] === 0x4d && bytes[1] === 0x4d
  if (!le && !be) throw new IoInvalidError('not a TIFF file: bad byte order mark')
  const r = new ByteReader(bytes, le)
  r.offset = 2
  const version = r.u16()
  if (version === 42) {
    const firstIfdOffset = r.u32()
    return { littleEndian: le, bigTiff: false, firstIfdOffset, offsetSize: 4 }
  }
  if (version === 43) {
    if (bytes.length < 16) throw new IoInvalidError('BigTIFF header truncated')
    const offsetSize = r.u16()
    const reserved = r.u16()
    if (offsetSize !== 8 || reserved !== 0) {
      throw new IoInvalidError(`unsupported BigTIFF header (offsetSize=${offsetSize})`)
    }
    const firstIfdOffset = r.u64()
    return { littleEndian: le, bigTiff: true, firstIfdOffset, offsetSize: 8 }
  }
  throw new IoInvalidError(`not a TIFF file: version ${version}`)
}

export class IfdReader {
  private readonly r: ByteReader

  constructor(
    bytes: Uint8Array,
    readonly header: TiffHeader,
    private readonly warn: WarnFn = () => undefined,
  ) {
    this.r = new ByteReader(bytes, header.littleEndian)
  }

  get bytes(): Uint8Array {
    return this.r.bytes
  }

  /** Reads a single IFD. Throws only when the entry-count field itself is unreadable. */
  readIfd(offset: number): Ifd {
    const r = this.r
    const big = this.header.bigTiff
    r.offset = offset
    const count = big ? r.u64() : r.u16()
    if (count > MAX_IFD_ENTRIES) {
      throw new IoInvalidError(`IFD at ${offset} declares ${count} entries`)
    }
    const entrySize = big ? 20 : 12
    const entriesStart = r.offset
    const entries = new Map<number, IfdEntry>()

    for (let i = 0; i < count; i++) {
      const base = entriesStart + i * entrySize
      if (!r.has(base, entrySize)) {
        this.warn(ioWarn('tiff.ifd-truncated', { offset, index: i }))
        break
      }
      const entry = this.readEntry(base)
      if (entry) entries.set(entry.tag, entry)
    }

    const nextPos = entriesStart + count * entrySize
    let nextOffset = 0
    if (r.has(nextPos, this.header.offsetSize)) {
      r.offset = nextPos
      nextOffset = big ? r.u64() : r.u32()
    }
    return { offset, entries, nextOffset }
  }

  /**
   * Walks the chained IFDs. Cycles and absurd chain lengths are the classic TIFF DoS,
   * so visited offsets are remembered and the page count is capped.
   */
  readChain(firstOffset: number, maxPages = MAX_PAGES): Ifd[] {
    const out: Ifd[] = []
    const visited = new Set<number>()
    let offset = firstOffset
    while (offset > 0 && out.length < maxPages) {
      if (visited.has(offset)) {
        this.warn(ioWarn('tiff.ifd-cycle', { offset }))
        break
      }
      visited.add(offset)
      let ifd: Ifd
      try {
        ifd = this.readIfd(offset)
      } catch (e) {
        this.warn(ioWarn('tiff.ifd-unreadable', { offset, error: String(e) }))
        break
      }
      out.push(ifd)
      offset = ifd.nextOffset
    }
    if (offset > 0 && out.length >= maxPages) {
      this.warn(ioWarn('tiff.too-many-pages', { limit: maxPages }))
    }
    return out
  }

  /** Reads a sub-IFD (EXIF 34665, GPS 34853, Interop 40965, SubIFDs 330). */
  readSubIfd(offset: number): Ifd | null {
    if (offset <= 0 || !this.r.has(offset, 2)) return null
    try {
      return this.readIfd(offset)
    } catch (e) {
      this.warn(ioWarn('tiff.subifd-unreadable', { offset, error: String(e) }))
      return null
    }
  }

  private readEntry(base: number): IfdEntry | null {
    const r = this.r
    const big = this.header.bigTiff
    r.offset = base
    const tag = r.u16()
    const type = r.u16()
    const count = big ? r.u64() : r.u32()
    const valueFieldOffset = r.offset
    const inlineCapacity = big ? 8 : 4

    const typeSize = EXIF_TYPE_SIZE[type] ?? 0
    if (typeSize === 0) {
      // Unknown field type: skip the entry, never the whole IFD.
      this.warn(ioWarn('tiff.unknown-field-type', { tag, type }, 'info'))
      return null
    }
    if (count > MAX_TAG_COUNT) {
      this.warn(ioWarn('tiff.tag-too-large', { tag, count }))
      return null
    }
    const total = count * typeSize
    let valueOffset: number
    if (total <= inlineCapacity) {
      valueOffset = valueFieldOffset
    } else {
      r.offset = valueFieldOffset
      valueOffset = big ? r.u64() : r.u32()
      if (!r.has(valueOffset, total)) {
        this.warn(ioWarn('tiff.value-out-of-range', { tag, offset: valueOffset, length: total }))
        return null
      }
    }
    return this.decodeValue(tag, type, count, valueOffset, typeSize)
  }

  private decodeValue(
    tag: number,
    type: number,
    count: number,
    valueOffset: number,
    typeSize: number,
  ): IfdEntry {
    const r = this.r
    const le = this.header.littleEndian
    const base: Omit<IfdEntry, 'numbers' | 'text' | 'bytes' | 'rationals'> = {
      tag,
      type,
      count,
      valueOffset,
    }
    switch (type) {
      case ExifType.Ascii: {
        const raw = r.subarray(valueOffset, count)
        let end = raw.length
        while (end > 0 && raw[end - 1] === 0) end--
        let text = ''
        for (let i = 0; i < end; i++) text += String.fromCharCode(raw[i])
        return { ...base, text, bytes: raw }
      }
      case ExifType.Byte:
      case ExifType.SByte:
      case ExifType.Undefined:
        return { ...base, bytes: r.subarray(valueOffset, count) }
      case ExifType.Rational:
      case ExifType.SRational: {
        const rationals: [number, number][] = []
        const numbers: number[] = []
        const view = r.view
        for (let i = 0; i < count; i++) {
          const o = valueOffset + i * 8
          const num = type === ExifType.Rational ? view.getUint32(o, le) : view.getInt32(o, le)
          const den = type === ExifType.Rational ? view.getUint32(o + 4, le) : view.getInt32(o + 4, le)
          rationals.push([num, den])
          numbers.push(den === 0 ? 0 : num / den)
        }
        return { ...base, numbers, rationals }
      }
      default: {
        const numbers = new Array<number>(count)
        const view = r.view
        for (let i = 0; i < count; i++) {
          const o = valueOffset + i * typeSize
          switch (type) {
            case ExifType.Short:
              numbers[i] = view.getUint16(o, le)
              break
            case ExifType.SShort:
              numbers[i] = view.getInt16(o, le)
              break
            case ExifType.Long:
            case ExifType.Ifd:
              numbers[i] = view.getUint32(o, le)
              break
            case ExifType.SLong:
              numbers[i] = view.getInt32(o, le)
              break
            case ExifType.Float:
              numbers[i] = view.getFloat32(o, le)
              break
            case ExifType.Double:
              numbers[i] = view.getFloat64(o, le)
              break
            case ExifType.Long8:
            case ExifType.Ifd8:
              numbers[i] = Number(view.getBigUint64(o, le))
              break
            case ExifType.SLong8:
              numbers[i] = Number(view.getBigInt64(o, le))
              break
            default:
              numbers[i] = 0
          }
        }
        return { ...base, numbers }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Value accessors — all tolerant: a missing or wrongly-typed tag returns the default
// rather than throwing, which is what real files require.
// ---------------------------------------------------------------------------

export function tagNumbers(ifd: Ifd, tag: number): readonly number[] | undefined {
  const e = ifd.entries.get(tag)
  if (!e) return undefined
  if (e.numbers) return e.numbers
  // Some writers store numeric tags as BYTE/UNDEFINED (IPTC as LONG is the classic case).
  if (e.bytes) return Array.from(e.bytes)
  return undefined
}

export function tagNumber(ifd: Ifd, tag: number, fallback: number): number {
  const v = tagNumbers(ifd, tag)
  return v && v.length > 0 && Number.isFinite(v[0]) ? v[0] : fallback
}

export function tagNumberOrUndefined(ifd: Ifd, tag: number): number | undefined {
  const v = tagNumbers(ifd, tag)
  return v && v.length > 0 && Number.isFinite(v[0]) ? v[0] : undefined
}

export function tagText(ifd: Ifd, tag: number): string | undefined {
  return ifd.entries.get(tag)?.text
}

export function tagBytes(ifd: Ifd, tag: number, reader: IfdReader): Uint8Array | undefined {
  const e = ifd.entries.get(tag)
  if (!e) return undefined
  if (e.bytes) return e.bytes
  // A tag written with a numeric type but meant as bytes (IPTC as LONG, XMP as LONG):
  // re-read the payload verbatim at its offset.
  const typeSize = EXIF_TYPE_SIZE[e.type] ?? 0
  if (typeSize === 0) return undefined
  const total = e.count * typeSize
  const r = new ByteReader(reader.bytes, reader.header.littleEndian)
  return r.has(e.valueOffset, total) ? r.subarray(e.valueOffset, total) : undefined
}
