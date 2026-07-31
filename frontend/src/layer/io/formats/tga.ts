// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Truevision TGA decoder and encoder (spec 05 §3.3).
//
// The two real-world traps, both documented by GIMP's plug-in
// (plug-ins/common/file-tga.c, around the header sanity checks): `alphaBits === bpp` is
// invalid and must be forced to 0, and `alphaBits === 4` on a 32-bit RGB image must be
// treated as 8. RLE packets are also allowed to run ACROSS row boundaries, which a
// per-row decoder gets wrong.
//
// GIMP is Copyright (C) 1995-2025 Spencer Kimball, Peter Mattis and the GIMP developers,
// GPL-3.0-or-later; Kubuno is AGPL-3.0-or-later, which is compatible. Reimplemented in
// TypeScript; no code was copied.

import { EMPTY_METADATA } from '../metadata/types'
import { toRgba8 } from './bmp'
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
  type RasterImage,
} from './types'

const IMAGE_TYPE = {
  None: 0,
  ColorMapped: 1,
  TrueColor: 2,
  Grayscale: 3,
  ColorMappedRle: 9,
  TrueColorRle: 10,
  GrayscaleRle: 11,
} as const

interface TgaHeader {
  idLength: number
  colorMapType: number
  imageType: number
  colorMapFirst: number
  colorMapLength: number
  colorMapEntrySize: number
  width: number
  height: number
  bpp: number
  alphaBits: number
  /** Bit 5 of the image descriptor: rows are stored top-down. */
  topDown: boolean
  /** Bit 4: columns are stored right-to-left. */
  rightToLeft: boolean
}

function readHeader(r: ByteReader): TgaHeader {
  r.offset = 0
  const idLength = r.u8()
  const colorMapType = r.u8()
  const imageType = r.u8()
  const colorMapFirst = r.u16()
  const colorMapLength = r.u16()
  const colorMapEntrySize = r.u8()
  r.u16() // x origin
  r.u16() // y origin
  const width = r.u16()
  const height = r.u16()
  const bpp = r.u8()
  const descriptor = r.u8()

  let alphaBits = descriptor & 0x0f
  // GIMP's sanity fixes: an alpha width equal to the pixel width is meaningless, and 4
  // alpha bits on a 32-bit true-colour image really means 8.
  if (alphaBits === bpp) alphaBits = 0
  if (alphaBits === 4 && bpp === 32) alphaBits = 8

  return {
    idLength,
    colorMapType,
    imageType,
    colorMapFirst,
    colorMapLength,
    colorMapEntrySize,
    width,
    height,
    bpp,
    alphaBits,
    topDown: (descriptor & 0x20) !== 0,
    rightToLeft: (descriptor & 0x10) !== 0,
  }
}

export function decodeTga(bytes: Uint8Array): DecodedFile {
  const sink = new WarningSink()
  const r = new ByteReader(bytes, true)
  if (bytes.length < 18) throw new IoInvalidError('TGA file too short')
  const h = readHeader(r)
  checkDimensions(h.width, h.height, 'TGA')
  if (![8, 15, 16, 24, 32].includes(h.bpp)) {
    throw new IoUnsupportedError(`TGA at ${h.bpp} bits per pixel`, 'tga.bpp')
  }

  const rle =
    h.imageType === IMAGE_TYPE.ColorMappedRle ||
    h.imageType === IMAGE_TYPE.TrueColorRle ||
    h.imageType === IMAGE_TYPE.GrayscaleRle
  const baseType =
    h.imageType === IMAGE_TYPE.ColorMappedRle
      ? IMAGE_TYPE.ColorMapped
      : h.imageType === IMAGE_TYPE.TrueColorRle
        ? IMAGE_TYPE.TrueColor
        : h.imageType === IMAGE_TYPE.GrayscaleRle
          ? IMAGE_TYPE.Grayscale
          : h.imageType
  if (
    baseType !== IMAGE_TYPE.ColorMapped &&
    baseType !== IMAGE_TYPE.TrueColor &&
    baseType !== IMAGE_TYPE.Grayscale
  ) {
    throw new IoUnsupportedError(`TGA image type ${h.imageType}`, 'tga.image-type')
  }

  let offset = 18 + h.idLength
  let palette: Uint8Array | undefined
  if (h.colorMapType === 1 && h.colorMapLength > 0) {
    const entryBytes = Math.ceil(h.colorMapEntrySize / 8)
    palette = new Uint8Array((h.colorMapFirst + h.colorMapLength) * 3)
    for (let i = 0; i < h.colorMapLength; i++) {
      const o = offset + i * entryBytes
      if (!r.has(o, entryBytes)) break
      const [red, green, blue] = readColor(r.bytes, o, h.colorMapEntrySize)
      const d = (h.colorMapFirst + i) * 3
      palette[d] = red
      palette[d + 1] = green
      palette[d + 2] = blue
    }
    offset += h.colorMapLength * entryBytes
  }

  const bytesPerPixel = Math.ceil(h.bpp / 8)
  const pixelCount = h.width * h.height
  // RLE packets cross row boundaries, so the payload is expanded whole before scattering.
  const raw = rle
    ? expandRle(r.bytes, offset, pixelCount, bytesPerPixel, sink)
    : r.bytes.subarray(offset, Math.min(r.bytes.length, offset + pixelCount * bytesPerPixel))

  const hasAlpha = h.alphaBits > 0
  const indexed = baseType === IMAGE_TYPE.ColorMapped
  const gray = baseType === IMAGE_TYPE.Grayscale
  const colorModel: ColorModel = indexed ? 'indexed' : gray ? 'gray' : 'rgb'
  const colorChannels = indexed || gray ? 1 : 3
  const channels = colorChannels + (hasAlpha && !indexed ? 1 : 0)
  const out = allocU8(pixelCount * channels, 'TGA')

  for (let y = 0; y < h.height; y++) {
    // Bottom-left origin is the TGA convention; bit 5 flips it.
    const dstY = h.topDown ? y : h.height - 1 - y
    for (let x = 0; x < h.width; x++) {
      const srcIndex = (y * h.width + x) * bytesPerPixel
      const dstX = h.rightToLeft ? h.width - 1 - x : x
      const d = (dstY * h.width + dstX) * channels
      if (srcIndex + bytesPerPixel > raw.length) break
      if (indexed || gray) {
        out[d] = raw[srcIndex]
        if (channels === 2) out[d + 1] = raw[srcIndex + 1] ?? 255
      } else {
        const [red, green, blue, a] = readColor(raw, srcIndex, h.bpp)
        out[d] = red
        out[d + 1] = green
        out[d + 2] = blue
        if (channels === 4) out[d + 3] = h.bpp === 32 ? raw[srcIndex + 3] : a
      }
    }
  }

  const alpha: AlphaMode = channels > colorChannels ? 'unassociated' : 'none'
  const image: RasterImage = {
    width: h.width,
    height: h.height,
    colorModel,
    sampleType: 'u8',
    colorChannels,
    alpha,
    data: out,
    palette,
    colorSpace: { kind: 'srgb' },
    metadata: EMPTY_METADATA,
    sourceBitDepth: h.bpp,
  }
  return {
    formatId: 'tga',
    pages: [{ image, role: 'main', index: 0 }],
    metadata: EMPTY_METADATA,
    warnings: sink.warnings,
  }
}

/** Returns R, G, B, A for one stored pixel. 16-bit is ARRRRRGGGGGBBBBB (1 alpha bit). */
function readColor(buf: Uint8Array, offset: number, bits: number): [number, number, number, number] {
  if (bits === 24 || bits === 32) {
    return [buf[offset + 2], buf[offset + 1], buf[offset], bits === 32 ? buf[offset + 3] : 255]
  }
  if (bits === 15 || bits === 16) {
    const v = buf[offset] | (buf[offset + 1] << 8)
    const r5 = (v >> 10) & 0x1f
    const g5 = (v >> 5) & 0x1f
    const b5 = v & 0x1f
    const scale = (c: number): number => (c << 3) | (c >> 2)
    return [scale(r5), scale(g5), scale(b5), bits === 16 && (v & 0x8000) === 0 ? 0 : 255]
  }
  const g = buf[offset]
  return [g, g, g, 255]
}

function expandRle(
  src: Uint8Array,
  offset: number,
  pixelCount: number,
  bytesPerPixel: number,
  sink: WarningSink,
): Uint8Array {
  const out = new Uint8Array(pixelCount * bytesPerPixel)
  let s = offset
  let d = 0
  let guard = 0
  while (d < out.length && s < src.length && guard++ < pixelCount + 65536) {
    const packet = src[s++]
    const count = (packet & 0x7f) + 1
    if ((packet & 0x80) !== 0) {
      if (s + bytesPerPixel > src.length) break
      for (let i = 0; i < count && d < out.length; i++) {
        for (let b = 0; b < bytesPerPixel; b++) out[d + b] = src[s + b]
        d += bytesPerPixel
      }
      s += bytesPerPixel
    } else {
      const bytes = count * bytesPerPixel
      const usable = Math.min(bytes, src.length - s, out.length - d)
      out.set(src.subarray(s, s + usable), d)
      d += usable
      s += bytes
      if (usable < bytes) break
    }
  }
  if (d < out.length) sink.warn(ioWarn('tga.rle-truncated', { got: d, want: out.length }, 'info'))
  return out
}

// ---------------------------------------------------------------------------
// Encoder
// ---------------------------------------------------------------------------

export interface TgaEncodeOptions {
  readonly rle?: boolean
  /** TGA's own convention is bottom-left; some pipelines want top-left. */
  readonly origin?: 'bottom-left' | 'top-left'
}

export function encodeTga(image: RasterImage, opts: TgaEncodeOptions = {}): Uint8Array {
  const { width, height } = image
  checkDimensions(width, height, 'TGA')
  // Re-uses the BMP flattener so the codebase has a single RGBA conversion policy.
  const rgba = toRgba8(image)
  const hasAlpha = image.alpha !== 'none'
  const bytesPerPixel = hasAlpha ? 4 : 3
  const topDown = opts.origin === 'top-left'

  const rows: Uint8Array[] = []
  for (let y = 0; y < height; y++) {
    const srcY = topDown ? y : height - 1 - y
    const row = new Uint8Array(width * bytesPerPixel)
    for (let x = 0; x < width; x++) {
      const s = (srcY * width + x) * 4
      row[x * bytesPerPixel] = rgba[s + 2]
      row[x * bytesPerPixel + 1] = rgba[s + 1]
      row[x * bytesPerPixel + 2] = rgba[s]
      if (hasAlpha) row[x * bytesPerPixel + 3] = rgba[s + 3]
    }
    rows.push(opts.rle ? encodeRleRow(row, bytesPerPixel) : row)
  }

  const body = rows.reduce((n, r) => n + r.length, 0)
  const out = new Uint8Array(18 + body)
  out[2] = opts.rle ? IMAGE_TYPE.TrueColorRle : IMAGE_TYPE.TrueColor
  const v = new DataView(out.buffer)
  v.setUint16(12, width, true)
  v.setUint16(14, height, true)
  out[16] = bytesPerPixel * 8
  out[17] = (hasAlpha ? 8 : 0) | (topDown ? 0x20 : 0)
  let p = 18
  for (const row of rows) {
    out.set(row, p)
    p += row.length
  }
  return out
}

/** Per-row RLE. Runs are not allowed to cross rows here, which stays legal and simpler. */
function encodeRleRow(row: Uint8Array, bpp: number): Uint8Array {
  const out: number[] = []
  const pixels = row.length / bpp
  let i = 0
  const samePixel = (a: number, b: number): boolean => {
    for (let k = 0; k < bpp; k++) if (row[a * bpp + k] !== row[b * bpp + k]) return false
    return true
  }
  while (i < pixels) {
    let run = 1
    while (i + run < pixels && run < 128 && samePixel(i, i + run)) run++
    if (run >= 2) {
      out.push(0x80 | (run - 1))
      for (let k = 0; k < bpp; k++) out.push(row[i * bpp + k])
      i += run
      continue
    }
    let lit = 1
    while (i + lit < pixels && lit < 128 && !samePixel(i + lit - 1, i + lit)) lit++
    out.push(lit - 1)
    for (let n = 0; n < lit; n++) {
      for (let k = 0; k < bpp; k++) out.push(row[(i + n) * bpp + k])
    }
    i += lit
  }
  return new Uint8Array(out)
}
