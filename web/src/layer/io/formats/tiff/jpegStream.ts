// JPEG stream surgery, used by TIFF compression 7 and by the JPEG metadata writer.
//
// The key trick of spec 05 §4.4: a TIFF strip holds an *abbreviated* JPEG stream (no
// quantisation/Huffman tables — those live in the `JPEGTables` tag). Splicing the two
// back together yields a self-contained JPEG that the browser decodes natively, so this
// layer never needs a DCT implementation.

const SOI = 0xd8
const EOI = 0xd9

/**
 * Rebuilds a self-contained JPEG from TIFF's abbreviated strip data.
 *
 * `JPEGTables` holds SOI + tables + EOI; each strip holds SOI + frame + scan + EOI.
 * The result is SOI + tables(without SOI/EOI) + strip(without SOI).
 */
export function rebuildJpegStream(tables: Uint8Array | undefined, strip: Uint8Array): Uint8Array {
  const stripBody = startsWithSoi(strip) ? strip.subarray(2) : strip
  if (!tables || tables.length < 4) {
    const out = new Uint8Array(2 + stripBody.length)
    out[0] = 0xff
    out[1] = SOI
    out.set(stripBody, 2)
    return out
  }
  let tableStart = startsWithSoi(tables) ? 2 : 0
  let tableEnd = tables.length
  if (tableEnd >= 2 && tables[tableEnd - 2] === 0xff && tables[tableEnd - 1] === EOI) tableEnd -= 2
  if (tableEnd < tableStart) tableStart = tableEnd
  const tableBody = tables.subarray(tableStart, tableEnd)

  const out = new Uint8Array(2 + tableBody.length + stripBody.length)
  out[0] = 0xff
  out[1] = SOI
  out.set(tableBody, 2)
  out.set(stripBody, 2 + tableBody.length)
  return out
}

function startsWithSoi(b: Uint8Array): boolean {
  return b.length >= 2 && b[0] === 0xff && b[1] === SOI
}

export interface JpegSegment {
  /** Marker byte after 0xFF (0xE1 for APP1, 0xDA for SOS…). */
  readonly marker: number
  /** Offset of the 0xFF byte. */
  readonly offset: number
  /** Payload, excluding the 2-byte length field. Empty for standalone markers. */
  readonly payload: Uint8Array
  /** Total length of the marker + length field + payload. */
  readonly totalLength: number
}

/**
 * Walks the marker segments of a JPEG file without decoding anything. Stops at SOS,
 * because everything after it is entropy-coded data where 0xFF bytes are stuffed.
 */
export function readJpegSegments(bytes: Uint8Array, limit = 64): JpegSegment[] {
  const out: JpegSegment[] = []
  if (!startsWithSoi(bytes)) return out
  let p = 2
  while (p + 4 <= bytes.length && out.length < limit) {
    if (bytes[p] !== 0xff) {
      // Fill bytes are legal between segments; skip them, bounded.
      p++
      continue
    }
    let marker = bytes[p + 1]
    let q = p + 1
    while (marker === 0xff && q + 1 < bytes.length) {
      q++
      marker = bytes[q]
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      p = q + 1
      continue
    }
    if (marker === EOI) break
    const lenOffset = q + 1
    if (lenOffset + 2 > bytes.length) break
    const length = (bytes[lenOffset] << 8) | bytes[lenOffset + 1]
    if (length < 2 || lenOffset + length > bytes.length) break
    out.push({
      marker,
      offset: p,
      payload: bytes.subarray(lenOffset + 2, lenOffset + length),
      totalLength: lenOffset + length - p,
    })
    if (marker === 0xda) break // start of scan
    p = lenOffset + length
  }
  return out
}

/**
 * Inserts marker segments right after SOI. Purely structural: the entropy-coded data is
 * untouched, so re-embedding EXIF/ICC/XMP into a browser-encoded JPEG is lossless
 * (spec 05 §3.3).
 */
export function insertJpegSegments(
  jpeg: Uint8Array,
  segments: readonly { marker: number; payload: Uint8Array }[],
): Uint8Array {
  if (!startsWithSoi(jpeg)) return jpeg
  let extra = 0
  for (const s of segments) extra += 4 + s.payload.length
  const out = new Uint8Array(jpeg.length + extra)
  out[0] = 0xff
  out[1] = SOI
  let p = 2
  for (const s of segments) {
    const len = s.payload.length + 2
    if (len > 0xffff) continue // caller must have split it already
    out[p++] = 0xff
    out[p++] = s.marker
    out[p++] = (len >> 8) & 0xff
    out[p++] = len & 0xff
    out.set(s.payload, p)
    p += s.payload.length
  }
  out.set(jpeg.subarray(2), p)
  return out.subarray(0, p + jpeg.length - 2)
}
