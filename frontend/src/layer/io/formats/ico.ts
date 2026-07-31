// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ICO / CUR decoder and encoder (spec 05 §3.3) — multi-image by nature.
//
// `ImageDecoder` refuses `image/x-icon` outright (measured). `<img>` does display .ico
// files, but it picks ONE sub-image by an opaque heuristic and exposes neither the other
// sizes, nor the bit depths, nor the AND mask. Unusable — hence a full decoder.
//
// The per-entry PNG-vs-BMP detection, the doubled `biHeight` and the AND-mask rules are
// derived from GIMP's ICO plug-in (plug-ins/file-ico/ico-load.c, ico-export.c). GIMP is
// Copyright (C) 1995-2025 Spencer Kimball, Peter Mattis and the GIMP developers,
// GPL-3.0-or-later; Kubuno is AGPL-3.0-or-later, which is compatible. Reimplemented in
// TypeScript; no code was copied.

import { EMPTY_METADATA } from '../metadata/types'
import { decodeDibPixels, readDibHeader, toRgba8 } from './bmp'
import { decodePng, encodePng } from './png'
import { checkDimensions } from './limits'
import { ByteReader, matchBytes } from './reader'
import {
  IoInvalidError,
  WarningSink,
  ioWarn,
  type DecodedFile,
  type IoWarning,
  type RasterImage,
  type RasterPage,
} from './types'

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const MAX_ENTRIES = 512

export interface IcoEntry {
  readonly width: number
  readonly height: number
  readonly bitCount: number
  readonly isPng: boolean
  /** CUR only: the click point, preserved in the metadata and re-written on export. */
  readonly hotspot?: { x: number; y: number }
}

export async function decodeIco(bytes: Uint8Array): Promise<DecodedFile> {
  const sink = new WarningSink()
  const warn = (w: IoWarning): void => sink.warn(w)
  const r = new ByteReader(bytes, true)
  if (bytes.length < 6) throw new IoInvalidError('ICO file too short')
  const reserved = r.u16()
  const type = r.u16()
  const count = r.u16()
  if (reserved !== 0 || (type !== 1 && type !== 2)) throw new IoInvalidError('not an ICO/CUR file')
  if (count < 1 || count > MAX_ENTRIES) throw new IoInvalidError(`ICO declares ${count} entries`)
  const isCursor = type === 2

  const pages: RasterPage[] = []
  for (let i = 0; i < count; i++) {
    const base = 6 + i * 16
    if (!r.has(base, 16)) {
      warn(ioWarn('ico.directory-truncated', { index: i }))
      break
    }
    // 0 means 256: the field is a single byte.
    const width = r.bytes[base] === 0 ? 256 : r.bytes[base]
    const height = r.bytes[base + 1] === 0 ? 256 : r.bytes[base + 1]
    r.offset = base + 4
    const planesOrHotspotX = r.u16()
    const bitCountOrHotspotY = r.u16()
    const byteCount = r.u32()
    const offset = r.u32()
    if (byteCount <= 0 || !r.has(offset, Math.min(byteCount, 8))) {
      warn(ioWarn('ico.entry-out-of-range', { index: i, offset }))
      continue
    }
    const available = Math.min(byteCount, bytes.length - offset)
    const payload = bytes.subarray(offset, offset + available)
    const hotspot = isCursor ? { x: planesOrHotspotX, y: bitCountOrHotspotY } : undefined

    try {
      const image = matchBytes(payload, 0, PNG_SIGNATURE)
        ? (await decodePng(payload)).pages[0].image
        : decodeIcoDib(payload, width, height, warn)
      pages.push({
        image: hotspot ? withHotspot(image, hotspot) : image,
        role: 'alternate-size',
        index: i,
        name: `${image.width}×${image.height} ${matchBytes(payload, 0, PNG_SIGNATURE) ? 'PNG' : `${bitCountOrHotspotY}bpp`}`,
      })
    } catch (e) {
      warn(ioWarn('ico.entry-failed', { index: i, error: String(e) }))
    }
  }
  if (pages.length === 0) throw new IoInvalidError('no decodable entry in this ICO/CUR')

  // Largest first: a naive consumer showing pages[0] gets the best image.
  pages.sort((a, b) => b.image.width * b.image.height - a.image.width * a.image.height)
  return {
    formatId: isCursor ? 'cur' : 'ico',
    pages: pages.map((p, index) => ({ ...p, index })),
    metadata: EMPTY_METADATA,
    warnings: sink.warnings,
  }
}

function withHotspot(image: RasterImage, hotspot: { x: number; y: number }): RasterImage {
  const text = new Map(image.metadata.text ?? [])
  text.set('HotspotX', String(hotspot.x))
  text.set('HotspotY', String(hotspot.y))
  return { ...image, metadata: { ...image.metadata, text } }
}

/**
 * Decodes one BMP-flavoured ICO entry. Its `biHeight` is TWICE the real height: the XOR
 * (colour) mask, then the 1-bit AND (transparency) mask.
 */
function decodeIcoDib(
  payload: Uint8Array,
  dirWidth: number,
  dirHeight: number,
  warn: (w: IoWarning) => void,
): RasterImage {
  const r = new ByteReader(payload, true)
  const header = readDibHeader(r, 0)
  const realHeight = Math.floor(header.height / 2) || dirHeight
  const width = header.width || dirWidth
  checkDimensions(width, realHeight, 'ICO entry')

  const pixelOffset = header.paletteOffset + header.paletteEntries * header.paletteEntrySize
  const pixels = decodeDibPixels(r, { ...header, height: realHeight }, pixelOffset, warn, {
    heightOverride: realHeight,
    argb32: true,
  })

  // Expand to RGBA so the AND mask can be applied uniformly.
  const base: RasterImage = {
    width,
    height: realHeight,
    colorModel: pixels.colorModel,
    sampleType: 'u8',
    colorChannels: pixels.colorModel === 'indexed' ? 1 : 3,
    alpha: pixels.alpha,
    data: pixels.data,
    palette: pixels.palette,
    colorSpace: { kind: 'srgb' },
    metadata: EMPTY_METADATA,
    sourceBitDepth: header.bitCount,
  }
  const rgba = toRgba8(base)

  // AND mask: 1 bit per pixel, rows padded to 4 bytes, bottom-up, 1 = transparent.
  //
  // NOT applied to 32-bit entries: Windows ignores the AND mask there and uses the real
  // alpha channel, and so does GIMP (ico-load.c: "32bpp: Windows ignores the AND mask;
  // ARGB uses real alpha, 0RGB is treated as fully opaque"). Applying it anyway punches
  // holes in perfectly good favicons.
  const colorRowBytes = Math.floor((width * header.bitCount + 31) / 32) * 4
  const maskOffset = pixelOffset + colorRowBytes * realHeight
  const maskRowBytes = Math.floor((width + 31) / 32) * 4
  let maskApplied = false
  if (header.bitCount !== 32 && r.has(maskOffset, maskRowBytes * realHeight)) {
    let anyMasked = false
    for (let y = 0; y < realHeight; y++) {
      const srcRow = maskOffset + (realHeight - 1 - y) * maskRowBytes
      for (let x = 0; x < width; x++) {
        const bit = (r.bytes[srcRow + (x >> 3)] >> (7 - (x & 7))) & 1
        if (bit) {
          rgba[(y * width + x) * 4 + 3] = 0
          anyMasked = true
        }
      }
    }
    maskApplied = anyMasked
  }

  const hasPixelAlpha = header.bitCount === 32 && pixels.alpha !== 'none'
  const alpha = hasPixelAlpha || maskApplied ? ('unassociated' as const) : ('none' as const)

  return {
    width,
    height: realHeight,
    colorModel: 'rgb',
    sampleType: 'u8',
    colorChannels: 3,
    alpha,
    data: alpha === 'none' ? dropAlpha(rgba) : rgba,
    colorSpace: { kind: 'srgb' },
    metadata: EMPTY_METADATA,
    sourceBitDepth: header.bitCount,
  }
}

function dropAlpha(rgba: Uint8Array): Uint8Array {
  const pixels = rgba.length / 4
  const out = new Uint8Array(pixels * 3)
  for (let i = 0; i < pixels; i++) {
    out[i * 3] = rgba[i * 4]
    out[i * 3 + 1] = rgba[i * 4 + 1]
    out[i * 3 + 2] = rgba[i * 4 + 2]
  }
  return out
}

// ---------------------------------------------------------------------------
// Encoder
// ---------------------------------------------------------------------------

export interface IcoEncodeOptions {
  /** Per-entry encoding. 'auto' = PNG at 256 px and above, BMP below (the Windows rule). */
  readonly entryFormat?: 'auto' | 'png' | 'bmp'
  /** Writes a CUR instead of an ICO; hotspots default to (0, 0). */
  readonly cursor?: boolean
  readonly hotspots?: readonly { x: number; y: number }[]
}

/**
 * Writes an ICO/CUR from already-sized pages. Resampling to the size set is the caller's
 * job (spec 05 §8.4) — the encoder never invents pixels.
 */
export async function encodeIco(
  pages: readonly RasterImage[],
  opts: IcoEncodeOptions = {},
): Promise<Uint8Array> {
  if (pages.length === 0 || pages.length > MAX_ENTRIES) {
    throw new IoInvalidError(`ICO needs between 1 and ${MAX_ENTRIES} images`)
  }
  const payloads: Uint8Array[] = []
  for (const page of pages) {
    if (page.width > 256 || page.height > 256) {
      throw new IoInvalidError(`ICO entries cannot exceed 256×256 (got ${page.width}×${page.height})`)
    }
    const usePng =
      opts.entryFormat === 'png' ||
      (opts.entryFormat !== 'bmp' && (page.width >= 256 || page.height >= 256))
    payloads.push(usePng ? await encodePng(page, { bitDepth: 8 }) : encodeIcoDib(page))
  }

  const headerSize = 6 + pages.length * 16
  const total = headerSize + payloads.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  const v = new DataView(out.buffer)
  v.setUint16(0, 0, true)
  v.setUint16(2, opts.cursor ? 2 : 1, true)
  v.setUint16(4, pages.length, true)

  let offset = headerSize
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i]
    const base = 6 + i * 16
    out[base] = p.width >= 256 ? 0 : p.width
    out[base + 1] = p.height >= 256 ? 0 : p.height
    out[base + 2] = 0 // colour count (0 for >= 8 bpp)
    out[base + 3] = 0
    if (opts.cursor) {
      const h = opts.hotspots?.[i] ?? { x: 0, y: 0 }
      v.setUint16(base + 4, h.x, true)
      v.setUint16(base + 6, h.y, true)
    } else {
      v.setUint16(base + 4, 1, true) // planes
      v.setUint16(base + 6, 32, true) // bit count
    }
    v.setUint32(base + 8, payloads[i].length, true)
    v.setUint32(base + 12, offset, true)
    out.set(payloads[i], offset)
    offset += payloads[i].length
  }
  return out
}

/** 32-bit BGRA DIB with a doubled height and an all-zero AND mask. */
function encodeIcoDib(image: RasterImage): Uint8Array {
  const { width, height } = image
  const rgba = toRgba8(image)
  const colorRowBytes = width * 4
  const maskRowBytes = Math.floor((width + 31) / 32) * 4
  const out = new Uint8Array(40 + colorRowBytes * height + maskRowBytes * height)
  const v = new DataView(out.buffer)
  v.setUint32(0, 40, true)
  v.setInt32(4, width, true)
  v.setInt32(8, height * 2, true) // XOR mask + AND mask
  v.setUint16(12, 1, true)
  v.setUint16(14, 32, true)
  v.setUint32(16, 0, true) // BI_RGB
  v.setUint32(20, colorRowBytes * height + maskRowBytes * height, true)
  for (let y = 0; y < height; y++) {
    const dst = 40 + (height - 1 - y) * colorRowBytes
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4
      out[dst + x * 4] = rgba[s + 2]
      out[dst + x * 4 + 1] = rgba[s + 1]
      out[dst + x * 4 + 2] = rgba[s]
      out[dst + x * 4 + 3] = rgba[s + 3]
    }
  }
  // The AND mask stays zero: the alpha channel already carries the transparency, which is
  // what every Windows version since XP honours.
  return out
}
