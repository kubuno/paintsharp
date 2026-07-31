// SPDX-License-Identifier: AGPL-3.0-or-later
//
// EXIF parsing and serialisation (spec 05 §6.2).
//
// The crucial fact: an EXIF block IS a complete little TIFF file (`II`/`MM` header plus
// chained IFDs). The IFD reader written for the TIFF decoder is therefore reused as-is —
// that is the whole architectural argument for this layer: the IFD walk exists once.

import { IfdReader, readTiffHeader, tagNumber, type Ifd } from '../formats/tiff/ifd'
import type { ExifData, ExifIfd, ExifTagValue } from './types'
import { ExifType } from './types'

/** EXIF tag numbers referenced by name elsewhere in the codebase. */
export const EXIF_TAG = {
  ImageWidth: 0x0100,
  ImageLength: 0x0101,
  Make: 0x010f,
  Model: 0x0110,
  Orientation: 0x0112,
  XResolution: 0x011a,
  YResolution: 0x011b,
  ResolutionUnit: 0x0128,
  Software: 0x0131,
  DateTime: 0x0132,
  Artist: 0x013b,
  Copyright: 0x8298,
  ExifIfdPointer: 0x8769,
  GpsIfdPointer: 0x8825,
  InteropIfdPointer: 0xa005,
  ExposureTime: 0x829a,
  FNumber: 0x829d,
  IsoSpeedRatings: 0x8827,
  DateTimeOriginal: 0x9003,
  Flash: 0x9209,
  FocalLength: 0x920a,
  LensModel: 0xa434,
  ThumbnailOffset: 0x0201,
  ThumbnailLength: 0x0202,
} as const

/** GPS sub-IFD tags. */
export const GPS_TAG = {
  LatitudeRef: 1,
  Latitude: 2,
  LongitudeRef: 3,
  Longitude: 4,
  AltitudeRef: 5,
  Altitude: 6,
} as const

/** The `Exif\0\0` prefix that JPEG APP1 puts before the TIFF header. */
const EXIF_PREFIX = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]

/** Strips the `Exif\0\0` prefix when present, so both JPEG and PNG/TIFF blocks work. */
export function stripExifPrefix(block: Uint8Array): Uint8Array {
  if (block.length >= 6 && EXIF_PREFIX.every((b, i) => block[i] === b)) return block.subarray(6)
  return block
}

function toExifIfd(ifd: Ifd): ExifIfd {
  const tags = new Map<number, ExifTagValue>()
  for (const [tag, e] of ifd.entries) {
    const value: ExifTagValue['value'] =
      e.text !== undefined ? e.text : e.numbers !== undefined ? e.numbers : (e.bytes ?? [])
    tags.set(tag, { tag, type: e.type, count: e.count, value, rationals: e.rationals })
  }
  return { tags }
}

/**
 * Parses a standalone EXIF block (JPEG APP1 payload, PNG `eXIf` chunk, WebP `EXIF`
 * chunk). Returns `null` for anything that is not a readable TIFF structure — EXIF is
 * decorative, so a broken block must never abort an import.
 */
export function parseExif(block: Uint8Array): ExifData | null {
  try {
    const bytes = stripExifPrefix(block)
    const header = readTiffHeader(bytes)
    const reader = new IfdReader(bytes, header)
    const ifd0 = reader.readIfd(header.firstIfdOffset)
    return assemble(reader, ifd0, header.littleEndian, bytes)
  } catch {
    return null
  }
}

/**
 * Parses the EXIF sub-IFD of a TIFF file in place: TIFF stores EXIF tags in a sub-IFD of
 * IFD0 rather than in a self-contained block, so the file's own reader is reused.
 */
export function parseExifFromReader(reader: IfdReader, ifd0: Ifd, exifOffset: number): ExifData | null {
  try {
    const exifIfd = reader.readSubIfd(exifOffset)
    const gpsOffset = tagNumber(ifd0, EXIF_TAG.GpsIfdPointer, 0)
    const gpsIfd = gpsOffset > 0 ? reader.readSubIfd(gpsOffset) : null
    const interopOffset = exifIfd ? tagNumber(exifIfd, EXIF_TAG.InteropIfdPointer, 0) : 0
    const interopIfd = interopOffset > 0 ? reader.readSubIfd(interopOffset) : null
    return {
      ifd0: toExifIfd(ifd0),
      exifIfd: exifIfd ? toExifIfd(exifIfd) : undefined,
      gpsIfd: gpsIfd ? toExifIfd(gpsIfd) : undefined,
      interopIfd: interopIfd ? toExifIfd(interopIfd) : undefined,
      littleEndian: reader.header.littleEndian,
    }
  } catch {
    return null
  }
}

function assemble(
  reader: IfdReader,
  ifd0: Ifd,
  littleEndian: boolean,
  bytes: Uint8Array,
): ExifData {
  const exifOffset = tagNumber(ifd0, EXIF_TAG.ExifIfdPointer, 0)
  const gpsOffset = tagNumber(ifd0, EXIF_TAG.GpsIfdPointer, 0)
  const exifIfd = exifOffset > 0 ? reader.readSubIfd(exifOffset) : null
  const gpsIfd = gpsOffset > 0 ? reader.readSubIfd(gpsOffset) : null
  const interopOffset = exifIfd ? tagNumber(exifIfd, EXIF_TAG.InteropIfdPointer, 0) : 0
  const interopIfd = interopOffset > 0 ? reader.readSubIfd(interopOffset) : null

  let ifd1: Ifd | null = null
  let thumbnail: Uint8Array | undefined
  if (ifd0.nextOffset > 0) {
    ifd1 = reader.readSubIfd(ifd0.nextOffset)
    if (ifd1) {
      const off = tagNumber(ifd1, EXIF_TAG.ThumbnailOffset, 0)
      const len = tagNumber(ifd1, EXIF_TAG.ThumbnailLength, 0)
      if (off > 0 && len > 0 && off + len <= bytes.length) {
        thumbnail = bytes.subarray(off, off + len)
      }
    }
  }

  return {
    ifd0: toExifIfd(ifd0),
    exifIfd: exifIfd ? toExifIfd(exifIfd) : undefined,
    gpsIfd: gpsIfd ? toExifIfd(gpsIfd) : undefined,
    interopIfd: interopIfd ? toExifIfd(interopIfd) : undefined,
    ifd1: ifd1 ? toExifIfd(ifd1) : undefined,
    thumbnail,
    littleEndian,
  }
}

// ---------------------------------------------------------------------------
// Convenience accessors
// ---------------------------------------------------------------------------

export function exifNumber(ifd: ExifIfd | undefined, tag: number): number | undefined {
  const v = ifd?.tags.get(tag)?.value
  if (typeof v === 'number') return v
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'number') return v[0]
  return undefined
}

export function exifString(ifd: ExifIfd | undefined, tag: number): string | undefined {
  const v = ifd?.tags.get(tag)?.value
  return typeof v === 'string' ? v : undefined
}

/**
 * EXIF orientation, 1..8. Returns 1 when absent or out of range — an invalid value must
 * never rotate a picture in an unpredictable way.
 */
export function exifOrientation(data: ExifData | undefined): number {
  const v = exifNumber(data?.ifd0, EXIF_TAG.Orientation)
  return v !== undefined && v >= 1 && v <= 8 ? v : 1
}

/** GPS position in decimal degrees, or `null`. Never logged, and dropped on export. */
export function exifGpsDecimal(data: ExifData | undefined): { lat: number; lon: number } | null {
  const gps = data?.gpsIfd
  if (!gps) return null
  const lat = dms(gps, GPS_TAG.Latitude)
  const lon = dms(gps, GPS_TAG.Longitude)
  if (lat === null || lon === null) return null
  const latRef = exifString(gps, GPS_TAG.LatitudeRef) ?? 'N'
  const lonRef = exifString(gps, GPS_TAG.LongitudeRef) ?? 'E'
  return {
    lat: latRef.toUpperCase().startsWith('S') ? -lat : lat,
    lon: lonRef.toUpperCase().startsWith('W') ? -lon : lon,
  }
}

function dms(ifd: ExifIfd, tag: number): number | null {
  const v = ifd.tags.get(tag)?.value
  if (!Array.isArray(v) || v.length < 3) return null
  const [d, m, s] = v as number[]
  if (![d, m, s].every((x) => typeof x === 'number' && Number.isFinite(x))) return null
  return d + m / 60 + s / 3600
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

export interface SerializeExifOptions {
  /** Drops IFD1 and its JPEG thumbnail (~10 KiB, always stale after an edit). */
  readonly stripThumbnail?: boolean
  /** Privacy default: GPS is removed unless explicitly kept (spec 05 §6.7). */
  readonly keepGps?: boolean
  /** Tags to overwrite in IFD0 — `Orientation: 1` after baking the rotation in. */
  readonly overrideIfd0?: ReadonlyMap<number, number>
  /** Prepends `Exif\0\0`, as JPEG APP1 requires. TIFF/PNG want it off. */
  readonly withPrefix?: boolean
}

interface PendingEntry {
  tag: number
  type: number
  count: number
  /** Inline 4-byte value, or a payload to place in the value area. */
  inline?: number
  payload?: Uint8Array
}

/**
 * Serialises back to a TIFF-structured block (little-endian, classic TIFF).
 *
 * Only the tags we can represent are written; everything is re-encoded rather than
 * patched, which is why `ImageMetadata.opaque` exists for the blocks that must survive
 * verbatim. GPS and the thumbnail are dropped by default.
 */
export function serializeExif(data: ExifData, opts: SerializeExifOptions = {}): Uint8Array {
  const ifd0 = collectEntries(data.ifd0, opts.overrideIfd0, [
    EXIF_TAG.ExifIfdPointer,
    EXIF_TAG.GpsIfdPointer,
    EXIF_TAG.ThumbnailOffset,
    EXIF_TAG.ThumbnailLength,
  ])
  const exif = data.exifIfd ? collectEntries(data.exifIfd, undefined, [EXIF_TAG.InteropIfdPointer]) : null
  const gps = opts.keepGps && data.gpsIfd ? collectEntries(data.gpsIfd, undefined, []) : null

  // Layout: header, IFD0, [EXIF IFD], [GPS IFD], then every long value.
  const HEADER = 8
  const ifd0Size = ifdSize(ifd0.length + (exif ? 1 : 0) + (gps ? 1 : 0))
  const exifSize = exif ? ifdSize(exif.length) : 0
  const gpsSize = gps ? ifdSize(gps.length) : 0

  const ifd0Offset = HEADER
  const exifOffset = ifd0Offset + ifd0Size
  const gpsOffset = exifOffset + exifSize
  let valueOffset = gpsOffset + gpsSize

  const longValues: { offset: number; bytes: Uint8Array }[] = []
  const place = (entries: PendingEntry[]): void => {
    for (const e of entries) {
      if (e.payload && e.payload.length > 4) {
        if (valueOffset % 2 === 1) valueOffset++
        longValues.push({ offset: valueOffset, bytes: e.payload })
        e.inline = valueOffset
        valueOffset += e.payload.length
      }
    }
  }
  place(ifd0)
  if (exif) place(exif)
  if (gps) place(gps)

  const total = valueOffset
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  // Header: little-endian, classic TIFF, IFD0 right after the header.
  out[0] = 0x49
  out[1] = 0x49
  view.setUint16(2, 42, true)
  view.setUint32(4, ifd0Offset, true)

  const pointers: PendingEntry[] = []
  if (exif) pointers.push({ tag: EXIF_TAG.ExifIfdPointer, type: ExifType.Long, count: 1, inline: exifOffset })
  if (gps) pointers.push({ tag: EXIF_TAG.GpsIfdPointer, type: ExifType.Long, count: 1, inline: gpsOffset })

  writeIfd(view, out, ifd0Offset, [...ifd0, ...pointers].sort((a, b) => a.tag - b.tag), 0)
  if (exif) writeIfd(view, out, exifOffset, exif, 0)
  if (gps) writeIfd(view, out, gpsOffset, gps, 0)
  for (const v of longValues) out.set(v.bytes, v.offset)

  if (!opts.withPrefix) return out
  const prefixed = new Uint8Array(6 + out.length)
  prefixed.set(EXIF_PREFIX, 0)
  prefixed.set(out, 6)
  return prefixed
}

function ifdSize(entryCount: number): number {
  return 2 + entryCount * 12 + 4
}

function collectEntries(
  ifd: ExifIfd,
  overrides: ReadonlyMap<number, number> | undefined,
  skip: readonly number[],
): PendingEntry[] {
  const skipSet = new Set(skip)
  const out: PendingEntry[] = []
  for (const [tag, v] of ifd.tags) {
    if (skipSet.has(tag)) continue
    const override = overrides?.get(tag)
    if (override !== undefined) {
      out.push({ tag, type: ExifType.Short, count: 1, inline: override })
      continue
    }
    const entry = encodeEntry(v)
    if (entry) out.push(entry)
  }
  if (overrides) {
    for (const [tag, value] of overrides) {
      if (!ifd.tags.has(tag) && !skipSet.has(tag)) {
        out.push({ tag, type: ExifType.Short, count: 1, inline: value })
      }
    }
  }
  return out.sort((a, b) => a.tag - b.tag)
}

function encodeEntry(v: ExifTagValue): PendingEntry | null {
  const { tag, type } = v
  if (typeof v.value === 'string') {
    const bytes = new Uint8Array(v.value.length + 1)
    for (let i = 0; i < v.value.length; i++) bytes[i] = v.value.charCodeAt(i) & 0xff
    return payloadEntry(tag, ExifType.Ascii, bytes.length, bytes)
  }
  if (v.value instanceof Uint8Array) {
    return payloadEntry(tag, type === ExifType.Ascii ? ExifType.Undefined : type, v.value.length, v.value)
  }
  const numbers = v.value as readonly number[]
  if (v.rationals && (type === ExifType.Rational || type === ExifType.SRational)) {
    const bytes = new Uint8Array(v.rationals.length * 8)
    const dv = new DataView(bytes.buffer)
    v.rationals.forEach(([n, d], i) => {
      if (type === ExifType.Rational) {
        dv.setUint32(i * 8, n >>> 0, true)
        dv.setUint32(i * 8 + 4, d >>> 0, true)
      } else {
        dv.setInt32(i * 8, n | 0, true)
        dv.setInt32(i * 8 + 4, d | 0, true)
      }
    })
    return payloadEntry(tag, type, v.rationals.length, bytes)
  }
  if (numbers.length === 0) return null
  // Everything numeric is normalised to SHORT or LONG: those two cover the tags we
  // actually rewrite, and a wrong width would corrupt the value.
  const fitsShort = numbers.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff)
  if (fitsShort && numbers.length <= 2) {
    const bytes = new Uint8Array(4)
    const dv = new DataView(bytes.buffer)
    numbers.forEach((n, i) => dv.setUint16(i * 2, n, true))
    return { tag, type: ExifType.Short, count: numbers.length, inline: readInline(bytes) }
  }
  if (fitsShort) {
    const bytes = new Uint8Array(numbers.length * 2)
    const dv = new DataView(bytes.buffer)
    numbers.forEach((n, i) => dv.setUint16(i * 2, n, true))
    return payloadEntry(tag, ExifType.Short, numbers.length, bytes)
  }
  const fitsLong = numbers.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffffffff)
  if (!fitsLong) return null
  if (numbers.length === 1) {
    return { tag, type: ExifType.Long, count: 1, inline: numbers[0] >>> 0 }
  }
  const bytes = new Uint8Array(numbers.length * 4)
  const dv = new DataView(bytes.buffer)
  numbers.forEach((n, i) => dv.setUint32(i * 4, n >>> 0, true))
  return payloadEntry(tag, ExifType.Long, numbers.length, bytes)
}

function payloadEntry(tag: number, type: number, count: number, bytes: Uint8Array): PendingEntry {
  if (bytes.length <= 4) {
    const padded = new Uint8Array(4)
    padded.set(bytes)
    return { tag, type, count, inline: readInline(padded) }
  }
  return { tag, type, count, payload: bytes }
}

function readInline(fourBytes: Uint8Array): number {
  return new DataView(fourBytes.buffer, fourBytes.byteOffset, 4).getUint32(0, true)
}

function writeIfd(
  view: DataView,
  out: Uint8Array,
  offset: number,
  entries: readonly PendingEntry[],
  nextIfd: number,
): void {
  view.setUint16(offset, entries.length, true)
  let p = offset + 2
  // The specification requires entries sorted by ascending tag; many readers enforce it.
  for (const e of [...entries].sort((a, b) => a.tag - b.tag)) {
    view.setUint16(p, e.tag, true)
    view.setUint16(p + 2, e.type, true)
    view.setUint32(p + 4, e.count, true)
    view.setUint32(p + 8, e.inline ?? 0, true)
    p += 12
  }
  view.setUint32(p, nextIfd, true)
  void out
}
