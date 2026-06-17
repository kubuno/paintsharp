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
  Search, RotateCw, Magnet, Grid3x3,
  ChevronsDownUp, FolderPlus, Folder, FolderOpen, GripVertical,
} from 'lucide-react'
import polygonClipping from 'polygon-clipping'
import { Dropdown, Checkbox, GradientField, DEFAULT_GRADIENT, type Gradient } from '@ui'
import { apexApi, type VectorPageData, type VectorElement, type PathPoint, type PathElement, type TextElement, type GroupElement, type FillStyle } from './api'
import { C as SHELL_C, EditorShell, DockArea, ColorField, paintsharpMenus, useContextMenu, type CtxItem } from './ui'
import { EmbedShell } from './EmbedShell'

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
  guides?: { vx: number[]; hy: number[] },
  grid?: { size: number; on: boolean },
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

  // Optional grid (clipped to each artboard so it reads as page guides).
  if (grid?.on && grid.size > 0) {
    ctx.save()
    ctx.strokeStyle = 'rgba(120,120,140,0.18)'
    ctx.lineWidth = 1 / cs.zoom
    for (const ab of pageData.artboards) {
      ctx.beginPath()
      for (let gx = ab.x; gx <= ab.x + ab.width + 0.5; gx += grid.size) { ctx.moveTo(gx, ab.y); ctx.lineTo(gx, ab.y + ab.height) }
      for (let gy = ab.y; gy <= ab.y + ab.height + 0.5; gy += grid.size) { ctx.moveTo(ab.x, gy); ctx.lineTo(ab.x + ab.width, gy) }
      ctx.stroke()
    }
    ctx.restore()
  }

  // Elements — depth-first tree order, with cascaded (parent×child) opacity.
  for (const { el, alpha: eff } of renderOrder(pageData.elements)) {
    ctx.save()
    ctx.globalAlpha = eff

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
        ctx.globalAlpha = eff * (fill.opacity / 100)
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
        ctx.globalAlpha = eff
        ctx.fill()
      } else if (fill.type === 'radial-gradient') {
        const b = elBBox(el)
        const cx = b.x + b.w / 2, cy = b.y + b.h / 2
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(b.w, b.h) / 2)
        const stops = [...fill.stops].sort((a, z) => a.position - z.position)
        for (const s of stops) g.addColorStop(Math.max(0, Math.min(1, s.position)), hexWithAlpha(s.color, s.opacity))
        ctx.fillStyle = g
        ctx.globalAlpha = eff
        ctx.fill()
      }
      if (el.stroke && el.stroke.width > 0) {
        ctx.strokeStyle = el.stroke.color
        ctx.lineWidth   = el.stroke.width
        ctx.lineCap     = el.stroke.cap  ?? 'butt'
        ctx.lineJoin    = el.stroke.join ?? 'miter'
        ctx.setLineDash((el.stroke.dashArray ?? []).map(d => d))
        ctx.globalAlpha = eff * (el.stroke.opacity / 100)
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

  // Smart alignment guides (magenta, full-bleed across the visible world).
  if (guides && (guides.vx.length || guides.hy.length)) {
    ctx.save()
    ctx.strokeStyle = '#d6249f'
    ctx.lineWidth = 1 / cs.zoom
    ctx.setLineDash([])
    // Span large enough to cross the viewport at any pan/zoom.
    const span = 100000
    ctx.beginPath()
    for (const x of guides.vx) { ctx.moveTo(x, -span); ctx.lineTo(x, span) }
    for (const y of guides.hy) { ctx.moveTo(-span, y); ctx.lineTo(span, y) }
    ctx.stroke()
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

// ── Gradient editing overlay (line + endpoint handles + draggable stops) ────────
function drawGradientOverlay(ctx: CanvasRenderingContext2D, el: VectorElement, cs: CanvasState, dpr: number) {
  const gl = gradientLine(el)
  if (!gl) return
  const f = el.fill
  if (f.type !== 'linear-gradient' && f.type !== 'radial-gradient') return
  ctx.save()
  ctx.scale(dpr, dpr)
  ctx.translate(cs.panX, cs.panY)
  if (cs.rot) ctx.rotate(cs.rot)
  ctx.scale(cs.zoom, cs.zoom)
  const lw = 1.5 / cs.zoom
  // Gradient line (white halo + accent core for contrast over any fill).
  ctx.setLineDash([])
  ctx.lineCap = 'round'
  ctx.strokeStyle = 'rgba(0,0,0,0.45)'; ctx.lineWidth = lw * 3
  ctx.beginPath(); ctx.moveTo(gl.sx, gl.sy); ctx.lineTo(gl.ex, gl.ey); ctx.stroke()
  ctx.strokeStyle = '#fff'; ctx.lineWidth = lw
  ctx.beginPath(); ctx.moveTo(gl.sx, gl.sy); ctx.lineTo(gl.ex, gl.ey); ctx.stroke()
  // Endpoint discs.
  const r = 5 / cs.zoom
  for (const [hx, hy] of [[gl.sx, gl.sy], [gl.ex, gl.ey]] as [number, number][]) {
    ctx.beginPath(); ctx.arc(hx, hy, r, 0, Math.PI * 2)
    ctx.fillStyle = '#fff'; ctx.fill()
    ctx.strokeStyle = C.accent; ctx.lineWidth = lw * 1.2; ctx.stroke()
  }
  // Colour stops as diamonds painted in their own colour.
  const d = 4 / cs.zoom
  for (const s of f.stops) {
    const px = gl.sx + (gl.ex - gl.sx) * s.position
    const py = gl.sy + (gl.ey - gl.sy) * s.position
    ctx.save(); ctx.translate(px, py); ctx.rotate(Math.PI / 4)
    ctx.fillStyle = s.color; ctx.fillRect(-d, -d, 2 * d, 2 * d)
    ctx.strokeStyle = '#fff'; ctx.lineWidth = lw; ctx.strokeRect(-d, -d, 2 * d, 2 * d)
    ctx.restore()
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
  if (el.type === 'group') return false   // containers have no geometry
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

// ── Hierarchical layers (parentId + `group` container elements) ─────────────────
const ROOT = '__root__'
function pkey(el: { parentId?: string | null }): string { return el.parentId ?? ROOT }
// Direct children of a parent (ROOT for top level), in sibling z-order.
function childrenOf(els: VectorElement[], parentId: string): VectorElement[] {
  return els.filter(e => pkey(e) === parentId).sort((a, b) => a.zIndex - b.zIndex)
}
// All descendant ids of a group (groups + leaves), excluding the group itself.
function descendantIds(els: VectorElement[], groupId: string): Set<string> {
  const out = new Set<string>()
  const walk = (pid: string) => {
    for (const e of els) if (pkey(e) === pid && !out.has(e.id)) { out.add(e.id); if (e.type === 'group') walk(e.id) }
  }
  walk(groupId)
  return out
}
// Non-group descendant leaves of a group.
function descendantLeaves(els: VectorElement[], groupId: string): VectorElement[] {
  return [...descendantIds(els, groupId)].map(id => els.find(e => e.id === id)!).filter(e => e && e.type !== 'group')
}
// Top-most ancestor group of an element (the group to select when clicked).
function topAncestorGroup(els: VectorElement[], id: string): string | null {
  let cur = els.find(e => e.id === id)
  let top: string | null = null
  const seen = new Set<string>()
  while (cur && cur.parentId && !seen.has(cur.parentId)) {
    seen.add(cur.parentId)
    top = cur.parentId
    cur = els.find(e => e.id === cur!.parentId)
  }
  return top
}
// True if `el` or any ancestor group is hidden / locked (cascades).
function ancestorFlag(els: VectorElement[], el: VectorElement, flag: 'visible' | 'locked'): boolean {
  let cur: VectorElement | undefined = el
  const seen = new Set<string>()
  while (cur) {
    if (flag === 'visible' ? !cur.visible : cur.locked) return true
    if (!cur.parentId || seen.has(cur.parentId)) break
    seen.add(cur.parentId)
    cur = els.find(e => e.id === cur!.parentId)
  }
  return false
}
function effHidden(els: VectorElement[], el: VectorElement) { return ancestorFlag(els, el, 'visible') }
function effLocked(els: VectorElement[], el: VectorElement) { return ancestorFlag(els, el, 'locked') }

// Leaf elements (with cascaded alpha) in depth-first render order.
function renderOrder(els: VectorElement[]): { el: VectorElement; alpha: number }[] {
  const out: { el: VectorElement; alpha: number }[] = []
  const walk = (parentId: string, vis: boolean, alpha: number) => {
    for (const el of childrenOf(els, parentId)) {
      const v = vis && el.visible
      const a = alpha * (el.opacity / 100)
      if (el.type === 'group') walk(el.id, v, a)
      else if (v) out.push({ el, alpha: a })
    }
  }
  walk(ROOT, true, 1)
  return out
}
// Union bbox of a group's descendant leaves.
function groupBBox(els: VectorElement[], groupId: string): { x: number; y: number; w: number; h: number } | null {
  return selBBox(descendantLeaves(els, groupId))
}
// Remove group elements that have no children left (after delete/ungroup).
function pruneEmptyGroups(els: VectorElement[]): VectorElement[] {
  let cur = els
  for (;;) {
    const empty = new Set(cur.filter(e => e.type === 'group' && !cur.some(c => c.parentId === e.id)).map(e => e.id))
    if (!empty.size) return cur
    cur = cur.filter(e => !empty.has(e.id))
  }
}
// Move `dragId` relative to `targetId` in the layer tree. `zone`:
//   'inside' → become last child of target (must be a group)
//   'before'/'after' → sibling of target, visually above/below it
// Returns the new element list with sibling z-order renumbered. No-op on cycles.
function moveElement(els: VectorElement[], dragId: string, targetId: string, zone: 'before' | 'after' | 'inside'): VectorElement[] {
  const drag = els.find(e => e.id === dragId), target = els.find(e => e.id === targetId)
  if (!drag || !target || dragId === targetId) return els
  const newParent: string | null = zone === 'inside' && target.type === 'group' ? target.id : (target.parentId ?? null)
  // Guard against dropping a group into itself or a descendant.
  if (drag.type === 'group') {
    if (newParent === drag.id) return els
    const desc = descendantIds(els, drag.id)
    if (newParent && desc.has(newParent)) return els
  }
  // Visual order = front (highest z) first.
  const sibs = els.filter(e => (e.parentId ?? null) === newParent && e.id !== dragId).sort((a, b) => b.zIndex - a.zIndex)
  let insertIdx: number
  if (zone === 'inside') insertIdx = 0
  else { const ti = sibs.findIndex(s => s.id === targetId); insertIdx = ti < 0 ? sibs.length : (zone === 'after' ? ti + 1 : ti) }
  const moved = { ...drag, parentId: newParent } as VectorElement
  sibs.splice(insertIdx, 0, moved)
  const n = sibs.length
  const zmap = new Map(sibs.map((s, i) => [s.id, n - 1 - i]))   // first (front) → highest z
  return els.map(e => zmap.has(e.id) ? { ...(e.id === dragId ? moved : e), zIndex: zmap.get(e.id)! } as VectorElement : e)
}

// One-time migration: legacy flat `groupId` → a `group` element per distinct id.
function migrateGroups(pd: VectorPageData): VectorPageData {
  const legacy = pd.elements.filter(e => (e as { groupId?: string }).groupId != null)
  if (!legacy.length) return pd
  const groups = new Map<string, GroupElement>()
  let z = pd.elements.length
  const elements = pd.elements.map(e => {
    const gid = (e as { groupId?: string }).groupId
    const { groupId: _g, ...rest } = e as VectorElement & { groupId?: string }
    if (gid == null) return rest as VectorElement
    if (!groups.has(gid)) {
      groups.set(gid, {
        id: gid, type: 'group', name: 'Groupe', x: 0, y: 0, w: 0, h: 0,
        rotation: 0, visible: true, locked: false, opacity: 100, zIndex: z++,
        fill: { type: 'none' }, stroke: null, parentId: null,
      })
    }
    return { ...rest, parentId: gid } as VectorElement
  })
  return { ...pd, elements: [...elements, ...groups.values()] }
}
// ── Snapping ─────────────────────────────────────────────────────────────────
const SNAP_PX = 6   // snap threshold in screen pixels
// Candidate snap coordinates: every other element's edges/centre, the artboards,
// and the user guides.
function snapTargets(pd: VectorPageData, exclude: Set<string>): { xs: number[]; ys: number[] } {
  const xs: number[] = [], ys: number[] = []
  for (const ab of pd.artboards) {
    xs.push(ab.x, ab.x + ab.width / 2, ab.x + ab.width)
    ys.push(ab.y, ab.y + ab.height / 2, ab.y + ab.height)
  }
  for (const el of pd.elements) {
    if (exclude.has(el.id) || !el.visible || el.type === 'group') continue
    const b = elBBox(el)
    xs.push(b.x, b.x + b.w / 2, b.x + b.w)
    ys.push(b.y, b.y + b.h / 2, b.y + b.h)
  }
  for (const g of pd.guides) (g.type === 'v' ? xs : ys).push(g.position)
  return { xs, ys }
}
// Best alignment of any of `positions` to any `target` within `thr`.
function bestSnap(positions: number[], targets: number[], thr: number): { delta: number; target: number } | null {
  let best: { delta: number; target: number } | null = null
  for (const p of positions) {
    for (const tgt of targets) {
      const d = tgt - p
      if (Math.abs(d) <= thr && (!best || Math.abs(d) < Math.abs(best.delta))) best = { delta: d, target: tgt }
    }
  }
  return best
}

// ── Gradient on-canvas editing ───────────────────────────────────────────────
// Endpoints of the gradient line in world coords — mirrors the renderer's extent
// so the handles sit exactly where the gradient is painted.
function gradientLine(el: VectorElement): { sx: number; sy: number; ex: number; ey: number; cx: number; cy: number } | null {
  const f = el.fill
  if (f.type !== 'linear-gradient' && f.type !== 'radial-gradient') return null
  const b = elBBox(el)
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2
  const ang = ((f.angle ?? 0) * Math.PI) / 180
  const dx = Math.cos(ang), dy = Math.sin(ang)
  if (f.type === 'radial-gradient') {
    const r = Math.max(b.w, b.h) / 2
    return { sx: cx, sy: cy, ex: cx + dx * r, ey: cy + dy * r, cx, cy }
  }
  const half = (Math.abs(dx) * b.w + Math.abs(dy) * b.h) / 2
  return { sx: cx - dx * half, sy: cy - dy * half, ex: cx + dx * half, ey: cy + dy * half, cx, cy }
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

// ── Pathfinder & path geometry (boolean ops, simplify, smooth, outline, offset) ──
// Vectors are flattened to polygons (rings of [x,y]), processed with the robust
// `polygon-clipping` library, then rebuilt as a PathElement. Bézier curvature is
// approximated by line sampling — the result is an editable polygonal path.
type PCRing = [number, number][]
type PCPoly = PCRing[]
type PCMulti = PCPoly[]

// Apply an element's own rotation (around its bbox centre) to a world point —
// matches the transform used by the renderer/fill, so geometry is baked true.
function bakeRotation(el: VectorElement, x: number, y: number): [number, number] {
  if (!el.rotation) return [x, y]
  const cx = el.x + el.w / 2, cy = el.y + el.h / 2
  const a = (el.rotation * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a)
  const dx = x - cx, dy = y - cy
  return [cx + c * dx - s * dy, cy + s * dx + c * dy]
}

// Sample the cubic from anchor `a` to anchor `b` (excludes a, includes b).
function sampleCubic(a: PathPoint, b: PathPoint, steps: number): [number, number][] {
  const out: [number, number][] = []
  // Straight segment when neither side carries a handle — keep it crisp (1 step).
  const curved = a.hOut || b.hIn
  const n = curved ? Math.max(2, steps) : 1
  for (let s = 1; s <= n; s++) {
    const p = cubicAt(a, b, s / n)
    out.push([p.x, p.y])
  }
  return out
}

// Flatten an element into one or more closed polygon rings (true world coords).
function elementToRings(el: VectorElement, steps = 20): PCRing[] {
  if (el.type === 'text' || el.type === 'group') return []
  const pe = el.type === 'path' ? (el as PathElement) : toPathElement(el)
  const pts = pe.points
  if (pts.length < 2) return []
  // Split on `move` markers into independent subpaths (compound path).
  const subs: PathPoint[][] = []
  let cur: PathPoint[] = []
  pts.forEach((p, i) => { if (p.move && i > 0) { subs.push(cur); cur = [] } cur.push(p) })
  if (cur.length) subs.push(cur)
  const rings: PCRing[] = []
  for (const sub of subs) {
    if (sub.length < 2) continue
    const ring: PCRing = [bakeRotation(el, sub[0].x, sub[0].y)]
    for (let i = 0; i < sub.length; i++) {
      const a = sub[i], b = sub[(i + 1) % sub.length]   // closing segment wraps to start
      for (const [x, y] of sampleCubic(a, b, steps)) ring.push(bakeRotation(el, x, y))
    }
    rings.push(ring)
  }
  return rings
}

// MultiPolygon → flat PathPoints (corner nodes), one subpath per ring.
function multiToPathPoints(multi: PCMulti): PathPoint[] {
  const out: PathPoint[] = []
  for (const poly of multi) {
    for (const ring of poly) {
      if (ring.length < 4) continue
      // Drop the duplicated closing vertex (polygon-clipping returns closed rings).
      const last = ring.length - 1
      const closed = ring[0][0] === ring[last][0] && ring[0][1] === ring[last][1]
      const r = closed ? ring.slice(0, -1) : ring
      const startIdx = out.length
      r.forEach((pt, i) => out.push({ x: pt[0], y: pt[1], move: i === 0 && startIdx > 0 ? true : undefined }))
    }
  }
  return out
}

// Build a PathElement from rings, inheriting style/name from `base`.
function pathFromMulti(multi: PCMulti, base: VectorElement, name: string): PathElement | null {
  const points = multiToPathPoints(multi)
  if (points.length < 2) return null
  const xs = points.map(p => p.x), ys = points.map(p => p.y)
  const nx = Math.min(...xs), ny = Math.min(...ys)
  const stroke = base.stroke ? structuredClone(base.stroke) : null
  return {
    id: newId(), type: 'path', name,
    x: nx, y: ny, w: Math.max(...xs) - nx || 1, h: Math.max(...ys) - ny || 1,
    rotation: 0, visible: true, locked: false, opacity: base.opacity,
    zIndex: base.zIndex,
    fill: structuredClone(base.fill), stroke,
    points, closed: true,
  }
}

type BoolOp = 'union' | 'subtract' | 'intersect' | 'exclude'

// Combine elements (ordered bottom→top) with a boolean operation.
function booleanCombine(els: VectorElement[], op: BoolOp): PCMulti | null {
  const geoms = els.map(e => elementToRings(e)).filter(r => r.length > 0) as PCPoly[]
  if (geoms.length < 2) return null
  try {
    if (op === 'union')     return polygonClipping.union(geoms[0], ...geoms.slice(1))
    if (op === 'intersect') return polygonClipping.intersection(geoms[0], ...geoms.slice(1))
    if (op === 'subtract')  return polygonClipping.difference(geoms[0], ...geoms.slice(1))
    return polygonClipping.xor(geoms[0], ...geoms.slice(1))
  } catch { return null }
}

// Ramer–Douglas–Peucker: drop anchors that lie within `eps` of the chord between
// their kept neighbours. Honours subpaths (`move`) and the closed wrap.
function rdpIndices(pts: { x: number; y: number }[], eps: number): number[] {
  if (pts.length < 3) return pts.map((_, i) => i)
  const keep = new Set<number>([0, pts.length - 1])
  const stack: [number, number][] = [[0, pts.length - 1]]
  while (stack.length) {
    const [lo, hi] = stack.pop()!
    if (hi - lo < 2) continue
    const a = pts[lo], b = pts[hi]
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1
    let far = -1, fd = eps
    for (let i = lo + 1; i < hi; i++) {
      const d = Math.abs((pts[i].x - a.x) * dy - (pts[i].y - a.y) * dx) / len
      if (d > fd) { fd = d; far = i }
    }
    if (far !== -1) { keep.add(far); stack.push([lo, far], [far, hi]) }
  }
  return [...keep].sort((p, q) => p - q)
}
function simplifyPath(pe: PathElement, eps: number): PathElement {
  // Operate per-subpath so compound paths keep their holes.
  const pts = pe.points
  const subs: { start: number; arr: PathPoint[] }[] = []
  let cur: PathPoint[] = []; let start = 0
  pts.forEach((p, i) => { if (p.move && i > 0) { subs.push({ start, arr: cur }); cur = []; start = i } cur.push(p) })
  if (cur.length) subs.push({ start, arr: cur })
  const next: PathPoint[] = []
  for (const { arr } of subs) {
    const keep = rdpIndices(arr, eps)
    keep.forEach((idx, k) => {
      const p = arr[idx]
      // Kept anchors lose handles (simplification → corner nodes).
      next.push({ x: p.x, y: p.y, move: k === 0 && next.length > 0 ? true : undefined })
    })
  }
  const xs = next.map(p => p.x), ys = next.map(p => p.y)
  const nx = Math.min(...xs), ny = Math.min(...ys)
  return { ...pe, points: next, x: nx, y: ny, w: Math.max(...xs) - nx || 1, h: Math.max(...ys) - ny || 1 }
}

// Smooth: give every anchor symmetric handles derived from its neighbours
// (Catmull-Rom-style), turning a polygonal path into a flowing curve.
function smoothPath(pe: PathElement, amount = 0.2): PathElement {
  const pts = pe.points
  const subs: number[][] = []
  let cur: number[] = []
  pts.forEach((p, i) => { if (p.move && i > 0) { subs.push(cur); cur = [] } cur.push(i) })
  if (cur.length) subs.push(cur)
  const next = pts.map(p => ({ ...p }))
  for (const idxs of subs) {
    const n = idxs.length
    if (n < 3) continue
    for (let k = 0; k < n; k++) {
      const p = next[idxs[k]]
      const prev = pts[idxs[(k - 1 + n) % n]], nxt = pts[idxs[(k + 1) % n]]
      const tx = (nxt.x - prev.x) * amount, ty = (nxt.y - prev.y) * amount
      p.hIn = [-tx, -ty]; p.hOut = [tx, ty]
    }
  }
  return { ...pe, points: next }
}

// Outline a stroke into a filled path: union of per-segment quads + round joins,
// then subtract the inner area for unfilled closed shapes. Width in world units.
function outlineStroke(el: VectorElement, steps = 16): PCMulti | null {
  const stroke = el.stroke
  if (!stroke || stroke.width <= 0) return null
  const hw = stroke.width / 2
  const rings = elementToRings(el, steps)
  if (!rings.length) return null
  const parts: PCPoly[] = []
  // Approximate a disc by an octagon scaled to the half-width (round joins/caps).
  const disc = (cx: number, cy: number): PCRing => {
    const r: PCRing = []
    for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; r.push([cx + Math.cos(a) * hw, cy + Math.sin(a) * hw]) }
    r.push(r[0]); return r
  }
  for (const ring of rings) {
    for (let i = 0; i < ring.length - 1; i++) {
      const [ax, ay] = ring[i], [bx, by] = ring[i + 1]
      const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy)
      if (len < 1e-6) continue
      const nx = (-dy / len) * hw, ny = (dx / len) * hw
      const quad: PCRing = [
        [ax + nx, ay + ny], [bx + nx, by + ny],
        [bx - nx, by - ny], [ax - nx, ay - ny], [ax + nx, ay + ny],
      ]
      parts.push([quad])
      parts.push([disc(ax, ay)])
    }
    parts.push([disc(ring[ring.length - 1][0], ring[ring.length - 1][1])])
  }
  if (!parts.length) return null
  try { return polygonClipping.union(parts[0], ...parts.slice(1)) } catch { return null }
}

// Offset a closed path outward (d>0) / inward (d<0). Naively offsets each vertex
// along its bisector normal, then re-unions to clean self-intersections.
function offsetPath(el: VectorElement, d: number, steps = 20): PCMulti | null {
  const rings = elementToRings(el, steps)
  if (!rings.length) return null
  const out: PCPoly[] = []
  for (const ring of rings) {
    const r = ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring
    const n = r.length
    if (n < 3) continue
    // Outward direction depends on winding (signed area).
    let area = 0
    for (let i = 0; i < n; i++) { const [x1, y1] = r[i], [x2, y2] = r[(i + 1) % n]; area += x1 * y2 - x2 * y1 }
    const sign = area > 0 ? 1 : -1
    const offset: PCRing = []
    for (let i = 0; i < n; i++) {
      const [px, py] = r[(i - 1 + n) % n], [cx, cy] = r[i], [nx2, ny2] = r[(i + 1) % n]
      const e1x = cx - px, e1y = cy - py, e2x = nx2 - cx, e2y = ny2 - cy
      const l1 = Math.hypot(e1x, e1y) || 1, l2 = Math.hypot(e2x, e2y) || 1
      // Edge normals (outward), averaged into a vertex normal.
      const n1x = -e1y / l1 * sign, n1y = e1x / l1 * sign
      const n2x = -e2y / l2 * sign, n2y = e2x / l2 * sign
      let bx = n1x + n2x, by = n1y + n2y
      const bl = Math.hypot(bx, by) || 1
      bx /= bl; by /= bl
      // Miter length compensation.
      const cos = Math.max(0.3, n1x * bx + n1y * by)
      offset.push([cx + bx * d / cos, cy + by * d / cos])
    }
    offset.push(offset[0])
    out.push([offset])
  }
  if (!out.length) return null
  try { return polygonClipping.union(out[0], ...out.slice(1)) } catch { return null }
}

// ── Main editor component ──────────────────────────────────────────────────────
// Embedded mode: the SAME editor mounted inside another app (e.g. Keyframe draws a
// cel with the real Apex engine). Server loading/saving is bypassed — the scene is
// seeded from memory and every edit is reported through onCommit — so any feature
// added to Apex is instantly available here too.
export interface ApexEmbed {
  width:       number
  height:      number
  initialData: VectorPageData | null
  onCommit:    (data: VectorPageData) => void
  onClose:     () => void
  title?:      string
}

export default function ApexEditorPage({ embed }: { embed?: ApexEmbed } = {}) {
  const embedded = !!embed
  const { t } = useTranslation('paintsharp')
  const { id: routeId } = useParams<{ id: string }>()
  const projectId = embedded ? undefined : routeId
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
    if (embedded) {
      if (dirtyRef.current) { dirtyRef.current = false; embed!.onCommit(savePageDataRef.current) }
      return
    }
    if (dirtyRef.current && projectId && pageIdRef.current) {
      dirtyRef.current = false
      apexApi.savePage(projectId, pageIdRef.current, savePageDataRef.current).catch(() => {})
    }
  }, [projectId, embedded]) // eslint-disable-line react-hooks/exhaustive-deps
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

  // Embedded: seed the scene from memory once (no server page to load).
  useEffect(() => {
    if (!embedded) return
    const data = embed!.initialData ?? {
      artboards: [{ id: newId(), name: 'Frame', x: 0, y: 0, width: embed!.width, height: embed!.height, background: 'transparent' }],
      elements: [], guides: [],
    }
    skipSaveRef.current = true
    setPageData(data)
    centeredRef.current = false
    setTimeout(() => { centerArtboard(data); centeredRef.current = true }, 30)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (embedded || !pagesRes?.pages?.length || !projectId) return
    const pages = pagesRes.pages
    const page  = pages[Math.min(currentPageIdx, pages.length - 1)]
    if (!page) return
    flushSave()                    // sauve la page précédente avant d'en changer
    setPageId(page.id)
    pageIdRef.current = page.id
    centeredRef.current = false
    apexApi.getPage(projectId, page.id).then(r => {
      const data = migrateGroups(r.data.data ?? makePage1())
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
    type:       'pan' | 'move' | 'create' | 'resize' | 'rotate' | 'marquee' | 'node' | 'viewrotate' | 'gradient'
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
    gradHandle?: 'start' | 'end' | number   // gradient editing: endpoint or stop index
  } | null>(null)
  const [nodeSel, setNodeSel] = useState<number | null>(null)
  const nodeSelRef = useRef<number | null>(null)
  useEffect(() => { nodeSelRef.current = nodeSel }, [nodeSel])
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const marqueeRef = useRef<{ x: number; y: number } | null>(null)            // marquee origin
  const marqueeRectRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null)

  // ── Magnétisme & repères intelligents ───────────────────────────────────────
  const [snapOn, setSnapOn]   = useState(true)        // smart snapping (objects/artboard/guides)
  const [gridOn, setGridOn]   = useState(false)       // grid overlay + grid snapping
  const gridSize              = 20
  const snapOnRef = useRef(snapOn); useEffect(() => { snapOnRef.current = snapOn }, [snapOn])
  const gridOnRef = useRef(gridOn); useEffect(() => { gridOnRef.current = gridOn }, [gridOn])
  // Active smart-guide lines (world coords) drawn while dragging.
  const [guides, setGuides] = useState<{ vx: number[]; hy: number[] }>({ vx: [], hy: [] })

  // ── Layers panel UI state ────────────────────────────────────────────────────
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const [dndTarget, setDndTarget] = useState<{ id: string; zone: 'before' | 'after' | 'inside' } | null>(null)
  const dndDragId = useRef<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')

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
    setPageData(prev => {
      // Deleting a group removes its whole subtree; then prune any emptied groups.
      const kill = new Set(sel)
      for (const id of sel) { const el = prev.elements.find(e => e.id === id); if (el?.type === 'group') descendantIds(prev.elements, id).forEach(d => kill.add(d)) }
      return { ...prev, elements: pruneEmptyGroups(prev.elements.filter(e => !kill.has(e.id))) }
    })
    setSelectedIds([])
  }, [pushHistory])
  const selectAll = useCallback(() => {
    const els = pageDataRef.current.elements
    setSelectedIds(els.filter(e => e.type !== 'group' && !effHidden(els, e) && !effLocked(els, e)).map(e => e.id))
  }, [])
  const cutSel = useCallback(() => { copySel(); deleteSel() }, [copySel, deleteSel])

  // ── Grouping ─────────────────────────────────────────────────────────────────
  // Wrap the selected elements into a new `group` container (nestable).
  const groupSel = useCallback(() => {
    const sel = selectedIdsRef.current
    if (sel.length < 2) return
    pushHistory()
    const gid = `g-${newId()}`
    setPageData(prev => {
      const chosen = prev.elements.filter(e => sel.includes(e.id))
      if (chosen.length < 2) return prev
      const parents = new Set(chosen.map(c => c.parentId ?? null))
      const parentId = parents.size === 1 ? [...parents][0] : null
      const group: GroupElement = {
        id: gid, type: 'group', name: t('apex_group_name'),
        x: 0, y: 0, w: 0, h: 0, rotation: 0, visible: true, locked: false,
        opacity: 100, zIndex: Math.max(...chosen.map(c => c.zIndex)),
        fill: { type: 'none' }, stroke: null, parentId, collapsed: false,
      }
      return { ...prev, elements: [...prev.elements.map(el => sel.includes(el.id) ? { ...el, parentId: gid } as VectorElement : el), group] }
    })
  }, [pushHistory, t])
  // Dissolve the parent group(s) of the selection, reparenting children upward.
  const ungroupSel = useCallback(() => {
    const sel = selectedIdsRef.current
    if (!sel.length) return
    pushHistory()
    setPageData(prev => {
      const chosen = prev.elements.filter(e => sel.includes(e.id))
      // Groups to dissolve: selected groups themselves + immediate parents of selected leaves.
      const dissolve = new Set<string>()
      for (const c of chosen) {
        if (c.type === 'group') dissolve.add(c.id)
        else if (c.parentId) dissolve.add(c.parentId)
      }
      if (!dissolve.size) return prev
      const grandparent = new Map<string, string | null>()
      for (const id of dissolve) grandparent.set(id, prev.elements.find(g => g.id === id)?.parentId ?? null)
      const elements = prev.elements
        .filter(e => !dissolve.has(e.id))
        .map(e => e.parentId && dissolve.has(e.parentId) ? { ...e, parentId: grandparent.get(e.parentId) ?? null } as VectorElement : e)
      return { ...prev, elements }
    })
  }, [pushHistory])

  // ── Layers panel actions ─────────────────────────────────────────────────────
  // Reparent / reorder via drag-and-drop in the layers tree.
  const reparent = useCallback((dragId: string, targetId: string, zone: 'before' | 'after' | 'inside') => {
    pushHistory()
    setPageData(prev => ({ ...prev, elements: moveElement(prev.elements, dragId, targetId, zone) }))
  }, [pushHistory])
  // Inline rename of any layer / group.
  const renameEl = useCallback((id: string, name: string) => {
    setPageData(prev => ({ ...prev, elements: prev.elements.map(e => e.id === id ? { ...e, name } as VectorElement : e) }))
  }, [])
  // New empty folder (group), or wrap the current selection when ≥ 2 are selected.
  const newFolder = useCallback(() => {
    const sel = selectedIdsRef.current
    if (sel.length >= 2) { groupSel(); return }
    pushHistory()
    setPageData(prev => {
      const sole = prev.elements.find(e => e.id === sel[0])
      const parentId = sole?.parentId ?? null
      const group: GroupElement = {
        id: `g-${newId()}`, type: 'group', name: t('apex_group_name'),
        x: 0, y: 0, w: 0, h: 0, rotation: 0, visible: true, locked: false,
        opacity: 100, zIndex: prev.elements.length, fill: { type: 'none' }, stroke: null,
        parentId, collapsed: false,
      }
      return { ...prev, elements: [...prev.elements, group] }
    })
  }, [pushHistory, t, groupSel])
  // Select from the layers panel: a group selects its leaf descendants.
  const selectFromPanel = useCallback((id: string, additive: boolean) => {
    const els = pageDataRef.current.elements
    const el = els.find(e => e.id === id)
    const ids = el?.type === 'group' ? descendantLeaves(els, id).map(e => e.id) : [id]
    setSelectedIds(prev => additive ? Array.from(new Set([...prev, ...ids])) : ids)
    setNodeSel(null)
  }, [])
  const toggleCollapse = useCallback((id: string) => {
    setCollapsedGroups(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }, [])

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
    const chosen = pageDataRef.current.elements.filter(e => sel.includes(e.id) && e.type !== 'text' && e.type !== 'group')
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

  // ── Pathfinder : opérations booléennes sur les objets sélectionnés ──────────
  const pathfinder = useCallback((op: BoolOp) => {
    const sel = selectedIdsRef.current
    const chosen = pageDataRef.current.elements
      .filter(e => sel.includes(e.id) && e.type !== 'text' && e.type !== 'group')
      .sort((a, b) => a.zIndex - b.zIndex)   // bottom → top (subtract = bottom minus rest)
    if (chosen.length < 2) return
    const multi = booleanCombine(chosen, op)
    if (!multi || !multi.length) return
    const top = chosen[chosen.length - 1]   // inherit appearance from the top object
    const name = t(`apex_pf_${op}` as 'apex_pf_union')
    const result = pathFromMulti(multi, top, name)
    if (!result) return
    pushHistory()
    const keptIds = new Set(chosen.map(c => c.id))
    setPageData(prev => ({ ...prev, elements: [...prev.elements.filter(e => !keptIds.has(e.id)), result] }))
    setSelectedIds([result.id])
    setNodeSel(null)
  }, [pushHistory, t])

  // ── Opérations de chemin (objet unique) ─────────────────────────────────────
  const simplifySel = useCallback((eps = 2) => {
    const sel = selectedIdsRef.current
    const el = pageDataRef.current.elements.find(e => e.id === sel[0])
    if (sel.length !== 1 || !el || el.type !== 'path') return
    pushHistory()
    const simplified = simplifyPath(el as PathElement, eps)
    setPageData(prev => ({ ...prev, elements: prev.elements.map(e => e.id === el.id ? simplified : e) }))
  }, [pushHistory])

  const smoothSel = useCallback(() => {
    const sel = selectedIdsRef.current
    const el = pageDataRef.current.elements.find(e => e.id === sel[0])
    if (sel.length !== 1 || !el || el.type !== 'path') return
    pushHistory()
    const smoothed = smoothPath(el as PathElement)
    setPageData(prev => ({ ...prev, elements: prev.elements.map(e => e.id === el.id ? smoothed : e) }))
  }, [pushHistory])

  const outlineStrokeSel = useCallback(() => {
    const sel = selectedIdsRef.current
    const el = pageDataRef.current.elements.find(e => e.id === sel[0])
    if (sel.length !== 1 || !el || !el.stroke || el.stroke.width <= 0) return
    const multi = outlineStroke(el)
    if (!multi || !multi.length) return
    // Le contour vectorisé prend la couleur du trait, sans contour propre.
    const base = { ...el, fill: { type: 'solid' as const, color: el.stroke.color, opacity: el.stroke.opacity }, stroke: null }
    const result = pathFromMulti(multi, base, t('apex_path_outline'))
    if (!result) return
    pushHistory()
    setPageData(prev => ({ ...prev, elements: prev.elements.map(e => e.id === el.id ? result : e) }))
    setSelectedIds([result.id])
  }, [pushHistory, t])

  const offsetSel = useCallback((d: number) => {
    const sel = selectedIdsRef.current
    const el = pageDataRef.current.elements.find(e => e.id === sel[0])
    if (sel.length !== 1 || !el || el.type === 'text' || d === 0) return
    const multi = offsetPath(el, d)
    if (!multi || !multi.length) return
    const result = pathFromMulti(multi, el, el.name)
    if (!result) return
    pushHistory()
    result.zIndex = el.zIndex
    setPageData(prev => ({ ...prev, elements: prev.elements.map(e => e.id === el.id ? result : e) }))
    setSelectedIds([result.id])
  }, [pushHistory])

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
        ...(hit.parentId != null ? [{ label: t('apex_ungroup'), onClick: ungroupSel, shortcut: 'Ctrl+Shift+G' } as CtxItem] : []),
        ...(hit.type === 'rect' || hit.type === 'ellipse' || (hit.type === 'path' && (hit as PathElement).shape)
          ? [{ label: t('apex_convert_to_path'), onClick: convertToPath } as CtxItem] : []),
        ...(multi ? [{ label: t('apex_merge'), onClick: mergeSel } as CtxItem] : []),
        ...(multi ? [
          'sep' as CtxItem,
          { label: t('apex_pf_union'),     onClick: () => pathfinder('union') } as CtxItem,
          { label: t('apex_pf_subtract'),  onClick: () => pathfinder('subtract') } as CtxItem,
          { label: t('apex_pf_intersect'), onClick: () => pathfinder('intersect') } as CtxItem,
          { label: t('apex_pf_exclude'),   onClick: () => pathfinder('exclude') } as CtxItem,
        ] : []),
        ...(!multi && hit.type === 'path' ? [
          'sep' as CtxItem,
          { label: t('apex_path_simplify'), onClick: () => simplifySel() } as CtxItem,
          { label: t('apex_path_smooth'),   onClick: smoothSel } as CtxItem,
        ] : []),
        ...(!multi && hit.stroke && hit.stroke.width > 0
          ? [{ label: t('apex_path_outline'), onClick: outlineStrokeSel } as CtxItem] : []),
        ...(multi ? [
          'sep' as CtxItem,
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
  }, [ctx, t, undo, cutSel, copySel, pasteSel, duplicateSel, reorder, flip, align, deleteSel, selectAll, groupSel, ungroupSel, convertToPath, mergeSel, pathfinder, simplifySel, smoothSel, outlineStrokeSel])

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
    renderCanvas(ctx, w, h, pageData, cs, tool === 'node' ? [] : selectedIds, dpr, marquee, guides, { size: gridSize, on: gridOn })
    const pen = penRef.current
    if (pen && pen.points.length > 0) drawPenOverlay(ctx, pen, cs, dpr)
    if (tool === 'node' && selectedIds.length === 1) {
      const pe = pageData.elements.find(el => el.id === selectedIds[0])
      if (pe && pe.type === 'path') renderNodeOverlay(ctx, pe as PathElement, cs, dpr, nodeSel)
    }
    if (tool === 'select' && selectedIds.length === 1) {
      const ge = pageData.elements.find(el => el.id === selectedIds[0])
      if (ge && (ge.fill.type === 'linear-gradient' || ge.fill.type === 'radial-gradient')) drawGradientOverlay(ctx, ge, cs, dpr)
    }
  }, [pageData, cs, selectedIds, marquee, tool, nodeSel, guides, gridOn])

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
      // Gradient handles take priority (single selection, gradient fill).
      if (sel.length === 1) {
        const el = pd.elements.find(x => x.id === sel[0])
        if (el && (el.fill.type === 'linear-gradient' || el.fill.type === 'radial-gradient')) {
          const gl = gradientLine(el)!
          const tol = 8 / cs_.zoom
          const stops = el.fill.stops
          for (let i = 0; i < stops.length; i++) {
            const px = gl.sx + (gl.ex - gl.sx) * stops[i].position
            const py = gl.sy + (gl.ey - gl.sy) * stops[i].position
            if (Math.hypot(pt.x - px, pt.y - py) <= tol) {
              pushHistory()
              dragRef.current = { type: 'gradient', startX: e.clientX, startY: e.clientY, canvasX: pt.x, canvasY: pt.y, snapshot: { ...el }, gradHandle: i, moved: false }
              return
            }
          }
          if (Math.hypot(pt.x - gl.ex, pt.y - gl.ey) <= tol) {
            pushHistory()
            dragRef.current = { type: 'gradient', startX: e.clientX, startY: e.clientY, canvasX: pt.x, canvasY: pt.y, snapshot: { ...el }, gradHandle: 'end', moved: false }
            return
          }
          if (el.fill.type === 'linear-gradient' && Math.hypot(pt.x - gl.sx, pt.y - gl.sy) <= tol) {
            pushHistory()
            dragRef.current = { type: 'gradient', startX: e.clientX, startY: e.clientY, canvasX: pt.x, canvasY: pt.y, snapshot: { ...el }, gradHandle: 'start', moved: false }
            return
          }
        }
      }
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
      const sorted = renderOrder(pd.elements).map(o => o.el).reverse()   // top-most first
      const hit = sorted.find(el => !effLocked(pd.elements, el) && hitTest(el, pt.x, pt.y))
      // Clicking a grouped object selects all leaves of its top-most ancestor group.
      const groupMates = (id: string) => {
        const top = topAncestorGroup(pd.elements, id)
        return top ? descendantLeaves(pd.elements, top).map(e => e.id) : [id]
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
    if (drag.type === 'gradient' && drag.snapshot) {
      const snap = drag.snapshot
      const gl = gradientLine(snap)
      if (!gl) return
      const ptw = toCanvas(e, rect, cs_)
      const id = snap.id
      drag.moved = true
      setPageData(prev => ({ ...prev, elements: prev.elements.map(el => {
        if (el.id !== id) return el
        const f = el.fill
        if (f.type !== 'linear-gradient' && f.type !== 'radial-gradient') return el
        if (drag.gradHandle === 'end' || drag.gradHandle === 'start') {
          let ang = Math.atan2(ptw.y - gl.cy, ptw.x - gl.cx) * 180 / Math.PI
          if (drag.gradHandle === 'start') ang += 180
          if (e.shiftKey) ang = Math.round(ang / 15) * 15
          return { ...el, fill: { ...f, angle: Math.round(ang) } } as VectorElement
        }
        const idx = drag.gradHandle as number
        const vx = gl.ex - gl.sx, vy = gl.ey - gl.sy
        const len2 = vx * vx + vy * vy || 1
        let tpos = ((ptw.x - gl.sx) * vx + (ptw.y - gl.sy) * vy) / len2
        tpos = Math.max(0, Math.min(1, tpos))
        const stops = f.stops.map((s, i) => i === idx ? { ...s, position: tpos } : s)
        return { ...el, fill: { ...f, stops } } as VectorElement
      }) }))
      return
    }
    if (drag.type === 'move' && drag.moves) {
      const moves = drag.moves
      let ndx = dx, ndy = dy
      const vx: number[] = [], hy: number[] = []
      const base = selBBox(moves)
      if (base && !e.altKey) {
        if (snapOnRef.current) {
          const exclude = new Set(moves.map(m => m.id))
          const tg = snapTargets(pageDataRef.current, exclude)
          const thr = SNAP_PX / cs_.zoom
          const mx = base.x + dx, my = base.y + dy
          const sx = bestSnap([mx, mx + base.w / 2, mx + base.w], tg.xs, thr)
          const sy = bestSnap([my, my + base.h / 2, my + base.h], tg.ys, thr)
          if (sx) { ndx += sx.delta; vx.push(sx.target) }
          if (sy) { ndy += sy.delta; hy.push(sy.target) }
        }
        if (gridOnRef.current) {
          // Snap the top-left corner to the grid when no smart guide claimed the axis.
          if (!vx.length) ndx = Math.round((base.x + dx) / gridSize) * gridSize - base.x
          if (!hy.length) ndy = Math.round((base.y + dy) / gridSize) * gridSize - base.y
        }
      }
      setGuides({ vx, hy })
      setPageData(prev => ({ ...prev, elements: prev.elements.map(el => {
        const snap = moves.find(m => m.id === el.id)
        return snap ? translateEl(snap, ndx, ndy) : el
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
      const left = [0, 3, 5].includes(hi), right = [2, 4, 7].includes(hi)
      const top  = [0, 1, 2].includes(hi), bottom = [5, 6, 7].includes(hi)
      // Snap the dragged edge to nearby targets (object/artboard/guide alignment).
      let ndx = dx, ndy = dy
      const vx: number[] = [], hy: number[] = []
      if (snapOnRef.current && !e.altKey) {
        const tg = snapTargets(pageDataRef.current, new Set([snap.id]))
        const thr = SNAP_PX / cs_.zoom
        if (left)   { const s = bestSnap([snap.x + dx], tg.xs, thr); if (s) { ndx += s.delta; vx.push(s.target) } }
        if (right)  { const s = bestSnap([snap.x + snap.w + dx], tg.xs, thr); if (s) { ndx += s.delta; vx.push(s.target) } }
        if (top)    { const s = bestSnap([snap.y + dy], tg.ys, thr); if (s) { ndy += s.delta; hy.push(s.target) } }
        if (bottom) { const s = bestSnap([snap.y + snap.h + dy], tg.ys, thr); if (s) { ndy += s.delta; hy.push(s.target) } }
      }
      setGuides({ vx, hy })
      if (left)   { x = snap.x + ndx; w = snap.w - ndx }
      if (right)  { w = snap.w + ndx }
      if (top)    { y = snap.y + ndy; h = snap.h - ndy }
      if (bottom) { h = snap.h + ndy }
      if (w < 4) { if (left) x = snap.x + snap.w - 4; w = 4 }
      if (h < 4) { if (top)  y = snap.y + snap.h - 4; h = 4 }
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
        const els = pageDataRef.current.elements
        const hits = els
          .filter(el => el.type !== 'group' && !effHidden(els, el) && !effLocked(els, el) && inside(elBBox(el)))
          // Expand each hit to its top-most group's leaves (marquee selects whole groups).
          .flatMap(el => { const top = topAncestorGroup(els, el.id); return top ? descendantLeaves(els, top).map(e => e.id) : [el.id] })
        setSelectedIds(prev => Array.from(new Set([...prev, ...hits])))
      }
    } else if (drag && !drag.moved && (drag.type === 'create')) {
      // A click with the shape tool created a zero-size element → drop it.
      const nid = drag.newEl?.id
      if (nid) setPageData(prev => ({ ...prev, elements: prev.elements.filter(e => e.id !== nid) }))
    }
    setMarquee(null); marqueeRef.current = null; marqueeRectRef.current = null
    setGuides({ vx: [], hy: [] })
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

  if (!projectId && !embedded) return null

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

  // Pathfinder : opérations booléennes (≥ 2 objets non-texte sélectionnés).
  const selNonText = selectedIds
    .map(id => pageData.elements.find(e => e.id === id))
    .filter((e): e is VectorElement => !!e && e.type !== 'text' && e.type !== 'group')
  const pathfinderSection = selNonText.length >= 2 && (
    <PropSection title={t('apex_section_pathfinder')}>
      <div className="px-2 pb-2 grid grid-cols-4 gap-1">
        {([
          ['union',     t('apex_pf_union')],
          ['subtract',  t('apex_pf_subtract')],
          ['intersect', t('apex_pf_intersect')],
          ['exclude',   t('apex_pf_exclude')],
        ] as [BoolOp, string][]).map(([op, label]) => (
          <button key={op} title={label} onClick={() => pathfinder(op)}
            className="flex items-center justify-center rounded transition-colors hover:brightness-150"
            style={{ height: 30, background: '#2a2a2a' }}>
            <PathfinderGlyph op={op} />
          </button>
        ))}
      </div>
    </PropSection>
  )

  // Opérations de chemin (objet unique : path, ou tout objet avec contour).
  const soloEl = selectedIds.length === 1 ? pageData.elements.find(e => e.id === selectedIds[0]) ?? null : null
  const pathOpsSection = soloEl && soloEl.type !== 'text' && (
    <PropSection title={t('apex_section_pathops')}>
      <div className="px-2 pb-2 flex flex-col gap-1">
        {soloEl.type === 'path' && (
          <div className="flex gap-1">
            <button onClick={() => simplifySel()} className="flex-1 flex items-center justify-center gap-1.5 h-6 rounded text-[10px] hover:brightness-150" style={{ background: '#2a2a2a', color: C.text }}>
              <Waypoints size={11} /> {t('apex_path_simplify')}
            </button>
            <button onClick={() => smoothSel()} className="flex-1 flex items-center justify-center gap-1.5 h-6 rounded text-[10px] hover:brightness-150" style={{ background: '#2a2a2a', color: C.text }}>
              <Spline size={11} /> {t('apex_path_smooth')}
            </button>
          </div>
        )}
        {soloEl.stroke && soloEl.stroke.width > 0 && (
          <button onClick={outlineStrokeSel} className="flex items-center justify-center gap-1.5 h-6 rounded text-[10px] hover:brightness-150" style={{ background: '#2a2a2a', color: C.text }}>
            <PenTool size={11} /> {t('apex_path_outline')}
          </button>
        )}
        <div className="flex gap-1 items-center">
          <span className="text-[10px]" style={{ color: C.textDim }}>{t('apex_path_offset')}</span>
          <button onClick={() => offsetSel(5)} title={t('apex_path_offset_out')} className="flex-1 h-6 rounded text-[12px] hover:brightness-150" style={{ background: '#2a2a2a', color: C.text }}>＋</button>
          <button onClick={() => offsetSel(-5)} title={t('apex_path_offset_in')} className="flex-1 h-6 rounded text-[12px] hover:brightness-150" style={{ background: '#2a2a2a', color: C.text }}>－</button>
        </div>
      </div>
    </PropSection>
  )

  const apexPanels = {
    layers: { label: t('apex_layers'), render: () => {
      const els = pageData.elements
      const rows: React.ReactNode[] = []
      const build = (parentId: string, depth: number) => {
        // Front-most (highest z) first, matching the canvas stacking top-down.
        for (const el of childrenOf(els, parentId).slice().reverse()) {
          const isGroup = el.type === 'group'
          const leaves = isGroup ? descendantLeaves(els, el.id) : []
          const selected = isGroup
            ? leaves.length > 0 && leaves.every(l => selectedIds.includes(l.id))
            : selectedIds.includes(el.id)
          rows.push(
            <LayerRow
              key={el.id}
              el={el}
              depth={depth}
              selected={selected}
              isGroup={isGroup}
              collapsed={collapsedGroups.has(el.id)}
              renaming={renamingId === el.id}
              renameDraft={renameDraft}
              dnd={dndTarget?.id === el.id ? dndTarget.zone : null}
              onToggleCollapse={() => toggleCollapse(el.id)}
              onSelect={e => selectFromPanel(el.id, e.shiftKey || e.metaKey || e.ctrlKey)}
              onStartRename={() => { setRenamingId(el.id); setRenameDraft(el.name) }}
              onRenameDraft={setRenameDraft}
              onCommitRename={() => { if (renameDraft.trim()) renameEl(el.id, renameDraft.trim()); setRenamingId(null) }}
              onToggleVisible={() => updateEl(el.id, { visible: !el.visible }, setPageData)}
              onToggleLock={() => updateEl(el.id, { locked: !el.locked }, setPageData)}
              onDragStartRow={() => { dndDragId.current = el.id }}
              onDragOverRow={e => {
                e.preventDefault()
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                const rel = (e.clientY - r.top) / r.height
                const zone: 'before' | 'after' | 'inside' = isGroup
                  ? (rel < 0.3 ? 'before' : rel > 0.7 ? 'after' : 'inside')
                  : (rel < 0.5 ? 'before' : 'after')
                if (dndDragId.current && dndDragId.current !== el.id) setDndTarget({ id: el.id, zone })
              }}
              onDropRow={e => {
                e.preventDefault()
                const dragId = dndDragId.current
                if (dragId && dndTarget && dragId !== dndTarget.id) reparent(dragId, dndTarget.id, dndTarget.zone)
                setDndTarget(null); dndDragId.current = null
              }}
              onDragEndRow={() => { setDndTarget(null); dndDragId.current = null }}
            />,
          )
          if (isGroup && !collapsedGroups.has(el.id)) build(el.id, depth + 1)
        }
      }
      build(ROOT, 0)
      return (
        <div className="flex-1 overflow-y-auto flex flex-col">
          <div className="flex items-center gap-1 px-2 py-1 flex-shrink-0" style={{ borderBottom: `1px solid #2a2a2a` }}>
            <button title={t('apex_new_folder')} onClick={newFolder}
              className="flex items-center justify-center w-6 h-6 rounded hover:bg-white/10" style={{ color: C.textDim }}>
              <FolderPlus size={13} />
            </button>
            <button title={t('apex_group')} onClick={groupSel} disabled={selectedIds.length < 2}
              className="flex items-center justify-center w-6 h-6 rounded hover:bg-white/10 disabled:opacity-30" style={{ color: C.textDim }}>
              <Group size={13} />
            </button>
            <button title={t('apex_ungroup')} onClick={ungroupSel}
              className="flex items-center justify-center w-6 h-6 rounded hover:bg-white/10" style={{ color: C.textDim }}>
              <Ungroup size={13} />
            </button>
            <div style={{ flex: 1 }} />
            <button title={t('apex_delete_element')} onClick={deleteSel} disabled={!selectedIds.length}
              className="flex items-center justify-center w-6 h-6 rounded hover:bg-white/10 disabled:opacity-30" style={{ color: '#e07a7a' }}>
              <Trash2 size={13} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto"
            onDragOver={e => { if (dndDragId.current) e.preventDefault() }}>
            {rows}
            {els.length === 0 && (
              <p className="text-[10px] px-3 py-4" style={{ color: C.textDim }}>{t('apex_no_elements')}</p>
            )}
          </div>
        </div>
      )
    } },
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
              {pathOpsSection}
              {deleteSection}
            </>
          ) : selectedIds.length >= 2 ? (
            <>
              <div className="px-3 py-2 text-[11px] font-medium" style={{ color: C.text }}>
                {t('apex_n_selected', { count: selectedIds.length })}
              </div>
              {pathfinderSection}
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

  // Embedded inside another editor → swap the (non-nestable) WorkspaceShell for a
  // bare shell that takes the same props. All tools/panels stay identical.
  const Shell = (embedded ? EmbedShell : EditorShell) as typeof EditorShell

  return (
    <Shell theme={C}
      chromeless
      topbarHeight={64}
      onBack={embedded ? () => { flushSave(); embed!.onClose() } : () => { if (projectId && pageId) saveMut.mutate(pageData); navigate('/paintsharp/apex') }}
      title={embedded ? (embed!.title ?? 'Frame') : titleDraft}
      onTitleChange={embedded ? undefined : setTitleDraft}
      onTitleCommit={embedded ? undefined : commitTitle}
      titlePlaceholder={t('common_untitled', { defaultValue: 'Sans titre' })}
      saveStatus={embedded ? '' : (saveMut.isPending ? t('apex_saving') : t('doc_saved', { defaultValue: 'Enregistré' }))}
      subtitle="Apex"
      docInfo={pageData.artboards[0] ? `${pageData.artboards[0].width}×${pageData.artboards[0].height}` : undefined}
      titleActions={embedded ? undefined : (
        <button
          onClick={() => starMut.mutate(!project?.is_starred)}
          title={project?.is_starred ? t('apex_unstar', { defaultValue: 'Retirer des favoris' }) : t('apex_star', { defaultValue: 'Ajouter aux favoris' })}
          className="p-1.5 rounded hover:bg-white/10 flex-shrink-0 transition-colors"
          style={{ color: project?.is_starred ? '#f9ab00' : C.textDim }}>
          <Star size={15} fill={project?.is_starred ? 'currentColor' : 'none'} />
        </button>
      )}
      onDelete={embedded ? undefined : () => trashMut.mutate()}
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
        }, {
          label: t('apex_menu_path'),
          items: [
            { label: t('apex_pf_union'),     onClick: () => pathfinder('union') },
            { label: t('apex_pf_subtract'),  onClick: () => pathfinder('subtract') },
            { label: t('apex_pf_intersect'), onClick: () => pathfinder('intersect') },
            { label: t('apex_pf_exclude'),   onClick: () => pathfinder('exclude') },
            'sep',
            { label: t('apex_merge'),          onClick: mergeSel },
            { label: t('apex_path_simplify'),  onClick: () => simplifySel() },
            { label: t('apex_path_smooth'),    onClick: smoothSel },
            { label: t('apex_path_outline'),   onClick: outlineStrokeSel },
            'sep',
            { label: t('apex_path_offset_out'), onClick: () => offsetSel(5) },
            { label: t('apex_path_offset_in'),  onClick: () => offsetSel(-5) },
          ],
        }],
        onZoomIn:  () => setCs(prev => { const nz=Math.min(20,prev.zoom*1.2); const c=canvasRef.current; if(!c) return {...prev,zoom:nz}; const r=c.getBoundingClientRect(); return {zoom:nz,panX:r.width/2-(r.width/2-prev.panX)*(nz/prev.zoom),panY:r.height/2-(r.height/2-prev.panY)*(nz/prev.zoom)} }),
        onZoomOut: () => setCs(prev => { const nz=Math.max(0.02,prev.zoom*0.8); const c=canvasRef.current; if(!c) return {...prev,zoom:nz}; const r=c.getBoundingClientRect(); return {zoom:nz,panX:r.width/2-(r.width/2-prev.panX)*(nz/prev.zoom),panY:r.height/2-(r.height/2-prev.panY)*(nz/prev.zoom)} }),
        onFit:     () => centerArtboard(pageData),
        viewExtra: [
          { label: snapOn ? t('apex_snap_off') : t('apex_snap_on'), onClick: () => setSnapOn(v => !v) },
          { label: gridOn ? t('apex_grid_off') : t('apex_grid_on'), onClick: () => setGridOn(v => !v) },
          'sep',
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

          {/* Magnétisme & grille */}
          <div className="h-px w-full my-1.5" style={{ background: C.border }} />
          <div className="flex gap-0.5">
            <button title={t('apex_snap_toggle')} onClick={() => setSnapOn(v => !v)}
              className="w-8 h-7 rounded flex items-center justify-center transition-colors"
              style={{ background: snapOn ? C.accent + '30' : 'transparent', color: snapOn ? C.accent : C.textDim }}>
              <Magnet size={14} />
            </button>
            <button title={t('apex_grid_toggle')} onClick={() => setGridOn(v => !v)}
              className="w-8 h-7 rounded flex items-center justify-center transition-colors"
              style={{ background: gridOn ? C.accent + '30' : 'transparent', color: gridOn ? C.accent : C.textDim }}>
              <Grid3x3 size={14} />
            </button>
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
    </Shell>
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

// Illustrator-style boolean-op glyphs: two overlapping rounded squares, the
// resulting region shown filled in the module accent.
function PathfinderGlyph({ op }: { op: BoolOp }) {
  const A = '#888', B = SHELL_C.accent
  const r1 = { x: 2, y: 3, w: 9, h: 9 }
  const r2 = { x: 7, y: 6, w: 9, h: 9 }
  const rect = (r: { x:number;y:number;w:number;h:number }, fill: string, stroke = 'none', op2 = 1) =>
    <rect x={r.x} y={r.y} width={r.w} height={r.h} rx={1.5} fill={fill} stroke={stroke} strokeWidth={1} opacity={op2} />
  return (
    <svg width={18} height={18} viewBox="0 0 18 18">
      {op === 'union' && <>{rect(r1, B)}{rect(r2, B)}</>}
      {op === 'subtract' && <>{rect(r1, B)}{rect(r2, '#2a2a2a', A)}</>}
      {op === 'intersect' && <>
        <rect x={r1.x} y={r1.y} width={r1.w} height={r1.h} rx={1.5} fill="none" stroke={A} strokeWidth={1} />
        <rect x={r2.x} y={r2.y} width={r2.w} height={r2.h} rx={1.5} fill="none" stroke={A} strokeWidth={1} />
        <rect x={r2.x} y={r1.y} width={r1.x + r1.w - r2.x} height={r2.y + r2.h - r1.y} fill={B} />
      </>}
      {op === 'exclude' && <>{rect(r1, B, 'none', 0.55)}{rect(r2, B, 'none', 0.55)}
        <rect x={r2.x} y={r1.y} width={r1.x + r1.w - r2.x} height={r2.y + r2.h - r1.y} fill="#2a2a2a" />
      </>}
    </svg>
  )
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
  el, depth, selected, isGroup, collapsed, renaming, renameDraft, dnd,
  onToggleCollapse, onSelect, onStartRename, onRenameDraft, onCommitRename,
  onToggleVisible, onToggleLock,
  onDragStartRow, onDragOverRow, onDropRow, onDragEndRow,
}: {
  el: VectorElement; depth: number; selected: boolean; isGroup: boolean
  collapsed: boolean; renaming: boolean; renameDraft: string
  dnd: 'before' | 'after' | 'inside' | null
  onToggleCollapse: () => void
  onSelect: (e: React.MouseEvent) => void
  onStartRename: () => void; onRenameDraft: (v: string) => void; onCommitRename: () => void
  onToggleVisible: () => void; onToggleLock: () => void
  onDragStartRow: () => void
  onDragOverRow: (e: React.DragEvent) => void
  onDropRow: (e: React.DragEvent) => void
  onDragEndRow: () => void
}) {
  const Icon = isGroup ? (collapsed ? Folder : FolderOpen)
    : el.type === 'rect' ? Square
    : el.type === 'ellipse' ? Circle
    : el.type === 'path'    ? PenTool
    : Type

  return (
    <div
      draggable
      onDragStart={onDragStartRow}
      onDragOver={onDragOverRow}
      onDrop={onDropRow}
      onDragEnd={onDragEndRow}
      onClick={onSelect}
      onDoubleClick={e => { e.stopPropagation(); onStartRename() }}
      className="relative flex items-center pr-2 h-7 cursor-pointer group"
      style={{
        paddingLeft: 6 + depth * 13,
        background:   dnd === 'inside' ? '#e84a9030' : selected ? '#e84a9015' : 'transparent',
        borderBottom: `1px solid #2a2a2a`,
        color:        selected ? '#e84a90' : '#9e9e9e',
      }}
    >
      {/* Drop indicator (before/after) */}
      {(dnd === 'before' || dnd === 'after') && (
        <div className="absolute left-0 right-0 h-0.5 pointer-events-none" style={{ top: dnd === 'before' ? 0 : 'auto', bottom: dnd === 'after' ? 0 : 'auto', background: '#e84a90' }} />
      )}
      {isGroup
        ? <button onClick={e => { e.stopPropagation(); onToggleCollapse() }} className="w-4 flex-shrink-0 flex items-center justify-center">
            <ChevronRight size={11} style={{ transform: collapsed ? undefined : 'rotate(90deg)', transition: 'transform 0.1s' }} />
          </button>
        : <div className="w-4 flex-shrink-0 flex items-center justify-center opacity-30"><GripVertical size={11} /></div>}
      <Icon size={12} className="mx-1 flex-shrink-0" />
      {renaming
        ? <input
            autoFocus
            value={renameDraft}
            onChange={e => onRenameDraft(e.target.value)}
            onClick={e => e.stopPropagation()}
            onBlur={onCommitRename}
            onKeyDown={e => { if (e.key === 'Enter') onCommitRename(); if (e.key === 'Escape') onCommitRename() }}
            className="flex-1 text-[11px] px-1 py-0 rounded outline-none"
            style={{ background: '#1c1c1c', border: '1px solid #e84a90', color: '#fff' }}
          />
        : <span className="flex-1 text-[11px] truncate">{el.name}</span>}
      <div className="flex items-center gap-0.5">
        <button onClick={e => { e.stopPropagation(); onToggleVisible() }} className={`p-0.5 rounded ${el.visible ? 'opacity-0 group-hover:opacity-100' : ''}`}>
          {el.visible ? <Eye size={10} /> : <EyeOff size={10} style={{ opacity: 0.5 }} />}
        </button>
        <button onClick={e => { e.stopPropagation(); onToggleLock() }} className={`p-0.5 rounded ${el.locked ? '' : 'opacity-0 group-hover:opacity-100'}`}>
          {el.locked ? <Lock size={10} style={{ color: '#e84a90' }} /> : <Unlock size={10} />}
        </button>
      </div>
    </div>
  )
}
