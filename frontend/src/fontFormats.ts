// Multi-format import/export for FontEditor.
//
//   Import : TTF, OTF, WOFF (opentype.js) — WOFF2, EOT, SVG font (fonteditor-core)
//   Export : OTF (opentype.js) · TTF (native writer, carries `kern`) ·
//            WOFF/WOFF2/EOT/SVG (converted from the TTF build via fonteditor-core)
//
// fonteditor-core (and its WOFF2 wasm) is only loaded on demand.
import { parse as parseOpentype, type Font as OtFont } from 'opentype.js'
import { filesApi } from '@kubuno/drive'
import { fontApi, type FontContour, type FontData, type FontGlyphPoint } from './api'
import { buildOtfFont } from './fontExport'
import { buildTtf } from './fontTtf'
import { countDrawnGlyphs } from './fontGeometry'

export type FontFileFormat = 'ttf' | 'otf' | 'woff' | 'woff2' | 'eot' | 'svg'

export const EXPORT_FORMATS: FontFileFormat[] = ['otf', 'ttf', 'woff', 'woff2', 'eot', 'svg']
export const IMPORT_ACCEPT = '.ttf,.otf,.woff,.woff2,.eot,.svg'

const MIME: Record<FontFileFormat, string> = {
  ttf:   'font/ttf',
  otf:   'font/otf',
  woff:  'font/woff',
  woff2: 'font/woff2',
  eot:   'application/vnd.ms-fontobject',
  svg:   'image/svg+xml',
}

// ── fonteditor-core (lazy, wasm for WOFF2) ──────────────────────────────────────

async function loadConverter(needWoff2: boolean) {
  const core = await import('fonteditor-core')
  if (needWoff2 && !core.woff2.isInited()) {
    // The wasm is imported by relative path (the package `exports` map does not
    // expose it). In the browser init() REQUIRES a URL string — its emscripten
    // locateFile fetches it itself (a buffer would hang the never-rejecting init).
    const { default: wasmUrl } = await import('../node_modules/fonteditor-core/woff2/woff2.wasm?url')
    await core.woff2.init(wasmUrl)
  }
  return core
}

// ── opentype.js font → FontData ─────────────────────────────────────────────────

function pathToContours(path: { commands: { type: string; x?: number; y?: number; x1?: number; y1?: number; x2?: number; y2?: number }[] }): FontContour[] {
  const contours: FontContour[] = []
  let cur: FontContour | null = null
  const R = Math.round
  const closeCurrent = () => {
    if (!cur) return
    // Drop a duplicated closing point (same coords as the first anchor).
    if (cur.length >= 2) {
      const a = cur[0], b = cur[cur.length - 1]
      if (a.x === b.x && a.y === b.y && !b.hOut) {
        if (b.hIn) a.hIn = b.hIn
        cur.pop()
      }
    }
    if (cur.length >= 2) contours.push(cur)
    cur = null
  }
  for (const c of path.commands) {
    switch (c.type) {
      case 'M':
        closeCurrent()
        cur = [{ x: R(c.x!), y: R(c.y!) }]
        break
      case 'L':
        cur?.push({ x: R(c.x!), y: R(c.y!) })
        break
      case 'C': {
        if (!cur) break
        const prev = cur[cur.length - 1]
        prev.hOut = [R(c.x1!), R(c.y1!)]
        cur.push({ x: R(c.x!), y: R(c.y!), hIn: [R(c.x2!), R(c.y2!)] })
        break
      }
      case 'Q': {
        // Exact quadratic → cubic elevation.
        if (!cur) break
        const prev = cur[cur.length - 1]
        const qx = c.x1!, qy = c.y1!
        prev.hOut = [R(prev.x + (2 / 3) * (qx - prev.x)), R(prev.y + (2 / 3) * (qy - prev.y))]
        cur.push({
          x: R(c.x!), y: R(c.y!),
          hIn: [R(c.x! + (2 / 3) * (qx - c.x!)), R(c.y! + (2 / 3) * (qy - c.y!))],
        })
        break
      }
      case 'Z':
        closeCurrent()
        break
    }
  }
  closeCurrent()
  return contours
}

function otFontToFontData(font: OtFont): FontData {
  const upem = font.unitsPerEm || 1000
  const tables = (font as unknown as { tables?: { os2?: { sxHeight?: number; sCapHeight?: number } } }).tables
  const data: FontData = {
    familyName: font.names?.fontFamily?.en ?? 'Police importée',
    styleName:  font.names?.fontSubfamily?.en ?? 'Regular',
    unitsPerEm: upem,
    ascender:   Math.round(font.ascender || upem * 0.8),
    descender:  Math.round(font.descender || -upem * 0.2),
    capHeight:  Math.round(tables?.os2?.sCapHeight || upem * 0.7),
    xHeight:    Math.round(tables?.os2?.sxHeight || upem * 0.5),
    glyphs:     {},
    kerning:    [],
  }

  const gidToUnicode = new Map<number, number>()
  for (let i = 0; i < font.numGlyphs; i++) {
    const g = font.glyphs.get(i)
    const unicodes: number[] = ((g as unknown as { unicodes?: number[] }).unicodes ?? (g.unicode != null ? [g.unicode] : []))
      .filter(u => u > 0)
    if (!unicodes.length) continue
    const contours = pathToContours(g.path as unknown as Parameters<typeof pathToContours>[0])
    const advance = Math.round(g.advanceWidth ?? upem / 2)
    gidToUnicode.set(i, unicodes[0])
    for (const u of unicodes) {
      data.glyphs[String(u)] = {
        unicode:  u,
        advance,
        contours: JSON.parse(JSON.stringify(contours)) as FontContour[],
      }
    }
  }

  // Kerning pairs from the legacy `kern` table (gid pairs → unicode pairs).
  const kerningPairs = (font as unknown as { kerningPairs?: Record<string, number> }).kerningPairs ?? {}
  for (const [key, value] of Object.entries(kerningPairs)) {
    const [lg, rg] = key.split(',').map(Number)
    const l = gidToUnicode.get(lg), r = gidToUnicode.get(rg)
    if (l != null && r != null && value) data.kerning.push({ left: l, right: r, value: Math.round(value) })
  }
  return data
}

// ── Import: any supported buffer → FontData ─────────────────────────────────────

export function formatOfFileName(name: string): FontFileFormat | null {
  const m = /\.(ttf|otf|woff2|woff|eot|svg)$/i.exec(name)
  return m ? (m[1].toLowerCase() as FontFileFormat) : null
}

export async function bufferToFontData(buf: ArrayBuffer, format: FontFileFormat): Promise<FontData> {
  if (format === 'ttf' || format === 'otf' || format === 'woff') {
    return otFontToFontData(parseOpentype(buf))
  }
  // WOFF2 / EOT / SVG font → convert to a plain TTF first.
  const core = await loadConverter(format === 'woff2')
  const input = format === 'svg' ? new TextDecoder().decode(buf) : buf
  const f = core.Font.create(input, { type: format, hinting: false, kerning: true })
  const ttf = f.write({ type: 'ttf', toBuffer: false, kerning: true }) as ArrayBuffer
  return otFontToFontData(parseOpentype(ttf))
}

// ── Export: FontData → file of the requested format ─────────────────────────────

export async function fontDataToBlob(data: FontData, format: FontFileFormat): Promise<Blob> {
  if (format === 'otf') return new Blob([buildOtfFont(data).toArrayBuffer()], { type: MIME.otf })
  const ttf = buildTtf(data)
  if (format === 'ttf') return new Blob([ttf], { type: MIME.ttf })
  const core = await loadConverter(format === 'woff2')
  const f = core.Font.create(ttf, { type: 'ttf', hinting: false, kerning: true })
  const out = f.write({ type: format, toBuffer: false, kerning: true }) as ArrayBuffer | string
  return typeof out === 'string' ? new Blob([out], { type: MIME.svg }) : new Blob([out], { type: MIME[format] })
}

/** Exports as `<family>.<fmt>`: uploads to Files (root) + browser download. */
export async function exportFont(data: FontData, format: FontFileFormat, fallbackName = 'police'): Promise<string> {
  const blob = await fontDataToBlob(data, format)
  const base = (data.familyName || fallbackName).trim().replace(/[/\\]/g, '-') || fallbackName
  const name = `${base}.${format}`

  await filesApi.uploadFile(new File([blob], name, { type: blob.type }), null)

  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
  return name
}

// ── "Open with" from Files: font file → new FontEditor project ──────────────────

export async function openFontFileAsProject(file: { id: string; name: string }): Promise<string> {
  const format = formatOfFileName(file.name)
  if (!format) throw new Error(`format inconnu: ${file.name}`)
  const res = await fetch(filesApi.downloadUrl(file.id), { credentials: 'include' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await bufferToFontData(await res.arrayBuffer(), format)
  const title = file.name.replace(/\.[^.]+$/, '')
  const { id } = (await fontApi.createProject({ title })).data
  await fontApi.saveData(id, data, countDrawnGlyphs(data))
  return id
}

/** Imports a browser-picked file into a new project; returns the project id. */
export async function importPickedFontAsProject(f: File): Promise<string> {
  const format = formatOfFileName(f.name)
  if (!format) throw new Error(`format inconnu: ${f.name}`)
  const data = await bufferToFontData(await f.arrayBuffer(), format)
  const title = f.name.replace(/\.[^.]+$/, '')
  const { id } = (await fontApi.createProject({ title })).data
  await fontApi.saveData(id, data, countDrawnGlyphs(data))
  return id
}
