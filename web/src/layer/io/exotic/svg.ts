// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SVG -> Layer rasterisation (spec 07 §7.2).
//
// Deliberately NOT routed through Apex's `svgToPageData()`: that model covers only what
// Apex can edit (paths, shapes, simple text) and would silently drop filters, gradient
// meshes, masks and patterns. Rasterising the source as written is strictly more
// faithful. The Apex bridge goes the other way — `rasterizeApexPage` below takes a
// `pageDataToSvg()` string, which is where the reuse genuinely pays.

import { missingFontFamilies, rasterizeSvg, SvgParseError } from '../../../shared/svgRaster'
import { bitmapToRgba, singleLayerDocument, stripExtension } from './bitmap'
import { ImportError, toImportError } from './errors'
import { ImportWarningSink, importWarn, type DecodeOptions, type ImportedDocument } from './types'

export interface SvgImportOptions extends DecodeOptions {
  /** Scale relative to the SVG's user units. */
  readonly scale?: number
  /** Ceiling on the rasterised surface. */
  readonly maxPixels?: number
  /** Transparent by default. */
  readonly background?: string
}

const DEFAULT_MAX_PIXELS = 40_000_000

export async function decodeSvg(
  bytes: Uint8Array,
  opts: SvgImportOptions = {},
): Promise<ImportedDocument> {
  const text = decodeSvgText(bytes)
  return rasterizeSvgSource(text, opts, stripExtension(opts.name, 'SVG'))
}

/**
 * Apex -> Layer bridge. The caller passes `pageDataToSvg(pageData)` from `apexSvg.ts`;
 * no rendering code is duplicated on either side.
 */
export function rasterizeApexPage(
  svgText: string,
  opts: SvgImportOptions = {},
): Promise<ImportedDocument> {
  return rasterizeSvgSource(svgText, opts, opts.name ?? 'Apex')
}

async function rasterizeSvgSource(
  svgText: string,
  opts: SvgImportOptions,
  title: string,
): Promise<ImportedDocument> {
  try {
    const warn = new ImportWarningSink()
    if (typeof document === 'undefined') {
      // Rasterising needs an <img>: the only path several engines accept for SVG.
      throw new ImportError('decoder-unavailable', 'layer.io.err.decoder_unavailable', undefined, 'no DOM')
    }
    let result
    try {
      result = await rasterizeSvg(svgText, {
        scale: opts.scale ?? 1,
        maxPixels: opts.maxPixels ?? DEFAULT_MAX_PIXELS,
        background: opts.background,
      })
    } catch (e) {
      if (e instanceof SvgParseError) {
        throw new ImportError('corrupt', 'layer.io.err.svg_parse', undefined, e.message)
      }
      throw e
    }
    opts.onProgress?.(1)

    if (result.sizeGuessed) warn.warn(importWarn('svg.size-guessed', { size: result.width }))
    if (result.scaleReduced) warn.warn(importWarn('svg.scale-reduced', { width: result.width, height: result.height }))
    const missing = missingFontFamilies(svgText)
    if (missing.length > 0) warn.warn(importWarn('svg.missing-fonts', { families: missing.join(', ') }))

    const image = bitmapToRgba(result.canvas)
    return singleLayerDocument(image, {
      title,
      layerName: 'SVG',
      warnings: warn.list(),
      provenance: `SVG · ${Math.round(result.intrinsic.width)}×${Math.round(result.intrinsic.height)} user units → ${result.width}×${result.height} px`,
    })
  } catch (e) {
    throw toImportError(e, 'svg')
  }
}

/**
 * Decodes SVG source text, honouring the byte-order marks real exporters emit. SVGZ is
 * handled by the caller (the gzip envelope is stripped before we get here).
 */
export function decodeSvgText(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le', { fatal: false }).decode(bytes.subarray(2))
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be', { fatal: false }).decode(bytes.subarray(2))
  }
  const start = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(start))
}

/** Transparently unwraps an SVGZ (gzip) envelope; returns the input otherwise. */
export async function gunzipIfNeeded(bytes: Uint8Array): Promise<Uint8Array> {
  if (bytes.length < 3 || bytes[0] !== 0x1f || bytes[1] !== 0x8b || bytes[2] !== 0x08) return bytes
  const DS = (globalThis as { DecompressionStream?: typeof DecompressionStream }).DecompressionStream
  if (!DS) return bytes
  const stream = new Blob([bytes.slice()]).stream().pipeThrough(new DS('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}
