// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Last-resort preview location: scan the bytes for JPEG streams (spec 07 §5.3, pass 3).
//
// Crude, and remarkably effective. It is what saves a camera body nobody has ever
// tested against: the manufacturer changed where the preview lives, but it is still a
// JPEG, and a JPEG still starts with FF D8 FF and ends with FF D9.
//
// Cost control: the scan stops after `MAX_SCAN_BYTES` (a 60 MB CR3 keeps its preview
// well inside the first 40 MiB) and after `MAX_CANDIDATES` hits.

const MAX_SCAN_BYTES = 40 * 1024 * 1024
const MAX_CANDIDATES = 64
/** Below this a "JPEG" is a thumbnail fragment or a false positive. */
const MIN_JPEG_BYTES = 1024

export interface JpegCandidate {
  readonly offset: number
  readonly length: number
  readonly width: number
  readonly height: number
}

/**
 * Reads the frame header of a JPEG to get its real dimensions.
 *
 * Walks the marker chain rather than guessing an offset, and accepts every SOF flavour
 * (baseline, progressive, and the lossless SOF3 that CR2 uses for its sensor data — which
 * is precisely why the caller must not treat every hit as displayable).
 */
export function readJpegSize(
  bytes: Uint8Array,
  start: number,
  end: number,
): { width: number; height: number; sof: number } | null {
  let p = start + 2 // past SOI
  const limit = Math.min(end, bytes.length)
  // A JPEG has a few dozen segments before the frame header; 512 is far past any real file.
  for (let guard = 0; guard < 512 && p + 4 <= limit; guard++) {
    if (bytes[p] !== 0xff) {
      p += 1
      continue
    }
    const marker = bytes[p + 1]
    if (marker === 0xff) {
      p += 1
      continue
    }
    // Standalone markers carry no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      p += 2
      continue
    }
    const len = (bytes[p + 2] << 8) | bytes[p + 3]
    if (len < 2) return null
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      if (p + 9 > limit) return null
      const height = (bytes[p + 5] << 8) | bytes[p + 6]
      const width = (bytes[p + 7] << 8) | bytes[p + 8]
      if (width <= 0 || height <= 0) return null
      return { width, height, sof: marker }
    }
    if (marker === 0xda) return null // start of scan: no frame header was found
    p += 2 + len
  }
  return null
}

/** True for the SOF markers a browser can actually decode (baseline/extended/progressive). */
export function isDisplayableSof(sof: number): boolean {
  return sof === 0xc0 || sof === 0xc1 || sof === 0xc2
}

/**
 * Scans for `FF D8 FF … FF D9` sequences and returns those whose frame header announces
 * plausible dimensions.
 *
 * Nested streams matter: an embedded preview usually carries its own EXIF thumbnail, so
 * the scan continues from just past each SOI rather than past each EOI, and the caller
 * picks the largest.
 */
export function scanJpegStreams(bytes: Uint8Array): JpegCandidate[] {
  const out: JpegCandidate[] = []
  const limit = Math.min(bytes.length, MAX_SCAN_BYTES)
  for (let i = 0; i + 3 < limit && out.length < MAX_CANDIDATES; i++) {
    if (bytes[i] !== 0xff || bytes[i + 1] !== 0xd8 || bytes[i + 2] !== 0xff) continue
    const size = readJpegSize(bytes, i, limit)
    if (!size || !isDisplayableSof(size.sof) || size.width < 32 || size.height < 32) continue
    const end = findEoi(bytes, i + 2, limit)
    const length = (end < 0 ? limit : end) - i
    if (length < MIN_JPEG_BYTES) continue
    out.push({ offset: i, length, width: size.width, height: size.height })
    // Skip past this stream's header; a preview's own thumbnail is found on the next pass.
    i += 2
  }
  return out
}

function findEoi(bytes: Uint8Array, from: number, limit: number): number {
  for (let i = from; i + 1 < limit; i++) {
    if (bytes[i] === 0xff && bytes[i + 1] === 0xd9) return i + 2
  }
  return -1
}

/** Finds the first `FF D8 FF` inside a box payload, whose preamble length varies. */
export function findSoi(bytes: Uint8Array, start: number, end: number): number {
  const limit = Math.min(end, bytes.length)
  for (let i = Math.max(0, start); i + 2 < limit; i++) {
    if (bytes[i] === 0xff && bytes[i + 1] === 0xd8 && bytes[i + 2] === 0xff) return i
  }
  return -1
}
