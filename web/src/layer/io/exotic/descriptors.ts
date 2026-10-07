// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Format descriptors for the exotic formats, written against the FROZEN contract of
// `layer/io/formats/registry.ts` (spec 05 §7). That contract is owned by another spec;
// this file CONSUMES it and does not redefine it. In particular `sniff` returns a
// CONFIDENCE, not a boolean, which is what keeps NEF/ARW/DNG/TIFF from colliding.
//
// Golden rule of the registry: nothing here imports a decoder statically. A descriptor is
// strings plus `() => import(...)` closures, a few hundred bytes each; the decoders
// themselves are separate chunks fetched only when a file of that format is opened.

import type { FormatDescriptor } from '../formats/registry'
import { formats } from '../formats/registry'
import type { ColorModel } from '../formats/types'
import {
  classifyTiffFamily,
  sniffCr2,
  sniffCr3,
  sniffHeif,
  sniffOrf,
  sniffPdf,
  sniffRaf,
  sniffRw2,
  sniffSvg,
  sniffXcf,
} from './magic'
import type { DecodeOptions, ImportedDocument } from './types'

/** Identifiers used by the exotic decoders. Stable: they key user export presets. */
export type ExoticFormatId =
  | 'xcf'
  | 'heif'
  | 'svg'
  | 'pdf'
  | 'raw-cr2'
  | 'raw-cr3'
  | 'raw-nef'
  | 'raw-arw'
  | 'raw-dng'
  | 'raw-orf'
  | 'raw-raf'
  | 'raw-rw2'
  | 'raw-tiff-generic'

/**
 * Extra descriptor facets this specification adds (spec 07 §2.1). They are all optional,
 * so the shared `FormatDescriptor` type is unchanged; consumers read them through
 * `exoticInfo(id)` rather than through a widened interface.
 */
export interface ExoticFormatInfo {
  readonly id: ExoticFormatId
  /** Approximate transferred weight of `load()`'s chunk, in KiB — for a metered-connection warning. */
  readonly decoderWeightKiB: number
  /** Decoding depends on a runtime browser capability probe (HEIC). */
  readonly needsCapabilityProbe?: boolean
  /** The format carries a layer stack we reconstruct. */
  readonly layers: boolean
  /** Loads the decoder chunk and returns the neutral document (or documents, for PDF). */
  load(): Promise<(bytes: Uint8Array, opts: DecodeOptions) => Promise<ImportedDocument[]>>
}

const RGB: readonly ColorModel[] = ['rgb']

function base(
  id: ExoticFormatId,
  labelKey: string,
  extensions: readonly string[],
  mimes: readonly string[],
  sniff: FormatDescriptor['sniff'],
  opts: { layers?: boolean; multiPage?: boolean } = {},
): FormatDescriptor {
  return {
    id,
    labelKey,
    extensions,
    mimes,
    canRead: true,
    canWrite: false,
    sniff,
    capabilities: {
      // Everything this layer produces is 8-bit sRGB: Layer's pipeline is RGBA8 textures,
      // so a 16- or 32-bit source is reduced on import, with a warning (spec 07 §3.4).
      maxBitDepth: 8,
      alpha: true,
      layers: opts.layers ?? false,
      multiPage: opts.multiPage ?? false,
      colorModels: RGB,
      icc: true,
      exif: true,
      xmp: false,
      iptc: false,
      lossless: true,
    },
  }
}

/** Sniffs a TIFF-family RAW, claiming only the flavour the bytes actually support. */
function tiffFamilySniff(wanted: ExoticFormatId): FormatDescriptor['sniff'] {
  return (head) => {
    const verdict = classifyTiffFamily(head)
    return verdict.id === wanted ? verdict.confidence : 0
  }
}

export const EXOTIC_DESCRIPTORS: readonly FormatDescriptor[] = [
  base('xcf', 'layer.io.format.xcf', ['xcf'], ['image/x-xcf'], (head) => sniffXcf(head), {
    layers: true,
  }),
  base('heif', 'layer.io.format.heif', ['heic', 'heif'], ['image/heic', 'image/heif'], (head) =>
    sniffHeif(head),
  ),
  base('svg', 'layer.io.format.svg', ['svg', 'svgz'], ['image/svg+xml'], (head) => sniffSvg(head)),
  base('pdf', 'layer.io.format.pdf', ['pdf'], ['application/pdf'], (head) => sniffPdf(head), {
    multiPage: true,
  }),
  base('raw-cr2', 'layer.io.format.raw_cr2', ['cr2'], ['image/x-canon-cr2'], (head) => sniffCr2(head)),
  base('raw-cr3', 'layer.io.format.raw_cr3', ['cr3'], ['image/x-canon-cr3'], (head) => sniffCr3(head)),
  base('raw-orf', 'layer.io.format.raw_orf', ['orf'], ['image/x-olympus-orf'], (head) => sniffOrf(head)),
  base('raw-raf', 'layer.io.format.raw_raf', ['raf'], ['image/x-fuji-raf'], (head) => sniffRaf(head)),
  base('raw-rw2', 'layer.io.format.raw_rw2', ['rw2', 'raw'], ['image/x-panasonic-rw2'], (head) =>
    sniffRw2(head),
  ),
  base('raw-dng', 'layer.io.format.raw_dng', ['dng'], ['image/x-adobe-dng'], tiffFamilySniff('raw-dng')),
  base('raw-nef', 'layer.io.format.raw_nef', ['nef', 'nrw'], ['image/x-nikon-nef'], tiffFamilySniff('raw-nef')),
  base('raw-arw', 'layer.io.format.raw_arw', ['arw', 'sr2', 'srf'], ['image/x-sony-arw'], tiffFamilySniff('raw-arw')),
  base(
    'raw-tiff-generic',
    'layer.io.format.raw_generic',
    ['pef', 'srw', '3fr', 'fff', 'iiq', 'cap', 'erf', 'mef', 'mos', 'rwl', 'dcr', 'kdc'],
    ['image/x-dcraw'],
    tiffFamilySniff('raw-tiff-generic'),
  ),
]

/** Wraps a single-document decoder so every loader has the same array-returning shape. */
function one(
  fn: (bytes: Uint8Array, opts: DecodeOptions) => Promise<ImportedDocument>,
): (bytes: Uint8Array, opts: DecodeOptions) => Promise<ImportedDocument[]> {
  return async (bytes, opts) => [await fn(bytes, opts)]
}

const RAW_IDS = [
  'raw-cr2',
  'raw-cr3',
  'raw-nef',
  'raw-arw',
  'raw-dng',
  'raw-orf',
  'raw-raf',
  'raw-rw2',
  'raw-tiff-generic',
] as const

const INFO = new Map<ExoticFormatId, ExoticFormatInfo>([
  [
    'xcf',
    {
      id: 'xcf',
      decoderWeightKiB: 12,
      layers: true,
      load: async () => {
        const { decodeXcf } = await import('./xcf/index')
        return one(decodeXcf)
      },
    },
  ],
  [
    'heif',
    {
      id: 'heif',
      decoderWeightKiB: 5,
      needsCapabilityProbe: true,
      layers: false,
      load: async () => {
        const { decodeHeif } = await import('./heif/index')
        return one(decodeHeif)
      },
    },
  ],
  [
    'svg',
    {
      id: 'svg',
      decoderWeightKiB: 2,
      layers: false,
      load: async () => {
        const { decodeSvg, gunzipIfNeeded } = await import('./svg')
        return async (bytes, opts) => [await decodeSvg(await gunzipIfNeeded(bytes), opts)]
      },
    },
  ],
  [
    'pdf',
    {
      id: 'pdf',
      // pdf.js is ~340 KiB gz. It is already paid for by PdfWriter, but a user who only
      // ever opens Layer has not downloaded it, so the number must be honest.
      decoderWeightKiB: 342,
      layers: false,
      load: async () => {
        const { decodePdf } = await import('./pdf')
        return (bytes, opts) => decodePdf(bytes, opts)
      },
    },
  ],
  ...RAW_IDS.map(
    (id) =>
      [
        id,
        {
          id,
          decoderWeightKiB: 7,
          layers: false,
          load: async () => {
            const { decodeRaw } = await import('./raw/index')
            return async (bytes: Uint8Array, opts: DecodeOptions) => [await decodeRaw(bytes, id, opts)]
          },
        },
      ] as const,
  ),
])

export function exoticInfo(id: string): ExoticFormatInfo | undefined {
  return INFO.get(id as ExoticFormatId)
}

export function isExoticFormat(id: string): id is ExoticFormatId {
  return INFO.has(id as ExoticFormatId)
}

/**
 * Registers every exotic descriptor with the shared registry.
 *
 * Pure data: no decoder module is imported as a side effect, so calling this from
 * `entry.ts` costs a few hundred bytes and no network request.
 */
export function registerExoticFormats(registry = formats): void {
  for (const d of EXOTIC_DESCRIPTORS) registry.register(d)
}
