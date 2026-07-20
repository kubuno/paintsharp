// PdfWriter font support.
//
// Two complementary sources:
//  1. A curated list of built-in families that map cleanly onto the PDF
//     standard-14 fonts (always exportable without embedding).
//  2. Shared fonts dropped by an admin in the drive System/Fonts folder: each
//     file is registered in the browser via `FontFace` (correct on-canvas
//     rendering) AND its raw bytes are kept in a registry so the PDF export can
//     embed the real font with fontkit — the exported file uses the same font
//     as the editor.
//
// Everything is best-effort and non-blocking: an empty folder or a network
// error leaves the editor working on its built-in families.
import { useQuery } from '@tanstack/react-query'
import { systemApi, type FileItem } from '@kubuno/drive'
import { parseFontMeta } from '@ui'

// Fixed folder id created by the drive migration (system owner).
const FONTS_FOLDER_ID = '00000000-0000-0000-0000-0000000005a2'
const FONT_EXTS = ['ttf', 'otf', 'woff', 'woff2']

/** Families PdfWriter always offers; each maps to a PDF standard-14 font at export. */
export const PDF_BASE_FONTS: readonly string[] = [
  'Helvetica',
  'Arial',
  'Verdana',
  'Tahoma',
  'Trebuchet MS',
  'Times New Roman',
  'Georgia',
  'Garamond',
  'Courier New',
]

function ext(name: string): string { return (name.split('.').pop() ?? '').toLowerCase() }
function baseName(name: string): string { return name.replace(/\.[^.]+$/, '') }

interface FontVariant { bytes: ArrayBuffer; weight: number; italic: boolean }

// family (lowercased) → registered variants with their raw bytes (for pdf-lib).
const variantsByFamily = new Map<string, FontVariant[]>()
// file id → family, so refetches never re-download / re-register a file.
const processedFiles = new Map<string, string>()

/**
 * Lists System/Fonts, registers each file as a browser `FontFace` under its REAL
 * family name (read from the font's `name` table, so Calibri Bold/Light/Italic all
 * land under one "Calibri" entry) and memorizes the bytes for PDF embedding.
 * Returns the list of family names found.
 */
export async function loadSystemFonts(): Promise<string[]> {
  let files: FileItem[]
  try { files = (await systemApi.listFiles(FONTS_FOLDER_ID)).files }
  catch { return [] }

  const families: string[] = []
  const addFamily = (fam: string) => {
    if (fam && !families.some(x => x.toLowerCase() === fam.toLowerCase())) families.push(fam)
  }

  for (const f of files) {
    if (!FONT_EXTS.includes(ext(f.name))) continue
    const cached = processedFiles.get(f.id)
    if (cached) { addFamily(cached); continue }
    try {
      const buf  = await (await systemApi.downloadBlob(f.id)).arrayBuffer()
      const meta = parseFontMeta(buf)
      const family = meta?.family ?? baseName(f.name)
      const weight = meta?.weight ?? 400
      const style  = meta?.style ?? 'normal'
      const face = await new FontFace(family, buf, { weight: String(weight), style }).load()
      document.fonts.add(face)
      const key = family.toLowerCase()
      const list = variantsByFamily.get(key) ?? []
      list.push({ bytes: buf, weight, italic: style === 'italic' })
      variantsByFamily.set(key, list)
      processedFiles.set(f.id, family)
      addFamily(family)
    } catch { /* unreadable file → skipped */ }
  }
  return families
}

/** React hook: built-in families + System/Fonts families (deduped, base first). */
export function usePdfFonts(): string[] {
  const { data = [] } = useQuery({ queryKey: ['system-fonts'], queryFn: loadSystemFonts, staleTime: 60_000 })
  const seen = new Set(PDF_BASE_FONTS.map(f => f.toLowerCase()))
  return [...PDF_BASE_FONTS, ...data.filter(f => !seen.has(f.toLowerCase()) && (seen.add(f.toLowerCase()), true))]
}

/**
 * Returns the raw bytes of the System/Fonts variant closest to (family, bold,
 * italic), or null when the family is not a shared system font — the export then
 * falls back to the standard-14 mapping. WOFF/WOFF2 bytes are excluded (fontkit
 * only parses TTF/OTF): their variants are registered for canvas display only.
 */
export function getEmbeddableFontBytes(family: string, bold: boolean, italic: boolean): ArrayBuffer | null {
  const list = variantsByFamily.get((family || '').toLowerCase())
  if (!list?.length) return null
  const embeddable = list.filter(v => isSfnt(v.bytes))
  if (!embeddable.length) return null
  const targetW = bold ? 700 : 400
  let best = embeddable[0], bestScore = Infinity
  for (const v of embeddable) {
    const score = Math.abs(v.weight - targetW) + (v.italic === italic ? 0 : 1000)
    if (score < bestScore) { best = v; bestScore = score }
  }
  return best.bytes
}

// TTF/OTF/TTC magic numbers (sfnt containers fontkit can parse).
function isSfnt(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 4) return false
  const tag = new DataView(buf).getUint32(0)
  return tag === 0x00010000 || tag === 0x4f54544f /* OTTO */ || tag === 0x74727565 /* true */ || tag === 0x74746366 /* ttcf */
}
