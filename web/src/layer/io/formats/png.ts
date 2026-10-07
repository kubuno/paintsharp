// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PNG decoder and encoder (spec 05 §3.3).
//
// Decoding is in-house whenever the browser would lose something — which is exactly the
// 16-bit case: Chrome decodes 16-bit PNG internally but the canvas truncates it to 8
// (measured, spec 05 §2.4), and scanners, medical imaging and 3D renders produce 16-bit
// PNG routinely. It is also needed unconditionally by the ICO decoder, whose Vista-era
// entries embed whole PNG streams.
//
// Encoding is ALWAYS in-house: the native encoder offers no 16-bit, no palette, no
// interlacing, no compression level and no metadata chunks (`quality` is ignored
// outright, measured §2.2).
//
// The per-row filter heuristic and the output-format mapping follow GIMP's PNG plug-in
// (plug-ins/common/file-png.c). GIMP is Copyright (C) 1995-2025 Spencer Kimball, Peter
// Mattis and the GIMP developers, GPL-3.0-or-later; Kubuno is AGPL-3.0-or-later, which is
// compatible. Reimplemented in TypeScript; no code was copied.

import { finishMetadata, type MutableImageMetadata } from '../metadata/types'
import { parseExif } from '../metadata/exif'
import { parseIcc } from '../metadata/icc'
import { parseXmp } from '../metadata/xmp'
import { deflate, inflate } from './codecs/deflate'
import { allocU16, allocU8, checkDimensions } from './limits'
import { matchBytes } from './reader'
import {
  IoInvalidError,
  IoUnsupportedError,
  WarningSink,
  ioWarn,
  type AlphaMode,
  type ColorModel,
  type DecodedFile,
  type RasterImage,
  type SampleArray,
} from './types'

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

const COLOR_TYPE = {
  Gray: 0,
  Rgb: 2,
  Palette: 3,
  GrayAlpha: 4,
  Rgba: 6,
} as const

interface Chunk {
  readonly type: string
  readonly data: Uint8Array
}

interface Ihdr {
  readonly width: number
  readonly height: number
  readonly bitDepth: number
  readonly colorType: number
  readonly interlace: number
}

/** Channel count for a PNG colour type. */
function channelsOfColorType(colorType: number): number {
  switch (colorType) {
    case COLOR_TYPE.Gray:
    case COLOR_TYPE.Palette:
      return 1
    case COLOR_TYPE.GrayAlpha:
      return 2
    case COLOR_TYPE.Rgb:
      return 3
    case COLOR_TYPE.Rgba:
      return 4
    default:
      throw new IoUnsupportedError(`PNG colour type ${colorType}`, 'png.color-type')
  }
}

/** Walks the chunk list without decompressing anything. Bounded and bounds-checked. */
export function readPngChunks(bytes: Uint8Array, stopAtIdat = false): Chunk[] {
  if (!matchBytes(bytes, 0, SIGNATURE)) throw new IoInvalidError('not a PNG file')
  const out: Chunk[] = []
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let p = 8
  let guard = 0
  while (p + 8 <= bytes.length && guard++ < 100_000) {
    const length = view.getUint32(p, false)
    if (length > bytes.length) break
    const type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7])
    const start = p + 8
    if (start + length + 4 > bytes.length) {
      // Truncated final chunk: keep what is readable rather than failing outright.
      if (start < bytes.length) out.push({ type, data: bytes.subarray(start, bytes.length) })
      break
    }
    out.push({ type, data: bytes.subarray(start, start + length) })
    if (type === 'IEND') break
    if (stopAtIdat && type === 'IDAT') break
    p = start + length + 4
  }
  return out
}

function readIhdr(chunks: readonly Chunk[]): Ihdr {
  const ihdr = chunks.find((c) => c.type === 'IHDR')
  if (!ihdr || ihdr.data.length < 13) throw new IoInvalidError('PNG without a valid IHDR')
  const v = new DataView(ihdr.data.buffer, ihdr.data.byteOffset, ihdr.data.byteLength)
  const header: Ihdr = {
    width: v.getUint32(0, false),
    height: v.getUint32(4, false),
    bitDepth: ihdr.data[8],
    colorType: ihdr.data[9],
    interlace: ihdr.data[12],
  }
  checkDimensions(header.width, header.height, 'PNG')
  if (![1, 2, 4, 8, 16].includes(header.bitDepth)) {
    throw new IoInvalidError(`PNG bit depth ${header.bitDepth}`)
  }
  if (ihdr.data[10] !== 0) throw new IoUnsupportedError('unknown PNG compression method', 'png.compression')
  if (ihdr.data[11] !== 0) throw new IoUnsupportedError('unknown PNG filter method', 'png.filter')
  return header
}

/** Header-only probe: decides native vs in-house without touching a pixel. */
export function probePng(bytes: Uint8Array): {
  width: number
  height: number
  bitDepth: number
  colorType: number
  hasIcc: boolean
  hasExif: boolean
  interlaced: boolean
  nativeDecodeSufficient: boolean
} {
  const chunks = readPngChunks(bytes, true)
  const ihdr = readIhdr(chunks)
  const hasIcc = chunks.some((c) => c.type === 'iCCP')
  const hasExif = chunks.some((c) => c.type === 'eXIf')
  const animated = chunks.some((c) => c.type === 'acTL')
  return {
    width: ihdr.width,
    height: ihdr.height,
    bitDepth: ihdr.bitDepth,
    colorType: ihdr.colorType,
    hasIcc,
    hasExif,
    interlaced: ihdr.interlace !== 0,
    // Native decoding is only safe when nothing would be silently lost.
    nativeDecodeSufficient: ihdr.bitDepth <= 8 && !hasIcc && !hasExif && !animated,
  }
}

export async function decodePng(bytes: Uint8Array): Promise<DecodedFile> {
  const sink = new WarningSink()
  const chunks = readPngChunks(bytes)
  const ihdr = readIhdr(chunks)
  if (chunks.some((c) => c.type === 'acTL')) {
    sink.warn(ioWarn('png.apng-first-frame-only', undefined, 'info'))
  }

  const idat = concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data))
  if (idat.length === 0) throw new IoInvalidError('PNG has no IDAT data')

  const channels = channelsOfColorType(ihdr.colorType)
  const bytesPerPixel = Math.ceil((channels * ihdr.bitDepth) / 8)
  const expected =
    ihdr.interlace === 0
      ? (Math.ceil((ihdr.width * channels * ihdr.bitDepth) / 8) + 1) * ihdr.height
      : adam7ExpectedBytes(ihdr, channels)

  const raw = await inflate(idat, 'deflate', expected)

  const samples =
    ihdr.interlace === 0
      ? decodeNonInterlaced(raw, ihdr, channels, bytesPerPixel)
      : decodeAdam7(raw, ihdr, channels, bytesPerPixel)

  // Palette and transparency.
  let palette: Uint8Array | undefined
  let colorModel: ColorModel = ihdr.colorType === COLOR_TYPE.Palette ? 'indexed' : channels >= 3 ? 'rgb' : 'gray'
  let alpha: AlphaMode = channels === 2 || channels === 4 ? 'unassociated' : 'none'
  let data: SampleArray = samples
  let outChannels = channels

  const plte = chunks.find((c) => c.type === 'PLTE')
  const trns = chunks.find((c) => c.type === 'tRNS')
  if (ihdr.colorType === COLOR_TYPE.Palette) {
    if (!plte) throw new IoInvalidError('indexed PNG without PLTE')
    palette = plte.data.slice()
    if (trns) {
      // Palette transparency cannot be expressed by an index alone: expand to RGBA so no
      // information is lost, and say so.
      const expanded = expandPaletteWithAlpha(samples as Uint8Array, palette, trns.data)
      data = expanded
      outChannels = 4
      colorModel = 'rgb'
      alpha = 'unassociated'
      palette = undefined
      sink.warn(ioWarn('png.palette-expanded-for-trns', undefined, 'info'))
    }
  }

  const metadata = readPngMetadata(chunks, sink)
  const phys = chunks.find((c) => c.type === 'pHYs')
  let resolution: RasterImage['resolution']
  if (phys && phys.data.length >= 9) {
    const v = new DataView(phys.data.buffer, phys.data.byteOffset, phys.data.byteLength)
    const unit = phys.data[8]
    resolution =
      unit === 1
        ? { x: v.getUint32(0, false) / 100, y: v.getUint32(4, false) / 100, unit: 'cm' }
        : { x: v.getUint32(0, false), y: v.getUint32(4, false), unit: 'none' }
  }

  const image: RasterImage = {
    width: ihdr.width,
    height: ihdr.height,
    colorModel,
    sampleType: ihdr.bitDepth === 16 ? 'u16' : 'u8',
    colorChannels: colorModel === 'indexed' ? 1 : colorModel === 'gray' ? 1 : 3,
    alpha,
    data,
    palette,
    colorSpace: metadata.icc ? { kind: 'icc', profile: metadata.icc } : { kind: 'srgb' },
    metadata,
    resolution,
    orientation: 1,
    sourceBitDepth: ihdr.bitDepth,
  }
  void outChannels
  return {
    formatId: 'png',
    pages: [{ image, role: 'main', index: 0 }],
    metadata,
    warnings: sink.warnings,
  }
}

function readPngMetadata(chunks: readonly Chunk[], sink: WarningSink): ReturnType<typeof finishMetadata> {
  const m: MutableImageMetadata = {}
  const text = new Map<string, string>()
  for (const c of chunks) {
    try {
      if (c.type === 'iCCP') {
        // Null-terminated name, one compression byte, then a zlib stream. Parsing it needs
        // async inflate; the raw chunk is kept so nothing is lost, and the profile is
        // resolved by `decodePngIccProfile` when the caller wants it.
        m.opaque = m.opaque ?? new Map()
        m.opaque.set('png:iCCP', c.data.slice())
      } else if (c.type === 'eXIf') {
        m.exif = parseExif(c.data) ?? undefined
      } else if (c.type === 'tEXt') {
        const [k, v] = splitNul(c.data)
        if (k) text.set(k, v)
        if (k === 'XML:com.adobe.xmp') m.xmp = parseXmp(new TextEncoder().encode(v)) ?? undefined
      } else if (c.type === 'iTXt') {
        const parsed = parseITxt(c.data)
        if (parsed) {
          text.set(parsed.key, parsed.value)
          if (parsed.key === 'XML:com.adobe.xmp') {
            m.xmp = parseXmp(new TextEncoder().encode(parsed.value)) ?? undefined
          }
        }
      }
    } catch {
      sink.warn(ioWarn('png.chunk-unreadable', { chunk: c.type }, 'info'))
    }
  }
  if (text.size > 0) m.text = text
  return finishMetadata(m)
}

/** Decompresses the `iCCP` chunk kept in `metadata.opaque` and parses the profile. */
export async function decodePngIccProfile(chunk: Uint8Array): ReturnType<typeof parseIccAsync> {
  return parseIccAsync(chunk)
}

async function parseIccAsync(chunk: Uint8Array): Promise<ReturnType<typeof parseIcc>> {
  let p = 0
  while (p < chunk.length && chunk[p] !== 0 && p < 80) p++
  if (p + 2 > chunk.length) return null
  const compression = chunk[p + 1]
  if (compression !== 0) return null
  const raw = await inflate(chunk.subarray(p + 2), 'deflate')
  return parseIcc(raw)
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

function unfilterRow(
  filter: number,
  row: Uint8Array,
  prev: Uint8Array | null,
  bytesPerPixel: number,
): void {
  const n = row.length
  switch (filter) {
    case 0:
      return
    case 1:
      for (let i = bytesPerPixel; i < n; i++) row[i] = (row[i] + row[i - bytesPerPixel]) & 0xff
      return
    case 2:
      if (prev) for (let i = 0; i < n; i++) row[i] = (row[i] + prev[i]) & 0xff
      return
    case 3:
      for (let i = 0; i < n; i++) {
        const left = i >= bytesPerPixel ? row[i - bytesPerPixel] : 0
        const up = prev ? prev[i] : 0
        row[i] = (row[i] + ((left + up) >> 1)) & 0xff
      }
      return
    case 4:
      for (let i = 0; i < n; i++) {
        const a = i >= bytesPerPixel ? row[i - bytesPerPixel] : 0
        const b = prev ? prev[i] : 0
        const c = prev && i >= bytesPerPixel ? prev[i - bytesPerPixel] : 0
        row[i] = (row[i] + paeth(a, b, c)) & 0xff
      }
      return
    default:
      throw new IoInvalidError(`unknown PNG filter type ${filter}`)
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

function decodeNonInterlaced(
  raw: Uint8Array,
  ihdr: Ihdr,
  channels: number,
  bytesPerPixel: number,
): SampleArray {
  const rowBytes = Math.ceil((ihdr.width * channels * ihdr.bitDepth) / 8)
  const out = makeSampleArray(ihdr, channels)
  let prev: Uint8Array | null = null
  const row = new Uint8Array(rowBytes)
  for (let y = 0; y < ihdr.height; y++) {
    const start = y * (rowBytes + 1)
    if (start + 1 + rowBytes > raw.length) break // truncated: keep what decoded
    row.set(raw.subarray(start + 1, start + 1 + rowBytes))
    unfilterRow(raw[start], row, prev, bytesPerPixel)
    writeRow(out, row, y * ihdr.width * channels, ihdr.width * channels, ihdr.bitDepth)
    prev = prev ? prev : new Uint8Array(rowBytes)
    prev.set(row)
  }
  return out
}

const ADAM7 = [
  { xStart: 0, yStart: 0, xStep: 8, yStep: 8 },
  { xStart: 4, yStart: 0, xStep: 8, yStep: 8 },
  { xStart: 0, yStart: 4, xStep: 4, yStep: 8 },
  { xStart: 2, yStart: 0, xStep: 4, yStep: 4 },
  { xStart: 0, yStart: 2, xStep: 2, yStep: 4 },
  { xStart: 1, yStart: 0, xStep: 2, yStep: 2 },
  { xStart: 0, yStart: 1, xStep: 1, yStep: 2 },
]

function adam7ExpectedBytes(ihdr: Ihdr, channels: number): number {
  let total = 0
  for (const pass of ADAM7) {
    const w = Math.ceil((ihdr.width - pass.xStart) / pass.xStep)
    const h = Math.ceil((ihdr.height - pass.yStart) / pass.yStep)
    if (w <= 0 || h <= 0) continue
    total += (Math.ceil((w * channels * ihdr.bitDepth) / 8) + 1) * h
  }
  return total
}

function decodeAdam7(raw: Uint8Array, ihdr: Ihdr, channels: number, bytesPerPixel: number): SampleArray {
  const out = makeSampleArray(ihdr, channels)
  let offset = 0
  for (const pass of ADAM7) {
    const w = Math.ceil((ihdr.width - pass.xStart) / pass.xStep)
    const h = Math.ceil((ihdr.height - pass.yStart) / pass.yStep)
    if (w <= 0 || h <= 0) continue
    const rowBytes = Math.ceil((w * channels * ihdr.bitDepth) / 8)
    const passRow = new Uint8Array(w * channels * (ihdr.bitDepth === 16 ? 2 : 1))
    const scratch = makePassArray(ihdr, w * channels)
    let prev: Uint8Array | null = null
    const row = new Uint8Array(rowBytes)
    for (let y = 0; y < h; y++) {
      if (offset + 1 + rowBytes > raw.length) return out
      row.set(raw.subarray(offset + 1, offset + 1 + rowBytes))
      unfilterRow(raw[offset], row, prev, bytesPerPixel)
      offset += rowBytes + 1
      writeRow(scratch, row, 0, w * channels, ihdr.bitDepth)
      // Scatter this pass row into the full image.
      const dstY = pass.yStart + y * pass.yStep
      for (let x = 0; x < w; x++) {
        const dstX = pass.xStart + x * pass.xStep
        if (dstX >= ihdr.width || dstY >= ihdr.height) continue
        const d = (dstY * ihdr.width + dstX) * channels
        for (let c = 0; c < channels; c++) out[d + c] = scratch[x * channels + c]
      }
      prev = prev ? prev : new Uint8Array(rowBytes)
      prev.set(row)
    }
    void passRow
  }
  return out
}

function makeSampleArray(ihdr: Ihdr, channels: number): SampleArray {
  const count = ihdr.width * ihdr.height * channels
  return ihdr.bitDepth === 16 ? allocU16(count, 'PNG') : allocU8(count, 'PNG')
}

function makePassArray(ihdr: Ihdr, count: number): SampleArray {
  return ihdr.bitDepth === 16 ? new Uint16Array(count) : new Uint8Array(count)
}

/** Expands one unfiltered row into the sample array, honouring the bit depth. */
function writeRow(out: SampleArray, row: Uint8Array, dst: number, samples: number, bitDepth: number): void {
  if (bitDepth === 8) {
    for (let i = 0; i < samples && i < row.length; i++) out[dst + i] = row[i]
    return
  }
  if (bitDepth === 16) {
    // PNG stores 16-bit samples big-endian.
    for (let i = 0; i < samples && i * 2 + 1 < row.length; i++) {
      out[dst + i] = (row[i * 2] << 8) | row[i * 2 + 1]
    }
    return
  }
  // 1/2/4 bits: MSB-first, rows padded to a byte. Sub-byte greyscale is scaled to 0..255;
  // palette indices must stay raw, and PNG palettes are always colour type 3, whose
  // samples this function receives untouched — hence no scaling here, the caller decides.
  const max = (1 << bitDepth) - 1
  for (let i = 0; i < samples; i++) {
    const bitPos = i * bitDepth
    const byteIndex = bitPos >> 3
    if (byteIndex >= row.length) return
    const shift = 8 - bitDepth - (bitPos & 7)
    out[dst + i] = (row[byteIndex] >> shift) & max
  }
}

function expandPaletteWithAlpha(indices: Uint8Array, palette: Uint8Array, trns: Uint8Array): Uint8Array {
  const out = new Uint8Array(indices.length * 4)
  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i]
    out[i * 4] = palette[idx * 3] ?? 0
    out[i * 4 + 1] = palette[idx * 3 + 1] ?? 0
    out[i * 4 + 2] = palette[idx * 3 + 2] ?? 0
    out[i * 4 + 3] = idx < trns.length ? trns[idx] : 255
  }
  return out
}

// ---------------------------------------------------------------------------
// Encoder
// ---------------------------------------------------------------------------

export interface PngEncodeOptions {
  /** 8 or 16. 16-bit output is the whole reason this encoder exists. */
  readonly bitDepth?: 8 | 16
  /** 'fast' writes filter 0 everywhere; 'optimal' picks per row (libpng's heuristic). */
  readonly filterStrategy?: 'fast' | 'optimal'
  /** Raw ICC bytes to embed in an `iCCP` chunk. */
  readonly iccProfile?: Uint8Array
  /** EXIF block for the `eXIf` chunk (already serialised, without the `Exif\0\0` prefix). */
  readonly exif?: Uint8Array
  /** XMP packet, written as an `iTXt` chunk. */
  readonly xmp?: Uint8Array
  readonly text?: ReadonlyMap<string, string>
  /** Pixels per metre, written as `pHYs`. */
  readonly pixelsPerMeter?: { x: number; y: number }
}

/**
 * Writes a PNG. `image` must already be in the target colour model — the encoder only
 * does binary formatting, never colour maths (spec 05 §5.2).
 */
export async function encodePng(image: RasterImage, opts: PngEncodeOptions = {}): Promise<Uint8Array> {
  const { width, height } = image
  checkDimensions(width, height, 'PNG')
  const bitDepth = opts.bitDepth ?? (image.sampleType === 'u16' ? 16 : 8)
  const hasAlpha = image.alpha !== 'none'
  const gray = image.colorModel === 'gray'
  const colorType = gray
    ? hasAlpha
      ? COLOR_TYPE.GrayAlpha
      : COLOR_TYPE.Gray
    : hasAlpha
      ? COLOR_TYPE.Rgba
      : COLOR_TYPE.Rgb
  const channels = channelsOfColorType(colorType)

  const raw = buildRawScanlines(image, width, height, channels, bitDepth, opts.filterStrategy ?? 'optimal')
  const compressed = await deflate(raw, 'deflate')

  const chunks: Uint8Array[] = []
  const ihdr = new Uint8Array(13)
  const iv = new DataView(ihdr.buffer)
  iv.setUint32(0, width, false)
  iv.setUint32(4, height, false)
  ihdr[8] = bitDepth
  ihdr[9] = colorType
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  chunks.push(makeChunk('IHDR', ihdr))

  if (opts.iccProfile && opts.iccProfile.length > 0) {
    const name = 'ICC profile'
    const compressedProfile = await deflate(opts.iccProfile, 'deflate')
    const payload = new Uint8Array(name.length + 2 + compressedProfile.length)
    for (let i = 0; i < name.length; i++) payload[i] = name.charCodeAt(i)
    payload[name.length] = 0
    payload[name.length + 1] = 0
    payload.set(compressedProfile, name.length + 2)
    chunks.push(makeChunk('iCCP', payload))
  }
  if (opts.pixelsPerMeter) {
    const phys = new Uint8Array(9)
    const pv = new DataView(phys.buffer)
    pv.setUint32(0, Math.round(opts.pixelsPerMeter.x), false)
    pv.setUint32(4, Math.round(opts.pixelsPerMeter.y), false)
    phys[8] = 1
    chunks.push(makeChunk('pHYs', phys))
  }
  for (const [k, v] of opts.text ?? []) {
    chunks.push(makeChunk('tEXt', textChunk(k, v)))
  }
  if (opts.xmp) {
    chunks.push(makeChunk('iTXt', iTxtChunk('XML:com.adobe.xmp', opts.xmp)))
  }
  chunks.push(makeChunk('IDAT', compressed))
  // eXIf goes after IDAT so viewers that stop at the image data still work.
  if (opts.exif && opts.exif.length > 0) chunks.push(makeChunk('eXIf', opts.exif))
  chunks.push(makeChunk('IEND', new Uint8Array(0)))

  const total = 8 + chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  out.set(SIGNATURE, 0)
  let p = 8
  for (const c of chunks) {
    out.set(c, p)
    p += c.length
  }
  return out
}

function buildRawScanlines(
  image: RasterImage,
  width: number,
  height: number,
  channels: number,
  bitDepth: number,
  strategy: 'fast' | 'optimal',
): Uint8Array {
  const bytesPerSample = bitDepth === 16 ? 2 : 1
  const rowBytes = width * channels * bytesPerSample
  const bytesPerPixel = channels * bytesPerSample
  const out = new Uint8Array((rowBytes + 1) * height)
  const srcSpp = image.data.length / (width * height)
  const row = new Uint8Array(rowBytes)
  let prev = new Uint8Array(rowBytes)

  const maxIn = image.sampleType === 'u16' ? 65535 : 255
  const maxOut = bitDepth === 16 ? 65535 : 255

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * srcSpp
      for (let c = 0; c < channels; c++) {
        let v = Number(image.data[s + c] ?? 0)
        if (image.sampleType === 'f32') v = Math.max(0, Math.min(1, v)) * maxOut
        else if (maxIn !== maxOut) v = (v * maxOut) / maxIn
        const rounded = Math.max(0, Math.min(maxOut, Math.round(v)))
        if (bitDepth === 16) {
          row[(x * channels + c) * 2] = (rounded >> 8) & 0xff
          row[(x * channels + c) * 2 + 1] = rounded & 0xff
        } else {
          row[x * channels + c] = rounded
        }
      }
    }
    const dst = y * (rowBytes + 1)
    if (strategy === 'fast') {
      out[dst] = 0
      out.set(row, dst + 1)
    } else {
      const best = chooseFilter(row, prev, bytesPerPixel)
      out[dst] = best.filter
      out.set(best.data, dst + 1)
    }
    prev = prev.length === rowBytes ? prev : new Uint8Array(rowBytes)
    prev.set(row)
  }
  return out
}

/** libpng's heuristic: pick the filter minimising the sum of absolute (signed) values. */
function chooseFilter(
  row: Uint8Array,
  prev: Uint8Array,
  bpp: number,
): { filter: number; data: Uint8Array } {
  let best = { filter: 0, data: row.slice(), score: sumAbs(row) }
  for (let filter = 1; filter <= 4; filter++) {
    const candidate = new Uint8Array(row.length)
    for (let i = 0; i < row.length; i++) {
      const a = i >= bpp ? row[i - bpp] : 0
      const b = prev[i]
      const c = i >= bpp ? prev[i - bpp] : 0
      let predictor = 0
      if (filter === 1) predictor = a
      else if (filter === 2) predictor = b
      else if (filter === 3) predictor = (a + b) >> 1
      else predictor = paeth(a, b, c)
      candidate[i] = (row[i] - predictor) & 0xff
    }
    const score = sumAbs(candidate)
    if (score < best.score) best = { filter, data: candidate, score }
  }
  return best
}

function sumAbs(data: Uint8Array): number {
  let s = 0
  for (let i = 0; i < data.length; i++) {
    const v = data[i]
    s += v < 128 ? v : 256 - v
  }
  return s
}

function makeChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const v = new DataView(out.buffer)
  v.setUint32(0, data.length, false)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)), false)
  return out
}

function textChunk(key: string, value: string): Uint8Array {
  const out = new Uint8Array(key.length + 1 + value.length)
  for (let i = 0; i < key.length; i++) out[i] = key.charCodeAt(i) & 0xff
  out[key.length] = 0
  for (let i = 0; i < value.length; i++) out[key.length + 1 + i] = value.charCodeAt(i) & 0xff
  return out
}

function iTxtChunk(key: string, utf8Value: Uint8Array): Uint8Array {
  // keyword \0 compressionFlag compressionMethod languageTag \0 translatedKeyword \0 text
  const out = new Uint8Array(key.length + 5 + utf8Value.length)
  let p = 0
  for (let i = 0; i < key.length; i++) out[p++] = key.charCodeAt(i) & 0xff
  out[p++] = 0
  out[p++] = 0 // uncompressed
  out[p++] = 0
  out[p++] = 0 // empty language tag
  out[p++] = 0 // empty translated keyword
  out.set(utf8Value, p)
  return out
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let p = 0
  for (const part of parts) {
    out.set(part, p)
    p += part.length
  }
  return out
}

function splitNul(data: Uint8Array): [string, string] {
  let i = 0
  while (i < data.length && data[i] !== 0) i++
  let key = ''
  for (let k = 0; k < i; k++) key += String.fromCharCode(data[k])
  let value = ''
  for (let k = i + 1; k < data.length; k++) value += String.fromCharCode(data[k])
  return [key, value]
}

function parseITxt(data: Uint8Array): { key: string; value: string } | null {
  let i = 0
  while (i < data.length && data[i] !== 0) i++
  if (i + 2 >= data.length) return null
  let key = ''
  for (let k = 0; k < i; k++) key += String.fromCharCode(data[k])
  const compressed = data[i + 1]
  if (compressed !== 0) return null // compressed iTXt needs async inflate; skipped
  let p = i + 3
  // Skip the language tag and the translated keyword, both NUL-terminated.
  for (let n = 0; n < 2 && p < data.length; n++) {
    while (p < data.length && data[p] !== 0) p++
    p++
  }
  if (p >= data.length) return null
  return { key, value: new TextDecoder('utf-8', { fatal: false }).decode(data.subarray(p)) }
}
