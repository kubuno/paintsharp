// SPDX-License-Identifier: AGPL-3.0-or-later
//
// BMP / DIB decoder and encoder (spec 05 §3.3).
//
// `ImageDecoder` claims `image/bmp` support, but in practice only plain 24/32-bit BMPs
// decode: BITMAPV4HEADER/V5HEADER (arbitrary bit masks, AlphaMask, LCS_*, embedded ICC),
// RLE4/RLE8, negative height (top-down), 16-bit 555/565 and sub-8-bit palettes are
// mishandled or invisible. Hence a full in-house decoder.
//
// Header variants, RLE4/RLE8 escape handling and the BITFIELDS logic are derived from
// GIMP's BMP plug-in (plug-ins/file-bmp/bmp-load.c, bmp-export.c). GIMP is
// Copyright (C) 1995-2025 Spencer Kimball, Peter Mattis and the GIMP developers,
// GPL-3.0-or-later; Kubuno is AGPL-3.0-or-later, which is compatible. Reimplemented in
// TypeScript; no code was copied.

import { EMPTY_METADATA } from '../metadata/types'
import { allocU8, checkDimensions } from './limits'
import { ByteReader } from './reader'
import {
  IoInvalidError,
  IoUnsupportedError,
  WarningSink,
  ioWarn,
  type AlphaMode,
  type ColorModel,
  type DecodedFile,
  type IoWarning,
  type RasterImage,
} from './types'

const BI_RGB = 0
const BI_RLE8 = 1
const BI_RLE4 = 2
const BI_BITFIELDS = 3
const BI_JPEG = 4
const BI_PNG = 5
const BI_ALPHABITFIELDS = 6

export interface DibHeader {
  readonly headerSize: number
  readonly width: number
  /** Already absolute; see `topDown`. */
  readonly height: number
  readonly topDown: boolean
  readonly bitCount: number
  readonly compression: number
  readonly paletteEntries: number
  /** 3 bytes per entry for the 12-byte CORE header, 4 otherwise. */
  readonly paletteEntrySize: number
  readonly masks: { r: number; g: number; b: number; a: number } | null
  readonly xPixelsPerMeter: number
  readonly yPixelsPerMeter: number
  /** Offset just past the header (and past the trailing masks of a BITFIELDS INFO header). */
  readonly paletteOffset: number
}

/** Reads a DIB header at `offset`. Shared with the ICO decoder. */
export function readDibHeader(r: ByteReader, offset: number): DibHeader {
  r.offset = offset
  const headerSize = r.u32()
  if (headerSize === 12) {
    const width = r.u16()
    const height = r.u16()
    r.u16() // planes
    const bitCount = r.u16()
    return {
      headerSize,
      width,
      height,
      topDown: false,
      bitCount,
      compression: BI_RGB,
      paletteEntries: bitCount <= 8 ? 1 << bitCount : 0,
      paletteEntrySize: 3,
      masks: null,
      xPixelsPerMeter: 0,
      yPixelsPerMeter: 0,
      paletteOffset: offset + 12,
    }
  }
  if (headerSize < 40 || headerSize > 1024) {
    throw new IoInvalidError(`unsupported DIB header size ${headerSize}`)
  }
  const width = r.i32()
  const rawHeight = r.i32()
  r.u16() // planes
  const bitCount = r.u16()
  const compression = r.u32()
  r.u32() // sizeImage
  const xPixelsPerMeter = r.i32()
  const yPixelsPerMeter = r.i32()
  const clrUsed = r.u32()
  r.u32() // clrImportant

  let masks: DibHeader['masks'] = null
  let paletteOffset = offset + headerSize
  if (headerSize >= 52) {
    // V2/V3/V4/V5 carry the masks inside the header.
    r.offset = offset + 40
    const rm = r.u32()
    const gm = r.u32()
    const bm = r.u32()
    const am = headerSize >= 56 ? r.u32() : 0
    masks = { r: rm, g: gm, b: bm, a: am }
  } else if (compression === BI_BITFIELDS || compression === BI_ALPHABITFIELDS) {
    // A 40-byte header stores the masks right after it, before the palette.
    r.offset = offset + 40
    const rm = r.u32()
    const gm = r.u32()
    const bm = r.u32()
    const am = compression === BI_ALPHABITFIELDS ? r.u32() : 0
    masks = { r: rm, g: gm, b: bm, a: am }
    paletteOffset = offset + 40 + (compression === BI_ALPHABITFIELDS ? 16 : 12)
  }

  const maxPalette = bitCount <= 8 ? 1 << bitCount : 0
  const paletteEntries = clrUsed > 0 ? Math.min(clrUsed, 256) : maxPalette

  return {
    headerSize,
    width: Math.abs(width),
    height: Math.abs(rawHeight),
    topDown: rawHeight < 0,
    bitCount,
    compression,
    paletteEntries,
    paletteEntrySize: 4,
    masks,
    xPixelsPerMeter,
    yPixelsPerMeter,
    paletteOffset,
  }
}

export interface DibPixels {
  readonly data: Uint8Array
  readonly colorModel: ColorModel
  readonly channels: number
  readonly alpha: AlphaMode
  readonly palette?: Uint8Array
}

export interface DibDecodeOptions {
  /** ICO's `biHeight` is twice the real height (XOR mask, then AND mask). */
  readonly heightOverride?: number
  /**
   * ICO semantics: a 32-bit entry is ARGB, its fourth byte IS the alpha. Plain BMP says
   * the opposite — `BI_RGB` at 32 bits has no alpha unless a V4/V5 mask declares one,
   * which is what GIMP (bmp-load.c `set_default_masks`, alpha mask = 0) and ImageMagick
   * both implement.
   */
  readonly argb32: boolean
}

/** Decodes DIB pixels. */
export function decodeDibPixels(
  r: ByteReader,
  header: DibHeader,
  pixelOffset: number,
  warn: (w: IoWarning) => void,
  opts: DibDecodeOptions = { argb32: false },
): DibPixels {
  const heightOverride = opts.heightOverride
  const width = header.width
  const height = heightOverride ?? header.height
  checkDimensions(width, height, 'BMP')

  if (header.compression === BI_JPEG || header.compression === BI_PNG) {
    throw new IoUnsupportedError('JPEG/PNG-in-BMP is not supported', 'bmp.embedded-codec')
  }

  const palette = header.paletteEntries > 0 ? readPalette(r, header) : undefined

  if (header.bitCount <= 8) {
    const indices = allocU8(width * height, 'BMP indices')
    if (header.compression === BI_RLE8 || header.compression === BI_RLE4) {
      decodeRle(r, pixelOffset, indices, width, height, header.compression === BI_RLE4, header.topDown, warn)
    } else {
      unpackIndexedRows(r, pixelOffset, indices, width, height, header.bitCount, header.topDown)
    }
    return { data: indices, colorModel: 'indexed', channels: 1, alpha: 'none', palette }
  }

  return decodeTrueColor(r, header, pixelOffset, width, height, warn, opts.argb32)
}

function readPalette(r: ByteReader, header: DibHeader): Uint8Array {
  const n = header.paletteEntries
  const size = header.paletteEntrySize
  const out = new Uint8Array(n * 3)
  for (let i = 0; i < n; i++) {
    const o = header.paletteOffset + i * size
    if (!r.has(o, size)) break
    // Stored B, G, R (, reserved).
    out[i * 3] = r.bytes[o + 2]
    out[i * 3 + 1] = r.bytes[o + 1]
    out[i * 3 + 2] = r.bytes[o]
  }
  return out
}

function unpackIndexedRows(
  r: ByteReader,
  pixelOffset: number,
  out: Uint8Array,
  width: number,
  height: number,
  bitCount: number,
  topDown: boolean,
): void {
  // BMP rows are padded to 4 bytes — not to a byte as in TIFF.
  const rowBytes = Math.floor((width * bitCount + 31) / 32) * 4
  const max = (1 << bitCount) - 1
  for (let y = 0; y < height; y++) {
    const srcRow = pixelOffset + y * rowBytes
    const dstY = topDown ? y : height - 1 - y
    const dst = dstY * width
    for (let x = 0; x < width; x++) {
      const bitPos = x * bitCount
      const byteIndex = srcRow + (bitPos >> 3)
      if (byteIndex >= r.bytes.length) return
      const shift = 8 - bitCount - (bitPos & 7)
      out[dst + x] = (r.bytes[byteIndex] >> shift) & max
    }
  }
}

/**
 * RLE4/RLE8. Escapes: `00 00` end of line, `00 01` end of bitmap, `00 02 dx dy` delta,
 * `00 n` (n >= 3) an absolute run padded to a 16-bit boundary.
 */
function decodeRle(
  r: ByteReader,
  pixelOffset: number,
  out: Uint8Array,
  width: number,
  height: number,
  rle4: boolean,
  topDown: boolean,
  warn: (w: IoWarning) => void,
): void {
  const bytes = r.bytes
  let p = pixelOffset
  let x = 0
  let y = 0
  const put = (index: number): void => {
    if (x < 0 || x >= width || y < 0 || y >= height) return
    const dstY = topDown ? y : height - 1 - y
    out[dstY * width + x] = index
  }
  let guard = 0
  const maxIterations = width * height + 65536
  while (p + 1 < bytes.length && y < height && guard++ < maxIterations) {
    const count = bytes[p++]
    const value = bytes[p++]
    if (count > 0) {
      for (let i = 0; i < count; i++) {
        put(rle4 ? (i % 2 === 0 ? value >> 4 : value & 0x0f) : value)
        x++
      }
      continue
    }
    if (value === 0) {
      x = 0
      y++
    } else if (value === 1) {
      return
    } else if (value === 2) {
      if (p + 1 >= bytes.length) return
      x += bytes[p++]
      y += bytes[p++]
    } else {
      // Absolute mode.
      const n = value
      if (rle4) {
        for (let i = 0; i < n; i++) {
          const b = bytes[p + (i >> 1)]
          if (b === undefined) return
          put(i % 2 === 0 ? b >> 4 : b & 0x0f)
          x++
        }
        p += Math.ceil(n / 2)
      } else {
        for (let i = 0; i < n; i++) {
          if (p + i >= bytes.length) return
          put(bytes[p + i])
          x++
        }
        p += n
      }
      if (p % 2 === 1) p++ // 16-bit alignment
    }
  }
  if (guard >= maxIterations) warn(ioWarn('bmp.rle-runaway'))
}

function decodeTrueColor(
  r: ByteReader,
  header: DibHeader,
  pixelOffset: number,
  width: number,
  height: number,
  warn: (w: IoWarning) => void,
  argb32: boolean,
): DibPixels {
  const bpp = header.bitCount
  const bytesPerPixel = bpp / 8
  const rowBytes = Math.floor((width * bpp + 31) / 32) * 4

  // Default masks when BI_RGB: 16 bits is 555, 24/32 bits are BGR(A).
  let masks = header.masks
  if (!masks || (masks.r === 0 && masks.g === 0 && masks.b === 0)) {
    masks =
      bpp === 16
        ? { r: 0x7c00, g: 0x03e0, b: 0x001f, a: 0 }
        : { r: 0x00ff0000, g: 0x0000ff00, b: 0x000000ff, a: bpp === 32 ? 0xff000000 : 0 }
  }
  // An alpha mask only means something if its bits actually exist at this depth.
  // BITMAPV4/V5 headers written by ImageMagick carry `a = 0xFF000000` even on
  // 24-bit images, where there is no fourth byte to read: trusting the mask there
  // yields a fourth channel that is never written, i.e. alpha 0 — a fully
  // transparent (black-looking) image. Require the mask to fit inside `bpp`,
  // which still accepts genuine 16-bit ARGB1555 (a = 0x8000).
  const alphaMaskBits = masks.a === 0 ? 0 : 32 - Math.clz32(masks.a)
  const hasAlphaMask = alphaMaskBits > 0 && alphaMaskBits <= bpp
  if (masks.a !== 0 && !hasAlphaMask) warn(ioWarn('bmp.alpha-mask-ignored', undefined, 'info'))
  // Without an explicit alpha mask, a 32-bit BMP is X-RGB: the fourth byte is undefined
  // padding, not transparency. Only ICO reinterprets it as ARGB.
  const useFourthByte = hasAlphaMask || (bpp === 32 && argb32)
  const channels = useFourthByte || bpp === 32 ? 4 : 3
  const out = allocU8(width * height * channels, 'BMP pixels')

  const shiftR = maskShift(masks.r)
  const shiftG = maskShift(masks.g)
  const shiftB = maskShift(masks.b)
  const shiftA = maskShift(masks.a)
  const scaleR = maskScale(masks.r)
  const scaleG = maskScale(masks.g)
  const scaleB = maskScale(masks.b)
  const scaleA = maskScale(masks.a)

  let anyAlpha = false
  for (let y = 0; y < height; y++) {
    const srcRow = pixelOffset + y * rowBytes
    const dstY = header.topDown ? y : height - 1 - y
    for (let x = 0; x < width; x++) {
      const o = srcRow + x * bytesPerPixel
      if (!r.has(o, bytesPerPixel)) break
      let v: number
      if (bpp === 16) v = r.bytes[o] | (r.bytes[o + 1] << 8)
      else if (bpp === 24) v = r.bytes[o] | (r.bytes[o + 1] << 8) | (r.bytes[o + 2] << 16)
      else v = (r.bytes[o] | (r.bytes[o + 1] << 8) | (r.bytes[o + 2] << 16) | (r.bytes[o + 3] << 24)) >>> 0
      const d = (dstY * width + x) * channels
      out[d] = Math.round(((v & masks.r) >>> shiftR) * scaleR)
      out[d + 1] = Math.round(((v & masks.g) >>> shiftG) * scaleG)
      out[d + 2] = Math.round(((v & masks.b) >>> shiftB) * scaleB)
      if (channels === 4) {
        const a = hasAlphaMask
          ? Math.round(((v & masks.a) >>> shiftA) * scaleA)
          : useFourthByte
            ? (v >>> 24) & 0xff
            : 0
        out[d + 3] = a
        if (((v >>> 24) & 0xff) !== 0) anyAlpha = true
      }
    }
  }

  let alpha: AlphaMode = 'none'
  if (channels === 4) {
    if (hasAlphaMask) {
      alpha = 'unassociated'
    } else if (useFourthByte && anyAlpha) {
      // ICO: ARGB entry with real alpha.
      alpha = 'unassociated'
    } else if (useFourthByte) {
      // ICO: 0RGB entry — every alpha is zero, which means opaque, not invisible.
      for (let i = 3; i < out.length; i += 4) out[i] = 255
      alpha = 'unassociated'
    } else {
      // Plain BMP at 32 bits with no alpha mask: the fourth byte is padding. Dropping it
      // matches GIMP and ImageMagick; say so when it was not zero, so the information is
      // reported rather than silently discarded.
      if (anyAlpha) warn(ioWarn('bmp.fourth-byte-discarded', undefined, 'info'))
      return { data: dropAlpha(out, width * height), colorModel: 'rgb', channels: 3, alpha: 'none' }
    }
  }
  return { data: out, colorModel: 'rgb', channels, alpha }
}

function dropAlpha(rgba: Uint8Array, pixels: number): Uint8Array {
  const out = new Uint8Array(pixels * 3)
  for (let i = 0; i < pixels; i++) {
    out[i * 3] = rgba[i * 4]
    out[i * 3 + 1] = rgba[i * 4 + 1]
    out[i * 3 + 2] = rgba[i * 4 + 2]
  }
  return out
}

function maskShift(mask: number): number {
  if (mask === 0) return 0
  let s = 0
  let m = mask >>> 0
  while ((m & 1) === 0 && s < 32) {
    m >>>= 1
    s++
  }
  return s
}

function maskScale(mask: number): number {
  if (mask === 0) return 0
  const bits = countBits(mask >>> maskShift(mask))
  const max = (1 << bits) - 1
  return max === 0 ? 0 : 255 / max
}

function countBits(v: number): number {
  let n = 0
  let m = v >>> 0
  while (m !== 0) {
    n += m & 1
    m >>>= 1
  }
  return n
}

// ---------------------------------------------------------------------------

export function decodeBmp(bytes: Uint8Array): DecodedFile {
  const sink = new WarningSink()
  const r = new ByteReader(bytes, true)
  if (bytes.length < 26 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) {
    throw new IoInvalidError('not a BMP file')
  }
  r.offset = 10
  const declaredPixelOffset = r.u32()
  const header = readDibHeader(r, 14)
  // A wrong pixel offset is common in hand-made files: fall back to just past the palette.
  const computed = header.paletteOffset + header.paletteEntries * header.paletteEntrySize
  const pixelOffset =
    declaredPixelOffset >= header.paletteOffset && declaredPixelOffset < bytes.length
      ? declaredPixelOffset
      : computed

  const pixels = decodeDibPixels(r, header, pixelOffset, (w) => sink.warn(w))
  const resolution =
    header.xPixelsPerMeter > 0
      ? { x: header.xPixelsPerMeter / 100, y: header.yPixelsPerMeter / 100, unit: 'cm' as const }
      : undefined

  const image: RasterImage = {
    width: header.width,
    height: header.height,
    colorModel: pixels.colorModel,
    sampleType: 'u8',
    colorChannels: pixels.colorModel === 'indexed' ? 1 : 3,
    alpha: pixels.alpha,
    data: pixels.data,
    palette: pixels.palette,
    colorSpace: { kind: 'srgb' },
    metadata: EMPTY_METADATA,
    resolution,
    sourceBitDepth: header.bitCount,
  }
  return {
    formatId: 'bmp',
    pages: [{ image, role: 'main', index: 0 }],
    metadata: EMPTY_METADATA,
    warnings: sink.warnings,
  }
}

// ---------------------------------------------------------------------------
// Encoder — the browser cannot write BMP at all (measured: `convertToBlob` silently
// returns a PNG for `image/bmp`), so this is the only path.
// ---------------------------------------------------------------------------

export interface BmpEncodeOptions {
  /** 24 (BGR), 32 (BGRA, V4 header with an alpha mask) or 8 (indexed). */
  readonly bitCount?: 8 | 16 | 24 | 32
  /** 16-bit layout when `bitCount === 16`. */
  readonly rgb16?: '555' | '565'
}

/**
 * Writes a BMP. 32-bit output uses a BITMAPV4HEADER with explicit masks, because a plain
 * 40-byte header gives no portable way to declare the alpha channel.
 */
export function encodeBmp(image: RasterImage, opts: BmpEncodeOptions = {}): Uint8Array {
  const { width, height } = image
  checkDimensions(width, height, 'BMP')
  const rgba = toRgba8(image)
  const hasAlpha = image.alpha !== 'none'
  const bitCount = opts.bitCount ?? (hasAlpha ? 32 : 24)

  if (bitCount === 32) return writeBmp32(rgba, width, height)
  if (bitCount === 16) return writeBmp16(rgba, width, height, opts.rgb16 ?? '565')
  if (bitCount === 24) return writeBmp24(rgba, width, height)
  throw new IoUnsupportedError(`BMP output at ${bitCount} bits is not implemented`, 'bmp.encode-depth')
}

function writeHeaders(
  headerSize: number,
  width: number,
  height: number,
  bitCount: number,
  compression: number,
  pixelBytes: number,
): { buf: Uint8Array; pixelOffset: number } {
  const pixelOffset = 14 + headerSize
  const buf = new Uint8Array(pixelOffset + pixelBytes)
  const v = new DataView(buf.buffer)
  buf[0] = 0x42
  buf[1] = 0x4d
  v.setUint32(2, buf.length, true)
  v.setUint32(10, pixelOffset, true)
  v.setUint32(14, headerSize, true)
  v.setInt32(18, width, true)
  v.setInt32(22, height, true)
  v.setUint16(26, 1, true)
  v.setUint16(28, bitCount, true)
  v.setUint32(30, compression, true)
  v.setUint32(34, pixelBytes, true)
  v.setInt32(38, 2835, true) // 72 dpi in pixels per metre
  v.setInt32(42, 2835, true)
  return { buf, pixelOffset }
}

function writeBmp24(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const rowBytes = Math.floor((width * 24 + 31) / 32) * 4
  const { buf, pixelOffset } = writeHeaders(40, width, height, 24, BI_RGB, rowBytes * height)
  for (let y = 0; y < height; y++) {
    const dst = pixelOffset + (height - 1 - y) * rowBytes
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4
      buf[dst + x * 3] = rgba[s + 2]
      buf[dst + x * 3 + 1] = rgba[s + 1]
      buf[dst + x * 3 + 2] = rgba[s]
    }
  }
  return buf
}

function writeBmp32(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const rowBytes = width * 4
  const { buf, pixelOffset } = writeHeaders(108, width, height, 32, BI_BITFIELDS, rowBytes * height)
  const v = new DataView(buf.buffer)
  v.setUint32(54, 0x00ff0000, true) // red
  v.setUint32(58, 0x0000ff00, true) // green
  v.setUint32(62, 0x000000ff, true) // blue
  v.setUint32(66, 0xff000000, true) // alpha
  v.setUint32(70, 0x73524742, true) // 'sRGB' colour space
  for (let y = 0; y < height; y++) {
    const dst = pixelOffset + (height - 1 - y) * rowBytes
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4
      buf[dst + x * 4] = rgba[s + 2]
      buf[dst + x * 4 + 1] = rgba[s + 1]
      buf[dst + x * 4 + 2] = rgba[s]
      buf[dst + x * 4 + 3] = rgba[s + 3]
    }
  }
  return buf
}

function writeBmp16(rgba: Uint8Array, width: number, height: number, layout: '555' | '565'): Uint8Array {
  const rowBytes = Math.floor((width * 16 + 31) / 32) * 4
  const { buf, pixelOffset } = writeHeaders(56, width, height, 16, BI_BITFIELDS, rowBytes * height)
  const v = new DataView(buf.buffer)
  if (layout === '565') {
    v.setUint32(54, 0xf800, true)
    v.setUint32(58, 0x07e0, true)
    v.setUint32(62, 0x001f, true)
  } else {
    v.setUint32(54, 0x7c00, true)
    v.setUint32(58, 0x03e0, true)
    v.setUint32(62, 0x001f, true)
  }
  for (let y = 0; y < height; y++) {
    const dst = pixelOffset + (height - 1 - y) * rowBytes
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4
      const value =
        layout === '565'
          ? ((rgba[s] >> 3) << 11) | ((rgba[s + 1] >> 2) << 5) | (rgba[s + 2] >> 3)
          : ((rgba[s] >> 3) << 10) | ((rgba[s + 1] >> 3) << 5) | (rgba[s + 2] >> 3)
      buf[dst + x * 2] = value & 0xff
      buf[dst + x * 2 + 1] = (value >> 8) & 0xff
    }
  }
  return buf
}

/**
 * Flattens any `RasterImage` to straight RGBA8. High-bit-depth sources are scaled down —
 * BMP has no deeper form — and indexed sources are expanded through their palette.
 */
export function toRgba8(image: RasterImage): Uint8Array {
  const { width, height, data, colorChannels, alpha, palette } = image
  const pixels = width * height
  const spp = data.length / pixels
  const out = new Uint8Array(pixels * 4)
  const scale =
    image.sampleType === 'u16'
      ? 1 / 257
      : image.sampleType === 'u32'
        ? 1 / 16843009
        : image.sampleType === 'f32'
          ? 255
          : 1
  const conv = (v: number): number => {
    const x = image.sampleType === 'u8' ? v : v * scale
    return x < 0 ? 0 : x > 255 ? 255 : Math.round(x)
  }
  for (let i = 0; i < pixels; i++) {
    const s = i * spp
    const d = i * 4
    if (image.colorModel === 'indexed' && palette) {
      const idx = data[s] * 3
      out[d] = palette[idx] ?? 0
      out[d + 1] = palette[idx + 1] ?? 0
      out[d + 2] = palette[idx + 2] ?? 0
    } else if (colorChannels === 1) {
      const g = conv(data[s])
      out[d] = g
      out[d + 1] = g
      out[d + 2] = g
    } else if (image.colorModel === 'cmyk') {
      // Naive conversion, documented as such (spec 05 §5.3): no profile means no maths.
      const c = conv(data[s]) / 255
      const m = conv(data[s + 1]) / 255
      const yy = conv(data[s + 2]) / 255
      const k = conv(data[s + 3]) / 255
      out[d] = Math.round(255 * (1 - Math.min(1, c + k)))
      out[d + 1] = Math.round(255 * (1 - Math.min(1, m + k)))
      out[d + 2] = Math.round(255 * (1 - Math.min(1, yy + k)))
    } else {
      out[d] = conv(data[s])
      out[d + 1] = conv(data[s + 1])
      out[d + 2] = conv(data[s + 2])
    }
    if (alpha !== 'none') {
      const a = conv(data[s + colorChannels])
      if (alpha === 'associated' && a > 0) {
        // Un-associate so downstream 8-bit compositing does not darken the edges.
        const f = 255 / a
        out[d] = Math.min(255, Math.round(out[d] * f))
        out[d + 1] = Math.min(255, Math.round(out[d + 1] * f))
        out[d + 2] = Math.min(255, Math.round(out[d + 2] * f))
      }
      out[d + 3] = a
    } else {
      out[d + 3] = 255
    }
  }
  return out
}

export { BI_BITFIELDS, BI_RGB, BI_RLE4, BI_RLE8 }
