// SPDX-License-Identifier: AGPL-3.0-or-later
//
// TIFF decoder (spec 05 §4). TIFF is the only format with NO browser support at all
// (measured: `ImageDecoder.isTypeSupported('image/tiff')` === false) and the richest one,
// which is why it is fully in-house.
//
// Strip/tile handling, the missing-PhotometricInterpretation heuristic, the tolerance
// rules for non-conformant files and the ExtraSamples treatment are derived from GIMP's
// TIFF plug-in (plug-ins/file-tiff/file-tiff-load.c). GIMP is Copyright (C) 1995-2025
// Spencer Kimball, Peter Mattis and the GIMP developers, licensed GPL-3.0-or-later.
// Kubuno is AGPL-3.0-or-later, which is compatible with GPL-3.0. Reimplemented in
// TypeScript; no code was copied.

import { finishMetadata, type MutableImageMetadata } from '../../metadata/types'
import { parseExifFromReader } from '../../metadata/exif'
import { parseIcc } from '../../metadata/icc'
import { parseIptc } from '../../metadata/iptc'
import { parseXmp } from '../../metadata/xmp'
import { reverseBits, unpackSubByteSamples } from '../codecs/bits'
import { inflate } from '../codecs/deflate'
import { lzwDecode } from '../codecs/lzw'
import { unpackBits } from '../codecs/packbits'
import { undoFloatingPredictor, undoHorizontalPredictor } from '../codecs/predictor'
import {
  MAX_BLOCKS,
  MAX_PAGES,
  MAX_SAMPLES_PER_PIXEL,
  allocF32,
  allocU16,
  allocU32,
  allocU8,
  checkDimensions,
} from '../limits'
import {
  IoInvalidError,
  IoUnsupportedError,
  WarningSink,
  ioWarn,
  type AlphaMode,
  type ColorModel,
  type ColorSpaceRef,
  type DecodedFile,
  type ExtraChannel,
  type IoWarning,
  type PageRole,
  type RasterImage,
  type RasterPage,
  type SampleArray,
  type SampleType,
} from '../types'
import { IfdReader, readTiffHeader, tagBytes, tagNumber, tagNumbers, tagText, type Ifd } from './ifd'
import { rebuildJpegStream } from './jpegStream'
import {
  COMPRESSION,
  EXTRA_SAMPLE,
  PHOTOMETRIC,
  PLANAR,
  PREDICTOR,
  RESOLUTION_UNIT,
  SAMPLE_FORMAT,
  SUBFILE,
  TIFF_TAG,
  compressionName,
  photometricName,
} from './tags'

/** Decodes a baseline JPEG payload. Supplied by the caller so this file stays DOM-free. */
export type JpegBlockDecoder = (
  jpeg: Uint8Array,
) => Promise<{ width: number; height: number; rgba: Uint8Array }>

export interface TiffDecodeOptions {
  /** Decode only this page; all pages when omitted. */
  readonly pageIndex?: number
  readonly maxPixels?: number
  readonly signal?: AbortSignal
  readonly warn?: (w: IoWarning) => void
  /** Enables compression 7 (JPEG-in-TIFF). Without it those pages are skipped. */
  readonly jpegDecoder?: JpegBlockDecoder
  /** Stop after the headers: pages carry a 0-sample buffer. */
  readonly headerOnly?: boolean
}

/** One compressed block (strip or tile) plus where it lands in the image (spec §4.5). */
interface TiffBlock {
  readonly offset: number
  readonly byteCount: number
  readonly x: number
  readonly y: number
  /** Padded, i.e. as stored. Tiles overflow the image and must be cropped. */
  readonly storedWidth: number
  readonly storedHeight: number
  /** 0 unless PlanarConfiguration === 2. */
  readonly plane: number
}

interface PageFields {
  width: number
  height: number
  bitsPerSample: number
  samplesPerPixel: number
  sampleFormat: number
  compression: number
  photometric: number
  planar: number
  predictor: number
  fillOrder: number
  extraSamples: readonly number[]
  colorMap?: readonly number[]
  orientation?: number
  subfileType: number
}

export async function decodeTiff(
  bytes: Uint8Array,
  opts: TiffDecodeOptions = {},
): Promise<DecodedFile> {
  const sink = new WarningSink()
  const warn = (w: IoWarning): void => {
    sink.warn(w)
    opts.warn?.(w)
  }
  const header = readTiffHeader(bytes)
  const reader = new IfdReader(bytes, header, warn)
  const ifds = reader.readChain(header.firstIfdOffset, MAX_PAGES)
  if (ifds.length === 0) throw new IoInvalidError('TIFF has no readable IFD')

  const fileMetadata = readMetadata(reader, ifds[0], warn)

  const pages: RasterPage[] = []
  const wanted = opts.pageIndex
  for (let i = 0; i < ifds.length; i++) {
    if (wanted !== undefined && wanted !== i) continue
    if (opts.signal?.aborted) throw new IoUnsupportedError('decoding aborted', 'io.aborted')
    try {
      const page = await decodePage(reader, ifds[i], i, opts, warn)
      if (page) pages.push(page)
    } catch (e) {
      warn(ioWarn('tiff.page-failed', { page: i, error: String(e) }))
      // A broken page 3 must not lose pages 1 and 2.
      if (pages.length === 0 && (wanted !== undefined || ifds.length === 1)) throw e
    }
  }
  if (pages.length === 0) throw new IoInvalidError('no decodable page in this TIFF')

  return { formatId: 'tiff', pages, metadata: fileMetadata, warnings: sink.warnings }
}

/** Header-only walk, for the import dialog and the memory budget (spec 05 §8.3). */
export function probeTiffPages(
  bytes: Uint8Array,
): { width: number; height: number; bitDepth: number; pageCount: number; colorModel: ColorModel; samplesPerPixel: number; hasIcc: boolean; hasExif: boolean; orientation: number } {
  const header = readTiffHeader(bytes)
  const reader = new IfdReader(bytes, header)
  const ifds = reader.readChain(header.firstIfdOffset, MAX_PAGES)
  if (ifds.length === 0) throw new IoInvalidError('TIFF has no readable IFD')
  const f = readPageFields(ifds[0])
  return {
    width: f.width,
    height: f.height,
    bitDepth: f.bitsPerSample,
    pageCount: ifds.length,
    colorModel: colorModelOf(f.photometric, f.compression),
    samplesPerPixel: f.samplesPerPixel,
    hasIcc: ifds[0].entries.has(TIFF_TAG.InterColorProfile),
    hasExif: ifds[0].entries.has(TIFF_TAG.ExifIFD),
    orientation: tagNumber(ifds[0], TIFF_TAG.Orientation, 1),
  }
}

// ---------------------------------------------------------------------------

function readPageFields(ifd: Ifd): PageFields {
  const width = tagNumber(ifd, TIFF_TAG.ImageWidth, 0)
  const height = tagNumber(ifd, TIFF_TAG.ImageLength, 0)
  const bps = tagNumbers(ifd, TIFF_TAG.BitsPerSample) ?? [1]
  const spp = tagNumber(ifd, TIFF_TAG.SamplesPerPixel, 1)
  const compression = tagNumber(ifd, TIFF_TAG.Compression, COMPRESSION.None)
  const sampleFormats = tagNumbers(ifd, TIFF_TAG.SampleFormat) ?? [SAMPLE_FORMAT.Uint]

  // A heterogeneous BitsPerSample is legal but vanishingly rare; refusing is honest.
  for (let i = 1; i < Math.min(bps.length, spp); i++) {
    if (bps[i] !== bps[0]) {
      throw new IoUnsupportedError(
        `heterogeneous BitsPerSample (${bps.join(',')}) is not supported`,
        'tiff.heterogeneous-bps',
      )
    }
  }

  // Missing PhotometricInterpretation is a real-world case: GIMP infers MINISWHITE for
  // CCITT compressions and MINISBLACK otherwise (file-tiff-load.c). Same rule here.
  let photometric = tagNumber(ifd, TIFF_TAG.PhotometricInterpretation, -1)
  if (photometric < 0) {
    photometric =
      compression === COMPRESSION.CcittRle ||
      compression === COMPRESSION.CcittG3 ||
      compression === COMPRESSION.CcittG4
        ? PHOTOMETRIC.WhiteIsZero
        : PHOTOMETRIC.BlackIsZero
  }

  return {
    width,
    height,
    bitsPerSample: bps[0] ?? 1,
    samplesPerPixel: spp,
    sampleFormat: sampleFormats[0] ?? SAMPLE_FORMAT.Uint,
    compression,
    photometric,
    planar: tagNumber(ifd, TIFF_TAG.PlanarConfiguration, PLANAR.Chunky),
    predictor: tagNumber(ifd, TIFF_TAG.Predictor, PREDICTOR.None),
    fillOrder: tagNumber(ifd, TIFF_TAG.FillOrder, 1),
    extraSamples: tagNumbers(ifd, TIFF_TAG.ExtraSamples) ?? [],
    colorMap: tagNumbers(ifd, TIFF_TAG.ColorMap),
    orientation: tagNumber(ifd, TIFF_TAG.Orientation, 1),
    subfileType: tagNumber(ifd, TIFF_TAG.NewSubfileType, tagNumber(ifd, TIFF_TAG.SubfileType, 0)),
  }
}

function colorModelOf(photometric: number, compression: number): ColorModel {
  switch (photometric) {
    case PHOTOMETRIC.WhiteIsZero:
    case PHOTOMETRIC.BlackIsZero:
    case PHOTOMETRIC.TransparencyMask:
      return 'gray'
    case PHOTOMETRIC.Rgb:
      return 'rgb'
    case PHOTOMETRIC.Palette:
      return 'indexed'
    case PHOTOMETRIC.Separated:
      return 'cmyk'
    case PHOTOMETRIC.YCbCr:
      // Compression 7 is decoded by the browser, which hands back RGB.
      return compression === COMPRESSION.Jpeg ? 'rgb' : 'ycbcr'
    case PHOTOMETRIC.CieLab:
    case PHOTOMETRIC.IccLab:
    case PHOTOMETRIC.ItuLab:
      return 'lab'
    default:
      return 'gray'
  }
}

function colorChannelsOf(model: ColorModel): number {
  switch (model) {
    case 'gray':
    case 'indexed':
      return 1
    case 'rgb':
    case 'lab':
    case 'ycbcr':
      return 3
    case 'cmyk':
      return 4
  }
}

function roleOf(subfileType: number): PageRole {
  if ((subfileType & SUBFILE.TransparencyMask) !== 0) return 'mask'
  if ((subfileType & SUBFILE.ReducedResolution) !== 0) return 'thumbnail'
  if ((subfileType & SUBFILE.Page) !== 0) return 'page'
  return 'main'
}

function sampleTypeOf(bits: number, format: number): SampleType {
  if (format === SAMPLE_FORMAT.IeeeFloat) {
    if (bits === 16) return 'f32' // half is expanded on the fly
    return 'f32'
  }
  if (bits <= 8) return 'u8'
  if (bits <= 16) return 'u16'
  return 'u32'
}

// ---------------------------------------------------------------------------

async function decodePage(
  reader: IfdReader,
  ifd: Ifd,
  index: number,
  opts: TiffDecodeOptions,
  warn: (w: IoWarning) => void,
): Promise<RasterPage | null> {
  const f = readPageFields(ifd)
  checkDimensions(f.width, f.height, `TIFF page ${index}`)
  if (opts.maxPixels && f.width * f.height > opts.maxPixels) {
    throw new IoUnsupportedError(
      `page ${index} is ${f.width}×${f.height}, above the ${opts.maxPixels}-pixel budget`,
      'tiff.over-budget',
    )
  }
  if (f.samplesPerPixel < 1 || f.samplesPerPixel > MAX_SAMPLES_PER_PIXEL) {
    throw new IoInvalidError(`SamplesPerPixel = ${f.samplesPerPixel}`)
  }
  if (![1, 2, 4, 8, 16, 32, 64].includes(f.bitsPerSample)) {
    throw new IoUnsupportedError(`BitsPerSample = ${f.bitsPerSample}`, 'tiff.bad-bps')
  }

  const model = colorModelOf(f.photometric, f.compression)
  const colorChannels = Math.min(colorChannelsOf(model), f.samplesPerPixel)
  const spp = f.samplesPerPixel

  // ExtraSamples (338): one entry per sample beyond the colour channels.
  let alpha: AlphaMode = 'none'
  const extra: ExtraChannel[] = []
  const extraCount = Math.max(0, spp - colorChannels)
  for (let i = 0; i < extraCount; i++) {
    const kindValue = f.extraSamples[i]
    const channelIndex = colorChannels + i
    if (i === 0) {
      if (kindValue === EXTRA_SAMPLE.AssociatedAlpha) {
        alpha = 'associated'
      } else if (kindValue === EXTRA_SAMPLE.UnassociatedAlpha) {
        alpha = 'unassociated'
      } else {
        // GIMP treats an unspecified extra sample as alpha when the channel count
        // demands it, but says so. Same behaviour, same warning.
        alpha = 'unassociated'
        warn(ioWarn('tiff.extra-sample-assumed-alpha', { page: index, value: kindValue ?? -1 }, 'info'))
      }
      continue
    }
    extra.push({ kind: 'unspecified', channelIndex, name: `extra${i}` })
  }

  const sampleType = sampleTypeOf(f.bitsPerSample, f.sampleFormat)
  const totalSamples = f.width * f.height * spp
  const label = `TIFF page ${index}`

  if (opts.headerOnly) {
    const empty = makeArray(sampleType, 0, label)
    return {
      index,
      role: roleOf(f.subfileType),
      name: tagText(ifd, TIFF_TAG.PageName),
      image: buildImage(reader, ifd, f, model, colorChannels, alpha, extra, sampleType, empty, warn),
    }
  }

  const out = makeArray(sampleType, totalSamples, label)
  const blocks = buildBlocks(ifd, f, warn)

  if (
    f.compression === COMPRESSION.CcittRle ||
    f.compression === COMPRESSION.CcittG3 ||
    f.compression === COMPRESSION.CcittG4
  ) {
    throw new IoUnsupportedError(
      `CCITT compression (${compressionName(f.compression)}) is not implemented yet`,
      'tiff.ccitt-unsupported',
    )
  }
  if (f.compression === COMPRESSION.OldJpeg || f.compression === COMPRESSION.Jpeg2000) {
    throw new IoUnsupportedError(
      `${compressionName(f.compression)} compression is refused`,
      'tiff.compression-refused',
    )
  }
  if (f.compression === COMPRESSION.Jpeg && !opts.jpegDecoder) {
    throw new IoUnsupportedError(
      'JPEG-in-TIFF needs a JPEG decoder (browser only)',
      'tiff.jpeg-decoder-missing',
    )
  }
  if (
    f.photometric === PHOTOMETRIC.YCbCr &&
    f.compression !== COMPRESSION.Jpeg &&
    (tagNumbers(ifd, TIFF_TAG.YCbCrSubSampling) ?? [1, 1]).some((v) => v !== 1)
  ) {
    throw new IoUnsupportedError('subsampled YCbCr without JPEG is not supported', 'tiff.ycbcr-subsampled')
  }

  const jpegTables = tagBytes(ifd, TIFF_TAG.JPEGTables, reader)
  const bytes = reader.bytes
  const chunkyChannels = f.planar === PLANAR.Planar ? 1 : spp

  for (const block of blocks) {
    if (opts.signal?.aborted) throw new IoUnsupportedError('decoding aborted', 'io.aborted')
    if (block.byteCount <= 0) continue
    if (block.offset < 0 || block.offset + block.byteCount > bytes.length) {
      warn(ioWarn('tiff.block-out-of-range', { page: index, offset: block.offset }))
      continue
    }
    const raw = bytes.subarray(block.offset, block.offset + block.byteCount)

    if (f.compression === COMPRESSION.Jpeg) {
      await writeJpegBlock(out, raw, jpegTables, block, f, spp, opts.jpegDecoder!, warn, index)
      continue
    }

    const bytesPerRow = Math.ceil((block.storedWidth * chunkyChannels * f.bitsPerSample) / 8)
    const expected = bytesPerRow * block.storedHeight
    let data: Uint8Array
    try {
      data = await decompressBlock(raw, f.compression, expected)
    } catch (e) {
      warn(ioWarn('tiff.block-decompress-failed', { page: index, error: String(e) }))
      continue
    }
    if (f.fillOrder === 2) reverseBits(data)
    if (data.length < expected) {
      warn(ioWarn('tiff.block-short', { page: index, got: data.length, want: expected }, 'info'))
      const padded = new Uint8Array(expected)
      padded.set(data.subarray(0, Math.min(data.length, expected)))
      data = padded
    }

    applyPredictor(data, f, block, chunkyChannels, reader)
    writeBlock(out, data, block, f, spp, chunkyChannels, sampleType, model, reader.header.littleEndian)
  }

  if (f.photometric === PHOTOMETRIC.WhiteIsZero) invertSamples(out, sampleType, f.bitsPerSample, spp, colorChannels)
  if (f.sampleFormat === SAMPLE_FORMAT.Int) {
    recentreSigned(out, sampleType, f.bitsPerSample)
    warn(ioWarn('tiff.signed-samples-recentred', { page: index }, 'info'))
  }

  return {
    index,
    role: roleOf(f.subfileType),
    name: tagText(ifd, TIFF_TAG.PageName),
    image: buildImage(reader, ifd, f, model, colorChannels, alpha, extra, sampleType, out, warn),
  }
}

function buildImage(
  reader: IfdReader,
  ifd: Ifd,
  f: PageFields,
  model: ColorModel,
  colorChannels: number,
  alpha: AlphaMode,
  extra: readonly ExtraChannel[],
  sampleType: SampleType,
  data: SampleArray,
  warn: (w: IoWarning) => void,
): RasterImage {
  const metadata = readMetadata(reader, ifd, warn)
  const palette = f.colorMap ? paletteFromColorMap(f.colorMap, f.bitsPerSample) : undefined
  const xres = tagNumbers(ifd, TIFF_TAG.XResolution)
  const yres = tagNumbers(ifd, TIFF_TAG.YResolution)
  const unitCode = tagNumber(ifd, TIFF_TAG.ResolutionUnit, RESOLUTION_UNIT.Inch)
  const resolution =
    xres && yres && xres[0] > 0
      ? {
          x: xres[0],
          y: yres[0],
          unit:
            unitCode === RESOLUTION_UNIT.Centimeter
              ? ('cm' as const)
              : unitCode === RESOLUTION_UNIT.None
                ? ('none' as const)
                : ('inch' as const),
        }
      : undefined

  return {
    width: f.width,
    height: f.height,
    colorModel: model,
    sampleType,
    colorChannels,
    alpha,
    data,
    palette,
    extra: extra.length > 0 ? extra : undefined,
    colorSpace: colorSpaceOf(model, f.photometric, metadata),
    metadata,
    resolution,
    orientation: f.orientation,
    sourceBitDepth: f.bitsPerSample,
  }
}

function colorSpaceOf(
  model: ColorModel,
  photometric: number,
  metadata: { icc?: unknown },
): ColorSpaceRef {
  const icc = (metadata as { icc?: import('../../metadata/types').IccProfile }).icc
  if (icc) return { kind: 'icc', profile: icc }
  if (model === 'cmyk') return { kind: 'cmyk' }
  if (model === 'lab') {
    // CIELab is D50 in TIFF; ICCLab likewise.
    return { kind: 'lab', illuminant: photometric === PHOTOMETRIC.ItuLab ? 'D65' : 'D50' }
  }
  return { kind: 'srgb' }
}

function paletteFromColorMap(colorMap: readonly number[], bitsPerSample: number): Uint8Array {
  const entries = 1 << Math.min(bitsPerSample, 16)
  const n = Math.min(entries, Math.floor(colorMap.length / 3))
  const out = new Uint8Array(n * 3)
  for (let i = 0; i < n; i++) {
    // ColorMap components are 0..65535, R plane then G then B.
    out[i * 3] = colorMap[i] >> 8
    out[i * 3 + 1] = colorMap[n + i] >> 8
    out[i * 3 + 2] = colorMap[2 * n + i] >> 8
  }
  return out
}

function readMetadata(
  reader: IfdReader,
  ifd: Ifd,
  warn: (w: IoWarning) => void,
): ReturnType<typeof finishMetadata> {
  const m: MutableImageMetadata = {}
  try {
    const iccBytes = tagBytes(ifd, TIFF_TAG.InterColorProfile, reader)
    if (iccBytes) m.icc = parseIcc(iccBytes) ?? undefined
  } catch (e) {
    warn(ioWarn('tiff.icc-unreadable', { error: String(e) }, 'info'))
  }
  try {
    const xmpBytes = tagBytes(ifd, TIFF_TAG.XMP, reader)
    if (xmpBytes) m.xmp = parseXmp(xmpBytes) ?? undefined
  } catch {
    /* XMP is decorative: never fatal */
  }
  try {
    const iptcBytes = tagBytes(ifd, TIFF_TAG.IPTC, reader)
    if (iptcBytes) m.iptc = parseIptc(iptcBytes) ?? undefined
  } catch {
    /* idem */
  }
  try {
    const exifOffset = tagNumber(ifd, TIFF_TAG.ExifIFD, 0)
    if (exifOffset > 0) m.exif = parseExifFromReader(reader, ifd, exifOffset) ?? undefined
  } catch (e) {
    warn(ioWarn('tiff.exif-unreadable', { error: String(e) }, 'info'))
  }
  // Photoshop layer data: kept verbatim so a light retouch can re-save it (spec §4.9).
  const psd = tagBytes(ifd, TIFF_TAG.ImageSourceData, reader)
  if (psd) {
    m.opaque = m.opaque ?? new Map()
    m.opaque.set('tiff:ImageSourceData', psd)
  }
  const text = new Map<string, string>()
  for (const [tag, key] of [
    [TIFF_TAG.ImageDescription, 'Description'],
    [TIFF_TAG.Make, 'Make'],
    [TIFF_TAG.Model, 'Model'],
    [TIFF_TAG.Software, 'Software'],
    [TIFF_TAG.DateTime, 'DateTime'],
    [TIFF_TAG.Artist, 'Artist'],
    [TIFF_TAG.Copyright, 'Copyright'],
  ] as const) {
    const v = tagText(ifd, tag)
    if (v) text.set(key, v)
  }
  if (text.size > 0) m.text = text
  return finishMetadata(m)
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

function buildBlocks(ifd: Ifd, f: PageFields, warn: (w: IoWarning) => void): TiffBlock[] {
  const tileWidth = tagNumber(ifd, TIFF_TAG.TileWidth, 0)
  const tileLength = tagNumber(ifd, TIFF_TAG.TileLength, 0)
  const tileOffsets = tagNumbers(ifd, TIFF_TAG.TileOffsets)
  const planes = f.planar === PLANAR.Planar ? f.samplesPerPixel : 1
  const blocks: TiffBlock[] = []

  if (tileWidth > 0 && tileLength > 0 && tileOffsets) {
    const tileCounts = tagNumbers(ifd, TIFF_TAG.TileByteCounts) ?? []
    const across = Math.ceil(f.width / tileWidth)
    const down = Math.ceil(f.height / tileLength)
    const perPlane = across * down
    if (perPlane * planes > MAX_BLOCKS) throw new IoInvalidError('too many tiles')
    for (let p = 0; p < planes; p++) {
      for (let ty = 0; ty < down; ty++) {
        for (let tx = 0; tx < across; tx++) {
          const i = p * perPlane + ty * across + tx
          blocks.push({
            offset: tileOffsets[i] ?? -1,
            byteCount: tileCounts[i] ?? 0,
            x: tx * tileWidth,
            y: ty * tileLength,
            storedWidth: tileWidth,
            storedHeight: tileLength,
            plane: p,
          })
        }
      }
    }
    return blocks
  }

  const stripOffsets = tagNumbers(ifd, TIFF_TAG.StripOffsets)
  if (!stripOffsets) throw new IoInvalidError('page has neither StripOffsets nor TileOffsets')
  const stripCounts = tagNumbers(ifd, TIFF_TAG.StripByteCounts) ?? []
  // Absent RowsPerStrip (or 2^32-1) means a single strip covering the whole image.
  let rowsPerStrip = tagNumber(ifd, TIFF_TAG.RowsPerStrip, 0xffffffff)
  if (rowsPerStrip <= 0 || rowsPerStrip > f.height) rowsPerStrip = f.height
  const perPlane = Math.ceil(f.height / rowsPerStrip)
  if (perPlane * planes > MAX_BLOCKS) throw new IoInvalidError('too many strips')
  if (stripOffsets.length < perPlane * planes) {
    warn(ioWarn('tiff.missing-strips', { have: stripOffsets.length, want: perPlane * planes }))
  }
  for (let p = 0; p < planes; p++) {
    for (let s = 0; s < perPlane; s++) {
      const i = p * perPlane + s
      const y = s * rowsPerStrip
      blocks.push({
        offset: stripOffsets[i] ?? -1,
        byteCount: stripCounts[i] ?? 0,
        x: 0,
        y,
        storedWidth: f.width,
        storedHeight: Math.min(rowsPerStrip, f.height - y),
        plane: p,
      })
    }
  }
  return blocks
}

async function decompressBlock(
  raw: Uint8Array,
  compression: number,
  expected: number,
): Promise<Uint8Array> {
  switch (compression) {
    case COMPRESSION.None:
      return raw
    case COMPRESSION.PackBits: {
      const out = new Uint8Array(expected)
      unpackBits(raw, out)
      return out
    }
    case COMPRESSION.Lzw:
      return lzwDecode(raw, expected)
    case COMPRESSION.AdobeDeflate:
    case COMPRESSION.DeflateOld:
      return inflate(raw, 'deflate', expected)
    default:
      throw new IoUnsupportedError(
        `compression ${compressionName(compression)} is not supported`,
        'tiff.unsupported-compression',
      )
  }
}

function applyPredictor(
  data: Uint8Array,
  f: PageFields,
  block: TiffBlock,
  channelsInBlock: number,
  reader: IfdReader,
): void {
  if (f.predictor === PREDICTOR.Horizontal) {
    undoHorizontalPredictor(
      data,
      block.storedWidth,
      channelsInBlock,
      block.storedHeight,
      f.bitsPerSample,
      reader.header.littleEndian,
    )
  } else if (f.predictor === PREDICTOR.FloatingPoint) {
    undoFloatingPredictor(
      data,
      block.storedWidth,
      channelsInBlock,
      block.storedHeight,
      f.bitsPerSample / 8,
    )
  }
}

/**
 * Copies one decoded block into the page buffer, cropping the tile padding and
 * interleaving planar sources so that consumers never branch on PlanarConfiguration
 * (invariant 1 of spec 05 §3.1).
 */
function writeBlock(
  out: SampleArray,
  data: Uint8Array,
  block: TiffBlock,
  f: PageFields,
  spp: number,
  channelsInBlock: number,
  sampleType: SampleType,
  model: ColorModel,
  littleEndian: boolean,
): void {
  const bps = f.bitsPerSample
  const rows = Math.min(block.storedHeight, f.height - block.y)
  const cols = Math.min(block.storedWidth, f.width - block.x)
  if (rows <= 0 || cols <= 0) return

  // Sub-byte depths: expand first, keeping raw indices for palette images.
  if (bps < 8) {
    const expanded = new Uint8Array(block.storedWidth * block.storedHeight * channelsInBlock)
    unpackSubByteSamples(
      data,
      expanded,
      block.storedWidth,
      block.storedHeight,
      channelsInBlock,
      bps,
      model !== 'indexed',
    )
    copySamples(out, expanded, block, f, spp, channelsInBlock, rows, cols, (a, i) => a[i])
    return
  }

  if (bps === 8) {
    copySamples(out, data, block, f, spp, channelsInBlock, rows, cols, (a, i) => a[i])
    return
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const isFloat = f.sampleFormat === SAMPLE_FORMAT.IeeeFloat
  let read: (i: number) => number
  if (bps === 16) {
    read = isFloat
      ? (i) => halfBitsToFloat(view.getUint16(i * 2, littleEndian))
      : (i) => view.getUint16(i * 2, littleEndian)
  } else if (bps === 32) {
    read = isFloat ? (i) => view.getFloat32(i * 4, littleEndian) : (i) => view.getUint32(i * 4, littleEndian)
  } else {
    // 64-bit doubles are degraded to f32, with the loss reported by the caller.
    read = (i) => view.getFloat64(i * 8, littleEndian)
  }
  const maxIndex = Math.floor(data.byteLength / (bps / 8))
  copyIndexed(out, block, f, spp, channelsInBlock, rows, cols, (i) => (i < maxIndex ? read(i) : 0))
  void sampleType
}

function copySamples(
  out: SampleArray,
  src: Uint8Array,
  block: TiffBlock,
  f: PageFields,
  spp: number,
  channelsInBlock: number,
  rows: number,
  cols: number,
  read: (a: Uint8Array, i: number) => number,
): void {
  copyIndexed(out, block, f, spp, channelsInBlock, rows, cols, (i) => (i < src.length ? read(src, i) : 0))
}

function copyIndexed(
  out: SampleArray,
  block: TiffBlock,
  f: PageFields,
  spp: number,
  channelsInBlock: number,
  rows: number,
  cols: number,
  read: (i: number) => number,
): void {
  const planar = channelsInBlock === 1 && spp > 1
  for (let r = 0; r < rows; r++) {
    const srcRow = r * block.storedWidth * channelsInBlock
    const dstRow = ((block.y + r) * f.width + block.x) * spp
    for (let c = 0; c < cols; c++) {
      const s = srcRow + c * channelsInBlock
      const d = dstRow + c * spp
      if (planar) {
        out[d + block.plane] = read(s)
      } else {
        for (let ch = 0; ch < channelsInBlock; ch++) out[d + ch] = read(s + ch)
      }
    }
  }
}

/**
 * JPEG-in-TIFF (compression 7): rebuild a self-contained JPEG from `JPEGTables` plus the
 * strip payload and let the browser decode it — no DCT to write (spec 05 §4.4). The
 * browser always returns RGBA, so the block is written back as RGB(A) samples.
 */
async function writeJpegBlock(
  out: SampleArray,
  raw: Uint8Array,
  tables: Uint8Array | undefined,
  block: TiffBlock,
  f: PageFields,
  spp: number,
  decode: JpegBlockDecoder,
  warn: (w: IoWarning) => void,
  pageIndex: number,
): Promise<void> {
  let decoded: { width: number; height: number; rgba: Uint8Array }
  try {
    decoded = await decode(rebuildJpegStream(tables, raw))
  } catch (e) {
    warn(ioWarn('tiff.jpeg-block-failed', { page: pageIndex, error: String(e) }))
    return
  }
  const rows = Math.min(block.storedHeight, f.height - block.y, decoded.height)
  const cols = Math.min(block.storedWidth, f.width - block.x, decoded.width)
  const colorChannels = Math.min(spp, 3)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const s = (r * decoded.width + c) * 4
      const d = ((block.y + r) * f.width + block.x + c) * spp
      for (let ch = 0; ch < colorChannels; ch++) out[d + ch] = decoded.rgba[s + ch]
      if (spp > colorChannels) out[d + colorChannels] = decoded.rgba[s + 3]
    }
  }
}

// ---------------------------------------------------------------------------

function makeArray(type: SampleType, count: number, label: string): SampleArray {
  switch (type) {
    case 'u8':
      return allocU8(count, label)
    case 'u16':
    case 'f16':
      return allocU16(count, label)
    case 'u32':
      return allocU32(count, label)
    case 'f32':
      return allocF32(count, label)
  }
}

function halfBitsToFloat(bits: number): number {
  const sign = (bits & 0x8000) !== 0 ? -1 : 1
  const exponent = (bits >> 10) & 0x1f
  const mantissa = bits & 0x3ff
  if (exponent === 0) return sign * mantissa * 2 ** -24
  if (exponent === 31) return mantissa === 0 ? sign * Infinity : NaN
  return sign * (mantissa + 1024) * 2 ** (exponent - 25)
}

/** PhotometricInterpretation = 0 (WhiteIsZero): colour channels are inverted, alpha is not. */
function invertSamples(
  out: SampleArray,
  type: SampleType,
  bitsPerSample: number,
  spp: number,
  colorChannels: number,
): void {
  const effectiveMax =
    type === 'f32'
      ? 1
      : type === 'u8'
        ? (bitsPerSample < 8 ? 255 : 255)
        : type === 'u16'
          ? 65535
          : 0xffffffff
  for (let i = 0; i < out.length; i += spp) {
    for (let c = 0; c < colorChannels; c++) out[i + c] = effectiveMax - out[i + c]
  }
}

/** SampleFormat = 2 (signed): shift into the unsigned range so downstream code is uniform. */
function recentreSigned(out: SampleArray, type: SampleType, bitsPerSample: number): void {
  if (type === 'u8') {
    for (let i = 0; i < out.length; i++) out[i] = (out[i] + 128) & 0xff
  } else if (type === 'u16' && bitsPerSample === 16) {
    for (let i = 0; i < out.length; i++) out[i] = (out[i] + 32768) & 0xffff
  }
}

export { photometricName }
