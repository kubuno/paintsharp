// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PDF -> Layer rasterisation (spec 07 §7.3).
//
// Layer rasterises; it does not extract. Pulling editable text fragments out of a PDF and
// matching their fonts is PdfWriter's job (`pdfExtract.ts` + `pdfFontMatch.ts`), and
// mixing the two would give the user two half-answers. Someone who wants to edit the text
// opens the PDF in PdfWriter; someone who wants to paint over it opens it in Layer.
//
// `pdfjs-dist` is reached only through `shared/pdfRender.ts`, which imports it with a
// dynamic `import()`. This module itself is only ever reached through the descriptor's
// lazy loader, so the pdf.js chunk is fetched the first time a PDF is opened, never
// before — a bundle-budget constraint, not an architectural one (spec 07 §7.1).

import { loadPdf, renderPdfPage } from '../../../shared/pdfRender'
import { bitmapToRgba, singleLayerDocument, stripExtension } from './bitmap'
import { throwIfAborted, toImportError } from './errors'
import {
  ImportWarningSink,
  importWarn,
  type DecodeOptions,
  type ImportedDocument,
  type ImportedRaster,
} from './types'

export interface PdfImportOptions extends DecodeOptions {
  /** 72 = 1:1 with PDF points. 150 balances legibility against weight. */
  readonly dpi?: number
  /** Ceiling per page. */
  readonly maxPixels?: number
  /** `'#ffffff'` by default: a PDF carries no background and users expect paper. */
  readonly background?: string
  /** 0-based page indices; every page when omitted. */
  readonly pages?: readonly number[]
  /** Force one document per page even when the sizes agree. */
  readonly separateDocuments?: boolean
}

const DEFAULT_DPI = 150
const DEFAULT_MAX_PIXELS = 40_000_000
/** Beyond this, a "one document, N layers" import is unusable and a warning is due. */
const MAX_LAYERS_PER_DOC = 60

/**
 * Rasterises a PDF.
 *
 * Returns ONE document when every selected page has the same size (planches, storyboards
 * and mock-ups are meant to be stacked and compared), and one document PER page when the
 * sizes differ — stacking an A4 and an A3 in a single canvas would invent arbitrary
 * margins. Page 1 ends up at index 0, i.e. on top, per the stacking convention.
 */
export async function decodePdf(
  bytes: Uint8Array,
  opts: PdfImportOptions = {},
): Promise<ImportedDocument[]> {
  try {
    const warn = new ImportWarningSink()
    const handle = await loadPdf(bytes)
    const pdf = handle.doc
    try {
      const total = pdf.numPages
      const wanted = (opts.pages ?? Array.from({ length: total }, (_, i) => i)).filter(
        (i) => Number.isInteger(i) && i >= 0 && i < total,
      )
      if (wanted.length === 0) {
        return []
      }

      const rendered: { name: string; image: ReturnType<typeof bitmapToRgba> }[] = []
      let dpiReduced = false
      for (let k = 0; k < wanted.length; k++) {
        throwIfAborted(opts.signal)
        const pageNumber = wanted[k] + 1
        const page = await pdf.getPage(pageNumber)
        try {
          const out = await renderPdfPage(page, {
            dpi: opts.dpi ?? DEFAULT_DPI,
            maxPixels: opts.maxPixels ?? DEFAULT_MAX_PIXELS,
            background: opts.background ?? '#ffffff',
          })
          dpiReduced ||= out.dpiReduced
          rendered.push({ name: `Page ${pageNumber}`, image: bitmapToRgba(out.canvas) })
        } finally {
          page.cleanup()
        }
        opts.onProgress?.((k + 1) / wanted.length)
      }

      if (dpiReduced) warn.warn(importWarn('pdf.dpi-reduced'))
      const uniform = rendered.every(
        (r) => r.image.width === rendered[0].image.width && r.image.height === rendered[0].image.height,
      )
      const title = stripExtension(opts.name, 'PDF')

      if (!uniform || opts.separateDocuments || rendered.length === 1) {
        if (!uniform && rendered.length > 1) warn.warn(importWarn('pdf.mixed-page-sizes'))
        return rendered.map((r, i) =>
          singleLayerDocument(r.image, {
            title: rendered.length > 1 ? `${title} — ${r.name}` : title,
            layerName: r.name,
            warnings: warn.list(),
            provenance: `PDF · page ${wanted[i] + 1}/${total} · ${opts.dpi ?? DEFAULT_DPI} dpi · ${r.image.width}×${r.image.height}`,
          }),
        )
      }

      if (rendered.length > MAX_LAYERS_PER_DOC) {
        warn.warn(importWarn('pdf.too-many-pages-in-one-document', { count: rendered.length }))
      }
      // Page 1 on top; only the first page is visible, so the document opens readable.
      const layers: ImportedRaster[] = rendered.map((r, i) => ({
        kind: 'raster',
        name: r.name,
        visible: i === 0,
        opacity: 100,
        blendMode: 'normal',
        pixels: { kind: 'rgba8', data: r.image.data, width: r.image.width, height: r.image.height },
      }))
      return [
        {
          width: rendered[0].image.width,
          height: rendered[0].image.height,
          title,
          layers,
          warnings: warn.list(),
          provenance: `PDF · ${rendered.length}/${total} page(s) as layers · ${opts.dpi ?? DEFAULT_DPI} dpi`,
        },
      ]
    } finally {
      await handle.destroy()
    }
  } catch (e) {
    throw toImportError(e, 'pdf')
  }
}

/** Page count and page sizes, for the import dialog, without rendering anything. */
export async function inspectPdf(
  bytes: Uint8Array,
): Promise<{ pageCount: number; sizes: { width: number; height: number }[] }> {
  const handle = await loadPdf(bytes)
  const pdf = handle.doc
  try {
    const sizes: { width: number; height: number }[] = []
    // Bounded: a 3000-page PDF must not cost 3000 round trips just to fill a dialog.
    const probe = Math.min(pdf.numPages, 64)
    for (let i = 1; i <= probe; i++) {
      const page = await pdf.getPage(i)
      const vp = page.getViewport({ scale: 1 })
      sizes.push({ width: vp.width, height: vp.height })
      page.cleanup()
    }
    return { pageCount: pdf.numPages, sizes }
  } finally {
    await handle.destroy()
  }
}

export { parsePageRange } from '../../../shared/pdfRender'
