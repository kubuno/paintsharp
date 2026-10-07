// Flatten every annotation of every page into a real PDF using pdf-lib, so the
// exported file looks the same in any reader instead of being the bare source.
//
// Coordinate systems: annotations are stored in PDF points with a TOP-LEFT origin
// and y growing DOWNWARD (pdf.js convention). pdf-lib uses a BOTTOM-LEFT origin
// with y growing UPWARD, so every y is converted as `pageHeight - y`.
//
// Fonts: families matching a PDF standard-14 font are mapped onto it (no
// embedding); families registered from drive System/Fonts are embedded with
// fontkit (subset) so the export uses the exact same font as the editor.
import {
  PDFDocument, StandardFonts, rgb, degrees, LineCapStyle,
  pushGraphicsState, popGraphicsState, concatTransformationMatrix,
  type PDFFont, type PDFPage, type RGB,
} from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import { getEmbeddableFontBytes } from './pdfFonts'
import type {
  Annotation, TextAnnotation, MarkupAnnotation, StickyNoteAnnotation, FreehandAnnotation,
  ShapeAnnotation, StampAnnotation, SignatureAnnotation, ImageAnnotation, FormFieldAnnotation,
} from './api'

export interface ExportPage {
  page_number: number
  width: number
  height: number
  /** Extra display rotation (degrees, clockwise) applied on top of the source page. */
  rotation: number
  /** Index of the page in the source binary (null/undefined = blank page). */
  sourceIndex?: number | null
}

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

// Dash patterns for the shape line styles (scaled a little by stroke width).
function dashArray(style: string | undefined, sw: number): number[] | undefined {
  if (style === 'dashed') return [Math.max(4, sw * 3), Math.max(3, sw * 2)]
  if (style === 'dotted') return [Math.max(0.8, sw * 0.8), Math.max(2.5, sw * 2)]
  return undefined
}

interface FontResolver { (family: string, bold: boolean, italic: boolean): Promise<PDFFont> }

// Map smart punctuation onto WinAnsi equivalents, drop what the standard-14
// fonts cannot encode. Only applied when falling back to a non-embedded font.
function winAnsiSafe(s: string): string {
  return (s || '')
    .replace(/[‘’‚]/g, "'").replace(/[“”„]/g, '"')
    .replace(/[–−]/g, '-').replace(/—/g, '--').replace(/…/g, '...')
    .replace(/[   ]/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x20-\x7E\xA1-\xFF€ŒœŠšŽžŸƒ•†‡ˆ˜™‹›‰]/g, '')
}

const stripControl = (s: string) => (s || '').replace(/[\x00-\x09\x0B-\x1F]/g, '') // eslint-disable-line no-control-regex

/** Greedy word-wrap on explicit newlines + max width (PDF points). */
function wrapLines(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const out: string[] = []
  const width = (s: string) => { try { return font.widthOfTextAtSize(s, size) } catch { return s.length * size * 0.5 } }
  for (const para of text.split('\n')) {
    if (maxWidth <= 4 || width(para) <= maxWidth) { out.push(para); continue }
    let line = ''
    for (const word of para.split(/(\s+)/)) {
      if (!line) { line = word; continue }
      if (width(line + word) <= maxWidth) line += word
      else { out.push(line.trimEnd()); line = word.trimStart() }
    }
    out.push(line.trimEnd())
  }
  return out
}

// Wrap a draw callback in a rotation about the element's bbox center. The stored
// rotation is clockwise on screen (y-down) → −θ in PDF space (y-up).
function withRotation(page: PDFPage, H: number, ann: { rotation?: number; x: number; y: number; width?: number; height?: number }, draw: () => void) {
  const rot = ann.rotation ?? 0
  if (!rot) { draw(); return }
  const cx = ann.x + (ann.width ?? 0) / 2
  const cy = H - (ann.y + (ann.height ?? 0) / 2)
  const phi = (-rot * Math.PI) / 180
  const cos = Math.cos(phi), sin = Math.sin(phi)
  page.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(cos, sin, -sin, cos, cx - cx * cos + cy * sin, cy - cx * sin - cy * cos),
  )
  try { draw() } finally { page.pushOperators(popGraphicsState()) }
}

/** Bounds of an M/L-only SVG path (the format produced by the signature pad). */
export function svgPathBounds(d: string): { x: number; y: number; w: number; h: number } | null {
  const nums = d.match(/-?\d+(?:\.\d+)?/g)
  if (!nums || nums.length < 4) return null
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (let i = 0; i + 1 < nums.length; i += 2) {
    const x = +nums[i], y = +nums[i + 1]
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (y < minY) minY = y; if (y > maxY) maxY = y
  }
  if (!Number.isFinite(minX)) return null
  return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) }
}

export async function buildAnnotatedPdf(opts: {
  sourceBytes: ArrayBuffer | null
  pages: ExportPage[]
  annotationsByPage: Map<number, Annotation[]>
}): Promise<Uint8Array> {
  const { sourceBytes, pages, annotationsByPage } = opts

  // The output is REBUILT page by page (copyPages) instead of edited in place:
  // this is what makes page reordering and deletions come out right even though
  // the source binary still has its original page order.
  const srcDoc = sourceBytes ? await PDFDocument.load(sourceBytes, { ignoreEncryption: true }) : null
  const doc = await PDFDocument.create()
  doc.registerFontkit(fontkit)

  // Lazily-embedded fonts (one instance each, reused across pages). System fonts
  // (real bytes) win over the standard-14 mapping.
  const fontCache = new Map<string, PDFFont>()
  const embedded = new Set<string>()      // cache keys backed by an embedded (full Unicode) font
  const font: FontResolver = async (family, bold, italic) => {
    const customKey = `sys:${(family || '').toLowerCase()}:${bold ? 1 : 0}${italic ? 1 : 0}`
    const cachedCustom = fontCache.get(customKey)
    if (cachedCustom) return cachedCustom
    const bytes = getEmbeddableFontBytes(family, bold, italic)
    if (bytes) {
      try {
        const f = await doc.embedFont(bytes, { subset: true })
        fontCache.set(customKey, f); embedded.add(customKey)
        return f
      } catch { /* unparsable → fall back to standard */ }
    }
    const fl = (family || '').toLowerCase()
    const serif = /times|serif|georgia|garamond|book/.test(fl)
    const mono = /courier|mono|consol/.test(fl)
    let name: StandardFonts
    if (mono) name = bold ? (italic ? StandardFonts.CourierBoldOblique : StandardFonts.CourierBold) : (italic ? StandardFonts.CourierOblique : StandardFonts.Courier)
    else if (serif) name = bold ? (italic ? StandardFonts.TimesRomanBoldItalic : StandardFonts.TimesRomanBold) : (italic ? StandardFonts.TimesRomanItalic : StandardFonts.TimesRoman)
    else name = bold ? (italic ? StandardFonts.HelveticaBoldOblique : StandardFonts.HelveticaBold) : (italic ? StandardFonts.HelveticaOblique : StandardFonts.Helvetica)
    const cached = fontCache.get(name)
    if (cached) return cached
    const std = await doc.embedFont(name)
    fontCache.set(name, std)
    return std
  }
  const isEmbedded = (family: string, bold: boolean, italic: boolean) =>
    embedded.has(`sys:${(family || '').toLowerCase()}:${bold ? 1 : 0}${italic ? 1 : 0}`)

  const srcCount = srcDoc?.getPageCount() ?? 0
  for (let i = 0; i < pages.length; i++) {
    const meta = pages[i]
    let page: PDFPage
    let intrinsic = 0
    if (srcDoc && meta.sourceIndex != null && meta.sourceIndex >= 0 && meta.sourceIndex < srcCount) {
      const [copied] = await doc.copyPages(srcDoc, [meta.sourceIndex])
      page = doc.addPage(copied)
      intrinsic = copied.getRotation().angle
    } else {
      page = doc.addPage([meta.width, meta.height])   // blank page (no backing source page)
    }
    // Total display rotation = the source page's own /Rotate + the extra rotation
    // applied in the editor. Annotations are recorded in the DISPLAYED space, so
    // when the total is non-zero we prepend a matrix mapping displayed
    // coordinates onto the page's content space (see below).
    const rtot = (((intrinsic + (meta.rotation || 0)) % 360) + 360) % 360
    if (rtot !== intrinsic) page.setRotation(degrees(rtot))
    const W = page.getWidth(), Hc = page.getHeight()
    const [Wd, Hd] = rtot % 180 !== 0 ? [Hc, W] : [W, Hc]
    if (rtot === 90)       page.pushOperators(pushGraphicsState(), concatTransformationMatrix(0, 1, -1, 0, Hd, 0))
    else if (rtot === 180) page.pushOperators(pushGraphicsState(), concatTransformationMatrix(-1, 0, 0, -1, Wd, Hd))
    else if (rtot === 270) page.pushOperators(pushGraphicsState(), concatTransformationMatrix(0, -1, 1, 0, 0, Wd))

    const anns = annotationsByPage.get(meta.page_number) ?? []
    for (const ann of anns) {
      try {
        await drawAnnotation(page, Hd, ann, font, isEmbedded)
      } catch {
        /* one bad annotation must never abort the export */
      }
    }
    if (rtot !== 0) page.pushOperators(popGraphicsState())
  }

  return doc.save()
}

async function drawAnnotation(
  page: PDFPage, H: number, ann: Annotation,
  font: FontResolver,
  isEmbedded: (family: string, bold: boolean, italic: boolean) => boolean,
) {
  switch (ann.type) {
    case 'image': {
      const a = ann as ImageAnnotation
      if (a.src && a.src.startsWith('data:')) {
        const img = a.src.startsWith('data:image/png') ? await page.doc.embedPng(a.src) : await page.doc.embedJpg(a.src)
        withRotation(page, H, a, () => {
          page.drawImage(img, { x: a.x, y: H - a.y - a.height, width: a.width, height: a.height, opacity: a.opacity ?? 1 })
        })
      }
      return
    }
    case 'signature': {
      // A signature is either a raster data URI or an SVG path string (pad px).
      const a = ann as SignatureAnnotation
      const data = a.signatureData
      if (data && data.startsWith('data:')) {
        const img = data.startsWith('data:image/png') ? await page.doc.embedPng(data) : await page.doc.embedJpg(data)
        withRotation(page, H, a, () => {
          page.drawImage(img, { x: a.x, y: H - a.y - a.height, width: a.width, height: a.height })
        })
      } else if (data) {
        // Scale the pad-pixel path to fit the placed box (like the editor does).
        const b = svgPathBounds(data)
        const sx = b ? a.width / b.w : 1
        const sy = b ? a.height / b.h : 1
        const s = Math.min(sx, sy)
        const ox = b ? a.x - b.x * s + (a.width - b.w * s) / 2 : a.x
        const oy = b ? a.y - b.y * s + (a.height - b.h * s) / 2 : a.y
        withRotation(page, H, a, () => {
          page.pushOperators(pushGraphicsState(), concatTransformationMatrix(s, 0, 0, s, ox, H - oy - 0))
          // After this matrix, drawSvgPath at (0,0) maps pad coords 1:1 (y flipped by drawSvgPath itself).
          page.drawSvgPath(data, { x: 0, y: 0, borderColor: parseColor(a.color, rgb(0.1, 0.1, 0.1)), borderWidth: 1.5 / s, borderLineCap: LineCapStyle.Round })
          page.pushOperators(popGraphicsState())
        })
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
      const sanitize = isEmbedded(a.fontFamily || 'Helvetica', !!a.bold, !!a.italic) ? stripControl : (s: string) => winAnsiSafe(stripControl(s))
      const content = sanitize(a.content)
      const opacity = a.invisible ? 0 : 1
      withRotation(page, H, a, () => {
        // Background / border of the text box (skipped for the invisible OCR layer).
        if (!a.invisible && a.backgroundColor) {
          page.drawRectangle({ x: a.x, y: H - a.y - a.height, width: a.width, height: a.height, color: parseColor(a.backgroundColor) })
        }
        if (!a.invisible && a.borderColor) {
          page.drawRectangle({ x: a.x, y: H - a.y - a.height, width: a.width, height: a.height, borderColor: parseColor(a.borderColor), borderWidth: 1 })
        }
        const scaleX = a.scaleX != null && a.scaleX !== 1 ? a.scaleX : null
        if (scaleX) {
          // Extracted fragment: single line, horizontally scaled about its left edge.
          page.pushOperators(pushGraphicsState(), concatTransformationMatrix(scaleX, 0, 0, 1, a.x * (1 - scaleX), 0))
        }
        const lines = scaleX ? [content.replace(/\n/g, ' ')] : wrapLines(content, f, size, a.width - 4)
        const lh = size * 1.2
        const col = parseColor(a.color)
        const width = (s: string) => { try { return f.widthOfTextAtSize(s, size) } catch { return s.length * size * 0.5 } }
        lines.forEach((line, idx) => {
          if (!line) return
          let lx = a.x + (scaleX ? 0 : 2)
          if (!scaleX && a.align === 'center') lx = a.x + (a.width - width(line)) / 2
          else if (!scaleX && a.align === 'right') lx = a.x + a.width - width(line) - 2
          const baselineY = H - a.y - size - idx * lh
          try { page.drawText(line, { x: lx, y: baselineY, size, font: f, color: col, opacity }) }
          catch {
            const fallback = winAnsiSafe(line)
            if (fallback) { try { page.drawText(fallback, { x: lx, y: baselineY, size, font: f, color: col, opacity }) } catch { /* skip line */ } }
          }
          if (a.underline && !a.invisible) {
            page.drawLine({ start: { x: lx, y: baselineY - size * 0.12 }, end: { x: lx + width(line), y: baselineY - size * 0.12 }, thickness: Math.max(0.6, size / 16), color: col, opacity })
          }
        })
        if (scaleX) page.pushOperators(popGraphicsState())
      })
      return
    }
    case 'sticky-note': {
      const a = ann as StickyNoteAnnotation
      const col = parseColor(a.color, rgb(1, 0.9, 0.3))
      page.drawRectangle({ x: a.x, y: H - a.y - 20, width: 20, height: 20, color: col, borderColor: rgb(0, 0, 0), borderWidth: 0.5 })
      if (a.isOpen && a.content) {
        const f = await font('Helvetica', false, false)
        const size = 9
        const boxW = 150
        const lines = wrapLines(winAnsiSafe(stripControl(a.content)), f, size, boxW - 10)
        const boxH = lines.length * size * 1.25 + 10
        page.drawRectangle({ x: a.x + 24, y: H - a.y - boxH, width: boxW, height: boxH, color: col, borderColor: rgb(0, 0, 0), borderWidth: 0.5, opacity: 0.95 })
        lines.forEach((line, idx) => {
          try { page.drawText(line, { x: a.x + 29, y: H - a.y - size - 5 - idx * size * 1.25, size, font: f, color: rgb(0.15, 0.15, 0.15) }) } catch { /* skip */ }
        })
      }
      return
    }
    case 'freehand': {
      const a = ann as FreehandAnnotation
      if (a.points.length < 2) return
      const col = parseColor(a.color)
      // Smoothed quadratic path through segment midpoints — same as the editor.
      const pts = a.points
      let d = `M${pts[0][0].toFixed(2)},${pts[0][1].toFixed(2)}`
      for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2
        d += ` Q${pts[i][0].toFixed(2)},${pts[i][1].toFixed(2)} ${mx.toFixed(2)},${my.toFixed(2)}`
      }
      const last = pts[pts.length - 1]
      d += ` L${last[0].toFixed(2)},${last[1].toFixed(2)}`
      // drawSvgPath interprets path y as growing downward from the anchor → anchor at page top-left.
      page.drawSvgPath(d, { x: 0, y: H, borderColor: col, borderWidth: a.strokeWidth, borderOpacity: a.opacity ?? 1, borderLineCap: LineCapStyle.Round })
      return
    }
    case 'rect': {
      const a = ann as ShapeAnnotation
      withRotation(page, H, a, () => {
        page.drawRectangle({
          x: a.x, y: H - a.y - a.height, width: a.width, height: a.height,
          borderColor: parseColor(a.strokeColor), borderWidth: a.strokeWidth,
          borderDashArray: dashArray(a.lineStyle, a.strokeWidth),
          color: a.fillColor ? parseColor(a.fillColor) : undefined, opacity: a.fillColor ? (a.fillOpacity ?? 0.1) : undefined,
          borderOpacity: a.opacity ?? 1,
        })
      })
      return
    }
    case 'ellipse': {
      const a = ann as ShapeAnnotation
      withRotation(page, H, a, () => {
        page.drawEllipse({
          x: a.x + a.width / 2, y: H - (a.y + a.height / 2), xScale: a.width / 2, yScale: a.height / 2,
          borderColor: parseColor(a.strokeColor), borderWidth: a.strokeWidth,
          borderDashArray: dashArray(a.lineStyle, a.strokeWidth),
          color: a.fillColor ? parseColor(a.fillColor) : undefined, opacity: a.fillColor ? (a.fillOpacity ?? 0.1) : undefined,
          borderOpacity: a.opacity ?? 1,
        })
      })
      return
    }
    case 'line':
    case 'arrow': {
      const a = ann as ShapeAnnotation
      const col = parseColor(a.strokeColor)
      const x1 = a.x, y1 = H - a.y, x2 = a.x + a.width, y2 = H - (a.y + a.height)
      page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: a.strokeWidth, color: col, opacity: a.opacity ?? 1, dashArray: dashArray(a.lineStyle, a.strokeWidth), lineCap: LineCapStyle.Round })
      if (a.type === 'arrow') {
        // Filled triangular head, sized with the stroke width.
        const ang = Math.atan2(y2 - y1, x2 - x1)
        const len = Math.max(9, a.strokeWidth * 4.5), spread = Math.PI / 7
        const p1 = { x: x2 - len * Math.cos(ang - spread), y: y2 - len * Math.sin(ang - spread) }
        const p2 = { x: x2 - len * Math.cos(ang + spread), y: y2 - len * Math.sin(ang + spread) }
        // drawSvgPath flips y around the anchor → feed it pre-flipped coordinates.
        const d = `M${x2.toFixed(2)},${(H - y2).toFixed(2)} L${p1.x.toFixed(2)},${(H - p1.y).toFixed(2)} L${p2.x.toFixed(2)},${(H - p2.y).toFixed(2)} Z`
        page.drawSvgPath(d, { x: 0, y: H, color: col, borderColor: col, borderWidth: 0.5, borderOpacity: a.opacity ?? 1 })
      }
      return
    }
    case 'stamp': {
      const a = ann as StampAnnotation
      const s = a.stampType === 'custom'
        ? { label: (a.customLabel || 'STAMP').toUpperCase(), color: a.color || '#d93025' }
        : STAMP_LABELS[a.stampType] ?? { label: a.stampType.toUpperCase(), color: '#d93025' }
      const col = parseColor(s.color)
      const f = await font('Helvetica', true, false)
      withRotation(page, H, a, () => {
        page.drawRectangle({ x: a.x, y: H - a.y - a.height, width: a.width, height: a.height, borderColor: col, borderWidth: 2.5, opacity: a.opacity ?? 1, borderOpacity: a.opacity ?? 1 })
        // Fit the label: scale with box height, shrink until it fits the width.
        let fs = Math.min(20, Math.max(8, a.height * 0.42))
        const label = winAnsiSafe(s.label)
        let tw = f.widthOfTextAtSize(label, fs)
        while (tw > a.width - 12 && fs > 6) { fs -= 1; tw = f.widthOfTextAtSize(label, fs) }
        page.drawText(label, { x: a.x + a.width / 2 - tw / 2, y: H - a.y - a.height / 2 - fs / 3, size: fs, font: f, color: col, opacity: a.opacity ?? 1 })
      })
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
        try { page.drawText(winAnsiSafe(stripControl(String(a.value))), { x: a.x + 4, y: H - a.y - a.height / 2 - 4, size: 12, font: f, color: rgb(0.2, 0.2, 0.2) }) } catch { /* skip */ }
      }
      return
    }
  }
}
