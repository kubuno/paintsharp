// Shared metadata model for the Layer IO stack (spec 05 §6.1).
//
// EXIF, XMP, IPTC and ICC are the *same* byte blocks in every container; only their
// location changes (JPEG APP segments, PNG chunks, TIFF tags, RIFF chunks, ISOBMFF
// items). This file describes the parsed shape once, so a single parser serves them all.

/** CIE xy chromaticities of the three primaries and the white point. */
export interface Chromaticities {
  readonly rx: number
  readonly ry: number
  readonly gx: number
  readonly gy: number
  readonly bx: number
  readonly by: number
  readonly wx: number
  readonly wy: number
}

/** CIE XYZ triplet (D50-relative in ICC, D65 elsewhere — the carrier says which). */
export interface XYZ {
  readonly x: number
  readonly y: number
  readonly z: number
}

/**
 * Opto-electronic transfer function *as declared by the file*. Never applied by a
 * decoder: turning this into an actual transform is the colour pipeline's job.
 */
export type TransferFn =
  | { readonly kind: 'linear' }
  | { readonly kind: 'srgb' }
  | { readonly kind: 'gamma'; readonly gamma: number }
  | { readonly kind: 'rec709' }
  | { readonly kind: 'pq' }
  | { readonly kind: 'hlg' }
  /** Sampled tone curve (ICC `curv` with more than one entry, PNG has none of these). */
  | { readonly kind: 'curve'; readonly samples: Float32Array }

/** ICC rendering intent, as stored in the profile header. */
export type RenderingIntent = 0 | 1 | 2 | 3

/**
 * A parsed ICC profile *header*, never a colour-management engine.
 *
 * `raw` is kept verbatim so the original profile can be re-embedded on export even when
 * we cannot interpret it (LUT-based profiles). See spec 05 §6.6.
 */
export interface IccProfile {
  /** Verbatim profile bytes, always kept for re-embedding. */
  readonly raw: Uint8Array
  readonly size: number
  /** Data colour space signature: 'RGB ', 'GRAY', 'CMYK', 'Lab '… */
  readonly colorSpace: string
  /** Profile connection space: 'XYZ ' or 'Lab '. */
  readonly pcs: string
  readonly version: string
  readonly renderingIntent: RenderingIntent
  /** 'desc' tag content, for the UI. */
  readonly description?: string
  /**
   * Matrix/TRC profiles reduce to primaries + transfer, which covers ~95 % of real
   * images (sRGB, Adobe RGB, Display P3, ProPhoto). `undefined` for LUT-based profiles.
   */
  readonly matrixTrc?: {
    readonly primaries: Chromaticities
    readonly transfer: TransferFn
    readonly wtpt: XYZ
  }
}

/**
 * TIFF/EXIF field types (shared with the TIFF IFD reader — spec 05 §4.1).
 * A frozen object rather than a `const enum`: esbuild/Vite cannot inline cross-module
 * const enums under isolated-modules transpilation.
 */
export const ExifType = {
  Byte: 1,
  Ascii: 2,
  Short: 3,
  Long: 4,
  Rational: 5,
  SByte: 6,
  Undefined: 7,
  SShort: 8,
  SLong: 9,
  SRational: 10,
  Float: 11,
  Double: 12,
  Ifd: 13,
  Long8: 16,
  SLong8: 17,
  Ifd8: 18,
} as const

export type ExifTypeId = (typeof ExifType)[keyof typeof ExifType]

/** Byte width of each TIFF field type; 0 marks an unknown type (entry must be skipped). */
export const EXIF_TYPE_SIZE: Readonly<Record<number, number>> = Object.freeze({
  1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4,
  16: 8, 17: 8, 18: 8,
})

/** One decoded IFD entry. */
export interface ExifTagValue {
  readonly tag: number
  readonly type: number
  readonly count: number
  /**
   * Decoded payload: a string for ASCII, raw bytes for UNDEFINED/BYTE, numbers
   * otherwise. RATIONAL types are decoded to their quotient; `rationals` keeps the
   * numerator/denominator pairs so a serializer can round-trip them exactly.
   */
  readonly value: string | Uint8Array | readonly number[]
  readonly rationals?: readonly (readonly [number, number])[]
}

export interface ExifIfd {
  readonly tags: ReadonlyMap<number, ExifTagValue>
}

/** Parsed EXIF block. An EXIF block *is* a small TIFF file (spec 05 §6.2). */
export interface ExifData {
  readonly ifd0: ExifIfd
  /** Tag 34665. */
  readonly exifIfd?: ExifIfd
  /** Tag 34853. */
  readonly gpsIfd?: ExifIfd
  /** Tag 40965. */
  readonly interopIfd?: ExifIfd
  /** Thumbnail IFD. */
  readonly ifd1?: ExifIfd
  /** JPEG thumbnail bytes referenced by IFD1, when present. */
  readonly thumbnail?: Uint8Array
  /** Byte order of the source block, preserved for exact re-serialisation. */
  readonly littleEndian: boolean
}

/** XMP is kept verbatim; only the properties we expose are re-serialised (spec 05 §6.4). */
export interface XmpPacket {
  readonly raw: Uint8Array
  readonly xml: string
  /** True when the packet was reassembled from JPEG Extended XMP segments. */
  readonly extended?: boolean
}

/** IPTC IIM datasets, keyed `"<record>:<dataset>"` (e.g. `"2:25"` for Keywords). */
export interface IptcData {
  readonly datasets: ReadonlyMap<string, readonly string[]>
  /** True when 1:90 declared `%G` (UTF-8) rather than the Latin-1 default. */
  readonly utf8: boolean
}

export interface ImageMetadata {
  readonly exif?: ExifData
  readonly xmp?: XmpPacket
  readonly iptc?: IptcData
  readonly icc?: IccProfile
  /**
   * Format-specific leftovers we do not model but must not lose on re-save
   * (TIFF ImageSourceData, PNG unknown chunks, TGA extension area…).
   */
  readonly opaque?: ReadonlyMap<string, Uint8Array>
  /** Free-form text (PNG tEXt, PNM comments, HDR header lines). */
  readonly text?: ReadonlyMap<string, string>
}

/** Mutable counterpart used by decoders while they fill a metadata record. */
export interface MutableImageMetadata {
  exif?: ExifData
  xmp?: XmpPacket
  iptc?: IptcData
  icc?: IccProfile
  opaque?: Map<string, Uint8Array>
  text?: Map<string, string>
}

/** Empty metadata, for decoders that carry none. */
export const EMPTY_METADATA: ImageMetadata = Object.freeze({})

/** Freezes a builder into the readonly shape, dropping empty containers. */
export function finishMetadata(m: MutableImageMetadata): ImageMetadata {
  const out: MutableImageMetadata = {}
  if (m.exif) out.exif = m.exif
  if (m.xmp) out.xmp = m.xmp
  if (m.iptc) out.iptc = m.iptc
  if (m.icc) out.icc = m.icc
  if (m.opaque && m.opaque.size > 0) out.opaque = m.opaque
  if (m.text && m.text.size > 0) out.text = m.text
  return out as ImageMetadata
}
