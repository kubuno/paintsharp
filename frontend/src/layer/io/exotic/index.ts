// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Public surface of the exotic-format importers. Nothing outside `layer/io/exotic/`
// should import any other file of this subtree.
//
// Scope, and what is deliberately absent
// --------------------------------------
//   XCF  full reader: 0..25+, all three precision encodings, 4- and 8-byte offsets, both
//        component byte orders, RLE / none / zlib, groups, masks, indexed palettes, the
//        64 blend modes. WRITING XCF is out of scope on purpose (spec 07 §4.12).
//   RAW  embedded JPEG preview only. Decoding the sensor stream needs a per-manufacturer
//        codec; that is LibRaw's job and it would mean shipping WebAssembly. NOT DONE.
//   HEIC native decoding paths only. No libheif, no bundled HEVC decoder: the copyright
//        question is answerable, the HEVC PATENT question is not, and shipping a decoder
//        in a self-hosted product is an exposure no licence removes.
//   SVG/PDF rasterisation by reusing `src/shared/`, which also serves Apex and PdfWriter.
//
// No new npm dependency was added for any of it.

export {
  DEFAULT_PIXEL_BUDGET,
  ImportWarningSink,
  countNodes,
  importWarn,
  walkNodes,
} from './types'
export type {
  BlendMode,
  DecodeOptions,
  ImportWarning,
  ImportedDocument,
  ImportedGroup,
  ImportedNode,
  ImportedRaster,
  RasterPayload,
} from './types'

export { ImportError, isImportError, toImportError } from './errors'
export type { ImportErrorCode } from './errors'

export {
  EXOTIC_DESCRIPTORS,
  exoticInfo,
  isExoticFormat,
  registerExoticFormats,
} from './descriptors'
export type { ExoticFormatId, ExoticFormatInfo } from './descriptors'

export {
  classifyTiffFamily,
  isGzip,
  sniffCr2,
  sniffCr3,
  sniffHeif,
  sniffOrf,
  sniffPdf,
  sniffRaf,
  sniffRw2,
  sniffSvg,
  sniffUnsupportedRaw,
  sniffXcf,
  tooShortToSniff,
} from './magic'
export type { TiffFamilyVerdict } from './magic'

export { orientedSize, singleLayerDocument, stripExtension } from './bitmap'
export type { RgbaImage } from './bitmap'

import { ImportError } from './errors'
import { exoticInfo, isExoticFormat } from './descriptors'
import { sniffUnsupportedRaw } from './magic'
import type { DecodeOptions, ImportedDocument } from './types'

/**
 * Decodes an exotic file into the neutral document model, loading the right decoder chunk
 * on demand.
 *
 * `formatId` comes from the shared registry's `detect()`; passing it in rather than
 * re-sniffing here keeps a single detection authority. Returns an ARRAY because a PDF
 * legitimately produces one document per page when the page sizes differ.
 *
 * Never rejects with a bare `Error`: every failure is an `ImportError` carrying an i18n
 * key and an actionable message.
 */
export async function decodeExotic(
  bytes: Uint8Array,
  formatId: string,
  opts: DecodeOptions = {},
): Promise<ImportedDocument[]> {
  // Recognised-but-refused families are named explicitly rather than byte-scanned: a
  // scan on a Foveon or a CRW finds false positives more often than pictures.
  const refused = sniffUnsupportedRaw(bytes)
  if (refused) {
    const { rejectUnsupportedRaw } = await import('./raw/index')
    rejectUnsupportedRaw(refused)
  }
  if (!isExoticFormat(formatId)) {
    throw new ImportError('unknown-format', 'layer.io.err.unknown_format', undefined, formatId)
  }
  const info = exoticInfo(formatId)
  if (!info) {
    throw new ImportError('unknown-format', 'layer.io.err.unknown_format', undefined, formatId)
  }
  const decode = await info.load()
  return decode(bytes, opts)
}

/** Rasterises an Apex page into a Layer document (`pageDataToSvg` -> raster bridge). */
export async function rasterizeApexPageToDocument(
  svgText: string,
  opts?: Parameters<typeof import('./svg').rasterizeApexPage>[1],
): Promise<ImportedDocument> {
  const { rasterizeApexPage } = await import('./svg')
  return rasterizeApexPage(svgText, opts)
}

/** How this browser can (or cannot) decode HEIC. Cached for the realm. */
export async function probeHeifSupport(sample?: Uint8Array): Promise<import('./heif/capability').HeifPath> {
  const { detectHeifPath } = await import('./heif/capability')
  return detectHeifPath(sample)
}
