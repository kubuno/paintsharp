// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Offscreen PDF page rendering, shared between the Paintsharp sub-modules (spec 07 §7.3).
//
// `pdfjs-dist` (Apache-2.0) is already a dependency of this package — PdfWriter uses it —
// so nothing new is installed. It is imported DYNAMICALLY on purpose: a static import
// from Layer would make rolldown merge the ~340 KiB gz pdf.js chunk into Layer's, and
// someone who never opens a PDF would pay for it on every load.
//
// The `canvas: null` + `intent: 'print'` combination below is not decorative. Without it
// pdf.js v6 shares the page's 'display' render channel and paints into the on-screen
// canvas instead of the offscreen one. That behaviour was found the hard way in
// `pdfExtract.ts`; the same combination is reproduced here rather than rediscovered.

import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'

/**
 * An open document plus the way to release it. `destroy()` lives on the LOADING TASK in
 * pdf.js v6, not on the document proxy — forgetting that leaks the worker for the rest of
 * the session, which on a multi-page import is measurable.
 */
export interface PdfHandle {
  readonly doc: PDFDocumentProxy
  destroy(): Promise<void>
}

export interface PdfRenderOptions {
  /** 72 renders 1:1 with PDF points. */
  readonly dpi: number
  /** Hard ceiling per page; the dpi is reduced to fit. */
  readonly maxPixels: number
  /** Transparent when omitted — a PDF has no background of its own. */
  readonly background?: string
}

export interface PdfPageRender {
  readonly canvas: OffscreenCanvas
  readonly width: number
  readonly height: number
  /** Page size in PDF points, i.e. at 72 dpi. */
  readonly widthPt: number
  readonly heightPt: number
  /** True when `maxPixels` forced the requested dpi down. */
  readonly dpiReduced: boolean
}

/** Opens a PDF. The handle must be destroyed by the caller. */
export async function loadPdf(bytes: ArrayBuffer | Uint8Array): Promise<PdfHandle> {
  const pdfjs = await import('pdfjs-dist')
  const data = bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes.slice(0))
  const task = pdfjs.getDocument({ data })
  const doc = await task.promise
  return { doc, destroy: () => task.destroy() }
}

/** Renders one page into an offscreen canvas, with no side effect on the DOM. */
export async function renderPdfPage(
  page: PDFPageProxy,
  opts: PdfRenderOptions,
): Promise<PdfPageRender> {
  const base = page.getViewport({ scale: 1 })
  const requested = Math.max(1, opts.dpi) / 72
  const maxScale = Math.sqrt(Math.max(1, opts.maxPixels) / (base.width * base.height))
  const scale = Math.max(0.05, Math.min(requested, maxScale))
  const viewport = page.getViewport({ scale })

  const width = Math.max(1, Math.ceil(viewport.width))
  const height = Math.max(1, Math.ceil(viewport.height))
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2D context unavailable for PDF rendering')
  if (opts.background) {
    ctx.fillStyle = opts.background
    ctx.fillRect(0, 0, width, height)
  }

  await page.render({
    canvas: null,
    canvasContext: ctx as unknown as CanvasRenderingContext2D,
    viewport,
    intent: 'print',
  } as unknown as Parameters<PDFPageProxy['render']>[0]).promise

  return {
    canvas,
    width,
    height,
    widthPt: base.width,
    heightPt: base.height,
    dpiReduced: scale < requested,
  }
}

/** Parses a page range such as `"1-3, 7, 10-"` into 0-based indices. */
export function parsePageRange(spec: string, pageCount: number): number[] {
  const wanted = new Set<number>()
  for (const part of spec.split(',')) {
    const token = part.trim()
    if (!token) continue
    const m = /^(\d+)?\s*(?:-\s*(\d+)?)?$/.exec(token)
    if (!m) continue
    const hasDash = token.includes('-')
    const from = m[1] ? Number.parseInt(m[1], 10) : 1
    const to = hasDash ? (m[2] ? Number.parseInt(m[2], 10) : pageCount) : from
    for (let p = Math.max(1, from); p <= Math.min(pageCount, to); p++) wanted.add(p - 1)
  }
  return [...wanted].sort((a, b) => a - b)
}
