// Common data model for every Layer raster decoder/encoder (spec 05 §3.1).
//
// Why not `ImageData`? Because the 2D canvas is strictly 8 bits per channel (measured,
// spec 05 §2.4): `getImageData(..., { pixelFormat: 'float16' })` throws. Anything deeper
// than 8 bits (PNG 16, TIFF 16/32, EXR, HDR) can never transit through a canvas, so the
// exchange currency has to be our own typed arrays.

import type { Chromaticities, IccProfile, ImageMetadata, TransferFn } from '../metadata/types'

export type { Chromaticities, IccProfile, ImageMetadata, TransferFn }

/** Sample storage. `f16` is stored in a Uint16Array (raw half bits) until read. */
export type SampleType = 'u8' | 'u16' | 'u32' | 'f16' | 'f32'

/** Colour model *as stored in the file*, before any conversion to the working space. */
export type ColorModel = 'gray' | 'rgb' | 'cmyk' | 'lab' | 'ycbcr' | 'indexed'

/**
 * How the alpha channel relates to the colour channels. TIFF ExtraSamples 1 vs 2;
 * EXR is always associated, PNG/WebP/canvas are always unassociated.
 */
export type AlphaMode = 'none' | 'unassociated' | 'associated'

/** Any sample buffer a decoder may produce. */
export type SampleArray = Uint8Array | Uint16Array | Uint32Array | Float32Array

/**
 * What a decoder can say about where its samples live. Deliberately a *description*,
 * not a transform: building the transform is the colour pipeline's job (spec 05 §5.1).
 */
export type ColorSpaceRef =
  | { readonly kind: 'srgb' }
  | { readonly kind: 'linear-srgb' }
  | { readonly kind: 'display-p3' }
  /** EXR / HDR default. */
  | { readonly kind: 'linear-rec709' }
  | { readonly kind: 'gray'; readonly gamma: number }
  | { readonly kind: 'icc'; readonly profile: IccProfile }
  /** TIFF/PNG cHRM+gAMA, EXR chromaticities, AVIF nclx. */
  | { readonly kind: 'primaries'; readonly primaries: Chromaticities; readonly transfer: TransferFn }
  /** No profile → assume a generic SWOP-like space, and warn. */
  | { readonly kind: 'cmyk'; readonly profile?: IccProfile }
  | { readonly kind: 'lab'; readonly illuminant: 'D50' | 'D65' }
  /** Treated as sRGB downstream, with a warning. */
  | { readonly kind: 'unknown' }

export interface ExtraChannel {
  readonly kind: 'unspecified' | 'spot' | 'mask' | 'depth' | 'named'
  readonly name?: string
  /**
   * Index of this channel inside `RasterImage.data`'s interleaved samples. Present for
   * every container that interleaves (TIFF extra samples, TGA, PSD merged data).
   *
   * Note vs spec 05 §3.1: the spec types `data` as required. Interleaved sources would
   * then have to be copied twice into memory for no benefit, so `data` is optional here
   * and `channelIndex` points into the interleaved buffer instead. Planar sources that
   * genuinely own their samples (EXR parts) still fill `data`.
   */
  readonly channelIndex?: number
  readonly data?: Uint8Array | Uint16Array | Float32Array
}

export interface RasterImage {
  readonly width: number
  readonly height: number
  readonly colorModel: ColorModel
  readonly sampleType: SampleType
  /** Colour channels only (1 gray, 3 rgb/lab/ycbcr, 4 cmyk, 1 indexed). */
  readonly colorChannels: number
  readonly alpha: AlphaMode
  /**
   * Interleaved samples, row-major, `colorChannels + (alpha !== 'none' ? 1 : 0) + extra.length`
   * samples per pixel. Planar sources (TIFF PlanarConfiguration = 2) are interleaved by the
   * decoder so that consumers never branch on it.
   */
  readonly data: SampleArray
  /** RGB triplets (3 bytes per entry) for `indexed`, else undefined. */
  readonly palette?: Uint8Array
  /** Spot colours, TIFF extra samples, extra EXR channels — carried, never guessed at. */
  readonly extra?: readonly ExtraChannel[]
  readonly colorSpace: ColorSpaceRef
  readonly metadata: ImageMetadata
  readonly resolution?: { readonly x: number; readonly y: number; readonly unit: 'inch' | 'cm' | 'none' }
  /** EXIF orientation 1..8 *as read*. Applying it is an explicit step (spec 05 §6.3). */
  readonly orientation?: number
  /** Bits per sample as stored in the file, before unpacking (1, 2, 4, 8, 16, 32, 64). */
  readonly sourceBitDepth?: number
}

export type PageRole = 'main' | 'thumbnail' | 'mipmap' | 'alternate-size' | 'mask' | 'page'

export interface RasterPage {
  readonly image: RasterImage
  /** TIFF PageName, EXR part name, ICO "48×48 32bpp". */
  readonly name?: string
  readonly role: PageRole
  readonly index: number
}

/** Non-fatal problem, surfaced in the import report — never silently dropped (§7.1). */
export interface IoWarning {
  /** Stable machine code, e.g. `'tiff.unsupported-compression'`. */
  readonly code: string
  /** i18n key resolved by the UI. */
  readonly messageKey: string
  readonly params?: Record<string, string | number>
  readonly severity: 'info' | 'warning'
}

/**
 * Builds a warning whose i18n key is derived from the code, which is the common case:
 * `layer.io.warn.<code>`. `params` carries the numbers the message interpolates.
 */
export function ioWarn(
  code: string,
  params?: Record<string, string | number>,
  severity: 'info' | 'warning' = 'warning',
): IoWarning {
  return { code, messageKey: `layer.io.warn.${code}`, params, severity }
}

/** Collects warnings for decoders that are handed no `IoContext`. */
export class WarningSink {
  readonly warnings: IoWarning[] = []
  warn(w: IoWarning): void {
    // Bounded: a pathological file must not accumulate a million warnings.
    if (this.warnings.length < 256) this.warnings.push(w)
  }
}

export interface DecodedFile {
  readonly formatId: string
  /** Ordered; `pages[0]` is what a naive consumer should show. */
  readonly pages: readonly RasterPage[]
  /** Container-level metadata (TIFF ICC on IFD0, RIFF chunks, ISOBMFF items…). */
  readonly metadata: ImageMetadata
  readonly warnings: readonly IoWarning[]
}

/**
 * Cheap header probe (first ~64 KiB) deciding native vs in-house decode.
 * Never decodes pixels (spec 05 §3.2).
 */
export interface FastProbe {
  readonly formatId: string
  readonly width: number
  readonly height: number
  readonly bitDepth: number
  readonly pageCount: number
  readonly hasIcc: boolean
  readonly hasExif: boolean
  /** 1 when absent. */
  readonly orientation: number
  readonly colorModel: ColorModel
  readonly extraChannels: number
  /** The decision. */
  readonly nativeDecodeSufficient: boolean
}

// ---------------------------------------------------------------------------
// Errors — a malformed file must always surface as one of these, never as a
// crash, an infinite loop or a silent `undefined`.
// ---------------------------------------------------------------------------

export class IoError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'IoError'
    this.code = code
  }
}

/** A read ran past the end of the buffer. */
export class IoTruncatedError extends IoError {
  constructor(message = 'unexpected end of file') {
    super('io.truncated', message)
    this.name = 'IoTruncatedError'
  }
}

/** The file is well-formed but uses a feature we deliberately do not implement. */
export class IoUnsupportedError extends IoError {
  constructor(message: string, code = 'io.unsupported') {
    super(code, message)
    this.name = 'IoUnsupportedError'
  }
}

/** The file declares something past our safety limits (dimensions, page count, alloc). */
export class IoLimitError extends IoError {
  constructor(message: string) {
    super('io.limit', message)
    this.name = 'IoLimitError'
  }
}

/** The bytes do not describe a valid file of this format. */
export class IoInvalidError extends IoError {
  constructor(message: string, code = 'io.invalid') {
    super(code, message)
    this.name = 'IoInvalidError'
  }
}

/** Number of interleaved samples per pixel in `RasterImage.data`. */
export function samplesPerPixel(img: {
  colorChannels: number
  alpha: AlphaMode
  extra?: readonly ExtraChannel[]
}): number {
  const interleavedExtra = (img.extra ?? []).filter((c) => c.channelIndex !== undefined).length
  return img.colorChannels + (img.alpha !== 'none' ? 1 : 0) + interleavedExtra
}

/** Default channel count for a colour model. */
export function channelsForModel(model: ColorModel): number {
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
