// SPDX-License-Identifier: AGPL-3.0-or-later
//
// TIFF/IFD traversal for RAW containers.
//
// The IFD reader itself is NOT duplicated: `layer/io/formats/tiff/ifd.ts` already
// implements a bounds-checked, cycle-checked one, and reusing it is the whole point of
// having it. What this file adds is the RAW-specific part:
//   * accepting the non-standard magics ORF (0x4F52/0x5352) and RW2 (0x55), which the
//     conforming header reader rightly rejects;
//   * collecting IFD0's chain, every SubIFD and the Exif IFD in one sweep, because a
//     preview can live in any of them.

import { IfdReader, tagNumbers, type Ifd, type TiffHeader } from '../../formats/tiff/ifd'
import { ioWarn, type IoWarning } from '../../formats/types'

/** Tags this module reads. Names follow TIFF 6 / EXIF / DNG 1.7. */
export const TAG = {
  NewSubfileType: 0x00fe,
  ImageWidth: 0x0100,
  ImageLength: 0x0101,
  Compression: 0x0103,
  PhotometricInterpretation: 0x0106,
  Make: 0x010f,
  Model: 0x0110,
  StripOffsets: 0x0111,
  Orientation: 0x0112,
  StripByteCounts: 0x0117,
  JPEGInterchangeFormat: 0x0201,
  JPEGInterchangeFormatLength: 0x0202,
  /** Panasonic RW2: a complete JPEG, usually full resolution. */
  PanasonicJpgFromRaw: 0x002e,
  SubIFDs: 0x014a,
  ExifIFD: 0x8769,
  MakerNote: 0x927c,
  DNGVersion: 0xc612,
} as const

/** `PhotometricInterpretation` value marking a colour-filter-array (sensor) image. */
export const PHOTOMETRIC_CFA = 32803
/** DNG "linear raw": already demosaicked. */
export const PHOTOMETRIC_LINEAR_RAW = 34892

/** Compression values that mean "the strip holds a JPEG stream". */
export const JPEG_COMPRESSIONS: ReadonlySet<number> = new Set([6, 7, 34892])

export interface RawTiffHeader extends TiffHeader {
  /** 42 for TIFF, 0x4F52/0x5352 for ORF, 0x55 for RW2, 43 for BigTIFF. */
  readonly magic: number
}

/**
 * Parses a TIFF-like header, tolerating the manufacturer magics.
 *
 * Returns null rather than throwing: a caller that guessed wrong about the container
 * should fall through to the byte scan, not fail the import.
 */
export function readRawTiffHeader(bytes: Uint8Array): RawTiffHeader | null {
  if (bytes.length < 8) return null
  const le = bytes[0] === 0x49 && bytes[1] === 0x49
  const be = bytes[0] === 0x4d && bytes[1] === 0x4d
  if (!le && !be) return null
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const magic = dv.getUint16(2, le)
  // 42 TIFF · 43 BigTIFF · 0x4F52 "RO"/0x5352 "RS" Olympus · 0x55 Panasonic.
  if (magic !== 42 && magic !== 43 && magic !== 0x4f52 && magic !== 0x5352 && magic !== 0x55) {
    return null
  }
  if (magic === 43) {
    if (bytes.length < 16) return null
    const offsetSize = dv.getUint16(4, le)
    if (offsetSize !== 8) return null
    const first = dv.getBigUint64(8, le)
    if (first > BigInt(Number.MAX_SAFE_INTEGER)) return null
    return { littleEndian: le, bigTiff: true, firstIfdOffset: Number(first), offsetSize: 8, magic }
  }
  return {
    littleEndian: le,
    bigTiff: false,
    firstIfdOffset: dv.getUint32(4, le),
    offsetSize: 4,
    magic,
  }
}

export interface IfdSweep {
  readonly reader: IfdReader
  /** IFD0 first, then its chain, then every SubIFD, then the Exif IFD. */
  readonly ifds: readonly Ifd[]
  readonly ifd0: Ifd | undefined
  /** Absolute file offset of the MakerNote payload, when present. */
  readonly makerNoteAt: number | undefined
  readonly makerNoteLength: number
}

/** IFDs a single sweep may visit — the classic TIFF denial-of-service bound. */
const MAX_SWEPT_IFDS = 64

/**
 * Collects every IFD a preview could hide in, without ever revisiting an offset.
 *
 * Order matters for diagnostics only: the caller scores candidates by pixel area, not by
 * the IFD they came from, because "which IFD holds the full-size preview" varies by
 * manufacturer and by body.
 */
export function sweepIfds(
  bytes: Uint8Array,
  header: RawTiffHeader,
  warn: (w: IoWarning) => void = () => undefined,
): IfdSweep {
  const reader = new IfdReader(bytes, header, warn)
  const ifds: Ifd[] = []
  const seen = new Set<number>()
  let makerNoteAt: number | undefined
  let makerNoteLength = 0

  const visit = (offset: number): Ifd | undefined => {
    if (offset <= 0 || offset >= bytes.length || seen.has(offset) || ifds.length >= MAX_SWEPT_IFDS) {
      return undefined
    }
    seen.add(offset)
    try {
      const ifd = reader.readIfd(offset)
      ifds.push(ifd)
      return ifd
    } catch {
      warn(ioWarn('raw.unreadable-ifd', { offset }))
      return undefined
    }
  }

  const ifd0 = visit(header.firstIfdOffset)

  // IFD0's chain (IFD1 is usually the thumbnail, but some bodies put more there).
  let next = ifd0?.nextOffset ?? 0
  for (let i = 0; i < MAX_SWEPT_IFDS && next > 0; i++) {
    const ifd = visit(next)
    if (!ifd) break
    next = ifd.nextOffset
  }

  // SubIFDs of every IFD found so far: on NEF and DNG this is where the full-resolution
  // preview lives, alongside the CFA.
  for (let i = 0; i < ifds.length; i++) {
    const ifd = ifds[i]
    for (const off of tagNumbers(ifd, TAG.SubIFDs) ?? []) visit(off)
    for (const off of tagNumbers(ifd, TAG.ExifIFD) ?? []) visit(off)
    const mn = ifd.entries.get(TAG.MakerNote)
    if (mn && makerNoteAt === undefined) {
      makerNoteAt = mn.valueOffset
      makerNoteLength = mn.bytes?.length ?? mn.count
    }
  }

  return { reader, ifds, ifd0, makerNoteAt, makerNoteLength }
}

/** First value of a tag, or `fallback`. */
export function num(ifd: Ifd, tag: number, fallback: number): number {
  const v = tagNumbers(ifd, tag)
  return v && v.length > 0 ? v[0] : fallback
}

export function numOrUndef(ifd: Ifd, tag: number): number | undefined {
  const v = tagNumbers(ifd, tag)
  return v && v.length > 0 ? v[0] : undefined
}

/** EXIF orientation, clamped to the legal 1..8 range. */
export function readOrientation(sweep: IfdSweep): number {
  const raw = sweep.ifd0 ? num(sweep.ifd0, TAG.Orientation, 1) : 1
  return raw >= 1 && raw <= 8 ? raw : 1
}

/** Sensor dimensions, taken from the largest CFA sub-IFD, for the "preview is small" test. */
export function sensorSize(sweep: IfdSweep): { width: number; height: number } | undefined {
  let best: { width: number; height: number } | undefined
  for (const ifd of sweep.ifds) {
    const photometric = numOrUndef(ifd, TAG.PhotometricInterpretation)
    if (photometric !== PHOTOMETRIC_CFA && photometric !== PHOTOMETRIC_LINEAR_RAW) continue
    const width = numOrUndef(ifd, TAG.ImageWidth)
    const height = numOrUndef(ifd, TAG.ImageLength)
    if (!width || !height) continue
    if (!best || width * height > best.width * best.height) best = { width, height }
  }
  return best
}
