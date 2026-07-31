// SPDX-License-Identifier: AGPL-3.0-or-later
//
// TIFF writer (spec 05 §4.9). The browser cannot write TIFF at all — asking
// `convertToBlob` for `image/tiff` silently returns a PNG (measured, §2.1) — so this is
// the only path.
//
// Write order is DATA FIRST, IFD AFTERWARDS: the compressed size of a strip is unknown
// until it is compressed, and this ordering removes every backward patch except the two
// offset fields that chain the pages.
//
// The compression constraints (which combinations are legal) follow GIMP's
// plug-ins/file-tiff/file-tiff-export.c. GIMP is Copyright (C) 1995-2025 Spencer Kimball,
// Peter Mattis and the GIMP developers, GPL-3.0-or-later; Kubuno is AGPL-3.0-or-later,
// which is compatible. Reimplemented in TypeScript; no code was copied.

import type { ImageMetadata } from '../../metadata/types'
import { deflate } from '../codecs/deflate'
import { lzwEncode } from '../codecs/lzw'
import { packBits } from '../codecs/packbits'
import { applyHorizontalPredictor } from '../codecs/predictor'
import { checkDimensions } from '../limits'
import { IoInvalidError, IoUnsupportedError, type RasterImage } from '../types'
import { COMPRESSION, EXTRA_SAMPLE, PHOTOMETRIC, PLANAR, PREDICTOR, SAMPLE_FORMAT, TIFF_TAG } from './tags'

export type TiffCompression = 'none' | 'deflate' | 'lzw' | 'packbits'

export interface TiffEncodeOptions {
  /** Deflate by default: better ratio than LZW and free via `CompressionStream`. */
  readonly compression?: TiffCompression
  /** Horizontal differencing; ignored for `none` and for float samples. */
  readonly predictor?: boolean
  /** Target uncompressed bytes per strip. ~64 KiB balances memory against overhead. */
  readonly targetStripBytes?: number
  readonly metadata?: ImageMetadata
  /** Written verbatim into tag 34675. */
  readonly iccProfile?: Uint8Array
  /** Written verbatim into tag 700. */
  readonly xmp?: Uint8Array
  /** Written verbatim into tag 33723. */
  readonly iptc?: Uint8Array
  readonly software?: string
}

/** 3.9 GiB: past this a classic TIFF cannot address its own data. */
const CLASSIC_TIFF_LIMIT = 3.9 * 1024 * 1024 * 1024

interface Entry {
  tag: number
  type: number
  count: number
  /** Value when it fits in the 4-byte field. */
  inline?: number
  /** Payload otherwise; placed after the strips and referenced by offset. */
  payload?: Uint8Array
}

class Writer {
  private parts: Uint8Array[] = []
  private length = 0

  get offset(): number {
    return this.length
  }

  push(bytes: Uint8Array): number {
    const at = this.length
    this.parts.push(bytes)
    this.length += bytes.length
    return at
  }

  /** TIFF requires word-aligned offsets for multi-byte values. */
  align(): void {
    if (this.length % 2 === 1) this.push(new Uint8Array(1))
  }

  finish(): Uint8Array {
    const out = new Uint8Array(this.length)
    let p = 0
    for (const part of this.parts) {
      out.set(part, p)
      p += part.length
    }
    this.parts = [out]
    return out
  }
}

export async function encodeTiff(
  pages: readonly RasterImage[],
  opts: TiffEncodeOptions = {},
): Promise<Uint8Array> {
  if (pages.length === 0) throw new IoInvalidError('TIFF needs at least one page')
  let estimate = 0
  for (const p of pages) {
    checkDimensions(p.width, p.height, 'TIFF')
    estimate += p.data.byteLength
  }
  if (estimate * 1.05 > CLASSIC_TIFF_LIMIT) {
    // The spec asks for an automatic BigTIFF switch here; the writer is classic-only for
    // now, so the refusal is explicit rather than silently producing a corrupt file.
    throw new IoUnsupportedError(
      `image would exceed the 4 GiB classic-TIFF limit (${Math.round(estimate / (1 << 20))} MiB); BigTIFF writing is not implemented`,
      'tiff.bigtiff-needed',
    )
  }

  const w = new Writer()
  // Header: little-endian, version 42, first IFD offset patched at the end.
  const header = new Uint8Array(8)
  header[0] = 0x49
  header[1] = 0x49
  new DataView(header.buffer).setUint16(2, 42, true)
  w.push(header)

  const ifdOffsets: number[] = []
  const nextIfdFields: number[] = []

  for (let i = 0; i < pages.length; i++) {
    const { entries, stripOffsets, stripByteCounts } = await writePageData(w, pages[i], opts)
    // Strip tables are values like any other, placed after the pixel data.
    entries.push(arrayEntry(TIFF_TAG.StripOffsets, stripOffsets))
    entries.push(arrayEntry(TIFF_TAG.StripByteCounts, stripByteCounts))

    for (const e of entries) {
      if (e.payload && e.payload.length > 4) {
        w.align()
        e.inline = w.push(e.payload)
      }
    }
    w.align()
    const ifdOffset = w.offset
    ifdOffsets.push(ifdOffset)
    const sorted = entries.sort((a, b) => a.tag - b.tag)
    const ifd = new Uint8Array(2 + sorted.length * 12 + 4)
    const v = new DataView(ifd.buffer)
    v.setUint16(0, sorted.length, true)
    let p = 2
    for (const e of sorted) {
      v.setUint16(p, e.tag, true)
      v.setUint16(p + 2, e.type, true)
      v.setUint32(p + 4, e.count, true)
      if (e.payload && e.payload.length <= 4) {
        for (let k = 0; k < e.payload.length; k++) ifd[p + 8 + k] = e.payload[k]
      } else {
        v.setUint32(p + 8, e.inline ?? 0, true)
      }
      p += 12
    }
    nextIfdFields.push(ifdOffset + 2 + sorted.length * 12)
    w.push(ifd)
  }

  const out = w.finish()
  const view = new DataView(out.buffer)
  view.setUint32(4, ifdOffsets[0], true)
  for (let i = 0; i < ifdOffsets.length; i++) {
    view.setUint32(nextIfdFields[i], i + 1 < ifdOffsets.length ? ifdOffsets[i + 1] : 0, true)
  }
  return out
}

async function writePageData(
  w: Writer,
  image: RasterImage,
  opts: TiffEncodeOptions,
): Promise<{ entries: Entry[]; stripOffsets: number[]; stripByteCounts: number[] }> {
  const { width, height } = image
  const compression = opts.compression ?? 'deflate'
  const bitsPerSample = image.sampleType === 'u16' ? 16 : image.sampleType === 'f32' ? 32 : 8
  const bytesPerSample = bitsPerSample / 8
  const spp = Math.round(image.data.length / (width * height))
  if (spp < 1) throw new IoInvalidError('TIFF: empty page')

  const photometric =
    image.colorModel === 'indexed'
      ? PHOTOMETRIC.Palette
      : image.colorModel === 'cmyk'
        ? PHOTOMETRIC.Separated
        : image.colorModel === 'gray'
          ? PHOTOMETRIC.BlackIsZero
          : PHOTOMETRIC.Rgb
  if (image.colorModel === 'indexed' && !image.palette) {
    throw new IoInvalidError('TIFF: indexed page without a palette')
  }

  const rowBytes = width * spp * bytesPerSample
  const target = opts.targetStripBytes ?? 64 * 1024
  const rowsPerStrip = Math.max(1, Math.min(height, Math.floor(target / Math.max(1, rowBytes))))
  const stripCount = Math.ceil(height / rowsPerStrip)
  const usePredictor =
    (opts.predictor ?? (compression !== 'none' && image.sampleType !== 'f32')) &&
    compression !== 'none' &&
    (bitsPerSample === 8 || bitsPerSample === 16)

  const stripOffsets: number[] = []
  const stripByteCounts: number[] = []
  const littleEndian = true

  for (let s = 0; s < stripCount; s++) {
    const y0 = s * rowsPerStrip
    const rows = Math.min(rowsPerStrip, height - y0)
    const raw = new Uint8Array(rows * rowBytes)
    const view = new DataView(raw.buffer)
    for (let r = 0; r < rows; r++) {
      const src = (y0 + r) * width * spp
      for (let i = 0; i < width * spp; i++) {
        const value = Number(image.data[src + i] ?? 0)
        const o = r * rowBytes + i * bytesPerSample
        if (bitsPerSample === 8) raw[o] = clamp8(value)
        else if (bitsPerSample === 16) view.setUint16(o, clamp16(value), littleEndian)
        else view.setFloat32(o, value, littleEndian)
      }
    }
    if (usePredictor) applyHorizontalPredictor(raw, width, spp, rows, bitsPerSample, littleEndian)

    let payload: Uint8Array
    switch (compression) {
      case 'none':
        payload = raw
        break
      case 'packbits': {
        // PackBits works per row, not per strip.
        const chunks: Uint8Array[] = []
        for (let r = 0; r < rows; r++) chunks.push(packBits(raw.subarray(r * rowBytes, (r + 1) * rowBytes)))
        payload = concat(chunks)
        break
      }
      case 'lzw':
        payload = lzwEncode(raw)
        break
      default:
        payload = await deflate(raw, 'deflate')
    }
    w.align()
    stripOffsets.push(w.push(payload))
    stripByteCounts.push(payload.length)
  }

  const entries: Entry[] = [
    shortEntry(TIFF_TAG.ImageWidth, width),
    shortEntry(TIFF_TAG.ImageLength, height),
    arrayEntry(TIFF_TAG.BitsPerSample, new Array<number>(spp).fill(bitsPerSample), true),
    shortEntry(TIFF_TAG.Compression, compressionCode(compression)),
    shortEntry(TIFF_TAG.PhotometricInterpretation, photometric),
    shortEntry(TIFF_TAG.SamplesPerPixel, spp),
    longEntry(TIFF_TAG.RowsPerStrip, rowsPerStrip),
    shortEntry(TIFF_TAG.PlanarConfiguration, PLANAR.Chunky),
    shortEntry(TIFF_TAG.Orientation, 1),
    arrayEntry(
      TIFF_TAG.SampleFormat,
      new Array<number>(spp).fill(image.sampleType === 'f32' ? SAMPLE_FORMAT.IeeeFloat : SAMPLE_FORMAT.Uint),
      true,
    ),
  ]
  if (usePredictor) entries.push(shortEntry(TIFF_TAG.Predictor, PREDICTOR.Horizontal))

  const colorChannels = image.colorModel === 'indexed' || image.colorModel === 'gray' ? 1 : image.colorModel === 'cmyk' ? 4 : 3
  const extras = spp - colorChannels
  if (extras > 0) {
    const values = new Array<number>(extras).fill(EXTRA_SAMPLE.Unspecified)
    // The first extra sample is the alpha channel; TIFF distinguishes the two flavours.
    values[0] = image.alpha === 'associated' ? EXTRA_SAMPLE.AssociatedAlpha : EXTRA_SAMPLE.UnassociatedAlpha
    entries.push(arrayEntry(TIFF_TAG.ExtraSamples, values, true))
  }
  if (image.palette) entries.push(colorMapEntry(image.palette, bitsPerSample))
  if (image.resolution) {
    entries.push(rationalEntry(TIFF_TAG.XResolution, image.resolution.x))
    entries.push(rationalEntry(TIFF_TAG.YResolution, image.resolution.y))
    entries.push(shortEntry(TIFF_TAG.ResolutionUnit, image.resolution.unit === 'cm' ? 3 : 2))
  }
  if (opts.software) entries.push(asciiEntry(TIFF_TAG.Software, opts.software))
  if (opts.iccProfile?.length) {
    entries.push({ tag: TIFF_TAG.InterColorProfile, type: 7, count: opts.iccProfile.length, payload: opts.iccProfile })
  }
  if (opts.xmp?.length) {
    entries.push({ tag: TIFF_TAG.XMP, type: 1, count: opts.xmp.length, payload: opts.xmp })
  }
  if (opts.iptc?.length) {
    entries.push({ tag: TIFF_TAG.IPTC, type: 7, count: opts.iptc.length, payload: opts.iptc })
  }
  // Photoshop layer data read at import is written back untouched (spec §4.9).
  const psd = opts.metadata?.opaque?.get('tiff:ImageSourceData')
  if (psd?.length) {
    entries.push({ tag: TIFF_TAG.ImageSourceData, type: 7, count: psd.length, payload: psd })
  }

  return { entries, stripOffsets, stripByteCounts }
}

function compressionCode(c: TiffCompression): number {
  switch (c) {
    case 'none':
      return COMPRESSION.None
    case 'lzw':
      return COMPRESSION.Lzw
    case 'packbits':
      return COMPRESSION.PackBits
    default:
      return COMPRESSION.AdobeDeflate
  }
}

function shortEntry(tag: number, value: number): Entry {
  const payload = new Uint8Array(4)
  new DataView(payload.buffer).setUint16(0, value, true)
  return { tag, type: 3, count: 1, payload }
}

function longEntry(tag: number, value: number): Entry {
  const payload = new Uint8Array(4)
  new DataView(payload.buffer).setUint32(0, value >>> 0, true)
  return { tag, type: 4, count: 1, payload }
}

function asciiEntry(tag: number, text: string): Entry {
  const bytes = new Uint8Array(text.length + 1)
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff
  return { tag, type: 2, count: bytes.length, payload: bytes }
}

function rationalEntry(tag: number, value: number): Entry {
  const payload = new Uint8Array(8)
  const v = new DataView(payload.buffer)
  // A denominator of 10 000 keeps four decimals without overflowing.
  v.setUint32(0, Math.round(value * 10000) >>> 0, true)
  v.setUint32(4, 10000, true)
  return { tag, type: 5, count: 1, payload }
}

/** SHORT array when `asShort`, LONG otherwise. */
function arrayEntry(tag: number, values: readonly number[], asShort = false): Entry {
  const size = asShort ? 2 : 4
  const payload = new Uint8Array(Math.max(4, values.length * size))
  const v = new DataView(payload.buffer)
  values.forEach((value, i) => {
    if (asShort) v.setUint16(i * size, value & 0xffff, true)
    else v.setUint32(i * size, value >>> 0, true)
  })
  return {
    tag,
    type: asShort ? 3 : 4,
    count: values.length,
    payload: values.length * size <= 4 ? payload.subarray(0, 4) : payload,
  }
}

/** ColorMap: 3 × 2^bps SHORT entries, all reds, then greens, then blues, scaled to 16 bits. */
function colorMapEntry(palette: Uint8Array, bitsPerSample: number): Entry {
  const entries = 1 << Math.min(bitsPerSample, 8)
  const payload = new Uint8Array(entries * 3 * 2)
  const v = new DataView(payload.buffer)
  for (let i = 0; i < entries; i++) {
    const r = palette[i * 3] ?? 0
    const g = palette[i * 3 + 1] ?? 0
    const b = palette[i * 3 + 2] ?? 0
    v.setUint16(i * 2, r * 257, true)
    v.setUint16((entries + i) * 2, g * 257, true)
    v.setUint16((entries * 2 + i) * 2, b * 257, true)
  }
  return { tag: TIFF_TAG.ColorMap, type: 3, count: entries * 3, payload }
}

function clamp8(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v)
}

function clamp16(v: number): number {
  return v < 0 ? 0 : v > 65535 ? 65535 : Math.round(v)
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let p = 0
  for (const part of parts) {
    out.set(part, p)
    p += part.length
  }
  return out
}
