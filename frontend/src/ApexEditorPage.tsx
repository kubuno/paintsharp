import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  MousePointer, Square, Circle, Type, Hand, Minus, Hexagon, Star,
  Plus, Trash2, Eye, EyeOff, Lock, Unlock, ChevronRight,
  AlignLeft, AlignCenter, AlignRight,
  AlignStartVertical, AlignCenterVertical, AlignEndVertical,
  AlignHorizontalDistributeCenter, AlignVerticalDistributeCenter,
  PenTool, ZoomIn, ZoomOut, Copy, FlipHorizontal, FlipVertical,
  BringToFront, SendToBack, ChevronUp, ChevronDown,
  Spline, Pipette, Group, Ungroup, Waypoints,
  Search, RotateCw,
} from 'lucide-react'
import { Dropdown, Checkbox, GradientField, DEFAULT_GRADIENT, type Gradient } from '@ui'
import { apexApi, type VectorPageData, type VectorElement, type PathPoint, type PathElement, type TextElement, type FillStyle } from './api'
import { C as SHELL_C, EditorShell, DockArea, ColorField, paintsharpMenus, useContextMenu, type CtxItem } from './ui'

// ── Palette (shared Paintsharp theme + a `handle` alias for canvas selection handles) ──
const C = { ...SHELL_C, handle: SHELL_C.accent }

// Map between Apex's FillStyle and the core @ui Gradient model.
function apexFillToGradient(fill: FillStyle): Gradient {
  if (fill.type === 'radial-gradient') return { type: 'radial', angle: fill.angle ?? 0, stops: fill.stops }
  if (fill.type === 'linear-gradient') return { type: 'linear', angle: fill.angle, stops: fill.stops }
  return DEFAULT_GRADIENT
}
function gradientToApexFill(g: Gradient): FillStyle {
  return g.type === 'radial'
    ? { type: 'radial-gradient', stops: g.stops, angle: g.angle }
    : { type: 'linear-gradient', stops: g.stops, angle: g.angle }
}

// ── Types ──────────────────────────────────────────────────────────────────────
type Tool = 'select' | 'node' | 'rect' | 'ellipse' | 'line' | 'polygon' | 'star' | 'text' | 'hand' | 'pen' | 'eyedropper' | 'zoom' | 'rotateview'

interface CanvasState { zoom: number; panX: number; panY: number; rot?: number }

interface PenProgress {
  points:   PathPoint[]
  dragging: boolean
  mousePos: { x: number; y: number } | null
}

function newId() { return crypto.randomUUID() }
function defaultFill() { return { type: 'solid' as const, color: '#4a90d9', opacity: 100 } }
function defaultStroke() { return null }

// Measure a text element's bbox (shared offscreen canvas).
let _measureCtx: CanvasRenderingContext2D | null = null
function measureText(te: { text: string; fontSize: number; fontFamily: string; fontWeight: number; italic: boolean }): { w: number; h: number } {
  if (!_measureCtx) _measureCtx = document.createElement('canvas').getContext('2d')
  const lines = te.text.split('\n')
  const h = Math.max(1, lines.length) * te.fontSize * 1.25
  if (!_measureCtx) return { w: te.text.length * te.fontSize * 0.6, h }
  _measureCtx.font = `${te.italic ? 'italic ' : ''}${te.fontWeight} ${te.fontSize}px ${te.fontFamily}, sans-serif`
  const w = Math.max(1, ...lines.map(l => _measureCtx!.measureText(l).width))
  return { w, h }
}

function makePage1(): VectorPageData {
  return {
    artboards: [{
      id: newId(), name: 'Artboard 1',
      x: 0, y: 0, width: 1920, height: 1080, background: 'white',
    }],
    elements: [],
    guides: [],
  }
}

// ── Path drawing helpers ───────────────────────────────────────────────────────

// "#rrggbb" + opacity(0-100) → "rgba(...)"
function hexWithAlpha(hex: string, opacity: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return hex
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.max(0, Math.min(1, opacity / 100))})`
}

// Bézier entre deux ancres consécutives.
function bezierTo(ctx: CanvasRenderingContext2D, prev: PathPoint, curr: PathPoint) {
  ctx.bezierCurveTo(
    prev.hOut ? prev.x + prev.hOut[0] : prev.x,
    prev.hOut ? prev.y + prev.hOut[1] : prev.y,
    curr.hIn  ? curr.x + curr.hIn[0]  : curr.x,
    curr.hIn  ? curr.y + curr.hIn[1]  : curr.y,
    curr.x, curr.y,
  )
}
function buildPathShape(ctx: CanvasRenderingContext2D, pts: PathPoint[], closed: boolean) {
  if (pts.length === 0) return
  ctx.beginPath()
  ctx.moveTo(pts[0].x, pts[0].y)
  // Sous-chemins (chemin composé) : un point `move` ferme le sous-chemin courant
  // (si fermé) et en démarre un nouveau — permet la fusion de plusieurs objets.
  let subStart = 0
  const closeSub = (end: number) => {
    if (closed && end - subStart >= 1) { bezierTo(ctx, pts[end], pts[subStart]); ctx.closePath() }
  }
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].move) {
      closeSub(i - 1)
      ctx.moveTo(pts[i].x, pts[i].y)
      subStart = i
      continue
    }
    bezierTo(ctx, pts[i - 1], pts[i])
  }
  closeSub(pts.length - 1)
}

// ── Renderer ───────────────────────────────────────────────────────────────────
function renderCanvas(
  ctx: CanvasRenderingContext2D,
  w: number, h: number,
  pageData: VectorPageData,
  cs: CanvasState,
  selectedIds: string[],
  dpr: number,
  marquee?: { x: number; y: number; w: number; h: number } | null,
) {
  ctx.save()
  ctx.scale(dpr, dpr)

  ctx.fillStyle = C.bg
  ctx.fillRect(0, 0, w, h)

  ctx.save()
  ctx.translate(cs.panX, cs.panY)
  if (cs.rot) ctx.rotate(cs.rot)
  ctx.scale(cs.zoom, cs.zoom)

  // Artboards
  for (const ab of pageData.artboards) {
    ctx.save()
    ctx.shadowColor = 'rgba(0,0,0,0.5)'
    ctx.shadowBlur  = 20
    ctx.shadowOffsetY = 4
    ctx.fillStyle = ab.background === 'white' ? '#ffffff' : ab.background
    ctx.fillRect(ab.x, ab.y, ab.width, ab.height)
    ctx.restore()
    ctx.fillStyle   = '#999'
    ctx.font        = `${12 / cs.zoom}px Inter, sans-serif`
    ctx.textBaseline = 'bottom'
    ctx.fillText(ab.name, ab.x, ab.y - 4 / cs.zoom)
  }

  // Elements
  const sorted = [...pageData.elements].sort((a, b) => a.zIndex - b.zIndex)
  for (const el of sorted) {
    if (!el.visible) continue
    ctx.save()
    ctx.globalAlpha = el.opacity / 100

    if (el.rotation !== 0) {
      const cx = el.x + el.w / 2, cy = el.y + el.h / 2
      ctx.translate(cx, cy)
      ctx.rotate(el.rotation * Math.PI / 180)
      ctx.translate(-cx, -cy)
    }

    const fill = el.fill
    let pathBuilt = false

    if (el.type === 'rect') {
      ctx.beginPath()
      const r = (el as import('./api').RectElement).cornerRadius ?? 0
      if (r > 0) ctx.roundRect(el.x, el.y, el.w, el.h, r)
      else       ctx.rect(el.x, el.y, el.w, el.h)
      pathBuilt = true
    } else if (el.type === 'ellipse') {
      ctx.beginPath()
      ctx.ellipse(el.x + el.w / 2, el.y + el.h / 2, el.w / 2, el.h / 2, 0, 0, Math.PI * 2)
      pathBuilt = true
    } else if (el.type === 'path') {
      const pe = el as PathElement
      buildPathShape(ctx, pe.points, pe.closed)
      pathBuilt = true
    } else if (el.type === 'text') {
      const te = el as TextElement
      ctx.fillStyle = te.fill.type === 'solid' ? te.fill.color : '#000000'
      ctx.font = `${te.italic ? 'italic ' : ''}${te.fontWeight} ${te.fontSize}px ${te.fontFamily}, sans-serif`
      ctx.textBaseline = 'top'
      ctx.textAlign = te.align
      const ax = te.align === 'center' ? te.x + te.w / 2 : te.align === 'right' ? te.x + te.w : te.x
      const lines = te.text.split('\n')
      lines.forEach((ln, i) => ctx.fillText(ln, ax, te.y + i * te.fontSize * 1.25))
      ctx.textAlign = 'left'
    }

    if (pathBuilt) {
      if (fill.type === 'solid') {
        ctx.fillStyle = fill.color
        ctx.globalAlpha = (el.opacity / 100) * (fill.opacity / 100)
        ctx.fill()
      } else if (fill.type === 'linear-gradient') {
        const b = elBBox(el)
        const ang = ((fill.angle ?? 0) * Math.PI) / 180
        const cx = b.x + b.w / 2, cy = b.y + b.h / 2
        const dx = Math.cos(ang), dy = Math.sin(ang)
        const half = (Math.abs(dx) * b.w + Math.abs(dy) * b.h) / 2
        const g = ctx.createLinearGradient(cx - dx * half, cy - dy * half, cx + dx * half, cy + dy * half)
        const stops = [...fill.stops].sort((a, z) => a.position - z.position)
        for (const s of stops) g.addColorStop(Math.max(0, Math.min(1, s.position)), hexWithAlpha(s.color, s.opacity))
        ctx.fillStyle = g
        ctx.globalAlpha = el.opacity / 100
        ctx.fill()
      } else if (fill.type === 'radial-gradient') {
        const b = elBBox(el)
        const cx = b.x + b.w / 2, cy = b.y + b.h / 2
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(b.w, b.h) / 2)
        const stops = [...fill.stops].sort((a, z) => a.position - z.position)
        for (const s of stops) g.addColorStop(Math.max(0, Math.min(1, s.position)), hexWithAlpha(s.color, s.opacity))
        ctx.fillStyle = g
        ctx.globalAlpha = el.opacity / 100
        ctx.fill()
      }
      if (el.stroke && el.stroke.width > 0) {
        ctx.strokeStyle = el.stroke.color
        ctx.lineWidth   = el.stroke.width
        ctx.lineCap     = el.stroke.cap  ?? 'butt'
        ctx.lineJoin    = el.stroke.join ?? 'miter'
        ctx.setLineDash((el.stroke.dashArray ?? []).map(d => d))
        ctx.globalAlpha = (el.opacity / 100) * (el.stroke.opacity / 100)
        ctx.stroke()
        ctx.setLineDash([])
      }
    }

    ctx.restore()
  }

  // Selection boxes
  for (const id of selectedIds) {
    const el = pageData.elements.find(e => e.id === id)
    if (!el) continue
    // Couleur de sélection distincte : objet VECTORIEL (chemin libre, éditable à la
    // plume) en magenta ; FORME paramétrique (rect/ellipse/polygone/étoile) en bleu.
    const isVector = el.type === 'path' && !(el as PathElement).shape
    const selColor = isVector ? '#d6249f' : C.handle
    // Compute bounding box
    let bx = el.x, by = el.y, bw = el.w, bh = el.h
    if (el.type === 'path') {
      const pts = (el as PathElement).points
      if (pts.length > 0) {
        bx = Math.min(...pts.map(p => p.x))
        by = Math.min(...pts.map(p => p.y))
        bw = Math.max(...pts.map(p => p.x)) - bx
        bh = Math.max(...pts.map(p => p.y)) - by
      }
    }
    ctx.save()
    if (el.rotation !== 0) {
      const cx = bx + bw / 2, cy = by + bh / 2
      ctx.translate(cx, cy)
      ctx.rotate(el.rotation * Math.PI / 180)
      ctx.translate(-cx, -cy)
    }
    ctx.strokeStyle = selColor
    ctx.lineWidth   = 1.5 / cs.zoom
    ctx.setLineDash([])
    ctx.strokeRect(bx - 1 / cs.zoom, by - 1 / cs.zoom, bw + 2 / cs.zoom, bh + 2 / cs.zoom)

    const hSz = 6 / cs.zoom
    const handles = [
      [bx, by], [bx + bw / 2, by], [bx + bw, by],
      [bx, by + bh / 2],             [bx + bw, by + bh / 2],
      [bx, by + bh], [bx + bw / 2, by + bh], [bx + bw, by + bh],
    ]
    ctx.fillStyle   = '#fff'
    ctx.strokeStyle = selColor
    ctx.lineWidth   = 1.5 / cs.zoom
    handles.forEach(([hx, hy]) => {
      ctx.fillRect(hx - hSz / 2, hy - hSz / 2, hSz, hSz)
      ctx.strokeRect(hx - hSz / 2, hy - hSz / 2, hSz, hSz)
    })
    // Rotation handle (single selection)
    if (selectedIds.length === 1) {
      const rhx = bx + bw / 2, rhy = by - 22 / cs.zoom
      ctx.beginPath(); ctx.moveTo(bx + bw / 2, by); ctx.lineTo(rhx, rhy); ctx.stroke()
      ctx.beginPath(); ctx.arc(rhx, rhy, 4 / cs.zoom, 0, Math.PI * 2)
      ctx.fillStyle = '#fff'; ctx.fill(); ctx.stroke()
    }
    ctx.restore()
  }

  // Marquee selection rectangle
  if (marquee) {
    ctx.save()
    ctx.fillStyle = C.accent + '22'; ctx.strokeStyle = C.accent
    ctx.lineWidth = 1 / cs.zoom; ctx.setLineDash([4 / cs.zoom, 3 / cs.zoom])
    ctx.fillRect(marquee.x, marquee.y, marquee.w, marquee.h)
    ctx.strokeRect(marquee.x, marquee.y, marquee.w, marquee.h)
    ctx.restore()
  }

  ctx.restore()
  ctx.restore()
}

// ── Pen overlay renderer ───────────────────────────────────────────────────────
function drawPenOverlay(
  ctx: CanvasRenderingContext2D,
  pen: PenProgress,
  cs: CanvasState,
  dpr: number,
) {
  ctx.save()
  ctx.scale(dpr, dpr)
  ctx.save()
  ctx.translate(cs.panX, cs.panY)
  if (cs.rot) ctx.rotate(cs.rot)
  ctx.scale(cs.zoom, cs.zoom)

  const pts   = pen.points
  const mouse = pen.mousePos
  const lw    = 1.5 / cs.zoom

  // Draw committed path segments
  if (pts.length >= 2) {
    ctx.strokeStyle = C.accent
    ctx.lineWidth   = lw
    ctx.setLineDash([])
    buildPathShape(ctx, pts, false)
    ctx.stroke()
  }

  // Preview segment from last point to mouse
  if (mouse && pts.length >= 1) {
    const last = pts[pts.length - 1]
    ctx.strokeStyle = C.accent + '80'
    ctx.lineWidth   = lw
    ctx.setLineDash([4 / cs.zoom, 4 / cs.zoom])
    ctx.beginPath()
    ctx.moveTo(last.x, last.y)
    const cp1x = last.hOut ? last.x + last.hOut[0] : last.x
    const cp1y = last.hOut ? last.y + last.hOut[1] : last.y
    ctx.bezierCurveTo(cp1x, cp1y, mouse.x, mouse.y, mouse.x, mouse.y)
    ctx.stroke()
    ctx.setLineDash([])
  }

  // Handle arms and handle dots
  for (const pt of pts) {
    const armLw = lw * 0.6
    const hDot  = 3 / cs.zoom
    if (pt.hOut) {
      ctx.strokeStyle = '#aaaaaa'
      ctx.lineWidth   = armLw
      ctx.beginPath()
      ctx.moveTo(pt.x, pt.y)
      ctx.lineTo(pt.x + pt.hOut[0], pt.y + pt.hOut[1])
      ctx.stroke()
      ctx.fillStyle = C.accent
      ctx.beginPath()
      ctx.arc(pt.x + pt.hOut[0], pt.y + pt.hOut[1], hDot, 0, Math.PI * 2)
      ctx.fill()
    }
    if (pt.hIn) {
      ctx.strokeStyle = '#aaaaaa'
      ctx.lineWidth   = armLw
      ctx.beginPath()
      ctx.moveTo(pt.x, pt.y)
      ctx.lineTo(pt.x + pt.hIn[0], pt.y + pt.hIn[1])
      ctx.stroke()
      ctx.fillStyle = C.accent
      ctx.beginPath()
      ctx.arc(pt.x + pt.hIn[0], pt.y + pt.hIn[1], hDot, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  // Anchor point squares + first-point close affordance
  const ancSz = 4 / cs.zoom
  for (let i = 0; i < pts.length; i++) {
    const pt = pts[i]
    const isFirst  = i === 0
    const nearFirst = isFirst && mouse &&
      Math.hypot(mouse.x - pt.x, mouse.y - pt.y) < 12 / cs.zoom

    ctx.fillStyle   = nearFirst ? C.accent + '40' : '#ffffff'
    ctx.strokeStyle = C.accent
    ctx.lineWidth   = lw
    ctx.beginPath()
    ctx.rect(pt.x - ancSz / 2, pt.y - ancSz / 2, ancSz, ancSz)
    ctx.fill()
    ctx.stroke()

    if (isFirst && pts.length >= 2) {
      ctx.strokeStyle = nearFirst ? C.accent : C.accent + '50'
      ctx.lineWidth   = lw * 0.7
      ctx.beginPath()
      ctx.arc(pt.x, pt.y, 9 / cs.zoom, 0, Math.PI * 2)
      ctx.stroke()
    }
  }

  ctx.restore()
  ctx.restore()
}

// ── Node-editing (direct selection) overlay & hit-testing ───────────────────────
type NodeHit = { kind: 'anchor' | 'in' | 'out'; index: number }

function hitNode(path: PathElement, px: number, py: number, zoom: number): NodeHit | null {
  const tol = 6 / zoom
  // Handles take priority over anchors (they sit further out and are smaller).
  for (let i = 0; i < path.points.length; i++) {
    const p = path.points[i]
    if (p.hOut && Math.hypot(px - (p.x + p.hOut[0]), py - (p.y + p.hOut[1])) <= tol) return { kind: 'out', index: i }
    if (p.hIn  && Math.hypot(px - (p.x + p.hIn[0]),  py - (p.y + p.hIn[1]))  <= tol) return { kind: 'in',  index: i }
  }
  for (let i = 0; i < path.points.length; i++) {
    const p = path.points[i]
    if (Math.hypot(px - p.x, py - p.y) <= tol + 1 / zoom) return { kind: 'anchor', index: i }
  }
  return null
}

function renderNodeOverlay(
  ctx: CanvasRenderingContext2D,
  path: PathElement,
  cs: CanvasState,
  dpr: number,
  selIdx: number | null,
) {
  ctx.save()
  ctx.scale(dpr, dpr)
  ctx.translate(cs.panX, cs.panY)
  if (cs.rot) ctx.rotate(cs.rot)
  ctx.scale(cs.zoom, cs.zoom)
  // Applique la rotation propre de l'élément (même transform que le rendu du fill)
  // pour que l'overlay des nœuds colle exactement à la forme affichée.
  if (path.rotation) {
    const cx = path.x + path.w / 2, cy = path.y + path.h / 2
    ctx.translate(cx, cy)
    ctx.rotate((path.rotation * Math.PI) / 180)
    ctx.translate(-cx, -cy)
  }
  const lw = 1.2 / cs.zoom
  // Path outline
  ctx.strokeStyle = C.accent
  ctx.lineWidth = lw
  ctx.setLineDash([])
  buildPathShape(ctx, path.points, path.closed)
  ctx.stroke()
  // Handle arms + dots
  const hd = 3 / cs.zoom
  for (let i = 0; i < path.points.length; i++) {
    const p = path.points[i]
    for (const h of [p.hIn, p.hOut]) {
      if (!h) continue
      ctx.strokeStyle = '#8aa9c9'; ctx.lineWidth = lw * 0.7
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + h[0], p.y + h[1]); ctx.stroke()
      ctx.fillStyle = '#fff'; ctx.strokeStyle = C.accent; ctx.lineWidth = lw
      ctx.beginPath(); ctx.arc(p.x + h[0], p.y + h[1], hd, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
    }
  }
  // Anchors (selected one filled accent)
  const a = 4 / cs.zoom
  for (let i = 0; i < path.points.length; i++) {
    const p = path.points[i]
    ctx.fillStyle = i === selIdx ? C.accent : '#fff'
    ctx.strokeStyle = C.accent; ctx.lineWidth = lw
    ctx.beginPath(); ctx.rect(p.x - a, p.y - a, a * 2, a * 2); ctx.fill(); ctx.stroke()
  }
  ctx.restore()
}

// ── Canvas coordinate helpers ──────────────────────────────────────────────────
function toCanvas(
  e: { clientX: number; clientY: number },
  rect: DOMRect,
  cs: CanvasState,
) {
  const dx = e.clientX - rect.left - cs.panX
  const dy = e.clientY - rect.top  - cs.panY
  // Inverse of: screen = pan + R(rot)·(zoom·world) → world = R(-rot)·(screen-pan)/zoom
  if (cs.rot) {
    const c = Math.cos(-cs.rot), s = Math.sin(-cs.rot)
    return { x: (c * dx - s * dy) / cs.zoom, y: (s * dx + c * dy) / cs.zoom }
  }
  return {
    x: dx / cs.zoom,
    y: dy / cs.zoom,
  }
}

function hitHandle(el: VectorElement, cx: number, cy: number, zoom: number): number {
  let bx = el.x, by = el.y, bw = el.w, bh = el.h
  if (el.type === 'path') {
    const pts = (el as PathElement).points
    if (pts.length > 0) {
      bx = Math.min(...pts.map(p => p.x))
      by = Math.min(...pts.map(p => p.y))
      bw = Math.max(...pts.map(p => p.x)) - bx
      bh = Math.max(...pts.map(p => p.y)) - by
    }
  }
  const hSz = 6 / zoom
  const handles = [
    [bx, by], [bx + bw / 2, by], [bx + bw, by],
    [bx, by + bh / 2],             [bx + bw, by + bh / 2],
    [bx, by + bh], [bx + bw / 2, by + bh], [bx + bw, by + bh],
  ]
  for (let i = 0; i < handles.length; i++) {
    const [hx, hy] = handles[i]
    if (Math.abs(cx - hx) <= hSz && Math.abs(cy - hy) <= hSz) return i
  }
  return -1
}

function hitTest(el: VectorElement, px: number, py: number): boolean {
  if (el.type === 'path') {
    const pts = (el as PathElement).points
    if (pts.length === 0) return false
    const minX = Math.min(...pts.map(p => p.x))
    const minY = Math.min(...pts.map(p => p.y))
    const maxX = Math.max(...pts.map(p => p.x))
    const maxY = Math.max(...pts.map(p => p.y))
    return px >= minX && px <= maxX && py >= minY && py <= maxY
  }
  return px >= el.x && px <= el.x + el.w && py >= el.y && py <= el.y + el.h
}

// ── Geometry helpers ───────────────────────────────────────────────────────────
function elBBox(el: VectorElement): { x: number; y: number; w: number; h: number } {
  if (el.type === 'path') {
    const pts = (el as PathElement).points
    if (pts.length) {
      const xs = pts.map(p => p.x), ys = pts.map(p => p.y)
      const x = Math.min(...xs), y = Math.min(...ys)
      return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
    }
  }
  return { x: el.x, y: el.y, w: el.w, h: el.h }
}
function selBBox(els: VectorElement[]): { x: number; y: number; w: number; h: number } | null {
  if (!els.length) return null
  const bs = els.map(elBBox)
  const x = Math.min(...bs.map(b => b.x)), y = Math.min(...bs.map(b => b.y))
  const r = Math.max(...bs.map(b => b.x + b.w)), b = Math.max(...bs.map(b => b.y + b.h))
  return { x, y, w: r - x, h: b - y }
}
// Regular polygon / star path points fitting the (cx,cy,rx,ry) ellipse.
function genPolygon(cx: number, cy: number, rx: number, ry: number, sides: number): PathPoint[] {
  return Array.from({ length: sides }, (_, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / sides
    return { x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) }
  })
}
function genStar(cx: number, cy: number, rx: number, ry: number, points: number, innerRatio = 0.45): PathPoint[] {
  return Array.from({ length: points * 2 }, (_, i) => {
    const a = -Math.PI / 2 + (i * Math.PI) / points
    const k = i % 2 === 0 ? 1 : innerRatio
    return { x: cx + rx * k * Math.cos(a), y: cy + ry * k * Math.sin(a) }
  })
}
// Regenerate a parametric polygon/star's points from its bounding box + params,
// so changing the side/spike count keeps it centred and fitted to the same box.
function regenShapePoints(el: PathElement): PathPoint[] {
  const cx = el.x + el.w / 2, cy = el.y + el.h / 2, rx = el.w / 2, ry = el.h / 2
  if (el.shape === 'star')
    return genStar(cx, cy, rx, ry, Math.max(3, Math.round(el.spikes ?? 5)),
                   Math.max(0.05, Math.min(0.95, el.innerRatio ?? 0.45)))
  if (el.shape === 'polygon')
    return genPolygon(cx, cy, rx, ry, Math.max(3, Math.round(el.sides ?? 6)))
  return el.points
}
// Deep-clone an element with a fresh id (optionally offset).
function cloneEl(el: VectorElement, dx = 0, dy = 0): VectorElement {
  const c = structuredClone(el)
  c.id = newId()
  c.x += dx; c.y += dy
  if (c.type === 'path') (c as PathElement).points = (c as PathElement).points.map(p => ({ ...p, x: p.x + dx, y: p.y + dy }))
  return c
}
// Translate an element by (dx,dy), keeping its id — moves path points too.
function translateEl(el: VectorElement, dx: number, dy: number): VectorElement {
  const c = structuredClone(el)
  c.x += dx; c.y += dy
  if (c.type === 'path') (c as PathElement).points = (c as PathElement).points.map(p => ({ ...p, x: p.x + dx, y: p.y + dy }))
  return c
}
// Convert a rect/ellipse into an editable PathElement (bezier nodes).
function toPathElement(el: VectorElement): PathElement {
  if (el.type === 'path') return el as PathElement
  const { x, y, w, h } = el
  let points: PathPoint[]
  if (el.type === 'ellipse') {
    const k = 0.5522847498
    const rx = w / 2, ry = h / 2, cx = x + rx, cy = y + ry
    points = [
      { x: cx,      y: y,       hIn: [-k * rx, 0], hOut: [k * rx, 0] },
      { x: x + w,   y: cy,      hIn: [0, -k * ry], hOut: [0, k * ry] },
      { x: cx,      y: y + h,   hIn: [k * rx, 0],  hOut: [-k * rx, 0] },
      { x: x,       y: cy,      hIn: [0, k * ry],  hOut: [0, -k * ry] },
    ]
  } else {
    const r = (el as import('./api').RectElement).cornerRadius ?? 0
    if (r > 0) {
      const c = Math.min(r, w / 2, h / 2), k = c * 0.5522847498
      points = [
        { x: x + c,     y: y,         hIn: [-k, 0] },
        { x: x + w - c, y: y,         hOut: [k, 0] },
        { x: x + w,     y: y + c,     hIn: [0, -k] },
        { x: x + w,     y: y + h - c, hOut: [0, k] },
        { x: x + w - c, y: y + h,     hIn: [k, 0] },
        { x: x + c,     y: y + h,     hOut: [-k, 0] },
        { x: x,         y: y + h - c, hIn: [0, k] },
        { x: x,         y: y + c,     hOut: [0, -k] },
      ]
    } else {
      points = [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }]
    }
  }
  const { cornerRadius: _cr, ...rest } = el as import('./api').RectElement & VectorElement
  return { ...(rest as object), type: 'path', points, closed: true } as PathElement
}

// Transforme un point MONDE → repère LOCAL d'un élément (annule sa rotation), autour
// du centre de bbox utilisé au rendu (el.x+el.w/2). Inverse exact de la rotation
// appliquée au fill, pour aligner hit-testing/drag des nœuds avec l'affichage.
function worldToLocal(px: number, py: number, el: VectorElement): { x: number; y: number } {
  if (!el.rotation) return { x: px, y: py }
  const cx = el.x + el.w / 2, cy = el.y + el.h / 2
  const a = (-el.rotation * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a)
  const dx = px - cx, dy = py - cy
  return { x: cx + c * dx - s * dy, y: cy + s * dx + c * dy }
}
// Point on the cubic segment from anchor `a` to anchor `b` at parameter t.
function cubicAt(a: PathPoint, b: PathPoint, t: number): { x: number; y: number } {
  const p0x = a.x, p0y = a.y
  const p1x = a.x + (a.hOut?.[0] ?? 0), p1y = a.y + (a.hOut?.[1] ?? 0)
  const p2x = b.x + (b.hIn?.[0] ?? 0),  p2y = b.y + (b.hIn?.[1] ?? 0)
  const p3x = b.x, p3y = b.y
  const u = 1 - t
  const w0 = u*u*u, w1 = 3*u*u*t, w2 = 3*u*t*t, w3 = t*t*t
  return { x: w0*p0x + w1*p1x + w2*p2x + w3*p3x, y: w0*p0y + w1*p1y + w2*p2y + w3*p3y }
}
// Closest (segmentIndex, t, point, dist) on a path to (px,py). Honors closed loop.
function nearestOnPath(path: PathElement, px: number, py: number) {
  const pts = path.points, n = pts.length
  if (n < 2) return null
  let best = { seg: -1, t: 0, x: 0, y: 0, d: Infinity }
  const last = path.closed ? n : n - 1
  for (let i = 0; i < last; i++) {
    const a = pts[i], b = pts[(i + 1) % n]
    for (let s = 0; s <= 24; s++) {
      const t = s / 24
      const p = cubicAt(a, b, t)
      const d = Math.hypot(p.x - px, p.y - py)
      if (d < best.d) best = { seg: i, t, x: p.x, y: p.y, d }
    }
  }
  return best
}
// Split the segment after anchor `seg` at parameter t (de Casteljau) — inserts a
// new anchor while preserving the curve exactly.
function insertAnchor(path: PathElement, seg: number, t: number): PathElement {
  const pts = path.points.map(p => ({ ...p }))
  const n = pts.length
  const a = pts[seg], b = pts[(seg + 1) % n]
  const P0 = [a.x, a.y], P1 = [a.x + (a.hOut?.[0] ?? 0), a.y + (a.hOut?.[1] ?? 0)]
  const P2 = [b.x + (b.hIn?.[0] ?? 0), b.y + (b.hIn?.[1] ?? 0)], P3 = [b.x, b.y]
  const lerp = (u: number[], v: number[]) => [u[0] + (v[0]-u[0])*t, u[1] + (v[1]-u[1])*t]
  const ab = lerp(P0,P1), bc = lerp(P1,P2), cd = lerp(P2,P3)
  const abc = lerp(ab,bc), bcd = lerp(bc,cd)
  const f = lerp(abc,bcd)
  a.hOut = [ab[0]-a.x, ab[1]-a.y]
  b.hIn  = [cd[0]-b.x, cd[1]-b.y]
  const np: PathPoint = { x: f[0], y: f[1], hIn: [abc[0]-f[0], abc[1]-f[1]], hOut: [bcd[0]-f[0], bcd[1]-f[1]] }
  pts.splice(seg + 1, 0, np)
  return { ...path, points: pts }
}
// Toggle an anchor between corner (no handles) and smooth (symmetric handles
// derived from its neighbours).
function toggleAnchorSmooth(path: PathElement, idx: number): PathElement {
  const pts = path.points.map(p => ({ ...p }))
  const p = pts[idx]
  if (p.hIn || p.hOut) { delete p.hIn; delete p.hOut; return { ...path, points: pts } }
  const n = pts.length
  const prev = pts[(idx - 1 + n) % n], next = pts[(idx + 1) % n]
  const tx = (next.x - prev.x) * 0.18, ty = (next.y - prev.y) * 0.18
  p.hIn = [-tx, -ty]; p.hOut = [tx, ty]
  return { ...path, points: pts }
}
// Screen position of the rotation handle (above the bbox top-centre).
function rotateHandlePos(bb: { x: number; y: number; w: number; h: number }, zoom: number) {
  return { x: bb.x + bb.w / 2, y: bb.y - 22 / zoom }
}

// ── Main editor component ──────────────────────────────────────────────────────
export default function ApexEditorPage() {
  const { t } = useTranslation('paintsharp')
  const { id: projectId } = useParams<{ id: string }>()
  const navigate          = useNavigate()
  const qc                = useQueryClient()

  const { data: project } = useQuery({
    queryKey: ['apex-project', projectId],
    queryFn:  () => apexApi.getProject(projectId!).then(r => r.data),
    enabled:  !!projectId,
  })

  // ── Titre éditable (standard WorkspaceShell) — synchronisé depuis le projet ────
  const [titleDraft, setTitleDraft] = useState('')
  useEffect(() => { if (project?.title != null) setTitleDraft(project.title) }, [project?.title])
  const renameMut = useMutation({
    mutationFn: (title: string) => apexApi.updateProject(projectId!, { title }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['apex-project', projectId] }) },
  })
  const starMut = useMutation({
    mutationFn: (is_starred: boolean) => apexApi.updateProject(projectId!, { is_starred }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['apex-project', projectId] }) },
  })
  const trashMut = useMutation({
    mutationFn: () => apexApi.trashProject(projectId!),
    onSuccess: () => { navigate('/paintsharp/apex') },
  })
  const commitTitle = () => {
    const v = titleDraft.trim()
    if (v && v !== project?.title) renameMut.mutate(v)
    else if (!v && project?.title) setTitleDraft(project.title)
  }

  const [currentPageIdx, setCurrentPageIdx] = useState(0)
  const [pageData, setPageData] = useState<VectorPageData>(makePage1())
  const [pageId, setPageId]     = useState<string | null>(null)

  // ── Sauvegarde automatique fiable ───────────────────────────────────────────
  // Sauve 1,5 s après la dernière modification (debounce) + flush au changement de
  // page et à la fermeture/navigation. (L'ancien intervalle de 30 s se
  // réinitialisait à chaque frappe → ne sauvegardait jamais en édition continue.)
  const saveMut = useMutation({
    mutationFn: (data: VectorPageData) =>
      apexApi.savePage(projectId!, pageId!, data),
  })
  const savePageDataRef = useRef(pageData)
  const pageIdRef   = useRef(pageId)
  const dirtyRef    = useRef(false)
  const skipSaveRef = useRef(false)
  const saveTimer   = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => { pageIdRef.current = pageId }, [pageId])

  const flushSave = useCallback(() => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null }
    if (dirtyRef.current && projectId && pageIdRef.current) {
      dirtyRef.current = false
      apexApi.savePage(projectId, pageIdRef.current, savePageDataRef.current).catch(() => {})
    }
  }, [projectId]) // eslint-disable-line react-hooks/exhaustive-deps
  const centeredRef             = useRef(false)

  const { data: pagesRes } = useQuery({
    queryKey: ['apex-pages', projectId],
    queryFn:  () => apexApi.listPages(projectId!).then(r => r.data),
    enabled:  !!projectId,
  })

  const canvasRef   = useRef<HTMLCanvasElement>(null)
  const [cs, setCs] = useState<CanvasState>({ zoom: 1, panX: 40, panY: 40 })

  // Center artboard once after page data loads
  const centerArtboard = useCallback((data: VectorPageData) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ab = data.artboards[0]
    if (!ab) return
    const { width: cw, height: ch } = canvas.getBoundingClientRect()
    if (!cw || !ch) return
    const padding = 60
    const zoom = Math.min(
      (cw - padding * 2) / ab.width,
      (ch - padding * 2) / ab.height,
      1,
    )
    const panX = (cw - ab.width * zoom) / 2 - ab.x * zoom
    const panY = (ch - ab.height * zoom) / 2 - ab.y * zoom
    setCs({ zoom, panX, panY, rot: 0 })   // « Ajuster » réinitialise aussi la rotation de la vue
  }, [])

  useEffect(() => {
    if (!pagesRes?.pages?.length || !projectId) return
    const pages = pagesRes.pages
    const page  = pages[Math.min(currentPageIdx, pages.length - 1)]
    if (!page) return
    flushSave()                    // sauve la page précédente avant d'en changer
    setPageId(page.id)
    pageIdRef.current = page.id
    centeredRef.current = false
    apexApi.getPage(projectId, page.id).then(r => {
      const data = r.data.data ?? makePage1()
      skipSaveRef.current = true   // ce setPageData est un chargement, pas une édition
      setPageData(data)
      setTimeout(() => {
        if (!centeredRef.current) { centerArtboard(data); centeredRef.current = true }
      }, 50)
    })
  }, [pagesRes, currentPageIdx, projectId, centerArtboard, flushSave])

  // Auto-center on first mount if no pages yet
  useEffect(() => {
    if (centeredRef.current) return
    const id = requestAnimationFrame(() => {
      if (!centeredRef.current) { centerArtboard(pageData); centeredRef.current = true }
    })
    return () => cancelAnimationFrame(id)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Débounce de sauvegarde à chaque modification (sauf juste après un chargement).
  useEffect(() => {
    savePageDataRef.current = pageData
    if (skipSaveRef.current) { skipSaveRef.current = false; return }
    dirtyRef.current = true
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => flushSave(), 1500)
  }, [pageData, flushSave])

  // Filet de sécurité périodique + flush à la fermeture/démontage.
  useEffect(() => {
    const safety = setInterval(flushSave, 15_000)
    const onUnload = () => flushSave()
    window.addEventListener('beforeunload', onUnload)
    return () => {
      clearInterval(safety)
      window.removeEventListener('beforeunload', onUnload)
      flushSave()
    }
  }, [flushSave])

  const [tool, setTool]           = useState<Tool>('select')
  const [selectedIds, setSelectedIds] = useState<string[]>([])

  // Pen tool state — use ref for non-stale access in event handlers
  const penRef = useRef<PenProgress | null>(null)
  const [penProgress, setPenProgress_] = useState<PenProgress | null>(null)
  const setPenProgress = (p: PenProgress | null) => {
    penRef.current = p
    setPenProgress_(p)
  }

  const dragRef = useRef<{
    type:       'pan' | 'move' | 'create' | 'resize' | 'rotate' | 'marquee' | 'node' | 'viewrotate'
    startX:     number
    startY:     number
    canvasX:    number
    canvasY:    number
    handleIdx?: number
    snapshot?:  VectorElement
    newEl?:     VectorElement
    shape?:     Tool              // shape being created (rect/ellipse/line/polygon/star)
    moves?:     VectorElement[]   // full snapshots of all moved elements
    cx?:        number   // rotate pivot (canvas coords)
    cy?:        number
    startRot?:  number
    startAng?:  number
    moved?:     boolean
    nodeHit?:   NodeHit            // node-editing: which anchor/handle is being dragged
    breakSym?:  boolean           // alt-drag a handle → break tangent symmetry
    w0x?:       number            // viewrotate: world point under the viewport centre
    w0y?:       number
  } | null>(null)
  const [nodeSel, setNodeSel] = useState<number | null>(null)
  const nodeSelRef = useRef<number | null>(null)
  useEffect(() => { nodeSelRef.current = nodeSel }, [nodeSel])
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const marqueeRef = useRef<{ x: number; y: number } | null>(null)            // marquee origin
  const marqueeRectRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null)

  // ── Undo / redo history (snapshots of pageData) ────────────────────────────
  const past   = useRef<VectorPageData[]>([])
  const future = useRef<VectorPageData[]>([])
  const pushHistory = useCallback(() => {
    past.current.push(structuredClone(pageDataRef.current))
    if (past.current.length > 60) past.current.shift()
    future.current = []
  }, [])
  const undo = useCallback(() => {
    const prev = past.current.pop(); if (!prev) return
    future.current.push(structuredClone(pageDataRef.current))
    setPageData(prev)
  }, [])
  const redo = useCallback(() => {
    const next = future.current.pop(); if (!next) return
    past.current.push(structuredClone(pageDataRef.current))
    setPageData(next)
  }, [])
  const clipboard = useRef<VectorElement[]>([])

  // ── Object actions ─────────────────────────────────────────────────────────
  const reorder = useCallback((mode: 'front' | 'back' | 'forward' | 'backward') => {
    const sel = new Set(selectedIdsRef.current); if (!sel.size) return
    pushHistory()
    setPageData(prev => {
      let ordered = [...prev.elements].sort((a, b) => a.zIndex - b.zIndex)
      if (mode === 'front')      ordered = [...ordered.filter(e => !sel.has(e.id)), ...ordered.filter(e => sel.has(e.id))]
      else if (mode === 'back')  ordered = [...ordered.filter(e => sel.has(e.id)), ...ordered.filter(e => !sel.has(e.id))]
      else {
        const step = mode === 'forward' ? 1 : -1
        const idxs = ordered.map((e, i) => ({ id: e.id, i })).filter(o => sel.has(o.id)).map(o => o.i)
        for (const i of (step > 0 ? idxs.reverse() : idxs)) {
          const j = i + step
          if (j >= 0 && j < ordered.length && !sel.has(ordered[j].id)) [ordered[i], ordered[j]] = [ordered[j], ordered[i]]
        }
      }
      return { ...prev, elements: ordered.map((e, i) => ({ ...e, zIndex: i })) }
    })
  }, [pushHistory])

  const align = useCallback((mode: 'left'|'hcenter'|'right'|'top'|'vcenter'|'bottom') => {
    const sel = selectedIdsRef.current
    const pd  = pageDataRef.current
    const els = pd.elements.filter(e => sel.includes(e.id)); if (!els.length) return
    const ab  = pd.artboards[0]
    // ≥2 elements → align to the selection box; 1 element → align to the artboard.
    const ref = els.length >= 2 ? selBBox(els)! : { x: 0, y: 0, w: ab?.width ?? 1920, h: ab?.height ?? 1080 }
    pushHistory()
    setPageData(prev => ({ ...prev, elements: prev.elements.map(el => {
      if (!sel.includes(el.id)) return el
      const b = elBBox(el); let dx = 0, dy = 0
      if (mode === 'left')         dx = ref.x - b.x
      else if (mode === 'hcenter') dx = (ref.x + ref.w/2) - (b.x + b.w/2)
      else if (mode === 'right')   dx = (ref.x + ref.w) - (b.x + b.w)
      else if (mode === 'top')     dy = ref.y - b.y
      else if (mode === 'vcenter') dy = (ref.y + ref.h/2) - (b.y + b.h/2)
      else                         dy = (ref.y + ref.h) - (b.y + b.h)
      return translateEl(el, dx, dy)
    }) }))
  }, [pushHistory])

  const distribute = useCallback((axis: 'h' | 'v') => {
    const sel = selectedIdsRef.current
    const els = pageDataRef.current.elements.filter(e => sel.includes(e.id)); if (els.length < 3) return
    const arr = els.map(e => ({ id: e.id, b: elBBox(e) }))
      .sort((a, b) => axis === 'h' ? (a.b.x + a.b.w/2) - (b.b.x + b.b.w/2) : (a.b.y + a.b.h/2) - (b.b.y + b.b.h/2))
    const c = (b: {x:number;y:number;w:number;h:number}) => axis === 'h' ? b.x + b.w/2 : b.y + b.h/2
    const firstC = c(arr[0].b), lastC = c(arr[arr.length-1].b)
    const gap = (lastC - firstC) / (arr.length - 1)
    const delta = new Map(arr.map((o, i) => [o.id, (firstC + gap*i) - c(o.b)]))
    pushHistory()
    setPageData(prev => ({ ...prev, elements: prev.elements.map(el => {
      const d = delta.get(el.id); if (d == null) return el
      return translateEl(el, axis === 'h' ? d : 0, axis === 'h' ? 0 : d)
    }) }))
  }, [pushHistory])

  const flip = useCallback((axis: 'h' | 'v') => {
    const sel = selectedIdsRef.current
    const els = pageDataRef.current.elements.filter(e => sel.includes(e.id)); if (!els.length) return
    const bb = selBBox(els)!; const cx = bb.x + bb.w/2, cy = bb.y + bb.h/2
    pushHistory()
    setPageData(prev => ({ ...prev, elements: prev.elements.map(el => {
      if (!sel.includes(el.id)) return el
      if (el.type === 'path') {
        const pts = (el as PathElement).points.map(p => ({
          ...p,
          x: axis === 'h' ? 2*cx - p.x : p.x,
          y: axis === 'v' ? 2*cy - p.y : p.y,
          hIn:  p.hIn  ? [axis==='h'?-p.hIn[0] :p.hIn[0],  axis==='v'?-p.hIn[1] :p.hIn[1]]  as [number,number] : p.hIn,
          hOut: p.hOut ? [axis==='h'?-p.hOut[0]:p.hOut[0], axis==='v'?-p.hOut[1]:p.hOut[1]] as [number,number] : p.hOut,
        }))
        const xs = pts.map(p => p.x), ys = pts.map(p => p.y)
        return { ...el, points: pts, x: Math.min(...xs), y: Math.min(...ys) } as VectorElement
      }
      const b = elBBox(el)
      return { ...el,
        x: axis === 'h' ? 2*cx - (b.x + b.w) : el.x,
        y: axis === 'v' ? 2*cy - (b.y + b.h) : el.y,
      } as VectorElement
    }) }))
  }, [pushHistory])

  const duplicateSel = useCallback(() => {
    const sel = selectedIdsRef.current
    const els = pageDataRef.current.elements.filter(e => sel.includes(e.id)); if (!els.length) return
    pushHistory()
    const clones = els.map(e => cloneEl(e, 12, 12))
    setPageData(prev => ({ ...prev, elements: [...prev.elements, ...clones.map((c, i) => ({ ...c, zIndex: prev.elements.length + i }))] }))
    setSelectedIds(clones.map(c => c.id))
  }, [pushHistory])

  const copySel  = useCallback(() => { clipboard.current = pageDataRef.current.elements.filter(e => selectedIdsRef.current.includes(e.id)).map(e => structuredClone(e)) }, [])
  const pasteSel = useCallback(() => {
    if (!clipboard.current.length) return
    pushHistory()
    const clones = clipboard.current.map(e => cloneEl(e, 16, 16))
    setPageData(prev => ({ ...prev, elements: [...prev.elements, ...clones.map((c, i) => ({ ...c, zIndex: prev.elements.length + i }))] }))
    setSelectedIds(clones.map(c => c.id))
  }, [pushHistory])
  const deleteSel = useCallback(() => {
    const sel = selectedIdsRef.current; if (!sel.length) return
    pushHistory()
    setPageData(prev => ({ ...prev, elements: prev.elements.filter(e => !sel.includes(e.id)) }))
    setSelectedIds([])
  }, [pushHistory])
  const selectAll = useCallback(() => setSelectedIds(pageDataRef.current.elements.filter(e => e.visible && !e.locked).map(e => e.id)), [])
  const cutSel = useCallback(() => { copySel(); deleteSel() }, [copySel, deleteSel])

  // ── Grouping ─────────────────────────────────────────────────────────────────
  const groupSel = useCallback(() => {
    const sel = selectedIdsRef.current
    if (sel.length < 2) return
    pushHistory()
    const gid = `g-${newId()}`
    setPageData(prev => ({ ...prev, elements: prev.elements.map(el => sel.includes(el.id) ? { ...el, groupId: gid } as VectorElement : el) }))
  }, [pushHistory])
  const ungroupSel = useCallback(() => {
    const sel = selectedIdsRef.current
    if (!sel.length) return
    pushHistory()
    setPageData(prev => ({ ...prev, elements: prev.elements.map(el => {
      if (!sel.includes(el.id) || el.groupId == null) return el
      const { groupId: _g, ...rest } = el
      return rest as VectorElement
    }) }))
  }, [pushHistory])

  // ── Convert shape(s) to editable path ────────────────────────────────────────
  const convertToPath = useCallback(() => {
    const sel = selectedIdsRef.current
    if (!sel.length) return
    pushHistory()
    setPageData(prev => ({ ...prev, elements: prev.elements.map(el => {
      if (!sel.includes(el.id)) return el
      // Rectangle / ellipse → chemin de Bézier éditable.
      if (el.type === 'rect' || el.type === 'ellipse') return toPathElement(el)
      // Polygone / étoile (chemin paramétrique) → détacher la nature paramétrique
      // pour en faire un objet vectoriel libre, pleinement éditable à la plume.
      if (el.type === 'path' && (el as PathElement).shape) {
        const { shape: _s, sides: _si, spikes: _sp, innerRatio: _ir, ...rest } = el as PathElement
        void _s; void _si; void _sp; void _ir
        return { ...rest, type: 'path' } as VectorElement
      }
      return el
    }) }))
  }, [pushHistory])

  // ── Fusionner les objets sélectionnés en un seul chemin composé ─────────────
  // Convertit chaque objet en chemin, puis concatène les sous-chemins (marqueur
  // `move`) en un unique PathElement libre — pleinement éditable à la plume.
  const mergeSel = useCallback(() => {
    const sel = selectedIdsRef.current
    const chosen = pageDataRef.current.elements.filter(e => sel.includes(e.id) && e.type !== 'text')
    if (chosen.length < 2) return
    pushHistory()
    const allPts: PathPoint[] = []
    for (const el of chosen) {
      const pe = el.type === 'path' ? (el as PathElement) : toPathElement(el)
      pe.points.forEach((p, i) => allPts.push({ ...p, move: i === 0 && allPts.length > 0 ? true : undefined }))
    }
    const xs = allPts.map(p => p.x), ys = allPts.map(p => p.y)
    const nx = Math.min(...xs), ny = Math.min(...ys)
    const base = chosen[0]
    const merged = {
      ...base, id: newId(), type: 'path', name: t('apex_merged_path'),
      points: allPts, closed: true,
      x: nx, y: ny, w: Math.max(...xs) - nx, h: Math.max(...ys) - ny,
      shape: undefined, sides: undefined, spikes: undefined, innerRatio: undefined,
      groupId: undefined, zIndex: Math.max(...chosen.map(c => c.zIndex)),
    } as PathElement
    const keptIds = new Set(chosen.map(c => c.id))
    setPageData(prev => ({ ...prev, elements: [...prev.elements.filter(e => !keptIds.has(e.id)), merged] }))
    setSelectedIds([merged.id])
    setNodeSel(null)
  }, [pushHistory, t])

  // ── Delete the selected node (direct-selection tool) ─────────────────────────
  const deleteNode = useCallback(() => {
    const sel = selectedIdsRef.current
    const idx = nodeSelRef.current
    if (sel.length !== 1 || idx == null) return
    pushHistory()
    setPageData(prev => ({ ...prev, elements: prev.elements.flatMap(el => {
      if (el.id !== sel[0] || el.type !== 'path') return [el]
      const pts = (el as PathElement).points.filter((_, i) => i !== idx)
      if (pts.length < 2) return []   // path collapsed → drop it
      const xs = pts.map(p => p.x), ys = pts.map(p => p.y)
      const nx = Math.min(...xs), ny = Math.min(...ys)
      return [{ ...el, points: pts, x: nx, y: ny, w: Math.max(...xs) - nx, h: Math.max(...ys) - ny } as VectorElement]
    }) }))
    setNodeSel(null)
  }, [pushHistory])

  // ── Right-click context menu ───────────────────────────────────────────────
  const ctx = useContextMenu()
  const onCanvasContextMenu = useCallback((e: React.MouseEvent) => {
    const canvas = canvasRef.current; if (!canvas) return
    const pt = toCanvas(e, canvas.getBoundingClientRect(), csRef.current)
    const sorted = [...pageDataRef.current.elements].sort((a, b) => b.zIndex - a.zIndex)
    const hit = sorted.find(el => el.visible && !el.locked && hitTest(el, pt.x, pt.y))
    if (hit) {
      if (!selectedIdsRef.current.includes(hit.id)) setSelectedIds([hit.id])
      const multi = selectedIdsRef.current.length > 1
      const items: CtxItem[] = [
        { label: t('menu_undo'),       onClick: undo },
        'sep',
        { label: t('apex_ctx_cut'),    onClick: cutSel,       shortcut: 'Ctrl+X' },
        { label: t('apex_ctx_copy'),   onClick: copySel,      shortcut: 'Ctrl+C' },
        { label: t('apex_ctx_paste'),  onClick: pasteSel,     shortcut: 'Ctrl+V', disabled: !clipboard.current.length },
        { label: t('apex_duplicate'),  onClick: duplicateSel, shortcut: 'Ctrl+D' },
        'sep',
        { label: t('apex_bring_front'),onClick: () => reorder('front'), shortcut: 'Ctrl+Shift+]' },
        { label: t('apex_send_back'),  onClick: () => reorder('back'),  shortcut: 'Ctrl+Shift+[' },
        'sep',
        { label: t('apex_flip_h'),     onClick: () => flip('h') },
        { label: t('apex_flip_v'),     onClick: () => flip('v') },
        'sep',
        ...(multi ? [{ label: t('apex_group'), onClick: groupSel, shortcut: 'Ctrl+G' } as CtxItem] : []),
        ...(hit.groupId != null ? [{ label: t('apex_ungroup'), onClick: ungroupSel, shortcut: 'Ctrl+Shift+G' } as CtxItem] : []),
        ...(hit.type === 'rect' || hit.type === 'ellipse' || (hit.type === 'path' && (hit as PathElement).shape)
          ? [{ label: t('apex_convert_to_path'), onClick: convertToPath } as CtxItem] : []),
        ...(multi ? [{ label: t('apex_merge'), onClick: mergeSel } as CtxItem] : []),
        ...(multi ? [
          { label: t('apex_align_left'),    onClick: () => align('left') } as CtxItem,
          { label: t('apex_align_center_h'),onClick: () => align('hcenter') } as CtxItem,
        ] : []),
        'sep',
        { label: t('apex_delete_element'), onClick: deleteSel, danger: true, shortcut: 'Suppr' },
      ]
      ctx.open(e, items)
    } else {
      ctx.open(e, [
        { label: t('apex_ctx_paste'), onClick: pasteSel, disabled: !clipboard.current.length, shortcut: 'Ctrl+V' },
        { label: t('apex_ctx_select_all'), onClick: selectAll, shortcut: 'Ctrl+A' },
      ])
    }
  }, [ctx, t, undo, cutSel, copySel, pasteSel, duplicateSel, reorder, flip, align, deleteSel, selectAll, groupSel, ungroupSel, convertToPath, mergeSel])

  // ── Commit pen path ──────────────────────────────────────────────────────────
  const commitPenPath = useCallback((points: PathPoint[], closed: boolean) => {
    if (points.length < 2) { setPenProgress(null); return }
    const xs = points.map(p => p.x), ys = points.map(p => p.y)
    const x = Math.min(...xs), y = Math.min(...ys)
    const w = Math.max(...xs) - x, h = Math.max(...ys) - y
    const newEl: PathElement = {
      id: newId(), type: 'path', name: t('apex_path_name'),
      x, y, w: w || 1, h: h || 1,
      rotation: 0, visible: true, locked: false, opacity: 100,
      zIndex: 0, // set below
      fill: defaultFill(),
      stroke: { color: '#1a1a1a', opacity: 100, width: 2, dashArray: [] },
      points,
      closed,
    }
    setPageData(prev => {
      const el = { ...newEl, zIndex: prev.elements.length }
      return { ...prev, elements: [...prev.elements, el] }
    })
    setSelectedIds([newEl.id])
    setPenProgress(null)
    // Bascule en édition de nœuds : le tracé fraîchement créé est aussitôt
    // modifiable (ancres + poignées), au lieu de retomber sur la sélection.
    setTool('node')
  }, [t])

  // ── Render ─────────────────────────────────────────────────────────────────
  const doRender = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    const { width: w, height: h } = canvas.getBoundingClientRect()
    canvas.width  = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    renderCanvas(ctx, w, h, pageData, cs, tool === 'node' ? [] : selectedIds, dpr, marquee)
    const pen = penRef.current
    if (pen && pen.points.length > 0) drawPenOverlay(ctx, pen, cs, dpr)
    if (tool === 'node' && selectedIds.length === 1) {
      const pe = pageData.elements.find(el => el.id === selectedIds[0])
      if (pe && pe.type === 'path') renderNodeOverlay(ctx, pe as PathElement, cs, dpr, nodeSel)
    }
  }, [pageData, cs, selectedIds, marquee, tool, nodeSel])

  useEffect(() => { doRender() }, [doRender, penProgress])

  // Resize observer
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const obs = new ResizeObserver(() => doRender())
    obs.observe(canvas)
    return () => obs.disconnect()
  }, [doRender])

  // Wheel zoom
  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    if (e.ctrlKey || e.metaKey) {
      const canvas = canvasRef.current!
      const rect   = canvas.getBoundingClientRect()
      const mx = e.clientX - rect.left, my = e.clientY - rect.top
      const factor = e.deltaY < 0 ? 1.1 : 0.9
      setCs(prev => {
        const nz = Math.min(20, Math.max(0.02, prev.zoom * factor))
        return { zoom: nz, panX: mx - (mx - prev.panX) * (nz / prev.zoom), panY: my - (my - prev.panY) * (nz / prev.zoom) }
      })
    } else {
      setCs(prev => ({ ...prev, panX: prev.panX - e.deltaX, panY: prev.panY - e.deltaY }))
    }
  }, [])

  // ── Mouse events ─────────────────────────────────────────────────────────────
  const csRef = useRef(cs)
  useEffect(() => { csRef.current = cs }, [cs])
  const pageDataRef = useRef(pageData)
  useEffect(() => { pageDataRef.current = pageData }, [pageData])
  const selectedIdsRef = useRef(selectedIds)
  useEffect(() => { selectedIdsRef.current = selectedIds }, [selectedIds])
  const toolRef = useRef(tool)
  useEffect(() => { toolRef.current = tool }, [tool])

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    const canvas = canvasRef.current!
    const rect   = canvas.getBoundingClientRect()
    const cs_    = csRef.current
    const pt     = toCanvas(e, rect, cs_)
    const currentTool = toolRef.current

    if (currentTool === 'hand') {
      dragRef.current = { type: 'pan', startX: e.clientX, startY: e.clientY, canvasX: cs_.panX, canvasY: cs_.panY }
      return
    }

    // Loupe : clic = zoom avant, Alt-clic = zoom arrière, centré sur le curseur.
    if (currentTool === 'zoom') {
      const mx = e.clientX - rect.left, my = e.clientY - rect.top
      const factor = e.altKey ? 1 / 1.4 : 1.4
      setCs(prev => {
        const nz = Math.min(20, Math.max(0.02, prev.zoom * factor))
        const k = nz / prev.zoom
        return { ...prev, zoom: nz, panX: mx - (mx - prev.panX) * k, panY: my - (my - prev.panY) * k }
      })
      return
    }

    // Rotation de la vue : glisser autour du centre du viewport.
    if (currentTool === 'rotateview') {
      const ccx = rect.width / 2, ccy = rect.height / 2
      const w0 = toCanvas({ clientX: rect.left + ccx, clientY: rect.top + ccy }, rect, cs_)
      dragRef.current = {
        type: 'viewrotate', startX: e.clientX, startY: e.clientY, canvasX: ccx, canvasY: ccy,
        startAng: Math.atan2(e.clientY - rect.top - ccy, e.clientX - rect.left - ccx),
        startRot: cs_.rot ?? 0, w0x: w0.x, w0y: w0.y, cx: ccx, cy: ccy,
      }
      return
    }

    if (currentTool === 'pen') {
      const pen = penRef.current
      if (!pen) {
        setPenProgress({ points: [{ x: pt.x, y: pt.y }], dragging: true, mousePos: pt })
      } else {
        // Check if near first point → close path
        if (pen.points.length >= 2) {
          const first = pen.points[0]
          if (Math.hypot(pt.x - first.x, pt.y - first.y) < 10 / cs_.zoom) {
            commitPenPath(pen.points, true)
            return
          }
        }
        // Add new anchor point
        const newPts = [...pen.points, { x: pt.x, y: pt.y }]
        setPenProgress({ points: newPts, dragging: true, mousePos: pt })
      }
      return
    }

    if (currentTool === 'node') {
      const pd  = pageDataRef.current
      const sel = selectedIdsRef.current
      const pathEl = sel.length === 1
        ? pd.elements.find(el => el.id === sel[0] && el.type === 'path') as PathElement | undefined
        : undefined
      if (pathEl) {
        // Les points sont en repère local ; on annule la rotation de l'élément sur
        // la position souris pour aligner le hit-testing avec l'affichage tourné.
        const lp = worldToLocal(pt.x, pt.y, pathEl)
        const nh = hitNode(pathEl, lp.x, lp.y, cs_.zoom)
        if (nh) {
          // Alt-clic sur une ancre → bascule coin / lisse.
          if (e.altKey && nh.kind === 'anchor') {
            pushHistory()
            const pid = pathEl.id, idx = nh.index
            setPageData(prev => ({ ...prev, elements: prev.elements.map(el =>
              el.id === pid && el.type === 'path' ? toggleAnchorSmooth(el as PathElement, idx) : el) }))
            setNodeSel(nh.index)
            return
          }
          pushHistory()
          setNodeSel(nh.index)
          dragRef.current = { type: 'node', startX: e.clientX, startY: e.clientY, canvasX: pt.x, canvasY: pt.y,
            snapshot: structuredClone(pathEl), nodeHit: nh, breakSym: e.altKey, moved: false }
          return
        }
        // Clic sur un segment du tracé (hors ancre/poignée) → insère une ancre.
        const near = nearestOnPath(pathEl, lp.x, lp.y)
        if (near && near.d <= 6 / cs_.zoom) {
          pushHistory()
          const pid = pathEl.id, seg = near.seg, tt = near.t
          setPageData(prev => ({ ...prev, elements: prev.elements.map(el =>
            el.id === pid && el.type === 'path' ? insertAnchor(el as PathElement, seg, tt) : el) }))
          setNodeSel(near.seg + 1)
          return
        }
      }
      // Sélection directe façon Illustrator : aucun tracé pré-sélectionné → on
      // cherche une ancre/poignée sous le curseur sur N'IMPORTE quel tracé et on
      // la saisit immédiatement (édition en un seul geste). Sinon, clic sur le
      // corps d'un tracé = le sélectionner (ses nœuds apparaissent) ; clic dans
      // le vide = désélectionner.
      const sorted = [...pd.elements].sort((a, b) => b.zIndex - a.zIndex)
      for (const el of sorted) {
        if (el.type !== 'path' || !el.visible || el.locked) continue
        const lp = worldToLocal(pt.x, pt.y, el)
        const nh = hitNode(el as PathElement, lp.x, lp.y, cs_.zoom)
        if (nh) {
          pushHistory()
          setSelectedIds([el.id]); setNodeSel(nh.index)
          dragRef.current = { type: 'node', startX: e.clientX, startY: e.clientY, canvasX: pt.x, canvasY: pt.y,
            snapshot: structuredClone(el), nodeHit: nh, breakSym: e.altKey, moved: false }
          return
        }
      }
      const hitP = sorted.find(el => { if (el.type !== 'path' || !el.visible || el.locked) return false; const lp = worldToLocal(pt.x, pt.y, el); return hitTest(el, lp.x, lp.y) })
      setSelectedIds(hitP ? [hitP.id] : [])
      setNodeSel(null)
      return
    }

    if (currentTool === 'eyedropper') {
      const pd  = pageDataRef.current
      const sorted = [...pd.elements].sort((a, b) => b.zIndex - a.zIndex)
      const src = sorted.find(el => el.visible && hitTest(el, pt.x, pt.y))
      const sel = selectedIdsRef.current
      if (src && sel.length) {
        pushHistory()
        setPageData(prev => ({ ...prev, elements: prev.elements.map(el => sel.includes(el.id)
          ? { ...el, fill: structuredClone(src.fill), stroke: src.stroke ? structuredClone(src.stroke) : null } as VectorElement
          : el) }))
      }
      return
    }

    if (currentTool === 'select') {
      const pd  = pageDataRef.current
      const sel = selectedIdsRef.current
      const shift = e.shiftKey
      // Rotation / resize handles (single selection only)
      if (sel.length === 1) {
        const el = pd.elements.find(x => x.id === sel[0])
        if (el) {
          const bb = elBBox(el)
          const rh = rotateHandlePos(bb, cs_.zoom)
          if (Math.hypot(pt.x - rh.x, pt.y - rh.y) <= 9 / cs_.zoom) {
            const cx = bb.x + bb.w / 2, cy = bb.y + bb.h / 2
            pushHistory()
            dragRef.current = { type: 'rotate', startX: e.clientX, startY: e.clientY, canvasX: pt.x, canvasY: pt.y,
              snapshot: { ...el }, cx, cy, startRot: el.rotation, startAng: Math.atan2(pt.y - cy, pt.x - cx) * 180 / Math.PI, moved: false }
            return
          }
          const hi = hitHandle(el, pt.x, pt.y, cs_.zoom)
          if (hi >= 0) {
            pushHistory()
            dragRef.current = { type: 'resize', startX: e.clientX, startY: e.clientY, canvasX: pt.x, canvasY: pt.y, handleIdx: hi, snapshot: { ...el }, moved: false }
            return
          }
        }
      }
      const sorted = [...pd.elements].sort((a, b) => b.zIndex - a.zIndex)
      const hit = sorted.find(el => !el.locked && el.visible && hitTest(el, pt.x, pt.y))
      // Selecting any member of a group selects the whole group.
      const groupMates = (id: string) => {
        const g = pd.elements.find(x => x.id === id)?.groupId
        return g ? pd.elements.filter(e => e.groupId === g).map(e => e.id) : [id]
      }
      if (hit) {
        let nextSel = sel
        const hitGroup = groupMates(hit.id)
        if (shift) {
          nextSel = sel.includes(hit.id) ? sel.filter(i => !hitGroup.includes(i)) : [...sel, ...hitGroup]
          nextSel = Array.from(new Set(nextSel))
          setSelectedIds(nextSel)
        } else if (!sel.includes(hit.id)) {
          nextSel = hitGroup; setSelectedIds(nextSel)
        }
        const moves = pd.elements.filter(el => nextSel.includes(el.id)).map(el => structuredClone(el))
        pushHistory()
        dragRef.current = { type: 'move', startX: e.clientX, startY: e.clientY, canvasX: pt.x, canvasY: pt.y, moves, moved: false }
      } else {
        if (!shift) setSelectedIds([])
        marqueeRef.current = { x: pt.x, y: pt.y }
        dragRef.current = { type: 'marquee', startX: e.clientX, startY: e.clientY, canvasX: pt.x, canvasY: pt.y }
      }
      return
    }

    if (currentTool === 'text') {
      const pd = pageDataRef.current
      const te: TextElement = {
        id: newId(), type: 'text', name: t('apex_text_name'),
        x: pt.x, y: pt.y, w: 10, h: 10, rotation: 0, visible: true, locked: false,
        opacity: 100, zIndex: pd.elements.length,
        fill: { type: 'solid', color: '#1a1a1a', opacity: 100 }, stroke: null,
        text: t('apex_text_default'), fontSize: 32, fontFamily: 'Inter', fontWeight: 400, italic: false, align: 'left',
      }
      const m = measureText(te); te.w = m.w; te.h = m.h
      pushHistory()
      setPageData(prev => ({ ...prev, elements: [...prev.elements, te] }))
      setSelectedIds([te.id])
      setTool('select')
      return
    }

    if (['rect','ellipse','line','polygon','star'].includes(currentTool)) {
      const pd = pageDataRef.current
      const base = {
        id: newId(), x: pt.x, y: pt.y, w: 0, h: 0,
        rotation: 0, visible: true, locked: false, opacity: 100,
        zIndex: pd.elements.length, fill: defaultFill(), stroke: defaultStroke(),
      }
      let newEl: VectorElement
      if (currentTool === 'rect') newEl = { ...base, type: 'rect', name: t('apex_rectangle'), cornerRadius: 0 } as VectorElement
      else if (currentTool === 'ellipse') newEl = { ...base, type: 'ellipse', name: t('apex_ellipse') } as VectorElement
      else newEl = { ...base, type: 'path',
        name: t(currentTool === 'line' ? 'apex_line' : currentTool === 'polygon' ? 'apex_polygon' : 'apex_star'),
        fill: currentTool === 'line' ? { type: 'none' } : defaultFill(),
        stroke: { color: '#1a1a1a', opacity: 100, width: 2, dashArray: [] },
        points: [{ x: pt.x, y: pt.y }], closed: currentTool !== 'line' } as VectorElement
      pushHistory()
      dragRef.current = { type: 'create', startX: e.clientX, startY: e.clientY, canvasX: pt.x, canvasY: pt.y, newEl, shape: currentTool, moved: false }
      setPageData(prev => ({ ...prev, elements: [...prev.elements, newEl] }))
      setSelectedIds([newEl.id])
    }
  }, [commitPenPath, t, pushHistory])

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    const cs_         = csRef.current
    const currentTool = toolRef.current

    if (currentTool === 'pen') {
      const pen = penRef.current
      if (!pen) return
      const canvas = canvasRef.current!
      const pt = toCanvas(e, canvas.getBoundingClientRect(), cs_)

      if (pen.dragging && pen.points.length > 0) {
        const pts  = pen.points.map((p, i) => i === pen.points.length - 1 ? { ...p } : p)
        const last = pts[pts.length - 1]
        const dx = pt.x - last.x, dy = pt.y - last.y
        if (Math.hypot(dx, dy) > 1 / cs_.zoom) {
          last.hOut = [dx, dy]
          last.hIn  = [-dx, -dy]
        }
        setPenProgress({ ...pen, points: pts, mousePos: pt })
      } else {
        setPenProgress({ ...pen, mousePos: pt })
      }
      return
    }

    const drag = dragRef.current
    if (!drag) return
    const canvas = canvasRef.current!
    const rect   = canvas.getBoundingClientRect()

    if (drag.type === 'pan') {
      setCs(prev => ({ ...prev, panX: drag.canvasX + (e.clientX - drag.startX), panY: drag.canvasY + (e.clientY - drag.startY) }))
      return
    }

    if (drag.type === 'viewrotate') {
      const ccx = drag.cx!, ccy = drag.cy!
      const ang = Math.atan2(e.clientY - rect.top - ccy, e.clientX - rect.left - ccx)
      let rot = (drag.startRot ?? 0) + (ang - (drag.startAng ?? 0))
      if (e.shiftKey) rot = Math.round(rot / (Math.PI / 12)) * (Math.PI / 12)  // snap 15°
      // Keep the world point under the viewport centre fixed while rotating:
      // pan = C − R(rot)·(zoom · w0)
      setCs(prev => {
        const c = Math.cos(rot), s = Math.sin(rot), z = prev.zoom
        const wx = drag.w0x! * z, wy = drag.w0y! * z
        return { ...prev, rot, panX: ccx - (c * wx - s * wy), panY: ccy - (s * wx + c * wy) }
      })
      return
    }

    // Canvas-space delta (rotation-aware: undo the view rotation on the drag vector).
    const sdx = e.clientX - drag.startX, sdy = e.clientY - drag.startY
    let dx: number, dy: number
    if (cs_.rot) {
      const c = Math.cos(-cs_.rot), s = Math.sin(-cs_.rot)
      dx = (c * sdx - s * sdy) / cs_.zoom
      dy = (s * sdx + c * sdy) / cs_.zoom
    } else {
      dx = sdx / cs_.zoom
      dy = sdy / cs_.zoom
    }
    if (Math.abs(sdx) > 2 || Math.abs(sdy) > 2) drag.moved = true

    if (drag.type === 'marquee') {
      const o = marqueeRef.current!; const pt = toCanvas(e, rect, cs_)
      const m = { x: Math.min(o.x, pt.x), y: Math.min(o.y, pt.y), w: Math.abs(pt.x - o.x), h: Math.abs(pt.y - o.y) }
      marqueeRectRef.current = m
      setMarquee(m)
      return
    }
    if (drag.type === 'rotate' && drag.snapshot && drag.cx != null) {
      const pt = toCanvas(e, rect, cs_)
      const delta = Math.atan2(pt.y - drag.cy!, pt.x - drag.cx) * 180 / Math.PI - drag.startAng!
      let rot = drag.startRot! + delta
      if (e.shiftKey) rot = Math.round(rot / 15) * 15
      const id = drag.snapshot.id
      setPageData(prev => ({ ...prev, elements: prev.elements.map(el => el.id === id ? { ...el, rotation: Math.round(rot) } as VectorElement : el) }))
      return
    }
    if (drag.type === 'node' && drag.snapshot && drag.nodeHit) {
      const snap = drag.snapshot as PathElement
      const nh   = drag.nodeHit
      const ptw  = toCanvas(e, rect, cs_)
      // Souris en repère LOCAL de l'élément (annule sa rotation autour du pivot du
      // snapshot, qui reste fixe pendant le geste).
      const pt   = worldToLocal(ptw.x, ptw.y, snap)
      const sp   = snap.points[nh.index]
      setPageData(prev => ({ ...prev, elements: prev.elements.map(el => {
        if (el.id !== snap.id || el.type !== 'path') return el
        const pts = (el as PathElement).points.map((p, i) => {
          if (i !== nh.index) return p
          if (nh.kind === 'anchor') {
            // Move the anchor; carry its handles along (they are relative).
            return { ...p, x: pt.x, y: pt.y }
          }
          const h: [number, number] = [pt.x - sp.x, pt.y - sp.y]
          const next = { ...p, [nh.kind === 'in' ? 'hIn' : 'hOut']: h } as PathPoint
          // Mirror the opposite handle unless Alt breaks symmetry.
          if (!drag.breakSym) {
            const opp: [number, number] = [-h[0], -h[1]]
            if (nh.kind === 'in')  next.hOut = next.hOut ? opp : next.hOut
            else                   next.hIn  = next.hIn  ? opp : next.hIn
          }
          return next
        })
        // Forme tournée : garder la bbox du snapshot fige le pivot de rotation
        // pendant le drag (sinon il dériverait → la forme sauterait). Sinon on
        // recalcule la bbox pour que transform/sélection restent justes.
        if (snap.rotation) {
          return { ...el, points: pts, x: snap.x, y: snap.y, w: snap.w, h: snap.h } as VectorElement
        }
        const xs = pts.map(p => p.x), ys = pts.map(p => p.y)
        const nx = Math.min(...xs), ny = Math.min(...ys)
        return { ...el, points: pts, x: nx, y: ny, w: Math.max(...xs) - nx, h: Math.max(...ys) - ny } as VectorElement
      }) }))
      return
    }
    if (drag.type === 'move' && drag.moves) {
      const moves = drag.moves
      setPageData(prev => ({ ...prev, elements: prev.elements.map(el => {
        const snap = moves.find(m => m.id === el.id)
        return snap ? translateEl(snap, dx, dy) : el
      }) }))
      return
    }
    if (drag.type === 'create' && drag.newEl) {
      const { canvasX: ox, canvasY: oy } = drag
      const pt = toCanvas(e, rect, cs_)
      const x = Math.min(ox, pt.x), y = Math.min(oy, pt.y)
      const w = Math.abs(pt.x - ox), h = Math.abs(pt.y - oy)
      const shape = drag.shape
      setPageData(prev => ({ ...prev, elements: prev.elements.map(el => {
        if (el.id !== drag.newEl!.id) return el
        if (el.type === 'path') {
          const cx = x + w / 2, cy = y + h / 2
          const points = shape === 'line'  ? [{ x: ox, y: oy }, { x: pt.x, y: pt.y }]
                       : shape === 'star'  ? genStar(cx, cy, w / 2, h / 2, 5)
                       :                     genPolygon(cx, cy, w / 2, h / 2, 6)
          // Remember the parametric kind so the side/spike count stays editable.
          const meta = shape === 'star'    ? { shape: 'star' as const, spikes: 5, innerRatio: 0.45 }
                     : shape === 'polygon' ? { shape: 'polygon' as const, sides: 6 }
                     : {}
          return { ...el, x, y, w, h, points, ...meta } as VectorElement
        }
        return { ...el, x, y, w, h }
      }) }))
      return
    }
    if (drag.type === 'resize' && drag.snapshot && drag.handleIdx !== undefined) {
      const snap = drag.snapshot
      const hi   = drag.handleIdx
      let { x, y, w, h } = snap
      if ([0, 3, 5].includes(hi)) { x = snap.x + dx; w = snap.w - dx }
      if ([2, 4, 7].includes(hi)) { w = snap.w + dx }
      if ([0, 1, 2].includes(hi)) { y = snap.y + dy; h = snap.h - dy }
      if ([5, 6, 7].includes(hi)) { h = snap.h + dy }
      if (w < 4) { if ([0, 3, 5].includes(hi)) x = snap.x + snap.w - 4; w = 4 }
      if (h < 4) { if ([0, 1, 2].includes(hi)) y = snap.y + snap.h - 4; h = 4 }
      setPageData(prev => ({ ...prev, elements: prev.elements.map(el => {
        if (el.id !== snap.id) return el
        if (snap.type === 'path') {
          const sw = snap.w || 1, sh = snap.h || 1
          const pts = (snap as PathElement).points.map(p => ({
            ...p,
            x: x + ((p.x - snap.x) / sw) * w,
            y: y + ((p.y - snap.y) / sh) * h,
            hIn:  p.hIn  ? [p.hIn[0]  / sw * w, p.hIn[1]  / sh * h] as [number, number] : p.hIn,
            hOut: p.hOut ? [p.hOut[0] / sw * w, p.hOut[1] / sh * h] as [number, number] : p.hOut,
          }))
          return { ...el, x, y, w, h, points: pts } as VectorElement
        }
        return { ...el, x, y, w, h } as VectorElement
      }) }))
      return
    }
  }, [])

  const onMouseUp = useCallback(() => {
    const pen = penRef.current
    if (pen?.dragging) setPenProgress({ ...pen, dragging: false })
    const drag = dragRef.current
    if (drag?.type === 'marquee') {
      const m = marqueeRectRef.current
      if (m && (m.w > 2 || m.h > 2)) {
        const inside = (b: { x:number;y:number;w:number;h:number }) =>
          b.x < m.x + m.w && b.x + b.w > m.x && b.y < m.y + m.h && b.y + b.h > m.y
        const hits = pageDataRef.current.elements.filter(el => el.visible && !el.locked && inside(elBBox(el))).map(el => el.id)
        setSelectedIds(prev => Array.from(new Set([...prev, ...hits])))
      }
    } else if (drag && !drag.moved && (drag.type === 'create')) {
      // A click with the shape tool created a zero-size element → drop it.
      const nid = drag.newEl?.id
      if (nid) setPageData(prev => ({ ...prev, elements: prev.elements.filter(e => e.id !== nid) }))
    }
    setMarquee(null); marqueeRef.current = null; marqueeRectRef.current = null
    dragRef.current = null
  }, [])

  // ── Keyboard ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return
      const mod = e.ctrlKey || e.metaKey
      const k = e.key.toLowerCase()

      // ── Ctrl/Cmd shortcuts ──
      if (mod) {
        if (k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return }
        if (k === 'y') { e.preventDefault(); redo(); return }
        if (k === 'd') { e.preventDefault(); duplicateSel(); return }
        if (k === 'c') { e.preventDefault(); copySel(); return }
        if (k === 'v') { e.preventDefault(); pasteSel(); return }
        if (k === 'a') { e.preventDefault(); selectAll(); return }
        if (k === ']') { e.preventDefault(); reorder(e.shiftKey ? 'front' : 'forward'); return }
        if (k === '[') { e.preventDefault(); reorder(e.shiftKey ? 'back'  : 'backward'); return }
        if (k === '=' || k === '+') { e.preventDefault(); setCs(p => ({ ...p, zoom: Math.min(20, p.zoom * 1.2) })); return }
        if (k === '-')              { e.preventDefault(); setCs(p => ({ ...p, zoom: Math.max(0.02, p.zoom * 0.8) })); return }
        if (k === '0')              { e.preventDefault(); centerArtboard(pageDataRef.current); return }
        if (k === 'g')              { e.preventDefault(); e.shiftKey ? ungroupSel() : groupSel(); return }
        return
      }

      // ── Tool shortcuts ──
      if (k === 'v') { setPenProgress(null); setTool('select') }
      else if (k === 'a') { setPenProgress(null); setTool('node') }
      else if (k === 'm' || k === 'r') { setPenProgress(null); setTool('rect') }
      else if (k === 'l') { setPenProgress(null); setTool('ellipse') }
      else if (k === '\\') { setPenProgress(null); setTool('line') }
      else if (k === 'p') setTool('pen')
      else if (k === 't') setTool('text')
      else if (k === 'i') { setPenProgress(null); setTool('eyedropper') }
      else if (k === 'z') { setPenProgress(null); setTool('zoom') }
      else if (k === 'h') { setPenProgress(null); setTool('hand') }

      if (e.key === 'Enter') {
        const pen = penRef.current
        if (pen && pen.points.length >= 2) commitPenPath(pen.points, false)
      }
      if (e.key === 'Escape') {
        if (penRef.current) { setPenProgress(null); return }
        setSelectedIds([])
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (toolRef.current === 'node' && nodeSelRef.current != null && selectedIdsRef.current.length === 1) deleteNode()
        else deleteSel()
      }

      if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key) && selectedIdsRef.current.length > 0) {
        e.preventDefault()
        if (!e.repeat) pushHistory()
        const d = e.shiftKey ? 10 : 1
        const dx = e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0
        const dy = e.key === 'ArrowUp'   ? -d : e.key === 'ArrowDown'  ? d : 0
        setPageData(prev => ({ ...prev, elements: prev.elements.map(el =>
          selectedIdsRef.current.includes(el.id) ? translateEl(el, dx, dy) : el) }))
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [commitPenPath, centerArtboard, undo, redo, duplicateSel, copySel, pasteSel, selectAll, reorder, deleteSel, pushHistory, groupSel, ungroupSel, deleteNode])

  const [spaceDown, setSpaceDown] = useState(false)
  useEffect(() => {
    const kd = (e: KeyboardEvent) => { if (e.key === ' ' && e.target === document.body) { e.preventDefault(); setSpaceDown(true) } }
    const ku = (e: KeyboardEvent) => { if (e.key === ' ') setSpaceDown(false) }
    window.addEventListener('keydown', kd)
    window.addEventListener('keyup', ku)
    return () => { window.removeEventListener('keydown', kd); window.removeEventListener('keyup', ku) }
  }, [])

  const effectiveTool = spaceDown ? 'hand' : tool

  const selectedEl = selectedIds.length === 1
    ? pageData.elements.find(e => e.id === selectedIds[0]) ?? null
    : null

  function updateSelected(patch: Partial<VectorElement>) {
    if (!selectedEl) return
    setPageData(prev => ({
      ...prev,
      elements: prev.elements.map(el =>
        el.id === selectedEl.id ? { ...el, ...patch } as VectorElement : el,
      ),
    }))
  }

  // Update a text element and re-measure its bounding box.
  function updateText(patch: Partial<TextElement>) {
    if (!selectedEl || selectedEl.type !== 'text') return
    const merged = { ...(selectedEl as TextElement), ...patch }
    const m = measureText(merged)
    updateSelected({ ...patch, w: m.w, h: m.h } as Partial<VectorElement>)
  }

  const pages = pagesRes?.pages ?? []

  const cursor = effectiveTool === 'hand' ? 'grab'
    : effectiveTool === 'pen' ? 'crosshair'
    : effectiveTool === 'eyedropper' ? 'copy'
    : effectiveTool === 'zoom' ? 'zoom-in'
    : effectiveTool === 'rotateview' ? 'grab'
    : effectiveTool === 'select' || effectiveTool === 'node' ? 'default'
    : 'crosshair'

  if (!projectId) return null

  // Reusable property sections (used by single- and multi-selection views).
  const propBtnCls = 'flex items-center justify-center rounded transition-colors hover:brightness-150'
  const propBtnStyle = { width: 28, height: 24, background: '#2a2a2a', color: C.textDim } as React.CSSProperties
  const alignSection = (
    <PropSection title={t('apex_section_align')}>
      <div className="px-2 pb-2 flex flex-wrap gap-1">
        {([
          ['left',    t('apex_align_left'),     AlignLeft],
          ['hcenter', t('apex_align_center_h'), AlignCenter],
          ['right',   t('apex_align_right'),    AlignRight],
          ['top',     t('apex_align_top'),      AlignStartVertical],
          ['vcenter', t('apex_align_center_v'), AlignCenterVertical],
          ['bottom',  t('apex_align_bottom'),   AlignEndVertical],
        ] as [string, string, React.FC<{size?:number}>][]).map(([m, title, Icon]) => (
          <button key={m} title={title} onClick={() => align(m as 'left')} className={propBtnCls} style={propBtnStyle}><Icon size={12} /></button>
        ))}
      </div>
    </PropSection>
  )
  const distributeSection = (
    <PropSection title={t('apex_section_distribute')}>
      <div className="px-2 pb-2 flex gap-1">
        <button title={t('apex_distribute_h')} onClick={() => distribute('h')} className={propBtnCls} style={propBtnStyle}><AlignHorizontalDistributeCenter size={12} /></button>
        <button title={t('apex_distribute_v')} onClick={() => distribute('v')} className={propBtnCls} style={propBtnStyle}><AlignVerticalDistributeCenter size={12} /></button>
      </div>
    </PropSection>
  )
  const arrangeSection = (
    <PropSection title={t('apex_section_arrange')}>
      <div className="px-2 pb-2 flex flex-wrap gap-1">
        {([
          [t('apex_bring_front'), BringToFront,    () => reorder('front')],
          [t('apex_bring_fwd'),   ChevronUp,       () => reorder('forward')],
          [t('apex_send_bwd'),    ChevronDown,     () => reorder('backward')],
          [t('apex_send_back'),   SendToBack,      () => reorder('back')],
          [t('apex_flip_h'),      FlipHorizontal,  () => flip('h')],
          [t('apex_flip_v'),      FlipVertical,    () => flip('v')],
          [t('apex_duplicate'),   Copy,            duplicateSel],
          [t('apex_group'),       Group,           groupSel],
          [t('apex_ungroup'),     Ungroup,         ungroupSel],
        ] as [string, React.FC<{size?:number}>, () => void][]).map(([title, Icon, fn]) => (
          <button key={title} title={title} onClick={fn} className={propBtnCls} style={propBtnStyle}><Icon size={12} /></button>
        ))}
      </div>
    </PropSection>
  )
  const deleteSection = (
    <div className="px-2 pt-1 pb-3">
      <button onClick={deleteSel} className="flex items-center gap-2 w-full px-2 py-1.5 rounded text-[11px] transition-colors" style={{ color: '#e84a4a', background: '#2a1a1a' }}>
        <Trash2 size={12} /> {t('apex_delete_element')}
      </button>
    </div>
  )

  const apexPanels = {
    layers: { label: t('apex_layers'), render: () => (
      <div className="flex-1 overflow-y-auto">
              {[...pageData.elements].reverse().map(el => (
                <LayerRow
                  key={el.id}
                  el={el}
                  selected={selectedIds.includes(el.id)}
                  onSelect={() => setSelectedIds([el.id])}
                  onToggleVisible={() => updateEl(el.id, { visible: !el.visible }, setPageData)}
                  onToggleLock={() => updateEl(el.id, { locked: !el.locked }, setPageData)}
                />
              ))}
              {pageData.elements.length === 0 && (
                <p className="text-[10px] px-3 py-4" style={{ color: C.textDim }}>
                  {t('apex_no_elements')}
                </p>
              )}
      </div>
    ) },
    properties: { label: selectedEl ? selectedEl.name : t('apex_properties'), render: () => (
      <>{selectedEl ? (
            <>
              <PropSection title={t('apex_section_transform')}>
                <div className="grid grid-cols-2 gap-1 px-2 pb-2">
                  {(['x','y','w','h'] as (keyof VectorElement)[]).map(k => (
                    <label key={k} className="flex flex-col gap-0.5">
                      <span className="text-[9px] uppercase" style={{ color: C.textDim }}>{k.toUpperCase()}</span>
                      <input
                        type="number"
                        value={Math.round(selectedEl[k] as number)}
                        onChange={e => updateSelected({ [k]: Number(e.target.value) } as Partial<VectorElement>)}
                        className="w-full px-1.5 py-0.5 rounded text-[11px] outline-none"
                        style={{ background: '#2c2c2c', border: `1px solid ${C.border}`, color: C.text }}
                      />
                    </label>
                  ))}
                </div>
                <div className="grid grid-cols-2 gap-1 px-2 pb-2">
                  <label className="flex flex-col gap-0.5">
                    <span className="text-[9px] uppercase" style={{ color: C.textDim }}>{t('apex_rotation')}</span>
                    <input
                      type="number"
                      value={Math.round(selectedEl.rotation)}
                      onChange={e => updateSelected({ rotation: Number(e.target.value) })}
                      className="w-full px-1.5 py-0.5 rounded text-[11px] outline-none"
                      style={{ background: '#2c2c2c', border: `1px solid ${C.border}`, color: C.text }}
                    />
                  </label>
                  <label className="flex flex-col gap-0.5">
                    <span className="text-[9px] uppercase" style={{ color: C.textDim }}>{t('apex_opacity')}</span>
                    <input
                      type="number" min={0} max={100}
                      value={selectedEl.opacity}
                      onChange={e => updateSelected({ opacity: Number(e.target.value) })}
                      className="w-full px-1.5 py-0.5 rounded text-[11px] outline-none"
                      style={{ background: '#2c2c2c', border: `1px solid ${C.border}`, color: C.text }}
                    />
                  </label>
                </div>
              </PropSection>

              <PropSection title={t('apex_section_fill')}>
                <div className="px-2 pb-2 flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <Dropdown
                      variant="dark"
                      className="flex-1"
                      fontSize={11}
                      value={selectedEl.fill.type === 'radial-gradient' ? 'linear-gradient' : selectedEl.fill.type}
                      onChange={v => {
                        updateSelected({ fill:
                          v === 'none' ? { type: 'none' }
                          : v === 'linear-gradient' ? { type: 'linear-gradient', angle: 90, stops: [
                              { color: '#4a90d9', opacity: 100, position: 0 },
                              { color: '#9b59b6', opacity: 100, position: 1 },
                            ] }
                          : { type: 'solid', color: '#4a90d9', opacity: 100 } })
                      }}
                      options={[
                        { value: 'solid',           label: t('apex_fill_solid') },
                        { value: 'linear-gradient', label: t('apex_fill_gradient') },
                        { value: 'none',            label: t('apex_fill_none') },
                      ]}
                    />
                  </div>
                  {selectedEl.fill.type === 'solid' && (
                    <>
                      <div className="flex items-center gap-2">
                        <ColorField t={t} C={C} width={32} height={24} className="flex-shrink-0"
                          color={selectedEl.fill.color}
                          onChange={hex => updateSelected({ fill: { ...selectedEl.fill, color: hex } as typeof selectedEl.fill })} />
                        <input
                          type="text"
                          value={selectedEl.fill.type === 'solid' ? selectedEl.fill.color : ''}
                          onChange={e => {
                            if (/^#[0-9a-fA-F]{6}$/.test(e.target.value))
                              updateSelected({ fill: { ...selectedEl.fill, color: e.target.value } as typeof selectedEl.fill })
                          }}
                          className="flex-1 px-1.5 py-0.5 rounded text-[11px] font-mono outline-none"
                          style={{ background: '#2c2c2c', border: `1px solid ${C.border}`, color: C.text }}
                        />
                      </div>
                      {/* Fill opacity — independent from the border opacity. */}
                      <label className="flex items-center gap-2">
                        <span className="text-[9px] uppercase flex-shrink-0" style={{ color: C.textDim, width: 54 }}>{t('apex_opacity')}</span>
                        <input
                          type="range" min={0} max={100} className="flex-1"
                          value={selectedEl.fill.opacity}
                          onChange={e => updateSelected({ fill: { ...selectedEl.fill, opacity: Number(e.target.value) } as typeof selectedEl.fill })}
                        />
                        <input
                          type="number" min={0} max={100}
                          value={Math.round(selectedEl.fill.opacity)}
                          onChange={e => updateSelected({ fill: { ...selectedEl.fill, opacity: Math.max(0, Math.min(100, Number(e.target.value))) } as typeof selectedEl.fill })}
                          className="w-14 px-1.5 py-0.5 rounded text-[11px] outline-none"
                          style={{ background: '#2c2c2c', border: `1px solid ${C.border}`, color: C.text }}
                        />
                      </label>
                    </>
                  )}
                  {(selectedEl.fill.type === 'linear-gradient' || selectedEl.fill.type === 'radial-gradient') && (
                    <GradientField t={t} C={C} height={28} className="w-full" style={{ width: '100%' }}
                      value={apexFillToGradient(selectedEl.fill)}
                      onChange={g => updateSelected({ fill: gradientToApexFill(g) })} />
                  )}
                </div>
              </PropSection>

              <PropSection title={t('apex_section_border')}>
                <div className="px-2 pb-2 flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <Checkbox
                      variant="dark"
                      checked={!!selectedEl.stroke}
                      onChange={v => updateSelected({ stroke: v
                        ? { color: '#000000', opacity: 100, width: 1, dashArray: [] }
                        : null })}
                    />
                    <span className="text-[11px]" style={{ color: C.text }}>{t('apex_enable')}</span>
                  </div>
                  {selectedEl.stroke && (
                    <>
                      <div className="flex items-center gap-2">
                        <ColorField t={t} C={C} width={32} height={24} className="flex-shrink-0"
                          color={selectedEl.stroke.color}
                          onChange={hex => updateSelected({ stroke: { ...selectedEl.stroke!, color: hex } })} />
                        <input
                          type="number" min={0} max={50} step={0.5}
                          value={selectedEl.stroke.width}
                          onChange={e => updateSelected({ stroke: { ...selectedEl.stroke!, width: Number(e.target.value) } })}
                          className="flex-1 px-1.5 py-0.5 rounded text-[11px] outline-none"
                          style={{ background: '#2c2c2c', border: `1px solid ${C.border}`, color: C.text }}
                          placeholder={t('apex_stroke_width')}
                        />
                      </div>
                      {/* Border opacity — independent from the fill opacity. */}
                      <label className="flex items-center gap-2">
                        <span className="text-[9px] uppercase flex-shrink-0" style={{ color: C.textDim, width: 54 }}>{t('apex_opacity')}</span>
                        <input
                          type="range" min={0} max={100} className="flex-1"
                          value={selectedEl.stroke.opacity}
                          onChange={e => updateSelected({ stroke: { ...selectedEl.stroke!, opacity: Number(e.target.value) } })}
                        />
                        <input
                          type="number" min={0} max={100}
                          value={Math.round(selectedEl.stroke.opacity)}
                          onChange={e => updateSelected({ stroke: { ...selectedEl.stroke!, opacity: Math.max(0, Math.min(100, Number(e.target.value))) } })}
                          className="w-14 px-1.5 py-0.5 rounded text-[11px] outline-none"
                          style={{ background: '#2c2c2c', border: `1px solid ${C.border}`, color: C.text }}
                        />
                      </label>
                      <div className="flex items-center gap-1">
                        <Dropdown variant="dark" className="flex-1" fontSize={11}
                          value={(() => { const d = selectedEl.stroke!.dashArray; return !d.length ? 'solid' : d[0] <= 2 ? 'dotted' : 'dashed' })()}
                          onChange={v => updateSelected({ stroke: { ...selectedEl.stroke!,
                            dashArray: v === 'solid' ? [] : v === 'dotted' ? [1, 3] : [8, 5] } })}
                          options={[
                            { value: 'solid',  label: t('apex_dash_solid') },
                            { value: 'dashed', label: t('apex_dash_dashed') },
                            { value: 'dotted', label: t('apex_dash_dotted') },
                          ]} />
                        <Dropdown variant="dark" className="flex-1" fontSize={11}
                          value={selectedEl.stroke!.cap ?? 'butt'}
                          onChange={v => updateSelected({ stroke: { ...selectedEl.stroke!, cap: v as 'butt' } })}
                          options={[
                            { value: 'butt',   label: t('apex_cap_butt') },
                            { value: 'round',  label: t('apex_cap_round') },
                            { value: 'square', label: t('apex_cap_square') },
                          ]} />
                        <Dropdown variant="dark" className="flex-1" fontSize={11}
                          value={selectedEl.stroke!.join ?? 'miter'}
                          onChange={v => updateSelected({ stroke: { ...selectedEl.stroke!, join: v as 'miter' } })}
                          options={[
                            { value: 'miter', label: t('apex_join_miter') },
                            { value: 'round', label: t('apex_join_round') },
                            { value: 'bevel', label: t('apex_join_bevel') },
                          ]} />
                      </div>
                    </>
                  )}
                </div>
              </PropSection>

              {selectedEl.type === 'rect' && (
                <PropSection title={t('apex_rectangle')}>
                  <div className="px-2 pb-2">
                    <label className="flex flex-col gap-0.5">
                      <span className="text-[9px] uppercase" style={{ color: C.textDim }}>{t('apex_corner_radius')}</span>
                      <input
                        type="number" min={0}
                        value={(selectedEl as import('./api').RectElement).cornerRadius}
                        onChange={e => updateSelected({ cornerRadius: Number(e.target.value) } as Partial<VectorElement>)}
                        className="w-full px-1.5 py-0.5 rounded text-[11px] outline-none"
                        style={{ background: '#2c2c2c', border: `1px solid ${C.border}`, color: C.text }}
                      />
                    </label>
                  </div>
                </PropSection>
              )}

              {selectedEl.type === 'path' && (selectedEl as PathElement).shape === 'polygon' && (
                <PropSection title={t('apex_section_shape')}>
                  <div className="px-2 pb-2">
                    <label className="flex flex-col gap-0.5">
                      <span className="text-[9px] uppercase" style={{ color: C.textDim }}>{t('apex_shape_sides')}</span>
                      <input
                        type="number" min={3} max={100}
                        value={(selectedEl as PathElement).sides ?? 6}
                        onChange={e => {
                          const pe = { ...(selectedEl as PathElement), sides: Math.max(3, Math.min(100, Number(e.target.value))) }
                          updateSelected({ sides: pe.sides, points: regenShapePoints(pe) } as Partial<VectorElement>)
                        }}
                        className="w-full px-1.5 py-0.5 rounded text-[11px] outline-none"
                        style={{ background: '#2c2c2c', border: `1px solid ${C.border}`, color: C.text }}
                      />
                    </label>
                  </div>
                </PropSection>
              )}

              {selectedEl.type === 'path' && (selectedEl as PathElement).shape === 'star' && (
                <PropSection title={t('apex_section_shape')}>
                  <div className="grid grid-cols-2 gap-1 px-2 pb-2">
                    <label className="flex flex-col gap-0.5">
                      <span className="text-[9px] uppercase" style={{ color: C.textDim }}>{t('apex_shape_points')}</span>
                      <input
                        type="number" min={3} max={100}
                        value={(selectedEl as PathElement).spikes ?? 5}
                        onChange={e => {
                          const pe = { ...(selectedEl as PathElement), spikes: Math.max(3, Math.min(100, Number(e.target.value))) }
                          updateSelected({ spikes: pe.spikes, points: regenShapePoints(pe) } as Partial<VectorElement>)
                        }}
                        className="w-full px-1.5 py-0.5 rounded text-[11px] outline-none"
                        style={{ background: '#2c2c2c', border: `1px solid ${C.border}`, color: C.text }}
                      />
                    </label>
                    <label className="flex flex-col gap-0.5">
                      <span className="text-[9px] uppercase" style={{ color: C.textDim }}>{t('apex_shape_inner')}</span>
                      <input
                        type="number" min={5} max={95}
                        value={Math.round(((selectedEl as PathElement).innerRatio ?? 0.45) * 100)}
                        onChange={e => {
                          const pe = { ...(selectedEl as PathElement), innerRatio: Math.max(0.05, Math.min(0.95, Number(e.target.value) / 100)) }
                          updateSelected({ innerRatio: pe.innerRatio, points: regenShapePoints(pe) } as Partial<VectorElement>)
                        }}
                        className="w-full px-1.5 py-0.5 rounded text-[11px] outline-none"
                        style={{ background: '#2c2c2c', border: `1px solid ${C.border}`, color: C.text }}
                      />
                    </label>
                  </div>
                </PropSection>
              )}

              {selectedEl.type === 'text' && (
                <PropSection title={t('apex_tool_text')}>
                  <div className="px-2 pb-2 flex flex-col gap-2">
                    <textarea
                      value={(selectedEl as TextElement).text}
                      onChange={e => updateText({ text: e.target.value })}
                      rows={2}
                      className="w-full px-1.5 py-1 rounded text-[11px] outline-none resize-y"
                      style={{ background: '#2c2c2c', border: `1px solid ${C.border}`, color: C.text }}
                    />
                    <div className="grid grid-cols-2 gap-1">
                      <label className="flex flex-col gap-0.5">
                        <span className="text-[9px] uppercase" style={{ color: C.textDim }}>{t('apex_text_size')}</span>
                        <input type="number" min={4} max={400} value={(selectedEl as TextElement).fontSize}
                          onChange={e => updateText({ fontSize: Number(e.target.value) })}
                          className="w-full px-1.5 py-0.5 rounded text-[11px] outline-none"
                          style={{ background: '#2c2c2c', border: `1px solid ${C.border}`, color: C.text }} />
                      </label>
                      <label className="flex flex-col gap-0.5">
                        <span className="text-[9px] uppercase" style={{ color: C.textDim }}>{t('apex_text_weight')}</span>
                        <Dropdown variant="dark" fontSize={11}
                          value={String((selectedEl as TextElement).fontWeight)}
                          onChange={v => updateText({ fontWeight: Number(v) })}
                          options={[
                            { value: '300', label: t('apex_text_light') },
                            { value: '400', label: t('apex_text_regular') },
                            { value: '700', label: t('apex_text_bold') },
                          ]} />
                      </label>
                    </div>
                    <Dropdown variant="dark" fontSize={11}
                      value={(selectedEl as TextElement).fontFamily}
                      onChange={v => updateText({ fontFamily: v })}
                      options={['Inter','Georgia','Courier New','Arial','Times New Roman'].map(f => ({ value: f, label: f }))} />
                    <div className="flex items-center gap-1">
                      {(['left','center','right'] as const).map(a => (
                        <button key={a} onClick={() => updateText({ align: a })}
                          className="flex-1 flex items-center justify-center h-6 rounded"
                          style={{ background: (selectedEl as TextElement).align === a ? C.accent + '30' : '#2a2a2a',
                                   color: (selectedEl as TextElement).align === a ? C.accent : C.textDim }}>
                          {a === 'left' ? <AlignLeft size={13} /> : a === 'center' ? <AlignCenter size={13} /> : <AlignRight size={13} />}
                        </button>
                      ))}
                      <button onClick={() => updateText({ italic: !(selectedEl as TextElement).italic })}
                        className="flex-1 flex items-center justify-center h-6 rounded italic text-[12px]"
                        style={{ background: (selectedEl as TextElement).italic ? C.accent + '30' : '#2a2a2a',
                                 color: (selectedEl as TextElement).italic ? C.accent : C.textDim }}>I</button>
                    </div>
                  </div>
                </PropSection>
              )}

              {alignSection}
              {arrangeSection}
              {selectedEl.type !== 'path' && selectedEl.type !== 'text' && (
                <div className="px-2 pt-1 pb-1">
                  <button onClick={convertToPath} className="flex items-center gap-2 w-full px-2 py-1.5 rounded text-[11px] transition-colors"
                    style={{ color: C.text, background: '#2a2a2a' }}>
                    <Waypoints size={12} /> {t('apex_convert_to_path')}
                  </button>
                </div>
              )}
              {deleteSection}
            </>
          ) : selectedIds.length >= 2 ? (
            <>
              <div className="px-3 py-2 text-[11px] font-medium" style={{ color: C.text }}>
                {t('apex_n_selected', { count: selectedIds.length })}
              </div>
              {alignSection}
              {distributeSection}
              {arrangeSection}
              {deleteSection}
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center p-4">
              <p className="text-[11px] text-center" style={{ color: C.textDim }}>
                {tool === 'pen'
                  ? t('apex_pen_hint')
                  : tool === 'node'
                  ? t('apex_node_hint')
                  : t('apex_select_hint')}
              </p>
            </div>
          )}</>
    ) },
  }

  return (
    <EditorShell theme={C}
      chromeless
      topbarHeight={64}
      onBack={() => { if (projectId && pageId) saveMut.mutate(pageData); navigate('/paintsharp/apex') }}
      title={titleDraft}
      onTitleChange={setTitleDraft}
      onTitleCommit={commitTitle}
      titlePlaceholder={t('common_untitled', { defaultValue: 'Sans titre' })}
      saveStatus={saveMut.isPending ? t('apex_saving') : t('doc_saved', { defaultValue: 'Enregistré' })}
      subtitle="Apex"
      docInfo={pageData.artboards[0] ? `${pageData.artboards[0].width}×${pageData.artboards[0].height}` : undefined}
      titleActions={(
        <button
          onClick={() => starMut.mutate(!project?.is_starred)}
          title={project?.is_starred ? t('apex_unstar', { defaultValue: 'Retirer des favoris' }) : t('apex_star', { defaultValue: 'Ajouter aux favoris' })}
          className="p-1.5 rounded hover:bg-white/10 flex-shrink-0 transition-colors"
          style={{ color: project?.is_starred ? '#f9ab00' : C.textDim }}>
          <Star size={15} fill={project?.is_starred ? 'currentColor' : 'none'} />
        </button>
      )}
      onDelete={() => trashMut.mutate()}
      deleteTitle={t('apex_move_to_trash', { defaultValue: 'Mettre à la corbeille' })}
      deleteConfirm={{
        title: t('apex_delete_confirm_title', { defaultValue: 'Supprimer ce projet ?' }),
        message: t('apex_delete_confirm_msg', { defaultValue: 'Le projet sera déplacé dans la corbeille.' }),
        confirmLabel: t('common_delete', { defaultValue: 'Supprimer' }),
        variant: 'danger',
      }}
      menus={paintsharpMenus(t, {
        onSave:  () => { if (projectId && pageId) saveMut.mutate(pageData) },
        onClose: () => { if (projectId && pageId) saveMut.mutate(pageData); navigate('/paintsharp/apex') },
        onExport: () => {
          if (!projectId) return
          import('./apexSvgIO').then(({ saveApexAsSvg }) =>
            saveApexAsSvg(projectId, pageDataRef.current, 'dessin').catch(() => {}))
        },
        exportLabel: t('apex_export_svg', { defaultValue: 'Enregistrer en SVG' }),
        onUndo: undo, onRedo: redo,
        editExtra: [
          { label: t('apex_ctx_cut'),   onClick: cutSel,   shortcut: 'Ctrl+X' },
          { label: t('apex_ctx_copy'),  onClick: copySel,  shortcut: 'Ctrl+C' },
          { label: t('apex_ctx_paste'), onClick: pasteSel, shortcut: 'Ctrl+V' },
          { label: t('apex_duplicate'), onClick: duplicateSel, shortcut: 'Ctrl+D' },
          'sep',
          { label: t('apex_ctx_select_all'), onClick: selectAll, shortcut: 'Ctrl+A' },
          { label: t('apex_delete_element'), onClick: deleteSel, shortcut: 'Suppr' },
        ],
        extraMenus: [{
          label: t('apex_menu_object'),
          items: [
            { label: t('apex_group'),    onClick: groupSel,   shortcut: 'Ctrl+G' },
            { label: t('apex_ungroup'),  onClick: ungroupSel, shortcut: 'Ctrl+Shift+G' },
            'sep',
            { label: t('apex_convert_to_path'), onClick: convertToPath },
            'sep',
            { label: t('apex_bring_front'), onClick: () => reorder('front') },
            { label: t('apex_send_back'),   onClick: () => reorder('back') },
            'sep',
            { label: t('apex_flip_h'), onClick: () => flip('h') },
            { label: t('apex_flip_v'), onClick: () => flip('v') },
          ],
        }],
        onZoomIn:  () => setCs(prev => { const nz=Math.min(20,prev.zoom*1.2); const c=canvasRef.current; if(!c) return {...prev,zoom:nz}; const r=c.getBoundingClientRect(); return {zoom:nz,panX:r.width/2-(r.width/2-prev.panX)*(nz/prev.zoom),panY:r.height/2-(r.height/2-prev.panY)*(nz/prev.zoom)} }),
        onZoomOut: () => setCs(prev => { const nz=Math.max(0.02,prev.zoom*0.8); const c=canvasRef.current; if(!c) return {...prev,zoom:nz}; const r=c.getBoundingClientRect(); return {zoom:nz,panX:r.width/2-(r.width/2-prev.panX)*(nz/prev.zoom),panY:r.height/2-(r.height/2-prev.panY)*(nz/prev.zoom)} }),
        onFit:     () => centerArtboard(pageData),
        viewExtra: [
          { label: t('apex_reset_rotation'), onClick: () => setCs(prev => ({ ...prev, rot: 0 })) },
        ],
      })}
      topbarActions={<>
        {penProgress && <span className="text-xs" style={{ color: C.accent }}>{t('apex_pen_progress', { count: penProgress.points.length })}</span>}
        <button onClick={() => { if (projectId && pageId) saveMut.mutate(pageData) }} className="px-3 py-1 rounded text-xs" style={{ background: C.accent, color: '#fff' }}>{t('common_save')}</button>
      </>}
      toolRailWidth={72}
      toolRail={<>
          {/* Palette d'outils sur 2 colonnes, façon Illustrator (raccourci entre parenthèses) */}
          <div className="grid grid-cols-2 gap-0.5">
          {([
            { id: 'select',  icon: MousePointer, label: t('apex_tool_select'),      sc: 'V' },
            { id: 'node',    icon: Spline,       label: t('apex_tool_node'),        sc: 'A' },
            { id: 'pen',     icon: PenTool,      label: t('apex_tool_pen'),         sc: 'P' },
            { id: 'text',    icon: Type,         label: t('apex_tool_text'),        sc: 'T' },
            { id: 'rect',    icon: Square,       label: t('apex_tool_rect'),        sc: 'M' },
            { id: 'ellipse', icon: Circle,       label: t('apex_tool_ellipse'),     sc: 'L' },
            { id: 'polygon', icon: Hexagon,      label: t('apex_tool_polygon'),     sc: '' },
            { id: 'star',    icon: Star,         label: t('apex_tool_star'),        sc: '' },
            { id: 'line',    icon: Minus,        label: t('apex_tool_line'),        sc: '\\' },
            { id: 'eyedropper', icon: Pipette,   label: t('apex_tool_eyedropper'),  sc: 'I' },
            { id: 'zoom',    icon: Search,       label: t('apex_tool_zoom'),        sc: 'Z' },
            { id: 'rotateview', icon: RotateCw,  label: t('apex_tool_rotate_view'), sc: '' },
            { id: 'hand',    icon: Hand,         label: t('apex_tool_hand'),        sc: 'H' },
          ] as { id: Tool; icon: React.ComponentType<{size?:number;style?:React.CSSProperties}>; label: string; sc: string }[]).map(({ id, icon: Icon, label, sc }) => (
            <button
              key={id}
              title={sc ? `${label} (${sc})` : label}
              onClick={() => { if (id !== 'pen') setPenProgress(null); setTool(id) }}
              className="w-8 h-8 rounded flex items-center justify-center transition-colors"
              style={{
                background: tool === id ? C.accent + '30' : 'transparent',
                color: tool === id ? C.accent : C.textDim,
              }}
            >
              <Icon size={16} />
            </button>
          ))}
          </div>

          {/* Bloc Fond / Contour façon Illustrator (agit sur l'objet sélectionné) */}
          <div className="h-px w-full my-1.5" style={{ background: C.border }} />
          <div className="relative" style={{ width: 40, height: 40 }} title={t('apex_fill_stroke')}>
            {/* Contour (carré creux, en arrière-plan) */}
            <div className="absolute" style={{ right: 0, bottom: 0, width: 24, height: 24, borderRadius: 3, border: `3px solid ${selectedEl?.stroke?.color ?? '#000000'}`, background: '#fff' }} />
            {/* Fond (carré plein, au premier plan) */}
            <ColorField width={24} height={24} className="absolute"
              style={{ left: 0, top: 0 }}
              color={selectedEl && selectedEl.fill.type === 'solid' ? selectedEl.fill.color : '#cccccc'}
              onChange={hex => { if (selectedEl) updateSelected({ fill: { type: 'solid', color: hex, opacity: selectedEl.fill.type === 'solid' ? selectedEl.fill.opacity : 100 } }) }} />
          </div>
          {/* Échanger / Aucun */}
          <div className="flex gap-0.5 mt-0.5">
            <button title={t('apex_fill_stroke_swap')} onClick={() => {
              if (!selectedEl) return
              const fillColor = selectedEl.fill.type === 'solid' ? selectedEl.fill.color : '#000000'
              const strokeColor = selectedEl.stroke?.color ?? '#000000'
              updateSelected({
                fill: { type: 'solid', color: strokeColor, opacity: selectedEl.fill.type === 'solid' ? selectedEl.fill.opacity : 100 },
                stroke: { ...(selectedEl.stroke ?? { opacity: 100, width: 1, dashArray: [] }), color: fillColor },
              })
            }} className="w-5 h-5 rounded flex items-center justify-center hover:bg-white/10 text-[9px]" style={{ color: C.textDim }}>⇄</button>
            <button title={t('apex_fill_none')} onClick={() => { if (selectedEl) updateSelected({ fill: { type: 'none' } }) }}
              className="w-5 h-5 rounded flex items-center justify-center hover:bg-white/10 text-[9px]" style={{ color: C.textDim }}>∅</button>
          </div>

          <div style={{ flex: 1 }} />
          {/* Zoom controls */}
          <button
            title={t('apex_zoom_in')}
            onClick={() => setCs(prev => {
              const nz = Math.min(20, prev.zoom * 1.2)
              const canvas = canvasRef.current
              if (!canvas) return { ...prev, zoom: nz }
              const { width: cw, height: ch } = canvas.getBoundingClientRect()
              return { zoom: nz, panX: cw/2-(cw/2-prev.panX)*(nz/prev.zoom), panY: ch/2-(ch/2-prev.panY)*(nz/prev.zoom) }
            })}
            className="w-8 h-7 rounded flex items-center justify-center hover:bg-white/10"
            style={{ color: C.textDim }}
          >
            <ZoomIn size={13} />
          </button>
          <span className="text-[9px] text-center" style={{ color: C.textDim }}>
            {Math.round(cs.zoom * 100)}%
          </span>
          <button
            title={t('apex_zoom_out')}
            onClick={() => setCs(prev => {
              const nz = Math.max(0.02, prev.zoom * 0.8)
              const canvas = canvasRef.current
              if (!canvas) return { ...prev, zoom: nz }
              const { width: cw, height: ch } = canvas.getBoundingClientRect()
              return { zoom: nz, panX: cw/2-(cw/2-prev.panX)*(nz/prev.zoom), panY: ch/2-(ch/2-prev.panY)*(nz/prev.zoom) }
            })}
            className="w-8 h-7 rounded flex items-center justify-center hover:bg-white/10"
            style={{ color: C.textDim }}
          >
            <ZoomOut size={13} />
          </button>
          <button
            title={t('apex_fit_to_screen')}
            onClick={() => centerArtboard(pageData)}
            className="w-8 h-7 rounded flex items-center justify-center hover:bg-white/10 text-[8px]"
            style={{ color: C.textDim }}
          >
            {t('apex_fit')}
          </button></>}
      bottomBar={
        <div className="flex items-center gap-1 px-2 flex-shrink-0 overflow-x-auto"
             style={{ height: 32, background: C.header, borderTop: `1px solid ${C.border}` }}>
        {pages.map((p, i) => (
          <button
            key={p.id}
            onClick={() => setCurrentPageIdx(i)}
            className="px-3 py-0.5 rounded text-xs flex-shrink-0 transition-colors"
            style={{
              background: i === currentPageIdx ? C.accent + '25' : 'transparent',
              color:      i === currentPageIdx ? C.accent : C.textDim,
              border:     `1px solid ${i === currentPageIdx ? C.accent + '60' : 'transparent'}`,
            }}
          >
            {p.name}
          </button>
        ))}
        <button
          onClick={async () => {
            if (!projectId) return
            const r = await apexApi.createPage(projectId, { name: t('apex_page_name', { number: pages.length + 1 }) })
            qc.invalidateQueries({ queryKey: ['apex-pages', projectId] })
            setCurrentPageIdx(pages.length)
            void r
          }}
          className="flex items-center justify-center w-6 h-6 rounded transition-colors ml-1"
          style={{ color: C.textDim }}
          title={t('apex_add_page')}
        >
          <Plus size={12} />
        </button>
        </div>
      }>
      <DockArea theme={C} storageKey="kubuno:paintsharp:apexDockLayout" viewportBg={C.bg}
        defaultArrangement={{ left: [['layers']], right: [['properties']] }}
        panels={apexPanels}>
        <canvas ref={canvasRef} className="block w-full h-full" style={{ cursor }}
                onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={onMouseUp} onMouseLeave={onMouseUp}
                onWheel={onWheel} onContextMenu={onCanvasContextMenu} />
      </DockArea>
      {ctx.menu}
    </EditorShell>
  )
}
// ── Helpers ────────────────────────────────────────────────────────────────────

function updateEl(
  id: string,
  patch: Partial<VectorElement>,
  setter: React.Dispatch<React.SetStateAction<VectorPageData>>,
) {
  setter(prev => ({
    ...prev,
    elements: prev.elements.map(el => el.id === id ? { ...el, ...patch } as VectorElement : el),
  }))
}

function PropSection({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(true)
  return (
    <div style={{ borderBottom: `1px solid #2a2a2a` }}>
      <button
        onClick={() => setOpen(v => !v)}
        className="flex items-center justify-between w-full px-3 py-1.5"
        style={{ color: '#c0c0c0' }}
      >
        <span className="text-[11px] font-medium">{title}</span>
        <ChevronRight size={11} style={{ transform: open ? 'rotate(90deg)' : undefined, transition: 'transform 0.1s' }} />
      </button>
      {open && children}
    </div>
  )
}

function LayerRow({
  el, selected, onSelect, onToggleVisible, onToggleLock,
}: {
  el: VectorElement; selected: boolean; onSelect: () => void
  onToggleVisible: () => void; onToggleLock: () => void
}) {
  const Icon = el.type === 'rect' ? Square
    : el.type === 'ellipse' ? Circle
    : el.type === 'path'    ? PenTool
    : Type

  return (
    <div
      onClick={onSelect}
      className="flex items-center px-2 h-7 cursor-pointer group"
      style={{
        background:   selected ? '#e84a9015' : 'transparent',
        borderBottom: `1px solid #2a2a2a`,
        color:        selected ? '#e84a90' : '#9e9e9e',
      }}
    >
      <div className="w-4" />
      <Icon size={12} className="mr-1.5 flex-shrink-0" />
      <span className="flex-1 text-[11px] truncate">{el.name}</span>
      <div className="hidden group-hover:flex items-center gap-0.5">
        <button onClick={e => { e.stopPropagation(); onToggleVisible() }} className="p-0.5 rounded">
          {el.visible ? <Eye size={10} /> : <EyeOff size={10} style={{ opacity: 0.4 }} />}
        </button>
        <button onClick={e => { e.stopPropagation(); onToggleLock() }} className="p-0.5 rounded">
          {el.locked ? <Lock size={10} style={{ color: '#e84a90' }} /> : <Unlock size={10} />}
        </button>
      </div>
    </div>
  )
}
