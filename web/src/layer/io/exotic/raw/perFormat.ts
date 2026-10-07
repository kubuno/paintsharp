// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Format-specific preview locations (spec 07 §5.4) — pass 1 of three.
//
// Everything here is an OPTIMISATION over the generic IFD sweep and the byte scan: when
// a path fails, or when a manufacturer moves the preview in a new body, the later passes
// still find it. Nothing in this file is allowed to throw.

import { findSoi, readJpegSize } from './jpegScan'
import { findBoxes, iterBoxes } from './bmff'
import { JPEG_COMPRESSIONS, TAG, num, numOrUndef, type IfdSweep } from './tiff'
import { tagNumbers } from '../../formats/tiff/ifd'

export type RawFormatId =
  | 'raw-cr2'
  | 'raw-cr3'
  | 'raw-nef'
  | 'raw-arw'
  | 'raw-dng'
  | 'raw-orf'
  | 'raw-raf'
  | 'raw-rw2'
  | 'raw-tiff-generic'

/** Families that are deliberately refused: no Bayer data we could ever use, and byte
 *  scanning them yields false positives more often than previews. */
export type UnsupportedRawId = 'raw-crw' | 'raw-x3f' | 'raw-mrw'

export interface PreviewCandidate {
  readonly offset: number
  readonly length: number
  /** Where it came from, for `ImportedDocument.provenance`. */
  readonly source: string
  readonly width?: number
  readonly height?: number
}

/** Ceiling on one preview blob: no camera writes a 128 MiB JPEG. */
const MAX_PREVIEW_BYTES = 128 * 1024 * 1024

function pushIfSane(
  out: PreviewCandidate[],
  bytes: Uint8Array,
  offset: number,
  length: number,
  source: string,
): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length)) return
  if (offset <= 0 || length < 1024 || length > MAX_PREVIEW_BYTES) return
  if (offset + length > bytes.length) return
  if (bytes[offset] !== 0xff || bytes[offset + 1] !== 0xd8) return
  const size = readJpegSize(bytes, offset, offset + length)
  out.push({ offset, length, source, width: size?.width, height: size?.height })
}

// ---------------------------------------------------------------------------
// TIFF-family paths
// ---------------------------------------------------------------------------

/**
 * Canon CR2: the simplest case of the lot. IFD0's strip IS the full-resolution JPEG
 * (IFD1 is a 160×120 thumbnail, IFD2 an uncompressed quarter-size RGB, IFD3 the CFA).
 */
function cr2(bytes: Uint8Array, sweep: IfdSweep, out: PreviewCandidate[]): void {
  const ifd0 = sweep.ifd0
  if (!ifd0) return
  const offset = numOrUndef(ifd0, TAG.StripOffsets)
  const length = numOrUndef(ifd0, TAG.StripByteCounts)
  if (offset !== undefined && length !== undefined) {
    pushIfSane(out, bytes, offset, length, 'CR2 IFD0/StripOffsets')
  }
}

/**
 * Panasonic RW2: IFD0 tag 0x002E `JpgFromRaw` is a complete, usually full-resolution
 * JPEG. Also used by some Leica bodies writing RWL.
 */
function rw2(bytes: Uint8Array, sweep: IfdSweep, out: PreviewCandidate[]): void {
  const ifd0 = sweep.ifd0
  if (!ifd0) return
  const entry = ifd0.entries.get(TAG.PanasonicJpgFromRaw)
  if (!entry) return
  pushIfSane(out, bytes, entry.valueOffset, entry.count, 'RW2 IFD0/JpgFromRaw')
}

/**
 * Olympus ORF: the preview hides in the MakerNote, under the 0x2020 "camera settings"
 * sub-IFD, as PreviewImageStart (0x0100) / PreviewImageLength (0x0101).
 *
 * ⚠️ The classic trap is that those offsets are RELATIVE TO THE START OF THE MAKERNOTE,
 * not to the file. Both interpretations are tried, and each is validated against an
 * actual SOI marker before being accepted — which is the only defence available without
 * a real ORF to test on (see the report: this path is UNVERIFIED).
 */
function orf(bytes: Uint8Array, sweep: IfdSweep, out: PreviewCandidate[]): void {
  const base = sweep.makerNoteAt
  if (base === undefined) return
  for (const ifd of sweep.ifds) {
    const start = numOrUndef(ifd, 0x0100)
    const length = numOrUndef(ifd, 0x0101)
    if (start === undefined || length === undefined) continue
    pushIfSane(out, bytes, base + start, length, 'ORF MakerNote/PreviewImage (relative)')
    pushIfSane(out, bytes, start, length, 'ORF MakerNote/PreviewImage (absolute)')
  }
}

/**
 * Fujifilm RAF — the one reserve this specification flagged (§5.4).
 *
 * Header layout per the dcraw convention: 16 bytes `FUJIFILMCCD-RAW`, 4 bytes format
 * version, 8 bytes camera id, 32 bytes camera string, then at offset 84 a big-endian
 * u32 JPEG offset and at offset 88 a big-endian u32 JPEG length.
 *
 * ⚠️ UNVERIFIED: no RAF file was available on this machine to confirm the 84/88 offsets
 * (see the delivery report). The code therefore never trusts them: the values are only
 * accepted when the bytes they point at really begin with a JPEG SOI, and the generic
 * byte scan remains the fallback. A wrong constant costs nothing but a slower path.
 */
function raf(bytes: Uint8Array, out: PreviewCandidate[]): void {
  if (bytes.length < 96) return
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const offset = dv.getUint32(84, false)
  const length = dv.getUint32(88, false)
  pushIfSane(out, bytes, offset, length, 'RAF header@84/88 (unverified)')
}

/**
 * Canon CR3 — ISO-BMFF. The preview sits in a `PRVW` box inside Canon's private `uuid`
 * box (85c0b687-820f-11e0-8111-f4ce462b6a48), with `THMB` holding the thumbnail. Both
 * carry a small, undocumented preamble before the SOI, so the SOI is searched for
 * instead of assumed at a fixed offset.
 */
function cr3(bytes: Uint8Array, out: PreviewCandidate[]): void {
  const wanted = new Set(['PRVW', 'THMB'])
  const boxes = findBoxes(bytes, 0, bytes.length, wanted)
  for (const box of boxes) {
    const soi = findSoi(bytes, box.start, Math.min(box.end, box.start + 4096))
    if (soi < 0) continue
    pushIfSane(out, bytes, soi, box.end - soi, `CR3 ${box.type}`)
  }
  if (boxes.length === 0) {
    // Some bodies nest the preview one level deeper than `findBoxes` walks; a shallow
    // top-level sweep catches `mdat`, whose payload the byte scan then handles.
    for (const box of iterBoxes(bytes, 0, bytes.length)) {
      if (box.type !== 'mdat') continue
      const soi = findSoi(bytes, box.start, box.end)
      if (soi >= 0) pushIfSane(out, bytes, soi, box.end - soi, 'CR3 mdat')
      break
    }
  }
}

/**
 * Pass 1. Returns the candidates a format-specific rule could name; an empty result is
 * normal and simply defers to passes 2 and 3.
 */
export function perFormatCandidates(
  bytes: Uint8Array,
  format: RawFormatId,
  sweep: IfdSweep | null,
): PreviewCandidate[] {
  const out: PreviewCandidate[] = []
  try {
    switch (format) {
      case 'raw-cr2':
        if (sweep) cr2(bytes, sweep, out)
        break
      case 'raw-cr3':
        cr3(bytes, out)
        break
      case 'raw-rw2':
        if (sweep) rw2(bytes, sweep, out)
        break
      case 'raw-orf':
        if (sweep) orf(bytes, sweep, out)
        break
      case 'raw-raf':
        raf(bytes, out)
        break
      default:
        // NEF, ARW, DNG and the generic TIFF family are entirely covered by the IFD
        // sweep of pass 2: they store the preview in standard tags.
        break
    }
  } catch {
    // A format-specific shortcut is never allowed to fail the import.
  }
  return out
}

/**
 * Pass 2 — generic IFD sweep. Every IFD is inspected for the two standard ways of
 * carrying a JPEG, in the order the specification lists them.
 */
export function ifdCandidates(bytes: Uint8Array, sweep: IfdSweep): PreviewCandidate[] {
  const out: PreviewCandidate[] = []
  for (const ifd of sweep.ifds) {
    const jpegAt = numOrUndef(ifd, TAG.JPEGInterchangeFormat)
    const jpegLen = numOrUndef(ifd, TAG.JPEGInterchangeFormatLength)
    if (jpegAt !== undefined && jpegLen !== undefined) {
      pushIfSane(out, bytes, jpegAt, jpegLen, 'IFD/JPEGInterchangeFormat')
    }

    const compression = num(ifd, TAG.Compression, 0)
    if (JPEG_COMPRESSIONS.has(compression)) {
      const offsets = tagNumbers(ifd, TAG.StripOffsets) ?? []
      const counts = tagNumbers(ifd, TAG.StripByteCounts) ?? []
      // A multi-strip JPEG is not a single stream; only the single-strip case is a
      // usable preview, and that is what every manufacturer writes.
      if (offsets.length === 1 && counts.length === 1) {
        pushIfSane(out, bytes, offsets[0], counts[0], 'IFD/StripOffsets (JPEG)')
      }
    }

    // MakerNote preview tags that several manufacturers share at IFD level.
    for (const [startTag, lenTag, label] of [
      [0x0100, 0x0101, 'MakerNote/PreviewImage'],
      [0x2001, 0x2002, 'MakerNote/PreviewImage (Sony)'],
    ] as const) {
      const s = numOrUndef(ifd, startTag)
      const l = numOrUndef(ifd, lenTag)
      if (s !== undefined && l !== undefined) pushIfSane(out, bytes, s, l, label)
    }
  }
  return out
}
