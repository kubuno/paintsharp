// Native decode path wrapped as a `DecodedFile` (spec 05 §3.2, §3.3).
//
// The pixels come from the platform codec; the CONTAINER is always walked in-house so
// EXIF, XMP and ICC survive — the browser exposes none of them. Orientation is read here
// and recorded, never applied: `createImageBitmap` is called with
// `imageOrientation: 'none'` and the rotation is baked in by `metadata/orientation.ts`.

import { finishMetadata, type MutableImageMetadata } from '../metadata/types'
import { parseExif, exifOrientation, stripExifPrefix } from '../metadata/exif'
import { joinIccFromJpeg, parseIcc } from '../metadata/icc'
import { extract8BimIptc, parseIptc } from '../metadata/iptc'
import { XMP_JPEG_ID, parseXmp } from '../metadata/xmp'
import { nativeDecode } from './native'
import { readJpegSegments } from './tiff/jpegStream'
import type { ByteSource, IoContext, ReadOptions } from './registry'
import { WarningSink, ioWarn, type DecodedFile, type ImageMetadata, type RasterImage } from './types'

const APP1 = 0xe1
const APP2 = 0xe2
const APP13 = 0xed

export async function readNativeImage(
  source: ByteSource,
  formatId: string,
  mime: string,
  opts: ReadOptions,
  ctx: IoContext,
): Promise<DecodedFile> {
  const sink = new WarningSink()
  const bytes = await source.all()
  const metadata =
    formatId === 'jpeg'
      ? readJpegMetadata(bytes, sink)
      : formatId === 'webp'
        ? readRiffMetadata(bytes, sink)
        : finishMetadata({})

  if (opts.headerOnly) {
    const empty: RasterImage = {
      width: 0,
      height: 0,
      colorModel: 'rgb',
      sampleType: 'u8',
      colorChannels: 3,
      alpha: 'none',
      data: new Uint8Array(0),
      colorSpace: { kind: 'srgb' },
      metadata,
      orientation: exifOrientation(metadata.exif),
    }
    return { formatId, pages: [{ image: empty, role: 'main', index: 0 }], metadata, warnings: sink.warnings }
  }

  const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: mime })
  const decoded = await nativeDecode(blob)
  for (const w of sink.warnings) ctx.warn(w)

  const image: RasterImage = {
    width: decoded.width,
    height: decoded.height,
    colorModel: 'rgb',
    sampleType: 'u8',
    colorChannels: 3,
    alpha: 'unassociated',
    data: decoded.rgba,
    colorSpace: metadata.icc ? { kind: 'icc', profile: metadata.icc } : { kind: 'srgb' },
    metadata,
    orientation: exifOrientation(metadata.exif),
    sourceBitDepth: 8,
  }
  return { formatId, pages: [{ image, role: 'main', index: 0 }], metadata, warnings: sink.warnings }
}

/** Walks the JPEG marker segments — pixels are never touched here. */
export function readJpegMetadata(bytes: Uint8Array, sink: WarningSink): ImageMetadata {
  const m: MutableImageMetadata = {}
  const iccChunks: Uint8Array[] = []
  try {
    for (const seg of readJpegSegments(bytes, 128)) {
      if (seg.marker === APP1) {
        if (startsWith(seg.payload, 'Exif\0\0')) {
          m.exif = parseExif(stripExifPrefix(seg.payload)) ?? undefined
        } else if (startsWith(seg.payload, XMP_JPEG_ID)) {
          m.xmp = parseXmp(seg.payload.subarray(XMP_JPEG_ID.length)) ?? undefined
        }
      } else if (seg.marker === APP2 && startsWith(seg.payload, 'ICC_PROFILE\0')) {
        iccChunks.push(seg.payload)
      } else if (seg.marker === APP13 && startsWith(seg.payload, 'Photoshop 3.0\0')) {
        const resources = seg.payload.subarray('Photoshop 3.0\0'.length)
        const iim = extract8BimIptc(resources)
        if (iim) m.iptc = parseIptc(iim) ?? undefined
      }
    }
    if (iccChunks.length > 0) {
      const raw = joinIccFromJpeg(iccChunks)
      if (raw) m.icc = parseIcc(raw) ?? undefined
    }
  } catch (e) {
    sink.warn(ioWarn('jpeg.metadata-unreadable', { error: String(e) }, 'info'))
  }
  return finishMetadata(m)
}

/** Walks the RIFF chunks of a WebP for `EXIF`, `XMP ` and `ICCP`. */
export function readRiffMetadata(bytes: Uint8Array, sink: WarningSink): ImageMetadata {
  const m: MutableImageMetadata = {}
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    let p = 12
    let guard = 0
    while (p + 8 <= bytes.length && guard++ < 1024) {
      const tag = String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3])
      const size = view.getUint32(p + 4, true)
      const start = p + 8
      if (size < 0 || start + size > bytes.length) break
      const payload = bytes.subarray(start, start + size)
      if (tag === 'EXIF') m.exif = parseExif(payload) ?? undefined
      else if (tag === 'XMP ') m.xmp = parseXmp(payload) ?? undefined
      else if (tag === 'ICCP') m.icc = parseIcc(payload) ?? undefined
      // RIFF chunks are padded to an even size.
      p = start + size + (size % 2)
    }
  } catch (e) {
    sink.warn(ioWarn('webp.metadata-unreadable', { error: String(e) }, 'info'))
  }
  return finishMetadata(m)
}

function startsWith(buf: Uint8Array, prefix: string): boolean {
  if (buf.length < prefix.length) return false
  for (let i = 0; i < prefix.length; i++) {
    if (buf[i] !== prefix.charCodeAt(i)) return false
  }
  return true
}
