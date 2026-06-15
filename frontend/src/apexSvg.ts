/**
 * Import / export SVG pour l'éditeur vectoriel Apex.
 *
 * Apex manipule un modèle interne `VectorPageData` (rect/ellipse/path/text +
 * remplissages/contours/dégradés). Ces fonctions convertissent ce modèle
 * depuis/vers du SVG standard, pour ouvrir, éditer puis ré-enregistrer des
 * fichiers `.svg` — le rendu canvas d'Apex mappe déjà 1:1 sur les primitives SVG.
 */
import type {
  VectorPageData, VectorElement, BaseElement, PathPoint,
  FillStyle, StrokeStyle, RectElement, EllipseElement, PathElement, TextElement,
} from './api'

// ─────────────────────────────────────────────────────────────────────────────
// EXPORT : VectorPageData → texte SVG
// ─────────────────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
function num(n: number): string {
  return (Math.round(n * 1000) / 1000).toString()
}

function pathToD(points: PathPoint[], closed: boolean): string {
  if (!points.length) return ''
  const out: string[] = []
  let subStart = 0
  const closeSub = (end: number) => {
    if (closed && end - subStart >= 1) {
      const a = points[end], b = points[subStart]
      out.push(`C ${num(a.x + (a.hOut?.[0] ?? 0))} ${num(a.y + (a.hOut?.[1] ?? 0))} ${num(b.x + (b.hIn?.[0] ?? 0))} ${num(b.y + (b.hIn?.[1] ?? 0))} ${num(b.x)} ${num(b.y)}`)
      out.push('Z')
    }
  }
  out.push(`M ${num(points[0].x)} ${num(points[0].y)}`)
  for (let i = 1; i < points.length; i++) {
    if (points[i].move) { closeSub(i - 1); out.push(`M ${num(points[i].x)} ${num(points[i].y)}`); subStart = i; continue }
    const p = points[i - 1], c = points[i]
    out.push(`C ${num(p.x + (p.hOut?.[0] ?? 0))} ${num(p.y + (p.hOut?.[1] ?? 0))} ${num(c.x + (c.hIn?.[0] ?? 0))} ${num(c.y + (c.hIn?.[1] ?? 0))} ${num(c.x)} ${num(c.y)}`)
  }
  closeSub(points.length - 1)
  return out.join(' ')
}

function fillAttrs(el: BaseElement, defs: string[]): string {
  const f = el.fill
  if (!f || f.type === 'none') return 'fill="none"'
  if (f.type === 'solid') return `fill="${esc(f.color)}"${f.opacity < 100 ? ` fill-opacity="${num(f.opacity / 100)}"` : ''}`
  // dégradés → paint server dans <defs>
  const gid = `grad-${el.id}`
  const stops = [...f.stops].sort((a, b) => a.position - b.position)
    .map(s => `<stop offset="${num(s.position)}" stop-color="${esc(s.color)}"${s.opacity < 100 ? ` stop-opacity="${num(s.opacity / 100)}"` : ''}/>`).join('')
  if (f.type === 'linear-gradient') {
    const a = ((f.angle ?? 0) * Math.PI) / 180
    const dx = Math.cos(a) / 2, dy = Math.sin(a) / 2
    defs.push(`<linearGradient id="${gid}" x1="${num(0.5 - dx)}" y1="${num(0.5 - dy)}" x2="${num(0.5 + dx)}" y2="${num(0.5 + dy)}">${stops}</linearGradient>`)
  } else {
    defs.push(`<radialGradient id="${gid}" cx="0.5" cy="0.5" r="0.5">${stops}</radialGradient>`)
  }
  return `fill="url(#${gid})"`
}

function strokeAttrs(s: StrokeStyle | null): string {
  if (!s || s.width <= 0) return ''
  let a = ` stroke="${esc(s.color)}" stroke-width="${num(s.width)}"`
  if (s.opacity < 100) a += ` stroke-opacity="${num(s.opacity / 100)}"`
  if (s.dashArray && s.dashArray.length) a += ` stroke-dasharray="${s.dashArray.map(num).join(' ')}"`
  if (s.cap && s.cap !== 'butt') a += ` stroke-linecap="${s.cap}"`
  if (s.join && s.join !== 'miter') a += ` stroke-linejoin="${s.join}"`
  return a
}

function elementToSvg(el: VectorElement, defs: string[]): string {
  const common: string[] = []
  if (el.opacity < 100) common.push(`opacity="${num(el.opacity / 100)}"`)
  if (el.rotation) {
    const cx = el.x + el.w / 2, cy = el.y + el.h / 2
    common.push(`transform="rotate(${num(el.rotation)} ${num(cx)} ${num(cy)})"`)
  }
  const c = common.length ? ' ' + common.join(' ') : ''
  const f = fillAttrs(el, defs)
  const s = strokeAttrs(el.stroke)

  if (el.type === 'rect') {
    const r = (el as RectElement).cornerRadius
    return `<rect x="${num(el.x)}" y="${num(el.y)}" width="${num(el.w)}" height="${num(el.h)}"${r ? ` rx="${num(r)}"` : ''} ${f}${s}${c}/>`
  }
  if (el.type === 'ellipse') {
    return `<ellipse cx="${num(el.x + el.w / 2)}" cy="${num(el.y + el.h / 2)}" rx="${num(el.w / 2)}" ry="${num(el.h / 2)}" ${f}${s}${c}/>`
  }
  if (el.type === 'path') {
    const pe = el as PathElement
    return `<path d="${pathToD(pe.points, pe.closed)}" ${f}${s}${c}/>`
  }
  if (el.type === 'text') {
    const te = el as TextElement
    const anchor = te.align === 'center' ? 'middle' : te.align === 'right' ? 'end' : 'start'
    const ax = te.align === 'center' ? te.x + te.w / 2 : te.align === 'right' ? te.x + te.w : te.x
    const fillC = te.fill.type === 'solid' ? te.fill.color : '#000000'
    const lines = te.text.split('\n')
    const tspans = lines.map((ln, i) => `<tspan x="${num(ax)}" dy="${i === 0 ? num(te.fontSize) : num(te.fontSize * 1.25)}">${esc(ln)}</tspan>`).join('')
    return `<text x="${num(ax)}" y="${num(te.y)}" font-family="${esc(te.fontFamily)}" font-size="${num(te.fontSize)}" font-weight="${te.fontWeight}"${te.italic ? ' font-style="italic"' : ''} text-anchor="${anchor}" fill="${esc(fillC)}"${c}>${tspans}</text>`
  }
  return ''
}

export function pageDataToSvg(pd: VectorPageData): string {
  const ab = pd.artboards[0]
  let vbX = 0, vbY = 0, vbW = 1000, vbH = 1000
  if (ab) { vbX = ab.x; vbY = ab.y; vbW = ab.width; vbH = ab.height }
  const defs: string[] = []
  const body = [...pd.elements].filter(e => e.visible).sort((a, b) => a.zIndex - b.zIndex)
    .map(e => elementToSvg(e, defs)).filter(Boolean).join('\n  ')
  const bg = ab && ab.background && ab.background !== 'transparent'
    ? `<rect x="${num(vbX)}" y="${num(vbY)}" width="${num(vbW)}" height="${num(vbH)}" fill="${esc(ab.background)}"/>\n  ` : ''
  const defsBlock = defs.length ? `<defs>${defs.join('')}</defs>\n  ` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${num(vbW)}" height="${num(vbH)}" viewBox="${num(vbX)} ${num(vbY)} ${num(vbW)} ${num(vbH)}">\n  ${defsBlock}${bg}${body}\n</svg>\n`
}

// ─────────────────────────────────────────────────────────────────────────────
// IMPORT : texte SVG → VectorPageData
// ─────────────────────────────────────────────────────────────────────────────

let _idc = 0
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${(_idc++).toString(36)}`

function parseColorOpacity(raw: string | null): { color: string; opacity: number } | 'none' | null {
  if (raw == null) return null
  const v = raw.trim()
  if (v === 'none') return 'none'
  if (v === '') return null
  if (v.startsWith('url(')) return { color: '#cccccc', opacity: 100 } // dégradé non résolu → gris neutre
  return { color: v, opacity: 100 }
}

function styleMap(el: Element): Record<string, string> {
  const m: Record<string, string> = {}
  const style = el.getAttribute('style')
  if (style) for (const part of style.split(';')) {
    const [k, ...rest] = part.split(':')
    if (k && rest.length) m[k.trim()] = rest.join(':').trim()
  }
  return m
}
function attrOrStyle(el: Element, name: string, sm: Record<string, string>): string | null {
  return sm[name] ?? el.getAttribute(name)
}

function readFill(el: Element, sm: Record<string, string>): FillStyle {
  const fo = parseFloat(attrOrStyle(el, 'fill-opacity', sm) ?? '1')
  const co = parseColorOpacity(attrOrStyle(el, 'fill', sm))
  if (co === 'none') return { type: 'none' }
  if (co == null) return { type: 'solid', color: '#000000', opacity: 100 } // défaut SVG = noir
  return { type: 'solid', color: co.color, opacity: Math.round((isNaN(fo) ? 1 : fo) * 100) }
}
function readStroke(el: Element, sm: Record<string, string>): StrokeStyle | null {
  const sc = parseColorOpacity(attrOrStyle(el, 'stroke', sm))
  if (!sc || sc === 'none') return null
  const w = parseFloat(attrOrStyle(el, 'stroke-width', sm) ?? '1')
  const so = parseFloat(attrOrStyle(el, 'stroke-opacity', sm) ?? '1')
  const dash = (attrOrStyle(el, 'stroke-dasharray', sm) ?? '').split(/[ ,]+/).map(parseFloat).filter(n => !isNaN(n))
  const cap = (attrOrStyle(el, 'stroke-linecap', sm) ?? 'butt') as StrokeStyle['cap']
  const join = (attrOrStyle(el, 'stroke-linejoin', sm) ?? 'miter') as StrokeStyle['join']
  return { color: sc.color, opacity: Math.round((isNaN(so) ? 1 : so) * 100), width: isNaN(w) ? 1 : w, dashArray: dash, cap, join }
}

function bbox(pts: { x: number; y: number }[]): { x: number; y: number; w: number; h: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of pts) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y) }
  if (!isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

// Parseur de l'attribut `d` (M/L/H/V/C/S/Q/T/Z, abs+rel ; A approximé en ligne).
function parsePathD(d: string): { points: PathPoint[]; closed: boolean } {
  const toks = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || []
  const pts: PathPoint[] = []
  let i = 0, cx = 0, cy = 0, startX = 0, startY = 0, closed = false
  let cmd = ''
  const numTok = () => parseFloat(toks[i++])
  const isCmd = (t: string) => /^[a-zA-Z]$/.test(t)
  while (i < toks.length) {
    if (isCmd(toks[i])) cmd = toks[i++]
    const rel = cmd === cmd.toLowerCase()
    const C = cmd.toUpperCase()
    if (C === 'M') {
      let x = numTok(), y = numTok(); if (rel) { x += cx; y += cy }
      cx = x; cy = y; startX = x; startY = y
      pts.push({ x, y, move: pts.length > 0 ? true : undefined })
      cmd = rel ? 'l' : 'L' // subséquents = lineto
    } else if (C === 'L') {
      let x = numTok(), y = numTok(); if (rel) { x += cx; y += cy }
      cx = x; cy = y; pts.push({ x, y })
    } else if (C === 'H') {
      let x = numTok(); if (rel) x += cx; cx = x; pts.push({ x, y: cy })
    } else if (C === 'V') {
      let y = numTok(); if (rel) y += cy; cy = y; pts.push({ x: cx, y })
    } else if (C === 'C') {
      let x1 = numTok(), y1 = numTok(), x2 = numTok(), y2 = numTok(), x = numTok(), y = numTok()
      if (rel) { x1 += cx; y1 += cy; x2 += cx; y2 += cy; x += cx; y += cy }
      if (pts.length) { const prev = pts[pts.length - 1]; prev.hOut = [x1 - prev.x, y1 - prev.y] }
      pts.push({ x, y, hIn: [x2 - x, y2 - y] }); cx = x; cy = y
    } else if (C === 'S') {
      let x2 = numTok(), y2 = numTok(), x = numTok(), y = numTok()
      if (rel) { x2 += cx; y2 += cy; x += cx; y += cy }
      const prev = pts[pts.length - 1]
      if (prev) prev.hOut = prev.hIn ? [-prev.hIn[0], -prev.hIn[1]] : [0, 0]
      pts.push({ x, y, hIn: [x2 - x, y2 - y] }); cx = x; cy = y
    } else if (C === 'Q') {
      let qx = numTok(), qy = numTok(), x = numTok(), y = numTok()
      if (rel) { qx += cx; qy += cy; x += cx; y += cy }
      const prev = pts[pts.length - 1]
      if (prev) prev.hOut = [(2 / 3) * (qx - prev.x), (2 / 3) * (qy - prev.y)]
      pts.push({ x, y, hIn: [(2 / 3) * (qx - x), (2 / 3) * (qy - y)] }); cx = x; cy = y
    } else if (C === 'T') {
      let x = numTok(), y = numTok(); if (rel) { x += cx; y += cy }
      pts.push({ x, y }); cx = x; cy = y
    } else if (C === 'A') {
      numTok(); numTok(); numTok(); numTok(); numTok() // rx ry rot large sweep
      let x = numTok(), y = numTok(); if (rel) { x += cx; y += cy }
      pts.push({ x, y }); cx = x; cy = y // arc approximé en ligne
    } else if (C === 'Z') {
      closed = true; cx = startX; cy = startY
    } else { i++ }
  }
  return { points: pts, closed }
}

// Applique un transform="translate(...) scale(...) rotate(...) matrix(...)" cumulé
// (gère translate/scale/matrix ; rotate de groupe approximé en translate du centre).
function parseTransform(t: string | null): (p: { x: number; y: number }) => { x: number; y: number } {
  if (!t) return p => p
  const fns: ((p: { x: number; y: number }) => { x: number; y: number })[] = []
  const re = /(translate|scale|matrix|rotate)\s*\(([^)]*)\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(t))) {
    const a = m[2].split(/[ ,]+/).map(parseFloat).filter(n => !isNaN(n))
    if (m[1] === 'translate') { const [tx, ty = 0] = a; fns.push(p => ({ x: p.x + tx, y: p.y + ty })) }
    else if (m[1] === 'scale') { const [sx, sy = a[0]] = a; fns.push(p => ({ x: p.x * sx, y: p.y * sy })) }
    else if (m[1] === 'matrix' && a.length === 6) { const [aa, b, c, dd, e, f] = a; fns.push(p => ({ x: aa * p.x + c * p.y + e, y: b * p.x + dd * p.y + f })) }
  }
  return p => fns.reduce((q, fn) => fn(q), p)
}

export function svgToPageData(svgText: string): VectorPageData {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml')
  const svg = doc.querySelector('svg')
  if (!svg || doc.querySelector('parsererror')) throw new Error('SVG invalide')

  // Dimensions de l'artboard
  let W = 1000, H = 1000, ox = 0, oy = 0
  const vb = svg.getAttribute('viewBox')
  if (vb) { const [x, y, w, h] = vb.split(/[ ,]+/).map(parseFloat); if (!isNaN(w) && !isNaN(h)) { ox = x; oy = y; W = w; H = h } }
  else { W = parseFloat(svg.getAttribute('width') || '1000') || 1000; H = parseFloat(svg.getAttribute('height') || '1000') || 1000 }

  const elements: VectorElement[] = []
  let z = 0
  const base = (el: Element, sm: Record<string, string>, bb: { x: number; y: number; w: number; h: number }): BaseElement => ({
    id: uid('el'), type: '', name: el.tagName, x: bb.x, y: bb.y, w: bb.w, h: bb.h, rotation: 0,
    visible: (attrOrStyle(el, 'display', sm) !== 'none'),
    locked: false, opacity: Math.round((parseFloat(attrOrStyle(el, 'opacity', sm) ?? '1') || 1) * 100),
    zIndex: z++, fill: readFill(el, sm), stroke: readStroke(el, sm),
  })

  const walk = (node: Element, xf: (p: { x: number; y: number }) => { x: number; y: number }) => {
    for (const el of Array.from(node.children)) {
      const tag = el.tagName.toLowerCase()
      const tf = (p: { x: number; y: number }) => xf(parseTransform(el.getAttribute('transform'))(p))
      const sm = styleMap(el)
      if (tag === 'g') { walk(el, tf); continue }
      if (tag === 'defs' || tag === 'title' || tag === 'desc' || tag === 'style' || tag === 'metadata') continue
      const P = (x: number, y: number) => tf({ x, y })
      if (tag === 'rect') {
        const x = parseFloat(el.getAttribute('x') || '0'), y = parseFloat(el.getAttribute('y') || '0')
        const w = parseFloat(el.getAttribute('width') || '0'), h = parseFloat(el.getAttribute('height') || '0')
        const tl = P(x, y), br = P(x + w, y + h)
        const bb = { x: Math.min(tl.x, br.x), y: Math.min(tl.y, br.y), w: Math.abs(br.x - tl.x), h: Math.abs(br.y - tl.y) }
        elements.push({ ...base(el, sm, bb), type: 'rect', cornerRadius: parseFloat(el.getAttribute('rx') || '0') || 0 } as RectElement)
      } else if (tag === 'circle' || tag === 'ellipse') {
        const cx = parseFloat(el.getAttribute('cx') || '0'), cy = parseFloat(el.getAttribute('cy') || '0')
        const rx = parseFloat(el.getAttribute('r') || el.getAttribute('rx') || '0')
        const ry = parseFloat(el.getAttribute('r') || el.getAttribute('ry') || '0')
        const tl = P(cx - rx, cy - ry), br = P(cx + rx, cy + ry)
        const bb = { x: Math.min(tl.x, br.x), y: Math.min(tl.y, br.y), w: Math.abs(br.x - tl.x), h: Math.abs(br.y - tl.y) }
        elements.push({ ...base(el, sm, bb), type: 'ellipse' } as EllipseElement)
      } else if (tag === 'line') {
        const pts = [P(parseFloat(el.getAttribute('x1') || '0'), parseFloat(el.getAttribute('y1') || '0')),
                     P(parseFloat(el.getAttribute('x2') || '0'), parseFloat(el.getAttribute('y2') || '0'))]
        elements.push({ ...base(el, sm, bbox(pts)), type: 'path', points: pts.map(p => ({ x: p.x, y: p.y })), closed: false } as PathElement)
      } else if (tag === 'polyline' || tag === 'polygon') {
        const nums = (el.getAttribute('points') || '').split(/[ ,]+/).map(parseFloat).filter(n => !isNaN(n))
        const pts: PathPoint[] = []
        for (let k = 0; k + 1 < nums.length; k += 2) { const p = P(nums[k], nums[k + 1]); pts.push({ x: p.x, y: p.y }) }
        if (pts.length) elements.push({ ...base(el, sm, bbox(pts)), type: 'path', points: pts, closed: tag === 'polygon' } as PathElement)
      } else if (tag === 'path') {
        const { points, closed } = parsePathD(el.getAttribute('d') || '')
        const tp = points.map(p => {
          const np = P(p.x, p.y)
          const out: PathPoint = { x: np.x, y: np.y, move: p.move }
          if (p.hIn) { const h = tf({ x: p.x + p.hIn[0], y: p.y + p.hIn[1] }); out.hIn = [h.x - np.x, h.y - np.y] }
          if (p.hOut) { const h = tf({ x: p.x + p.hOut[0], y: p.y + p.hOut[1] }); out.hOut = [h.x - np.x, h.y - np.y] }
          return out
        })
        if (tp.length) elements.push({ ...base(el, sm, bbox(tp)), type: 'path', points: tp, closed } as PathElement)
      } else if (tag === 'text') {
        const x = parseFloat(el.getAttribute('x') || '0'), y = parseFloat(el.getAttribute('y') || '0')
        const p = P(x, y)
        const fs = parseFloat(attrOrStyle(el, 'font-size', sm) || '16') || 16
        const anchor = attrOrStyle(el, 'text-anchor', sm)
        const txt = (el.textContent || '').trim()
        const bb = { x: p.x, y: p.y - fs, w: Math.max(fs * txt.length * 0.5, 10), h: fs * 1.3 }
        elements.push({
          ...base(el, sm, bb), type: 'text', text: txt, fontSize: fs,
          fontFamily: (attrOrStyle(el, 'font-family', sm) || 'sans-serif').replace(/["']/g, ''),
          fontWeight: parseInt(attrOrStyle(el, 'font-weight', sm) || '400') || 400,
          italic: (attrOrStyle(el, 'font-style', sm) || '') === 'italic',
          align: anchor === 'middle' ? 'center' : anchor === 'end' ? 'right' : 'left',
        } as TextElement)
      }
    }
  }
  walk(svg, p => p)

  return {
    artboards: [{ id: uid('ab'), name: 'Page 1', x: ox, y: oy, width: W, height: H, background: '#ffffff' }],
    elements,
    guides: [],
  }
}
