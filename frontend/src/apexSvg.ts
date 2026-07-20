/**
 * SVG import / export for the Apex vector editor.
 *
 * Apex works on an internal `VectorPageData` model (rect/ellipse/path/text +
 * fills/strokes/gradients). These functions convert that model from/to standard
 * SVG, so `.svg` files can be opened, edited and saved again — Apex's canvas
 * renderer already maps 1:1 onto the SVG primitives.
 *
 * Known model ceilings (not parser gaps): Apex has no transform matrix — an
 * element is an axis-aligned bbox plus a rotation scalar — so shear/skew from an
 * imported matrix() bakes into the bbox. There is no clip/mask/pattern/filter
 * primitive, so those tags are dropped on import.
 */
import type {
  VectorPageData, VectorElement, BaseElement, PathPoint, GradientStop,
  FillStyle, StrokeStyle, RectElement, EllipseElement, PathElement, TextElement,
  GroupElement,
} from './api'

// ─────────────────────────────────────────────────────────────────────────────
// EXPORT: VectorPageData → SVG text
// ─────────────────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
// Coordinate precision (Illustrator's "Decimal Places"). Serialisation is
// synchronous and single-threaded, so pageDataToSvg can safely swap this in
// for one run and restore it.
let _pow = 1000
function num(n: number): string {
  return (Math.round(n * _pow) / _pow).toString()
}

export interface SvgExportOpts {
  /** Decimal places for coordinates (default 3). */
  precision?: number
  /** Responsive SVG: no fixed width/height on the root, viewBox only. */
  responsive?: boolean
}

export function pathToD(points: PathPoint[], closed: boolean): string {
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
  // Gradients → paint server in <defs>
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
  // Miter limit only matters for miter joins and differs from the SVG default (4)…
  // note the canvas/Apex default is 10, so emit it whenever a miter join is used.
  if ((!s.join || s.join === 'miter') && s.miterLimit != null) a += ` stroke-miterlimit="${num(s.miterLimit)}"`
  return a
}

// Apex stores canvas composite names, which are also the CSS mix-blend-mode
// keywords — except 'source-over', canvas's word for "no blending".
function blendAttr(el: BaseElement): string {
  const b = el.blend
  if (!b || b === 'normal' || b === 'source-over') return ''
  return ` style="mix-blend-mode:${b}"`
}

function elementToSvg(el: VectorElement, defs: string[]): string {
  const common: string[] = []
  if (el.opacity < 100) common.push(`opacity="${num(el.opacity / 100)}"`)
  if (el.rotation) {
    const cx = el.x + el.w / 2, cy = el.y + el.h / 2
    common.push(`transform="rotate(${num(el.rotation)} ${num(cx)} ${num(cy)})"`)
  }
  const c = (common.length ? ' ' + common.join(' ') : '') + blendAttr(el)
  const f = fillAttrs(el, defs)
  const s = strokeAttrs(el.stroke)

  if (el.type === 'rect') {
    const re = el as RectElement
    // Independent per-corner radii need a real path (SVG <rect rx> is uniform).
    if (re.corners && re.corners.some(v => v > 0)) {
      const { x, y, w, h } = el
      const cs = re.corners.map(v => Math.min(Math.max(0, v), w / 2, h / 2))
      const arc = (r: number, ex: number, ey: number) => r > 0 ? `A ${num(r)} ${num(r)} 0 0 1 ${num(ex)} ${num(ey)} ` : ''
      const d =
        `M ${num(x + cs[0])} ${num(y)} L ${num(x + w - cs[1])} ${num(y)} ${arc(cs[1], x + w, y + cs[1])}` +
        `L ${num(x + w)} ${num(y + h - cs[2])} ${arc(cs[2], x + w - cs[2], y + h)}` +
        `L ${num(x + cs[3])} ${num(y + h)} ${arc(cs[3], x, y + h - cs[3])}` +
        `L ${num(x)} ${num(y + cs[0])} ${arc(cs[0], x + cs[0], y)}Z`
      return `<path d="${d}" ${f}${s}${c}/>`
    }
    const r = re.cornerRadius
    return `<rect x="${num(el.x)}" y="${num(el.y)}" width="${num(el.w)}" height="${num(el.h)}"${r ? ` rx="${num(r)}"` : ''} ${f}${s}${c}/>`
  }
  if (el.type === 'ellipse') {
    return `<ellipse cx="${num(el.x + el.w / 2)}" cy="${num(el.y + el.h / 2)}" rx="${num(el.w / 2)}" ry="${num(el.h / 2)}" ${f}${s}${c}/>`
  }
  if (el.type === 'path') {
    const pe = el as PathElement
    return `<path d="${pathToD(pe.points, pe.closed)}" ${f}${s}${c}/>`
  }
  if (el.type === 'image') {
    const ie = el as import('./api').ImageElement
    return `<image x="${num(el.x)}" y="${num(el.y)}" width="${num(el.w)}" height="${num(el.h)}" href="${esc(ie.src)}" preserveAspectRatio="none"${c}/>`
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

export function pageDataToSvg(pd: VectorPageData, opts?: SvgExportOpts): string {
  _pow = 10 ** Math.min(6, Math.max(0, opts?.precision ?? 3))
  try {
    return pageDataToSvgInner(pd, opts)
  } finally {
    _pow = 1000
  }
}

function pageDataToSvgInner(pd: VectorPageData, opts?: SvgExportOpts): string {
  const ab = pd.artboards[0]
  let vbX = 0, vbY = 0, vbW = 1000, vbH = 1000
  if (ab) { vbX = ab.x; vbY = ab.y; vbW = ab.width; vbH = ab.height }
  const defs: string[] = []

  // Containers become real nested <g>, so the layer tree survives a round-trip.
  // Symmetry containers export as plain groups: their clones are already
  // materialised as ordinary elements, and the live rule has no SVG equivalent.
  const byParent = new Map<string, VectorElement[]>()
  for (const e of pd.elements) {
    const k = e.parentId ?? ''
    const arr = byParent.get(k)
    if (arr) arr.push(e); else byParent.set(k, [e])
  }
  const isContainer = (e: VectorElement) => e.type === 'group' || e.type === 'symmetry'

  // Leaf shapes of a clipping mask (itself possibly a nested group).
  const maskLeaves = (el: VectorElement): VectorElement[] =>
    isContainer(el) ? (byParent.get(el.id) ?? []).flatMap(maskLeaves) : [el]

  const emit = (parentId: string, depth: number, excludeId?: string): string[] => {
    const pad = '  '.repeat(depth)
    const out: string[] = []
    for (const el of [...(byParent.get(parentId) ?? [])].sort((a, b) => a.zIndex - b.zIndex)) {
      if (!el.visible || el.id === excludeId) continue   // hidden subtree: skip it whole
      if (isContainer(el)) {
        const attrs = [`id="${esc(el.id)}"`]
        if (el.name) attrs.push(`data-name="${esc(el.name)}"`)
        if (el.opacity < 100) attrs.push(`opacity="${num(el.opacity / 100)}"`)
        // Clipping-mask group: the topmost child becomes a real <clipPath>.
        const kids = [...(byParent.get(el.id) ?? [])].sort((a, b) => a.zIndex - b.zIndex)
        const mask = el.type === 'group' && (el as GroupElement).clipped && kids.length >= 2
          ? kids[kids.length - 1] : null
        if (mask) {
          const cid = `clip-${el.id}`
          defs.push(`<clipPath id="${esc(cid)}">${maskLeaves(mask).map(s => elementToSvg(s, defs)).join('')}</clipPath>`)
          attrs.push(`clip-path="url(#${esc(cid)})"`)
        }
        const inner = emit(el.id, depth + 1, mask?.id)
        if (!inner.length) continue      // empty group → nothing to write
        out.push(`${pad}<g ${attrs.join(' ')}${blendAttr(el)}>`, ...inner, `${pad}</g>`)
      } else {
        const s = elementToSvg(el, defs)
        if (s) out.push(pad + s)
      }
    }
    return out
  }
  const body = emit('', 1).join('\n')

  const bg = ab && ab.background && ab.background !== 'transparent'
    ? `  <rect x="${num(vbX)}" y="${num(vbY)}" width="${num(vbW)}" height="${num(vbH)}" fill="${esc(ab.background)}"/>\n` : ''
  // defs must be built before it is stringified: emit() fills it as a side effect.
  const defsBlock = defs.length ? `  <defs>${defs.join('')}</defs>\n` : ''
  const size = opts?.responsive ? '' : ` width="${num(vbW)}" height="${num(vbH)}"`
  return `<svg xmlns="http://www.w3.org/2000/svg"${size} viewBox="${num(vbX)} ${num(vbY)} ${num(vbW)} ${num(vbH)}">\n${defsBlock}${bg}${body}${body ? '\n' : ''}</svg>\n`
}

// ─────────────────────────────────────────────────────────────────────────────
// IMPORT: SVG text → VectorPageData
// ─────────────────────────────────────────────────────────────────────────────

let _idc = 0
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${(_idc++).toString(36)}`

type GradMap = Map<string, Element>

// A paint server may inherit stops and geometry from another through href, so
// resolution walks that chain (guarding against cycles).
function gradAttr(g: Element, grads: GradMap, name: string, seen = new Set<string>()): string | null {
  const own = g.getAttribute(name)
  if (own != null) return own
  const href = g.getAttribute('href') ?? g.getAttribute('xlink:href')
  if (href?.startsWith('#')) {
    const id = href.slice(1)
    if (!seen.has(id)) { seen.add(id); const p = grads.get(id); if (p) return gradAttr(p, grads, name, seen) }
  }
  return null
}
function gradStops(g: Element, grads: GradMap, seen = new Set<string>()): GradientStop[] {
  const own = Array.from(g.children).filter(c => c.tagName.toLowerCase() === 'stop')
  if (own.length) {
    return own.map(s => {
      const sm = styleMap(s)
      const raw = (attrOrStyle(s, 'offset', sm) ?? '0').trim()
      const pos = raw.endsWith('%') ? parseFloat(raw) / 100 : parseFloat(raw)
      const op = parseFloat(attrOrStyle(s, 'stop-opacity', sm) ?? '1')
      return {
        color: (attrOrStyle(s, 'stop-color', sm) ?? '#000000').trim(),
        opacity: Math.round((isNaN(op) ? 1 : op) * 100),
        position: isNaN(pos) ? 0 : Math.min(1, Math.max(0, pos)),
      }
    })
  }
  const href = g.getAttribute('href') ?? g.getAttribute('xlink:href')
  if (href?.startsWith('#')) {
    const id = href.slice(1)
    if (!seen.has(id)) { seen.add(id); const p = grads.get(id); if (p) return gradStops(p, grads, seen) }
  }
  return []
}

// Apex gradients are bbox-relative and carry only an angle, so a linear gradient
// keeps its direction but loses its extent; radial loses focal point and radius.
function gradToFill(g: Element, grads: GradMap): FillStyle | null {
  const tag = g.tagName.toLowerCase()
  const stops = gradStops(g, grads)
  if (!stops.length) return null
  if (tag === 'radialgradient') return { type: 'radial-gradient', stops }
  if (tag !== 'lineargradient') return null
  // Percentages, plain fractions and userSpaceOnUse lengths all give a usable
  // direction — only the angle survives into the model anyway.
  const len = (v: string | null, d: number) => {
    if (v == null) return d
    const n = v.trim().endsWith('%') ? parseFloat(v) / 100 : parseFloat(v)
    return isNaN(n) ? d : n
  }
  const x1 = len(gradAttr(g, grads, 'x1'), 0), y1 = len(gradAttr(g, grads, 'y1'), 0)
  const x2 = len(gradAttr(g, grads, 'x2'), 1), y2 = len(gradAttr(g, grads, 'y2'), 0)
  const angle = Math.round((Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI)
  return { type: 'linear-gradient', stops, angle }
}

function paintRef(raw: string): string | null {
  const m = /^url\(\s*['"]?#([^)'"]+)['"]?\s*\)/.exec(raw.trim())
  return m ? m[1] : null
}

function parseColorOpacity(raw: string | null): { color: string; opacity: number } | 'none' | null {
  if (raw == null) return null
  const v = raw.trim()
  if (v === 'none') return 'none'
  if (v === '') return null
  // Unresolved paint server (pattern, or a gradient with no stops) → neutral grey.
  if (v.startsWith('url(')) return { color: '#cccccc', opacity: 100 }
  return { color: v, opacity: 100 }
}

// Simple-selector CSS rules from <style> blocks. Illustrator/Inkscape exports
// style everything through classes (`.st0{fill:#FF0000}`), so skipping these
// used to import such files as all-black shapes. Combinators and pseudo-classes
// are out of the model's reach and are skipped.
interface CssRule {
  spec: number                       // 100·id + 10·class + 1·tag
  order: number                      // document order for ties
  test: (el: Element) => boolean
  props: Record<string, string>
}

function parseCssRules(svg: Element): CssRule[] {
  const rules: CssRule[] = []
  let order = 0
  for (const styleEl of Array.from(svg.querySelectorAll('style'))) {
    const text = (styleEl.textContent || '').replace(/\/\*[\s\S]*?\*\//g, '')
    const re = /([^{}]+)\{([^}]*)\}/g
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      const props: Record<string, string> = {}
      for (const part of m[2].split(';')) {
        const [k, ...rest] = part.split(':')
        if (k && rest.length) props[k.trim().toLowerCase()] = rest.join(':').trim()
      }
      if (!Object.keys(props).length) continue
      for (const selRaw of m[1].split(',')) {
        const sel = selRaw.trim()
        if (!sel || /[ >+~[\]:]/.test(sel)) continue          // combinator/pseudo → skip
        const parts = /^([a-zA-Z*][\w-]*)?((?:[.#][\w-]+)*)$/.exec(sel)
        if (!parts || (!parts[1] && !parts[2])) continue
        const tag = parts[1]?.toLowerCase()
        const quals = parts[2] ? (parts[2].match(/[.#][\w-]+/g) ?? []) : []
        let spec = tag && tag !== '*' ? 1 : 0
        for (const q of quals) spec += q[0] === '#' ? 100 : 10
        rules.push({
          spec, order: order++, props,
          test: el => {
            if (tag && tag !== '*' && el.tagName.toLowerCase() !== tag) return false
            for (const q of quals) {
              if (q[0] === '#') { if (el.getAttribute('id') !== q.slice(1)) return false }
              else if (!(el.getAttribute('class') || '').split(/\s+/).includes(q.slice(1))) return false
            }
            return true
          },
        })
      }
    }
  }
  return rules
}

// Effective style of an element: CSS rules by ascending specificity, inline
// `style=""` on top. Presentation attributes stay below both (attrOrStyle's
// fallback), matching the SVG cascade.
function styleMap(el: Element, css: CssRule[] = []): Record<string, string> {
  const m: Record<string, string> = {}
  if (css.length) {
    const hits = css.filter(r => r.test(el)).sort((a, b) => (a.spec - b.spec) || (a.order - b.order))
    for (const r of hits) Object.assign(m, r.props)
  }
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

// Text width via real font metrics — the old `fontSize · length · 0.5` guess
// misplaced right/centre-anchored imports by half a word.
let _measureCtx: CanvasRenderingContext2D | null = null
function measureLine(text: string, fontSize: number, family: string, weight: number, italic: boolean): number {
  if (!_measureCtx) _measureCtx = document.createElement('canvas').getContext('2d')
  if (!_measureCtx) return fontSize * text.length * 0.5
  _measureCtx.font = `${italic ? 'italic ' : ''}${weight} ${fontSize}px ${family}`
  return _measureCtx.measureText(text).width
}

function readFill(el: Element, sm: Record<string, string>, grads: GradMap): FillStyle {
  const raw = attrOrStyle(el, 'fill', sm)
  if (raw != null) {
    const ref = paintRef(raw)
    if (ref) {
      const g = grads.get(ref)
      const f = g ? gradToFill(g, grads) : null
      if (f) return f
    }
  }
  const fo = parseFloat(attrOrStyle(el, 'fill-opacity', sm) ?? '1')
  const co = parseColorOpacity(raw)
  if (co === 'none') return { type: 'none' }
  if (co == null) return { type: 'solid', color: '#000000', opacity: 100 } // SVG default = black
  return { type: 'solid', color: co.color, opacity: Math.round((isNaN(fo) ? 1 : fo) * 100) }
}
function readStroke(el: Element, sm: Record<string, string>, grads: GradMap): StrokeStyle | null {
  const raw = attrOrStyle(el, 'stroke', sm)
  const sc = parseColorOpacity(raw)
  if (!sc || sc === 'none') return null
  // Apex strokes are solid-colour only; a gradient stroke takes its first stop.
  let color = sc.color
  const ref = raw ? paintRef(raw) : null
  if (ref) {
    const g = grads.get(ref)
    const stops = g ? gradStops(g, grads) : []
    if (stops.length) color = stops[0].color
  }
  const w = parseFloat(attrOrStyle(el, 'stroke-width', sm) ?? '1')
  const so = parseFloat(attrOrStyle(el, 'stroke-opacity', sm) ?? '1')
  const dash = (attrOrStyle(el, 'stroke-dasharray', sm) ?? '').split(/[ ,]+/).map(parseFloat).filter(n => !isNaN(n))
  const cap = (attrOrStyle(el, 'stroke-linecap', sm) ?? 'butt') as StrokeStyle['cap']
  const join = (attrOrStyle(el, 'stroke-linejoin', sm) ?? 'miter') as StrokeStyle['join']
  return { color, opacity: Math.round((isNaN(so) ? 1 : so) * 100), width: isNaN(w) ? 1 : w, dashArray: dash, cap, join }
}

function bbox(pts: { x: number; y: number }[]): { x: number; y: number; w: number; h: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of pts) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y) }
  if (!isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

// Endpoint-parameterised arc → cubic segments (SVG spec appendix F.6.5).
// Returns [] for a degenerate arc, which the caller then treats as a lineto.
function arcToCubics(
  x1: number, y1: number, rx: number, ry: number, rot: number,
  large: number, sweep: number, x2: number, y2: number,
): { c1: [number, number]; c2: [number, number]; end: [number, number] }[] {
  if (!rx || !ry) return []
  if (x1 === x2 && y1 === y2) return []
  rx = Math.abs(rx); ry = Math.abs(ry)
  const rad = (rot * Math.PI) / 180
  const cos = Math.cos(rad), sin = Math.sin(rad)
  // Step 1: midpoint transform into the ellipse's own frame.
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2
  const x1p = cos * dx + sin * dy, y1p = -sin * dx + cos * dy
  // Step 2: scale the radii up if they cannot span the chord.
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
  if (lam > 1) { const s = Math.sqrt(lam); rx *= s; ry *= s }
  const sq = Math.max(0, (rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p) /
                         (rx * rx * y1p * y1p + ry * ry * x1p * x1p))
  const coef = (large === sweep ? -1 : 1) * Math.sqrt(sq)
  const cxp = (coef * rx * y1p) / ry, cyp = (-coef * ry * x1p) / rx
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2
  // Step 3: start angle and sweep.
  const ang = (ux: number, uy: number, vx: number, vy: number) => {
    const d = Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy))
    if (!d) return 0
    let c = (ux * vx + uy * vy) / d
    c = Math.min(1, Math.max(-1, c))
    return (ux * vy - uy * vx < 0 ? -1 : 1) * Math.acos(c)
  }
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
  if (!sweep && dt > 0) dt -= 2 * Math.PI
  else if (sweep && dt < 0) dt += 2 * Math.PI
  // Step 4: one cubic per ≤90° slice keeps the error negligible.
  const n = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2)))
  const step = dt / n
  const k = (4 / 3) * Math.tan(step / 4)
  const at = (t: number) => {
    const ct = Math.cos(t), st = Math.sin(t)
    return {
      p: [cx + rx * ct * cos - ry * st * sin, cy + rx * ct * sin + ry * st * cos] as [number, number],
      d: [-rx * st * cos - ry * ct * sin, -rx * st * sin + ry * ct * cos] as [number, number],
    }
  }
  const out: { c1: [number, number]; c2: [number, number]; end: [number, number] }[] = []
  let t = t1
  for (let i = 0; i < n; i++) {
    const a = at(t), b = at(t + step)
    out.push({
      c1: [a.p[0] + k * a.d[0], a.p[1] + k * a.d[1]],
      c2: [b.p[0] - k * b.d[0], b.p[1] - k * b.d[1]],
      end: b.p,
    })
    t += step
  }
  return out
}

// `d` attribute parser (M/L/H/V/C/S/Q/T/A/Z, absolute + relative).
function parsePathD(d: string): { points: PathPoint[]; closed: boolean } {
  const toks = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || []
  const pts: PathPoint[] = []
  let i = 0, cx = 0, cy = 0, startX = 0, startY = 0, closed = false, subIdx = 0
  let cmd = ''
  // Reflected control point for smooth S/T continuations.
  let lastQ: [number, number] | null = null
  const numTok = () => parseFloat(toks[i++])
  const isCmd = (t: string) => /^[a-zA-Z]$/.test(t)
  while (i < toks.length) {
    if (isCmd(toks[i])) cmd = toks[i++]
    const rel = cmd === cmd.toLowerCase()
    const C = cmd.toUpperCase()
    if (C !== 'Q' && C !== 'T') lastQ = null
    if (C === 'M') {
      let x = numTok(), y = numTok(); if (rel) { x += cx; y += cy }
      cx = x; cy = y; startX = x; startY = y
      subIdx = pts.length
      pts.push({ x, y, move: pts.length > 0 ? true : undefined })
      cmd = rel ? 'l' : 'L' // subsequent pairs are implicit linetos
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
      pts.push({ x, y, hIn: [(2 / 3) * (qx - x), (2 / 3) * (qy - y)] })
      lastQ = [qx, qy]; cx = x; cy = y
    } else if (C === 'T') {
      let x = numTok(), y = numTok(); if (rel) { x += cx; y += cy }
      // The implied control point mirrors the previous one about the current point.
      const qx: number = lastQ ? 2 * cx - lastQ[0] : cx
      const qy: number = lastQ ? 2 * cy - lastQ[1] : cy
      const prev = pts[pts.length - 1]
      if (prev) prev.hOut = [(2 / 3) * (qx - prev.x), (2 / 3) * (qy - prev.y)]
      pts.push({ x, y, hIn: [(2 / 3) * (qx - x), (2 / 3) * (qy - y)] })
      lastQ = [qx, qy]; cx = x; cy = y
    } else if (C === 'A') {
      const rx = numTok(), ry = numTok(), rot = numTok(), large = numTok(), sweep = numTok()
      let x = numTok(), y = numTok(); if (rel) { x += cx; y += cy }
      const segs = arcToCubics(cx, cy, rx, ry, rot, large, sweep, x, y)
      if (!segs.length) pts.push({ x, y })        // degenerate arc → straight line
      else for (const s of segs) {
        const prev = pts[pts.length - 1]
        if (prev) prev.hOut = [s.c1[0] - prev.x, s.c1[1] - prev.y]
        pts.push({ x: s.end[0], y: s.end[1], hIn: [s.c2[0] - s.end[0], s.c2[1] - s.end[1]] })
      }
      cx = x; cy = y
    } else if (C === 'Z') {
      // Many exporters (ours included) draw the closing segment explicitly and
      // THEN close — leaving a duplicate of the subpath's first anchor. Fold it
      // back in (its incoming handle moves onto the start anchor), otherwise a
      // round-trip grows every closed subpath by one anchor.
      const first = pts[subIdx], last = pts[pts.length - 1]
      if (last && first && last !== first
          && Math.abs(last.x - first.x) < 1e-6 && Math.abs(last.y - first.y) < 1e-6) {
        if (last.hIn) first.hIn = last.hIn
        pts.pop()
      }
      closed = true; cx = startX; cy = startY
    } else { i++ }
  }
  return { points: pts, closed }
}

// True when a transform maps the axes onto themselves (translate/scale/flip only).
// If it doesn't — rotation, skew — a rect or ellipse can no longer be expressed in
// Apex's axis-aligned bbox model, so the caller emits an exact path instead.
function axisAligned(tf: (p: { x: number; y: number }) => { x: number; y: number }): boolean {
  const o = tf({ x: 0, y: 0 }), ux = tf({ x: 1, y: 0 }), uy = tf({ x: 0, y: 1 })
  return Math.abs(ux.y - o.y) < 1e-6 && Math.abs(uy.x - o.x) < 1e-6
}

// Circle/ellipse as four cubic quadrants — the classic kappa approximation.
const KAPPA = 0.5522847498307936
function ellipsePoints(cx: number, cy: number, rx: number, ry: number): PathPoint[] {
  const kx = rx * KAPPA, ky = ry * KAPPA
  return [
    { x: cx,      y: cy - ry, hIn: [-kx, 0], hOut: [kx, 0] },
    { x: cx + rx, y: cy,      hIn: [0, -ky], hOut: [0, ky] },
    { x: cx,      y: cy + ry, hIn: [kx, 0],  hOut: [-kx, 0] },
    { x: cx - rx, y: cy,      hIn: [0, ky],  hOut: [0, -ky] },
  ]
}

// Maps anchors AND their handles through a transform (handles are relative, so
// they travel as absolute points and are re-relativised afterwards).
function mapPts(points: PathPoint[], tf: (p: { x: number; y: number }) => { x: number; y: number }): PathPoint[] {
  return points.map(p => {
    const np = tf({ x: p.x, y: p.y })
    const out: PathPoint = { x: np.x, y: np.y, move: p.move }
    if (p.hIn) { const h = tf({ x: p.x + p.hIn[0], y: p.y + p.hIn[1] }); out.hIn = [h.x - np.x, h.y - np.y] }
    if (p.hOut) { const h = tf({ x: p.x + p.hOut[0], y: p.y + p.hOut[1] }); out.hOut = [h.x - np.x, h.y - np.y] }
    return out
  })
}

// Builds a point mapper for a cumulative transform="translate/scale/rotate/matrix".
function parseTransform(t: string | null): (p: { x: number; y: number }) => { x: number; y: number } {
  if (!t) return p => p
  const fns: ((p: { x: number; y: number }) => { x: number; y: number })[] = []
  const re = /(translate|scale|rotate|matrix)\s*\(([^)]*)\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(t))) {
    const a = m[2].split(/[ ,]+/).map(parseFloat).filter(n => !isNaN(n))
    if (m[1] === 'translate') { const [tx, ty = 0] = a; fns.push(p => ({ x: p.x + tx, y: p.y + ty })) }
    else if (m[1] === 'scale') { const [sx, sy = a[0]] = a; fns.push(p => ({ x: p.x * sx, y: p.y * sy })) }
    else if (m[1] === 'rotate') {
      const [deg, rx = 0, ry = 0] = a
      const r = (deg * Math.PI) / 180, cos = Math.cos(r), sin = Math.sin(r)
      fns.push(p => {
        const dx = p.x - rx, dy = p.y - ry
        return { x: rx + dx * cos - dy * sin, y: ry + dx * sin + dy * cos }
      })
    }
    else if (m[1] === 'matrix' && a.length === 6) { const [aa, b, c, dd, e, f] = a; fns.push(p => ({ x: aa * p.x + c * p.y + e, y: b * p.x + dd * p.y + f })) }
  }
  return p => fns.reduce((q, fn) => fn(q), p)
}

export function svgToPageData(svgText: string): VectorPageData {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml')
  const svg = doc.querySelector('svg')
  if (!svg || doc.querySelector('parsererror')) throw new Error('SVG invalide')

  // Artboard dimensions
  let W = 1000, H = 1000, ox = 0, oy = 0
  const vb = svg.getAttribute('viewBox')
  if (vb) { const [x, y, w, h] = vb.split(/[ ,]+/).map(parseFloat); if (!isNaN(w) && !isNaN(h)) { ox = x; oy = y; W = w; H = h } }
  else { W = parseFloat(svg.getAttribute('width') || '1000') || 1000; H = parseFloat(svg.getAttribute('height') || '1000') || 1000 }

  // Paint servers are indexed document-wide: they are conventionally in <defs>,
  // but nothing requires it.
  const grads: GradMap = new Map()
  for (const g of Array.from(svg.querySelectorAll('linearGradient, radialGradient'))) {
    const id = g.getAttribute('id')
    if (id) grads.set(id, g)
  }
  const css = parseCssRules(svg)
  const clipDefs = new Map<string, Element>()
  for (const cp of Array.from(svg.querySelectorAll('clipPath'))) {
    const id = cp.getAttribute('id')
    if (id) clipDefs.set(id, cp)
  }

  const elements: VectorElement[] = []
  let z = 0
  const readBlend = (sm: Record<string, string>): string | undefined => {
    const b = sm['mix-blend-mode']
    return b && b !== 'normal' ? b : undefined
  }
  const base = (el: Element, sm: Record<string, string>, bb: { x: number; y: number; w: number; h: number }, parentId: string | null): BaseElement => ({
    id: uid('el'), type: '', name: el.tagName, x: bb.x, y: bb.y, w: bb.w, h: bb.h, rotation: 0,
    visible: (attrOrStyle(el, 'display', sm) !== 'none'),
    locked: false, opacity: Math.round((parseFloat(attrOrStyle(el, 'opacity', sm) ?? '1') || 1) * 100),
    zIndex: z++, blend: readBlend(sm), fill: readFill(el, sm, grads), stroke: readStroke(el, sm, grads), parentId,
  })

  const walk = (node: Element, xf: (p: { x: number; y: number }) => { x: number; y: number }, parentId: string | null) => {
    for (const el of Array.from(node.children)) {
      const tag = el.tagName.toLowerCase()
      const tf = (p: { x: number; y: number }) => xf(parseTransform(el.getAttribute('transform'))(p))
      const sm = styleMap(el, css)
      if (tag === 'defs' || tag === 'title' || tag === 'desc' || tag === 'style' || tag === 'metadata') continue
      if (tag === 'g') {
        // Keep the hierarchy: a real group element, children hung off it.
        // A clip-path reference makes it a clipping-mask group: the clipPath's
        // shapes are imported as its TOPMOST child (wrapped in a sub-group).
        const clipRef = attrOrStyle(el, 'clip-path', sm)
        const clipEl = clipRef ? clipDefs.get(paintRef(clipRef) ?? '') : undefined
        const gid = uid('g')
        elements.push({
          id: gid, type: 'group', name: el.getAttribute('data-name') || el.getAttribute('id') || 'Group',
          x: 0, y: 0, w: 0, h: 0, rotation: 0,
          visible: (attrOrStyle(el, 'display', sm) !== 'none'), locked: false,
          opacity: Math.round((parseFloat(attrOrStyle(el, 'opacity', sm) ?? '1') || 1) * 100),
          zIndex: z++, blend: readBlend(sm), fill: { type: 'none' }, stroke: null, parentId, collapsed: true,
          clipped: !!clipEl,
        } as GroupElement)
        walk(el, tf, gid)
        if (clipEl) {
          const mid = uid('g')
          elements.push({
            id: mid, type: 'group', name: 'Mask',
            x: 0, y: 0, w: 0, h: 0, rotation: 0, visible: true, locked: false,
            opacity: 100, zIndex: z++, fill: { type: 'none' }, stroke: null, parentId: gid, collapsed: true,
          } as GroupElement)
          walk(clipEl, tf, mid)
        }
        continue
      }
      const P = (x: number, y: number) => tf({ x, y })
      if (tag === 'rect') {
        const x = parseFloat(el.getAttribute('x') || '0'), y = parseFloat(el.getAttribute('y') || '0')
        const w = parseFloat(el.getAttribute('width') || '0'), h = parseFloat(el.getAttribute('height') || '0')
        if (!axisAligned(tf)) {
          // Rotated/skewed: keep the true geometry as a 4-corner path.
          const pts = mapPts([{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }], tf)
          elements.push({ ...base(el, sm, bbox(pts), parentId), type: 'path', points: pts, closed: true } as PathElement)
        } else {
          const tl = P(x, y), br = P(x + w, y + h)
          const bb = { x: Math.min(tl.x, br.x), y: Math.min(tl.y, br.y), w: Math.abs(br.x - tl.x), h: Math.abs(br.y - tl.y) }
          elements.push({ ...base(el, sm, bb, parentId), type: 'rect', cornerRadius: parseFloat(el.getAttribute('rx') || '0') || 0 } as RectElement)
        }
      } else if (tag === 'circle' || tag === 'ellipse') {
        const cx = parseFloat(el.getAttribute('cx') || '0'), cy = parseFloat(el.getAttribute('cy') || '0')
        const rx = parseFloat(el.getAttribute('r') || el.getAttribute('rx') || '0')
        const ry = parseFloat(el.getAttribute('r') || el.getAttribute('ry') || '0')
        if (!axisAligned(tf)) {
          const pts = mapPts(ellipsePoints(cx, cy, rx, ry), tf)
          elements.push({ ...base(el, sm, bbox(pts), parentId), type: 'path', points: pts, closed: true } as PathElement)
        } else {
          const tl = P(cx - rx, cy - ry), br = P(cx + rx, cy + ry)
          const bb = { x: Math.min(tl.x, br.x), y: Math.min(tl.y, br.y), w: Math.abs(br.x - tl.x), h: Math.abs(br.y - tl.y) }
          elements.push({ ...base(el, sm, bb, parentId), type: 'ellipse' } as EllipseElement)
        }
      } else if (tag === 'line') {
        const pts = [P(parseFloat(el.getAttribute('x1') || '0'), parseFloat(el.getAttribute('y1') || '0')),
                     P(parseFloat(el.getAttribute('x2') || '0'), parseFloat(el.getAttribute('y2') || '0'))]
        elements.push({ ...base(el, sm, bbox(pts), parentId), type: 'path', points: pts.map(p => ({ x: p.x, y: p.y })), closed: false } as PathElement)
      } else if (tag === 'polyline' || tag === 'polygon') {
        const nums = (el.getAttribute('points') || '').split(/[ ,]+/).map(parseFloat).filter(n => !isNaN(n))
        const pts: PathPoint[] = []
        for (let k = 0; k + 1 < nums.length; k += 2) { const p = P(nums[k], nums[k + 1]); pts.push({ x: p.x, y: p.y }) }
        if (pts.length) elements.push({ ...base(el, sm, bbox(pts), parentId), type: 'path', points: pts, closed: tag === 'polygon' } as PathElement)
      } else if (tag === 'path') {
        const { points, closed } = parsePathD(el.getAttribute('d') || '')
        const tp = mapPts(points, tf)
        if (tp.length) elements.push({ ...base(el, sm, bbox(tp), parentId), type: 'path', points: tp, closed } as PathElement)
      } else if (tag === 'text') {
        const x = parseFloat(el.getAttribute('x') || '0'), y = parseFloat(el.getAttribute('y') || '0')
        const p = P(x, y)
        const fs = parseFloat(attrOrStyle(el, 'font-size', sm) || '16') || 16
        const anchor = attrOrStyle(el, 'text-anchor', sm)
        // Multiple tspans = one line each (how both our exporter and most tools
        // encode line breaks); a single run keeps its own newlines.
        const tspans = Array.from(el.children).filter(c => c.tagName.toLowerCase() === 'tspan')
        const lines = tspans.length > 1
          ? tspans.map(ts => (ts.textContent || '').trim())
          : (el.textContent || '').trim().split('\n').map(s => s.trim())
        const txt = lines.join('\n')
        if (!txt) continue
        const family = (attrOrStyle(el, 'font-family', sm) || 'sans-serif').replace(/["']/g, '')
        const weight = parseInt(attrOrStyle(el, 'font-weight', sm) || '400') || 400
        const italic = (attrOrStyle(el, 'font-style', sm) || '') === 'italic'
        const width = Math.max(10, ...lines.map(ln => measureLine(ln, fs, family, weight, italic)))
        // (x,y) is the FIRST BASELINE of the anchor point; Apex's box is top-left.
        const bx = anchor === 'middle' ? p.x - width / 2 : anchor === 'end' ? p.x - width : p.x
        const bb = { x: bx, y: p.y - fs, w: width, h: fs * 1.25 * lines.length }
        elements.push({
          ...base(el, sm, bb, parentId), type: 'text', text: txt, fontSize: fs,
          fontFamily: family, fontWeight: weight, italic,
          align: anchor === 'middle' ? 'center' : anchor === 'end' ? 'right' : 'left',
        } as TextElement)
      } else if (tag === 'image') {
        const href = el.getAttribute('href') ?? el.getAttribute('xlink:href')
          ?? el.getAttributeNS('http://www.w3.org/1999/xlink', 'href')
        if (!href) continue
        const x = parseFloat(el.getAttribute('x') || '0'), y = parseFloat(el.getAttribute('y') || '0')
        const w = parseFloat(el.getAttribute('width') || '0'), h = parseFloat(el.getAttribute('height') || '0')
        if (!w || !h) continue
        const tl = P(x, y), br = P(x + w, y + h)
        const bb = { x: Math.min(tl.x, br.x), y: Math.min(tl.y, br.y), w: Math.abs(br.x - tl.x), h: Math.abs(br.y - tl.y) }
        elements.push({
          ...base(el, sm, bb, parentId), type: 'image',
          fill: { type: 'none' }, stroke: null,
          src: href, natW: w, natH: h,
        } as import('./api').ImageElement)
      }
    }
  }
  walk(svg, p => p, null)

  return {
    artboards: [{ id: uid('ab'), name: 'Page 1', x: ox, y: oy, width: W, height: H, background: '#ffffff' }],
    elements,
    guides: [],
  }
}
