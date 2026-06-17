// Flatten every annotation of every page into a real PDF using pdf-lib, so the
// exported file looks the same in any reader instead of being the bare source.
//
// Coordinate systems: annotations are stored in PDF points with a TOP-LEFT origin
// and y growing DOWNWARD (pdf.js convention). pdf-lib uses a BOTTOM-LEFT origin
// with y growing UPWARD, so every y is converted as `pageHeight - y`.
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from 'pdf-lib'
import type {
  Annotation, TextAnnotation, MarkupAnnotation, StickyNoteAnnotation, FreehandAnnotation,
  ShapeAnnotation, StampAnnotation, SignatureAnnotation, ImageAnnotation, FormFieldAnnotation,
} from './api'

export interface ExportPage { page_number: number; width: number; height: number; rotation: number }

const STAMP_LABELS: Record<string, { label: string; color: string }> = {
  approved: { label: 'APPROVED', color: '#1e8e3e' }, 'not-approved': { label: 'NOT APPROVED', color: '#d93025' },
  rejected: { label: 'REJECTED', color: '#d93025' }, confidential: { label: 'CONFIDENTIAL', color: '#d93025' },
  draft: { label: 'DRAFT', color: '#f9ab00' }, revised: { label: 'REVISED', color: '#1a73e8' },
  final: { label: 'FINAL', color: '#1e8e3e' }, 'for-review': { label: 'FOR REVIEW', color: '#1a73e8' },
}

function parseColor(hex: string | undefined, fallback: RGB = rgb(0, 0, 0)): RGB {
  if (!hex) return fallback
  let h = hex.trim()
  if (h.startsWith('#')) h = h.slice(1)
  if (h.length === 3) h = h.split('').map(c => c + c).join('')
  if (h.length !== 6) return fallback
  const n = parseInt(h, 16)
  if (Number.isNaN(n)) return fallback
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255)
}

export async function buildAnnotatedPdf(opts: {
  sourceBytes: ArrayBuffer | null
  pages: ExportPage[]
  annotationsByPage: Map<number, Annotation[]>
}): Promise<Uint8Array> {
  const { sourceBytes, pages, annotationsByPage } = opts

  const doc = sourceBytes
    ? await PDFDocument.load(sourceBytes, { ignoreEncryption: true })
    : await PDFDocument.create()

  // Lazily-embedded fonts (one instance each, reused across pages).
  const fontCache = new Map<string, PDFFont>()
  const font = async (family: string, bold: boolean, italic: boolean): Promise<PDFFont> => {
    const f = family.toLowerCase()
    const serif = /times|serif|georgia/.test(f)
    const mono = /courier|mono|consol/.test(f)
    let name: StandardFonts
    if (mono) name = bold ? (italic ? StandardFonts.CourierBoldOblique : StandardFonts.CourierBold) : (italic ? StandardFonts.CourierOblique : StandardFonts.Courier)
    else if (serif) name = bold ? (italic ? StandardFonts.TimesRomanBoldItalic : StandardFonts.TimesRomanBold) : (italic ? StandardFonts.TimesRomanItalic : StandardFonts.TimesRoman)
    else name = bold ? (italic ? StandardFonts.HelveticaBoldOblique : StandardFonts.HelveticaBold) : (italic ? StandardFonts.HelveticaOblique : StandardFonts.Helvetica)
    const cached = fontCache.get(name)
    if (cached) return cached
    const embedded = await doc.embedFont(name)
    fontCache.set(name, embedded)
    return embedded
  }

  // Strip control chars that the standard fonts (WinAnsi) cannot encode, so one odd
  // glyph never aborts the whole export.
  const safe = (s: string) => (s || '').replace(/[\x00-\x09\x0B-\x1F]/g, '')

  for (let i = 0; i < pages.length; i++) {
    const meta = pages[i]
    let page: PDFPage | undefined = doc.getPages()[i]
    if (!page) page = doc.addPage([meta.width, meta.height])   // pages added after import have no source page
    const H = page.getHeight()
    const anns = annotationsByPage.get(meta.page_number) ?? []

    for (const ann of anns) {
      try {
        await drawAnnotation(page, H, ann, font, safe)
      } catch {
        /* one bad annotation must never abort the export */
      }
    }
  }

  return doc.save()
}

async function drawAnnotation(
  page: PDFPage, H: number, ann: Annotation,
  font: (family: string, bold: boolean, italic: boolean) => Promise<PDFFont>,
  safe: (s: string) => string,
) {
  switch (ann.type) {
    case 'image': {
      const a = ann as ImageAnnotation
      if (a.src && a.src.startsWith('data:')) {
        const img = a.src.startsWith('data:image/png') ? await page.doc.embedPng(a.src) : await page.doc.embedJpg(a.src)
        page.drawImage(img, { x: a.x, y: H - a.y - a.height, width: a.width, height: a.height, opacity: a.opacity ?? 1 })
      }
      return
    }
    case 'signature': {
      // A signature is either a raster data URI or an SVG path string.
      const a = ann as SignatureAnnotation
      const data = a.signatureData
      if (data && data.startsWith('data:')) {
        const img = data.startsWith('data:image/png') ? await page.doc.embedPng(data) : await page.doc.embedJpg(data)
        page.drawImage(img, { x: a.x, y: H - a.y - a.height, width: a.width, height: a.height })
      } else if (data) {
        // SVG path: pdf-lib anchors at (x,y) and draws downward.
        page.drawSvgPath(data, { x: a.x, y: H - a.y, borderColor: rgb(0.1, 0.1, 0.1), borderWidth: 1.5 })
      }
      return
    }
    case 'highlight':
    case 'underline':
    case 'strikethrough': {
      const a = ann as MarkupAnnotation
      const col = parseColor(a.color)
      if (a.type === 'highlight') {
        page.drawRectangle({ x: a.x, y: H - a.y - a.height, width: a.width, height: a.height, color: col, opacity: a.opacity ?? 0.4 })
      } else {
        const ly = a.type === 'underline' ? H - (a.y + a.height) : H - (a.y + a.height / 2)
        page.drawLine({ start: { x: a.x, y: ly }, end: { x: a.x + a.width, y: ly }, thickness: 1.5, color: col })
      }
      return
    }
    case 'text': {
      const a = ann as TextAnnotation
      const f = await font(a.fontFamily || 'Helvetica', !!a.bold, !!a.italic)
      const size = a.fontSize
      const lines = safe(a.content).split('\n')
      const lh = size * 1.15
      lines.forEach((line, idx) => {
        page.drawText(line, { x: a.x, y: H - a.y - size - idx * lh, size, font: f, color: parseColor(a.color) })
      })
      return
    }
    case 'sticky-note': {
      const a = ann as StickyNoteAnnotation
      page.drawRectangle({ x: a.x, y: H - a.y - 20, width: 20, height: 20, color: parseColor(a.color, rgb(1, 0.9, 0.3)), borderColor: rgb(0, 0, 0), borderWidth: 0.5 })
      return
    }
    case 'freehand': {
      const a = ann as FreehandAnnotation
      if (a.points.length < 2) return
      const col = parseColor(a.color)
      for (let i = 1; i < a.points.length; i++) {
        const p0 = a.points[i - 1], p1 = a.points[i]
        page.drawLine({ start: { x: p0[0], y: H - p0[1] }, end: { x: p1[0], y: H - p1[1] }, thickness: a.strokeWidth, color: col, opacity: a.opacity ?? 1 })
      }
      return
    }
    case 'rect': {
      const a = ann as ShapeAnnotation
      page.drawRectangle({
        x: a.x, y: H - a.y - a.height, width: a.width, height: a.height,
        borderColor: parseColor(a.strokeColor), borderWidth: a.strokeWidth,
        color: a.fillColor ? parseColor(a.fillColor) : undefined, opacity: a.fillColor ? (a.fillOpacity ?? 0.1) : undefined,
      })
      return
    }
    case 'ellipse': {
      const a = ann as ShapeAnnotation
      page.drawEllipse({
        x: a.x + a.width / 2, y: H - (a.y + a.height / 2), xScale: a.width / 2, yScale: a.height / 2,
        borderColor: parseColor(a.strokeColor), borderWidth: a.strokeWidth,
        color: a.fillColor ? parseColor(a.fillColor) : undefined, opacity: a.fillColor ? (a.fillOpacity ?? 0.1) : undefined,
      })
      return
    }
    case 'line':
    case 'arrow': {
      const a = ann as ShapeAnnotation
      const col = parseColor(a.strokeColor)
      const x1 = a.x, y1 = H - a.y, x2 = a.x + a.width, y2 = H - (a.y + a.height)
      page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: a.strokeWidth, color: col })
      if (a.type === 'arrow') {
        const ang = Math.atan2(y2 - y1, x2 - x1), len = 10
        for (const off of [Math.PI * 0.82, -Math.PI * 0.82]) {
          page.drawLine({ start: { x: x2, y: y2 }, end: { x: x2 + len * Math.cos(ang + off), y: y2 + len * Math.sin(ang + off) }, thickness: a.strokeWidth, color: col })
        }
      }
      return
    }
    case 'stamp': {
      const a = ann as StampAnnotation
      const s = STAMP_LABELS[a.stampType] ?? { label: a.stampType.toUpperCase(), color: '#d93025' }
      const col = parseColor(s.color)
      page.drawRectangle({ x: a.x, y: H - a.y - a.height, width: a.width, height: a.height, borderColor: col, borderWidth: 2.5, opacity: a.opacity ?? 1, borderOpacity: a.opacity ?? 1 })
      const f = await font('Helvetica', true, false)
      const fs = 14
      const tw = f.widthOfTextAtSize(s.label, fs)
      page.drawText(s.label, { x: a.x + a.width / 2 - tw / 2, y: H - a.y - a.height / 2 - fs / 3, size: fs, font: f, color: col, opacity: a.opacity ?? 1 })
      return
    }
    case 'form-text':
    case 'form-checkbox':
    case 'form-radio':
    case 'form-dropdown':
    case 'form-date': {
      const a = ann as FormFieldAnnotation
      page.drawRectangle({ x: a.x, y: H - a.y - a.height, width: a.width, height: a.height, borderColor: rgb(0.6, 0.6, 0.6), borderWidth: 1, color: rgb(1, 1, 1) })
      if (a.type === 'form-checkbox') {
        if (a.value === true) {
          const cx = a.x, cy = H - a.y - a.height
          page.drawLine({ start: { x: cx + 3, y: cy + a.height / 2 }, end: { x: cx + a.width / 2 - 1, y: cy + 3 }, thickness: 2, color: rgb(0.1, 0.45, 0.91) })
          page.drawLine({ start: { x: cx + a.width / 2 - 1, y: cy + 3 }, end: { x: cx + a.width - 2, y: cy + a.height - 3 }, thickness: 2, color: rgb(0.1, 0.45, 0.91) })
        }
      } else if (a.value != null && String(a.value)) {
        const f = await font('Helvetica', false, false)
        page.drawText(safe(String(a.value)), { x: a.x + 4, y: H - a.y - a.height / 2 - 4, size: 12, font: f, color: rgb(0.2, 0.2, 0.2) })
      }
      return
    }
  }
}
