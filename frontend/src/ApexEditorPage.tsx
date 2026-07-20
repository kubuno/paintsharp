import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
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
  Search, RotateCw, Magnet, Grid3x3, Pencil, Brush, Ruler,
  FolderPlus, Folder, FolderOpen, GripVertical,
  Squircle, Triangle, Diamond, Pentagon, Sun, Flower, ArrowRight, ArrowLeftRight,
  Disc, ChartPie, Rainbow, Moon, Cog, Cloud, MessageCircle, Droplet, Shell, Heart,
} from 'lucide-react'
import type { TFunction } from 'i18next'
import polygonClipping from 'polygon-clipping'
import { Dropdown, Checkbox, GradientField, RangeSlider, DEFAULT_GRADIENT, MenuDropdown, FontSizeField, type MenuDropdownPos, type Gradient } from '@ui'
import { apexApi, type VectorPageData, type VectorElement, type PathPoint, type PathElement, type TextElement, type GroupElement, type SymmetryElement, type RectElement, type FillStyle } from './api'
import { C as SHELL_C, EditorShell, DockArea, ColorField, paintsharpMenus, useContextMenu, type CtxItem, type PickerTool } from './ui'
import { EmbedShell } from './EmbedShell'
import { uid } from './uid'
import { copyKubunoData } from './kubunoData'
import { vectorsEnvelope } from './ApexVectorsCard'
import { StrokeStabilizer, fitFreehandPath, sampleWidths, brushRibbon, ribbonToPathPoints, type RawSample } from './apexFreehand'

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
type Tool = 'select' | 'node' | 'rect' | 'ellipse' | 'line' | 'shape' | 'text' | 'hand' | 'pen' | 'pencil' | 'brush' | 'eyedropper' | 'zoom' | 'rotateview'

interface CanvasState { zoom: number; panX: number; panY: number; rot?: number }

interface PenProgress {
  points:   PathPoint[]
  dragging: boolean
  mousePos: { x: number; y: number } | null
}

function newId() { return uid() }

// Trapezoid glyph (lucide has no trapezoid).
function TrapezoidIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round">
      <path d="M8 5 L16 5 L21 19 L3 19 Z" />
    </svg>
  )
}

// "No fill" glyph — circle crossed by a red diagonal (universal none/transparent).
function NoFillIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.4" stroke="currentColor" strokeWidth="1.4" />
      <line x1="3.4" y1="12.6" x2="12.6" y2="3.4" stroke="#e5484d" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  )
}

// Shared "none" tool descriptor for the ColorPicker's left column (see PickerTool):
// used for both "no fill" and "no border" (the ⊘ glyph reads as none/transparent).
function noneTool(label: string, active: boolean, onClick: () => void): PickerTool {
  return { id: 'none', title: label, active, icon: <NoFillIcon />, onClick }
}

// "None" swatch face — a white disc crossed by a red diagonal (Illustrator-style),
// shown in a tool-rail circle when its fill/stroke is set to none, replacing the
// colour. Purely visual (pointer-events: none) so the ColorField beneath stays clickable.
function NoneSwatchFace({ style }: { style?: React.CSSProperties }) {
  return (
    <div className="absolute pointer-events-none"
         style={{ width: 32, height: 32, borderRadius: '50%', overflow: 'hidden', background: '#fff', ...style }}>
      <svg width="32" height="32" viewBox="0 0 32 32" aria-hidden="true">
        <line x1="5" y1="27" x2="27" y2="5" stroke="#e5484d" strokeWidth="2.6" strokeLinecap="round" />
      </svg>
    </div>
  )
}

// ── Grouped predefined-shape picker (Affinity-style flyout) ─────────────────────
// One toolbar button holds every predefined shape; its icon is the LAST shape
// picked (rectangle by default). `tool` routes to the native rect/ellipse tools
// or to the generic parametric 'shape' tool with preset metadata.
interface ShapeEntry {
  id:      string
  icon:    React.ComponentType<{ size?: number }>
  nameKey: string
  tool:    'rect' | 'ellipse' | 'shape'
  cr?:     number                                   // rect preset: corner radius
  meta?:   Partial<import('./api').PathElement>     // path preset: shape kind + params
  open?:   boolean                                  // open, stroke-only path (spiral)
}
const SHAPES_MENU: ShapeEntry[] = [
  { id: 'rect',      icon: Square,         nameKey: 'apex_rectangle',       tool: 'rect' },
  { id: 'roundrect', icon: Squircle,       nameKey: 'apex_shape_roundrect', tool: 'rect', cr: 24 },
  { id: 'ellipse',   icon: Circle,         nameKey: 'apex_ellipse',         tool: 'ellipse' },
  { id: 'triangle',  icon: Triangle,       nameKey: 'apex_shape_triangle',  tool: 'shape', meta: { shape: 'polygon', sides: 3 } },
  { id: 'diamond',   icon: Diamond,        nameKey: 'apex_shape_diamond',   tool: 'shape', meta: { shape: 'polygon', sides: 4 } },
  { id: 'trapezoid', icon: TrapezoidIcon,  nameKey: 'apex_shape_trapezoid', tool: 'shape', meta: { shape: 'trapezoid' } },
  { id: 'pentagon',  icon: Pentagon,       nameKey: 'apex_shape_pentagon',  tool: 'shape', meta: { shape: 'polygon', sides: 5 } },
  { id: 'polygon',   icon: Hexagon,        nameKey: 'apex_polygon',         tool: 'shape', meta: { shape: 'polygon', sides: 6 } },
  { id: 'star',      icon: Star,           nameKey: 'apex_star',            tool: 'shape', meta: { shape: 'star', spikes: 5, innerRatio: 0.45 } },
  { id: 'burst',     icon: Sun,            nameKey: 'apex_shape_burst',     tool: 'shape', meta: { shape: 'star', spikes: 16, innerRatio: 0.75 } },
  { id: 'flower',    icon: Flower,         nameKey: 'apex_shape_flower',    tool: 'shape', meta: { shape: 'flower' } },
  { id: 'arrow',     icon: ArrowRight,     nameKey: 'apex_shape_arrow',     tool: 'shape', meta: { shape: 'arrow' } },
  { id: 'dblarrow',  icon: ArrowLeftRight, nameKey: 'apex_shape_dblarrow',  tool: 'shape', meta: { shape: 'dblarrow' } },
  { id: 'donut',     icon: Disc,           nameKey: 'apex_shape_donut',     tool: 'shape', meta: { shape: 'pie', params: { start: 0, sweep: 360, hole: 0.5 } } },
  { id: 'pie',       icon: ChartPie,       nameKey: 'apex_shape_pie',       tool: 'shape', meta: { shape: 'pie', params: { start: 0, sweep: 270, hole: 0 } } },
  { id: 'dome',      icon: Rainbow,        nameKey: 'apex_shape_dome',      tool: 'shape', meta: { shape: 'pie', params: { start: 270, sweep: 180, hole: 0 } } },
  { id: 'crescent',  icon: Moon,           nameKey: 'apex_shape_crescent',  tool: 'shape', meta: { shape: 'crescent' } },
  { id: 'gear',      icon: Cog,            nameKey: 'apex_shape_gear',      tool: 'shape', meta: { shape: 'gear' } },
  { id: 'cloud',     icon: Cloud,          nameKey: 'apex_shape_cloud',     tool: 'shape', meta: { shape: 'cloud' } },
  { id: 'bubble',    icon: MessageCircle,  nameKey: 'apex_shape_bubble',    tool: 'shape', meta: { shape: 'bubble' } },
  { id: 'drop',      icon: Droplet,        nameKey: 'apex_shape_drop',      tool: 'shape', meta: { shape: 'drop' } },
  { id: 'heart',     icon: Heart,          nameKey: 'apex_shape_heart',     tool: 'shape', meta: { shape: 'heart' } },
  { id: 'spiral',    icon: Shell,          nameKey: 'apex_shape_spiral',    tool: 'shape', meta: { shape: 'spiral' }, open: true },
  { id: 'cross',     icon: Plus,           nameKey: 'apex_shape_cross',     tool: 'shape', meta: { shape: 'cross' } },
]

// Canvas blend modes exposed in the properties panel (Illustrator-style set).
const BLEND_MODES = [
  'source-over', 'multiply', 'screen', 'overlay', 'darken', 'lighten',
  'color-dodge', 'color-burn', 'soft-light', 'hard-light',
  'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity',
] as const

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

// Minimal drawing surface shared by CanvasRenderingContext2D and Path2D.
type PathSink = Pick<CanvasRenderingContext2D, 'moveTo' | 'bezierCurveTo' | 'closePath'>
function bezierToSink(sink: PathSink, prev: PathPoint, curr: PathPoint) {
  sink.bezierCurveTo(
    prev.hOut ? prev.x + prev.hOut[0] : prev.x,
    prev.hOut ? prev.y + prev.hOut[1] : prev.y,
    curr.hIn  ? curr.x + curr.hIn[0]  : curr.x,
    curr.hIn  ? curr.y + curr.hIn[1]  : curr.y,
    curr.x, curr.y,
  )
}
function buildPathInto(sink: PathSink, pts: PathPoint[], closed: boolean) {
  if (pts.length === 0) return
  sink.moveTo(pts[0].x, pts[0].y)
  // Sous-chemins (chemin composé) : un point `move` ferme le sous-chemin courant
  // (si fermé) et en démarre un nouveau — permet la fusion de plusieurs objets.
  let subStart = 0
  const closeSub = (end: number) => {
    if (closed && end - subStart >= 1) { bezierToSink(sink, pts[end], pts[subStart]); sink.closePath() }
  }
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].move) {
      closeSub(i - 1)
      sink.moveTo(pts[i].x, pts[i].y)
      subStart = i
      continue
    }
    bezierToSink(sink, pts[i - 1], pts[i])
  }
  closeSub(pts.length - 1)
}
function buildPathShape(ctx: CanvasRenderingContext2D, pts: PathPoint[], closed: boolean) {
  ctx.beginPath()
  buildPathInto(ctx, pts, closed)
}

// ── Per-element geometry caches ────────────────────────────────────────────────
// Elements are updated immutably (a changed element is a NEW object), so caching
// by object identity is both safe and extremely effective: during a drag only
// the moved elements rebuild their Path2D / bbox, everything else is reused.
const path2DCache = new WeakMap<VectorElement, Path2D | null>()
function elPath2D(el: VectorElement): Path2D | null {
  const hit = path2DCache.get(el)
  if (hit !== undefined) return hit
  let p: Path2D | null = null
  if (el.type === 'rect') {
    p = new Path2D()
    const re = el as import('./api').RectElement
    const r = re.cornerRadius ?? 0
    if (re.corners) p.roundRect(el.x, el.y, el.w, el.h, re.corners)
    else if (r > 0) p.roundRect(el.x, el.y, el.w, el.h, r)
    else            p.rect(el.x, el.y, el.w, el.h)
  } else if (el.type === 'ellipse') {
    p = new Path2D()
    p.ellipse(el.x + el.w / 2, el.y + el.h / 2, Math.abs(el.w / 2), Math.abs(el.h / 2), 0, 0, Math.PI * 2)
  } else if (el.type === 'path') {
    const pe = el as PathElement
    if (pe.points.length > 0) { p = new Path2D(); buildPathInto(p, pe.points, pe.closed) }
  }
  path2DCache.set(el, p)
  return p
}
const bboxCache = new WeakMap<VectorElement, { x: number; y: number; w: number; h: number }>()
// Compound paths (with `move` sub-path markers) fill with the even-odd rule so
// merged objects punch real holes (ring = circle merged with inner circle).
const compoundCache = new WeakMap<VectorElement, boolean>()
function fillRule(el: VectorElement): CanvasFillRule {
  if (el.type !== 'path') return 'nonzero'
  let v = compoundCache.get(el)
  if (v === undefined) { v = (el as PathElement).points.some(p => p.move); compoundCache.set(el, v) }
  return v ? 'evenodd' : 'nonzero'
}

// ── Raster image cache (src → decoded bitmap) ──────────────────────────────────
// paintElement is a module-level function; when a bitmap finishes decoding, the
// editor's re-render hook (set by the component) repaints so the image pops in.
const imageBitmapCache = new Map<string, HTMLImageElement>()
let onImageDecoded: (() => void) | null = null
function cachedImage(src: string): HTMLImageElement | null {
  const hit = imageBitmapCache.get(src)
  if (hit) return hit.complete && hit.naturalWidth > 0 ? hit : null
  const img = new Image()
  img.onload = () => { onImageDecoded?.() }
  img.src = src
  imageBitmapCache.set(src, img)
  return null
}

// Paint one leaf element into a world-space context. Shared by the main canvas
// renderer and the layer-panel thumbnails. `eff` = cascaded opacity, `outline`
// renders wireframe only (Illustrator's outline mode).
function paintElement(ctx: CanvasRenderingContext2D, el: VectorElement, eff: number, zoom: number, outline: boolean) {
  if (el.rotation !== 0) {
    const cx = el.x + el.w / 2, cy = el.y + el.h / 2
    ctx.translate(cx, cy)
    ctx.rotate(el.rotation * Math.PI / 180)
    ctx.translate(-cx, -cy)
  }
  if (el.blend && el.blend !== 'source-over') ctx.globalCompositeOperation = el.blend as GlobalCompositeOperation

  if (el.type === 'image') {
    const ie = el as import('./api').ImageElement
    if (outline) {
      ctx.strokeStyle = '#8a8a8a'; ctx.lineWidth = 1 / zoom; ctx.setLineDash([]); ctx.globalAlpha = 1
      ctx.strokeRect(el.x, el.y, el.w, el.h)
      return
    }
    const bmp = cachedImage(ie.src)
    ctx.globalAlpha = eff
    if (bmp) {
      ctx.drawImage(bmp, el.x, el.y, el.w, el.h)
    } else {
      // Bitmap still decoding → light placeholder so the frame is visible.
      ctx.fillStyle = 'rgba(128,128,128,0.15)'
      ctx.fillRect(el.x, el.y, el.w, el.h)
      ctx.strokeStyle = 'rgba(128,128,128,0.5)'; ctx.lineWidth = 1 / zoom
      ctx.strokeRect(el.x, el.y, el.w, el.h)
    }
    return
  }

  if (el.type === 'text') {
    const te = el as TextElement
    ctx.fillStyle = outline ? '#8a8a8a' : te.fill.type === 'solid' ? te.fill.color : '#000000'
    ctx.font = `${te.italic ? 'italic ' : ''}${te.fontWeight} ${te.fontSize}px ${te.fontFamily}, sans-serif`
    ctx.textBaseline = 'top'
    ctx.textAlign = te.align
    const ax = te.align === 'center' ? te.x + te.w / 2 : te.align === 'right' ? te.x + te.w : te.x
    const lines = te.text.split('\n')
    lines.forEach((ln, i) => ctx.fillText(ln, ax, te.y + i * te.fontSize * 1.25))
    ctx.textAlign = 'left'
    return
  }

  const p2d = elPath2D(el)
  if (!p2d) return

  if (outline) {
    // Wireframe: geometry only, uniform hairline — invaluable to inspect stacking.
    ctx.strokeStyle = '#8a8a8a'
    ctx.lineWidth = 1 / zoom
    ctx.setLineDash([])
    ctx.globalAlpha = 1
    ctx.stroke(p2d)
    return
  }

  const fill = el.fill
  if (fill.type === 'solid') {
    ctx.fillStyle = fill.color
    ctx.globalAlpha = eff * (fill.opacity / 100)
    ctx.fill(p2d, fillRule(el))
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
    ctx.fill(p2d, fillRule(el))
  } else if (fill.type === 'radial-gradient') {
    const b = elBBox(el)
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(b.w, b.h) / 2)
    const stops = [...fill.stops].sort((a, z) => a.position - z.position)
    for (const s of stops) g.addColorStop(Math.max(0, Math.min(1, s.position)), hexWithAlpha(s.color, s.opacity))
    ctx.fillStyle = g
    ctx.globalAlpha = eff
    ctx.fill(p2d, fillRule(el))
  }
  if (el.stroke && el.stroke.width > 0) {
    ctx.strokeStyle = el.stroke.color
    ctx.lineWidth   = el.stroke.width
    ctx.lineCap     = el.stroke.cap  ?? 'butt'
    ctx.lineJoin    = el.stroke.join ?? 'miter'
    ctx.miterLimit  = el.stroke.miterLimit ?? 10
    ctx.setLineDash((el.stroke.dashArray ?? []).map(d => d))
    ctx.globalAlpha = eff * (el.stroke.opacity / 100)
    ctx.stroke(p2d)
    ctx.setLineDash([])
  }
}

// ── Renderer ───────────────────────────────────────────────────────────────────
interface ViewOptions {
  rulers:    boolean
  guidesOn:  boolean
  outline:   boolean
  tempGuide?: { type: 'h' | 'v'; position: number } | null
  // Live symmetry drawing mode: axes drawn through (cx,cy).
  symmetry?: { mode: 'v' | 'h' | 'vh' | 'radial'; count: number; cx: number; cy: number; rot?: number } | null
  // Tangent-snap contact point (outlines kissing).
  snapTouch?: { x: number; y: number } | null
}
const RULER_PX = 18
const GUIDE_COLOR = '#1ba7ff'

function renderCanvas(
  ctx: CanvasRenderingContext2D,
  w: number, h: number,
  pageData: VectorPageData,
  cs: CanvasState,
  selectedIds: string[],
  dpr: number,
  marquee?: { x: number; y: number; w: number; h: number } | null,
  guides?: { vx: SnapGuide[]; hy: SnapGuide[] },
  grid?: { size: number; on: boolean },
  view?: ViewOptions,
  symBoxClone?: string | null,   // clicked symmetry clone → draw its box on the clone
  hoverAngle?: { x: number; y: number; deg: number; a1: number; a2: number } | null,   // corner angle readout
  mode: 'full' | 'scene' | 'overlays' = 'full',
) {
  // Split rendering: the SCENE (bg + artboards + grid + elements) is expensive to
  // rasterise and rarely changes, so doRender caches it to an offscreen bitmap and
  // only repaints OVERLAYS (selection / hover / marquee / guides / rulers) on top for
  // interactive gestures that leave the artwork untouched.
  const drawScene = mode !== 'overlays'
  const drawOv = mode !== 'scene'
  ctx.save()
  ctx.imageSmoothingQuality = 'high'   // crisper downscaling of raster images
  ctx.scale(dpr, dpr)

  if (drawScene) {
    ctx.fillStyle = C.bg
    ctx.fillRect(0, 0, w, h)
  }

  ctx.save()
  ctx.translate(cs.panX, cs.panY)
  if (cs.rot) ctx.rotate(cs.rot)
  ctx.scale(cs.zoom, cs.zoom)

  if (drawScene) {
  // Artboards
  for (const ab of pageData.artboards) {
    ctx.save()
    ctx.shadowColor = 'rgba(0,0,0,0.5)'
    ctx.shadowBlur  = 20
    ctx.shadowOffsetY = 4
    if (ab.background === 'transparent') {
      // Checkerboard so transparency reads at a glance.
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(ab.x, ab.y, ab.width, ab.height)
      ctx.shadowColor = 'transparent'
      ctx.fillStyle = '#e2e2e2'
      const sq = Math.max(8 / cs.zoom, 8)
      ctx.save()
      ctx.beginPath(); ctx.rect(ab.x, ab.y, ab.width, ab.height); ctx.clip()
      for (let gy = 0; gy * sq < ab.height; gy++)
        for (let gx = gy % 2; gx * sq < ab.width; gx += 2)
          ctx.fillRect(ab.x + gx * sq, ab.y + gy * sq, sq, sq)
      ctx.restore()
    } else {
      ctx.fillStyle = ab.background === 'white' ? '#ffffff' : ab.background
      ctx.fillRect(ab.x, ab.y, ab.width, ab.height)
    }
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
  // Clip scopes (clipping-mask groups) translate to save/clip/restore pairs.
  for (const entry of renderOrder(pageData.elements)) {
    if ('clipEnter' in entry) { ctx.save(); ctx.clip(worldClipPath(entry.clipEnter), 'nonzero'); continue }
    if ('clipExit' in entry)  { ctx.restore(); continue }
    ctx.save()
    ctx.globalAlpha = entry.alpha
    paintElement(ctx, entry.el, entry.alpha, cs.zoom, view?.outline ?? false)
    ctx.restore()
  }
  }

  if (drawOv) {
  // Selection boxes
  for (const id of selectedIds) {
    const el = pageData.elements.find(e => e.id === id)
    if (!el) continue
    // A clicked symmetry clone shows its selection box on the CLONE, even though its
    // (hidden) source is what actually sits in `selectedIds` and gets edited. We draw
    // the SOURCE's box under the clone's forward isometry (reflected clones bake their
    // rotation into points, so their own bbox+angle can't reproduce a hugging box).
    const proxyClone = symBoxClone && el.type !== 'group' && el.type !== 'symmetry'
      ? pageData.elements.find(c => c.id === symBoxClone && c.symOf === el.id) : null
    // Couleur de sélection distincte : objet VECTORIEL (chemin libre, éditable à la
    // plume) en magenta ; FORME paramétrique (rect/ellipse/polygone/étoile) en bleu.
    const isVector = el.type === 'path' && !(el as PathElement).shape
    const isCont = el.type === 'group' || el.type === 'symmetry'
    const selColor = el.type === 'symmetry' ? '#b16ee8' : isVector ? '#d6249f' : C.handle
    // Containers select as a unit: an ORIENTED box (tilts with the symmetry rotation)
    // encloses the whole subtree.
    const ob = isCont ? orientedContainerBox(pageData.elements, el) : null
    const { x: bx, y: by, w: bw, h: bh } = ob
      ? { x: ob.lx, y: ob.ly, w: ob.lw, h: ob.lh }
      : (isCont ? (groupBBox(pageData.elements, el.id) ?? elBBox(el)) : elBBox(el))
    ctx.save()
    if (proxyClone) {
      const cont = pageData.elements.find(e => e.id === proxyClone.parentId)
      if (cont && cont.type === 'symmetry') applySymCloneForward(ctx, cont as SymmetryElement, proxyClone.symIdx!)
    }
    if (ob && ob.ang) {
      ctx.translate(ob.px, ob.py)
      ctx.rotate(ob.ang * Math.PI / 180)
      ctx.translate(-ob.px, -ob.py)
    } else if (!isCont && el.rotation !== 0) {
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
    // All 8 handles (corners + edge midpoints) — containers resize their whole subtree.
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
    // Corner-radius handle (rect + roundable parametric shapes, single selection).
    if (selectedIds.length === 1 && (el.type === 'rect' || (el.type === 'path' && isRoundableShape((el as PathElement).shape)))) {
      const rh = radiusHandleLocal(el, cs.zoom)
      if (rh) {
        ctx.beginPath(); ctx.arc(rh.hx, rh.hy, hSz * 0.7, 0, Math.PI * 2)
        ctx.fillStyle = '#fff'; ctx.fill()
        ctx.strokeStyle = selColor; ctx.lineWidth = 1.5 / cs.zoom; ctx.stroke()
      }
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

  // User guides (cyan) + the guide currently being dragged out of a ruler.
  if (view?.guidesOn !== false) {
    const span = 100000
    ctx.save()
    ctx.strokeStyle = GUIDE_COLOR
    ctx.lineWidth = 1 / cs.zoom
    ctx.setLineDash([])
    ctx.beginPath()
    for (const g of pageData.guides ?? []) {
      if (g.type === 'v') { ctx.moveTo(g.position, -span); ctx.lineTo(g.position, span) }
      else                { ctx.moveTo(-span, g.position); ctx.lineTo(span, g.position) }
    }
    ctx.stroke()
    if (view?.tempGuide) {
      ctx.setLineDash([6 / cs.zoom, 4 / cs.zoom])
      ctx.beginPath()
      const tg = view.tempGuide
      if (tg.type === 'v') { ctx.moveTo(tg.position, -span); ctx.lineTo(tg.position, span) }
      else                 { ctx.moveTo(-span, tg.position); ctx.lineTo(span, tg.position) }
      ctx.stroke()
      ctx.setLineDash([])
    }
    ctx.restore()
  }

  // Live-symmetry axes (dashed accent) through the artboard centre.
  if (view?.symmetry) {
    const { mode, count, cx, cy, rot = 0 } = view.symmetry
    const span = 100000
    ctx.save()
    // Rotated frame: mirror axes / radial spokes turn about the centre.
    if (rot) { ctx.translate(cx, cy); ctx.rotate(rot * Math.PI / 180); ctx.translate(-cx, -cy) }
    ctx.strokeStyle = '#b16ee8'
    ctx.lineWidth = 1 / cs.zoom
    ctx.setLineDash([7 / cs.zoom, 5 / cs.zoom])
    ctx.beginPath()
    if (mode === 'v' || mode === 'vh') { ctx.moveTo(cx, -span); ctx.lineTo(cx, span) }
    if (mode === 'h' || mode === 'vh') { ctx.moveTo(-span, cy); ctx.lineTo(span, cy) }
    if (mode === 'radial') {
      const n = Math.max(2, count)
      for (let k = 0; k < n; k++) {
        const a = (k * 2 * Math.PI) / n - Math.PI / 2
        ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * span, cy + Math.sin(a) * span)
      }
    }
    ctx.stroke()
    ctx.setLineDash([])
    // Centre HANDLE (draggable): filled disc + ring.
    ctx.beginPath(); ctx.arc(cx, cy, 5 / cs.zoom, 0, Math.PI * 2)
    ctx.fillStyle = '#ffffff'; ctx.fill()
    ctx.lineWidth = 1.6 / cs.zoom; ctx.stroke()
    ctx.beginPath(); ctx.arc(cx, cy, 1.8 / cs.zoom, 0, Math.PI * 2)
    ctx.fillStyle = '#b16ee8'; ctx.fill()
    ctx.restore()
  }

  // Tangent-snap contact marker: a small ring where the two outlines kiss.
  if (view?.snapTouch) {
    const { x, y } = view.snapTouch
    ctx.save()
    ctx.strokeStyle = '#12b76a'; ctx.lineWidth = 1.6 / cs.zoom
    ctx.beginPath(); ctx.arc(x, y, 4 / cs.zoom, 0, Math.PI * 2); ctx.stroke()
    ctx.fillStyle = '#12b76a'
    ctx.beginPath(); ctx.arc(x, y, 1.4 / cs.zoom, 0, Math.PI * 2); ctx.fill()
    ctx.restore()
  }

  // Smart alignment + distance overlays (Affinity-style, green). The MAGNETISM
  // line (alignment axis) is thick; the DISTANCE line (measured gap) is thin.
  if (guides && (guides.vx.length || guides.hy.length)) {
    ctx.save()
    ctx.setLineDash([])
    const z = cs.zoom
    const GREEN = '#12b76a'
    const thick = 2 / z, thin = 0.85 / z, tick = 4 / z, span = 100000
    const fmt = (n: number) => (Math.round(n * 10) / 10).toString().replace('.', ',')
    // Draws one axis-aligned snap guide. `axis` = orientation of the alignment
    // line ('x' → vertical line at coord; 'y' → horizontal line at coord).
    const drawGuide = (axis: 'x' | 'y', g: SnapGuide) => {
      const c = g.coord
      ctx.strokeStyle = GREEN
      if (g.a && g.b) {
        // MAGNETISM line = thick, but drawn only OVER each box (never across the
        // gap) so the empty span carries only the thin distance line, like Affinity.
        const aLo = axis === 'x' ? g.a.y : g.a.x, aHi = aLo + (axis === 'x' ? g.a.h : g.a.w)
        const bLo = axis === 'x' ? g.b.y : g.b.x, bHi = bLo + (axis === 'x' ? g.b.h : g.b.w)
        ctx.lineWidth = thick
        ctx.beginPath()
        if (axis === 'x') { ctx.moveTo(c, aLo); ctx.lineTo(c, aHi); ctx.moveTo(c, bLo); ctx.lineTo(c, bHi) }
        else              { ctx.moveTo(aLo, c); ctx.lineTo(aHi, c); ctx.moveTo(bLo, c); ctx.lineTo(bHi, c) }
        ctx.stroke()
        // Distance line inside the gap (thin) + end ticks + numeric label.
        const gap = axisGap(g.a, g.b, axis === 'x' ? 'y' : 'x')
        if (gap.dist > 0.05) {
          ctx.lineWidth = thin
          ctx.beginPath()
          if (axis === 'x') {
            ctx.moveTo(c, gap.from); ctx.lineTo(c, gap.to)
            ctx.moveTo(c - tick, gap.from); ctx.lineTo(c + tick, gap.from)
            ctx.moveTo(c - tick, gap.to);   ctx.lineTo(c + tick, gap.to)
          } else {
            ctx.moveTo(gap.from, c); ctx.lineTo(gap.to, c)
            ctx.moveTo(gap.from, c - tick); ctx.lineTo(gap.from, c + tick)
            ctx.moveTo(gap.to, c - tick);   ctx.lineTo(gap.to, c + tick)
          }
          ctx.stroke()
          // Label at the gap midpoint, drawn at constant screen size. For a vertical
          // magnetism line the text is rotated to read bottom-to-top (Affinity style).
          const mid = (gap.from + gap.to) / 2
          const label = fmt(gap.dist)
          ctx.save()
          ctx.font = `${9 / z}px system-ui, sans-serif`
          ctx.lineJoin = 'round'
          if (axis === 'x') {
            ctx.translate(c + 3 / z, mid); ctx.rotate(-Math.PI / 2)
            ctx.textAlign = 'center'; ctx.textBaseline = 'top'
          } else {
            ctx.translate(mid, c - 4 / z)
            ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'
          }
          ctx.lineWidth = 2.5 / z
          ctx.strokeStyle = '#ffffff'
          ctx.strokeText(label, 0, 0)
          ctx.fillStyle = GREEN
          ctx.fillText(label, 0, 0)
          ctx.restore()
          ctx.strokeStyle = GREEN
        }
      } else {
        // Guide/grid/edge snap with no paired object → thin full-bleed line.
        ctx.lineWidth = thin
        ctx.beginPath()
        if (axis === 'x') { ctx.moveTo(c, -span); ctx.lineTo(c, span) } else { ctx.moveTo(-span, c); ctx.lineTo(span, c) }
        ctx.stroke()
      }
    }
    for (const g of guides.vx) drawGuide('x', g)
    for (const g of guides.hy) drawGuide('y', g)
    ctx.restore()
  }

  // Corner angle readout (hover): a small pill near the hovered vertex. Screen-constant
  // size via 1/zoom scaling; a right-angle corner is tinted green as an at-a-glance cue.
  if (hoverAngle) {
    const z = cs.zoom
    ctx.save()
    // Reset any inherited paint state (a prior element's blend/alpha/dash could otherwise
    // suppress these fills) before drawing the overlay.
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
    ctx.setLineDash([])
    const label = `${hoverAngle.deg.toFixed(1)}°`
    const square = Math.abs(hoverAngle.deg - 90) < 0.15
    // Angle annotation: arms along both edges, then a right-angle square for 90° or an
    // arc spanning the interior angle otherwise. Every stroke gets a white CASING drawn
    // underneath so the coloured core stays visible over same-hue backgrounds (the white
    // separates it from a coloured fill; the coloured core stands out over white). Fully
    // automatic — no need to sample the background colour.
    const vx = hoverAngle.x, vy = hoverAngle.y, a1 = hoverAngle.a1, a2 = hoverAngle.a2
    const arm = 34 / z, rad = 18 / z
    const d1x = Math.cos(a1), d1y = Math.sin(a1), d2x = Math.cos(a2), d2y = Math.sin(a2)
    // Match the readout's colour code: green for a right angle, magenta otherwise.
    const angColor = square ? '#22a05a' : '#d6249f'
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'
    const arms = new Path2D()
    arms.moveTo(vx, vy); arms.lineTo(vx + arm * d1x, vy + arm * d1y)
    arms.moveTo(vx, vy); arms.lineTo(vx + arm * d2x, vy + arm * d2y)
    const marker = new Path2D()
    if (square) {
      marker.moveTo(vx + rad * d1x, vy + rad * d1y)
      marker.lineTo(vx + rad * (d1x + d2x), vy + rad * (d1y + d2y))
      marker.lineTo(vx + rad * d2x, vy + rad * d2y)
    } else {
      let delta = a2 - a1                    // signed sweep of the interior angle
      while (delta <= -Math.PI) delta += 2 * Math.PI
      while (delta > Math.PI) delta -= 2 * Math.PI
      const steps = 24
      for (let i = 0; i <= steps; i++) {
        const a = a1 + (delta * i) / steps
        const px = vx + rad * Math.cos(a), py = vy + rad * Math.sin(a)
        if (i === 0) marker.moveTo(px, py); else marker.lineTo(px, py)
      }
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.92)'; ctx.lineWidth = 3.6 / z   // casing
    ctx.stroke(arms); ctx.stroke(marker)
    ctx.strokeStyle = angColor; ctx.lineWidth = 1.5 / z                   // coloured core
    ctx.stroke(arms); ctx.stroke(marker)
    ctx.font = `${11 / z}px Inter, system-ui, sans-serif`
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
    const padX = 5 / z, tw = ctx.measureText(label).width
    const bx = hoverAngle.x + 11 / z, by = hoverAngle.y - 11 / z
    const bw = tw + padX * 2, bh = 15 / z, rr = 4 / z
    // Pill: white casing outline (separates it from a same-hue fill) + colour-coded body.
    ctx.beginPath(); ctx.roundRect(bx, by - bh / 2, bw, bh, rr)
    ctx.lineWidth = 3 / z; ctx.strokeStyle = 'rgba(255,255,255,0.92)'; ctx.stroke()
    ctx.fillStyle = square ? 'rgba(24,150,84,0.97)' : 'rgba(20,20,24,0.95)'; ctx.fill()
    ctx.fillStyle = '#ffffff'
    ctx.fillText(label, bx + padX, by + 0.5 / z)
    // Marker dot on the vertex: white halo ring + coloured centre → visible on any fill.
    ctx.beginPath(); ctx.arc(vx, vy, 4.4 / z, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(255,255,255,0.95)'; ctx.fill()
    ctx.beginPath(); ctx.arc(vx, vy, 2.6 / z, 0, Math.PI * 2)
    ctx.fillStyle = angColor; ctx.fill()
    ctx.restore()
  }
  }

  ctx.restore()

  // Rulers — screen-space strips with adaptive world-unit ticks. Drawn last so
  // they overlay the content. Skipped while the view is rotated (ticks would lie).
  if (drawOv && view?.rulers && !cs.rot) {
    const R = RULER_PX
    ctx.save()
    ctx.fillStyle = '#232323'
    ctx.fillRect(0, 0, w, R)
    ctx.fillRect(0, 0, R, h)
    ctx.strokeStyle = '#3a3a3a'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, R + 0.5); ctx.lineTo(w, R + 0.5)
    ctx.moveTo(R + 0.5, 0); ctx.lineTo(R + 0.5, h)
    ctx.stroke()
    // Pick a world step so labelled ticks sit ≥ 55 px apart on screen.
    const steps = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000]
    const step = steps.find(s => s * cs.zoom >= 55) ?? 25000
    const minor = step / 5
    ctx.fillStyle = '#8d8d8d'
    ctx.strokeStyle = '#555'
    ctx.font = '9px Inter, sans-serif'
    ctx.textBaseline = 'top'
    // Horizontal ruler
    const wx0 = (R - cs.panX) / cs.zoom, wx1 = (w - cs.panX) / cs.zoom
    ctx.beginPath()
    for (let x = Math.floor(wx0 / minor) * minor; x <= wx1; x += minor) {
      const sx = cs.panX + x * cs.zoom
      const major = Math.abs(x / step - Math.round(x / step)) < 1e-6
      ctx.moveTo(sx + 0.5, major ? 4 : 12); ctx.lineTo(sx + 0.5, R)
      if (major) ctx.fillText(String(Math.round(x)), sx + 3, 2)
    }
    ctx.stroke()
    // Vertical ruler (labels rotated 90°)
    const wy0 = (R - cs.panY) / cs.zoom, wy1 = (h - cs.panY) / cs.zoom
    ctx.beginPath()
    for (let y = Math.floor(wy0 / minor) * minor; y <= wy1; y += minor) {
      const sy = cs.panY + y * cs.zoom
      const major = Math.abs(y / step - Math.round(y / step)) < 1e-6
      ctx.moveTo(major ? 4 : 12, sy + 0.5); ctx.lineTo(R, sy + 0.5)
      if (major) {
        ctx.save()
        ctx.translate(2, sy + 3)
        ctx.rotate(Math.PI / 2)
        ctx.fillText(String(Math.round(y)), 0, -9)
        ctx.restore()
      }
    }
    ctx.stroke()
    // Corner square
    ctx.fillStyle = '#232323'
    ctx.fillRect(0, 0, R, R)
    ctx.restore()
  }

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

// ── Freehand capture overlay (live pencil / brush preview) ─────────────────────
function drawFreehandOverlay(
  ctx: CanvasRenderingContext2D,
  samples: { x: number; y: number }[],
  cs: CanvasState,
  dpr: number,
  width: number,
  color: string,
) {
  if (samples.length < 2) return
  ctx.save()
  ctx.scale(dpr, dpr)
  ctx.translate(cs.panX, cs.panY)
  if (cs.rot) ctx.rotate(cs.rot)
  ctx.scale(cs.zoom, cs.zoom)
  ctx.strokeStyle = color
  ctx.globalAlpha = 0.9
  ctx.lineWidth = width
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()
  ctx.moveTo(samples[0].x, samples[0].y)
  for (let i = 1; i < samples.length; i++) ctx.lineTo(samples[i].x, samples[i].y)
  ctx.stroke()
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
  selIdx: number[],
  dim = false,   // symmetry clone overlay: editable but drawn faded to read as a mirror
) {
  ctx.save()
  ctx.globalAlpha = dim ? 0.5 : 1
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
    ctx.fillStyle = selIdx.includes(i) ? C.accent : '#fff'
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
  const { x: bx, y: by, w: bw, h: bh } = elBBox(el)
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

// Parametric path shapes whose corners can be rounded (polygon covers triangle /
// diamond / pentagon / n-gon, star covers stars, trapezoid the trapezoid).
const ROUNDABLE_SHAPES = new Set(['polygon', 'star', 'trapezoid'])
function isRoundableShape(shape?: string): boolean {
  return !!shape && ROUNDABLE_SHAPES.has(shape)
}

// The un-rounded (sharp) vertices of a roundable parametric shape, in local coords.
function baseShapePoints(pe: PathElement): PathPoint[] {
  const cx = pe.x + pe.w / 2, cy = pe.y + pe.h / 2, rx = pe.w / 2, ry = pe.h / 2
  if (pe.shape === 'polygon') return genPolygon(cx, cy, rx, ry, Math.max(3, Math.round(pe.sides ?? 6)))
  if (pe.shape === 'star')    return genStar(cx, cy, rx, ry, Math.max(3, Math.round(pe.spikes ?? 5)), Math.max(0.05, Math.min(0.95, pe.innerRatio ?? 0.45)))
  if (pe.shape === 'trapezoid') return genTrapezoid(pe.x, pe.y, pe.w, pe.h, shapeParam(pe, 'top'))
  return []
}

// Round the corners of a closed polygon of sharp anchors: trim each vertex back by
// `radius` along both edges and bridge with a bezier arc. Per-corner trim is capped
// to half the shorter adjacent edge so neighbouring fillets never overlap.
function roundCorners(pts: PathPoint[], radius: number): PathPoint[] {
  const n = pts.length
  if (n < 3 || radius <= 0) return pts
  const K = 0.5523  // circle-arc bezier constant
  const out: PathPoint[] = []
  for (let i = 0; i < n; i++) {
    const V = pts[i], P = pts[(i - 1 + n) % n], N = pts[(i + 1) % n]
    const ivx = V.x - P.x, ivy = V.y - P.y, iLen = Math.hypot(ivx, ivy) || 1
    const ovx = N.x - V.x, ovy = N.y - V.y, oLen = Math.hypot(ovx, ovy) || 1
    const t = Math.min(radius, iLen / 2, oLen / 2)
    const dix = ivx / iLen, diy = ivy / iLen   // incoming edge dir (P→V)
    const dox = ovx / oLen, doy = ovy / oLen   // outgoing edge dir (V→N)
    out.push({ x: V.x - dix * t, y: V.y - diy * t, hOut: [dix * t * K, diy * t * K] })
    out.push({ x: V.x + dox * t, y: V.y + doy * t, hIn: [-dox * t * K, -doy * t * K] })
  }
  return out
}

// Unified corner-radius handle geometry (local coords): an origin corner, a unit
// drag direction (radius = projection of the pointer onto it) and the max radius.
// Rect → top-left corner, diagonal drag. Roundable shapes → top vertex, dragged
// toward the centre. Returns null for anything without an adjustable radius.
function radiusHandleGeom(el: VectorElement): { ox: number; oy: number; ux: number; uy: number; maxR: number; r: number } | null {
  if (el.type === 'rect') {
    const { x: bx, y: by, w: bw, h: bh } = elBBox(el)
    const maxR = Math.min(bw, bh) / 2
    const r = Math.max(0, Math.min((el as RectElement).cornerRadius ?? 0, maxR))
    return { ox: bx, oy: by, ux: Math.SQRT1_2, uy: Math.SQRT1_2, maxR, r }
  }
  if (el.type === 'path' && isRoundableShape((el as PathElement).shape)) {
    const pe = el as PathElement
    const base = baseShapePoints(pe)
    if (base.length < 3) return null
    const cx = pe.x + pe.w / 2, cy = pe.y + pe.h / 2, V = base[0]
    let ux = cx - V.x, uy = cy - V.y; const l = Math.hypot(ux, uy) || 1; ux /= l; uy /= l
    let maxR = Infinity
    for (let i = 0; i < base.length; i++) { const A = base[i], B = base[(i + 1) % base.length]; maxR = Math.min(maxR, Math.hypot(B.x - A.x, B.y - A.y) / 2) }
    const r = Math.max(0, Math.min(pe.params?.cornerRadius ?? 0, maxR))
    return { ox: V.x, oy: V.y, ux, uy, maxR, r }
  }
  return null
}

// Local position of the corner-radius handle dot (with a floor so it stays
// grabbable near radius 0), derived from the unified geometry above.
function radiusHandleLocal(el: VectorElement, zoom: number): { hx: number; hy: number } | null {
  const g = radiusHandleGeom(el); if (!g) return null
  const d = Math.max(g.r, 14 / zoom)
  return { hx: g.ox + g.ux * d, hy: g.oy + g.uy * d }
}

// Rotate a world point into an element's local (un-rotated) frame about its centre.
function toElementLocal(el: VectorElement, px: number, py: number): { x: number; y: number } {
  if (!el.rotation) return { x: px, y: py }
  const { x: bx, y: by, w: bw, h: bh } = elBBox(el)
  const cx = bx + bw / 2, cy = by + bh / 2
  const a = -el.rotation * Math.PI / 180, dx = px - cx, dy = py - cy
  return { x: cx + dx * Math.cos(a) - dy * Math.sin(a), y: cy + dx * Math.sin(a) + dy * Math.cos(a) }
}

// Precise, rotation-aware hit-testing: point-in-fill / point-on-stroke against
// the cached Path2D (was a plain bounding-box test — impossible to click through
// the empty inside of a ring, or select overlapping shapes reliably).
let _hitCtx: CanvasRenderingContext2D | null = null
function hitTest(el: VectorElement, px: number, py: number, zoom = 1): boolean {
  if (isContainer(el)) return false   // containers have no geometry
  const lp = worldToLocal(px, py, el)     // undo the element's own rotation
  if (el.type === 'text' || el.type === 'image') {
    const pad = 2 / zoom
    return lp.x >= el.x - pad && lp.x <= el.x + el.w + pad && lp.y >= el.y - pad && lp.y <= el.y + el.h + pad
  }
  const p2d = elPath2D(el)
  if (!p2d) return false
  if (!_hitCtx) _hitCtx = document.createElement('canvas').getContext('2d')
  const hctx = _hitCtx
  if (!hctx) return false
  // Fill region counts whenever the shape carries a fill — a filled OPEN path is
  // rendered by implicitly closing it (ctx.fill), so its visible (non-transparent)
  // area is clickable too, exactly matching what the user sees.
  if (el.fill.type !== 'none' && hctx.isPointInPath(p2d, lp.x, lp.y, fillRule(el))) return true
  // Stroke band — with a comfortable minimum grab width at any zoom.
  const grab = 8 / zoom
  const sw = el.stroke && el.stroke.width > 0 ? el.stroke.width : 0
  hctx.lineWidth = Math.max(sw, grab)
  return hctx.isPointInStroke(p2d, lp.x, lp.y)
}

// ── Geometry helpers ───────────────────────────────────────────────────────────
// True bounding box of a bezier path INCLUDING curve extrema — a curve can bulge
// well past its anchors, so an anchors-only box clips the selection frame.
function pathBounds(pts: PathPoint[], closed: boolean): { x: number; y: number; w: number; h: number } {
  if (!pts.length) return { x: 0, y: 0, w: 0, h: 0 }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  const extend = (x: number, y: number) => {
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (y < minY) minY = y; if (y > maxY) maxY = y
  }
  // 1D cubic extrema: roots of the derivative inside (0,1).
  const axis = (p0: number, c1: number, c2: number, p3: number, out: number[]) => {
    const lo = Math.min(p0, p3), hi = Math.max(p0, p3)
    if (c1 >= lo && c1 <= hi && c2 >= lo && c2 <= hi) return   // hull inside endpoints
    const a = c1 - p0, b = c2 - c1, c = p3 - c2
    const A = a - 2 * b + c, B = 2 * (b - a), C = a
    const ts: number[] = []
    if (Math.abs(A) < 1e-12) { if (Math.abs(B) > 1e-12) ts.push(-C / B) }
    else {
      const disc = B * B - 4 * A * C
      if (disc >= 0) { const s = Math.sqrt(disc); ts.push((-B + s) / (2 * A), (-B - s) / (2 * A)) }
    }
    for (const t of ts) {
      if (t <= 0 || t >= 1) continue
      const u = 1 - t
      out.push(u * u * u * p0 + 3 * u * u * t * c1 + 3 * u * t * t * c2 + t * t * t * p3)
    }
  }
  const seg = (a: PathPoint, b: PathPoint) => {
    if (!a.hOut && !b.hIn) return   // straight segment: endpoints suffice
    const c1x = a.hOut ? a.x + a.hOut[0] : a.x, c1y = a.hOut ? a.y + a.hOut[1] : a.y
    const c2x = b.hIn  ? b.x + b.hIn[0]  : b.x, c2y = b.hIn  ? b.y + b.hIn[1]  : b.y
    const xs: number[] = [], ys: number[] = []
    axis(a.x, c1x, c2x, b.x, xs)
    axis(a.y, c1y, c2y, b.y, ys)
    for (const x of xs) { if (x < minX) minX = x; if (x > maxX) maxX = x }
    for (const y of ys) { if (y < minY) minY = y; if (y > maxY) maxY = y }
  }
  // Split into subpaths on `move` markers; honour the closing segment.
  const subs: PathPoint[][] = []
  let cur: PathPoint[] = []
  pts.forEach((p, i) => { if (p.move && i > 0) { subs.push(cur); cur = [] } cur.push(p) })
  if (cur.length) subs.push(cur)
  for (const sub of subs) {
    for (const p of sub) extend(p.x, p.y)
    for (let i = 0; i < sub.length - 1; i++) seg(sub[i], sub[i + 1])
    if (closed && sub.length > 2) seg(sub[sub.length - 1], sub[0])
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}
function elBBox(el: VectorElement): { x: number; y: number; w: number; h: number } {
  if (el.type === 'path') {
    const cached = bboxCache.get(el)
    if (cached) return cached
    const pe = el as PathElement
    if (pe.points.length) {
      const b = pathBounds(pe.points, pe.closed)
      bboxCache.set(el, b)
      return b
    }
  }
  return { x: el.x, y: el.y, w: el.w, h: el.h }
}
// World-space corners of an element together with the interior angle (deg) between the
// two edges meeting there. Angles are rotation-invariant, so they are measured on the
// local outline; only the vertex position is rotated into world space. Used by the
// hover angle-readout (inspect whether e.g. a "rectangle" still has 90° corners).
// `a1`/`a2` are the WORLD-space directions (radians) of the two edges leaving the vertex
// — used to draw the angle's arms plus its arc / right-angle marker.
// `ptIndex` = index of the vertex in a PATH's `points` array (or -1 for the corners of a
// parametric rect/image/text, whose 90° corners are not point-editable). Enables the
// double-click / context-menu "edit angle" flow.
function elCornerAngles(el: VectorElement): { x: number; y: number; deg: number; a1: number; a2: number; ptIndex: number }[] {
  const out: { x: number; y: number; deg: number; a1: number; a2: number; ptIndex: number }[] = []
  const subs: { x: number; y: number; gi: number }[][] = []
  let closed = true
  if (el.type === 'path') {
    const pe = el as PathElement
    closed = pe.closed
    let cur: { x: number; y: number; gi: number }[] = []
    pe.points.forEach((p, i) => { if (p.move && i > 0) { subs.push(cur); cur = [] } cur.push({ x: p.x, y: p.y, gi: i }) })
    if (cur.length) subs.push(cur)
  } else if (el.type === 'rect' || el.type === 'image' || el.type === 'text') {
    subs.push([{ x: el.x, y: el.y, gi: -1 }, { x: el.x + el.w, y: el.y, gi: -1 }, { x: el.x + el.w, y: el.y + el.h, gi: -1 }, { x: el.x, y: el.y + el.h, gi: -1 }])
  } else return out
  const rot = ((el.rotation || 0) * Math.PI) / 180, c = Math.cos(rot), s = Math.sin(rot)
  const bb = elBBox(el), ccx = bb.x + bb.w / 2, ccy = bb.y + bb.h / 2
  for (const sub of subs) {
    const n = sub.length
    if (n < 3) continue
    for (let i = 0; i < n; i++) {
      if (!closed && (i === 0 || i === n - 1)) continue   // open-path endpoints have no interior angle
      const V = sub[i], P = sub[(i - 1 + n) % n], N = sub[(i + 1) % n]
      const v1x = P.x - V.x, v1y = P.y - V.y, v2x = N.x - V.x, v2y = N.y - V.y
      const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y)
      if (l1 < 1e-6 || l2 < 1e-6) continue
      const cosA = Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / (l1 * l2)))
      // Edge directions rotated into world space (rotation preserves the angle itself).
      const e1x = c * v1x - s * v1y, e1y = s * v1x + c * v1y
      const e2x = c * v2x - s * v2y, e2y = s * v2x + c * v2y
      out.push({
        x: ccx + c * (V.x - ccx) - s * (V.y - ccy),
        y: ccy + s * (V.x - ccx) + c * (V.y - ccy),
        deg: (Math.acos(cosA) * 180) / Math.PI,
        a1: Math.atan2(e1y, e1x),
        a2: Math.atan2(e2y, e2x),
        ptIndex: V.gi,
      })
    }
  }
  return out
}
// Set the interior angle at vertex `ptIndex` of a path to `deg`, by rotating the OUTGOING
// arm (V→next) about the vertex while keeping the incoming arm (prev→V) fixed. Returns a
// new points array (bbox recomputed by the caller). World-invariant elsewhere.
// Rigidly rotate an anchor (position AND its bezier handles) about a pivot.
function rotPtAround(p: PathPoint, ox: number, oy: number, ang: number): PathPoint {
  const c = Math.cos(ang), s = Math.sin(ang)
  const dx = p.x - ox, dy = p.y - oy
  const np: PathPoint = { ...p, x: ox + c * dx - s * dy, y: oy + s * dx + c * dy }
  if (p.hIn)  np.hIn  = [c * p.hIn[0]  - s * p.hIn[1],  s * p.hIn[0]  + c * p.hIn[1]]
  if (p.hOut) np.hOut = [c * p.hOut[0] - s * p.hOut[1], s * p.hOut[0] + c * p.hOut[1]]
  return np
}
// Editing one corner necessarily cascades to the connected neighbours (the interior
// angles of a polyline sum to a fixed total). `strat` picks WHICH point absorbs the
// change: 'out' rotates the outgoing arm (moves the next vertex → shifts angles at
// next & next+1), 'in' rotates the incoming arm (moves the prev vertex → shifts
// prev & prev-1), 'split' rotates both half each about the bisector (symmetric).
type AngleStrat = 'out' | 'in' | 'split'
function setPathCornerAngle(pe: PathElement, ptIndex: number, deg: number, strat: AngleStrat = 'out'): PathPoint[] {
  const pts = pe.points
  const n = pts.length
  if (ptIndex < 0 || ptIndex >= n) return pts
  // Neighbours within the same subpath (respecting `move` breaks + closure).
  let start = ptIndex; while (start > 0 && !pts[start].move) start--
  let end = ptIndex; while (end + 1 < n && !pts[end + 1].move) end++
  const len = end - start + 1
  if (len < 3) return pts
  const rel = ptIndex - start
  const prevI = start + ((rel - 1 + len) % len)
  const nextI = start + ((rel + 1) % len)
  const V = pts[ptIndex], P = pts[prevI], N = pts[nextI]
  const v1x = P.x - V.x, v1y = P.y - V.y, v2x = N.x - V.x, v2y = N.y - V.y
  if (Math.hypot(v1x, v1y) < 1e-6 || Math.hypot(v2x, v2y) < 1e-6) return pts
  const cross = v1x * v2y - v1y * v2x
  const cur = Math.atan2(cross, v1x * v2x + v1y * v2y)   // signed angle prev→next in (-π,π]
  const sign = cur < 0 ? -1 : 1
  const target = sign * (deg * Math.PI) / 180
  const rotBy = target - cur
  if (strat === 'in')
    return pts.map((p, i) => i === prevI ? rotPtAround(P, V.x, V.y, -rotBy) : p)
  if (strat === 'split')
    return pts.map((p, i) => i === nextI ? rotPtAround(N, V.x, V.y, rotBy / 2)
                           : i === prevI ? rotPtAround(P, V.x, V.y, -rotBy / 2) : p)
  return pts.map((p, i) => i === nextI ? rotPtAround(N, V.x, V.y, rotBy) : p)
}
function selBBox(els: VectorElement[]): { x: number; y: number; w: number; h: number } | null {
  if (!els.length) return null
  const bs = els.map(elBBox)
  const x = Math.min(...bs.map(b => b.x)), y = Math.min(...bs.map(b => b.y))
  const r = Math.max(...bs.map(b => b.x + b.w)), b = Math.max(...bs.map(b => b.y + b.h))
  return { x, y, w: r - x, h: b - y }
}

// ── Isometry helpers (Illustrator-style symmetry tools) ─────────────────────────
// Rotate an element around an ARBITRARY world pivot. Exact for every element
// type: rendering rotates an element about its own bbox centre, so carrying the
// centre along the rotation and adding the angle reproduces the full isometry.
// Container elements hold children via `parentId` and carry no geometry of their
// own: plain groups and symmetry containers.
function isContainer(el: { type: string }): boolean { return el.type === 'group' || el.type === 'symmetry' }

function rotateElementAround(el: VectorElement, px: number, py: number, angDeg: number): VectorElement {
  if (isContainer(el)) return el
  const rad = (angDeg * Math.PI) / 180, co = Math.cos(rad), si = Math.sin(rad)
  const cx = el.x + el.w / 2, cy = el.y + el.h / 2
  const nx = px + co * (cx - px) - si * (cy - py)
  const ny = py + si * (cx - px) + co * (cy - py)
  const moved = translateEl(el, nx - cx, ny - cy)
  return { ...moved, rotation: (((el.rotation + angDeg) % 360) + 360) % 360 }
}
// Reflect an element across the axis through (cx,cy) at `axisDeg`. Paths get their
// geometry truly mirrored (rotation baked in); symmetric shapes (rect/ellipse) use
// the exact centre+angle identity; text/images keep their content unmirrored
// (position and orientation reflect, like most vector editors' default).
function reflectElement(el: VectorElement, cx: number, cy: number, axisDeg: number): VectorElement {
  if (isContainer(el)) return el
  const a = (axisDeg * Math.PI) / 180
  const dx = Math.cos(a), dy = Math.sin(a)
  const refl = (px: number, py: number): [number, number] => {
    const vx = px - cx, vy = py - cy
    const d = vx * dx + vy * dy
    return [cx + 2 * d * dx - vx, cy + 2 * d * dy - vy]
  }
  const reflVec = (vx: number, vy: number): [number, number] => {
    const d = vx * dx + vy * dy
    return [2 * d * dx - vx, 2 * d * dy - vy]
  }
  if (el.type === 'path') {
    const pe = el as PathElement
    // Bake the element's own rotation into the points, then mirror everything.
    const ecx = el.x + el.w / 2, ecy = el.y + el.h / 2
    const rot = (el.rotation * Math.PI) / 180, rc = Math.cos(rot), rs = Math.sin(rot)
    const bakePt = (px: number, py: number): [number, number] =>
      el.rotation ? [ecx + rc * (px - ecx) - rs * (py - ecy), ecy + rs * (px - ecx) + rc * (py - ecy)] : [px, py]
    const bakeVec = (vx: number, vy: number): [number, number] =>
      el.rotation ? [rc * vx - rs * vy, rs * vx + rc * vy] : [vx, vy]
    const pts = pe.points.map(p => {
      const [bx, by] = bakePt(p.x, p.y)
      const [px2, py2] = refl(bx, by)
      const hIn  = p.hIn  ? reflVec(...bakeVec(p.hIn[0],  p.hIn[1]))  : undefined
      const hOut = p.hOut ? reflVec(...bakeVec(p.hOut[0], p.hOut[1])) : undefined
      return { ...p, x: px2, y: py2, hIn, hOut }
    })
    const bb = pathBounds(pts, pe.closed)
    return { ...pe, points: pts, rotation: 0, x: bb.x, y: bb.y, w: bb.w, h: bb.h }
  }
  const ecx = el.x + el.w / 2, ecy = el.y + el.h / 2
  const [nx, ny] = refl(ecx, ecy)
  const out = { ...el, x: nx - el.w / 2, y: ny - el.h / 2,
    rotation: (((2 * axisDeg - el.rotation) % 360) + 360) % 360 } as VectorElement
  // Asymmetric per-corner radii: remap the corner order under H/V mirrors.
  if (el.type === 'rect' && (el as RectElement).corners) {
    const [tl, tr, br, bl] = (el as RectElement).corners!
    const m = ((axisDeg % 180) + 180) % 180
    if (Math.abs(m - 90) < 45) (out as RectElement).corners = [tr, tl, bl, br]   // vertical axis
    else                       (out as RectElement).corners = [bl, br, tr, tl]   // horizontal axis
  }
  return out
}

// Derived symmetry clones of ONE source element inside a symmetry container.
// Deterministic ids (`<src>::symK`) make reconciliation stable; clones are locked
// (uneditable), parented to the container and tagged so they never recurse.
function genSymClones(container: SymmetryElement, src: VectorElement): VectorElement[] {
  if (isContainer(src) || src.symOf) return []
  const { symMode: mode, cx, cy } = container
  let k = 0
  const mk = (e: VectorElement): VectorElement => {
    const c = structuredClone(e)
    c.id = `${src.id}::sym${k}`
    c.parentId = container.id
    c.symOf = src.id; c.symIdx = k; c.locked = true
    k++
    return c
  }
  // The whole symmetry frame can be rotated (container.rotation): mirror axes turn
  // with it; the 180° and radial rotations are frame-angle-invariant.
  const rot = container.rotation || 0
  const out: VectorElement[] = []
  if (mode === 'v' || mode === 'vh') out.push(mk(reflectElement(src, cx, cy, 90 + rot)))
  if (mode === 'h' || mode === 'vh') out.push(mk(reflectElement(src, cx, cy, 0 + rot)))
  if (mode === 'vh') out.push(mk(rotateElementAround(src, cx, cy, 180)))
  if (mode === 'radial') {
    const n = Math.max(2, Math.min(72, container.symCount))
    for (let j = 1; j < n; j++) out.push(mk(rotateElementAround(src, cx, cy, (j * 360) / n)))
  }
  return out
}
// Inverse of the transform genSymClones applies to make clone `symIdx` — maps a
// canvas point from the clone's frame back to the source's, so edits on a clone can
// be redirected onto its source (all isometries → simple inverses).
function symCloneInverse(container: SymmetryElement, symIdx: number): ((x: number, y: number) => { x: number; y: number }) | null {
  const { symMode: mode, cx, cy } = container
  const rot = container.rotation || 0
  const reflPt = (axisDeg: number) => (x: number, y: number) => {   // reflection is self-inverse
    const a = (axisDeg * Math.PI) / 180, dx = Math.cos(a), dy = Math.sin(a)
    const vx = x - cx, vy = y - cy, d = vx * dx + vy * dy
    return { x: cx + 2 * d * dx - vx, y: cy + 2 * d * dy - vy }
  }
  const rotPt = (ang: number) => (x: number, y: number) => {
    const r = (ang * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r)
    const vx = x - cx, vy = y - cy
    return { x: cx + c * vx - s * vy, y: cy + s * vx + c * vy }
  }
  const list: ((x: number, y: number) => { x: number; y: number })[] = []
  if (mode === 'v' || mode === 'vh') list.push(reflPt(90 + rot))
  if (mode === 'h' || mode === 'vh') list.push(reflPt(0 + rot))
  if (mode === 'vh') list.push(rotPt(-180))
  if (mode === 'radial') {
    const n = Math.max(2, Math.min(72, container.symCount))
    for (let j = 1; j < n; j++) list.push(rotPt(-(j * 360) / n))
  }
  return list[symIdx] ?? null
}
// Apply, to a canvas context, the FORWARD isometry genSymClones used to place clone
// `symIdx`. Reflected clones bake their rotation into points (no `rotation` field), so
// their selection box can't be re-derived from a bbox+angle — instead we draw the
// SOURCE's (correct) box under this transform, landing it exactly on the clone.
function applySymCloneForward(ctx: CanvasRenderingContext2D, container: SymmetryElement, symIdx: number): boolean {
  const { symMode: mode, cx, cy } = container
  const rot = container.rotation || 0
  const list: ({ refl: number } | { rot: number })[] = []
  if (mode === 'v' || mode === 'vh') list.push({ refl: 90 + rot })
  if (mode === 'h' || mode === 'vh') list.push({ refl: 0 + rot })
  if (mode === 'vh') list.push({ rot: 180 })
  if (mode === 'radial') { const n = Math.max(2, Math.min(72, container.symCount)); for (let j = 1; j < n; j++) list.push({ rot: (j * 360) / n }) }
  const t = list[symIdx]; if (!t) return false
  ctx.translate(cx, cy)
  if ('refl' in t) { const a = (t.refl * Math.PI) / 180; ctx.rotate(a); ctx.scale(1, -1); ctx.rotate(-a) }
  else ctx.rotate((t.rot * Math.PI) / 180)
  ctx.translate(-cx, -cy)
  return true
}
// Scale an element by (sx,sy) about `anchor` (given in the frame's LOCAL coords),
// where the frame is rotated by `ang` about pivot (px,py). Used to resize a whole
// container by dragging its (possibly tilted) selection box. Rect/ellipse keep their
// type for axis-aligned scaling; otherwise they fall back to an editable path.
function scaleElementInFrame(el: VectorElement, px: number, py: number, ang: number,
                            ax: number, ay: number, sx: number, sy: number): VectorElement {
  const ar = (ang * Math.PI) / 180, c = Math.cos(ar), s = Math.sin(ar)
  const toLocal = (x: number, y: number): [number, number] => { const dx = x - px, dy = y - py; return [px + c * dx + s * dy, py - s * dx + c * dy] }
  const toWorld = (lx: number, ly: number): [number, number] => { const dx = lx - px, dy = ly - py; return [px + c * dx - s * dy, py + s * dx + c * dy] }
  const M = (x: number, y: number): [number, number] => { const [lx, ly] = toLocal(x, y); return toWorld(ax + (lx - ax) * sx, ay + (ly - ay) * sy) }
  const L = (vx: number, vy: number): [number, number] => { const llx = c * vx + s * vy, lly = -s * vx + c * vy; const X = llx * sx, Y = lly * sy; return [c * X - s * Y, s * X + c * Y] }
  const axisAligned = ang % 360 === 0
  if (el.type === 'symmetry') { const [ncx, ncy] = M((el as SymmetryElement).cx, (el as SymmetryElement).cy); return { ...el, cx: ncx, cy: ncy } as VectorElement }
  if (el.type === 'group') return el   // no geometry — its leaves scale individually
  if (el.type === 'path') {
    const pe = el as PathElement
    const pts = pe.points.map(p => {
      const [nx, ny] = M(p.x, p.y)
      return { ...p, x: nx, y: ny, hIn: p.hIn ? L(p.hIn[0], p.hIn[1]) : undefined, hOut: p.hOut ? L(p.hOut[0], p.hOut[1]) : undefined }
    })
    const bb = pathBounds(pts, pe.closed)
    return { ...pe, points: pts, x: bb.x, y: bb.y, w: bb.w, h: bb.h }
  }
  if (el.type === 'rect' || el.type === 'ellipse') {
    if (axisAligned && !el.rotation) {
      const [x1, y1] = M(el.x, el.y), [x2, y2] = M(el.x + el.w, el.y + el.h)
      const out = { ...el, x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) } as VectorElement
      if (el.type === 'rect' && (el as RectElement).cornerRadius) (out as RectElement).cornerRadius = (el as RectElement).cornerRadius * Math.min(Math.abs(sx), Math.abs(sy))
      return out
    }
    return scaleElementInFrame(toPathElement(el), px, py, ang, ax, ay, sx, sy)
  }
  // text / image: scale position + box (text also scales its size).
  const [x1, y1] = M(el.x, el.y), [x2, y2] = M(el.x + el.w, el.y + el.h)
  const out = { ...el, x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) } as VectorElement
  if (el.type === 'text') (out as TextElement).fontSize = Math.max(1, (el as TextElement).fontSize * Math.abs(sy))
  return out
}
// Rotate a symmetry container's frame around a pivot: spin its centre and add to
// the frame angle. Cascaded to its source leaves (rotated around the same pivot),
// this rigidly turns the whole pattern.
function rotateContainerFrame(c: SymmetryElement, px: number, py: number, angDeg: number): SymmetryElement {
  const r = (angDeg * Math.PI) / 180, co = Math.cos(r), si = Math.sin(r)
  const vx = c.cx - px, vy = c.cy - py
  return { ...c, cx: px + co * vx - si * vy, cy: py + si * vx + co * vy,
    rotation: (((c.rotation + angDeg) % 360) + 360) % 360 }
}
// All derived clones for a symmetry container: every non-clone leaf it contains,
// reflected/rotated. Clones are flattened directly under the container.
function genContainerClones(els: VectorElement[], container: SymmetryElement): VectorElement[] {
  const sources = descendantLeaves(els, container.id).filter(e => !e.symOf)
  const out: VectorElement[] = []
  for (const src of sources) out.push(...genSymClones(container, src))
  return out
}

// ── Hierarchical layers (parentId + `group` container elements) ─────────────────
const ROOT = '__root__'
function pkey(el: { parentId?: string | null }): string { return el.parentId ?? ROOT }
// Direct children of a parent (ROOT for top level), in sibling z-order.
function childrenOf(els: VectorElement[], parentId: string): VectorElement[] {
  return els.filter(e => pkey(e) === parentId).sort((a, b) => a.zIndex - b.zIndex)
}
// All descendant ids of a container (containers + leaves), excluding it.
function descendantIds(els: VectorElement[], groupId: string): Set<string> {
  const out = new Set<string>()
  const walk = (pid: string) => {
    for (const e of els) if (pkey(e) === pid && !out.has(e.id)) { out.add(e.id); if (isContainer(e)) walk(e.id) }
  }
  walk(groupId)
  return out
}
// Non-container descendant leaves of a container.
function descendantLeaves(els: VectorElement[], groupId: string): VectorElement[] {
  return [...descendantIds(els, groupId)].map(id => els.find(e => e.id === id)!).filter(e => e && !isContainer(e))
}
// Expand a selection for a unit MOVE/ROTATE: any selected container also drags its
// whole subtree — source leaves AND sub-containers (nested groups/symmetries carry
// x/y or cx/cy + rotation that must transform too). Clones are regenerated, excluded.
function expandUnitForMove(els: VectorElement[], ids: string[]): string[] {
  const out = new Set(ids)
  for (const id of ids) {
    const el = els.find(e => e.id === id)
    if (el && isContainer(el)) for (const d of descendantIds(els, id)) {
      const de = els.find(e => e.id === d)
      if (de && !de.symOf) out.add(d)
    }
  }
  return [...out]
}
// Nearest ancestor SYMMETRY container of an element (itself if it is one), or null.
// The pattern (sources + clones) is one object; this is the id to select/transform.
function symContainerOf(els: VectorElement[], id: string): string | null {
  let cur = els.find(e => e.id === id)
  const seen = new Set<string>()
  while (cur && !seen.has(cur.id)) {
    if (cur.type === 'symmetry') return cur.id
    seen.add(cur.id)
    cur = cur.parentId ? els.find(e => e.id === cur!.parentId) : undefined
  }
  return null
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
// Single pass to bucket children by parent (was O(n²) with per-node filters).
// Paint-order entry: a leaf to paint, or a clip scope delimiter. `clipEnter`
// carries the mask's leaf shapes (world coords); the renderer clips until the
// matching `clipExit`. Scopes nest with save/restore.
type RenderEntry =
  | { el: VectorElement; alpha: number }
  | { clipEnter: VectorElement[] }
  | { clipExit: true }

function renderOrder(els: VectorElement[]): RenderEntry[] {
  const byParent = new Map<string, VectorElement[]>()
  for (const e of els) {
    const k = pkey(e)
    const arr = byParent.get(k)
    if (arr) arr.push(e); else byParent.set(k, [e])
  }
  for (const arr of byParent.values()) arr.sort((a, b) => a.zIndex - b.zIndex)
  const out: RenderEntry[] = []
  // Leaf shapes of a mask child (itself possibly a container).
  const maskLeaves = (el: VectorElement): VectorElement[] => {
    if (!isContainer(el)) return el.visible ? [el] : []
    return (byParent.get(el.id) ?? []).flatMap(maskLeaves)
  }
  const walk = (parentId: string, vis: boolean, alpha: number) => {
    for (const el of byParent.get(parentId) ?? []) {
      const v = vis && el.visible
      const a = alpha * (el.opacity / 100)
      if (el.type === 'group' && (el as GroupElement).clipped) {
        const kids = byParent.get(el.id) ?? []
        if (!v || kids.length < 2) continue        // mask alone (or hidden): nothing to paint
        const mask = kids[kids.length - 1]         // topmost child = the mask
        const shapes = maskLeaves(mask)
        if (!shapes.length) continue
        out.push({ clipEnter: shapes })
        for (const kid of kids.slice(0, -1)) {
          const kv = v && kid.visible
          const ka = a * (kid.opacity / 100)
          if (isContainer(kid)) walk(kid.id, kv, ka)
          else if (kv) out.push({ el: kid, alpha: ka })
        }
        out.push({ clipExit: true })
      } else if (isContainer(el)) walk(el.id, v, a)
      else if (v) out.push({ el, alpha: a })
    }
  }
  walk(ROOT, true, 1)
  return out
}
// Only the paintable leaves, in paint order — for hit-testing and export flows
// that don't care about clip scopes.
function renderLeaves(els: VectorElement[]): { el: VectorElement; alpha: number }[] {
  return renderOrder(els).filter((e): e is { el: VectorElement; alpha: number } => 'el' in e)
}
// World-space Path2D of a mask shape (its rotation baked in).
function worldClipPath(shapes: VectorElement[]): Path2D {
  const clip = new Path2D()
  for (const m of shapes) {
    const p = elPath2D(m)
    if (!p) continue
    let mtx: DOMMatrix | undefined
    if (m.rotation) {
      const cx = m.x + m.w / 2, cy = m.y + m.h / 2
      mtx = new DOMMatrix().translateSelf(cx, cy).rotateSelf(m.rotation).translateSelf(-cx, -cy)
    }
    clip.addPath(p, mtx)
  }
  return clip
}
// Union bbox of a group's descendant leaves.
function groupBBox(els: VectorElement[], groupId: string): { x: number; y: number; w: number; h: number } | null {
  return selBBox(descendantLeaves(els, groupId))
}
// Oriented bounding box of a container's pattern, tight in the frame's rotated space
// (pivot = symmetry centre). Lets the selection box TILT with the symmetry rotation.
// Returns local AABB (lx,ly,lw,lh) + pivot (px,py) + angle°; draw by rotating the
// canvas by `ang` about (px,py) then using the local rect.
function orientedContainerBox(els: VectorElement[], container: VectorElement):
  { px: number; py: number; ang: number; lx: number; ly: number; lw: number; lh: number } | null {
  const ang = container.rotation || 0   // groups AND symmetries carry a frame angle now
  const gb = groupBBox(els, container.id)
  // Symmetry pivots on its centre; a group pivots on its content AABB centre.
  const px = container.type === 'symmetry' ? (container as SymmetryElement).cx : (gb ? gb.x + gb.w / 2 : 0)
  const py = container.type === 'symmetry' ? (container as SymmetryElement).cy : (gb ? gb.y + gb.h / 2 : 0)
  if (!ang) { if (!gb) return null; return { px, py, ang: 0, lx: gb.x, ly: gb.y, lw: gb.w, lh: gb.h } }
  const a = (-ang * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a)
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const leaf of descendantLeaves(els, container.id)) {
    for (const ring of elementToRings(leaf, 6)) {
      for (const [x, y] of ring) {
        const dx = x - px, dy = y - py
        const lx = px + c * dx - s * dy, ly = py + s * dx + c * dy   // un-rotate around pivot
        if (lx < minX) minX = lx; if (lx > maxX) maxX = lx
        if (ly < minY) minY = ly; if (ly > maxY) maxY = ly
      }
    }
  }
  if (!isFinite(minX)) { if (!gb) return null; return { px, py, ang: 0, lx: gb.x, ly: gb.y, lw: gb.w, lh: gb.h } }
  return { px, py, ang, lx: minX, ly: minY, lw: maxX - minX, lh: maxY - minY }
}
// Remove container elements with no children left (after delete/ungroup). A
// symmetry container is empty when it has no SOURCE (non-clone) child.
function pruneEmptyGroups(els: VectorElement[]): VectorElement[] {
  let cur = els
  for (;;) {
    const empty = new Set(cur.filter(e => isContainer(e) &&
      !cur.some(c => c.parentId === e.id && !c.symOf)).map(e => e.id))
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
  // Symmetry clones are managed by the reconciler — never move them by hand.
  if (drag.symOf) return els
  const newParent: string | null = zone === 'inside' && isContainer(target) ? target.id : (target.parentId ?? null)
  // Guard against dropping a container into itself or a descendant.
  if (isContainer(drag)) {
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
type SnapBox = { x: number; y: number; w: number; h: number }
type SnapCand = { coord: number; box: SnapBox | null }   // box=null for guides (no distance)
// A live snap line: the aligned axis coordinate, plus (when known) the dragged box
// `a` and the neighbour `b` it aligned with — used to draw the distance indicator.
type SnapGuide = { coord: number; a?: SnapBox; b?: SnapBox }
// Candidate snap coordinates: every other element's edges/centre, the artboards,
// and the user guides — each carries its source bbox so we can measure distances.
function snapTargets(pd: VectorPageData, exclude: Set<string>): { xs: SnapCand[]; ys: SnapCand[] } {
  const xs: SnapCand[] = [], ys: SnapCand[] = []
  for (const ab of pd.artboards) {
    const box: SnapBox = { x: ab.x, y: ab.y, w: ab.width, h: ab.height }
    xs.push({ coord: ab.x, box }, { coord: ab.x + ab.width / 2, box }, { coord: ab.x + ab.width, box })
    ys.push({ coord: ab.y, box }, { coord: ab.y + ab.height / 2, box }, { coord: ab.y + ab.height, box })
  }
  for (const el of pd.elements) {
    if (exclude.has(el.id) || !el.visible || isContainer(el)) continue
    const b = elBBox(el)
    const box: SnapBox = { x: b.x, y: b.y, w: b.w, h: b.h }
    xs.push({ coord: b.x, box }, { coord: b.x + b.w / 2, box }, { coord: b.x + b.w, box })
    ys.push({ coord: b.y, box }, { coord: b.y + b.h / 2, box }, { coord: b.y + b.h, box })
  }
  for (const g of pd.guides) (g.type === 'v' ? xs : ys).push({ coord: g.position, box: null })
  return { xs, ys }
}
// Best alignment of any of `positions` to any candidate within `thr`.
function bestSnap(positions: number[], targets: SnapCand[], thr: number): { delta: number; coord: number } | null {
  let best: { delta: number; coord: number } | null = null
  for (const p of positions) {
    for (const tgt of targets) {
      const d = tgt.coord - p
      if (Math.abs(d) <= thr && (!best || Math.abs(d) < Math.abs(best.delta))) best = { delta: d, coord: tgt.coord }
    }
  }
  return best
}
// Distance from point p to segment a-b, with the foot of the perpendicular.
function ptSegDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): { d: number; fx: number; fy: number } {
  const vx = bx - ax, vy = by - ay
  const len2 = vx * vx + vy * vy
  let t = len2 > 1e-9 ? ((px - ax) * vx + (py - ay) * vy) / len2 : 0
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const fx = ax + t * vx, fy = ay + t * vy
  return { d: Math.hypot(px - fx, py - fy), fx, fy }
}
// TANGENT / touch snap: translate `mv` by (ndx,ndy), then find the smallest gap
// between its flattened outline and any nearby element's outline. If the shapes are
// close but not yet touching (0 < gap ≤ thr), return the correction that slides `mv`
// so the two outlines just KISS (tangent contact), plus the contact point for the UI.
function tangentSnap(pd: VectorPageData, mv: VectorElement, ndx: number, ndy: number,
                     exclude: Set<string>, thr: number): { dx: number; dy: number; tx: number; ty: number } | null {
  const mvT = translateEl(mv, ndx, ndy)
  const mvRings = elementToRings(mvT, 14)
  if (!mvRings.length) return null
  const mb = elBBox(mvT)
  let best: { gap: number; dx: number; dy: number; tx: number; ty: number } | null = null
  for (const el of pd.elements) {
    if (exclude.has(el.id) || !el.visible || isContainer(el) || el.type === 'text' || el.type === 'image') continue
    const b = elBBox(el)
    // Proximity reject: bounding boxes must be within the snap band to bother.
    if (b.x - (mb.x + mb.w) > thr || mb.x - (b.x + b.w) > thr ||
        b.y - (mb.y + mb.h) > thr || mb.y - (b.y + b.h) > thr) continue
    const rings = elementToRings(el, 14)
    for (const tr of rings) {
      for (let i = 0; i < tr.length - 1; i++) {
        const [ax, ay] = tr[i], [bx, by] = tr[i + 1]
        for (const mr of mvRings) {
          for (const [px, py] of mr) {
            const { d, fx, fy } = ptSegDist(px, py, ax, ay, bx, by)
            if (d > 0.001 && d <= thr && (!best || d < best.gap)) {
              // Slide the moving point onto the contact foot → outlines touch.
              best = { gap: d, dx: fx - px, dy: fy - py, tx: fx, ty: fy }
            }
          }
        }
      }
    }
  }
  return best ? { dx: best.dx, dy: best.dy, tx: best.tx, ty: best.ty } : null
}
// Signed gap between two boxes along one axis (0 when they overlap on that axis).
// Returns the empty span [from,to] so the distance line can be drawn in the gap.
function axisGap(a: SnapBox, b: SnapBox, axis: 'x' | 'y'): { dist: number; from: number; to: number } {
  const aLo = axis === 'x' ? a.x : a.y, aHi = aLo + (axis === 'x' ? a.w : a.h)
  const bLo = axis === 'x' ? b.x : b.y, bHi = bLo + (axis === 'x' ? b.w : b.h)
  if (aLo >= bHi) return { dist: aLo - bHi, from: bHi, to: aLo }   // a after b
  if (bLo >= aHi) return { dist: bLo - aHi, from: aHi, to: bLo }   // a before b
  const m = Math.max(aLo, bLo)
  return { dist: 0, from: m, to: m }                               // overlap
}
// Build a SnapGuide for `coord` on `axis`: pick the nearest neighbour box (by the
// perpendicular gap) among candidates whose coordinate matches, for the distance UI.
function snapGuideFor(axis: 'x' | 'y', coord: number, moved: SnapBox, cands: SnapCand[]): SnapGuide {
  const perp = axis === 'x' ? 'y' : 'x'
  const seen = new Set<SnapBox>()
  // Prefer the nearest SEPARATED neighbour (positive gap → a meaningful distance);
  // fall back to an overlapping one only if that's all there is.
  let bestGap: { box: SnapBox; dist: number } | null = null
  let bestAny: { box: SnapBox; dist: number } | null = null
  for (const c of cands) {
    if (!c.box || Math.abs(c.coord - coord) > 0.5 || seen.has(c.box)) continue
    seen.add(c.box)
    const g = axisGap(moved, c.box, perp)
    if (!bestAny || g.dist < bestAny.dist) bestAny = { box: c.box, dist: g.dist }
    if (g.dist > 0.05 && (!bestGap || g.dist < bestGap.dist)) bestGap = { box: c.box, dist: g.dist }
  }
  const best = bestGap ?? bestAny
  return best ? { coord, a: moved, b: best.box } : { coord }
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
// ── Predefined-shape library ────────────────────────────────────────────────────
type LibShape = 'arrow' | 'dblarrow' | 'heart' | 'cross' | 'gear' | 'pie' | 'bubble'
              | 'trapezoid' | 'flower' | 'crescent' | 'cloud' | 'drop' | 'spiral'
// Editable parameters per shape kind, rendered as sliders in the properties
// panel. Values live in PathElement.params (ratios 0..1, angles in degrees,
// counts as integers).
const SHAPE_DEFS: Record<LibShape, { key: string; label: string; min: number; max: number; step: number; def: number }[]> = {
  arrow: [
    { key: 'head',  label: 'apex_param_head',  min: 0.1,  max: 0.9,  step: 0.01, def: 0.4 },
    { key: 'shaft', label: 'apex_param_shaft', min: 0.05, max: 0.95, step: 0.01, def: 0.45 },
  ],
  heart: [],
  cross: [
    { key: 'shaft', label: 'apex_param_shaft', min: 0.05, max: 0.95, step: 0.01, def: 0.34 },
  ],
  gear: [
    { key: 'teeth', label: 'apex_param_teeth', min: 4,    max: 40,   step: 1,    def: 8 },
    { key: 'depth', label: 'apex_param_depth', min: 0.4,  max: 0.95, step: 0.01, def: 0.72 },
    { key: 'hole',  label: 'apex_param_hole',  min: 0,    max: 0.8,  step: 0.01, def: 0.35 },
  ],
  pie: [
    { key: 'start', label: 'apex_param_start', min: 0,    max: 360,  step: 1,    def: 0 },
    { key: 'sweep', label: 'apex_param_sweep', min: 5,    max: 360,  step: 1,    def: 270 },
    { key: 'hole',  label: 'apex_param_hole',  min: 0,    max: 0.9,  step: 0.01, def: 0 },
  ],
  bubble: [
    { key: 'round', label: 'apex_param_round', min: 0,    max: 0.5,  step: 0.01, def: 0.22 },
    { key: 'tail',  label: 'apex_param_tail',  min: 0.05, max: 0.5,  step: 0.01, def: 0.22 },
  ],
  dblarrow: [
    { key: 'head',  label: 'apex_param_head',  min: 0.1,  max: 0.9,  step: 0.01, def: 0.35 },
    { key: 'shaft', label: 'apex_param_shaft', min: 0.05, max: 0.95, step: 0.01, def: 0.4 },
  ],
  trapezoid: [
    { key: 'top',   label: 'apex_param_top',   min: 0.05, max: 0.95, step: 0.01, def: 0.6 },
  ],
  flower: [
    { key: 'petals', label: 'apex_param_petals', min: 3,   max: 24,   step: 1,    def: 6 },
    { key: 'depth',  label: 'apex_param_depth',  min: 0.1, max: 0.9,  step: 0.01, def: 0.45 },
  ],
  cloud: [
    { key: 'petals', label: 'apex_param_bumps',  min: 4,   max: 24,   step: 1,    def: 8 },
    { key: 'depth',  label: 'apex_param_depth',  min: 0.3, max: 0.95, step: 0.01, def: 0.8 },
  ],
  crescent: [
    { key: 'depth', label: 'apex_param_depth',  min: 0.05, max: 0.9,  step: 0.01, def: 0.55 },
  ],
  drop: [],
  spiral: [
    { key: 'turns', label: 'apex_param_turns',  min: 1,    max: 8,    step: 1,    def: 3 },
  ],
}
function shapeParam(el: PathElement, key: string): number {
  const def = SHAPE_DEFS[el.shape as LibShape]?.find(d => d.key === key)
  return el.params?.[key] ?? def?.def ?? 0
}
function defaultShapeParams(kind: LibShape): Record<string, number> {
  return Object.fromEntries(SHAPE_DEFS[kind].map(d => [d.key, d.def]))
}

// Right-pointing arrow fitted to the box. head = head length ratio of the
// width, shaft = shaft thickness ratio of the height.
function genArrow(cx: number, cy: number, rx: number, ry: number, head: number, shaft: number): PathPoint[] {
  const x0 = cx - rx, x2 = cx + rx
  const x1 = x2 - head * 2 * rx
  const hs = shaft * ry
  return [
    { x: x0, y: cy - hs }, { x: x1, y: cy - hs }, { x: x1, y: cy - ry },
    { x: x2, y: cy },
    { x: x1, y: cy + ry }, { x: x1, y: cy + hs }, { x: x0, y: cy + hs },
  ]
}
// Bezier heart (classic two-lobe curve), anchors + handles in unit space then
// mapped to the box.
function genHeart(x: number, y: number, w: number, h: number): PathPoint[] {
  // [ux, uy, hInX, hInY, hOutX, hOutY] in unit coordinates (handles relative).
  const U: [number, number, number, number, number, number][] = [
    [0.50, 0.35,  0.00,  0.15,  0.00, -0.15],   // centre dip
    [0.20, 0.00,  0.15,  0.00, -0.15,  0.00],   // left lobe top
    [0.00, 0.35,  0.00, -0.15,  0.00,  0.20],   // left edge
    [0.50, 1.00, -0.30, -0.25,  0.30, -0.25],   // bottom tip
    [1.00, 0.35,  0.00,  0.20,  0.00, -0.15],   // right edge
    [0.80, 0.00,  0.15,  0.00, -0.15,  0.00],   // right lobe top
  ]
  return U.map(([ux, uy, ix, iy, ox, oy]) => ({
    x: x + ux * w, y: y + uy * h,
    hIn:  [ix * w, iy * h] as [number, number],
    hOut: [ox * w, oy * h] as [number, number],
  }))
}
// Plus / cross. shaft = arm thickness ratio.
function genCross(cx: number, cy: number, rx: number, ry: number, shaft: number): PathPoint[] {
  const hx = shaft * rx, hy = shaft * ry
  return [
    { x: cx - hx, y: cy - ry }, { x: cx + hx, y: cy - ry }, { x: cx + hx, y: cy - hy },
    { x: cx + rx, y: cy - hy }, { x: cx + rx, y: cy + hy }, { x: cx + hx, y: cy + hy },
    { x: cx + hx, y: cy + ry }, { x: cx - hx, y: cy + ry }, { x: cx - hx, y: cy + hy },
    { x: cx - rx, y: cy + hy }, { x: cx - rx, y: cy - hy }, { x: cx - hx, y: cy - hy },
  ]
}
// Gear: flat-topped teeth + optional centre hole as a `move` subpath (the
// compound path fills even-odd, so the hole is real).
function genGear(cx: number, cy: number, rx: number, ry: number, teeth: number, depth: number, hole: number): PathPoint[] {
  const out: PathPoint[] = []
  const n = Math.max(4, Math.round(teeth))
  const pitch = (Math.PI * 2) / n
  // Per tooth: 4 vertices — tooth top (2, at outer radius) then valley (2, at inner).
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + i * pitch
    const angles = [a - pitch * 0.18, a + pitch * 0.18, a + pitch * 0.30, a + pitch * 0.70]
    const radii  = [1, 1, depth, depth]
    for (let k = 0; k < 4; k++) {
      out.push({ x: cx + rx * radii[k] * Math.cos(angles[k]), y: cy + ry * radii[k] * Math.sin(angles[k]) })
    }
  }
  if (hole > 0.02) {
    const kb = 0.5522847498
    const hrx = rx * hole, hry = ry * hole
    out.push(
      { x: cx,       y: cy - hry, move: true, hIn: [-kb * hrx, 0], hOut: [kb * hrx, 0] },
      { x: cx + hrx, y: cy,       hIn: [0, -kb * hry], hOut: [0, kb * hry] },
      { x: cx,       y: cy + hry, hIn: [kb * hrx, 0],  hOut: [-kb * hrx, 0] },
      { x: cx - hrx, y: cy,       hIn: [0, kb * hry],  hOut: [0, -kb * hry] },
    )
  }
  return out
}
// Elliptical arc (a0 → a1, ≤ 2π) as bezier anchors+handles, appended to `out`.
// `move` starts a new subpath at the first anchor.
function arcAnchors(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number, move: boolean): PathPoint[] {
  const out: PathPoint[] = []
  const total = a1 - a0
  const segs = Math.max(1, Math.ceil(Math.abs(total) / (Math.PI / 2)))
  const step = total / segs
  const k = (4 / 3) * Math.tan(step / 4)   // bezier arc constant per segment
  for (let i = 0; i <= segs; i++) {
    const a = a0 + i * step
    const cos = Math.cos(a), sin = Math.sin(a)
    const p: PathPoint = { x: cx + rx * cos, y: cy + ry * sin }
    // Tangent direction scaled by k gives the handle vectors.
    if (i > 0)    p.hIn  = [rx * sin * k, -ry * cos * k]
    if (i < segs) p.hOut = [-rx * sin * k, ry * cos * k]
    if (i === 0 && move) p.move = true
    out.push(p)
  }
  return out
}
// Pie / donut segment: outer arc, then either the centre or a reverse inner arc.
function genPie(cx: number, cy: number, rx: number, ry: number, startDeg: number, sweepDeg: number, hole: number): PathPoint[] {
  const a0 = ((startDeg - 90) * Math.PI) / 180
  const sweep = (Math.max(1, Math.min(360, sweepDeg)) * Math.PI) / 180
  const full = sweep >= Math.PI * 2 - 1e-4
  const outer = arcAnchors(cx, cy, rx, ry, a0, a0 + (full ? Math.PI * 2 : sweep), false)
  if (full) outer.pop()   // full circle: last anchor duplicates the first
  if (hole > 0.02) {
    const inner = arcAnchors(cx, cy, rx * hole, ry * hole, a0 + (full ? Math.PI * 2 : sweep), a0, full)
    if (full) inner.pop()
    return [...outer, ...inner]
  }
  if (full) return outer
  return [...outer, { x: cx, y: cy }]
}
// Speech bubble: rounded rectangle over ~the top of the box + a tail reaching
// the bottom-left corner. round = corner ratio, tail = tail width ratio.
function genBubble(x: number, y: number, w: number, h: number, round: number, tail: number): PathPoint[] {
  const bodyH = h * 0.78
  const c = Math.min(round * Math.min(w, bodyH), w / 2, bodyH / 2)
  const kb = c * 0.5522847498
  const by = y + bodyH
  const tx0 = x + w * 0.18                       // tail attach (left)
  const tx1 = Math.min(x + w * 0.18 + w * tail, x + w - c)
  const pts: PathPoint[] = [
    { x: x + c,     y: y,       hIn: [-kb, 0] },
    { x: x + w - c, y: y,       hOut: [kb, 0] },
    { x: x + w,     y: y + c,   hIn: [0, -kb] },
    { x: x + w,     y: by - c,  hOut: [0, kb] },
    { x: x + w - c, y: by,      hIn: [kb, 0] },
    // tail: attaches on the bottom edge, tip at the bottom-left of the box
    { x: tx1,       y: by },
    { x: x + w * 0.10, y: y + h },
    { x: tx0,       y: by },
    { x: x + c,     y: by,      hOut: [-kb, 0] },
    { x: x,         y: by - c,  hIn: [0, kb] },
    { x: x,         y: y + c,   hOut: [0, -kb] },
  ]
  return pts
}

// Give a closed polygon smooth Catmull-Rom handles (puffy outline) — used by
// the flower and cloud shapes on top of the star skeleton.
function smoothClosed(pts: PathPoint[], amount = 0.25): PathPoint[] {
  const n = pts.length
  return pts.map((p, i) => {
    const prev = pts[(i - 1 + n) % n], next = pts[(i + 1) % n]
    const tx = (next.x - prev.x) * amount, ty = (next.y - prev.y) * amount
    return { ...p, hIn: [-tx, -ty] as [number, number], hOut: [tx, ty] as [number, number] }
  })
}
// Trapezoid. top = top-edge width ratio of the full width.
function genTrapezoid(x: number, y: number, w: number, h: number, top: number): PathPoint[] {
  return [
    { x: x + (w * (1 - top)) / 2, y }, { x: x + (w * (1 + top)) / 2, y },
    { x: x + w, y: y + h }, { x, y: y + h },
  ]
}
// Double-headed horizontal arrow.
function genDblArrow(cx: number, cy: number, rx: number, ry: number, head: number, shaft: number): PathPoint[] {
  const x0 = cx - rx, x3 = cx + rx
  const hl = head * rx, hs = shaft * ry
  return [
    { x: x0, y: cy }, { x: x0 + hl, y: cy - ry }, { x: x0 + hl, y: cy - hs },
    { x: x3 - hl, y: cy - hs }, { x: x3 - hl, y: cy - ry }, { x: x3, y: cy },
    { x: x3 - hl, y: cy + ry }, { x: x3 - hl, y: cy + hs },
    { x: x0 + hl, y: cy + hs }, { x: x0 + hl, y: cy + ry },
  ]
}
// Crescent moon: outer right-bulging semicircle + shallower return arc.
function genCrescent(cx: number, cy: number, rx: number, ry: number, depth: number): PathPoint[] {
  const outer = arcAnchors(cx, cy, rx, ry, -Math.PI / 2, Math.PI / 2, false)
  const inner = arcAnchors(cx, cy, rx * (1 - depth), ry, Math.PI / 2, -Math.PI / 2, false)
  // Drop the duplicated junction anchors.
  inner.shift(); inner.pop()
  return [...outer, ...inner]
}
// Teardrop: pointed top, round belly.
function genDrop(x: number, y: number, w: number, h: number): PathPoint[] {
  const cx = x + w / 2
  const kb = 0.5522847498 * (w / 2)
  const belly = y + h * 0.62
  return [
    { x: cx, y },                                                     // sharp tip
    { x: x + w, y: belly, hIn: [0, -h * 0.28], hOut: [0, kb] },
    { x: cx, y: y + h, hIn: [kb, 0], hOut: [-kb, 0] },
    { x, y: belly, hIn: [0, kb], hOut: [0, -h * 0.28] },
  ]
}
// Archimedean spiral (open, stroke-only): anchors every quarter turn with
// Catmull-Rom handles.
function genSpiral(x: number, y: number, w: number, h: number, turns: number): PathPoint[] {
  const n = Math.max(1, Math.round(turns))
  const steps = n * 8
  const raw: { x: number; y: number }[] = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const a = t * n * Math.PI * 2 - Math.PI / 2
    const r = t
    raw.push({ x: Math.cos(a) * r, y: Math.sin(a) * r })
  }
  const pts: PathPoint[] = raw.map((p, i) => {
    const prev = raw[Math.max(0, i - 1)], next = raw[Math.min(raw.length - 1, i + 1)]
    return { x: p.x, y: p.y, hIn: [-(next.x - prev.x) / 6, -(next.y - prev.y) / 6], hOut: [(next.x - prev.x) / 6, (next.y - prev.y) / 6] }
  })
  return fitPointsToBox(pts, x, y, w, h, false)
}

// Regenerate a parametric shape's points from its bounding box + params,
// so changing the parameters keeps it centred and fitted to the same box.
function regenShapePoints(el: PathElement): PathPoint[] {
  const cx = el.x + el.w / 2, cy = el.y + el.h / 2, rx = el.w / 2, ry = el.h / 2
  // Uniform corner rounding (fillets) for the sharp-cornered shapes, driven by
  // params.cornerRadius (absolute px); 0 keeps the original sharp vertices.
  const cr = el.params?.cornerRadius ?? 0
  if (el.shape === 'star')
    return roundCorners(genStar(cx, cy, rx, ry, Math.max(3, Math.round(el.spikes ?? 5)),
                   Math.max(0.05, Math.min(0.95, el.innerRatio ?? 0.45))), cr)
  if (el.shape === 'polygon')
    return roundCorners(genPolygon(cx, cy, rx, ry, Math.max(3, Math.round(el.sides ?? 6))), cr)
  if (el.shape === 'arrow')  return genArrow(cx, cy, rx, ry, shapeParam(el, 'head'), shapeParam(el, 'shaft'))
  if (el.shape === 'heart')  return genHeart(el.x, el.y, el.w, el.h)
  if (el.shape === 'cross')  return genCross(cx, cy, rx, ry, shapeParam(el, 'shaft'))
  if (el.shape === 'gear')   return genGear(cx, cy, rx, ry, shapeParam(el, 'teeth'), shapeParam(el, 'depth'), shapeParam(el, 'hole'))
  // A partial pie doesn't fill its generation circle — refit so the stored
  // bbox and the geometry always agree (keeps regeneration idempotent).
  if (el.shape === 'pie')    return fitPointsToBox(genPie(cx, cy, rx, ry, shapeParam(el, 'start'), shapeParam(el, 'sweep'), shapeParam(el, 'hole')), el.x, el.y, el.w, el.h)
  if (el.shape === 'bubble') return genBubble(el.x, el.y, el.w, el.h, shapeParam(el, 'round'), shapeParam(el, 'tail'))
  if (el.shape === 'dblarrow')  return genDblArrow(cx, cy, rx, ry, shapeParam(el, 'head'), shapeParam(el, 'shaft'))
  if (el.shape === 'trapezoid') return roundCorners(genTrapezoid(el.x, el.y, el.w, el.h, shapeParam(el, 'top')), cr)
  if (el.shape === 'flower')    return smoothClosed(genStar(cx, cy, rx, ry, Math.max(3, Math.round(shapeParam(el, 'petals'))), shapeParam(el, 'depth')), 0.3)
  if (el.shape === 'cloud')     return fitPointsToBox(smoothClosed(genStar(cx, cy, rx, ry, Math.max(4, Math.round(shapeParam(el, 'petals'))), shapeParam(el, 'depth')), 0.22), el.x, el.y, el.w, el.h)
  if (el.shape === 'crescent')  return fitPointsToBox(genCrescent(cx, cy, rx, ry, shapeParam(el, 'depth')), el.x, el.y, el.w, el.h)
  if (el.shape === 'drop')      return genDrop(el.x, el.y, el.w, el.h)
  if (el.shape === 'spiral')    return genSpiral(el.x, el.y, el.w, el.h, shapeParam(el, 'turns'))
  return el.points
}
// Affine-map points (and their handles) so their true bounds fill the target box.
function fitPointsToBox(pts: PathPoint[], x: number, y: number, w: number, h: number, closed = true): PathPoint[] {
  const b = pathBounds(pts, closed)
  if (b.w < 1e-6 || b.h < 1e-6) return pts
  const sx = w / b.w, sy = h / b.h
  return pts.map(p => ({
    ...p,
    x: x + (p.x - b.x) * sx,
    y: y + (p.y - b.y) * sy,
    hIn:  p.hIn  ? [p.hIn[0]  * sx, p.hIn[1]  * sy] as [number, number] : p.hIn,
    hOut: p.hOut ? [p.hOut[0] * sx, p.hOut[1] * sy] as [number, number] : p.hOut,
  }))
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
  // A symmetry container carries its centre so the whole pattern translates rigidly.
  if (c.type === 'symmetry') { (c as SymmetryElement).cx += dx; (c as SymmetryElement).cy += dy }
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
    const re = el as import('./api').RectElement
    const r = re.cornerRadius ?? 0
    const rr = re.corners ?? [r, r, r, r]
    if (rr.some(v => v > 0)) {
      // Per-corner radii [TL, TR, BR, BL]: two anchors per rounded corner, one
      // per sharp corner (radius 0), clockwise from after the TL corner.
      const cs = rr.map(v => Math.min(Math.max(0, v), w / 2, h / 2))
      const ks = cs.map(c => c * 0.5522847498)
      points = []
      const add = (px: number, py: number, hIn?: [number, number], hOut?: [number, number]) => {
        const prev = points[points.length - 1]
        if (prev && Math.abs(prev.x - px) < 1e-6 && Math.abs(prev.y - py) < 1e-6) {
          if (hOut) prev.hOut = hOut     // merge coincident sharp-corner anchors
          return
        }
        points.push({ x: px, y: py, ...(hIn ? { hIn } : {}), ...(hOut ? { hOut } : {}) })
      }
      add(x + cs[0], y, cs[0] ? [-ks[0], 0] : undefined)                      // TL exit
      add(x + w - cs[1], y, undefined, cs[1] ? [ks[1], 0] : undefined)        // TR entry
      add(x + w, y + cs[1], cs[1] ? [0, -ks[1]] : undefined)                  // TR exit
      add(x + w, y + h - cs[2], undefined, cs[2] ? [0, ks[2]] : undefined)    // BR entry
      add(x + w - cs[2], y + h, cs[2] ? [ks[2], 0] : undefined)               // BR exit
      add(x + cs[3], y + h, undefined, cs[3] ? [-ks[3], 0] : undefined)       // BL entry
      add(x, y + h - cs[3], cs[3] ? [0, ks[3]] : undefined)                   // BL exit
      add(x, y + cs[0], undefined, cs[0] ? [0, -ks[0]] : undefined)           // TL entry
    } else {
      points = [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }]
    }
  }
  const { cornerRadius: _cr, corners: _co, ...rest } = el as import('./api').RectElement & VectorElement
  void _co
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
// Inverse of worldToLocal: element-local point → world (rotation-aware).
function localToWorld(px: number, py: number, el: VectorElement): { x: number; y: number } {
  if (!el.rotation) return { x: px, y: py }
  const cx = el.x + el.w / 2, cy = el.y + el.h / 2
  const a = (el.rotation * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a)
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

// ── Node (anchor) type conversion — direct-selection contextual toolbar ─────────
// Affinity-style node kinds: sharp (cusp, no handles), smooth (colinear handles),
// symmetric (mirrored equal-length handles), smart (auto tangent from neighbours).
type AnchorType = 'sharp' | 'smooth' | 'symmetric' | 'smart'

// Neighbours of anchor `idx` within its own subpath (bounded by `move` markers),
// honouring open ends and the closed wrap. Returns null on an open endpoint side.
function anchorNeighbours(pts: PathPoint[], idx: number, closed: boolean): { prev: PathPoint | null; next: PathPoint | null } {
  let start = 0
  for (let i = idx; i >= 0; i--) { if (i === 0 || pts[i].move) { start = i; break } }
  let end = pts.length - 1
  for (let i = idx + 1; i < pts.length; i++) { if (pts[i].move) { end = i - 1; break } }
  const n = end - start + 1
  const rel = idx - start
  // Inner compound subpaths (started by a `move`, or not the trailing one) are rings;
  // the trailing/only subpath follows the element's own `closed` flag.
  const isTrailing = end === pts.length - 1
  const subClosed = (start > 0 || !isTrailing) ? true : closed
  const prev = rel > 0 ? pts[start + rel - 1] : (subClosed && n > 1 ? pts[end] : null)
  const next = rel < n - 1 ? pts[start + rel + 1] : (subClosed && n > 1 ? pts[start] : null)
  return { prev, next }
}

function convertAnchor(path: PathElement, idx: number, type: AnchorType): PathElement {
  const pts = path.points.map(p => ({
    ...p,
    hIn:  p.hIn  ? [p.hIn[0],  p.hIn[1]]  as [number, number] : undefined,
    hOut: p.hOut ? [p.hOut[0], p.hOut[1]] as [number, number] : undefined,
  }))
  const p = pts[idx]
  if (!p) return path
  // Only the auto-smooth type keeps the live `auto` flag; every other type is manual.
  if (type !== 'smart') delete p.auto
  if (type === 'sharp') { delete p.hIn; delete p.hOut; return { ...path, points: pts } }
  const { prev, next } = anchorNeighbours(pts, idx, path.closed)
  // Tangent direction: chord prev→next, falling back to whichever neighbour exists.
  let tx: number, ty: number
  if (prev && next) { tx = next.x - prev.x; ty = next.y - prev.y }
  else if (next)    { tx = next.x - p.x;   ty = next.y - p.y }
  else if (prev)    { tx = p.x - prev.x;   ty = p.y - prev.y }
  else return { ...path, points: pts }
  const tl = Math.hypot(tx, ty) || 1
  tx /= tl; ty /= tl
  const dPrev = prev ? Math.hypot(p.x - prev.x, p.y - prev.y) : 0
  const dNext = next ? Math.hypot(next.x - p.x, next.y - p.y) : 0
  if (type === 'symmetric') {
    const cur = Math.max(
      p.hIn  ? Math.hypot(p.hIn[0],  p.hIn[1])  : 0,
      p.hOut ? Math.hypot(p.hOut[0], p.hOut[1]) : 0,
    )
    const L = cur > 0.01 ? cur : ((dPrev + dNext) / 2) * 0.33
    p.hIn  = prev ? [-tx * L, -ty * L] : undefined
    p.hOut = next ? [ tx * L,  ty * L] : undefined
  } else if (type === 'smart') {
    // Auto-smooth: mark it so the handles keep re-deriving from the neighbours.
    p.auto = true
    p.hIn  = prev ? [-tx * dPrev * 0.33, -ty * dPrev * 0.33] : undefined
    p.hOut = next ? [ tx * dNext * 0.33,  ty * dNext * 0.33] : undefined
  } else { // smooth: colinear, preserving existing handle magnitudes where present.
    const inLen  = p.hIn  ? Math.hypot(p.hIn[0],  p.hIn[1])  : dPrev * 0.33
    const outLen = p.hOut ? Math.hypot(p.hOut[0], p.hOut[1]) : dNext * 0.33
    p.hIn  = prev ? [-tx * inLen,  -ty * inLen]  : undefined
    p.hOut = next ? [ tx * outLen,  ty * outLen] : undefined
  }
  return { ...path, points: pts }
}

// Recompute the handles of every auto-smooth anchor from its current neighbours,
// so they re-adjust live whenever an adjacent anchor is moved/added/removed.
function reflowAuto(points: PathPoint[], closed: boolean): PathPoint[] {
  if (!points.some(p => p.auto)) return points
  const pts = points.map(p => ({ ...p }))
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]
    if (!p.auto) continue
    const { prev, next } = anchorNeighbours(pts, i, closed)
    let tx: number, ty: number
    if (prev && next) { tx = next.x - prev.x; ty = next.y - prev.y }
    else if (next)    { tx = next.x - p.x;   ty = next.y - p.y }
    else if (prev)    { tx = p.x - prev.x;   ty = p.y - prev.y }
    else continue
    const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl
    const dPrev = prev ? Math.hypot(p.x - prev.x, p.y - prev.y) : 0
    const dNext = next ? Math.hypot(next.x - p.x, next.y - p.y) : 0
    p.hIn  = prev ? [-tx * dPrev * 0.33, -ty * dPrev * 0.33] : undefined
    p.hOut = next ? [ tx * dNext * 0.33,  ty * dNext * 0.33] : undefined
  }
  return pts
}

// Are two handle vectors colinear and opposite (a smooth/symmetric tangent)?
function handlesColinear(a?: [number, number], b?: [number, number]): boolean {
  if (!a || !b) return false
  const la = Math.hypot(a[0], a[1]), lb = Math.hypot(b[0], b[1])
  if (la < 1e-6 || lb < 1e-6) return false
  const cross = a[0] * b[1] - a[1] * b[0]
  const dot   = a[0] * b[0] + a[1] * b[1]
  return Math.abs(cross) < la * lb * 0.08 && dot < 0
}

// Classify an anchor for toolbar active-state highlighting (null = cusp/broken).
function classifyAnchor(path: PathElement, idx: number): AnchorType | null {
  const p = path.points[idx]
  if (!p) return null
  if (p.auto) return 'smart'
  if (!p.hIn && !p.hOut) return 'sharp'
  if (!p.hIn || !p.hOut) return 'smooth'
  const inL = Math.hypot(p.hIn[0], p.hIn[1]), outL = Math.hypot(p.hOut[0], p.hOut[1])
  const cross = p.hIn[0] * p.hOut[1] - p.hIn[1] * p.hOut[0]
  const dot   = p.hIn[0] * p.hOut[0] + p.hIn[1] * p.hOut[1]
  const colinear = Math.abs(cross) < inL * outL * 0.03 && dot < 0
  if (!colinear) return null
  return Math.abs(inL - outL) < Math.max(inL, outL, 1) * 0.06 ? 'symmetric' : 'smooth'
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

// Key a flattened vertex for the boolean-op vertex-tag map (see elementToRings).
// polygon-clipping passes non-intersection input vertices through with their exact
// float coordinates, so a fixed-precision string key matches them reliably.
function ringTagKey(x: number, y: number): string { return x.toFixed(6) + ',' + y.toFixed(6) }
// Per-vertex tag recorded while flattening for the boolean pipeline: role of the
// vertex (0 curve-interior sample, 1 smooth anchor, 2 corner anchor) plus, for
// anchors, the EXACT unit tangents (incoming travel direction `i`, outgoing `o`)
// derived from the Bézier handles — letting the refit reproduce the original
// cubics with zero error instead of estimating tangents from the polygon.
type VertexTag = { f: 0 | 1 | 2; ix?: number; iy?: number; ox?: number; oy?: number }
// Analytic tangents at anchor `sub[i]`: incoming/outgoing directions of travel and
// whether they diverge (a genuine CORNER) — tightly-curved-but-smooth anchors
// (star tips, blob lobes) are NOT corners.
function anchorTangents(sub: PathPoint[], i: number): { corner: boolean; din: [number, number] | null; dout: [number, number] | null } {
  const n = sub.length
  const p = sub[i], prev = sub[(i - 1 + n) % n], next = sub[(i + 1) % n]
  const din: [number, number] = p.hIn ? [-p.hIn[0], -p.hIn[1]]
    : prev.hOut ? [p.x - prev.x - prev.hOut[0], p.y - prev.y - prev.hOut[1]]
    : [p.x - prev.x, p.y - prev.y]
  const dout: [number, number] = p.hOut ? [p.hOut[0], p.hOut[1]]
    : next.hIn ? [next.x + next.hIn[0] - p.x, next.y + next.hIn[1] - p.y]
    : [next.x - p.x, next.y - p.y]
  const li = Math.hypot(din[0], din[1]), lo = Math.hypot(dout[0], dout[1])
  const dinN = li > 1e-9 ? [din[0] / li, din[1] / li] as [number, number] : null
  const doutN = lo > 1e-9 ? [dout[0] / lo, dout[1] / lo] as [number, number] : null
  const corner = !dinN || !doutN || (dinN[0] * doutN[0] + dinN[1] * doutN[1]) < Math.cos((28 * Math.PI) / 180)
  return { corner, din: dinN, dout: doutN }
}

// Flatten an element into one or more closed polygon rings (true world coords).
// When `tags` is given, every emitted vertex is recorded: key → 0 (curve-interior
// sample), 1 (smooth anchor) or 2 (corner anchor). The boolean pipeline uses this
// to rebuild results with the ORIGINAL node structure: intersection points
// (unmatched vertices) and corner anchors are sharp breaks, smooth anchors are
// smooth fit boundaries — so untouched outline portions keep exactly their source
// anchors (minimal, mirror-symmetric node count), no angle guessing involved.
function elementToRings(el: VectorElement, steps = 20, tags?: Map<string, VertexTag>): PCRing[] {
  if (el.type === 'text' || el.type === 'group' || el.type === 'symmetry' || el.type === 'image') return []
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
    // Tangent vectors must follow the element's rotation like the positions do.
    const rot = el.rotation ? (el.rotation * Math.PI) / 180 : 0
    const rc = Math.cos(rot), rs = Math.sin(rot)
    const tagAnchor = (w: [number, number], idx: number) => {
      if (!tags) return
      const { corner, din, dout } = anchorTangents(sub, idx)
      const tg: VertexTag = { f: corner ? 2 : 1 }
      if (din)  { tg.ix = rc * din[0]  - rs * din[1];  tg.iy = rs * din[0]  + rc * din[1] }
      if (dout) { tg.ox = rc * dout[0] - rs * dout[1]; tg.oy = rs * dout[0] + rc * dout[1] }
      tags.set(ringTagKey(w[0], w[1]), tg)
    }
    const first = bakeRotation(el, sub[0].x, sub[0].y)
    const ring: PCRing = [first]
    tagAnchor(first, 0)
    for (let i = 0; i < sub.length; i++) {
      const a = sub[i], b = sub[(i + 1) % sub.length]   // closing segment wraps to start
      const samples = sampleCubic(a, b, steps)
      for (let s = 0; s < samples.length; s++) {
        const w = bakeRotation(el, samples[s][0], samples[s][1])
        ring.push(w)
        // Last sample of the segment IS the anchor `b`; the rest are curve interior.
        if (s === samples.length - 1) tagAnchor(w, (i + 1) % sub.length)
        else if (tags) tags.set(ringTagKey(w[0], w[1]), { f: 0 })
      }
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

// ── Least-squares cubic Bézier fitting (Schneider) ──────────────────────────────
// Used to rebuild faithful Béziers from the dense polygon that boolean ops produce,
// so unions/intersections of curved shapes keep their curves instead of faceting.
type FPt = { x: number; y: number }
const fSub = (a: FPt, b: FPt): FPt => ({ x: a.x - b.x, y: a.y - b.y })
const fAdd = (a: FPt, b: FPt): FPt => ({ x: a.x + b.x, y: a.y + b.y })
const fMul = (a: FPt, s: number): FPt => ({ x: a.x * s, y: a.y * s })
const fDot = (a: FPt, b: FPt): number => a.x * b.x + a.y * b.y
const fLen = (a: FPt): number => Math.hypot(a.x, a.y)
const fNorm = (a: FPt): FPt => { const l = fLen(a) || 1; return { x: a.x / l, y: a.y / l } }
const fDist = (a: FPt, b: FPt): number => Math.hypot(a.x - b.x, a.y - b.y)
const bB0 = (u: number) => (1 - u) ** 3, bB1 = (u: number) => 3 * (1 - u) ** 2 * u
const bB2 = (u: number) => 3 * (1 - u) * u * u, bB3 = (u: number) => u ** 3
function bezAt(c: FPt[], u: number): FPt {
  return { x: bB0(u) * c[0].x + bB1(u) * c[1].x + bB2(u) * c[2].x + bB3(u) * c[3].x,
           y: bB0(u) * c[0].y + bB1(u) * c[1].y + bB2(u) * c[2].y + bB3(u) * c[3].y }
}
// Chord-length parameters normalised to [0,1].
function chordU(pts: FPt[]): number[] {
  const u = [0]
  for (let i = 1; i < pts.length; i++) u.push(u[i - 1] + fDist(pts[i], pts[i - 1]))
  const tot = u[u.length - 1] || 1
  return u.map(v => v / tot)
}
// Fit one cubic to pts given unit end tangents (t1 outward at start, t2 outward at
// end, i.e. pointing back into the curve) via the least-squares normal equations.
function fitOneCubic(pts: FPt[], u: number[], t1: FPt, t2: FPt): FPt[] {
  const n = pts.length, p0 = pts[0], p3 = pts[n - 1]
  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0
  for (let i = 0; i < n; i++) {
    const a1 = fMul(t1, bB1(u[i])), a2 = fMul(t2, bB2(u[i]))
    c00 += fDot(a1, a1); c01 += fDot(a1, a2); c11 += fDot(a2, a2)
    const part = fAdd(fMul(p0, bB0(u[i]) + bB1(u[i])), fMul(p3, bB2(u[i]) + bB3(u[i])))
    const tmp = fSub(pts[i], part)
    x0 += fDot(a1, tmp); x1 += fDot(a2, tmp)
  }
  const det = c00 * c11 - c01 * c01
  let a1len = det !== 0 ? (c11 * x0 - c01 * x1) / det : 0
  let a2len = det !== 0 ? (c00 * x1 - c01 * x0) / det : 0
  const seg = fDist(p0, p3)
  // Degenerate systems (thin/looping runs, bad tangents) can solve to negative or
  // ENORMOUS handle lengths — the classic "spikes shooting across the canvas".
  // Clamp to the Wu/Schneider fallback; the error check then splits the run.
  const maxA = seg * 1.5
  if (!isFinite(a1len) || !isFinite(a2len) ||
      a1len < 1e-6 * seg || a2len < 1e-6 * seg || a1len > maxA || a2len > maxA) { a1len = a2len = seg / 3 }
  return [p0, fAdd(p0, fMul(t1, a1len)), fAdd(p3, fMul(t2, a2len)), p3]
}
// First/second derivative of a cubic at u (for Newton reparameterization).
function bezD1(c: FPt[], u: number): FPt {
  const t = 1 - u
  const d0 = fMul(fSub(c[1], c[0]), 3), d1 = fMul(fSub(c[2], c[1]), 3), d2 = fMul(fSub(c[3], c[2]), 3)
  return { x: t * t * d0.x + 2 * t * u * d1.x + u * u * d2.x, y: t * t * d0.y + 2 * t * u * d1.y + u * u * d2.y }
}
function bezD2(c: FPt[], u: number): FPt {
  const e0 = fMul({ x: c[2].x - 2 * c[1].x + c[0].x, y: c[2].y - 2 * c[1].y + c[0].y }, 6)
  const e1 = fMul({ x: c[3].x - 2 * c[2].x + c[1].x, y: c[3].y - 2 * c[2].y + c[1].y }, 6)
  return { x: (1 - u) * e0.x + u * e1.x, y: (1 - u) * e0.y + u * e1.y }
}
// One Newton-Raphson step moving each parameter toward the point's true closest u.
function reparamRun(pts: FPt[], u: number[], c: FPt[]): number[] {
  return u.map((ui, i) => {
    const q = bezAt(c, ui), q1 = bezD1(c, ui), q2 = bezD2(c, ui)
    const d = fSub(q, pts[i])
    const den = q1.x * q1.x + q1.y * q1.y + d.x * q2.x + d.y * q2.y
    if (Math.abs(den) < 1e-12) return ui
    const nu = ui - (d.x * q1.x + d.y * q1.y) / den
    return nu < 0 ? 0 : nu > 1 ? 1 : nu
  })
}
function maxErrorOf(pts: FPt[], c: FPt[], u: number[]): [number, number] {
  let maxErr = 0, split = Math.floor(pts.length / 2)
  for (let i = 1; i < pts.length - 1; i++) { const d = fDist(bezAt(c, u[i]), pts[i]); if (d > maxErr) { maxErr = d; split = i } }
  return [maxErr, split]
}
// Recursively fit an OPEN run of points, splitting at the worst error. Cubics are
// pushed (in order) to `out`. Reparameterization (Newton) tightens the parameter
// values so a single cubic covers a much larger arc → far fewer, cleaner nodes.
function fitRun(pts: FPt[], t1: FPt, t2: FPt, tol: number, out: FPt[][], depth = 0): void {
  const n = pts.length
  if (n === 2) {
    const d = fDist(pts[0], pts[1]) / 3
    out.push([pts[0], fAdd(pts[0], fMul(t1, d)), fAdd(pts[1], fMul(t2, d)), pts[1]])
    return
  }
  let u = chordU(pts)
  let c = fitOneCubic(pts, u, t1, t2)
  let [maxErr, split] = maxErrorOf(pts, c, u)
  if (maxErr <= tol) { out.push(c); return }
  // Close enough → try to converge by reparameterizing instead of splitting.
  if (maxErr <= tol * 4 && depth <= 24) {
    for (let it = 0; it < 4; it++) {
      u = reparamRun(pts, u, c)
      c = fitOneCubic(pts, u, t1, t2)
      ;[maxErr, split] = maxErrorOf(pts, c, u)
      if (maxErr <= tol) { out.push(c); return }
    }
  }
  if (depth > 24) { out.push(c); return }
  const v1 = fSub(pts[split - 1], pts[split]), v2 = fSub(pts[split], pts[split + 1])
  const tc = fNorm({ x: (v1.x + v2.x) / 2, y: (v1.y + v2.y) / 2 })
  fitRun(pts.slice(0, split + 1), t1, tc, tol, out, depth + 1)
  fitRun(pts.slice(split), fMul(tc, -1), t2, tol, out, depth + 1)
}
// Convert an ordered, closed list of cubics (each P3 == next P0, last P3 == first
// P0) into closed PathPoints: each anchor carries hOut from its cubic and hIn from
// the previous cubic — colinear where the fit is smooth, a cusp at real corners.
function cubicsToPathPoints(cubics: FPt[][], startMove: boolean): PathPoint[] {
  const out: PathPoint[] = []
  const m = cubics.length
  for (let k = 0; k < m; k++) {
    const cur = cubics[k], prev = cubics[(k - 1 + m) % m]
    const a = cur[0]
    const hOut = fSub(cur[1], a), hIn = fSub(prev[2], prev[3])
    const p: PathPoint = { x: a.x, y: a.y, move: k === 0 && startMove ? true : undefined }
    if (fLen(hOut) > 1e-4) p.hOut = [hOut.x, hOut.y]
    if (fLen(hIn) > 1e-4) p.hIn = [hIn.x, hIn.y]
    out.push(p)
  }
  return out
}

// After a boolean op the result is a dense corner polygon (curves were flattened
// to run the clipper). Recover the Béziers: detect true corners, then LEAST-SQUARES
// fit cubics to each smooth run so curved shapes keep their curves (not facets),
// while genuine corners stay sharp.
function refitCurves(points: PathPoint[], tags?: Map<string, VertexTag>, cornerDeg = 42, tolOverride?: number): PathPoint[] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of points) { if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y }
  const diag = Math.hypot(maxX - minX, maxY - minY) || 1
  const tol = tolOverride ?? Math.max(0.45, diag * 0.002) // Bézier fit fidelity
  const win = Math.max(2, diag * 0.02)                    // arc-length window for tangents
  const cornerCos = Math.cos((cornerDeg * Math.PI) / 180)
  // Endpoint tangents estimated over an arc-length window (not the 2 nearest points,
  // which cluster/facet when the sampling is fine near a corner).
  const runStartDir = (run: FPt[]) => { let j = 0, acc = 0; while (j + 1 < run.length) { acc += fDist(run[j], run[j + 1]); j++; if (acc >= win) break } return fNorm(fSub(run[j], run[0])) }
  const runEndDir = (run: FPt[]) => { let j = run.length - 1, acc = 0; while (j - 1 >= 0) { acc += fDist(run[j], run[j - 1]); j--; if (acc >= win) break } return fNorm(fSub(run[j], run[run.length - 1])) }
  const subs: PathPoint[][] = []
  let cur: PathPoint[] = []
  points.forEach((p, i) => { if (p.move && i > 0) { subs.push(cur); cur = [] } cur.push(p) })
  if (cur.length) subs.push(cur)
  const out: PathPoint[] = []
  for (const sub of subs) {
    // Dedup near-coincident vertices (the clipper emits some) and drop the closing dup.
    const raw: FPt[] = sub.map(p => ({ x: p.x, y: p.y }))
    const R: FPt[] = []
    for (const p of raw) { const q = R[R.length - 1]; if (!q || fDist(p, q) > 1e-3) R.push(p) }
    if (R.length > 2 && fDist(R[0], R[R.length - 1]) < 1e-3) R.pop()
    const n = R.length
    const startMove = out.length > 0
    if (n < 3) { R.forEach((p, i) => out.push({ x: p.x, y: p.y, move: i === 0 && startMove ? true : undefined })); continue }
    // ── EXACT node recovery (boolean ops) ──────────────────────────────────────
    // Vertices matched in `tags` come straight from an input outline: 2 = corner
    // anchor (sharp break), 1 = smooth anchor (smooth fit boundary), 0 = curve-
    // interior sample. UNMATCHED vertices are intersection points computed by the
    // clipper — the exact spots where the result jumps from one shape's boundary
    // to the other's, i.e. true corners. Fitting each run BETWEEN original anchors
    // reproduces the source node structure on untouched outline portions — the
    // minimal node count, mirror-symmetric, no arbitrary recursive-split nodes.
    type Break = { i: number; sharp: boolean; tin?: FPt; tout?: FPt }
    let breaks: Break[] = []
    let exact = false
    if (tags) {
      let matched = 0
      const flags = R.map(p => { const v = tags.get(ringTagKey(p.x, p.y)); if (v !== undefined) matched++; return v })
      if (matched / n >= 0.5) {   // clipper kept input coords → trust the tags
        exact = true
        for (let i = 0; i < n; i++) {
          const f = flags[i]
          if (f === undefined) { breaks.push({ i, sharp: true }); continue }  // intersection point
          if (f.f === 0) continue                                             // curve-interior sample
          // Original anchor (sharp or smooth) with its EXACT tangents — the fit
          // reproduces the source cubics with ~zero error, so untouched outline
          // portions keep exactly their original node structure.
          breaks.push({
            i, sharp: f.f === 2,
            tin:  f.ix !== undefined ? { x: f.ix, y: f.iy! } : undefined,
            tout: f.ox !== undefined ? { x: f.ox, y: f.oy! } : undefined,
          })
        }
      }
    }
    if (!exact) {
      // Heuristic fallback (offset/outline results, or if the clipper perturbed
      // coordinates): arc-length-window turn detection, density-independent.
      const turn: number[] = new Array(n)
      for (let i = 0; i < n; i++) {
        let j = i, acc = 0
        for (;;) { const p = (j - 1 + n) % n; acc += fDist(R[j], R[p]); j = p; if (acc >= win || j === i) break }
        const back = fNorm(fSub(R[i], R[j]))
        let k = i, acc2 = 0
        for (;;) { const p = (k + 1) % n; acc2 += fDist(R[k], R[p]); k = p; if (acc2 >= win || k === i) break }
        const fwd = fNorm(fSub(R[k], R[i]))
        turn[i] = fDot(back, fwd)
      }
      // Keep each corner once: sharpest vertex of every flagged cluster, ≥ win apart.
      const arcGap = (a: number, b: number) => { let j = a, acc = 0; while (j !== b) { const p = (j + 1) % n; acc += fDist(R[j], R[p]); j = p } return acc }
      const flagged = turn.map((tn, i) => ({ i, tn })).filter(o => o.tn < cornerCos).sort((p, q) => p.tn - q.tn)
      const corners: number[] = []
      for (const { i } of flagged) if (corners.every(c => Math.min(arcGap(c, i), arcGap(i, c)) > win)) corners.push(i)
      breaks = corners.sort((a, b) => a - b).map(i => ({ i, sharp: true }))
    }
    // Windowed direction of travel THROUGH vertex i (spans both sides) — shared by
    // the two runs meeting at a smooth anchor, guaranteeing G1 continuity there.
    const jointDir = (i: number): FPt => {
      let j = i, acc = 0
      for (;;) { const p = (j - 1 + n) % n; acc += fDist(R[j], R[p]); j = p; if (acc >= win || j === i) break }
      let k = i, acc2 = 0
      for (;;) { const p = (k + 1) % n; acc2 += fDist(R[k], R[p]); k = p; if (acc2 >= win || k === i) break }
      return fNorm(fSub(R[k], R[j]))
    }
    const cubics: FPt[][] = []
    if (!breaks.length) {
      // Fully smooth closed ring → fit as one loop with a continuous seam tangent.
      const seq = R.concat([R[0]])
      const seam = jointDir(0)
      fitRun(seq, seam, fMul(seam, -1), tol, cubics)
    } else {
      // Fit each run between consecutive breaks. Sharp breaks (intersections /
      // corner anchors) estimate tangents per side; smooth breaks share jointDir.
      for (let ci = 0; ci < breaks.length; ci++) {
        const A = breaks[ci], B = breaks[(ci + 1) % breaks.length]
        const run: FPt[] = [R[A.i]]
        let i = A.i
        do { i = (i + 1) % n; run.push(R[i]) } while (i !== B.i)
        if (run.length < 2) continue
        // Prefer the anchors' EXACT tangents; fall back to windowed estimates
        // (intersection points, or estimates lost to clipper vertex reuse).
        const t1 = A.tout ?? (A.sharp ? runStartDir(run) : jointDir(A.i))
        const t2 = B.tin ? fMul(B.tin, -1) : (B.sharp ? runEndDir(run) : fMul(jointDir(B.i), -1))
        fitRun(run, t1, t2, tol, cubics)
      }
    }
    if (!cubics.length) { R.forEach((p, i) => out.push({ x: p.x, y: p.y, move: i === 0 && startMove ? true : undefined })); continue }
    out.push(...cubicsToPathPoints(cubics, startMove))
  }
  return out
}

// A traceable pixel source: the imported bitmap, or a canvas pre-processed by the
// OCR stage (text regions inpainted away before the shapes are traced).
type TraceSource = HTMLImageElement | HTMLCanvasElement
function traceSrcSize(bmp: TraceSource): { w: number; h: number } {
  const el = bmp as HTMLImageElement
  return { w: el.naturalWidth || bmp.width, h: el.naturalHeight || bmp.height }
}
const hex2 = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')

// ── Image tracing (server-side visioncortex/VTracer engine) ──────────────────────
interface TraceOpts {
  clusterMode: 'color' | 'binary'
  hierarchical: 'stacked' | 'cutout'
  curveMode: 'spline' | 'polygon' | 'pixel'
  filterSpeckle: number     // 0..=16
  colorPrecision: number    // 1..=8
  gradientStep: number      // 0..=128
  cornerThreshold: number   // 0..=180
  segmentLength: number     // 3.5..=10
  spliceThreshold: number   // 0..=180
  // Client-side post-pass (never sent to the server): tolerance in trace-canvas
  // pixels for removing shape-neutral anchors. 0 = off.
  simplify: number          // 0..=10
}
const TRACE_DEFAULTS: TraceOpts = {
  clusterMode: 'color', hierarchical: 'stacked', curveMode: 'spline',
  filterSpeckle: 4, colorPrecision: 6, gradientStep: 16,
  cornerThreshold: 60, segmentLength: 4, spliceThreshold: 45,
  simplify: 1,
}
// VTracer's own presets (bw / poster / photo).
const TRACE_PRESETS: Record<'bw' | 'poster' | 'photo', Partial<TraceOpts>> = {
  bw:     { clusterMode: 'binary', filterSpeckle: 4,  colorPrecision: 6, gradientStep: 16, cornerThreshold: 60 },
  poster: { clusterMode: 'color',  filterSpeckle: 4,  colorPrecision: 8, gradientStep: 16, cornerThreshold: 60 },
  photo:  { clusterMode: 'color',  filterSpeckle: 10, colorPrecision: 8, gradientStep: 48, cornerThreshold: 180 },
}
function traceOptsToPayload(o: TraceOpts): Omit<import('./api').TracePayload, 'image'> {
  return {
    color_mode: o.clusterMode, hierarchical: o.hierarchical, mode: o.curveMode,
    filter_speckle: o.filterSpeckle, color_precision: o.colorPrecision,
    layer_difference: o.gradientStep, corner_threshold: o.cornerThreshold,
    length_threshold: o.segmentLength, splice_threshold: o.spliceThreshold,
  }
}
// Rasterise the source to a PNG payload, capped so the upload and the trace stay
// fast — detail beyond ~1600px is invisible once the result is scaled back into
// the placed element's box.
function rasterForTrace(src: TraceSource): { url: string; w: number; h: number } {
  const nat = traceSrcSize(src)
  const scale = Math.min(1, 1600 / Math.max(nat.w, nat.h))
  const w = Math.max(1, Math.round(nat.w * scale)), h = Math.max(1, Math.round(nat.h * scale))
  const cv = document.createElement('canvas')
  cv.width = w; cv.height = h
  cv.getContext('2d')!.drawImage(src, 0, 0, w, h)
  return { url: cv.toDataURL('image/png'), w, h }
}

// Recognize text lines in the bitmap (self-hosted tesseract WASM), turn each
// confident line into a REAL TextElement (position, size, colour sampled from the
// glyph pixels), and inpaint the text boxes away so the shape tracer never sees
// them — text stays editable text instead of becoming traced blobs.
type OcrText = { text: string; x: number; y: number; w: number; h: number; fontSize: number; color: string; bold: boolean }
async function ocrPrepare(bmp: HTMLImageElement, elX: number, elY: number, elW: number, elH: number):
    Promise<{ src: TraceSource; texts: OcrText[] }> {
  const nat = traceSrcSize(bmp)
  const cv = document.createElement('canvas'); cv.width = nat.w; cv.height = nat.h
  const g = cv.getContext('2d', { willReadFrequently: true })
  if (!g) return { src: bmp, texts: [] }
  g.drawImage(bmp, 0, 0)
  let lines: import('./pdfOcr').OcrWord[] = []
  try {
    // OCR at a capped resolution for speed; map boxes back to natural pixels.
    const oscale = Math.min(1, 1200 / Math.max(nat.w, nat.h))
    let ocrCv: HTMLCanvasElement = cv
    if (oscale < 1) {
      ocrCv = document.createElement('canvas')
      ocrCv.width = Math.round(nat.w * oscale); ocrCv.height = Math.round(nat.h * oscale)
      ocrCv.getContext('2d')!.drawImage(bmp, 0, 0, ocrCv.width, ocrCv.height)
    }
    const { recognizeImage } = await import('./pdfOcr')
    const res = await recognizeImage(ocrCv, 'fra+eng')
    // Regroup WORDS ourselves: same row, but split on wide horizontal gaps
    // (> 1.2× the line height) so spaced-out captions stay separate elements.
    const words = res.words.map(l => ({ ...l, x0: l.x0 / oscale, y0: l.y0 / oscale, x1: l.x1 / oscale, y1: l.y1 / oscale }))
      .sort((a, b) => (a.y0 - b.y0) || (a.x0 - b.x0))
    for (const wd of words) {
      const prev = lines[lines.length - 1]
      const h = Math.min(prev ? prev.y1 - prev.y0 : 1e9, wd.y1 - wd.y0)
      const sameRow = prev && Math.min(prev.y1, wd.y1) - Math.max(prev.y0, wd.y0) > 0.5 * h
      if (sameRow && wd.x0 - prev.x1 < 1.2 * h && wd.x0 > prev.x0) {
        prev.text += ' ' + wd.text
        prev.x1 = Math.max(prev.x1, wd.x1); prev.y0 = Math.min(prev.y0, wd.y0); prev.y1 = Math.max(prev.y1, wd.y1)
        prev.confidence = Math.min(prev.confidence, wd.confidence)
      } else {
        lines.push({ ...wd })
      }
    }
  } catch { return { src: bmp, texts: [] } }
  const sx = elW / nat.w, sy = elH / nat.h
  const texts: OcrText[] = []
  for (const ln of lines) {
    const bw = ln.x1 - ln.x0, bh = ln.y1 - ln.y0
    if (ln.confidence < 65 || bh < 6 || bh > nat.h * 0.25 || bw < 4 || !/[\p{L}\p{N}]/u.test(ln.text)) continue
    // Glyph colour: pixels inside the box far from the border's background colour.
    const pad = Math.max(2, Math.round(bh * 0.18))
    const x0 = Math.max(0, Math.round(ln.x0) - pad), y0 = Math.max(0, Math.round(ln.y0) - pad)
    const x1 = Math.min(nat.w, Math.round(ln.x1) + pad), y1 = Math.min(nat.h, Math.round(ln.y1) + pad)
    let img: ImageData
    try { img = g.getImageData(x0, y0, x1 - x0, y1 - y0) } catch { continue }
    const d = img.data, iw = x1 - x0, ih = y1 - y0
    // Background = mean of the box's 1px border ring.
    let br = 0, bg2 = 0, bb = 0, bn = 0
    for (let x = 0; x < iw; x++) for (const y of [0, ih - 1]) { const o = (y * iw + x) * 4; br += d[o]; bg2 += d[o + 1]; bb += d[o + 2]; bn++ }
    for (let y = 0; y < ih; y++) for (const x of [0, iw - 1]) { const o = (y * iw + x) * 4; br += d[o]; bg2 += d[o + 1]; bb += d[o + 2]; bn++ }
    br /= bn; bg2 /= bn; bb /= bn
    let gr = 0, gg = 0, gb = 0, gn = 0
    for (let i = 0; i < iw * ih; i++) {
      const o = i * 4
      const dist = Math.abs(d[o] - br) + Math.abs(d[o + 1] - bg2) + Math.abs(d[o + 2] - bb)
      if (dist > 120) { gr += d[o]; gg += d[o + 1]; gb += d[o + 2]; gn++ }
    }
    if (gn < 8) continue                                   // no real glyph pixels → skip
    // Inpaint: flood the padded box with the border background colour.
    g.fillStyle = `rgb(${Math.round(br)},${Math.round(bg2)},${Math.round(bb)})`
    g.fillRect(x0, y0, x1 - x0, y1 - y0)
    texts.push({
      text: ln.text, x: elX + ln.x0 * sx, y: elY + ln.y0 * sy, w: bw * sx, h: bh * sy,
      fontSize: Math.max(4, bh * sy * 0.82),
      color: `#${hex2(gr / gn)}${hex2(gg / gn)}${hex2(gb / gn)}`,
      bold: gn / (iw * ih) > 0.28,                         // ink coverage heuristic
    })
  }
  return { src: texts.length ? cv : bmp, texts }
}

// Build a PathElement from rings, inheriting style/name from `base`.
function pathFromMulti(multi: PCMulti, base: VectorElement, name: string, tags?: Map<string, VertexTag>): PathElement | null {
  const points = refitCurves(multiToPathPoints(multi), tags)
  if (points.length < 2) return null
  const bb = pathBounds(points, true)
  const stroke = base.stroke ? structuredClone(base.stroke) : null
  return {
    id: newId(), type: 'path', name,
    x: bb.x, y: bb.y, w: bb.w || 1, h: bb.h || 1,
    rotation: 0, visible: true, locked: false, opacity: base.opacity,
    zIndex: base.zIndex,
    fill: structuredClone(base.fill), stroke,
    points, closed: true,
  }
}

type BoolOp = 'union' | 'subtract' | 'intersect' | 'exclude'

// Combine elements (ordered bottom→top) with a boolean operation. When `tags` is
// given it accumulates the vertex-tag map of ALL inputs (for exact corner recovery).
function booleanCombine(els: VectorElement[], op: BoolOp, tags?: Map<string, VertexTag>): PCMulti | null {
  const geoms = els.map(e => elementToRings(e, 48, tags)).filter(r => r.length > 0) as PCPoly[]
  if (geoms.length < 2) return null
  try {
    if (op === 'union')     return polygonClipping.union(geoms[0], ...geoms.slice(1))
    if (op === 'intersect') return polygonClipping.intersection(geoms[0], ...geoms.slice(1))
    if (op === 'subtract')  return polygonClipping.difference(geoms[0], ...geoms.slice(1))
    return polygonClipping.xor(geoms[0], ...geoms.slice(1))
  } catch { return null }
}

// Illustrator "Pathfinder" effects that yield SEVERAL faces (grouped), unlike the
// four shape-mode booleans above. `chosen` is ordered bottom→top.
//  • divide    — every atomic region of the arrangement (2^N subset algebra)
//  • trim      — each shape minus the shapes ABOVE it (colours kept, no merge)
//  • merge     — trim, then union faces that share the same fill colour
//  • crop      — everything clipped to the TOP shape, top removed
//  • minusback — front shape minus every shape behind it
type PathfinderOp = 'divide' | 'trim' | 'merge' | 'crop' | 'minusback'
function pathfinderMulti(chosen: VectorElement[], op: PathfinderOp): { multi: PCMulti; base: VectorElement }[] {
  const N = chosen.length
  if (N < 2) return []
  const geoms: PCMulti[] = chosen.map(e => [elementToRings(e, 48) as PCPoly])
  const U = (a: PCMulti, b: PCMulti): PCMulti => { try { return polygonClipping.union(a, b) } catch { return a } }
  const I = (a: PCMulti, b: PCMulti): PCMulti => { try { return polygonClipping.intersection(a, b) } catch { return [] } }
  const D = (a: PCMulti, b: PCMulti): PCMulti => { try { return polygonClipping.difference(a, b) } catch { return a } }
  const faces: { multi: PCMulti; base: VectorElement }[] = []
  const add = (m: PCMulti, base: VectorElement) => { if (m && m.length) faces.push({ multi: m, base }) }

  if (op === 'minusback') {
    let below: PCMulti = geoms[0]
    for (let i = 1; i < N - 1; i++) below = U(below, geoms[i])
    add(N >= 2 ? D(geoms[N - 1], below) : geoms[N - 1], chosen[N - 1])
  } else if (op === 'divide') {
    if (N > 7) return []   // 2^N subsets — capped so the arrangement stays fast
    for (let mask = 1; mask < (1 << N); mask++) {
      const inT: number[] = [], outT: number[] = []
      for (let i = 0; i < N; i++) (mask & (1 << i) ? inT : outT).push(i)
      let region: PCMulti = geoms[inT[0]]
      for (let k = 1; k < inT.length && region.length; k++) region = I(region, geoms[inT[k]])
      for (let k = 0; k < outT.length && region.length; k++) region = D(region, geoms[outT[k]])
      add(region, chosen[inT[inT.length - 1]])   // topmost input covering this region
    }
  } else {
    const clipToTop = op === 'crop'
    const top = geoms[N - 1]
    const start = clipToTop ? N - 2 : N - 1
    let above: PCMulti | null = null
    for (let i = start; i >= 0; i--) {
      let piece: PCMulti = geoms[i]
      if (clipToTop) piece = I(piece, top)
      if (above) piece = D(piece, above)
      add(piece, chosen[i])
      const contrib = clipToTop ? I(geoms[i], top) : geoms[i]
      above = above ? U(above, contrib) : contrib
    }
  }
  if (op === 'merge') {
    const groups = new Map<string, { multi: PCMulti; base: VectorElement }>()
    for (const f of faces) {
      const key = f.base.fill.type === 'solid' ? f.base.fill.color : JSON.stringify(f.base.fill)
      const g = groups.get(key)
      if (g) g.multi = U(g.multi, f.multi); else groups.set(key, { multi: f.multi, base: f.base })
    }
    return [...groups.values()]
  }
  return faces
}

// Illustrator distort effects, applied to an element's flattened outline (works for
// any type). Twist/pucker move points relative to the centroid; roughen/zigzag
// resample the outline then displace (jitter / alternating normal offset).
type DistortFx = 'twist' | 'pucker' | 'roughen' | 'zigzag'
function distortElement(el: VectorElement, fx: DistortFx, amount: number, detail: number): PathElement | null {
  const rings = elementToRings(el, 40) as PCPoly
  if (!rings.length) return null
  const flat = rings.flat()
  const cx = flat.reduce((s, p) => s + p[0], 0) / flat.length
  const cy = flat.reduce((s, p) => s + p[1], 0) / flat.length
  const xs = flat.map(p => p[0]), ys = flat.map(p => p[1])
  const diag = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) || 1
  const out: PathPoint[] = []
  rings.forEach((ring, ri) => {
    let pts = ring.map(([x, y]) => ({ x, y }))
    if (pts.length > 1 && pts[0].x === pts[pts.length - 1].x && pts[0].y === pts[pts.length - 1].y) pts.pop()
    if (pts.length < 3) return
    if (fx === 'twist') {
      const maxD = Math.max(...pts.map(p => Math.hypot(p.x - cx, p.y - cy))) || 1
      pts = pts.map(p => { const dx = p.x - cx, dy = p.y - cy, d = Math.hypot(dx, dy); const a = (amount * Math.PI / 180) * (d / maxD), c = Math.cos(a), s = Math.sin(a); return { x: cx + c * dx - s * dy, y: cy + s * dx + c * dy } })
    } else if (fx === 'pucker') {
      const f = amount / 100
      pts = pts.map(p => ({ x: p.x + (p.x - cx) * f, y: p.y + (p.y - cy) * f }))
    } else {
      const per = Math.max(1, Math.round(detail))
      const dense: { x: number; y: number }[] = []
      for (let i = 0; i < pts.length; i++) { const a = pts[i], bp = pts[(i + 1) % pts.length]; for (let k = 0; k < per; k++) { const tt = k / per; dense.push({ x: a.x + (bp.x - a.x) * tt, y: a.y + (bp.y - a.y) * tt }) } }
      const n = dense.length
      const size = (amount / 100) * diag * (fx === 'zigzag' ? 0.06 : 0.1)
      pts = dense.map((p, i) => {
        if (fx === 'roughen') return { x: p.x + (Math.random() * 2 - 1) * size, y: p.y + (Math.random() * 2 - 1) * size }
        const pv = dense[(i - 1 + n) % n], nx = dense[(i + 1) % n]
        let tx = nx.x - pv.x, ty = nx.y - pv.y; const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl
        let rx = -ty, ry = tx
        if ((p.x - cx) * rx + (p.y - cy) * ry < 0) { rx = -rx; ry = -ry }
        const s = (i % 2 === 0 ? 1 : -1) * size
        return { x: p.x + rx * s, y: p.y + ry * s }
      })
    }
    pts.forEach((p, i) => out.push({ x: p.x, y: p.y, move: ri > 0 && i === 0 ? true : undefined }))
  })
  if (out.length < 3) return null
  const bb = pathBounds(out, true)
  return {
    id: newId(), type: 'path', name: el.name,
    x: bb.x, y: bb.y, w: bb.w || 1, h: bb.h || 1,
    rotation: 0, visible: true, locked: false, opacity: el.opacity, zIndex: el.zIndex,
    fill: structuredClone(el.fill), stroke: el.stroke ? structuredClone(el.stroke) : null,
    points: out, closed: true,
  }
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
  // Smoothing adds handles → the curve now bulges past the anchors.
  const bb = pathBounds(next, pe.closed)
  return { ...pe, points: next, x: bb.x, y: bb.y, w: bb.w, h: bb.h }
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

  // ── Reliable autosave ────────────────────────────────────────────────────────
  // Saves 1.5 s after the last edit (debounce) + flushes on page switch and on
  // close/navigation. (The old 30 s interval restarted on every keystroke, so it
  // never fired during continuous editing.)
  const savePageDataRef = useRef(pageData)
  const pageIdRef   = useRef(pageId)
  const dirtyRef    = useRef(false)
  const skipSaveRef = useRef(false)
  const savingRef   = useRef(false)
  const saveTimer   = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved')
  useEffect(() => { pageIdRef.current = pageId }, [pageId])

  const flushSave = useCallback(() => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null }
    if (embedded) {
      if (dirtyRef.current) { dirtyRef.current = false; embed!.onCommit(savePageDataRef.current) }
      return
    }
    if (!dirtyRef.current || !projectId || !pageIdRef.current) return
    // One request at a time: a second PUT racing the first could land out of order
    // and resurrect stale content. The dirty flag survives, so we retry below.
    if (savingRef.current) return
    const snapshot = savePageDataRef.current
    savingRef.current = true
    setSaveState('saving')
    apexApi.savePage(projectId, pageIdRef.current, snapshot)
      .then(() => {
        // Only consider the document clean if nothing changed mid-flight.
        if (savePageDataRef.current === snapshot) dirtyRef.current = false
        setSaveState('saved')
      })
      .catch(() => {
        // Stay dirty and surface it: the safety interval retries until it lands.
        setSaveState('error')
      })
      .finally(() => { savingRef.current = false })
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

  // Grouped shape picker (Affinity-style): the last chosen entry drives both
  // the toolbar button icon and what the 'shape' tool creates. Rectangle by default.
  const [curShape, setCurShape] = useState<ShapeEntry>(SHAPES_MENU[0])
  const curShapeRef = useRef(curShape)
  useEffect(() => { curShapeRef.current = curShape }, [curShape])
  const [shapeMenuPos, setShapeMenuPos] = useState<MenuDropdownPos | null>(null)

  // Active fill/stroke paint — the default colours new shapes inherit (Illustrator
  // style), driven by the tool-rail swatches and persisted across sessions.
  const [curFill, setCurFill]     = useState<string>(() => localStorage.getItem('apex:fill')   ?? '#4a90d9')
  const [curStroke, setCurStroke] = useState<string>(() => localStorage.getItem('apex:stroke') ?? '#1a1a1a')
  const curFillRef   = useRef(curFill)
  const curStrokeRef = useRef(curStroke)
  useEffect(() => { curFillRef.current = curFill; try { localStorage.setItem('apex:fill', curFill) } catch { /* quota */ } }, [curFill])
  useEffect(() => { curStrokeRef.current = curStroke; try { localStorage.setItem('apex:stroke', curStroke) } catch { /* quota */ } }, [curStroke])

  // Pen tool state — use ref for non-stale access in event handlers
  const penRef = useRef<PenProgress | null>(null)
  const [penProgress, setPenProgress_] = useState<PenProgress | null>(null)
  const setPenProgress = (p: PenProgress | null) => {
    penRef.current = p
    setPenProgress_(p)
  }
  // Select a predefined shape from the grouped picker.
  const pickShape = (entry: ShapeEntry) => {
    setPenProgress(null)
    setCurShape(entry)
    setTool(entry.tool)
  }

  const dragRef = useRef<{
    type:       'pan' | 'move' | 'create' | 'resize' | 'rotate' | 'radius' | 'marquee' | 'nodemarquee' | 'node' | 'viewrotate' | 'gradient' | 'freehand' | 'newguide' | 'guide' | 'symcenter'
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
    nodeGroup?: number[]          // all selected anchor indices to move together
    breakSym?:  boolean           // alt-drag a handle → break tangent symmetry
    w0x?:       number            // viewrotate: world point under the viewport centre
    w0y?:       number
    gradHandle?: 'start' | 'end' | number   // gradient editing: endpoint or stop index
    guideType?: 'h' | 'v'          // ruler-guide being created / dragged
    guideId?:   string
    symTargets?: string[]          // sym sources whose centre is being dragged ([] = drawing-mode centre)
    snapTg?:    { xs: SnapCand[]; ys: SnapCand[] }  // snap targets cached at drag start
    dupIds?:    string[]           // alt-drag duplicate: ids of the live clones
    origIds?:   string[]           // alt-drag duplicate: the original selection
    symPtInv?:  (x: number, y: number) => { x: number; y: number }  // grabbed a clone → map pointer to its source frame
    rotates?:   VectorElement[]    // multi-element rotate (container unit): snapshots to spin around cx/cy
    scales?:    VectorElement[]    // container unit resize: subtree snapshots to scale
    resizeCtx?: { px: number; py: number; ang: number; lx: number; ly: number; lw: number; lh: number; handle: number }  // oriented box + grabbed handle
  } | null>(null)
  // Direct-selection can hold MULTIPLE anchors at once (Shift-click to extend);
  // node-type conversions apply to exactly this set, never to the whole path.
  const [nodeSel, setNodeSel] = useState<number[]>([])
  const nodeSelRef = useRef<number[]>([])
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
  const [guides, setGuides] = useState<{ vx: SnapGuide[]; hy: SnapGuide[] }>({ vx: [], hy: [] })
  // Tangent-snap contact point (where two outlines kiss), shown while dragging.
  const [snapTouch, setSnapTouch] = useState<{ x: number; y: number } | null>(null)
  const snapTouchRef = useRef<{ x: number; y: number } | null>(null)

  // ── View options : règles, repères utilisateur, mode contours ───────────────
  const [rulersOn, setRulersOn]         = useState(() => localStorage.getItem('apex:rulers') !== '0')
  const [guidesOn, setGuidesOn]         = useState(true)
  const [guidesLocked, setGuidesLocked] = useState(false)
  const [outlineMode, setOutlineMode]   = useState(false)
  useEffect(() => { localStorage.setItem('apex:rulers', rulersOn ? '1' : '0') }, [rulersOn])
  const rulersOnRef     = useRef(rulersOn);     useEffect(() => { rulersOnRef.current = rulersOn }, [rulersOn])
  const guidesOnRef     = useRef(guidesOn);     useEffect(() => { guidesOnRef.current = guidesOn }, [guidesOn])
  const guidesLockedRef = useRef(guidesLocked); useEffect(() => { guidesLockedRef.current = guidesLocked }, [guidesLocked])
  // Guide being dragged out of a ruler (world position), previewed dashed.
  const [tempGuide, setTempGuide] = useState<{ type: 'h' | 'v'; position: number } | null>(null)
  // Middle-button panning → show the closed-hand cursor for the duration.
  const [midPan, setMidPan] = useState(false)

  // ── Freehand tools (pencil / brush) : stabilized capture + options ──────────
  // `pen` marks a stylus stroke → pressure drives the brush width.
  const freehandRef = useRef<{ samples: RawSample[]; stab: StrokeStabilizer; pen: boolean } | null>(null)
  const [freehandTick, setFreehandTick] = useState(0)   // repaint trigger while capturing
  type FreehandOpts = { stabilizer: number; pencilWidth: number; brushSize: number; brushDynamics: number; color: string }
  const [fhOpts, setFhOpts] = useState<FreehandOpts>(() => {
    const defaults: FreehandOpts = { stabilizer: 50, pencilWidth: 3, brushSize: 14, brushDynamics: 60, color: '#1a1a1a' }
    try { return { ...defaults, ...JSON.parse(localStorage.getItem('apex:freehand') ?? '{}') } } catch { return defaults }
  })
  useEffect(() => { localStorage.setItem('apex:freehand', JSON.stringify(fhOpts)) }, [fhOpts])
  const fhOptsRef = useRef(fhOpts); useEffect(() => { fhOptsRef.current = fhOpts }, [fhOpts])

  // ── Layers panel UI state ────────────────────────────────────────────────────
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const [dndTarget, setDndTarget] = useState<{ id: string; zone: 'before' | 'after' | 'inside' } | null>(null)
  const dndDragId = useRef<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')

  // ── Undo / redo history (reference snapshots of pageData) ───────────────────
  // Every mutation goes through `setPageData(prev => ({ ...prev, … }))` and
  // builds fresh element objects — the same immutability contract the WeakMap
  // render caches rely on. Snapshots can therefore share structure: storing the
  // reference is enough, no structuredClone of the whole document (which used to
  // copy every embedded image data-URL on EVERY undoable action).
  const past   = useRef<VectorPageData[]>([])
  const future = useRef<VectorPageData[]>([])
  const pushHistory = useCallback(() => {
    past.current.push(pageDataRef.current)
    if (past.current.length > 60) past.current.shift()
    future.current = []
  }, [])
  const undo = useCallback(() => {
    const prev = past.current.pop(); if (!prev) return
    future.current.push(pageDataRef.current)
    setPageData(prev)
  }, [])
  const redo = useCallback(() => {
    const next = future.current.pop(); if (!next) return
    past.current.push(pageDataRef.current)
    setPageData(next)
  }, [])
  const clipboard = useRef<VectorElement[]>([])
  // Ctrl+V hands over to the browser's `paste` event (the only way to read image
  // data from another app); these carry the intent across and let the shortcut
  // fall back to the internal clipboard when no event arrives.
  const pasteInPlaceRef = useRef(false)
  const pasteHandledRef = useRef(false)

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
        const bb = pathBounds(pts, (el as PathElement).closed)
        return { ...el, points: pts, x: bb.x, y: bb.y, w: bb.w, h: bb.h } as VectorElement
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

  // ── Symmetry / repeat tools (Illustrator-style) ──────────────────────────────
  const [mirrorDlg, setMirrorDlg]     = useState(false)
  const [mirrorAxis, setMirrorAxis]   = useState<'v' | 'h' | 'angle'>('v')
  const [mirrorAngle, setMirrorAngle] = useState(45)
  const [radialDlg, setRadialDlg]     = useState(false)
  const [radialCount, setRadialCount] = useState(8)
  const [radialRadius, setRadialRadius] = useState(120)
  const [gridDlg, setGridDlg]         = useState(false)
  const [gridRows, setGridRows]       = useState(2)
  const [gridCols, setGridCols]       = useState(3)
  const [gridGapX, setGridGapX]       = useState(24)
  const [gridGapY, setGridGapY]       = useState(24)
  const selLeaves = useCallback(() =>
    pageDataRef.current.elements.filter(e => selectedIdsRef.current.includes(e.id) && e.type !== 'group'), [])

  // Miroir : reflect in place, or reflect a COPY (Illustrator's Copier button).
  const applyMirror = useCallback((copy: boolean) => {
    const els = selLeaves(); if (!els.length) { setMirrorDlg(false); return }
    const bb = selBBox(els)!
    const cx = bb.x + bb.w / 2, cy = bb.y + bb.h / 2
    const deg = mirrorAxis === 'h' ? 0 : mirrorAxis === 'v' ? 90 : mirrorAngle
    pushHistory()
    if (copy) {
      const clones = els.map(e => reflectElement(cloneEl(e), cx, cy, deg))
      setPageData(prev => ({ ...prev, elements: [...prev.elements, ...clones.map((c, i) => ({ ...c, zIndex: prev.elements.length + i } as VectorElement))] }))
      setSelectedIds(clones.map(c => c.id))
    } else {
      const ids = new Set(els.map(e => e.id))
      setPageData(prev => ({ ...prev, elements: prev.elements.map(e => ids.has(e.id) ? reflectElement(e, cx, cy, deg) : e) }))
    }
    setMirrorDlg(false)
  }, [mirrorAxis, mirrorAngle, pushHistory, selLeaves])

  // Wrap originals + generated copies into one group (like Illustrator's repeats).
  const finishRepeat = useCallback((name: string, originals: VectorElement[], copies: VectorElement[]) => {
    const gid = `g-${newId()}`
    const orig = new Set(originals.map(e => e.id))
    setPageData(prev => {
      const group: GroupElement = {
        id: gid, type: 'group', name,
        x: 0, y: 0, w: 0, h: 0, rotation: 0, visible: true, locked: false,
        opacity: 100, zIndex: Math.max(...originals.map(e => e.zIndex)),
        fill: { type: 'none' }, stroke: null, parentId: null, collapsed: true,
      }
      return { ...prev, elements: [
        ...prev.elements.map(e => orig.has(e.id) ? { ...e, parentId: gid } as VectorElement : e),
        group,
        ...copies.map((c, i) => ({ ...c, parentId: gid, zIndex: prev.elements.length + 1 + i } as VectorElement)),
      ] }
    })
    setSelectedIds([...originals.map(e => e.id), ...copies.map(c => c.id)])
  }, [])

  // Répétition radiale : N instances autour d'un centre situé à `radius` sous la
  // sélection (rayon 0 → rotation sur place autour du centre de la sélection).
  const applyRadial = useCallback(() => {
    const els = selLeaves(); if (!els.length) { setRadialDlg(false); return }
    const bb = selBBox(els)!
    const px = bb.x + bb.w / 2, py = bb.y + bb.h / 2 + radialRadius
    const n = Math.max(2, Math.min(72, Math.round(radialCount)))
    pushHistory()
    const copies: VectorElement[] = []
    for (let k = 1; k < n; k++) for (const e of els) copies.push(rotateElementAround(cloneEl(e), px, py, (k * 360) / n))
    finishRepeat(t('apex_radial_title'), els, copies)
    setRadialDlg(false)
  }, [radialCount, radialRadius, pushHistory, selLeaves, finishRepeat, t])

  // Répétition en grille : lignes × colonnes avec espacements.
  const applyGrid = useCallback(() => {
    const els = selLeaves(); if (!els.length) { setGridDlg(false); return }
    const bb = selBBox(els)!
    const rows = Math.max(1, Math.min(40, Math.round(gridRows)))
    const cols = Math.max(1, Math.min(40, Math.round(gridCols)))
    pushHistory()
    const copies: VectorElement[] = []
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      if (!r && !c) continue
      const dx = c * (bb.w + gridGapX), dy = r * (bb.h + gridGapY)
      for (const e of els) copies.push(translateEl(cloneEl(e), dx, dy))
    }
    finishRepeat(t('apex_grid_title'), els, copies)
    setGridDlg(false)
  }, [gridRows, gridCols, gridGapX, gridGapY, pushHistory, selLeaves, finishRepeat, t])

  // Répétition miroir (un clic) : copie réfléchie sur l'axe vertical au bord droit.
  const mirrorRepeatSel = useCallback(() => {
    const els = selLeaves(); if (!els.length) return
    const bb = selBBox(els)!
    const axisX = bb.x + bb.w + 12
    pushHistory()
    const copies = els.map(e => reflectElement(cloneEl(e), axisX, bb.y + bb.h / 2, 90))
    finishRepeat(t('apex_mirror_repeat'), els, copies)
  }, [pushHistory, selLeaves, finishRepeat, t])

  // ── SYMMETRY CONTAINER (a layer-dock object that reflects its children) ───────
  // Drawing mode: new strokes drop into a live symmetry container. Its CENTRE is a
  // movable on-canvas handle; radial count is free (2-72).
  const [symLive, setSymLive]   = useState<'off' | 'v' | 'h' | 'vh' | 'radial'>(() =>
    (localStorage.getItem('apex:sym') as 'off' | 'v' | 'h' | 'vh' | 'radial') ?? 'off')
  const [symCount, setSymCount] = useState(() => Number(localStorage.getItem('apex:symCount')) || 6)
  const [symCenter, setSymCenter] = useState<{ x: number; y: number } | null>(null)   // drawing-mode centre (null = artboard centre)
  // When a symmetry CLONE is clicked, its source is selected but the selection box is
  // drawn on the clicked clone; this holds that clone's id (source stays in selectedIds).
  const [symBoxClone, setSymBoxClone] = useState<string | null>(null)
  const symBoxCloneRef = useRef(symBoxClone); useEffect(() => { symBoxCloneRef.current = symBoxClone }, [symBoxClone])
  // Hovered corner of a selected object → live interior-angle readout (world pos + deg).
  const [hoverAngle, setHoverAngle] = useState<{ x: number; y: number; deg: number; a1: number; a2: number } | null>(null)
  const hoverAngleRef = useRef(hoverAngle); useEffect(() => { hoverAngleRef.current = hoverAngle }, [hoverAngle])
  // Corner-angle editor dialog (double-click / context menu on a vertex). `srcId` is the
  // SOURCE path (symmetry clones are edited through their source; the reconciler follows).
  const [angleDlg, setAngleDlg] = useState<{ srcId: string; ptIndex: number; value: number; strat: AngleStrat; base: PathPoint[] } | null>(null)
  const [distortDlg, setDistortDlg] = useState<{ fx: DistortFx; amount: number; detail: number } | null>(null)
  const [symDlg, setSymDlg] = useState(false)
  const symRef = useRef({ mode: symLive, count: symCount })
  const drawSymRef = useRef<string | null>(null)   // active drawing-mode container id
  useEffect(() => {
    symRef.current = { mode: symLive, count: symCount }
    localStorage.setItem('apex:sym', symLive); localStorage.setItem('apex:symCount', String(symCount))
    drawSymRef.current = null   // mode change starts a fresh drawing container
  }, [symLive, symCount])
  const symCenterRef = useRef(symCenter); useEffect(() => { symCenterRef.current = symCenter }, [symCenter])
  const getSymCenter = useCallback(() => {
    if (symCenterRef.current) return symCenterRef.current
    const ab = pageDataRef.current.artboards[0]
    return ab ? { x: ab.x + ab.width / 2, y: ab.y + ab.height / 2 } : { x: 0, y: 0 }
  }, [])
  const mkSymContainer = useCallback((mode: 'v' | 'h' | 'vh' | 'radial', count: number, cx: number, cy: number, zIndex: number, parentId: string | null): SymmetryElement => ({
    id: `sym-${newId()}`, type: 'symmetry', name: t('apex_symmetry_obj'),
    x: 0, y: 0, w: 0, h: 0, rotation: 0, visible: true, locked: false,
    opacity: 100, zIndex, fill: { type: 'none' }, stroke: null, parentId, collapsed: false,
    symMode: mode, symCount: count, cx, cy,
  }), [t])
  // Nearest ancestor symmetry container of an element (self included).
  const ancestorSym = useCallback((els: VectorElement[], el: VectorElement): SymmetryElement | null => {
    let cur: VectorElement | undefined = el
    const seen = new Set<string>()
    while (cur) {
      if (cur.type === 'symmetry') return cur as SymmetryElement
      if (!cur.parentId || seen.has(cur.parentId)) break
      seen.add(cur.parentId); cur = els.find(e => e.id === cur!.parentId)
    }
    return null
  }, [])
  // The symmetry centre currently shown/draggable: the selected container(s) (or
  // the container(s) of the selected children), else the drawing-mode centre.
  const activeSymContext = useCallback((): { cx: number; cy: number; targets: string[] } | null => {
    const els = pageDataRef.current.elements
    const conts = new Map<string, SymmetryElement>()
    for (const id of selectedIdsRef.current) {
      const el = els.find(e => e.id === id); if (!el) continue
      const c = ancestorSym(els, el); if (c) conts.set(c.id, c)
    }
    if (conts.size) { const c = [...conts.values()][0]; return { cx: c.cx, cy: c.cy, targets: [...conts.keys()] } }
    if (symRef.current.mode !== 'off') { const c = getSymCenter(); return { cx: c.x, cy: c.y, targets: [] } }
    return null
  }, [getSymCenter, ancestorSym])
  // Drawing mode: give a freshly committed element (id) its symmetry parent,
  // creating/reusing the drawing container. Runs inside the same setPageData.
  const placeInDrawSym = useCallback((prev: VectorPageData, elId: string): VectorPageData => {
    const { mode, count } = symRef.current
    if (mode === 'off') return prev
    let contId = drawSymRef.current
    let els = prev.elements
    if (!contId || !els.some(e => e.id === contId && e.type === 'symmetry')) {
      const c = getSymCenter()
      const cont = mkSymContainer(mode, count, c.x, c.y, els.length, null)
      contId = cont.id; drawSymRef.current = contId
      els = [...els, cont]
    }
    return { ...prev, elements: els.map(e => e.id === elId ? { ...e, parentId: contId } as VectorElement : e) }
  }, [getSymCenter, mkSymContainer])
  // Wrap the selection into a NEW symmetry container (Objet menu / layer action).
  const createSymmetry = useCallback((mode: 'v' | 'h' | 'vh' | 'radial', count: number) => {
    const els = pageDataRef.current.elements
    const sel = els.filter(e => selectedIdsRef.current.includes(e.id) && !e.symOf && e.type !== 'symmetry')
    if (!sel.length) return
    const bb = selBBox(sel.filter(e => !isContainer(e)))
    const c = getSymCenter()
    const cx = bb ? bb.x + bb.w / 2 : c.x, cy = bb ? bb.y + bb.h / 2 : c.y
    // Inherit the shared parent when the whole selection lives in one container.
    const parents = new Set(sel.map(e => e.parentId ?? null))
    const parentId = parents.size === 1 ? [...parents][0] : null
    pushHistory()
    const cont = mkSymContainer(mode, count, cx, cy, Math.max(...sel.map(e => e.zIndex)), parentId)
    const ids = new Set(sel.map(e => e.id))
    setPageData(prev => ({ ...prev, elements: [
      ...prev.elements.map(e => ids.has(e.id) ? { ...e, parentId: cont.id } as VectorElement : e), cont,
    ] }))
    setSelectedIds([cont.id])
  }, [getSymCenter, mkSymContainer, pushHistory])
  // Patch a symmetry container's parameters (mode / count / centre).
  const updateSym = useCallback((id: string, patch: Partial<SymmetryElement>) => {
    pushHistory()
    setPageData(prev => ({ ...prev, elements: prev.elements.map(e => e.id === id && e.type === 'symmetry' ? { ...e, ...patch } as VectorElement : e) }))
  }, [pushHistory])
  // Release a symmetry container: freeze its clones into normal editable objects
  // and dissolve the container (its sources move up to its parent).
  const releaseSym = useCallback((ids?: string[]) => {
    const els = pageDataRef.current.elements
    const targets = (ids ?? selectedIdsRef.current).map(id => els.find(e => e.id === id))
      .filter((e): e is SymmetryElement => !!e && e.type === 'symmetry')
    if (!targets.length) return
    const contIds = new Set(targets.map(c => c.id))
    pushHistory()
    setPageData(prev => ({ ...prev, elements: prev.elements.flatMap(e => {
      if (contIds.has(e.id)) return []   // drop the container
      if (e.parentId && contIds.has(e.parentId)) {
        const parent = prev.elements.find(p => p.id === e.parentId)!.parentId ?? null
        if (e.symOf) { const c = structuredClone(e); delete c.symOf; delete c.symIdx; c.locked = false; c.id = newId(); c.parentId = parent; return [c as VectorElement] }
        return [{ ...e, parentId: parent } as VectorElement]
      }
      return [e]
    }) }))
  }, [pushHistory])
  // Reconciliation: derived clones are a pure function of their container + source
  // children — rebuild whenever the document changes (moves, node edits, restyles,
  // undo…) and drop orphans. Idempotent: no state update when already in sync.
  useEffect(() => {
    const els = pageData.elements
    const containers = els.filter((e): e is SymmetryElement => e.type === 'symmetry')
    const existing = els.filter(e => e.symOf)
    if (!containers.length && !existing.length) return
    const expected: VectorElement[] = []
    for (const cont of containers) expected.push(...genContainerClones(els, cont))
    const exById = new Map(existing.map(e => [e.id, e]))
    // A clone's depth must MIRROR its source's: track the source's current zIndex so
    // reordering sources (bring-to-front…) keeps the pattern's stacking symmetric.
    const srcZ = new Map(els.filter(e => !e.symOf).map(e => [e.id, e.zIndex]))
    const adjusted = expected.map(c => ({ ...c, zIndex: srcZ.get(c.symOf!) ?? exById.get(c.id)?.zIndex ?? c.zIndex }))
    const same = existing.length === adjusted.length
      && adjusted.every(c => { const ex = exById.get(c.id); return ex && JSON.stringify(ex) === JSON.stringify(c) })
    if (same) return
    setPageData(prev => ({ ...prev, elements: [...prev.elements.filter(e => !e.symOf), ...adjusted] }))
  }, [pageData])

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
      for (const id of sel) { const el = prev.elements.find(e => e.id === id); if (el && isContainer(el)) descendantIds(prev.elements, id).forEach(d => kill.add(d)) }
      // Removing a source also removes its derived clones.
      for (const e of prev.elements) if (e.symOf && kill.has(e.symOf)) kill.add(e.id)
      return { ...prev, elements: pruneEmptyGroups(prev.elements.filter(e => !kill.has(e.id))) }
    })
    setSelectedIds([])
  }, [pushHistory])
  const selectAll = useCallback(() => {
    const els = pageDataRef.current.elements
    setSelectedIds(els.filter(e => e.type !== 'group' && !effHidden(els, e) && !effLocked(els, e)).map(e => e.id))
  }, [])
  const cutSel = useCallback(() => { copySel(); deleteSel() }, [copySel, deleteSel])
  // Cross-module copy: selection → JSON envelope on the system clipboard,
  // pasteable as a rendered card in chat, office documents… (`core.data-card`).
  const copyForKubuno = useCallback(() => {
    const els = pageDataRef.current.elements
    const sel = new Set(selectedIdsRef.current)
    if (!sel.size) return
    // Containers travel with their whole subtree so the producer render is complete.
    for (const id of [...sel]) {
      const el = els.find(e => e.id === id)
      if (el && isContainer(el)) descendantIds(els, id).forEach(d => sel.add(d))
    }
    const picked = els.filter(e => sel.has(e.id)).map(e => structuredClone(e))
    const bbox = selBBox(picked.filter(e => e.type !== 'group')) ?? selBBox(picked)
    if (!bbox) return
    copyKubunoData(vectorsEnvelope(picked, bbox)).catch(() => {})
  }, [])
  // Paste without the cascade offset — clones land exactly on the originals.
  const pasteInPlace = useCallback(() => {
    if (!clipboard.current.length) return
    pushHistory()
    const clones = clipboard.current.map(e => cloneEl(e))
    setPageData(prev => ({ ...prev, elements: [...prev.elements, ...clones.map((c, i) => ({ ...c, zIndex: prev.elements.length + i }))] }))
    setSelectedIds(clones.map(c => c.id))
  }, [pushHistory])

  // ── Lock / hide (Illustrator Ctrl+2 / Ctrl+3 family) ─────────────────────────
  const lockSel = useCallback(() => {
    const sel = new Set(selectedIdsRef.current); if (!sel.size) return
    pushHistory()
    setPageData(prev => ({ ...prev, elements: prev.elements.map(el => sel.has(el.id) ? { ...el, locked: true } as VectorElement : el) }))
    setSelectedIds([])
  }, [pushHistory])
  const unlockAll = useCallback(() => {
    pushHistory()
    setPageData(prev => ({ ...prev, elements: prev.elements.map(el => el.locked ? { ...el, locked: false } as VectorElement : el) }))
  }, [pushHistory])
  const hideSel = useCallback(() => {
    const sel = new Set(selectedIdsRef.current); if (!sel.size) return
    pushHistory()
    setPageData(prev => ({ ...prev, elements: prev.elements.map(el => sel.has(el.id) ? { ...el, visible: false } as VectorElement : el) }))
    setSelectedIds([])
  }, [pushHistory])
  const showAll = useCallback(() => {
    pushHistory()
    setPageData(prev => ({ ...prev, elements: prev.elements.map(el => el.visible ? el : { ...el, visible: true } as VectorElement) }))
  }, [pushHistory])

  // Rotate the selection ±90° about its common centre (positions orbit, each
  // element's own rotation shifts by the same amount).
  const rotate90 = useCallback((dir: 1 | -1) => {
    const sel = selectedIdsRef.current
    const els = pageDataRef.current.elements.filter(e => sel.includes(e.id) && e.type !== 'group')
    if (!els.length) return
    const bb = selBBox(els)!
    const cx = bb.x + bb.w / 2, cy = bb.y + bb.h / 2
    pushHistory()
    const ids = new Set(els.map(e => e.id))
    setPageData(prev => ({ ...prev, elements: prev.elements.map(el => {
      if (!ids.has(el.id)) return el
      const b = elBBox(el)
      const ecx = b.x + b.w / 2, ecy = b.y + b.h / 2
      const dx = ecx - cx, dy = ecy - cy
      const nx = dir === 1 ? cx - dy : cx + dy
      const ny = dir === 1 ? cy + dx : cy - dx
      const moved = translateEl(el, nx - ecx, ny - ecy)
      return { ...moved, rotation: ((moved.rotation + dir * 90) % 360 + 360) % 360 } as VectorElement
    }) }))
  }, [pushHistory])

  // ── Zoom presets ─────────────────────────────────────────────────────────────
  const zoom100 = useCallback(() => {
    const canvas = canvasRef.current; if (!canvas) return
    const r = canvas.getBoundingClientRect()
    setCs(prev => {
      const k = 1 / prev.zoom
      return { ...prev, zoom: 1, panX: r.width / 2 - (r.width / 2 - prev.panX) * k, panY: r.height / 2 - (r.height / 2 - prev.panY) * k }
    })
  }, [])
  const zoomToSel = useCallback(() => {
    const els = pageDataRef.current.elements.filter(e => selectedIdsRef.current.includes(e.id) && e.type !== 'group')
    const bb = selBBox(els); if (!bb) return
    const canvas = canvasRef.current; if (!canvas) return
    const r = canvas.getBoundingClientRect()
    const pad = 60
    const zoom = Math.max(0.02, Math.min(20,
      (r.width - pad * 2) / Math.max(1, bb.w),
      (r.height - pad * 2) / Math.max(1, bb.h)))
    setCs({ zoom, panX: (r.width - bb.w * zoom) / 2 - bb.x * zoom, panY: (r.height - bb.h * zoom) / 2 - bb.y * zoom, rot: 0 })
  }, [])

  const clearGuides = useCallback(() => {
    if (!pageDataRef.current.guides?.length) return
    pushHistory()
    setPageData(prev => ({ ...prev, guides: [] }))
  }, [pushHistory])

  // Alt-click on a layer's eye: solo it (hide everything else) / restore all.
  const soloLayer = useCallback((id: string) => {
    setPageData(prev => {
      const els = prev.elements
      const target = els.find(e => e.id === id); if (!target) return prev
      const keep = new Set<string>([id])
      if (isContainer(target)) descendantIds(els, id).forEach(d => keep.add(d))
      let cur: VectorElement | undefined = target
      const seenAnc = new Set<string>()
      while (cur?.parentId && !seenAnc.has(cur.parentId)) {
        seenAnc.add(cur.parentId); keep.add(cur.parentId)
        cur = els.find(e => e.id === cur!.parentId)
      }
      const isSolo = els.every(e => keep.has(e.id) ? e.visible : !e.visible)
      return { ...prev, elements: els.map(e => ({ ...e, visible: isSolo ? true : keep.has(e.id) }) as VectorElement) }
    })
  }, [])

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

  // ── Clipping mask (Illustrator Ctrl+7 family) ────────────────────────────────
  // Wrap the selection in a `clipped` group: the TOPMOST selected object becomes
  // the mask, everything below it is clipped to its shape.
  const makeClipMask = useCallback(() => {
    const sel = selectedIdsRef.current
    if (sel.length < 2) return
    pushHistory()
    const gid = `g-${newId()}`
    setPageData(prev => {
      const chosen = prev.elements.filter(e => sel.includes(e.id) && !e.symOf)
      if (chosen.length < 2) return prev
      const parents = new Set(chosen.map(c => c.parentId ?? null))
      const parentId = parents.size === 1 ? [...parents][0] : null
      const group: GroupElement = {
        id: gid, type: 'group', name: t('apex_clip_group_name'),
        x: 0, y: 0, w: 0, h: 0, rotation: 0, visible: true, locked: false,
        opacity: 100, zIndex: Math.max(...chosen.map(c => c.zIndex)),
        fill: { type: 'none' }, stroke: null, parentId, collapsed: false, clipped: true,
      }
      return { ...prev, elements: [...prev.elements.map(el => sel.includes(el.id) && !el.symOf ? { ...el, parentId: gid } as VectorElement : el), group] }
    })
    setSelectedIds([gid])
  }, [pushHistory, t])
  // Release: dissolve the clipped group(s), children (mask included) come back
  // as ordinary siblings — mirrors ungroupSel but only touches clipped groups.
  const releaseClipMask = useCallback(() => {
    const sel = selectedIdsRef.current
    if (!sel.length) return
    const els = pageDataRef.current.elements
    const dissolve = new Set<string>()
    for (const id of sel) {
      let cur = els.find(e => e.id === id)
      // A selected child releases its enclosing clip group too.
      while (cur) {
        if (cur.type === 'group' && (cur as GroupElement).clipped) { dissolve.add(cur.id); break }
        cur = cur.parentId ? els.find(e => e.id === cur!.parentId) : undefined
      }
    }
    if (!dissolve.size) return
    pushHistory()
    setPageData(prev => {
      const grandparent = new Map<string, string | null>()
      for (const id of dissolve) grandparent.set(id, prev.elements.find(g => g.id === id)?.parentId ?? null)
      const elements = prev.elements
        .filter(e => !dissolve.has(e.id))
        .map(e => e.parentId && dissolve.has(e.parentId) ? { ...e, parentId: grandparent.get(e.parentId) ?? null } as VectorElement : e)
      return { ...prev, elements }
    })
    setSelectedIds([])
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
  // Select from the layers panel. A leaf selects itself. A container toggles: first
  // click selects its CONTENTS (source leaves — you can edit them); clicking it again
  // (contents already selected) collapses to the container as a single UNIT object
  // whose selection box covers everything (move/rotate the whole thing).
  const selectFromPanel = useCallback((id: string, additive: boolean) => {
    const els = pageDataRef.current.elements
    const el = els.find(e => e.id === id)
    setSelectedIds(prev => {
      let ids: string[]
      if (el && isContainer(el)) {
        const contents = descendantLeaves(els, id).filter(e => !e.symOf).map(e => e.id)
        const isContents = contents.length > 0 && prev.length === contents.length && contents.every(c => prev.includes(c))
        ids = isContents ? [id] : (contents.length ? contents : [id])
      } else {
        ids = [id]
      }
      return additive ? Array.from(new Set([...prev, ...ids])) : ids
    })
    setNodeSel([])
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
        const { shape: _s, sides: _si, spikes: _sp, innerRatio: _ir, params: _pa, ...rest } = el as PathElement
        void _s; void _si; void _sp; void _ir; void _pa
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
    const els = pageDataRef.current.elements
    // Expand selected groups into their leaves, keep canvas stacking order.
    const seen = new Set<string>()
    const chosen: VectorElement[] = []
    for (const e of els) {
      if (!sel.includes(e.id)) continue
      const leaves = isContainer(e) ? descendantLeaves(els, e.id) : [e]
      for (const leaf of leaves) {
        if (leaf.type === 'text' || isContainer(leaf) || leaf.symOf || seen.has(leaf.id)) continue
        seen.add(leaf.id); chosen.push(leaf)
      }
    }
    chosen.sort((a, b) => a.zIndex - b.zIndex)
    if (chosen.length < 2) return
    pushHistory()
    const allPts: PathPoint[] = []
    let anyClosed = false
    for (const el of chosen) {
      const pe = el.type === 'path' ? (el as PathElement) : toPathElement(el)
      if (pe.closed) anyClosed = true
      // Bake the element's own rotation into the merged geometry (positions AND
      // handle vectors) so the result matches exactly what was on screen.
      const a = ((el.rotation ?? 0) * Math.PI) / 180
      const c = Math.cos(a), s = Math.sin(a)
      const rotVec = (v?: [number, number]): [number, number] | undefined =>
        v && el.rotation ? [c * v[0] - s * v[1], s * v[0] + c * v[1]] : v
      pe.points.forEach((p, i) => {
        const [bx, by] = bakeRotation(el, p.x, p.y)
        allPts.push({
          x: bx, y: by,
          hIn: rotVec(p.hIn), hOut: rotVec(p.hOut),
          // First point of each merged object starts a new subpath; INNER `move`
          // markers of already-compound sources are preserved (they used to be lost).
          move: allPts.length > 0 && (i === 0 || p.move) ? true : undefined,
        })
      })
    }
    const mb = pathBounds(allPts, anyClosed)
    const base = chosen[0]
    const merged = {
      ...base, id: newId(), type: 'path', name: t('apex_merged_path'),
      points: allPts, closed: anyClosed, rotation: 0,
      x: mb.x, y: mb.y, w: mb.w, h: mb.h,
      shape: undefined, sides: undefined, spikes: undefined, innerRatio: undefined,
      groupId: undefined, parentId: base.parentId ?? null,
      zIndex: Math.max(...chosen.map(c => c.zIndex)),
    } as PathElement
    const keptIds = new Set(chosen.map(c => c.id))
    setPageData(prev => ({ ...prev, elements: pruneEmptyGroups([...prev.elements.filter(e => !keptIds.has(e.id)), merged]) }))
    setSelectedIds([merged.id])
    setNodeSel([])
  }, [pushHistory, t])

  // ── Pathfinder : opérations booléennes sur les objets sélectionnés ──────────
  const pathfinder = useCallback((op: BoolOp) => {
    const sel = selectedIdsRef.current
    const chosen = pageDataRef.current.elements
      .filter(e => sel.includes(e.id) && e.type !== 'text' && e.type !== 'group' && e.type !== 'image')
      .sort((a, b) => a.zIndex - b.zIndex)   // bottom → top (subtract = bottom minus rest)
    if (chosen.length < 2) return
    // Vertex-tag map: lets the refit place corners EXACTLY (intersections + true
    // input corners) instead of guessing from angles on the flattened polygon.
    const tags = new Map<string, VertexTag>()
    const multi = booleanCombine(chosen, op, tags)
    if (!multi || !multi.length) return
    const top = chosen[chosen.length - 1]   // inherit appearance from the top object
    const name = t(`apex_pf_${op}` as 'apex_pf_union')
    const result = pathFromMulti(multi, top, name, tags)
    if (!result) return
    pushHistory()
    const keptIds = new Set(chosen.map(c => c.id))
    setPageData(prev => ({ ...prev, elements: [...prev.elements.filter(e => !keptIds.has(e.id)), result] }))
    setSelectedIds([result.id])
    setNodeSel([])
  }, [pushHistory, t])

  // Extended pathfinder (Divide/Trim/Merge/Crop/Minus Back) → possibly many faces,
  // wrapped in a group (single face stays flat).
  const pathfinderX = useCallback((op: PathfinderOp) => {
    const sel = selectedIdsRef.current
    const chosen = pageDataRef.current.elements
      .filter(e => sel.includes(e.id) && e.type !== 'text' && e.type !== 'group' && e.type !== 'image')
      .sort((a, b) => a.zIndex - b.zIndex)
    if (chosen.length < 2) return
    const results = pathfinderMulti(chosen, op).map(f => pathFromMulti(f.multi, f.base, f.base.name)).filter(Boolean) as PathElement[]
    if (!results.length) return
    pushHistory()
    const keptIds = new Set(chosen.map(c => c.id))
    const baseZ = Math.min(...chosen.map(c => c.zIndex))
    const parents = new Set(chosen.map(c => c.parentId ?? null))
    const parentId = parents.size === 1 ? [...parents][0] : null
    if (results.length === 1) {
      const r = results[0]; r.zIndex = baseZ; r.parentId = parentId ?? undefined
      setPageData(prev => ({ ...prev, elements: [...prev.elements.filter(e => !keptIds.has(e.id)), r] }))
      setSelectedIds([r.id])
    } else {
      const gid = `g-${newId()}`
      const group: GroupElement = {
        id: gid, type: 'group', name: t(`apex_pfx_${op}` as 'apex_pfx_divide'),
        x: 0, y: 0, w: 0, h: 0, rotation: 0, visible: true, locked: false,
        opacity: 100, zIndex: baseZ, fill: { type: 'none' }, stroke: null, parentId, collapsed: false,
      }
      results.forEach((r, i) => { r.parentId = gid; r.zIndex = baseZ + i })
      setPageData(prev => ({ ...prev, elements: [...prev.elements.filter(e => !keptIds.has(e.id)), group, ...results] }))
      setSelectedIds([gid])
    }
    setNodeSel([])
  }, [pushHistory, t])

  // Join (Ctrl+J): close a single open path, or stitch two open paths at their
  // nearest endpoints. Reversing a path swaps each point's in/out handles.
  const joinSel = useCallback(() => {
    const sel = selectedIdsRef.current
    const pd = pageDataRef.current
    const paths = pd.elements.filter(e => sel.includes(e.id) && e.type === 'path') as PathElement[]
    if (paths.length === 1) {
      const p = paths[0]
      if (p.closed || p.points.length < 2) return
      pushHistory()
      setPageData(prev => ({ ...prev, elements: prev.elements.map(e => e.id === p.id ? { ...(e as PathElement), closed: true } : e) }))
      return
    }
    if (paths.length !== 2) return
    const [a, b] = paths
    if (a.closed || b.closed) return
    const rev = (arr: PathPoint[]) => arr.slice().reverse().map(pt => ({ ...pt, hIn: pt.hOut, hOut: pt.hIn }))
    const d = (p: PathPoint, q: PathPoint) => Math.hypot(p.x - q.x, p.y - q.y)
    const aF = a.points[0], aL = a.points[a.points.length - 1], bF = b.points[0], bL = b.points[b.points.length - 1]
    const combo = [
      { d: d(aL, bF), A: a.points, B: b.points },
      { d: d(aL, bL), A: a.points, B: rev(b.points) },
      { d: d(aF, bF), A: rev(a.points), B: b.points },
      { d: d(aF, bL), A: rev(a.points), B: rev(b.points) },
    ].sort((x, y) => x.d - y.d)[0]
    const points: PathPoint[] = [...combo.A.map(p => ({ ...p, move: undefined })), ...combo.B.map((p, i) => ({ ...p, move: i === 0 ? undefined : p.move }))]
    const bb = pathBounds(points, false)
    const merged: PathElement = { ...a, id: newId(), points, closed: false, x: bb.x, y: bb.y, w: bb.w || 1, h: bb.h || 1 }
    pushHistory()
    const ids = new Set([a.id, b.id])
    setPageData(prev => ({ ...prev, elements: [...prev.elements.filter(e => !ids.has(e.id)), merged] }))
    setSelectedIds([merged.id])
  }, [pushHistory])

  // ── Distort effects (Twist / Pucker&Bloat / Roughen / ZigZag) ────────────────
  const distortBaseRef = useRef<VectorElement | null>(null)
  const applyDistort = useCallback((fx: DistortFx, amount: number, detail: number) => {
    const base = distortBaseRef.current
    if (!base) return
    const preview = distortElement(base, fx, amount, detail)
    if (!preview) return
    preview.id = base.id; preview.zIndex = base.zIndex; preview.parentId = base.parentId
    setPageData(prev => ({ ...prev, elements: prev.elements.map(e => e.id === base.id ? preview : e) }))
  }, [])
  const openDistort = useCallback((fx: DistortFx) => {
    const sel = selectedIdsRef.current
    const el = pageDataRef.current.elements.find(e => e.id === sel[0])
    if (sel.length !== 1 || !el || el.type === 'text' || el.type === 'image' || isContainer(el)) return
    pushHistory()
    distortBaseRef.current = el
    const amt = fx === 'twist' ? 30 : fx === 'pucker' ? 30 : 20
    setDistortDlg({ fx, amount: amt, detail: 4 })
    applyDistort(fx, amt, 4)
  }, [pushHistory, applyDistort])

  // Average (Ctrl+Alt+J): collapse the selected anchors onto their centroid.
  const averageNodes = useCallback(() => {
    const sel = selectedIdsRef.current
    const idxs = nodeSelRef.current
    if (sel.length !== 1 || idxs.length < 2) return
    const el = pageDataRef.current.elements.find(e => e.id === sel[0])
    if (!el || el.type !== 'path') return
    const pe = el as PathElement
    const cx = idxs.reduce((s, i) => s + pe.points[i].x, 0) / idxs.length
    const cy = idxs.reduce((s, i) => s + pe.points[i].y, 0) / idxs.length
    pushHistory()
    const np = pe.points.map((p, i) => idxs.includes(i) ? { ...p, x: cx, y: cy } : p)
    const bb = pathBounds(np, pe.closed)
    setPageData(prev => ({ ...prev, elements: prev.elements.map(e => e.id === pe.id ? { ...pe, points: np, x: bb.x, y: bb.y, w: bb.w, h: bb.h } as VectorElement : e) }))
  }, [pushHistory])

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

  // ── Raster images: import (file picker / drag-and-drop) + vectorisation ──────
  const fileInputRef = useRef<HTMLInputElement>(null)
  const importImageFiles = useCallback((files: FileList | File[], at?: { x: number; y: number }) => {
    const list = [...files].filter(f => f.type.startsWith('image/'))
    if (!list.length) return
    pushHistory()
    list.forEach((file, k) => {
      const reader = new FileReader()
      reader.onload = () => {
        const src = String(reader.result)
        const probe = new Image()
        probe.onload = () => {
          // Fit oversized bitmaps inside the artboard; keep small ones 1:1.
          const ab = pageDataRef.current.artboards[0]
          const maxW = ab ? ab.width * 0.6 : 800, maxH = ab ? ab.height * 0.6 : 600
          const sc = Math.min(1, maxW / probe.naturalWidth, maxH / probe.naturalHeight)
          const w = Math.max(8, probe.naturalWidth * sc), h = Math.max(8, probe.naturalHeight * sc)
          const cx = at ? at.x : ab ? ab.x + ab.width / 2 : 0
          const cy = at ? at.y : ab ? ab.y + ab.height / 2 : 0
          const el: import('./api').ImageElement = {
            id: newId(), type: 'image', name: file.name.replace(/\.[^.]+$/, '') || t('apex_image'),
            x: cx - w / 2 + k * 24, y: cy - h / 2 + k * 24, w, h,
            rotation: 0, visible: true, locked: false, opacity: 100,
            zIndex: pageDataRef.current.elements.length + k,
            fill: { type: 'none' }, stroke: null, parentId: null,
            src, natW: probe.naturalWidth, natH: probe.naturalHeight,
          }
          setPageData(prev => ({ ...prev, elements: [...prev.elements, el] }))
          setSelectedIds([el.id])
        }
        probe.src = src
      }
      reader.readAsDataURL(file)
    })
  }, [pushHistory, t])

  // Import dropped SVG files as EDITABLE vector shapes (not a raster image): parse
  // the SVG, translate its drawing to the drop point, wrap it in a group.
  const importSvgFiles = useCallback((files: FileList | File[], at?: { x: number; y: number }) => {
    const list = [...files].filter(f => f.type === 'image/svg+xml' || /\.svg$/i.test(f.name))
    if (!list.length) return
    list.forEach((file, fi) => {
      const reader = new FileReader()
      reader.onload = async () => {
        try {
          const { svgToPageData } = await import('./apexSvg')
          const parsed = svgToPageData(String(reader.result))
          const imported = parsed.elements
          if (!imported.length) return
          // Centre the imported drawing on the drop point.
          const bb = selBBox(imported.filter(e => !isContainer(e)))
          const ab = pageDataRef.current.artboards[0]
          const tx = (at ? at.x : ab ? ab.x + ab.width / 2 : 0) - (bb ? bb.x + bb.w / 2 : 0) + fi * 24
          const ty = (at ? at.y : ab ? ab.y + ab.height / 2 : 0) - (bb ? bb.y + bb.h / 2 : 0) + fi * 24
          pushHistory()
          const gid = `g-${newId()}`
          setPageData(prev => {
            const z0 = prev.elements.length
            const moved = imported.map((e, i) => {
              const t2 = translateEl(e, tx, ty)
              return { ...t2, parentId: e.parentId ?? gid, zIndex: z0 + 1 + i } as VectorElement
            })
            const group: GroupElement = {
              id: gid, type: 'group', name: file.name.replace(/\.svg$/i, '') || t('apex_group_name'),
              x: 0, y: 0, w: 0, h: 0, rotation: 0, visible: true, locked: false,
              opacity: 100, zIndex: z0, fill: { type: 'none' }, stroke: null, parentId: null, collapsed: true,
            }
            return { ...prev, elements: [...prev.elements, group, ...moved] }
          })
          setSelectedIds([gid])
        } catch { /* invalid SVG → ignore */ }
      }
      reader.readAsText(file)
    })
  }, [pushHistory, t])

  // ── Pasting images from the system clipboard ─────────────────────────────────
  // Whatever the user copied elsewhere — a screenshot, a browser image, SVG markup
  // from a design tool — lands as real content at the centre of the view: SVG as
  // editable shapes, bitmaps as a placed image.
  const viewCentre = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined
    const rect = canvas.getBoundingClientRect()
    return toCanvas({ clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }, rect, csRef.current)
  }, [])

  // Consumes an image from the clipboard payload; false when there was none, so
  // the caller can fall back to the internal element clipboard.
  const pasteImagePayload = useCallback((files: File[], text: string) => {
    const at = viewCentre()
    const isSvg = (f: File) => f.type === 'image/svg+xml' || /\.svg$/i.test(f.name)
    const svgs = files.filter(isSvg)
    const rasters = files.filter(f => f.type.startsWith('image/') && !isSvg(f))
    if (svgs.length || rasters.length) {
      if (svgs.length) importSvgFiles(svgs, at)
      if (rasters.length) importImageFiles(rasters, at)
      return true
    }
    // No file entry: many apps put raw SVG markup on the clipboard as plain text.
    if (/^\s*(?:<\?xml[^>]*\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)*\s*<svg[\s>]/i.test(text)) {
      importSvgFiles([new File([text], 'clipboard.svg', { type: 'image/svg+xml' })], at)
      return true
    }
    return false
  }, [importImageFiles, importSvgFiles, viewCentre])

  // Menu/context-menu paste: no ClipboardEvent to read, so ask the async API.
  // Unavailable or denied (Firefox, insecure context) → internal clipboard.
  const pasteSmart = useCallback(async (inPlace = false) => {
    try {
      const files: File[] = []
      let text = ''
      for (const item of await navigator.clipboard.read()) {
        const imgType = item.types.find(ty => ty.startsWith('image/'))
        if (imgType) {
          const blob = await item.getType(imgType)
          files.push(new File([blob], imgType === 'image/svg+xml' ? 'clipboard.svg' : 'clipboard', { type: imgType }))
        } else if (!text && item.types.includes('text/plain')) {
          text = await (await item.getType('text/plain')).text()
        }
      }
      if (pasteImagePayload(files, text)) return
    } catch { /* no clipboard permission → internal clipboard only */ }
    if (inPlace) pasteInPlace(); else pasteSel()
  }, [pasteImagePayload, pasteInPlace, pasteSel])

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const tgt = e.target
      if (tgt instanceof HTMLInputElement || tgt instanceof HTMLTextAreaElement || tgt instanceof HTMLSelectElement) return
      pasteHandledRef.current = true
      const inPlace = pasteInPlaceRef.current
      pasteInPlaceRef.current = false
      const dt = e.clipboardData
      e.preventDefault()
      if (pasteImagePayload(dt ? [...dt.files] : [], dt?.getData('text/plain') ?? '')) return
      if (inPlace) pasteInPlace(); else pasteSel()
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [pasteImagePayload, pasteInPlace, pasteSel])

  // ── Export dialog (format / scope / preview) — see ApexExportDialog below ────
  const [exportDlg, setExportDlg] = useState(false)

  // "Image trace" dialog on the visioncortex/VTracer engine (server-side): the
  // bitmap is uploaded, clustered and spline-fitted there, and comes back as an
  // SVG this editor imports as editable shapes. Options mirror VTracer's.
  const [traceDlg, setTraceDlg]   = useState<string | null>(null)   // image element id
  const [traceOpts, setTraceOpts] = useState<TraceOpts>(() => {
    try { return { ...TRACE_DEFAULTS, ...JSON.parse(localStorage.getItem('apex:trace') || '{}') } }
    catch { return TRACE_DEFAULTS }
  })
  const patchTrace = useCallback((p: Partial<TraceOpts>) => {
    setTraceOpts(prev => {
      const next = { ...prev, ...p }
      try { localStorage.setItem('apex:trace', JSON.stringify(next)) } catch { /* quota */ }
      return next
    })
  }, [])
  const [traceOcr, setTraceOcr]   = useState(true)     // recognize text lines as real text
  const [traceBusy, setTraceBusy] = useState(false)    // OCR / server trace in flight
  const [traceErr, setTraceErr]   = useState<string | null>(null)
  const traceBusyRef = useRef(false)
  // ── Live preview: re-trace (debounced) whenever an option changes ────────────
  const [tracePrev, setTracePrev]         = useState<string | null>(null)  // result SVG text
  const [tracePrevBusy, setTracePrevBusy] = useState(false)
  const [traceCount, setTraceCount]       = useState<{ before: number; after: number } | null>(null)
  const [prevView, setPrevView]           = useState({ z: 1, x: 0, y: 0 }) // preview zoom/pan
  const tracePayloadRef = useRef<{ id: string; url: string; w: number; h: number } | null>(null)
  const traceSeqRef     = useRef(0)
  // Server result per (payload, server options): moving the client-only
  // "simplify" slider re-simplifies locally without re-tracing on the server.
  const traceSrvRef     = useRef<{ key: string; svg: string } | null>(null)
  // Parse the server SVG, drop shape-neutral anchors, rebuild a preview SVG.
  // Returns exactly what applyTrace would put in the document.
  const processTraceSvg = useCallback(async (svg: string, eps: number): Promise<{ svg: string; before: number; after: number }> => {
    const [{ svgToPageData, pathToD }, { simplifyTracedPoints }] = await Promise.all([
      import('./apexSvg'), import('./apexSimplify'),
    ])
    const paths = svgToPageData(svg).elements.filter(e => e.type === 'path') as PathElement[]
    let before = 0, after = 0
    const out = paths.map(p => {
      before += p.points.length
      const points = simplifyTracedPoints(p.points, p.closed, eps)
      after += points.length
      return { ...p, points }
    })
    const pl = tracePayloadRef.current
    const w = pl?.w ?? 0, h = pl?.h ?? 0
    const body = out.map(p =>
      `<path d="${pathToD(p.points, p.closed)}" fill="${p.fill.type === 'solid' ? p.fill.color : '#000'}"/>`).join('\n')
    return {
      svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">\n${body}\n</svg>`,
      before, after,
    }
  }, [])
  const PREV_BOX = { w: 430, h: 470 }   // fixed preview viewport (px)
  const fitPreview = useCallback(() => {
    const p = tracePayloadRef.current
    if (!p) return
    const z = Math.min(PREV_BOX.w / p.w, PREV_BOX.h / p.h)
    setPrevView({ z, x: (PREV_BOX.w - p.w * z) / 2, y: (PREV_BOX.h - p.h * z) / 2 })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!traceDlg) { tracePayloadRef.current = null; setTracePrev(null); return }
    // Rasterise the source once per dialog opening (preview traces WITHOUT the
    // OCR pass — it is slow, and erased text zones barely change the tuning).
    const el = pageDataRef.current.elements.find(e => e.id === traceDlg)
    if (!el || el.type !== 'image') return
    const bmp = imageBitmapCache.get((el as import('./api').ImageElement).src)
    if (!bmp || !bmp.complete || !bmp.naturalWidth) return
    tracePayloadRef.current = { id: traceDlg, ...rasterForTrace(bmp) }
    fitPreview()
  }, [traceDlg, fitPreview])
  useEffect(() => {
    if (!traceDlg) return
    const payload = tracePayloadRef.current
    if (!payload || payload.id !== traceDlg) return
    const seq = ++traceSeqRef.current
    setTracePrevBusy(true)
    const srvKey = payload.id + JSON.stringify(traceOptsToPayload(traceOpts))
    const timer = setTimeout(() => {
      const srv = traceSrvRef.current?.key === srvKey
        ? Promise.resolve(traceSrvRef.current!.svg)
        : apexApi.traceImage({ image: payload.url, ...traceOptsToPayload(traceOpts) })
            .then(svg => { traceSrvRef.current = { key: srvKey, svg }; return svg })
      srv
        .then(svg => processTraceSvg(svg, traceOpts.simplify))
        .then(r => {
          if (traceSeqRef.current !== seq) return
          setTracePrev(r.svg)
          setTraceCount({ before: r.before, after: r.after })
          setTraceErr(null)
        })
        .catch(() => { if (traceSeqRef.current === seq) { setTracePrev(null); setTraceCount(null) } })
        .finally(() => { if (traceSeqRef.current === seq) setTracePrevBusy(false) })
    }, 350)
    return () => clearTimeout(timer)
  }, [traceDlg, traceOpts, processTraceSvg])
  const applyTrace = useCallback(async () => {
    if (!traceDlg || traceBusyRef.current) return
    const el = pageDataRef.current.elements.find(e => e.id === traceDlg)
    if (!el || el.type !== 'image') { setTraceDlg(null); return }
    const ie = el as import('./api').ImageElement
    const bmp = imageBitmapCache.get(ie.src)
    if (!bmp || !bmp.complete || !bmp.naturalWidth) { setTraceDlg(null); return }
    traceBusyRef.current = true; setTraceBusy(true); setTraceErr(null)
    try {
      // OCR pass (optional): extract text lines as REAL text elements and erase
      // them from the tracing source so shapes and text are vectorized separately.
      let src: TraceSource = bmp
      let texts: OcrText[] = []
      if (traceOcr) {
        try { ({ src, texts } = await ocrPrepare(bmp, el.x, el.y, el.w, el.h)) } catch { /* trace without OCR */ }
      }
      // Without OCR the source is the raw bitmap — exactly what the live preview
      // traced — so reuse its (already simplified) result instead of a second
      // server round-trip.
      let svg: string, cw: number, ch: number
      const cached = tracePayloadRef.current
      const reused = !traceOcr && !!tracePrev && !!cached && cached.id === traceDlg
      if (reused) {
        svg = tracePrev!; cw = cached!.w; ch = cached!.h
      } else {
        const r = rasterForTrace(src)
        cw = r.w; ch = r.h
        svg = await apexApi.traceImage({ image: r.url, ...traceOptsToPayload(traceOpts) })
      }
      const { svgToPageData } = await import('./apexSvg')
      let traced = svgToPageData(svg).elements.filter(e => e.type === 'path') as PathElement[]
      if (!traced.length) { setTraceErr(t('apex_trace_empty')); return }
      // Drop shape-neutral anchors (collinear runs, mergeable smooth curves).
      if (!reused && traceOpts.simplify > 0) {
        const { simplifyTracedPoints } = await import('./apexSimplify')
        traced = traced.map(p => ({ ...p, points: simplifyTracedPoints(p.points, p.closed, traceOpts.simplify) }))
      }
      // Map from trace-canvas pixel space into the placed element's box.
      const sx = el.w / cw, sy = el.h / ch
      const mapped = traced.map(p => {
        const points = p.points.map(pt => {
          const out: PathPoint = { x: el.x + pt.x * sx, y: el.y + pt.y * sy, move: pt.move }
          if (pt.hIn)  out.hIn  = [pt.hIn[0] * sx,  pt.hIn[1] * sy]
          if (pt.hOut) out.hOut = [pt.hOut[0] * sx, pt.hOut[1] * sy]
          return out
        })
        return { ...p, points }
      })
      setTraceDlg(null)
      pushHistory()
      const mkText = (tx: OcrText, zIndex: number, parentId: string | null): TextElement => ({
        id: newId(), type: 'text', name: tx.text.slice(0, 24),
        text: tx.text, x: tx.x, y: tx.y, w: tx.w, h: tx.h,
        rotation: el.rotation, visible: true, locked: false, opacity: el.opacity,
        zIndex, parentId,
        fill: { type: 'solid', color: tx.color, opacity: 100 }, stroke: null,
        fontSize: tx.fontSize, fontFamily: 'Inter', fontWeight: tx.bold ? 700 : 400,
        italic: false, align: 'left',
      })
      // Single path (typical of binary mode): replace the image in place, no group.
      if (mapped.length === 1 && !texts.length) {
        const bb = pathBounds(mapped[0].points, true)
        const traced1: PathElement = {
          ...mapped[0], id: newId(), name: el.name,
          x: bb.x, y: bb.y, w: bb.w || 1, h: bb.h || 1,
          rotation: el.rotation, opacity: el.opacity,
          zIndex: el.zIndex, parentId: el.parentId ?? null,
        }
        setPageData(prev => ({ ...prev, elements: prev.elements.map(e => e.id === el.id ? traced1 : e) }))
        setSelectedIds([traced1.id])
        return
      }
      // One path per colour region (bottom→top) + OCR texts on top, in a group.
      const gid = `g-${newId()}`
      const group: GroupElement = {
        id: gid, type: 'group', name: el.name,
        x: 0, y: 0, w: 0, h: 0, rotation: 0, visible: true, locked: false,
        opacity: 100, zIndex: el.zIndex,
        fill: { type: 'none' }, stroke: null, parentId: el.parentId ?? null, collapsed: true,
      }
      const paths = mapped.map((p, i) => {
        const bb = pathBounds(p.points, true)
        return {
          ...p, id: newId(), name: `${el.name} ${i + 1}`,
          x: bb.x, y: bb.y, w: bb.w || 1, h: bb.h || 1,
          rotation: el.rotation, opacity: el.opacity,
          zIndex: i, parentId: gid,
        } as PathElement
      })
      const textEls = texts.map((tx, i) => mkText(tx, paths.length + i, gid))
      setPageData(prev => ({ ...prev, elements: [...prev.elements.filter(e => e.id !== el.id), group, ...paths, ...textEls] }))
      setSelectedIds([...paths.map(p => p.id), ...textEls.map(t2 => t2.id)])
    } catch (err) {
      setTraceErr(err instanceof Error ? err.message : t('apex_trace_failed'))
    } finally {
      traceBusyRef.current = false; setTraceBusy(false)
    }
  }, [traceDlg, traceOpts, traceOcr, tracePrev, pushHistory, t])

  // ── Delete the selected node (direct-selection tool) ─────────────────────────
  const deleteNode = useCallback(() => {
    const sel = selectedIdsRef.current
    const idxs = nodeSelRef.current
    if (sel.length !== 1 || !idxs.length) return
    const drop = new Set(idxs)
    pushHistory()
    setPageData(prev => ({ ...prev, elements: prev.elements.flatMap(el => {
      if (el.id !== sel[0] || el.type !== 'path') return [el]
      const filtered = (el as PathElement).points.filter((_, i) => !drop.has(i))
      if (filtered.length < 2) return []   // path collapsed → drop it
      const pts = reflowAuto(filtered, (el as PathElement).closed)
      const bb = pathBounds(pts, (el as PathElement).closed)
      return [{ ...el, points: pts, x: bb.x, y: bb.y, w: bb.w, h: bb.h } as VectorElement]
    }) }))
    setNodeSel([])
  }, [pushHistory])

  // ── Node-type conversion (direct-selection contextual toolbar) ───────────────
  // Applies to exactly the SELECTED anchor(s) — never the whole path. Handles
  // change the true curve extent → rebase the bbox.
  const setAnchorType = useCallback((type: AnchorType) => {
    const sel = selectedIdsRef.current
    const idxs = nodeSelRef.current
    if (sel.length !== 1 || !idxs.length) return
    const el = pageDataRef.current.elements.find(e => e.id === sel[0])
    if (!el || el.type !== 'path') return
    pushHistory()
    setPageData(prev => ({ ...prev, elements: prev.elements.map(e => {
      if (e.id !== el.id || e.type !== 'path') return e
      let pe = e as PathElement
      for (const i of idxs) pe = convertAnchor(pe, i, type)
      const bb = pathBounds(pe.points, pe.closed)
      return { ...pe, x: bb.x, y: bb.y, w: bb.w, h: bb.h }
    }) }))
  }, [pushHistory])

  // Live node type shared by ALL selected anchors (for toolbar highlighting) —
  // null when the selection mixes types or nothing is selected.
  const activeAnchorType: AnchorType | null = (() => {
    if (tool !== 'node' || selectedIds.length !== 1 || !nodeSel.length) return null
    const el = pageData.elements.find(e => e.id === selectedIds[0])
    if (!el || el.type !== 'path') return null
    const types = nodeSel.map(i => classifyAnchor(el as PathElement, i))
    return types.every(t => t === types[0]) ? types[0] : null
  })()

  // Current-tool name for the persistent options bar (strips the "(X)" shortcut).
  const optToolLabel = (() => {
    const map: Record<string, string> = {
      select: 'apex_tool_select', node: 'apex_tool_node', pen: 'apex_tool_pen',
      pencil: 'apex_tool_pencil', brush: 'apex_tool_brush', text: 'apex_tool_text',
      rect: 'apex_rectangle', ellipse: 'apex_ellipse', line: 'apex_tool_line',
      hand: 'apex_tool_hand', eyedropper: 'apex_tool_eyedropper', zoom: 'apex_tool_zoom',
      rotateview: 'apex_tool_rotate_view',
    }
    const key = tool === 'shape' ? curShape.nameKey : map[tool]
    return key ? String(t(key)).replace(/\s*\([^)]*\)\s*$/, '') : ''
  })()

  // Double-click a path with the select tool → jump straight into node editing.
  // Nearest editable path corner to a canvas point among `cands` (and their symmetry
  // clones), within grab range. Returns the SOURCE path id + vertex index + current angle.
  const cornerNear = useCallback((pt: { x: number; y: number }, zoom: number, cands: (VectorElement | undefined)[]) => {
    const pd = pageDataRef.current
    const thr = 16 / zoom
    let best = thr, found: { srcId: string; ptIndex: number; deg: number } | null = null
    const targets: VectorElement[] = []
    for (const el of cands) {
      if (!el || isContainer(el) || el.type !== 'path') continue
      targets.push(el)
      for (const c of pd.elements) if (c.symOf === el.id && c.type === 'path') targets.push(c)
    }
    for (const el of targets) {
      for (const cn of elCornerAngles(el)) {
        if (cn.ptIndex < 0) continue
        const d = Math.hypot(pt.x - cn.x, pt.y - cn.y)
        if (d < best) { best = d; found = { srcId: el.symOf ?? el.id, ptIndex: cn.ptIndex, deg: cn.deg } }
      }
    }
    return found
  }, [])
  // Live-apply a new interior angle to a source path corner (used by the dialog).
  // Always rebuilds from the ORIGINAL points captured at open time, so changing the
  // slider OR the absorption strategy re-derives cleanly (never compounds).
  const applyCornerAngle = useCallback((srcId: string, ptIndex: number, deg: number, strat: AngleStrat, base: PathPoint[]) => {
    setPageData(prev => ({ ...prev, elements: prev.elements.map(el => {
      if (el.id !== srcId || el.type !== 'path') return el
      const pe = el as PathElement
      const pts = setPathCornerAngle({ ...pe, points: base }, ptIndex, deg, strat)
      const bb = pathBounds(pts, pe.closed)
      return { ...pe, points: pts, x: bb.x, y: bb.y, w: bb.w, h: bb.h } as VectorElement
    }) }))
  }, [])
  const openAngleDialog = useCallback((c: { srcId: string; ptIndex: number; deg: number }) => {
    const src = pageDataRef.current.elements.find(x => x.id === c.srcId)
    if (!src || src.type !== 'path') return
    pushHistory()   // one undo step covers the whole edit; Cancel pops it back
    setHoverAngle(null)
    setAngleDlg({ srcId: c.srcId, ptIndex: c.ptIndex, value: Math.round(c.deg * 10) / 10, strat: 'out', base: (src as PathElement).points })
  }, [pushHistory])

  const onCanvasDoubleClick = useCallback((e: React.MouseEvent) => {
    if (toolRef.current !== 'select') return
    const canvas = canvasRef.current; if (!canvas) return
    const pt = toCanvas(e, canvas.getBoundingClientRect(), csRef.current)
    const pd = pageDataRef.current
    // Double-clicking a corner of a SELECTED path opens the angle editor.
    const corner = cornerNear(pt, csRef.current.zoom, selectedIdsRef.current.map(id => pd.elements.find(x => x.id === id)))
    if (corner) { openAngleDialog(corner); return }
    const sorted = renderLeaves(pd.elements).map(o => o.el).reverse()
    const hit = sorted.find(el => !effLocked(pd.elements, el) && hitTest(el, pt.x, pt.y, csRef.current.zoom))
    if (hit && hit.type === 'path') {
      setSelectedIds([hit.id])
      setNodeSel([])
      setTool('node')
      return
    }
    // Double-clicking a symmetry clone enters node editing on its SOURCE (clones are
    // locked, so the plain hit-test above skips them); the source's mesh — and every
    // clone's mesh — then becomes editable.
    const cloneHit = sorted.find(el => el.symOf && el.type === 'path' && el.visible && hitTest(el, pt.x, pt.y, csRef.current.zoom))
    if (cloneHit && cloneHit.symOf) {
      const src = pd.elements.find(x => x.id === cloneHit.symOf)
      if (src && src.type === 'path') { setSelectedIds([src.id]); setNodeSel([]); setTool('node') }
    }
  }, [cornerNear, openAngleDialog])

  // ── Right-click context menu ───────────────────────────────────────────────
  const ctx = useContextMenu()
  const onCanvasContextMenu = useCallback((e: React.MouseEvent) => {
    const canvas = canvasRef.current; if (!canvas) return
    const pt = toCanvas(e, canvas.getBoundingClientRect(), csRef.current)
    const sorted = [...pageDataRef.current.elements].sort((a, b) => b.zIndex - a.zIndex)
    const hit = sorted.find(el => el.visible && !el.locked && hitTest(el, pt.x, pt.y, csRef.current.zoom))
    if (hit) {
      if (!selectedIdsRef.current.includes(hit.id)) setSelectedIds([hit.id])
      const multi = selectedIdsRef.current.length > 1
      // A right-click landing on a path vertex offers "Edit angle…" first.
      const corner = hit.type === 'path' ? cornerNear(pt, csRef.current.zoom, [hit]) : null
      const items: CtxItem[] = [
        ...(corner ? [{ label: t('apex_edit_angle'), onClick: () => openAngleDialog(corner) } as CtxItem, 'sep' as CtxItem] : []),
        { label: t('menu_undo'),       onClick: undo },
        'sep',
        { label: t('apex_ctx_cut'),    onClick: cutSel,       shortcut: 'Ctrl+X' },
        { label: t('apex_ctx_copy'),   onClick: copySel,      shortcut: 'Ctrl+C' },
        { label: t('apex_copy_kubuno', { defaultValue: 'Copier pour Kubuno' }), onClick: copyForKubuno },
        { label: t('apex_ctx_paste'),  onClick: () => { void pasteSmart() }, shortcut: 'Ctrl+V' },
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
        ...(multi ? [{ label: t('apex_clip_make'), onClick: makeClipMask, shortcut: 'Ctrl+7' } as CtxItem] : []),
        ...(hit.parentId != null ? [{ label: t('apex_clip_release'), onClick: releaseClipMask, shortcut: 'Ctrl+Alt+7' } as CtxItem] : []),
        ...(hit.type === 'rect' || hit.type === 'ellipse' || (hit.type === 'path' && (hit as PathElement).shape)
          ? [{ label: t('apex_convert_to_path'), onClick: convertToPath } as CtxItem] : []),
        ...(multi ? [{ label: t('apex_merge'), onClick: mergeSel } as CtxItem] : []),
        ...(multi ? [
          'sep' as CtxItem,
          { label: t('apex_pf_union'),     onClick: () => pathfinder('union') } as CtxItem,
          { label: t('apex_pf_subtract'),  onClick: () => pathfinder('subtract') } as CtxItem,
          { label: t('apex_pf_intersect'), onClick: () => pathfinder('intersect') } as CtxItem,
          { label: t('apex_pf_exclude'),   onClick: () => pathfinder('exclude') } as CtxItem,
          { label: t('apex_pfx_divide'),   onClick: () => pathfinderX('divide') } as CtxItem,
          { label: t('apex_pfx_trim'),     onClick: () => pathfinderX('trim') } as CtxItem,
          { label: t('apex_pfx_merge'),    onClick: () => pathfinderX('merge') } as CtxItem,
          { label: t('apex_pfx_crop'),     onClick: () => pathfinderX('crop') } as CtxItem,
          { label: t('apex_pfx_minusback'),onClick: () => pathfinderX('minusback') } as CtxItem,
        ] : []),
        ...(multi ? [{ label: t('apex_join'), onClick: joinSel, shortcut: 'Ctrl+J' } as CtxItem] : []),
        ...(!multi && hit.type === 'path' ? [
          'sep' as CtxItem,
          { label: t('apex_path_simplify'), onClick: () => simplifySel() } as CtxItem,
          { label: t('apex_path_smooth'),   onClick: smoothSel } as CtxItem,
        ] : []),
        ...(!multi && hit.stroke && hit.stroke.width > 0
          ? [{ label: t('apex_path_outline'), onClick: outlineStrokeSel } as CtxItem] : []),
        ...(!multi && hit.type !== 'text' && hit.type !== 'image' && !isContainer(hit) ? [
          'sep' as CtxItem,
          { label: t('apex_fx_twist'),   onClick: () => openDistort('twist') } as CtxItem,
          { label: t('apex_fx_pucker'),  onClick: () => openDistort('pucker') } as CtxItem,
          { label: t('apex_fx_roughen'), onClick: () => openDistort('roughen') } as CtxItem,
          { label: t('apex_fx_zigzag'),  onClick: () => openDistort('zigzag') } as CtxItem,
        ] : []),
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
        { label: t('apex_ctx_paste'), onClick: () => { void pasteSmart() }, shortcut: 'Ctrl+V' },
        { label: t('apex_ctx_select_all'), onClick: selectAll, shortcut: 'Ctrl+A' },
      ])
    }
  }, [ctx, t, undo, cutSel, copySel, copyForKubuno, pasteSmart, duplicateSel, reorder, flip, align, deleteSel, selectAll, groupSel, ungroupSel, convertToPath, mergeSel, pathfinder, pathfinderX, joinSel, simplifySel, smoothSel, outlineStrokeSel, openDistort, cornerNear, openAngleDialog])

  // ── Commit pen path ──────────────────────────────────────────────────────────
  const commitPenPath = useCallback((points: PathPoint[], closed: boolean) => {
    if (points.length < 2) { setPenProgress(null); return }
    pushHistory()
    const { x, y, w, h } = pathBounds(points, closed)
    const newEl: PathElement = {
      id: newId(), type: 'path', name: t('apex_path_name'),
      x, y, w: w || 1, h: h || 1,
      rotation: 0, visible: true, locked: false, opacity: 100,
      zIndex: 0, // set below
      // Inherit the active paint (same defaults as the predefined shapes).
      fill: closed ? { type: 'solid', color: curFillRef.current, opacity: 100 } : { type: 'none' },
      stroke: { color: curStrokeRef.current, opacity: 100, width: 2, dashArray: [] },
      points,
      closed,
    }
    setPageData(prev => {
      const el = { ...newEl, zIndex: prev.elements.length }
      // Live symmetry: drop the new path into the drawing container.
      return placeInDrawSym({ ...prev, elements: [...prev.elements, el] }, el.id)
    })
    setSelectedIds([newEl.id])
    setPenProgress(null)
    // Bascule en édition de nœuds : le tracé fraîchement créé est aussitôt
    // modifiable (ancres + poignées), au lieu de retomber sur la sélection.
    setTool('node')
  }, [t, pushHistory, placeInDrawSym])

  // ── Render ─────────────────────────────────────────────────────────────────
  // The backing store is only re-allocated when the canvas size / DPR actually
  // changes (setting canvas.width forces a full GPU surface realloc per frame).
  const canvasSizeRef = useRef({ w: 0, h: 0, dpr: 0 })
  const sceneCacheRef = useRef<{ canvas: HTMLCanvasElement; key: unknown[] } | null>(null)
  const doRender = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    const { width: w, height: h } = canvas.getBoundingClientRect()
    const sz = canvasSizeRef.current
    if (sz.w !== w || sz.h !== h || sz.dpr !== dpr) {
      canvas.width  = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      canvasSizeRef.current = { w, h, dpr }
    }
    const grid = { size: gridSize, on: gridOn }
    const view = { rulers: rulersOn, guidesOn, outline: outlineMode, tempGuide,
      symmetry: (() => {
        // A selected symmetry container (or a container of a selected child)
        // shows its own movable axes; else the drawing-mode centre.
        for (const id of selectedIds) {
          const el = pageData.elements.find(e => e.id === id); if (!el) continue
          let cur: VectorElement | undefined = el
          const seen = new Set<string>()
          while (cur) {
            if (cur.type === 'symmetry') { const s = cur as SymmetryElement; return { mode: s.symMode, count: s.symCount, cx: s.cx, cy: s.cy, rot: s.rotation || 0 } }
            if (!cur.parentId || seen.has(cur.parentId)) break
            seen.add(cur.parentId); cur = pageData.elements.find(e => e.id === cur!.parentId)
          }
        }
        if (symLive === 'off') return null
        const ab = pageData.artboards[0]
        const c = symCenter ?? (ab ? { x: ab.x + ab.width / 2, y: ab.y + ab.height / 2 } : null)
        return c ? { mode: symLive, count: symCount, cx: c.x, cy: c.y, rot: 0 } : null
      })(), snapTouch }
    // Cached scene layer: the artwork (bg + artboards + grid + elements) is rasterised
    // to an offscreen bitmap and rebuilt ONLY when a scene input changes (pageData, cs,
    // size, grid, outline). Overlay-only frames — hover, marquee, selection, guides,
    // snap — just blit the bitmap and repaint overlays, skipping vector rasterisation.
    const dw = Math.round(w * dpr), dh = Math.round(h * dpr)
    const key: unknown[] = [pageData, cs, dw, dh, gridOn, gridSize, outlineMode]
    let cache = sceneCacheRef.current
    if (!cache || key.some((v, i) => v !== cache!.key[i])) {
      if (!cache) { cache = { canvas: document.createElement('canvas'), key }; sceneCacheRef.current = cache }
      const oc = cache.canvas
      if (oc.width !== dw || oc.height !== dh) { oc.width = dw; oc.height = dh }
      const octx = oc.getContext('2d')
      if (octx) {
        octx.setTransform(1, 0, 0, 1, 0, 0); octx.clearRect(0, 0, dw, dh)
        renderCanvas(octx, w, h, pageData, cs, [], dpr, null, undefined, grid, { rulers: false, guidesOn: false, outline: outlineMode }, null, null, 'scene')
      }
      cache.key = key
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.drawImage(cache.canvas, 0, 0)
    renderCanvas(ctx, w, h, pageData, cs, tool === 'node' ? [] : selectedIds, dpr, marquee, guides, grid, view, symBoxClone, hoverAngle, 'overlays')
    const pen = penRef.current
    if (pen && pen.points.length > 0) drawPenOverlay(ctx, pen, cs, dpr)
    const fh = freehandRef.current
    if (fh) drawFreehandOverlay(ctx, fh.samples, cs, dpr,
      tool === 'brush' ? fhOpts.brushSize : fhOpts.pencilWidth, fhOpts.color)
    if (tool === 'node' && selectedIds.length === 1) {
      const pe = pageData.elements.find(el => el.id === selectedIds[0])
      if (pe && pe.type === 'path') {
        renderNodeOverlay(ctx, pe as PathElement, cs, dpr, nodeSel)
        // Symmetry: expose each clone's mesh too, so its nodes/handles can be edited
        // (the edit maps back onto the source through the clone's inverse isometry).
        for (const c of pageData.elements)
          if (c.symOf === pe.id && c.type === 'path' && c.visible) renderNodeOverlay(ctx, c as PathElement, cs, dpr, nodeSel, true)
      }
    }
    if (tool === 'select' && selectedIds.length === 1) {
      const ge = pageData.elements.find(el => el.id === selectedIds[0])
      if (ge && (ge.fill.type === 'linear-gradient' || ge.fill.type === 'radial-gradient')) drawGradientOverlay(ctx, ge, cs, dpr)
    }
  }, [pageData, cs, selectedIds, marquee, tool, nodeSel, guides, snapTouch, gridOn, rulersOn, guidesOn, outlineMode, tempGuide, fhOpts, symLive, symCount, symCenter, symBoxClone, hoverAngle])

  // Always-latest doRender for imperative repaint triggers (image decode, resize).
  const doRenderRef = useRef(doRender)
  useEffect(() => { doRenderRef.current = doRender }, [doRender])
  // Coalesce repaints to one per animation frame: several state changes or imperative
  // triggers in the same frame schedule a SINGLE doRender via requestAnimationFrame
  // (high-frequency pointer moves no longer paint more than once per displayed frame).
  // scheduleRender is stable ([] deps) and reads the latest doRender through the ref, so
  // image-decode / resize subscriptions never need to re-subscribe (no stale closures).
  const rafRef = useRef<number | null>(null)
  const scheduleRender = useCallback(() => {
    if (rafRef.current != null) return
    rafRef.current = requestAnimationFrame(() => { rafRef.current = null; doRenderRef.current() })
  }, [])
  useEffect(() => () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current) }, [])
  useEffect(() => { scheduleRender() }, [doRender, penProgress, freehandTick, scheduleRender])
  // Repaint when an image bitmap finishes decoding (imports, project reload).
  useEffect(() => { onImageDecoded = () => scheduleRender(); return () => { onImageDecoded = null } }, [scheduleRender])

  // Resize observer
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const obs = new ResizeObserver(() => scheduleRender())
    obs.observe(canvas)
    return () => obs.disconnect()
  }, [scheduleRender])

  // Wheel: Ctrl/Cmd+scroll (and trackpad pinch, which reports ctrlKey) zooms at
  // the cursor; plain scroll pans; Shift+scroll pans horizontally.
  // Attached as a NATIVE non-passive listener: React registers `onWheel` as
  // passive, so preventDefault() was silently ignored and Ctrl+wheel triggered
  // the BROWSER page zoom instead of the canvas zoom.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const handler = (e: WheelEvent) => {
      e.preventDefault()
      // Normalize delta units (1 = lines, 2 = pages → pixels).
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 120 : 1
      const dx = e.deltaX * unit, dy = e.deltaY * unit
      if (e.ctrlKey || e.metaKey) {
        const rect = canvas.getBoundingClientRect()
        const mx = e.clientX - rect.left, my = e.clientY - rect.top
        // Exponential scaling: smooth for fractional trackpad-pinch deltas,
        // ≈ ×1.2 per mouse-wheel notch.
        const factor = Math.exp(-dy * 0.0015)
        setCs(prev => {
          const nz = Math.min(20, Math.max(0.02, prev.zoom * factor))
          const k = nz / prev.zoom
          return { ...prev, zoom: nz, panX: mx - (mx - prev.panX) * k, panY: my - (my - prev.panY) * k }
        })
      } else if (e.shiftKey) {
        setCs(prev => ({ ...prev, panX: prev.panX - (dx || dy) }))
      } else {
        setCs(prev => ({ ...prev, panX: prev.panX - dx, panY: prev.panY - dy }))
      }
    }
    canvas.addEventListener('wheel', handler, { passive: false })
    return () => canvas.removeEventListener('wheel', handler)
  }, [])

  // ── Mouse events ─────────────────────────────────────────────────────────────
  const csRef = useRef(cs)
  useEffect(() => { csRef.current = cs }, [cs])
  const pageDataRef = useRef(pageData)
  useEffect(() => { pageDataRef.current = pageData }, [pageData])
  const selectedIdsRef = useRef(selectedIds)
  useEffect(() => { selectedIdsRef.current = selectedIds }, [selectedIds])
  // Drop the clone-box proxy whenever the selection is no longer exactly that clone's
  // source (panel pick, Escape, Ctrl+A, another object…) or the clone disappeared.
  useEffect(() => {
    if (!symBoxClone) return
    const clone = pageData.elements.find(e => e.id === symBoxClone)
    if (!clone?.symOf || selectedIds.length !== 1 || selectedIds[0] !== clone.symOf) setSymBoxClone(null)
  }, [selectedIds, symBoxClone, pageData.elements])
  const toolRef = useRef(tool)
  useEffect(() => { toolRef.current = tool }, [tool])

  // Only one pointer drives the canvas at a time (palm rejection on tablets):
  // the pointer that started a drag owns it until release.
  const activePtrRef = useRef<number | null>(null)

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    // A second pointer (palm, extra finger) must not hijack an active drag.
    if (dragRef.current) return
    if (hoverAngleRef.current) setHoverAngle(null)   // drop the corner readout once a gesture starts
    const canvas = canvasRef.current!
    const pev = e as React.PointerEvent
    // Middle-button drag pans the workspace like the hand tool, whatever the active tool.
    if (e.button === 1) {
      e.preventDefault()
      if (pev.pointerId !== undefined) {
        activePtrRef.current = pev.pointerId
        try { canvas.setPointerCapture(pev.pointerId) } catch { /* unsupported pointer */ }
      }
      const cs0 = csRef.current
      dragRef.current = { type: 'pan', startX: e.clientX, startY: e.clientY, canvasX: cs0.panX, canvasY: cs0.panY }
      setMidPan(true)
      return
    }
    if (e.button !== 0) return
    if (pev.pointerId !== undefined) {
      activePtrRef.current = pev.pointerId
      // Capture so strokes / drags keep tracking outside the canvas bounds.
      try { canvas.setPointerCapture(pev.pointerId) } catch { /* unsupported pointer */ }
    }
    const rect   = canvas.getBoundingClientRect()
    const cs_    = csRef.current
    const pt     = toCanvas(e, rect, cs_)
    const currentTool = toolRef.current

    // Drag a new guide out of a ruler (any tool).
    const sxp = e.clientX - rect.left, syp = e.clientY - rect.top
    if (rulersOnRef.current && !cs_.rot && (sxp <= RULER_PX || syp <= RULER_PX)) {
      const gtype: 'h' | 'v' = sxp <= RULER_PX && syp > RULER_PX ? 'v' : 'h'
      dragRef.current = { type: 'newguide', startX: e.clientX, startY: e.clientY, canvasX: pt.x, canvasY: pt.y, guideType: gtype }
      setTempGuide({ type: gtype, position: gtype === 'v' ? pt.x : pt.y })
      return
    }

    if (currentTool === 'hand') {
      dragRef.current = { type: 'pan', startX: e.clientX, startY: e.clientY, canvasX: cs_.panX, canvasY: cs_.panY }
      return
    }

    // Drag the LIVE-symmetry centre handle (movable axes/pivot).
    {
      const sc = activeSymContext()
      if (sc && Math.hypot(pt.x - sc.cx, pt.y - sc.cy) <= 10 / cs_.zoom) {
        if (sc.targets.length) pushHistory()   // moving attached centres edits the document
        dragRef.current = { type: 'symcenter', startX: e.clientX, startY: e.clientY, canvasX: pt.x, canvasY: pt.y, symTargets: sc.targets }
        return
      }
    }

    // Freehand capture (pencil / brush) with live stroke stabilization.
    // Stylus pointers record pressure per sample (drives the brush width).
    if (currentTool === 'pencil' || currentTool === 'brush') {
      const stab = new StrokeStabilizer(fhOptsRef.current.stabilizer / 100)
      const p0 = stab.feed(pt.x, pt.y, cs_.zoom)
      const isPen = pev.pointerType === 'pen'
      freehandRef.current = {
        samples: [{ x: p0.x, y: p0.y, t: performance.now(), p: isPen ? (pev.pressure || 0.5) : undefined }],
        stab, pen: isPen,
      }
      dragRef.current = { type: 'freehand', startX: e.clientX, startY: e.clientY, canvasX: pt.x, canvasY: pt.y }
      setFreehandTick(tk => tk + 1)
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
            setNodeSel([nh.index])
            return
          }
          // Shift-clic sur une ancre → étend/retire de la sélection multiple (pas de drag).
          if (e.shiftKey && nh.kind === 'anchor') {
            setNodeSel(prev => prev.includes(nh.index) ? prev.filter(i => i !== nh.index) : [...prev, nh.index])
            return
          }
          pushHistory()
          // Grabbing an anchor already in the multi-selection keeps the whole set
          // (drag moves them together); anything else selects just this node.
          const cur = nodeSelRef.current
          const group = nh.kind === 'anchor' && cur.includes(nh.index) ? cur : [nh.index]
          if (nh.kind !== 'anchor' || !cur.includes(nh.index)) setNodeSel(nh.kind === 'anchor' ? group : [nh.index])
          dragRef.current = { type: 'node', startX: e.clientX, startY: e.clientY, canvasX: pt.x, canvasY: pt.y,
            snapshot: structuredClone(pathEl), nodeHit: nh, nodeGroup: nh.kind === 'anchor' ? group : undefined, breakSym: e.altKey, moved: false }
          return
        }
        // Symmetry clones: grab a node/handle/segment on ANY of the source's clones and
        // redirect the edit onto the SOURCE via the clone's inverse isometry. Point
        // indices are preserved between a source and its clones, so hits map 1:1.
        for (const cl of pd.elements) {
          if (cl.symOf !== pathEl.id || cl.type !== 'path' || !cl.visible) continue
          const clp = worldToLocal(pt.x, pt.y, cl as PathElement)
          const cnh = hitNode(cl as PathElement, clp.x, clp.y, cs_.zoom)
          const cId = symContainerOf(pd.elements, cl.id)
          const cont = cId ? pd.elements.find(e2 => e2.id === cId) : undefined
          const inv = cont && cont.type === 'symmetry' && cl.symIdx != null
            ? symCloneInverse(cont as SymmetryElement, cl.symIdx) : null
          if (!inv) continue
          if (cnh) {
            if (e.altKey && cnh.kind === 'anchor') {
              pushHistory()
              const pid = pathEl.id, idx = cnh.index
              setPageData(prev => ({ ...prev, elements: prev.elements.map(el =>
                el.id === pid && el.type === 'path' ? toggleAnchorSmooth(el as PathElement, idx) : el) }))
              setNodeSel([cnh.index]); return
            }
            if (e.shiftKey && cnh.kind === 'anchor') {
              setNodeSel(prev => prev.includes(cnh.index) ? prev.filter(i => i !== cnh.index) : [...prev, cnh.index]); return
            }
            pushHistory()
            const cur = nodeSelRef.current
            const group = cnh.kind === 'anchor' && cur.includes(cnh.index) ? cur : [cnh.index]
            if (cnh.kind !== 'anchor' || !cur.includes(cnh.index)) setNodeSel(cnh.kind === 'anchor' ? group : [cnh.index])
            dragRef.current = { type: 'node', startX: e.clientX, startY: e.clientY, canvasX: pt.x, canvasY: pt.y,
              snapshot: structuredClone(pathEl), nodeHit: cnh, nodeGroup: cnh.kind === 'anchor' ? group : undefined, breakSym: e.altKey, moved: false, symPtInv: inv }
            return
          }
          const nearc = nearestOnPath(cl as PathElement, clp.x, clp.y)
          if (nearc && nearc.d <= 6 / cs_.zoom) {
            pushHistory()
            const pid = pathEl.id, seg = nearc.seg, tt = nearc.t
            setPageData(prev => ({ ...prev, elements: prev.elements.map(el => {
              if (el.id !== pid || el.type !== 'path') return el
              const ins = insertAnchor(el as PathElement, seg, tt)
              return { ...ins, points: reflowAuto(ins.points, ins.closed) }
            }) }))
            setNodeSel([nearc.seg + 1]); return
          }
        }
        // Clic sur un segment du tracé (hors ancre/poignée) → insère une ancre.
        const near = nearestOnPath(pathEl, lp.x, lp.y)
        if (near && near.d <= 6 / cs_.zoom) {
          pushHistory()
          const pid = pathEl.id, seg = near.seg, tt = near.t
          setPageData(prev => ({ ...prev, elements: prev.elements.map(el => {
            if (el.id !== pid || el.type !== 'path') return el
            const ins = insertAnchor(el as PathElement, seg, tt)
            return { ...ins, points: reflowAuto(ins.points, ins.closed) }
          }) }))
          setNodeSel([near.seg + 1])
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
          setSelectedIds([el.id]); setNodeSel([nh.index])
          dragRef.current = { type: 'node', startX: e.clientX, startY: e.clientY, canvasX: pt.x, canvasY: pt.y,
            snapshot: structuredClone(el), nodeHit: nh, nodeGroup: nh.kind === 'anchor' ? [nh.index] : undefined, breakSym: e.altKey, moved: false }
          return
        }
      }
      const hitP = sorted.find(el => el.type === 'path' && el.visible && !el.locked && hitTest(el, pt.x, pt.y, cs_.zoom))
      if (hitP) { setSelectedIds([hitP.id]); setNodeSel([]); return }
      // Empty space: drag a marquee to select several nodes at once. Works with a
      // path already in node-edit, or with none — the marquee then picks the
      // topmost path whose nodes fall inside it. A plain click still deselects.
      if (!e.shiftKey) { setNodeSel([]); if (!pathEl) setSelectedIds([]) }
      marqueeRef.current = { x: pt.x, y: pt.y }
      dragRef.current = { type: 'nodemarquee', startX: e.clientX, startY: e.clientY, canvasX: pt.x, canvasY: pt.y }
      return
    }

    if (currentTool === 'eyedropper') {
      const pd  = pageDataRef.current
      const sorted = [...pd.elements].sort((a, b) => b.zIndex - a.zIndex)
      const src = sorted.find(el => el.visible && hitTest(el, pt.x, pt.y, cs_.zoom))
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
          // A container (group/symmetry) uses the whole-pattern ORIENTED box (tilted by
          // the symmetry rotation) and rotates all its leaves as a unit.
          const isCont = isContainer(el)
          // Clone-box proxy: the selection box is drawn on a clicked clone, but its
          // SOURCE is selected. Map the pointer into the source frame so the (source-
          // based) handle hit-tests register on the clone's on-screen handles; the
          // same inverse rides along on the drag so the gesture tracks the cursor.
          let cloneInv: ((x: number, y: number) => { x: number; y: number }) | undefined
          if (!isCont && symBoxCloneRef.current) {
            const pc = pd.elements.find(c => c.id === symBoxCloneRef.current && c.symOf === el.id)
            if (pc && pc.symIdx != null) {
              const cId = symContainerOf(pd.elements, pc.id)
              const cont = cId ? pd.elements.find(e2 => e2.id === cId) : undefined
              if (cont && cont.type === 'symmetry') cloneInv = symCloneInverse(cont as SymmetryElement, pc.symIdx) ?? undefined
            }
          }
          const P = cloneInv ? cloneInv(pt.x, pt.y) : pt
          const ob = isCont ? orientedContainerBox(pd.elements, el) : null
          let rh: { x: number; y: number }, cx: number, cy: number
          if (ob) {
            const ar = (ob.ang * Math.PI) / 180, cc = Math.cos(ar), ss = Math.sin(ar)
            const rot = (lx: number, ly: number) => ({ x: ob.px + cc * (lx - ob.px) - ss * (ly - ob.py), y: ob.py + ss * (lx - ob.px) + cc * (ly - ob.py) })
            rh = rot(ob.lx + ob.lw / 2, ob.ly - 22 / cs_.zoom)
            const ctr = rot(ob.lx + ob.lw / 2, ob.ly + ob.lh / 2)
            cx = ctr.x; cy = ctr.y
          } else {
            const bb = elBBox(el)
            rh = rotateHandlePos(bb, cs_.zoom)
            cx = bb.x + bb.w / 2; cy = bb.y + bb.h / 2
          }
          // A rotated single object draws its box + handles in its OWN rotated frame;
          // un-rotate the pointer into that frame so hit-tests match what's on screen.
          // (Containers already express handles in world coords via `rot()`, so hp === pt.)
          const rotDeg = isCont ? 0 : (el.rotation || 0)
          const hp = rotDeg
            ? ((): { x: number; y: number } => {
                const a = (-rotDeg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a)
                const dx = P.x - cx, dy = P.y - cy
                return { x: cx + c * dx - s * dy, y: cy + s * dx + c * dy }
              })()
            : P
          // The selection box (incl. the rotate handle) is drawn as the SOURCE's box
          // under the clone's forward isometry; the pointer is pre-mapped by the inverse
          // (`P`/`hp`), so the standard source-frame hit-test lands on every handle.
          if (Math.hypot(hp.x - rh.x, hp.y - rh.y) <= 9 / cs_.zoom) {
            pushHistory()
            if (isCont) {
              const ids = expandUnitForMove(pd.elements, [el.id])
              const rotates = pd.elements.filter(x => ids.includes(x.id)).map(x => structuredClone(x))
              dragRef.current = { type: 'rotate', startX: e.clientX, startY: e.clientY, canvasX: pt.x, canvasY: pt.y,
                rotates, cx, cy, startAng: Math.atan2(pt.y - cy, pt.x - cx) * 180 / Math.PI, moved: false }
              return
            }
            dragRef.current = { type: 'rotate', startX: e.clientX, startY: e.clientY, canvasX: pt.x, canvasY: pt.y,
              snapshot: { ...el }, cx, cy, startRot: el.rotation, startAng: Math.atan2(P.y - cy, P.x - cx) * 180 / Math.PI, moved: false, symPtInv: cloneInv }
            return
          }
          if (isCont && ob) {
            // Resize handles on the (possibly tilted) container box → scale the subtree.
            const ar = (ob.ang * Math.PI) / 180, cc = Math.cos(ar), ss = Math.sin(ar)
            const rot = (lx: number, ly: number) => ({ x: ob.px + cc * (lx - ob.px) - ss * (ly - ob.py), y: ob.py + ss * (lx - ob.px) + cc * (ly - ob.py) })
            const locals: [number, number][] = [
              [ob.lx, ob.ly], [ob.lx + ob.lw / 2, ob.ly], [ob.lx + ob.lw, ob.ly],
              [ob.lx, ob.ly + ob.lh / 2], [ob.lx + ob.lw, ob.ly + ob.lh / 2],
              [ob.lx, ob.ly + ob.lh], [ob.lx + ob.lw / 2, ob.ly + ob.lh], [ob.lx + ob.lw, ob.ly + ob.lh],
            ]
            for (let hi = 0; hi < locals.length; hi++) {
              const w = rot(locals[hi][0], locals[hi][1])
              if (Math.hypot(pt.x - w.x, pt.y - w.y) <= 7 / cs_.zoom) {
                pushHistory()
                const ids = expandUnitForMove(pd.elements, [el.id])
                const scales = pd.elements.filter(x => ids.includes(x.id)).map(x => structuredClone(x))
                dragRef.current = { type: 'resize', startX: e.clientX, startY: e.clientY, canvasX: pt.x, canvasY: pt.y,
                  scales, resizeCtx: { px: ob.px, py: ob.py, ang: ob.ang, lx: ob.lx, ly: ob.ly, lw: ob.lw, lh: ob.lh, handle: hi }, moved: false }
                return
              }
            }
          } else if (!isCont) {
          // Corner-radius handle (rect + roundable shapes) — priority over resize handles.
          if (el.type === 'rect' || (el.type === 'path' && isRoundableShape((el as PathElement).shape))) {
            const rh = radiusHandleLocal(el, cs_.zoom)
            if (rh) {
              const lp = toElementLocal(el, P.x, P.y)
              if (Math.hypot(lp.x - rh.hx, lp.y - rh.hy) <= 8 / cs_.zoom) {
                pushHistory()
                dragRef.current = { type: 'radius', startX: e.clientX, startY: e.clientY, canvasX: pt.x, canvasY: pt.y, snapshot: { ...el }, moved: false, symPtInv: cloneInv }
                return
              }
            }
          }
          const hi = hitHandle(el, hp.x, hp.y, cs_.zoom)
          if (hi >= 0) {
            pushHistory()
            // Paths: resize relative to the TRUE curve bbox (where the handles
            // are drawn) — stored x/y/w/h can be stale anchors-only on old docs.
            const snapBox = el.type === 'path' ? { ...el, ...elBBox(el) } : { ...el }
            dragRef.current = { type: 'resize', startX: e.clientX, startY: e.clientY, canvasX: pt.x, canvasY: pt.y, handleIdx: hi, snapshot: snapBox,
              snapTg: snapTargets(pd, new Set([el.id])), moved: false, symPtInv: cloneInv }
            return
          }
          }
        }
      }
      // Grab an existing guide (unless locked) — takes priority over elements.
      if (guidesOnRef.current && !guidesLockedRef.current && pd.guides?.length) {
        const thr = 5 / cs_.zoom
        const g = [...pd.guides].reverse().find(g =>
          g.type === 'v' ? Math.abs(pt.x - g.position) <= thr : Math.abs(pt.y - g.position) <= thr)
        if (g) {
          pushHistory()
          dragRef.current = { type: 'guide', startX: e.clientX, startY: e.clientY, canvasX: pt.x, canvasY: pt.y, guideId: g.id, guideType: g.type, moved: false }
          return
        }
      }
      const sorted = renderLeaves(pd.elements).map(o => o.el).reverse()   // top-most first
      // Symmetry clones are locked but still grab their container (whole pattern is
      // one transformable object) — so they're hittable for selection.
      const hit = sorted.find(el => (!effLocked(pd.elements, el) || !!el.symOf) && hitTest(el, pt.x, pt.y, cs_.zoom))
      // Clicking an object inside a container selects ONLY that object (not the whole
      // container). A symmetry clone grabs its editable source instead (the pattern
      // follows live). Selecting a whole container is done from the layers panel.
      const groupMates = (id: string) => {
        const el = pd.elements.find(e => e.id === id)
        return el?.symOf ? [el.symOf] : [id]
      }
      // A container UNIT is already selected and we grabbed something inside it →
      // drag the WHOLE unit (double-click to drill into a child instead).
      if (hit && !shift && sel.length === 1) {
        const only = pd.elements.find(e => e.id === sel[0])
        if (only && isContainer(only) && descendantIds(pd.elements, only.id).has(hit.id)) {
          pushHistory()
          const moveIds = expandUnitForMove(pd.elements, [only.id])
          const moves = pd.elements.filter(el => moveIds.includes(el.id)).map(el => structuredClone(el))
          dragRef.current = { type: 'move', startX: e.clientX, startY: e.clientY, canvasX: pt.x, canvasY: pt.y, moves,
            snapTg: snapTargets(pd, new Set(moveIds)), moved: false }
          return
        }
      }
      if (hit) {
        let nextSel = sel
        const hitGroup = groupMates(hit.id)
        // Draw the selection box on the clicked clone (its source is what's selected).
        setSymBoxClone(hit.symOf && hit.symIdx != null ? hit.id : null)
        if (shift) {
          nextSel = sel.includes(hit.id) ? sel.filter(i => !hitGroup.includes(i)) : [...sel, ...hitGroup]
          nextSel = Array.from(new Set(nextSel))
          setSelectedIds(nextSel)
        } else if (!sel.includes(hit.id)) {
          nextSel = hitGroup; setSelectedIds(nextSel)
        }
        pushHistory()
        if (e.altKey) {
          // Alt-drag duplicates the selection and drags the copies (Illustrator).
          const src = pd.elements.filter(el => nextSel.includes(el.id))
          const clones = src.map(el => cloneEl(el))
          setPageData(prev => ({ ...prev, elements: [...prev.elements, ...clones.map((c, i) => ({ ...c, zIndex: prev.elements.length + i }))] }))
          const cloneIds = clones.map(c => c.id)
          setSelectedIds(cloneIds)
          dragRef.current = { type: 'move', startX: e.clientX, startY: e.clientY, canvasX: pt.x, canvasY: pt.y,
            moves: clones.map(c => structuredClone(c)), dupIds: cloneIds, origIds: nextSel,
            snapTg: snapTargets(pd, new Set(cloneIds)), moved: false }
        } else {
          // Container unit selection ([containerId]) cascades the move to its source
          // leaves (clones regenerate). A grabbed clone maps the pointer to its source
          // frame so it follows the cursor while the whole pattern moves symmetrically.
          const moveIds = expandUnitForMove(pd.elements, nextSel)
          const moves = pd.elements.filter(el => moveIds.includes(el.id)).map(el => structuredClone(el))
          let symPtInv: ((x: number, y: number) => { x: number; y: number }) | undefined
          let ax = pt.x, ay = pt.y
          if (hit.symOf && hit.symIdx != null) {
            const cId = symContainerOf(pd.elements, hit.id)
            const cont = cId ? pd.elements.find(e => e.id === cId) : undefined
            if (cont && cont.type === 'symmetry') {
              const inv = symCloneInverse(cont as SymmetryElement, hit.symIdx)
              if (inv) { symPtInv = inv; const a = inv(pt.x, pt.y); ax = a.x; ay = a.y }
            }
          }
          dragRef.current = { type: 'move', startX: e.clientX, startY: e.clientY, canvasX: ax, canvasY: ay, moves,
            snapTg: snapTargets(pd, new Set(moveIds)), moved: false, symPtInv }
        }
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

    if (['rect','ellipse','line','shape'].includes(currentTool)) {
      const pd = pageDataRef.current
      // New shapes inherit the active fill/stroke colours from the tool-rail swatches.
      const paintFill = { type: 'solid' as const, color: curFillRef.current, opacity: 100 }
      const paintStroke = { color: curStrokeRef.current, opacity: 100, width: 2, dashArray: [] }
      const base = {
        id: newId(), x: pt.x, y: pt.y, w: 0, h: 0,
        rotation: 0, visible: true, locked: false, opacity: 100,
        zIndex: pd.elements.length, fill: paintFill, stroke: paintStroke,
      }
      const entry = curShapeRef.current
      let newEl: VectorElement
      if (currentTool === 'rect') {
        // Rounded-rect preset from the shape picker carries a default radius.
        const cr = entry.tool === 'rect' ? (entry.cr ?? 0) : 0
        newEl = { ...base, type: 'rect', name: t(cr > 0 ? 'apex_shape_roundrect' : 'apex_rectangle'), cornerRadius: cr } as VectorElement
      } else if (currentTool === 'ellipse') {
        newEl = { ...base, type: 'ellipse', name: t('apex_ellipse') } as VectorElement
      } else if (currentTool === 'shape') {
        const kind = entry.meta?.shape
        const params = entry.meta?.params
          ?? (kind && SHAPE_DEFS[kind as LibShape] ? defaultShapeParams(kind as LibShape) : undefined)
        // Open shapes (e.g. spiral) are strokes only → no fill.
        newEl = { ...base, type: 'path', name: t(entry.nameKey),
          fill: entry.open ? { type: 'none' } : paintFill,
          points: [{ x: pt.x, y: pt.y }], closed: !entry.open,
          ...(entry.meta ?? {}), ...(params ? { params } : {}) } as VectorElement
      } else {
        newEl = { ...base, type: 'path', name: t('apex_line'),
          fill: { type: 'none' },
          points: [{ x: pt.x, y: pt.y }], closed: false } as VectorElement
      }
      pushHistory()
      dragRef.current = { type: 'create', startX: e.clientX, startY: e.clientY, canvasX: pt.x, canvasY: pt.y, newEl, shape: currentTool, moved: false }
      setPageData(prev => ({ ...prev, elements: [...prev.elements, newEl] }))
      setSelectedIds([newEl.id])
    }
  }, [commitPenPath, t, pushHistory, activeSymContext])

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    const cs_         = csRef.current
    const currentTool = toolRef.current
    // Ignore secondary pointers while a drag is in progress (palm rejection).
    const movePid = (e as React.PointerEvent).pointerId
    if (dragRef.current && activePtrRef.current != null && movePid !== undefined && movePid !== activePtrRef.current) return

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

    // Hover readout: when idle over a selected object's corner, show its interior angle
    // until the pointer leaves it. Skip while a gesture is active or a marquee is open.
    if (!dragRef.current && (currentTool === 'select' || currentTool === 'node')) {
      const canvasH = canvasRef.current
      const sel = selectedIdsRef.current
      let next: { x: number; y: number; deg: number; a1: number; a2: number } | null = null
      if (canvasH && sel.length) {
        const pt = toCanvas(e, canvasH.getBoundingClientRect(), cs_)
        const thr = 16 / cs_.zoom
        let best = thr
        const pd = pageDataRef.current
        // Inspect the selected objects AND their symmetry clones (selecting a clone puts
        // its SOURCE in `sel`, so hovering a clone also reads out — angles are isometry-
        // invariant, only the vertex positions differ).
        const targets: VectorElement[] = []
        for (const id of sel) {
          const el = pd.elements.find(x => x.id === id)
          if (!el || isContainer(el)) continue
          targets.push(el)
          for (const c of pd.elements) if (c.symOf === id && !isContainer(c)) targets.push(c)
        }
        for (const el of targets) {
          for (const cn of elCornerAngles(el)) {
            const d = Math.hypot(pt.x - cn.x, pt.y - cn.y)
            if (d < best) { best = d; next = cn }
          }
        }
      }
      const cur = hoverAngleRef.current
      const same = !!cur && !!next && cur.x === next.x && cur.y === next.y && cur.deg === next.deg
      if (!same && (cur || next)) setHoverAngle(next)
    }

    const drag = dragRef.current
    if (!drag) return
    const canvas = canvasRef.current!
    const rect   = canvas.getBoundingClientRect()

    if (drag.type === 'pan') {
      setCs(prev => ({ ...prev, panX: drag.canvasX + (e.clientX - drag.startX), panY: drag.canvasY + (e.clientY - drag.startY) }))
      return
    }

    if (drag.type === 'symcenter') {
      // Move the live-symmetry centre: attached sources update live (the
      // reconciler re-derives their clones); the drawing-mode centre is view state.
      const rect2 = canvasRef.current!.getBoundingClientRect()
      const pt2 = toCanvas(e, rect2, csRef.current)
      const targets = drag.symTargets ?? []
      if (targets.length) {
        const set = new Set(targets)   // symmetry container ids
        setPageData(prev => ({ ...prev, elements: prev.elements.map(el =>
          set.has(el.id) && el.type === 'symmetry' ? { ...el, cx: pt2.x, cy: pt2.y } as VectorElement : el) }))
      } else {
        setSymCenter({ x: pt2.x, y: pt2.y })
      }
      return
    }

    // Freehand capture — stabilize + min-distance filter, repaint via tick.
    // Coalesced pointer events give the full high-frequency stylus trail
    // (a tablet reports 200+ Hz; React only delivers one event per frame).
    if (drag.type === 'freehand') {
      const fh = freehandRef.current
      if (!fh) return
      const ne = (e as React.PointerEvent).nativeEvent as PointerEvent
      const coalesced = typeof ne.getCoalescedEvents === 'function' ? ne.getCoalescedEvents() : []
      const events: { clientX: number; clientY: number; pressure: number; timeStamp: number }[] =
        coalesced.length ? coalesced : [ne]
      let added = false
      for (const ev of events) {
        const pt = toCanvas(ev, rect, cs_)
        const sm = fh.stab.feed(pt.x, pt.y, cs_.zoom)
        const last = fh.samples[fh.samples.length - 1]
        if (Math.hypot(sm.x - last.x, sm.y - last.y) >= 0.75 / cs_.zoom) {
          fh.samples.push({
            x: sm.x, y: sm.y,
            t: ev.timeStamp || performance.now(),
            p: fh.pen ? (ev.pressure || last.p || 0.5) : undefined,
          })
          added = true
        }
      }
      if (added) setFreehandTick(tk => tk + 1)
      return
    }

    if (drag.type === 'newguide') {
      const pt = toCanvas(e, rect, cs_)
      setTempGuide({ type: drag.guideType!, position: drag.guideType === 'v' ? pt.x : pt.y })
      return
    }
    if (drag.type === 'guide') {
      const pt = toCanvas(e, rect, cs_)
      drag.moved = true
      const gid = drag.guideId!
      const pos = Math.round(drag.guideType === 'v' ? pt.x : pt.y)
      setPageData(prev => ({ ...prev, guides: (prev.guides ?? []).map(g => g.id === gid ? { ...g, position: pos } : g) }))
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

    if (drag.type === 'marquee' || drag.type === 'nodemarquee') {
      const o = marqueeRef.current!; const pt = toCanvas(e, rect, cs_)
      const m = { x: Math.min(o.x, pt.x), y: Math.min(o.y, pt.y), w: Math.abs(pt.x - o.x), h: Math.abs(pt.y - o.y) }
      marqueeRectRef.current = m
      setMarquee(m)
      return
    }
    // Unit rotation of a container (group/symmetry): spin every source leaf around
    // the pivot; a symmetry container also turns its frame so the pattern stays rigid.
    if (drag.type === 'rotate' && drag.rotates && drag.cx != null) {
      const pt = toCanvas(e, rect, cs_)
      let delta = Math.atan2(pt.y - drag.cy!, pt.x - drag.cx) * 180 / Math.PI - drag.startAng!
      if (e.shiftKey) delta = Math.round(delta / 15) * 15
      const px = drag.cx, py = drag.cy!
      const byId = new Map(drag.rotates.map(s => [s.id, s]))
      const norm = (a: number) => (((a % 360) + 360) % 360)
      drag.moved = true
      setPageData(prev => ({ ...prev, elements: prev.elements.map(el => {
        const snap = byId.get(el.id); if (!snap) return el
        // Symmetry sub/container: spin its frame (centre revolves + axis angle turns).
        if (snap.type === 'symmetry') return { ...rotateContainerFrame(snap as SymmetryElement, px, py, delta), zIndex: el.zIndex }
        // Group sub/container: accumulate its frame angle so its oriented box tilts
        // (its leaves are rotated separately as part of the same set).
        if (snap.type === 'group') return { ...el, rotation: norm(snap.rotation + delta) } as VectorElement
        return { ...rotateElementAround(snap, px, py, delta), zIndex: el.zIndex } as VectorElement
      }) }))
      return
    }
    if (drag.type === 'rotate' && drag.snapshot && drag.cx != null) {
      let pt = toCanvas(e, rect, cs_)
      if (drag.symPtInv) pt = drag.symPtInv(pt.x, pt.y)   // grabbed a clone's rotate handle
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
      const ptw0 = toCanvas(e, rect, cs_)
      // Grabbed a symmetry clone's node: map the pointer through the clone's inverse
      // isometry into the SOURCE's world frame, so editing the clone edits the source.
      const ptw  = drag.symPtInv ? drag.symPtInv(ptw0.x, ptw0.y) : ptw0
      // Souris en repère LOCAL de l'élément (annule sa rotation autour du pivot du
      // snapshot, qui reste fixe pendant le geste).
      const pt   = worldToLocal(ptw.x, ptw.y, snap)
      const sp   = snap.points[nh.index]
      // Group move: shift every selected anchor by the same local delta.
      const group = nh.kind === 'anchor' ? (drag.nodeGroup ?? [nh.index]) : []
      const gset  = new Set(group)
      const gdx   = pt.x - sp.x, gdy = pt.y - sp.y
      setPageData(prev => ({ ...prev, elements: prev.elements.map(el => {
        if (el.id !== snap.id || el.type !== 'path') return el
        const pts = (el as PathElement).points.map((p, i) => {
          if (nh.kind === 'anchor' && gset.has(i)) {
            // Move the anchor by the drag delta; handles are relative, so they follow.
            const s = snap.points[i]
            return { ...p, x: s.x + gdx, y: s.y + gdy }
          }
          if (i !== nh.index) return p
          if (nh.kind === 'anchor') {
            return { ...p, x: pt.x, y: pt.y }
          }
          const h: [number, number] = [pt.x - sp.x, pt.y - sp.y]
          const next = { ...p, [nh.kind === 'in' ? 'hIn' : 'hOut']: h } as PathPoint
          delete next.auto   // manually tugging a handle turns an auto node into a manual one
          const oppKey = nh.kind === 'in' ? 'hOut' : 'hIn'
          const oppSnap = sp[oppKey]
          // Keep the tangent colinear ONLY while the node is a smooth node (its two
          // handles were already colinear) and Alt is not held. We mirror the
          // DIRECTION but preserve the opposite handle's OWN length — so the two
          // sides can differ (asymmetric smooth). Alt, or an already-broken (cusp)
          // node, leaves the opposite handle fully independent.
          if (oppSnap && !drag.breakSym && handlesColinear(sp.hIn, sp.hOut)) {
            const hl = Math.hypot(h[0], h[1]) || 1
            const ol = Math.hypot(oppSnap[0], oppSnap[1])
            next[oppKey] = [(-h[0] / hl) * ol, (-h[1] / hl) * ol]
          }
          return next
        })
        // Auto-smooth anchors re-derive their handles from the moved neighbours.
        const rpts = reflowAuto(pts, (el as PathElement).closed)
        // Forme tournée : garder la bbox du snapshot fige le pivot de rotation
        // pendant le drag (sinon il dériverait → la forme sauterait). Sinon on
        // recalcule la bbox pour que transform/sélection restent justes.
        if (snap.rotation) {
          return { ...el, points: rpts, x: snap.x, y: snap.y, w: snap.w, h: snap.h } as VectorElement
        }
        const bb = pathBounds(rpts, (el as PathElement).closed)
        return { ...el, points: rpts, x: bb.x, y: bb.y, w: bb.w, h: bb.h } as VectorElement
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
      // Grabbed a symmetry clone: map the canvas delta into the source's frame so the
      // source moves by the inverse rotation/reflection — the grabbed clone then tracks
      // the cursor exactly while every sibling clone follows symmetrically.
      if (drag.symPtInv) {
        const o = drag.symPtInv(0, 0), p = drag.symPtInv(dx, dy)
        dx = p.x - o.x; dy = p.y - o.y
      }
      // Shift constrains the move to the dominant axis.
      let mdx = dx, mdy = dy
      if (e.shiftKey) { if (Math.abs(mdx) >= Math.abs(mdy)) mdy = 0; else mdx = 0 }
      let ndx = mdx, ndy = mdy
      const vx: SnapGuide[] = [], hy: SnapGuide[] = []
      const base = selBBox(moves)
      let snapTg: { xs: SnapCand[]; ys: SnapCand[] } | null = null
      // Holding Ctrl (⌘) suspends magnetism for the duration of the drag.
      const snapSuspended = e.ctrlKey || e.metaKey
      if (base && !e.altKey && !snapSuspended) {
        if (snapOnRef.current) {
          // Snap targets were computed once at drag start (they don't change
          // while dragging) — recomputing per mousemove was O(n) wasted work.
          snapTg = drag.snapTg ?? snapTargets(pageDataRef.current, new Set(moves.map(m => m.id)))
          const thr = SNAP_PX / cs_.zoom
          const mx = base.x + mdx, my = base.y + mdy
          const sx = bestSnap([mx, mx + base.w / 2, mx + base.w], snapTg.xs, thr)
          const sy = bestSnap([my, my + base.h / 2, my + base.h], snapTg.ys, thr)
          if (sx) ndx += sx.delta
          if (sy) ndy += sy.delta
          // Now that the final offset is known, build guides with the snapped box
          // so the distance indicator measures the real gap to the neighbour.
          const moved: SnapBox = { x: base.x + ndx, y: base.y + ndy, w: base.w, h: base.h }
          if (sx) vx.push(snapGuideFor('x', sx.coord, moved, snapTg.xs))
          if (sy) hy.push(snapGuideFor('y', sy.coord, moved, snapTg.ys))
        }
        if (gridOnRef.current) {
          // Snap the top-left corner to the grid when no smart guide claimed the axis.
          if (!vx.length) ndx = Math.round((base.x + mdx) / gridSize) * gridSize - base.x
          if (!hy.length) ndy = Math.round((base.y + mdy) / gridSize) * gridSize - base.y
        }
        // TANGENT snap: a single moved object KISSES a nearby outline (curve/edge). It
        // refines the axis snaps and yields a contact marker.
        let touch: { x: number; y: number } | null = null
        if (snapOnRef.current && moves.length === 1 && !e.altKey) {
          const ts = tangentSnap(pageDataRef.current, moves[0], ndx, ndy, new Set([moves[0].id]), SNAP_PX / cs_.zoom)
          if (ts) { ndx += ts.dx; ndy += ts.dy; touch = { x: ts.tx, y: ts.ty } }
        }
        snapTouchRef.current = touch
        setSnapTouch(touch)
      } else if (snapTouchRef.current) {
        // Snapping off/suspended → drop any lingering tangent marker.
        snapTouchRef.current = null; setSnapTouch(null)
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
      const shape = drag.shape
      // Shift constrains: square/circle for shapes, 45° increments for lines.
      let px2 = pt.x, py2 = pt.y
      if (e.shiftKey) {
        if (shape === 'line') {
          const ang = Math.atan2(pt.y - oy, pt.x - ox)
          const snap = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4)
          const len = Math.hypot(pt.x - ox, pt.y - oy)
          px2 = ox + Math.cos(snap) * len
          py2 = oy + Math.sin(snap) * len
        } else {
          const ddx = pt.x - ox, ddy = pt.y - oy
          const m = Math.max(Math.abs(ddx), Math.abs(ddy))
          px2 = ox + (ddx < 0 ? -m : m)
          py2 = oy + (ddy < 0 ? -m : m)
        }
      }
      // Alt draws from the centre outwards.
      let x: number, y: number, w: number, h: number
      if (e.altKey && shape !== 'line') {
        w = Math.abs(px2 - ox) * 2; h = Math.abs(py2 - oy) * 2
        x = ox - w / 2; y = oy - h / 2
      } else {
        x = Math.min(ox, px2); y = Math.min(oy, py2)
        w = Math.abs(px2 - ox); h = Math.abs(py2 - oy)
      }
      setPageData(prev => ({ ...prev, elements: prev.elements.map(el => {
        if (el.id !== drag.newEl!.id) return el
        if (el.type === 'path') {
          const pe = el as PathElement
          // Parametric shapes regenerate from their metadata + the drag box.
          const points = shape === 'line' ? [{ x: ox, y: oy }, { x: px2, y: py2 }]
                       : pe.shape         ? regenShapePoints({ ...pe, x, y, w, h })
                       :                    pe.points
          return { ...el, x, y, w, h, points } as VectorElement
        }
        return { ...el, x, y, w, h }
      }) }))
      return
    }
    if (drag.type === 'radius' && drag.snapshot) {
      const snap = drag.snapshot
      const g = radiusHandleGeom(snap)
      if (g) {
        // Project the pointer (in the element's local frame) onto the handle axis;
        // that distance is the new corner radius, clamped so fillets never overlap.
        let pt = toCanvas(e, rect, cs_)
        if (drag.symPtInv) pt = drag.symPtInv(pt.x, pt.y)   // grabbed a clone's radius handle
        const lp = toElementLocal(snap, pt.x, pt.y)
        const proj = (lp.x - g.ox) * g.ux + (lp.y - g.oy) * g.uy
        const newR = Math.round(Math.max(0, Math.min(proj, g.maxR)))
        setPageData(prev => ({ ...prev, elements: prev.elements.map(el => {
          if (el.id !== snap.id) return el
          if (el.type === 'rect') return ({ ...el, cornerRadius: newR, corners: undefined }) as VectorElement
          const pe = el as PathElement
          const params = { ...(pe.params ?? {}), cornerRadius: newR }
          return ({ ...pe, params, points: regenShapePoints({ ...pe, params }) }) as VectorElement
        }) }))
        drag.moved = true
      }
      return
    }
    // Container unit resize: scale the whole subtree by dragging the (tilted) box.
    if (drag.type === 'resize' && drag.scales && drag.resizeCtx) {
      const R = drag.resizeCtx
      const ptw = toCanvas(e, rect, cs_)
      // Pointer into the box's local (un-rotated) frame.
      const ar = (R.ang * Math.PI) / 180, c = Math.cos(ar), s = Math.sin(ar)
      const ldx = ptw.x - R.px, ldy = ptw.y - R.py
      const lpx = R.px + c * ldx + s * ldy, lpy = R.py - s * ldx + c * ldy
      const H = R.handle
      let nlw = R.lw, nlh = R.lh
      if ([0, 3, 5].includes(H)) { const rgt = R.lx + R.lw; nlw = rgt - lpx }
      else if ([2, 4, 7].includes(H)) { nlw = lpx - R.lx }
      if ([0, 1, 2].includes(H)) { const bot = R.ly + R.lh; nlh = bot - lpy }
      else if ([5, 6, 7].includes(H)) { nlh = lpy - R.ly }
      if (Math.abs(nlw) < 1) nlw = nlw < 0 ? -1 : 1
      if (Math.abs(nlh) < 1) nlh = nlh < 0 ? -1 : 1
      let sx = nlw / R.lw, sy = nlh / R.lh
      // Shift locks the aspect ratio on corner handles — uniform scale about the
      // fixed corner, exactly like plain objects (largest axis wins, flip preserved).
      if (e.shiftKey && [0, 2, 5, 7].includes(H)) {
        const m = Math.max(Math.abs(sx), Math.abs(sy))
        sx = (sx < 0 ? -1 : 1) * m
        sy = (sy < 0 ? -1 : 1) * m
      }
      // Anchor = the fixed opposite corner (local coords); mid-handles keep their axis.
      const ax = [0, 3, 5].includes(H) ? R.lx + R.lw : R.lx
      const ay = [0, 1, 2].includes(H) ? R.ly + R.lh : R.ly
      const byId = new Map(drag.scales.map(sn => [sn.id, sn]))
      drag.moved = true
      setPageData(prev => ({ ...prev, elements: prev.elements.map(el => {
        const sn = byId.get(el.id); if (!sn) return el
        return { ...scaleElementInFrame(sn, R.px, R.py, R.ang, ax, ay, sx, sy), zIndex: el.zIndex } as VectorElement
      }) }))
      return
    }
    if (drag.type === 'resize' && drag.snapshot && drag.handleIdx !== undefined) {
      const snap = drag.snapshot
      const hi   = drag.handleIdx
      // Grabbed a clone's resize handle: map the canvas delta into the source frame
      // (undo the clone's reflection/rotation) so the source scales as expected.
      if (drag.symPtInv) { const o = drag.symPtInv(0, 0), p = drag.symPtInv(dx, dy); dx = p.x - o.x; dy = p.y - o.y }
      let { x, y, w, h } = snap
      const left = [0, 3, 5].includes(hi), right = [2, 4, 7].includes(hi)
      const top  = [0, 1, 2].includes(hi), bottom = [5, 6, 7].includes(hi)
      // A rotated box is edited in its OWN local frame: un-rotate the drag vector so
      // dragging a handle grows the box along the (visually) expected edge.
      const rotDeg = (snap as VectorElement).rotation || 0
      let ldx = dx, ldy = dy
      if (rotDeg) { const a = (-rotDeg * Math.PI) / 180, rc = Math.cos(a), rs = Math.sin(a); ldx = rc * dx - rs * dy; ldy = rs * dx + rc * dy }
      // Snap the dragged edge to nearby targets (object/artboard/guide alignment).
      // World-axis snapping only makes sense for an un-rotated box.
      let ndx = ldx, ndy = ldy
      const vx: SnapGuide[] = [], hy: SnapGuide[] = []
      if (snapOnRef.current && !e.altKey && !rotDeg) {
        const tg = drag.snapTg ?? snapTargets(pageDataRef.current, new Set([snap.id]))
        const thr = SNAP_PX / cs_.zoom
        if (left)   { const s = bestSnap([snap.x + dx], tg.xs, thr); if (s) { ndx += s.delta; vx.push({ coord: s.coord }) } }
        if (right)  { const s = bestSnap([snap.x + snap.w + dx], tg.xs, thr); if (s) { ndx += s.delta; vx.push({ coord: s.coord }) } }
        if (top)    { const s = bestSnap([snap.y + dy], tg.ys, thr); if (s) { ndy += s.delta; hy.push({ coord: s.coord }) } }
        if (bottom) { const s = bestSnap([snap.y + snap.h + dy], tg.ys, thr); if (s) { ndy += s.delta; hy.push({ coord: s.coord }) } }
      }
      setGuides({ vx, hy })
      if (left)   { x = snap.x + ndx; w = snap.w - ndx }
      if (right)  { w = snap.w + ndx }
      if (top)    { y = snap.y + ndy; h = snap.h - ndy }
      if (bottom) { h = snap.h + ndy }
      // Shift keeps the original aspect ratio (corner handles only).
      const corner = (left || right) && (top || bottom)
      if (e.shiftKey && corner && snap.w > 0 && snap.h > 0) {
        const s = Math.max(w / snap.w, h / snap.h)
        w = snap.w * s; h = snap.h * s
        if (left) x = snap.x + snap.w - w
        if (top)  y = snap.y + snap.h - h
      }
      // Alt resizes symmetrically about the centre (both edges move).
      if (e.altKey) {
        const ccx = snap.x + snap.w / 2, ccy = snap.y + snap.h / 2
        if (left || right) { w = 2 * w - snap.w; x = ccx - w / 2 }
        if (top || bottom) { h = 2 * h - snap.h; y = ccy - h / 2 }
      }
      if (w < 4) { if (left) x = snap.x + snap.w - 4; w = 4 }
      if (h < 4) { if (top)  y = snap.y + snap.h - 4; h = 4 }
      // Rotation pivots on the box centre; resizing shifts that centre, which would
      // drag the whole (rotated) shape across the canvas. Compensate so the anchor
      // edge stays put on screen: offset by (I − R(θ))·(oldCentre − newCentre).
      if (rotDeg) {
        const dCx = (snap.x + snap.w / 2) - (x + w / 2)
        const dCy = (snap.y + snap.h / 2) - (y + h / 2)
        const a = (rotDeg * Math.PI) / 180, rc = Math.cos(a), rs = Math.sin(a)
        x += dCx - (rc * dCx - rs * dCy)
        y += dCy - (rs * dCx + rc * dCy)
      }
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

  const onMouseUp = useCallback((e: React.MouseEvent) => {
    // Only the pointer that started the drag may end it (palm rejection).
    const upPid = (e as React.PointerEvent).pointerId
    if (dragRef.current && activePtrRef.current != null && upPid !== undefined && upPid !== activePtrRef.current) return
    activePtrRef.current = null
    // NOTE: the corner readout is NOT cleared here. onMouseUp is wired to pointerup /
    // pointercancel / pointerleave, and a background re-render can fire a spurious
    // `pointerleave` (with stale coords) that would wipe a still-valid readout. Instead
    // the hover handler clears it the moment the cursor moves off the corner, and
    // onMouseDown clears it when a gesture begins — which is all the UX needs.
    setMidPan(false)   // end of a middle-button pan → restore the tool cursor
    const pen = penRef.current
    if (pen?.dragging) setPenProgress({ ...pen, dragging: false })
    const drag = dragRef.current

    // Commit a freehand stroke: pencil → fitted open path, brush → filled ribbon.
    if (drag?.type === 'freehand') {
      const fh = freehandRef.current
      freehandRef.current = null
      dragRef.current = null
      const cs_ = csRef.current
      if (fh && fh.samples.length >= 2) {
        const opts = fhOptsRef.current
        const isBrush = toolRef.current === 'brush'
        let newEl: PathElement | null = null
        const base = {
          id: newId(), type: 'path' as const,
          rotation: 0, visible: true, locked: false, opacity: 100, zIndex: 0,
        }
        if (isBrush) {
          const widths = sampleWidths(fh.samples, opts.brushSize, opts.brushDynamics / 100, cs_.zoom)
          const ring = brushRibbon(fh.samples, widths)
          const points = ribbonToPathPoints(ring, 0.4 / cs_.zoom)
          if (points.length >= 3) {
            newEl = { ...base, name: t('apex_brush_name'), points, closed: true,
              fill: { type: 'solid', color: opts.color, opacity: 100 }, stroke: null,
              x: 0, y: 0, w: 0, h: 0 }
          }
        } else {
          const points = fitFreehandPath(fh.samples, 1.1 / cs_.zoom)
          if (points.length >= 2) {
            newEl = { ...base, name: t('apex_pencil_name'), points, closed: false,
              fill: { type: 'none' },
              stroke: { color: opts.color, opacity: 100, width: opts.pencilWidth, dashArray: [], cap: 'round', join: 'round' },
              x: 0, y: 0, w: 0, h: 0 }
          }
        }
        if (newEl) {
          const bb = pathBounds(newEl.points, newEl.closed)
          newEl.x = bb.x; newEl.y = bb.y
          newEl.w = bb.w || 1; newEl.h = bb.h || 1
          pushHistory()
          const el = newEl
          setPageData(prev => {
            const placed = { ...el, zIndex: prev.elements.length }
            // Live symmetry: drop the stroke into the drawing container.
            return placeInDrawSym({ ...prev, elements: [...prev.elements, placed] }, placed.id)
          })
          setSelectedIds([el.id])
        }
      }
      setFreehandTick(tk => tk + 1)
      return
    }

    // Commit a guide dragged out of a ruler (dropped back on the ruler = cancel).
    if (drag?.type === 'newguide') {
      dragRef.current = null
      setTempGuide(null)
      const canvas = canvasRef.current
      if (canvas) {
        const rect = canvas.getBoundingClientRect()
        const inRuler = e.clientX - rect.left <= RULER_PX || e.clientY - rect.top <= RULER_PX
        if (!inRuler) {
          const pt = toCanvas(e, rect, csRef.current)
          const g = { id: newId(), type: drag.guideType!, position: Math.round(drag.guideType === 'v' ? pt.x : pt.y) }
          pushHistory()
          setPageData(prev => ({ ...prev, guides: [...(prev.guides ?? []), g] }))
        }
      }
      return
    }
    // Dropping an existing guide on a ruler removes it.
    if (drag?.type === 'guide') {
      dragRef.current = null
      const canvas = canvasRef.current
      if (canvas) {
        const rect = canvas.getBoundingClientRect()
        const inRuler = e.clientX - rect.left <= RULER_PX || e.clientY - rect.top <= RULER_PX
        if (inRuler) {
          const gid = drag.guideId!
          setPageData(prev => ({ ...prev, guides: (prev.guides ?? []).filter(g => g.id !== gid) }))
        }
      }
      return
    }

    if (drag?.type === 'nodemarquee') {
      const m = marqueeRectRef.current
      if (m && (m.w > 2 || m.h > 2)) {
        const els = pageDataRef.current.elements
        const nodesIn = (p: PathElement): number[] => {
          const hits: number[] = []
          p.points.forEach((pt2, i) => {
            const w = localToWorld(pt2.x, pt2.y, p)
            if (w.x >= m.x && w.x <= m.x + m.w && w.y >= m.y && w.y <= m.y + m.h) hits.push(i)
          })
          return hits
        }
        const sel = selectedIdsRef.current
        let pe = sel.length === 1
          ? els.find(el => el.id === sel[0] && el.type === 'path') as PathElement | undefined
          : undefined
        // No path in node-edit yet: the marquee picks the topmost path with nodes
        // inside it (one path at a time, Illustrator-style direct selection).
        if (!pe) {
          const sorted = [...els].sort((a, b) => b.zIndex - a.zIndex)
          for (const el of sorted) {
            if (el.type !== 'path' || !el.visible || el.locked) continue
            if (nodesIn(el as PathElement).length) { pe = el as PathElement; setSelectedIds([el.id]); break }
          }
        }
        if (pe) {
          const hits = nodesIn(pe)
          // Shift extends the current node selection; a plain marquee replaces it.
          setNodeSel(prev => e.shiftKey ? Array.from(new Set([...prev, ...hits])) : hits)
        }
      }
    } else if (drag?.type === 'marquee') {
      const m = marqueeRectRef.current
      if (m && (m.w > 2 || m.h > 2)) {
        const inside = (b: { x:number;y:number;w:number;h:number }) =>
          b.x < m.x + m.w && b.x + b.w > m.x && b.y < m.y + m.h && b.y + b.h > m.y
        const els = pageDataRef.current.elements
        // Marquee selects the individual leaves it touches (clones excluded — they're
        // derived; select their container from the panel to move the pattern).
        const hits = els
          .filter(el => !isContainer(el) && !el.symOf && !effHidden(els, el) && !effLocked(els, el) && inside(elBBox(el)))
          .map(el => el.id)
        // Shift extends the selection; a plain marquee replaces it.
        setSelectedIds(prev => e.shiftKey ? Array.from(new Set([...prev, ...hits])) : Array.from(new Set(hits)))
      }
    } else if (drag && !drag.moved && (drag.type === 'create')) {
      // A click with the shape tool created a zero-size element → drop it.
      const nid = drag.newEl?.id
      if (nid) setPageData(prev => ({ ...prev, elements: prev.elements.filter(e2 => e2.id !== nid) }))
    } else if (drag?.type === 'create' && drag.moved && drag.newEl) {
      // Shape committed → drop it into the drawing symmetry container.
      const nid = drag.newEl.id
      if (symRef.current.mode !== 'off') setPageData(prev => placeInDrawSym(prev, nid))
    } else if (drag?.type === 'move' && drag.dupIds && !drag.moved) {
      // Alt-click without an actual drag: discard the speculative duplicates.
      const dup = new Set(drag.dupIds)
      setPageData(prev => ({ ...prev, elements: prev.elements.filter(e2 => !dup.has(e2.id)) }))
      if (drag.origIds) setSelectedIds(drag.origIds)
      past.current.pop()   // drop the now-pointless history entry
    }
    setMarquee(null); marqueeRef.current = null; marqueeRectRef.current = null
    setGuides({ vx: [], hy: [] })
    snapTouchRef.current = null; setSnapTouch(null)
    dragRef.current = null
  }, [t, pushHistory, placeInDrawSym])

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
        // Not preventDefault'ed on purpose: the browser's `paste` event is the only
        // way to reach clipboard images. The timeout covers the case where no such
        // event reaches us (no focused document) — then paste elements internally.
        if (k === 'v') {
          pasteInPlaceRef.current = e.shiftKey
          pasteHandledRef.current = false
          const inPlace = e.shiftKey
          setTimeout(() => { if (!pasteHandledRef.current) { if (inPlace) pasteInPlace(); else pasteSel() } }, 0)
          return
        }
        if (k === 'a') { e.preventDefault(); selectAll(); return }
        if (k === ']') { e.preventDefault(); reorder(e.shiftKey ? 'front' : 'forward'); return }
        if (k === '[') { e.preventDefault(); reorder(e.shiftKey ? 'back'  : 'backward'); return }
        if (k === '=' || k === '+') { e.preventDefault(); setCs(p => ({ ...p, zoom: Math.min(20, p.zoom * 1.2) })); return }
        if (k === '-')              { e.preventDefault(); setCs(p => ({ ...p, zoom: Math.max(0.02, p.zoom * 0.8) })); return }
        if (k === '0')              { e.preventDefault(); centerArtboard(pageDataRef.current); return }
        if (k === '1')              { e.preventDefault(); zoom100(); return }
        if (k === '2')              { e.preventDefault(); e.altKey ? unlockAll() : lockSel(); return }
        if (k === '3')              { e.preventDefault(); e.altKey ? showAll() : hideSel(); return }
        if (k === 'g')              { e.preventDefault(); e.shiftKey ? ungroupSel() : groupSel(); return }
        if (k === '7')              { e.preventDefault(); e.altKey ? releaseClipMask() : makeClipMask(); return }
        if (k === 'j')              { e.preventDefault(); e.altKey ? averageNodes() : joinSel(); return }
        if (k === 'r')              { e.preventDefault(); setRulersOn(v => !v); return }
        return
      }

      // ── Tool shortcuts ──
      if (k === 'v') { setPenProgress(null); setTool('select') }
      else if (k === 'a') { setPenProgress(null); setTool('node') }
      else if (k === 'm' || k === 'r') { setPenProgress(null); setTool('rect'); setCurShape(SHAPES_MENU[0]) }
      else if (k === 'l') { setPenProgress(null); setTool('ellipse'); setCurShape(SHAPES_MENU.find(s => s.id === 'ellipse')!) }
      else if (k === '\\') { setPenProgress(null); setTool('line') }
      else if (k === 'p') setTool('pen')
      else if (k === 'n') { setPenProgress(null); setTool('pencil') }
      else if (k === 'b') { setPenProgress(null); setTool('brush') }
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
        if (freehandRef.current) { freehandRef.current = null; dragRef.current = null; setFreehandTick(tk => tk + 1); return }
        if (toolRef.current === 'node') { setTool('select'); return }
        setSelectedIds([])
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (toolRef.current === 'node' && nodeSelRef.current.length && selectedIdsRef.current.length === 1) deleteNode()
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
  }, [commitPenPath, centerArtboard, undo, redo, duplicateSel, copySel, pasteSel, pasteInPlace, selectAll, reorder, deleteSel, pushHistory, groupSel, ungroupSel, makeClipMask, releaseClipMask, deleteNode, zoom100, lockSel, unlockAll, hideSel, showAll, joinSel, averageNodes])

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

  const cursor = midPan ? 'grabbing'
    : effectiveTool === 'hand' ? 'grab'
    : effectiveTool === 'pen' || effectiveTool === 'pencil' || effectiveTool === 'brush' ? 'crosshair'
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

  // Options des outils à main levée (crayon / pinceau) — visibles quand l'outil est actif.
  // ── Contextual controls surfaced in the options bar (below the menu bar) ────────
  // These used to live in the right-hand Properties panel; they now appear in the
  // contextual toolbar depending on the active tool / selection.
  const barFreehand = (tool === 'pencil' || tool === 'brush') ? (
    <div className="flex items-center gap-3">
      <BarSlider label={t('apex_stabilizer')} min={0} max={100} value={fhOpts.stabilizer}
        onChange={v => setFhOpts(o => ({ ...o, stabilizer: v }))} fmt={v => `${Math.round(v)}`} />
      {tool === 'brush'
        ? <BarSlider label={t('apex_fh_size')} min={2} max={80} value={fhOpts.brushSize}
            onChange={v => setFhOpts(o => ({ ...o, brushSize: v }))} fmt={v => `${Math.round(v)}`} />
        : <BarSlider label={t('apex_fh_size')} min={1} max={30} value={fhOpts.pencilWidth}
            onChange={v => setFhOpts(o => ({ ...o, pencilWidth: v }))} fmt={v => `${Math.round(v)}`} />}
      {tool === 'brush' && (
        <BarSlider label={t('apex_fh_dynamics')} min={0} max={100} value={fhOpts.brushDynamics}
          onChange={v => setFhOpts(o => ({ ...o, brushDynamics: v }))} fmt={v => `${Math.round(v)}`} />
      )}
      <label className="flex items-center gap-1.5 flex-shrink-0" title={t('apex_fh_color')}>
        <span className="text-[10px] uppercase" style={{ color: C.textDim }}>{t('apex_fh_color')}</span>
        <ColorField t={t} C={C} width={28} height={22} color={fhOpts.color}
          onChange={hex => setFhOpts(o => ({ ...o, color: hex }))} />
      </label>
    </div>
  ) : null

  // Pathfinder : opérations booléennes (≥ 2 objets non-texte sélectionnés).
  const selNonText = selectedIds
    .map(id => pageData.elements.find(e => e.id === id))
    .filter((e): e is VectorElement => !!e && e.type !== 'text' && e.type !== 'group' && e.type !== 'image')
  const soloEl = selectedIds.length === 1 ? pageData.elements.find(e => e.id === selectedIds[0]) ?? null : null

  const barPathfinder = selNonText.length >= 2 ? (
    <div className="flex items-center gap-1">
      {([['union', t('apex_pf_union')], ['subtract', t('apex_pf_subtract')], ['intersect', t('apex_pf_intersect')], ['exclude', t('apex_pf_exclude')]] as [BoolOp, string][]).map(([op, label]) => (
        <button key={op} title={label} onClick={() => pathfinder(op)}
          className="h-7 w-9 rounded flex items-center justify-center transition-colors flex-shrink-0"
          style={{ background: C.toolbar }}
          onMouseEnter={e => { e.currentTarget.style.background = C.active }}
          onMouseLeave={e => { e.currentTarget.style.background = C.toolbar }}>
          <PathfinderGlyph op={op} />
        </button>
      ))}
      <div className="w-px h-5 mx-0.5 flex-shrink-0" style={{ background: C.border }} />
      {([['divide', t('apex_pfx_divide')], ['trim', t('apex_pfx_trim')], ['merge', t('apex_pfx_merge')], ['crop', t('apex_pfx_crop')], ['minusback', t('apex_pfx_minusback')]] as [PathfinderOp, string][]).map(([op, label]) => (
        <button key={op} title={label} onClick={() => pathfinderX(op)}
          className="h-7 px-2 rounded text-[11px] transition-colors flex-shrink-0"
          style={{ background: C.toolbar, color: C.text }}
          onMouseEnter={e => { e.currentTarget.style.background = C.active }}
          onMouseLeave={e => { e.currentTarget.style.background = C.toolbar }}>
          {label}
        </button>
      ))}
    </div>
  ) : null

  const shapePe = soloEl && soloEl.type === 'path' && (soloEl as PathElement).shape ? soloEl as PathElement : null
  const barShapeParams = shapePe ? (() => {
    type Row = { label: string; min: number; max: number; step: number; value: number; set: (v: number) => void; fmt: (v: number) => string }
    const rows: Row[] = []
    const int = (v: number) => `${Math.round(v)}`
    if (shapePe.shape === 'polygon') {
      rows.push({ label: t('apex_shape_sides'), min: 3, max: 40, step: 1, value: shapePe.sides ?? 6, fmt: int,
        set: v => { const s = Math.max(3, Math.min(100, Math.round(v))); updateSelected({ sides: s, points: regenShapePoints({ ...shapePe, sides: s }) } as Partial<VectorElement>) } })
    } else if (shapePe.shape === 'star') {
      rows.push({ label: t('apex_shape_points'), min: 3, max: 40, step: 1, value: shapePe.spikes ?? 5, fmt: int,
        set: v => { const s = Math.max(3, Math.min(100, Math.round(v))); updateSelected({ spikes: s, points: regenShapePoints({ ...shapePe, spikes: s }) } as Partial<VectorElement>) } })
      rows.push({ label: t('apex_shape_inner'), min: 5, max: 95, step: 1, value: Math.round((shapePe.innerRatio ?? 0.45) * 100), fmt: v => `${Math.round(v)}%`,
        set: v => { const r = Math.max(0.05, Math.min(0.95, v / 100)); updateSelected({ innerRatio: r, points: regenShapePoints({ ...shapePe, innerRatio: r }) } as Partial<VectorElement>) } })
    } else {
      for (const d of (SHAPE_DEFS[shapePe.shape as LibShape] ?? [])) {
        const isRatio = d.max <= 1
        rows.push({ label: t(d.label), min: d.min, max: d.max, step: d.step, value: shapeParam(shapePe, d.key),
          fmt: v => isRatio ? `${Math.round(v * 100)}%` : int(v),
          set: v => { const params = { ...(shapePe.params ?? {}), [d.key]: v }; updateSelected({ params, points: regenShapePoints({ ...shapePe, params }) } as Partial<VectorElement>) } })
      }
    }
    // Corner rounding — for the sharp-cornered shapes (polygon/star/trapezoid).
    if (isRoundableShape(shapePe.shape)) {
      const maxR = Math.round(radiusHandleGeom(shapePe)?.maxR ?? Math.min(shapePe.w, shapePe.h) / 2)
      rows.push({ label: t('apex_corner_radius'), min: 0, max: Math.max(1, maxR), step: 1,
        value: Math.round(shapePe.params?.cornerRadius ?? 0), fmt: int,
        set: v => { const params = { ...(shapePe.params ?? {}), cornerRadius: Math.round(v) }; updateSelected({ params, points: regenShapePoints({ ...shapePe, params }) } as Partial<VectorElement>) } })
    }
    if (!rows.length) return null
    return <div className="flex items-center gap-3">{rows.map((r, i) => (
      <BarSlider key={i} label={r.label} min={r.min} max={r.max} step={r.step} value={r.value} onChange={r.set} fmt={r.fmt} />
    ))}</div>
  })() : null

  const barImage = soloEl && soloEl.type === 'image' ? (
    <BarButton title={t('apex_trace_image')} label={t('apex_trace_image')} icon={<Spline size={12} />}
      onClick={() => setTraceDlg(soloEl.id)} />
  ) : null

  const barPathOps = (soloEl && soloEl.type !== 'text' && soloEl.type !== 'image') ? (
    <div className="flex items-center gap-1">
      {soloEl.type === 'path' && <>
        <BarButton title={t('apex_path_simplify')} label={t('apex_path_simplify')} icon={<Waypoints size={12} />} onClick={() => simplifySel()} />
        <BarButton title={t('apex_path_smooth')} label={t('apex_path_smooth')} icon={<Spline size={12} />} onClick={() => smoothSel()} />
      </>}
      {soloEl.stroke && soloEl.stroke.width > 0 && (
        <BarButton title={t('apex_path_outline')} label={t('apex_path_outline')} icon={<PenTool size={12} />} onClick={outlineStrokeSel} />
      )}
      <BarButton title={t('apex_path_offset_out')} icon={<span className="text-[13px] leading-none">＋</span>} onClick={() => offsetSel(5)} />
      <BarButton title={t('apex_path_offset_in')} icon={<span className="text-[13px] leading-none">－</span>} onClick={() => offsetSel(-5)} />
    </div>
  ) : null

  const barCtxParts = [barShapeParams, barPathfinder, barPathOps, barImage].filter(Boolean) as React.ReactNode[]
  const barContext: React.ReactNode = barFreehand ?? (barCtxParts.length ? (
    <div className="flex items-center gap-1">
      {barCtxParts.map((node, i) => (
        <Fragment key={i}>
          {i > 0 && <div className="w-px h-5 mx-1 flex-shrink-0" style={{ background: C.border }} />}
          {node}
        </Fragment>
      ))}
    </div>
  ) : null)

  const apexPanels = {
    layers: { label: t('apex_layers'), render: () => {
      const els = pageData.elements
      const rows: React.ReactNode[] = []
      const build = (parentId: string, depth: number) => {
        // Front-most (highest z) first, matching the canvas stacking top-down.
        for (const el of childrenOf(els, parentId).slice().reverse()) {
          if (el.symOf) continue                 // derived clones are hidden from the layer tree
          const isSym = el.type === 'symmetry'
          const isGroup = isContainer(el)        // groups AND symmetry containers nest/collapse
          const leaves = isGroup ? descendantLeaves(els, el.id).filter(l => !l.symOf) : []
          const selected = isSym
            ? selectedIds.includes(el.id)
            : el.type === 'group'
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
              onToggleVisible={e => e.altKey ? soloLayer(el.id) : updateEl(el.id, { visible: !el.visible }, setPageData)}
              onToggleLock={() => updateEl(el.id, { locked: !el.locked }, setPageData)}
              onContextMenuRow={e => {
                e.preventDefault(); e.stopPropagation()
                if (!selected) selectFromPanel(el.id, false)
                ctx.open(e, [
                  { label: t('apex_rename'), onClick: () => { setRenamingId(el.id); setRenameDraft(el.name) } },
                  { label: t('apex_duplicate'), onClick: duplicateSel, shortcut: 'Ctrl+D' },
                  'sep',
                  { label: t('apex_bring_front'), onClick: () => reorder('front') },
                  { label: t('apex_send_back'),   onClick: () => reorder('back') },
                  'sep',
                  { label: el.visible ? t('apex_layer_hide') : t('apex_layer_show'), onClick: () => updateEl(el.id, { visible: !el.visible }, setPageData) },
                  { label: el.locked ? t('apex_layer_unlock') : t('apex_layer_lock'), onClick: () => updateEl(el.id, { locked: !el.locked }, setPageData) },
                  'sep',
                  // Symmetry-container context actions.
                  ...(isSym ? [
                    { label: t('apex_sym_edit'), onClick: () => setSymDlg(true) } as CtxItem,
                    { label: t('apex_sym_release'), onClick: () => releaseSym([el.id]) } as CtxItem,
                    'sep' as CtxItem,
                  ] : [{ label: t('apex_sym_create'), onClick: () => setSymDlg(true) } as CtxItem]),
                  ...(selectedIds.length >= 2 ? [{ label: t('apex_group'), onClick: groupSel, shortcut: 'Ctrl+G' } as CtxItem] : []),
                  ...((el.parentId != null || el.type === 'group') ? [{ label: t('apex_ungroup'), onClick: ungroupSel, shortcut: 'Ctrl+Shift+G' } as CtxItem] : []),
                  { label: t('apex_delete_element'), onClick: deleteSel, danger: true, shortcut: 'Suppr' },
                ])
              }}
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
            <button title={t('apex_duplicate')} onClick={duplicateSel} disabled={!selectedIds.length}
              className="flex items-center justify-center w-6 h-6 rounded hover:bg-white/10 disabled:opacity-30" style={{ color: C.textDim }}>
              <Copy size={13} />
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
                <div className="px-2 pb-2 flex flex-col gap-0.5">
                  <span className="text-[9px] uppercase" style={{ color: C.textDim }}>{t('apex_blend')}</span>
                  <Dropdown variant="dark" fontSize={11}
                    value={selectedEl.blend ?? 'source-over'}
                    onChange={v => updateSelected({ blend: v === 'source-over' ? undefined : v })}
                    options={BLEND_MODES.map(m => ({ value: m, label: t(`apex_blend_${m.replace(/-/g, '_')}` as 'apex_blend') }))}
                  />
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
                          onChange={hex => updateSelected({ fill: { ...selectedEl.fill, color: hex } as typeof selectedEl.fill })}
                          leftTools={[noneTool(t('apex_fill_none'), false, () => updateSelected({ fill: { type: 'none' } }))]} />
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
                        <RangeSlider
                          min={0} max={100} className="flex-1"
                          accent={C.accent} trackColor="rgba(255,255,255,0.15)"
                          value={selectedEl.fill.opacity}
                          onChange={v => updateSelected({ fill: { ...selectedEl.fill, opacity: v } as typeof selectedEl.fill })}
                          aria-label={t('apex_opacity')}
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
                          onChange={hex => updateSelected({ stroke: { ...selectedEl.stroke!, color: hex } })}
                          leftTools={[noneTool(t('apex_fill_none'), false, () => updateSelected({ stroke: null }))]} />
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
                        <RangeSlider
                          min={0} max={100} className="flex-1"
                          accent={C.accent} trackColor="rgba(255,255,255,0.15)"
                          value={selectedEl.stroke.opacity}
                          onChange={v => updateSelected({ stroke: { ...selectedEl.stroke!, opacity: v } })}
                          aria-label={t('apex_opacity')}
                        />
                        <input
                          type="number" min={0} max={100}
                          value={Math.round(selectedEl.stroke.opacity)}
                          onChange={e => updateSelected({ stroke: { ...selectedEl.stroke!, opacity: Math.max(0, Math.min(100, Number(e.target.value))) } })}
                          className="w-14 px-1.5 py-0.5 rounded text-[11px] outline-none"
                          style={{ background: '#2c2c2c', border: `1px solid ${C.border}`, color: C.text }}
                        />
                      </label>
                      <Dropdown variant="dark" className="w-full" fontSize={11}
                        value={(() => { const d = selectedEl.stroke!.dashArray; return !d.length ? 'solid' : d[0] <= 2 ? 'dotted' : 'dashed' })()}
                        onChange={v => updateSelected({ stroke: { ...selectedEl.stroke!,
                          dashArray: v === 'solid' ? [] : v === 'dotted' ? [1, 3] : [8, 5] } })}
                        options={[
                          { value: 'solid',  label: t('apex_dash_solid') },
                          { value: 'dashed', label: t('apex_dash_dashed') },
                          { value: 'dotted', label: t('apex_dash_dotted') },
                        ]} />
                      {/* Extrémités (cap) — segmented control, each icon rendered with
                          its own stroke-linecap so it previews the actual result. */}
                      <label className="flex items-center gap-2">
                        <span className="text-[9px] uppercase flex-shrink-0" style={{ color: C.textDim, width: 54 }}>{t('apex_stroke_cap')}</span>
                        <div className="flex-1 flex gap-0.5 p-0.5 rounded" style={{ background: '#2c2c2c' }}>
                          {(['butt', 'round', 'square'] as const).map(cp => {
                            const on = (selectedEl.stroke!.cap ?? 'butt') === cp
                            return (
                              <button key={cp} title={t(`apex_cap_${cp}` as 'apex_cap_butt')}
                                onClick={() => updateSelected({ stroke: { ...selectedEl.stroke!, cap: cp } })}
                                className="flex-1 h-7 rounded flex items-center justify-center transition-colors"
                                style={{ background: on ? C.accent : 'transparent', color: on ? '#fff' : C.textDim }}>
                                <CapIcon cap={cp} />
                              </button>
                            )
                          })}
                        </div>
                      </label>
                      {/* Jointures (join) — segmented control; each chevron icon uses
                          its own stroke-linejoin (miter/round/bevel = its real shape). */}
                      <label className="flex items-center gap-2">
                        <span className="text-[9px] uppercase flex-shrink-0" style={{ color: C.textDim, width: 54 }}>{t('apex_stroke_join')}</span>
                        <div className="flex-1 flex gap-0.5 p-0.5 rounded" style={{ background: '#2c2c2c' }}>
                          {(['miter', 'round', 'bevel'] as const).map(jn => {
                            const on = (selectedEl.stroke!.join ?? 'miter') === jn
                            return (
                              <button key={jn} title={t(`apex_join_${jn}` as 'apex_join_miter')}
                                onClick={() => updateSelected({ stroke: { ...selectedEl.stroke!, join: jn } })}
                                className="flex-1 h-7 rounded flex items-center justify-center transition-colors"
                                style={{ background: on ? C.accent : 'transparent', color: on ? '#fff' : C.textDim }}>
                                <JoinIcon join={jn} />
                              </button>
                            )
                          })}
                        </div>
                      </label>
                      {/* Miter limit — only relevant for a miter join (past this
                          ratio the point is cut to a bevel). */}
                      {(selectedEl.stroke!.join ?? 'miter') === 'miter' && (
                        <label className="flex items-center gap-2">
                          <span className="text-[9px] uppercase flex-shrink-0" style={{ color: C.textDim, width: 54 }}>{t('apex_miter_limit')}</span>
                          <RangeSlider
                            min={1} max={50} step={0.5} className="flex-1"
                            accent={C.accent} trackColor="rgba(255,255,255,0.15)"
                            value={selectedEl.stroke!.miterLimit ?? 10}
                            onChange={v => updateSelected({ stroke: { ...selectedEl.stroke!, miterLimit: v } })}
                            aria-label={t('apex_miter_limit')}
                          />
                          <input
                            type="number" min={1} max={100} step={0.5}
                            value={selectedEl.stroke!.miterLimit ?? 10}
                            onChange={e => updateSelected({ stroke: { ...selectedEl.stroke!, miterLimit: Math.max(1, Math.min(100, Number(e.target.value))) } })}
                            className="w-14 px-1.5 py-0.5 rounded text-[11px] outline-none"
                            style={{ background: '#2c2c2c', border: `1px solid ${C.border}`, color: C.text }}
                          />
                        </label>
                      )}
                    </>
                  )}
                </div>
              </PropSection>

              {selectedEl.type === 'rect' && (() => {
                const re = selectedEl as import('./api').RectElement
                const corners = re.corners
                return (
                  <PropSection title={t('apex_rectangle')}>
                    <div className="px-2 pb-2 flex flex-col gap-2">
                      {!corners && (
                        <label className="flex flex-col gap-0.5">
                          <span className="text-[9px] uppercase" style={{ color: C.textDim }}>{t('apex_corner_radius')}</span>
                          <input
                            type="number" min={0}
                            value={re.cornerRadius}
                            onChange={e => updateSelected({ cornerRadius: Number(e.target.value) } as Partial<VectorElement>)}
                            className="w-full px-1.5 py-0.5 rounded text-[11px] outline-none"
                            style={{ background: '#2c2c2c', border: `1px solid ${C.border}`, color: C.text }}
                          />
                        </label>
                      )}
                      {/* Independent per-corner radii (TL / TR / BR / BL). */}
                      <div className="flex items-center gap-2">
                        <Checkbox variant="dark" checked={!!corners}
                          onChange={v => updateSelected((v
                            ? { corners: [re.cornerRadius, re.cornerRadius, re.cornerRadius, re.cornerRadius] }
                            : { corners: undefined, cornerRadius: corners ? Math.max(...corners) : re.cornerRadius }) as Partial<VectorElement>)} />
                        <span className="text-[11px]" style={{ color: C.text }}>{t('apex_rect_corners')}</span>
                      </div>
                      {corners && (
                        <div className="grid grid-cols-2 gap-1">
                          {([['apex_corner_tl', 0], ['apex_corner_tr', 1], ['apex_corner_bl', 3], ['apex_corner_br', 2]] as [string, number][]).map(([key, idx]) => (
                            <label key={key} className="flex flex-col gap-0.5">
                              <span className="text-[9px] uppercase" style={{ color: C.textDim }}>{t(key)}</span>
                              <input
                                type="number" min={0}
                                value={Math.round(corners[idx])}
                                onChange={e => {
                                  const next = [...corners] as [number, number, number, number]
                                  next[idx] = Math.max(0, Number(e.target.value))
                                  updateSelected({ corners: next } as Partial<VectorElement>)
                                }}
                                className="w-full px-1.5 py-0.5 rounded text-[11px] outline-none"
                                style={{ background: '#2c2c2c', border: `1px solid ${C.border}`, color: C.text }}
                              />
                            </label>
                          ))}
                        </div>
                      )}
                    </div>
                  </PropSection>
                )
              })()}

              {/* Parametric-shape params (polygon sides, star points/inner, gear teeth…)
                  now live in the contextual options bar (barShapeParams). */}

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
                    <FontSizeField theme="dark" height={26} fontSize={11} fontWidth={132} sizeWidth={60}
                      font={(selectedEl as TextElement).fontFamily} onFontChange={v => updateText({ fontFamily: v })}
                      fonts={['Inter', 'Georgia', 'Courier New', 'Arial', 'Times New Roman']}
                      size={String((selectedEl as TextElement).fontSize)} onSizeChange={v => updateText({ fontSize: Number(v) })}
                      sizes={[8, 10, 12, 14, 18, 24, 36, 48, 72, 144]} minSize={4} maxSize={400} />
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

  // Embedded inside another editor → swap the (non-nestable) WorkspaceShell for a
  // bare shell that takes the same props. All tools/panels stay identical.
  const Shell = (embedded ? EmbedShell : EditorShell) as typeof EditorShell

  return (
    <Shell theme={C}
      chromeless
      topbarHeight={64}
      optionsBarHeight={40}
      onBack={embedded ? () => { flushSave(); embed!.onClose() } : () => { if (projectId && pageId) flushSave(); navigate('/paintsharp/apex') }}
      title={embedded ? (embed!.title ?? 'Frame') : titleDraft}
      onTitleChange={embedded ? undefined : setTitleDraft}
      onTitleCommit={embedded ? undefined : commitTitle}
      titlePlaceholder={t('common_untitled', { defaultValue: 'Sans titre' })}
      saveStatus={embedded ? '' : saveState === 'saving' ? t('apex_saving')
        : saveState === 'error' ? t('apex_save_failed')
        : t('doc_saved', { defaultValue: 'Enregistré' })}
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
        onSave:  () => { if (projectId && pageId) flushSave() },
        onClose: () => { if (projectId && pageId) flushSave(); navigate('/paintsharp/apex') },
        onExport: () => setExportDlg(true),
        exportLabel: t('apex_export_dialog'),
        fileExtra: [
          { label: t('apex_import_image'), onClick: () => fileInputRef.current?.click() },
          {
            // Writes the SVG back into the Drive (overwriting the source .svg
            // when the project was opened from one) — distinct from Export.
            label: t('apex_export_svg', { defaultValue: 'Enregistrer en SVG' }),
            onClick: () => {
              if (!projectId) return
              import('./apexSvgIO').then(({ saveApexAsSvg }) =>
                saveApexAsSvg(projectId, pageDataRef.current, 'dessin').catch(() => {}))
            },
          },
        ],
        onUndo: undo, onRedo: redo,
        editExtra: [
          { label: t('apex_ctx_cut'),   onClick: cutSel,   shortcut: 'Ctrl+X' },
          { label: t('apex_ctx_copy'),  onClick: copySel,  shortcut: 'Ctrl+C' },
          { label: t('apex_copy_kubuno', { defaultValue: 'Copier pour Kubuno' }), onClick: copyForKubuno },
          { label: t('apex_ctx_paste'), onClick: () => { void pasteSmart() }, shortcut: 'Ctrl+V' },
          { label: t('apex_paste_in_place'), onClick: () => { void pasteSmart(true) }, shortcut: 'Ctrl+Shift+V' },
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
            { label: t('apex_clip_make'),    onClick: makeClipMask,    shortcut: 'Ctrl+7' },
            { label: t('apex_clip_release'), onClick: releaseClipMask, shortcut: 'Ctrl+Alt+7' },
            'sep',
            { label: t('apex_convert_to_path'), onClick: convertToPath },
            'sep',
            { label: t('apex_bring_front'), onClick: () => reorder('front') },
            { label: t('apex_send_back'),   onClick: () => reorder('back') },
            'sep',
            { label: t('apex_flip_h'), onClick: () => flip('h') },
            { label: t('apex_flip_v'), onClick: () => flip('v') },
            { label: t('apex_rotate_cw'),  onClick: () => rotate90(1) },
            { label: t('apex_rotate_ccw'), onClick: () => rotate90(-1) },
            'sep',
            { label: t('apex_mirror'),        onClick: () => setMirrorDlg(true), disabled: !selectedIds.length },
            { label: t('apex_radial_repeat'), onClick: () => setRadialDlg(true), disabled: !selectedIds.length },
            { label: t('apex_grid_repeat'),   onClick: () => setGridDlg(true),   disabled: !selectedIds.length },
            { label: t('apex_mirror_repeat'), onClick: mirrorRepeatSel,          disabled: !selectedIds.length },
            { label: t('apex_sym_create'),    onClick: () => setSymDlg(true),    disabled: !selectedIds.length },
            'sep',
            { label: t('apex_lock_selection'), onClick: lockSel,   shortcut: 'Ctrl+2' },
            { label: t('apex_unlock_all'),     onClick: unlockAll, shortcut: 'Ctrl+Alt+2' },
            { label: t('apex_hide_selection'), onClick: hideSel,   shortcut: 'Ctrl+3' },
            { label: t('apex_show_all'),       onClick: showAll,   shortcut: 'Ctrl+Alt+3' },
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
          { label: t('apex_zoom_100'),       onClick: zoom100,   shortcut: 'Ctrl+1' },
          { label: t('apex_zoom_selection'), onClick: zoomToSel, disabled: !selectedIds.length },
          'sep',
          { label: snapOn ? t('apex_snap_off') : t('apex_snap_on'), onClick: () => setSnapOn(v => !v) },
          { label: gridOn ? t('apex_grid_off') : t('apex_grid_on'), onClick: () => setGridOn(v => !v) },
          'sep',
          { label: `${rulersOn ? '✓ ' : ''}${t('apex_toggle_rulers')}`,  onClick: () => setRulersOn(v => !v), shortcut: 'Ctrl+R' },
          { label: `${guidesOn ? '✓ ' : ''}${t('apex_toggle_guides')}`,  onClick: () => setGuidesOn(v => !v) },
          { label: `${guidesLocked ? '✓ ' : ''}${t('apex_lock_guides')}`, onClick: () => setGuidesLocked(v => !v) },
          { label: t('apex_clear_guides'), onClick: clearGuides, disabled: !(pageData.guides?.length) },
          'sep',
          { label: `${outlineMode ? '✓ ' : ''}${t('apex_outline_mode')}`, onClick: () => setOutlineMode(v => !v) },
          'sep',
          { label: t('apex_reset_rotation'), onClick: () => setCs(prev => ({ ...prev, rot: 0 })) },
        ],
      })}
      topbarActions={<>
        {penProgress && <span className="text-xs" style={{ color: C.accent }}>{t('apex_pen_progress', { count: penProgress.points.length })}</span>}
        <button onClick={() => { if (projectId && pageId) flushSave() }} className="px-3 py-1 rounded text-xs" style={{ background: C.accent, color: '#fff' }}>{t('common_save')}</button>
      </>}
      optionsBar={<ApexOptionsBar
        tool={tool} selCount={selectedIds.length}
        nodeMode={tool === 'node' && selectedIds.length === 1 && pageData.elements.find(e => e.id === selectedIds[0])?.type === 'path'}
        nodeSelCount={nodeSel.length} activeAnchorType={activeAnchorType} setAnchorType={setAnchorType}
        toolLabel={optToolLabel} align={align} distribute={distribute} flip={flip}
        reorder={reorder} rotate90={rotate90} duplicateSel={duplicateSel}
        groupSel={groupSel} ungroupSel={ungroupSel} t={t} context={barContext} />}
      toolRailWidth={72}
      toolRail={<>
          {/* Palette d'outils sur 2 colonnes, façon Illustrator (raccourci entre parenthèses) */}
          <div className="grid grid-cols-2 gap-0.5">
          {([
            { id: 'select',  icon: MousePointer, label: t('apex_tool_select'),      sc: 'V' },
            { id: 'node',    icon: Spline,       label: t('apex_tool_node'),        sc: 'A' },
            { id: 'pen',     icon: PenTool,      label: t('apex_tool_pen'),         sc: 'P' },
            { id: 'pencil',  icon: Pencil,       label: t('apex_tool_pencil'),      sc: 'N' },
            { id: 'brush',   icon: Brush,        label: t('apex_tool_brush'),       sc: 'B' },
            { id: 'text',    icon: Type,         label: t('apex_tool_text'),        sc: 'T' },
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

          {/* Formes prédéfinies groupées (façon Affinity) : l'icône du bouton =
              dernière forme choisie ; re-clic (ou clic droit) = ouvrir la grille. */}
          {(() => {
            const shapeToolActive = tool === 'rect' || tool === 'ellipse' || tool === 'shape'
            const openMenu = (el: HTMLElement) => {
              const r = el.getBoundingClientRect()
              setShapeMenuPos({ top: r.top - 4, left: r.right + 10 })
            }
            const CurIcon = curShape.icon
            return (
              <button
                title={`${t(curShape.nameKey)} — ${t('apex_shapes_group')}`}
                onClick={e => { if (shapeToolActive) openMenu(e.currentTarget) ; else pickShape(curShape) }}
                onContextMenu={e => { e.preventDefault(); openMenu(e.currentTarget as HTMLElement) }}
                className="w-8 h-8 rounded flex items-center justify-center transition-colors relative"
                style={{
                  background: shapeToolActive ? C.accent + '30' : 'transparent',
                  color: shapeToolActive ? C.accent : C.textDim,
                }}
              >
                <CurIcon size={16} />
                {/* Flyout affordance (bottom-right corner tick) */}
                <span className="absolute pointer-events-none" style={{ right: 1, bottom: 1, width: 0, height: 0,
                  borderLeft: '4px solid transparent', borderBottom: `4px solid ${shapeToolActive ? C.accent : C.textDim}` }} />
              </button>
            )
          })()}

          {([
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

          {/* Grille des formes prédéfinies */}
          {shapeMenuPos && (
            <MenuDropdown theme="dark" pos={shapeMenuPos} minWidth={152} onClose={() => setShapeMenuPos(null)}
              items={[{ type: 'custom', render: close => (
                <div className="grid grid-cols-4 gap-0.5 p-1" style={{ width: 152 }}>
                  {SHAPES_MENU.map(entry => {
                    const EIcon = entry.icon
                    const active = curShape.id === entry.id
                    return (
                      <button key={entry.id} title={t(entry.nameKey)}
                        onClick={() => { pickShape(entry); close() }}
                        className="w-8 h-8 rounded flex items-center justify-center hover:bg-white/10 transition-colors"
                        style={{ background: active ? C.accent + '30' : 'transparent', color: active ? C.accent : C.text }}>
                        <EIcon size={15} />
                      </button>
                    )
                  })}
                </div>
              ) }]} />
          )}

          {/* Bloc Fond / Contour façon Illustrator. Les deux pastilles pilotent la
              PEINTURE ACTIVE (couleurs par défaut des nouvelles formes) et, s'il y a
              une sélection, l'appliquent aussi à l'objet sélectionné. */}
          <div className="h-px w-full my-1.5" style={{ background: C.border }} />
          {(() => {
            const fillSwatch   = selectedEl && selectedEl.fill.type === 'solid' ? selectedEl.fill.color : curFill
            const strokeSwatch = selectedEl?.stroke?.color ?? curStroke
            const setFillPaint = (hex: string) => {
              setCurFill(hex)
              if (selectedEl) updateSelected({ fill: { type: 'solid', color: hex, opacity: selectedEl.fill.type === 'solid' ? selectedEl.fill.opacity : 100 } })
            }
            const setStrokePaint = (hex: string) => {
              setCurStroke(hex)
              if (selectedEl) updateSelected({ stroke: { ...(selectedEl.stroke ?? { opacity: 100, width: 2, dashArray: [] }), color: hex } })
            }
            return (
              <div className="relative" style={{ width: 48, height: 48 }} title={t('apex_fill_stroke')}>
                {/* Contour : grande pastille RONDE cliquable en arrière-plan, rendue en
                    DONUT creux (trou = fond du rail) → lecture « anneau » comme le contour. */}
                <ColorField t={t} C={C} width={32} height={32} className="absolute" style={{ right: 0, bottom: 0, borderRadius: '50%', overflow: 'hidden' }}
                  color={strokeSwatch} onChange={setStrokePaint}
                  leftTools={selectedEl ? [noneTool(t('apex_fill_none'), !selectedEl.stroke, () => updateSelected({ stroke: null }))] : undefined} />
                {/* No border → replace the stroke colour with the "none" face. */}
                {selectedEl && !selectedEl.stroke && <NoneSwatchFace style={{ right: 0, bottom: 0 }} />}
                <div className="absolute pointer-events-none" style={{ right: 0, bottom: 0, width: 32, height: 32, borderRadius: '50%', boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.35)' }} />
                <div className="absolute pointer-events-none" style={{ right: 9, bottom: 9, width: 14, height: 14, borderRadius: '50%', background: C.panel, boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.3)' }} />
                {/* Fond : grande pastille RONDE pleine au premier plan, chevauchant le
                    contour, cerclée d'un liseré blanc (aspect concentrique de la référence). */}
                <ColorField t={t} C={C} width={32} height={32} className="absolute" style={{ left: 0, top: 0, borderRadius: '50%', overflow: 'hidden' }}
                  color={fillSwatch} onChange={setFillPaint}
                  leftTools={selectedEl ? [noneTool(t('apex_fill_none'), selectedEl.fill.type === 'none', () => updateSelected({ fill: { type: 'none' } }))] : undefined} />
                {/* No fill → replace the fill colour with the "none" face. */}
                {selectedEl?.fill.type === 'none' && <NoneSwatchFace style={{ left: 0, top: 0 }} />}
                <div className="absolute pointer-events-none" style={{ left: 0, top: 0, width: 32, height: 32, borderRadius: '50%', boxShadow: 'inset 0 0 0 2.5px #fff, 0 0 0 1px rgba(0,0,0,0.45)' }} />
              </div>
            )
          })()}
          {/* Échanger fond/contour */}
          <div className="flex gap-0.5 mt-0.5">
            <button title={t('apex_fill_stroke_swap')} onClick={() => {
              if (!selectedEl) return
              const fillColor = selectedEl.fill.type === 'solid' ? selectedEl.fill.color : '#000000'
              const strokeColor = selectedEl.stroke?.color ?? '#000000'
              updateSelected({
                fill: { type: 'solid', color: strokeColor, opacity: selectedEl.fill.type === 'solid' ? selectedEl.fill.opacity : 100 },
                stroke: { ...(selectedEl.stroke ?? { opacity: 100, width: 1, dashArray: [] }), color: fillColor },
              })
            }} className="flex items-center justify-center hover:bg-white/10"
              style={{ width: 28, height: 24, borderRadius: 8, boxSizing: 'border-box', color: 'rgb(142, 142, 142)', fontFamily: 'var(--font-family-sans)' }}>
              <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" style={{ transform: 'scaleY(-1)' }}>
                <path d="M3.5 7 Q8 2.5 12.5 7" />
                <path d="M3.5 7 l0.4 -2.1 M3.5 7 l2.1 0.4" />
                <path d="M12.5 7 l-0.4 -2.1 M12.5 7 l-2.1 0.4" />
              </svg>
            </button>
          </div>

          {/* Magnétisme & grille */}
          <div className="h-px w-full my-1.5" style={{ background: C.border }} />
          <div className="flex flex-wrap gap-0.5">
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
            <button title={t('apex_toggle_rulers')} onClick={() => setRulersOn(v => !v)}
              className="w-8 h-7 rounded flex items-center justify-center transition-colors"
              style={{ background: rulersOn ? C.accent + '30' : 'transparent', color: rulersOn ? C.accent : C.textDim }}>
              <Ruler size={14} />
            </button>
            {/* Live symmetry (drawing mode + attach to selection) — full dialog. */}
            <button title={t('apex_symmetry')}
              onClick={() => setSymDlg(true)}
              className="w-8 h-7 rounded flex items-center justify-center transition-colors"
              style={{ background: symLive !== 'off' ? C.accent + '30' : 'transparent', color: symLive !== 'off' ? C.accent : C.textDim }}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
                <line x1="8" y1="1.5" x2="8" y2="14.5" strokeDasharray="2 1.6" />
                <path d="M6.5 4 L2.5 8 L6.5 12" fill="currentColor" stroke="none" />
                <path d="M9.5 4 L13.5 8 L9.5 12" fill="none" />
              </svg>
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
        {/* Pointer events (NOT mouse events, which would double-fire): full
            stylus support — pressure, pointer capture, palm rejection.
            touchAction none stops the browser panning/zooming mid-stroke. */}
        <canvas ref={canvasRef} className="block w-full h-full" style={{ cursor, touchAction: 'none' }}
                onPointerDown={onMouseDown} onPointerMove={onMouseMove} onPointerUp={onMouseUp}
                onPointerCancel={onMouseUp} onPointerLeave={onMouseUp}
                onDoubleClick={onCanvasDoubleClick}
                onContextMenu={onCanvasContextMenu}
                onDragOver={e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault() }}
                onDrop={e => {
                  // Drop files from the OS explorer: SVG → editable vector shapes,
                  // other images → placed bitmaps.
                  e.preventDefault()
                  const files = e.dataTransfer.files
                  if (!files?.length || !canvasRef.current) return
                  const pt = toCanvas(e, canvasRef.current.getBoundingClientRect(), csRef.current)
                  const isSvg = (f: File) => f.type === 'image/svg+xml' || /\.svg$/i.test(f.name)
                  const svgs = [...files].filter(isSvg), rasters = [...files].filter(f => !isSvg(f))
                  if (svgs.length) importSvgFiles(svgs, pt)
                  if (rasters.length) importImageFiles(rasters, pt)
                }} />
      </DockArea>
      {/* Hidden picker for Fichier → Importer une image… (SVG → editable vectors) */}
      <input ref={fileInputRef} type="file" accept="image/*,.svg" multiple style={{ display: 'none' }}
        onChange={e => {
          const fs = e.target.files
          if (fs?.length) {
            const isSvg = (f: File) => f.type === 'image/svg+xml' || /\.svg$/i.test(f.name)
            const svgs = [...fs].filter(isSvg), rasters = [...fs].filter(f => !isSvg(f))
            if (svgs.length) importSvgFiles(svgs)
            if (rasters.length) importImageFiles(rasters)
          }
          e.target.value = ''
        }} />
      {/* "Image trace" dialog (edge threshold + curve tolerance), Affinity-style. */}
      {exportDlg && (
        <ApexExportDialog
          t={t}
          pageData={pageData}
          selectedIds={selectedIds}
          pages={pagesRes?.pages ?? []}
          currentPageIdx={currentPageIdx}
          projectId={projectId ?? null}
          title={titleDraft}
          onClose={() => setExportDlg(false)}
        />
      )}
      {traceDlg && (() => {
        // Segmented two/three-way switch (cluster mode, hierarchy, curve fitting).
        const seg = <K extends string>(value: K, opts: [K, string][], set: (v: K) => void) => (
          <div className="flex rounded overflow-hidden" style={{ border: `1px solid ${C.border}` }}>
            {opts.map(([v, label]) => (
              <button key={v} onClick={() => set(v)}
                className="flex-1 px-2 py-1 text-[11px] transition-colors"
                style={{ background: value === v ? C.accent + '30' : 'transparent', color: value === v ? C.accent : C.textDim }}>
                {label}
              </button>
            ))}
          </div>
        )
        const slider = (label: string, key: keyof TraceOpts, mn: number, mx: number, step = 1) => (
          <div className="flex flex-col gap-1">
            <span className="text-[11px]" style={{ color: C.textDim }}>{label}</span>
            <div className="flex items-center gap-2">
              <RangeSlider min={mn} max={mx} step={step} className="flex-1" value={traceOpts[key] as number}
                onChange={v => patchTrace({ [key]: v })}
                accent={C.accent} trackColor="rgba(255,255,255,0.15)" aria-label={label} />
              <input type="number" min={mn} max={mx} step={step} value={traceOpts[key] as number}
                onChange={e => patchTrace({ [key]: Math.max(mn, Math.min(mx, Number(e.target.value))) })}
                className="w-12 px-1.5 py-0.5 rounded bg-transparent outline-none text-right text-[12px]"
                style={{ color: C.text, background: '#2c2c2c', border: `1px solid ${C.border}` }} />
            </div>
          </div>
        )
        const isBinary = traceOpts.clusterMode === 'binary'
        // Wheel-zoom anchored on the pointer; drag to pan.
        const onPrevWheel = (e: React.WheelEvent) => {
          const box = (e.currentTarget as HTMLElement).getBoundingClientRect()
          const mx = e.clientX - box.left, my = e.clientY - box.top
          setPrevView(v => {
            const z = Math.min(16, Math.max(0.05, v.z * (e.deltaY < 0 ? 1.2 : 1 / 1.2)))
            return { z, x: mx - (mx - v.x) * (z / v.z), y: my - (my - v.y) * (z / v.z) }
          })
        }
        const onPrevDown = (e: React.PointerEvent) => {
          const start = { px: e.clientX, py: e.clientY }
          const v0 = prevView
          const el = e.currentTarget as HTMLElement
          el.setPointerCapture(e.pointerId)
          const move = (ev: PointerEvent) => setPrevView({ ...v0, x: v0.x + ev.clientX - start.px, y: v0.y + ev.clientY - start.py })
          const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up) }
          el.addEventListener('pointermove', move)
          el.addEventListener('pointerup', up)
        }
        return (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.45)' }}
          onClick={() => setTraceDlg(null)}>
          <div className="rounded-xl shadow-2xl" style={{ background: C.panel, border: `1px solid ${C.border}`, width: 980, maxWidth: 'calc(100vw - 40px)' }}
            onClick={e => e.stopPropagation()}>
            <div className="flex items-center px-4 py-2.5" style={{ borderBottom: `1px solid ${C.border}` }}>
              <span className="flex-1 text-center text-[13px] font-semibold" style={{ color: C.text }}>{t('apex_trace_image')}</span>
              <button onClick={() => setTraceDlg(null)} className="w-6 h-6 rounded flex items-center justify-center hover:bg-white/10" style={{ color: C.textDim }}>✕</button>
            </div>
            <div className="flex items-stretch">
            <div className="px-4 py-3 flex flex-col gap-3" style={{ width: 500, flexShrink: 0 }}>
              {/* Presets (VTracer's bw / poster / photo) */}
              <div className="flex items-center gap-2">
                <span className="text-[11px]" style={{ color: C.textDim }}>{t('apex_trace_preset')}</span>
                {(['bw', 'poster', 'photo'] as const).map(p => (
                  <button key={p} onClick={() => patchTrace(TRACE_PRESETS[p])}
                    className="px-2.5 py-1 rounded-full text-[11px] hover:brightness-110"
                    style={{ background: C.toolbar, color: C.text, border: `1px solid ${C.border}` }}>
                    {t(`apex_trace_preset_${p}`)}
                  </button>
                ))}
              </div>
              {/* Clustering */}
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1">
                  <span className="text-[11px]" style={{ color: C.textDim }}>{t('apex_trace_clusters')}</span>
                  {seg(traceOpts.clusterMode, [['color', t('apex_trace_mode_color')], ['binary', t('apex_trace_mode_binary')]],
                       v => patchTrace({ clusterMode: v }))}
                </div>
                <div className="flex flex-col gap-1" style={{ opacity: isBinary ? 0.45 : 1, pointerEvents: isBinary ? 'none' : undefined }}>
                  <span className="text-[11px]" style={{ color: C.textDim }}>{t('apex_trace_hierarchy')}</span>
                  {seg(traceOpts.hierarchical, [['stacked', t('apex_trace_stacked')], ['cutout', t('apex_trace_cutout')]],
                       v => patchTrace({ hierarchical: v }))}
                </div>
              </div>
              {slider(t('apex_trace_speckle'), 'filterSpeckle', 0, 16)}
              {!isBinary && slider(t('apex_trace_color_precision'), 'colorPrecision', 1, 8)}
              {!isBinary && slider(t('apex_trace_gradient_step'), 'gradientStep', 0, 128)}
              {/* Curve fitting */}
              <div className="flex flex-col gap-1">
                <span className="text-[11px]" style={{ color: C.textDim }}>{t('apex_trace_curve')}</span>
                {seg(traceOpts.curveMode,
                     [['spline', t('apex_trace_curve_spline')], ['polygon', t('apex_trace_curve_polygon')], ['pixel', t('apex_trace_curve_pixel')]],
                     v => patchTrace({ curveMode: v }))}
              </div>
              {traceOpts.curveMode === 'spline' && (
                <div className="grid grid-cols-2 gap-3">
                  {slider(t('apex_trace_corner'), 'cornerThreshold', 0, 180)}
                  {slider(t('apex_trace_splice'), 'spliceThreshold', 0, 180)}
                </div>
              )}
              {traceOpts.curveMode !== 'pixel' && slider(t('apex_trace_segment'), 'segmentLength', 3.5, 10, 0.5)}
              {slider(t('apex_trace_simplify'), 'simplify', 0, 10, 0.5)}
              {/* OCR: recognized text lines become REAL editable text elements. */}
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input type="checkbox" checked={traceOcr} onChange={e => setTraceOcr(e.target.checked)}
                  style={{ accentColor: C.accent }} />
                <span className="text-[12px]" style={{ color: C.text }}>{t('apex_trace_ocr')}</span>
              </label>
              {traceErr && <div className="text-[12px]" style={{ color: '#f87171' }}>{traceErr}</div>}
            </div>
            {/* Live result preview: re-traced on every option change, wheel-zoomable. */}
            <div className="flex flex-col gap-2 px-4 py-3" style={{ borderLeft: `1px solid ${C.border}`, flex: 1, minWidth: 0 }}>
              <div className="flex items-center gap-2">
                <span className="flex-1 text-[11px]" style={{ color: C.textDim }}>
                  {t('apex_trace_preview')}
                  {traceCount && (
                    <span className="ml-2 tabular-nums" style={{ color: C.textDim, opacity: 0.8 }}>
                      {traceCount.before === traceCount.after
                        ? `${traceCount.after} pts`
                        : `${traceCount.before} → ${traceCount.after} pts`}
                    </span>
                  )}
                </span>
                <button onClick={() => setPrevView(v => ({ ...v, z: Math.max(0.05, v.z / 1.2) }))} title="−"
                  className="w-6 h-6 rounded hover:bg-white/10 text-[13px]" style={{ color: C.textDim }}>−</button>
                <span className="text-[11px] tabular-nums w-10 text-center" style={{ color: C.textDim }}>{Math.round(prevView.z * 100)}%</span>
                <button onClick={() => setPrevView(v => ({ ...v, z: Math.min(16, v.z * 1.2) }))} title="+"
                  className="w-6 h-6 rounded hover:bg-white/10 text-[13px]" style={{ color: C.textDim }}>+</button>
                <button onClick={fitPreview}
                  className="px-2 h-6 rounded text-[11px] hover:bg-white/10" style={{ color: C.textDim, border: `1px solid ${C.border}` }}>
                  {t('apex_fit')}
                </button>
              </div>
              <div className="relative rounded overflow-hidden select-none" onWheel={onPrevWheel} onPointerDown={onPrevDown}
                style={{
                  width: PREV_BOX.w, height: PREV_BOX.h, cursor: 'grab', touchAction: 'none',
                  // Checkerboard so keyed-out transparency reads as transparent.
                  backgroundImage: 'conic-gradient(#3a3a3a 0 25%, #2e2e2e 0 50%, #3a3a3a 0 75%, #2e2e2e 0)',
                  backgroundSize: '16px 16px', border: `1px solid ${C.border}`,
                }}>
                {tracePrev && (
                  <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(tracePrev)}`} alt=""
                    draggable={false}
                    style={{
                      position: 'absolute', left: 0, top: 0,
                      width: tracePayloadRef.current?.w, height: tracePayloadRef.current?.h,
                      transform: `translate(${prevView.x}px, ${prevView.y}px) scale(${prevView.z})`,
                      transformOrigin: '0 0', imageRendering: prevView.z > 3 ? 'pixelated' : undefined,
                      maxWidth: 'none',
                    }} />
                )}
                {tracePrevBusy && (
                  <div className="absolute inset-0 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.25)' }}>
                    <div className="w-6 h-6 rounded-full border-2 border-t-transparent animate-spin" style={{ borderColor: C.accent, borderTopColor: 'transparent' }} />
                  </div>
                )}
              </div>
            </div>
            </div>
            <div className="flex items-center gap-2 px-4 py-2.5" style={{ borderTop: `1px solid ${C.border}` }}>
              <div style={{ flex: 1 }} />
              <button onClick={() => { void applyTrace() }} disabled={traceBusy}
                className="h-8 px-4 rounded text-[12px] font-medium hover:brightness-110 disabled:opacity-60"
                style={{ background: C.accent, color: '#fff' }}>
                {traceBusy ? '…' : t('filt_apply')}
              </button>
              <button onClick={() => setTraceDlg(null)} className="h-8 px-4 rounded text-[12px] hover:brightness-110"
                style={{ background: C.toolbar, color: C.text, border: `1px solid ${C.border}` }}>{t('common_cancel')}</button>
            </div>
          </div>
        </div>
        )
      })()}
      {/* Corner angle editor: set the interior angle of the double-clicked / right-clicked
          vertex via a boxed slider (editable field). Live preview; Cancel pops the undo
          step pushed on open. */}
      {angleDlg && (() => {
        const cancel = () => { const pre = past.current.pop(); if (pre) setPageData(pre); setAngleDlg(null) }
        return (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.45)' }} onClick={cancel}>
          <div className="rounded-xl shadow-2xl" style={{ background: C.panel, border: `1px solid ${C.border}`, width: 320 }} onClick={e => e.stopPropagation()}>
            <div className="flex items-center px-4 py-2.5" style={{ borderBottom: `1px solid ${C.border}` }}>
              <span className="text-[13px] font-medium" style={{ color: C.text }}>{t('apex_edit_angle')}</span>
            </div>
            <div className="px-4 py-4 flex flex-col gap-3.5">
              <RangeSlider variant="boxed" min={1} max={179} step={0.5}
                value={angleDlg.value}
                format={v => `${Number.isInteger(v) ? v : v.toFixed(1)}°`}
                minLabel="1°" maxLabel="179°" accent={C.accent}
                onChange={v => { setAngleDlg(d => d && { ...d, value: v }); applyCornerAngle(angleDlg.srcId, angleDlg.ptIndex, v, angleDlg.strat, angleDlg.base) }}
                aria-label={t('apex_edit_angle')} />
              {/* Which neighbour absorbs the induced cascade. */}
              <div className="flex flex-col gap-1.5">
                <span className="text-[11px]" style={{ color: C.textDim }}>{t('apex_angle_propagate')}</span>
                <div className="flex gap-1">
                  {([['out', t('apex_angle_out')], ['in', t('apex_angle_in')], ['split', t('apex_angle_split')]] as [AngleStrat, string][]).map(([s, label]) => (
                    <button key={s} onClick={() => { setAngleDlg(d => d && { ...d, strat: s }); applyCornerAngle(angleDlg.srcId, angleDlg.ptIndex, angleDlg.value, s, angleDlg.base) }}
                      className="flex-1 h-7 rounded text-[11px] hover:brightness-110"
                      style={angleDlg.strat === s
                        ? { background: C.accent, color: '#fff', border: `1px solid ${C.accent}` }
                        : { background: C.toolbar, color: C.text, border: `1px solid ${C.border}` }}>{label}</button>
                  ))}
                </div>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 px-4 py-2.5" style={{ borderTop: `1px solid ${C.border}` }}>
              <button onClick={cancel} className="h-8 px-4 rounded text-[12px] hover:brightness-110"
                style={{ background: C.toolbar, color: C.text, border: `1px solid ${C.border}` }}>{t('common_cancel')}</button>
              <button onClick={() => setAngleDlg(null)} className="h-8 px-4 rounded text-[12px] font-medium hover:brightness-110"
                style={{ background: C.accent, color: '#fff' }}>{t('common_confirm')}</button>
            </div>
          </div>
        </div>
        )
      })()}
      {distortDlg && (() => {
        const cancel = () => { const pre = past.current.pop(); if (pre) setPageData(pre); setDistortDlg(null); distortBaseRef.current = null }
        const fx = distortDlg.fx
        const jitter = fx === 'roughen' || fx === 'zigzag'
        const rng = fx === 'twist' ? { min: -360, max: 360, u: '°' } : fx === 'pucker' ? { min: -100, max: 100, u: '%' } : { min: 0, max: 100, u: '%' }
        return (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.45)' }} onClick={cancel}>
          <div className="rounded-xl shadow-2xl" style={{ background: C.panel, border: `1px solid ${C.border}`, width: 320 }} onClick={e => e.stopPropagation()}>
            <div className="flex items-center px-4 py-2.5" style={{ borderBottom: `1px solid ${C.border}` }}>
              <span className="text-[13px] font-medium" style={{ color: C.text }}>{t(`apex_fx_${fx}` as 'apex_fx_twist')}</span>
            </div>
            <div className="px-4 py-4 flex flex-col gap-3.5">
              <div className="flex flex-col gap-1.5">
                <span className="text-[11px]" style={{ color: C.textDim }}>{t('apex_fx_amount')}</span>
                <RangeSlider variant="boxed" min={rng.min} max={rng.max} step={1}
                  value={distortDlg.amount} format={v => `${Math.round(v)}${rng.u}`}
                  minLabel={`${rng.min}${rng.u}`} maxLabel={`${rng.max}${rng.u}`} accent={C.accent}
                  onChange={v => { setDistortDlg(d => d && { ...d, amount: v }); applyDistort(fx, v, distortDlg.detail) }}
                  aria-label={t('apex_fx_amount')} />
              </div>
              {jitter && (
                <div className="flex flex-col gap-1.5">
                  <span className="text-[11px]" style={{ color: C.textDim }}>{t('apex_fx_detail')}</span>
                  <RangeSlider variant="boxed" min={1} max={20} step={1}
                    value={distortDlg.detail} format={v => `${Math.round(v)}`}
                    minLabel="1" maxLabel="20" accent={C.accent}
                    onChange={v => { setDistortDlg(d => d && { ...d, detail: v }); applyDistort(fx, distortDlg.amount, v) }}
                    aria-label={t('apex_fx_detail')} />
                </div>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 px-4 py-2.5" style={{ borderTop: `1px solid ${C.border}` }}>
              <button onClick={cancel} className="h-8 px-4 rounded text-[12px] hover:brightness-110"
                style={{ background: C.toolbar, color: C.text, border: `1px solid ${C.border}` }}>{t('common_cancel')}</button>
              <button onClick={() => { setDistortDlg(null); distortBaseRef.current = null }} className="h-8 px-4 rounded text-[12px] font-medium hover:brightness-110"
                style={{ background: C.accent, color: '#fff' }}>{t('common_confirm')}</button>
            </div>
          </div>
        </div>
        )
      })()}
      {/* Symmetry dialog: EDIT a selected symmetry container, or CREATE one from
          the selection / set the drawing mode. Radial count is free (2-72); the
          container centre is a draggable handle on the canvas. */}
      {symDlg && (() => {
        const selCont = pageData.elements.find(e => e.type === 'symmetry' && selectedIds.includes(e.id)) as SymmetryElement | undefined
        const curMode = selCont ? selCont.symMode : (symLive === 'off' ? 'v' : symLive)
        const curCount = selCont ? selCont.symCount : symCount
        const setMode = (m: 'off' | 'v' | 'h' | 'vh' | 'radial') => selCont ? (m !== 'off' && updateSym(selCont.id, { symMode: m })) : setSymLive(m)
        const setCount = (n: number) => selCont ? updateSym(selCont.id, { symCount: n }) : setSymCount(n)
        return (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.45)' }} onClick={() => setSymDlg(false)}>
          <div className="rounded-xl shadow-2xl" style={{ background: C.panel, border: `1px solid ${C.border}`, width: 440 }} onClick={e => e.stopPropagation()}>
            <div className="flex items-center px-4 py-2.5" style={{ borderBottom: `1px solid ${C.border}` }}>
              <span className="flex-1 text-center text-[13px] font-semibold" style={{ color: C.text }}>{selCont ? t('apex_symmetry_obj') : t('apex_live_sym_title')}</span>
              <button onClick={() => setSymDlg(false)} className="w-6 h-6 rounded flex items-center justify-center hover:bg-white/10" style={{ color: C.textDim }}>✕</button>
            </div>
            <div className="px-4 py-3 flex flex-col gap-3">
              <div className="flex items-center gap-1.5 flex-wrap">
                {([...(selCont ? [] : [['off', t('apex_sym_off')]]), ['v', t('apex_sym_v')], ['h', t('apex_sym_h')], ['vh', t('apex_sym_vh')], ['radial', t('apex_sym_radial')]] as ['off' | 'v' | 'h' | 'vh' | 'radial', string][]).map(([m, label]) => {
                  const active = selCont ? curMode === m : symLive === m
                  return (
                  <button key={m} onClick={() => setMode(m)}
                    className="h-7 px-2.5 rounded text-[12px] transition-colors"
                    style={{ background: active ? C.accent : C.toolbar, color: active ? '#fff' : C.text }}>
                    {label}
                  </button>
                )})}
              </div>
              {curMode === 'radial' && (
                <div className="flex items-center gap-2">
                  <span className="text-[12px] flex-1" style={{ color: C.text }}>{t('apex_radial_count')}</span>
                  <RangeSlider min={2} max={72} step={1} value={curCount} onChange={setCount}
                    accent={C.accent} trackColor="rgba(255,255,255,0.15)" aria-label={t('apex_radial_count')} className="w-44" />
                  <input type="number" min={2} max={72} value={curCount}
                    onChange={e => setCount(Math.max(2, Math.min(72, Number(e.target.value))))}
                    className="w-14 px-1.5 py-1 rounded text-right text-[12px] outline-none"
                    style={{ background: '#2c2c2c', border: `1px solid ${C.border}`, color: C.text }} />
                </div>
              )}
              <span className="text-[11px]" style={{ color: C.textDim }}>
                {selCont ? t('apex_sym_hint_edit') : t('apex_sym_hint_create')}
              </span>
            </div>
            <div className="flex items-center gap-2 px-4 py-2.5" style={{ borderTop: `1px solid ${C.border}` }}>
              {selCont ? (
                <button onClick={() => { releaseSym([selCont.id]); setSymDlg(false) }}
                  className="h-8 px-3 rounded text-[12px] hover:brightness-110"
                  style={{ background: C.toolbar, color: C.text, border: `1px solid ${C.border}` }}>{t('apex_sym_release')}</button>
              ) : (
                <button onClick={() => { createSymmetry(curMode, curCount); setSymDlg(false) }}
                  disabled={!selectedIds.length}
                  className="h-8 px-3 rounded text-[12px] font-medium hover:brightness-110 disabled:opacity-50"
                  style={{ background: C.accent, color: '#fff' }}>{t('apex_sym_create')}</button>
              )}
              <div style={{ flex: 1 }} />
              <button onClick={() => setSymDlg(false)} className="h-8 px-4 rounded text-[12px] hover:brightness-110"
                style={{ background: C.toolbar, color: C.text, border: `1px solid ${C.border}` }}>{selCont ? t('filt_apply') : t('common_cancel')}</button>
            </div>
          </div>
        </div>
        )
      })()}
      {/* Symmetry tool dialogs (Miroir / Répétition radiale / Répétition en grille). */}
      {(mirrorDlg || radialDlg || gridDlg) && (() => {
        const title = mirrorDlg ? t('apex_mirror_title') : radialDlg ? t('apex_radial_title') : t('apex_grid_title')
        const close = () => { setMirrorDlg(false); setRadialDlg(false); setGridDlg(false) }
        const numRow = (label: string, val: number, set: (v: number) => void, min: number, max: number) => (
          <div key={label} className="flex items-center gap-2">
            <span className="text-[12px] flex-1" style={{ color: C.text }}>{label}</span>
            <RangeSlider min={min} max={max} step={1} value={val} onChange={set}
              accent={C.accent} trackColor="rgba(255,255,255,0.15)" aria-label={label} className="w-44" />
            <input type="number" min={min} max={max} value={Math.round(val)}
              onChange={e => set(Math.max(min, Math.min(max, Number(e.target.value))))}
              className="w-14 px-1.5 py-1 rounded text-right text-[12px] outline-none"
              style={{ background: '#2c2c2c', border: `1px solid ${C.border}`, color: C.text }} />
          </div>
        )
        const btn = (label: string, cb: () => void, primary = false) => (
          <button key={label} onClick={cb} className="h-8 px-4 rounded text-[12px] hover:brightness-110"
            style={{ background: primary ? C.accent : C.toolbar, color: primary ? '#fff' : C.text, border: `1px solid ${C.border}`, fontWeight: primary ? 600 : 400 }}>
            {label}
          </button>
        )
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.45)' }} onClick={close}>
            <div className="rounded-xl shadow-2xl" style={{ background: C.panel, border: `1px solid ${C.border}`, width: 420 }} onClick={e => e.stopPropagation()}>
              <div className="flex items-center px-4 py-2.5" style={{ borderBottom: `1px solid ${C.border}` }}>
                <span className="flex-1 text-center text-[13px] font-semibold" style={{ color: C.text }}>{title}</span>
                <button onClick={close} className="w-6 h-6 rounded flex items-center justify-center hover:bg-white/10" style={{ color: C.textDim }}>✕</button>
              </div>
              <div className="px-4 py-3 flex flex-col gap-3">
                {mirrorDlg && <>
                  <div className="flex items-center gap-1.5">
                    {([['v', t('apex_axis_v')], ['h', t('apex_axis_h')], ['angle', t('apex_axis_angle')]] as ['v' | 'h' | 'angle', string][]).map(([m, label]) => (
                      <button key={m} onClick={() => setMirrorAxis(m)}
                        className="h-7 px-2.5 rounded text-[12px] transition-colors"
                        style={{ background: mirrorAxis === m ? C.accent : C.toolbar, color: mirrorAxis === m ? '#fff' : C.text }}>
                        {label}
                      </button>
                    ))}
                  </div>
                  {mirrorAxis === 'angle' && numRow(t('apex_angle'), mirrorAngle, setMirrorAngle, -90, 90)}
                </>}
                {radialDlg && <>
                  {numRow(t('apex_radial_count'), radialCount, setRadialCount, 2, 72)}
                  {numRow(t('apex_radial_radius'), radialRadius, setRadialRadius, 0, 800)}
                </>}
                {gridDlg && <>
                  {numRow(t('apex_grid_rows'), gridRows, setGridRows, 1, 40)}
                  {numRow(t('apex_grid_cols'), gridCols, setGridCols, 1, 40)}
                  {numRow(t('apex_grid_gap_h'), gridGapX, setGridGapX, 0, 400)}
                  {numRow(t('apex_grid_gap_v'), gridGapY, setGridGapY, 0, 400)}
                </>}
              </div>
              <div className="flex items-center justify-end gap-2 px-4 py-2.5" style={{ borderTop: `1px solid ${C.border}` }}>
                {mirrorDlg && btn(t('apex_ctx_copy'), () => applyMirror(true), true)}
                {mirrorDlg && btn(t('filt_apply'), () => applyMirror(false))}
                {radialDlg && btn(t('filt_apply'), applyRadial, true)}
                {gridDlg && btn(t('filt_apply'), applyGrid, true)}
                {btn(t('common_cancel'), close)}
              </div>
            </div>
          </div>
        )
      })()}
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

// Tiny live thumbnail of an element, rendered with the real paint pipeline.
// Elements are immutable, so the effect only re-runs when the element changes.
// Distinct glyph per node type for the direct-selection contextual toolbar.
function NodeTypeIcon({ type, size = 16 }: { type: AnchorType; size?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  if (type === 'sharp') return (
    <svg {...common}><path d="M2.5 13 L8 3.5 L13.5 13" /><rect x="6" y="1.6" width="4" height="4" rx="0.5" fill="currentColor" stroke="none" /></svg>
  )
  if (type === 'smooth') return (
    <svg {...common}><path d="M2 11.5 C 4.5 5, 11.5 5, 14 11.5" /><line x1="3.5" y1="6.6" x2="12.5" y2="6.6" strokeWidth="1" /><circle cx="8" cy="6.6" r="2.1" fill="currentColor" stroke="none" /></svg>
  )
  if (type === 'symmetric') return (
    <svg {...common}><path d="M2 11.5 C 4.5 5, 11.5 5, 14 11.5" /><line x1="2.5" y1="6.6" x2="13.5" y2="6.6" strokeWidth="1" /><circle cx="2.5" cy="6.6" r="1.3" fill="currentColor" stroke="none" /><circle cx="13.5" cy="6.6" r="1.3" fill="currentColor" stroke="none" /><circle cx="8" cy="6.6" r="2.1" fill="currentColor" stroke="none" /></svg>
  )
  // smart: flowing curve + auto handle bar (dashed), round node.
  return (
    <svg {...common}><path d="M2 12 C 5.5 12, 5 4, 8 4 C 11 4, 10.5 12, 14 12" /><circle cx="8" cy="4" r="2.1" fill="currentColor" stroke="none" /></svg>
  )
}

// Stroke-JOIN icon that literally demonstrates the join: a chevron drawn with the
// matching `stroke-linejoin`, so miter shows a sharp apex, round a curved one, bevel
// a cut one — exactly what the setting does to the artwork.
function JoinIcon({ join, size = 17 }: { join: 'miter' | 'round' | 'bevel'; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth={3.4} strokeLinejoin={join} strokeLinecap="butt">
      <polyline points="3,14 9,5 15,14" />
    </svg>
  )
}
// Stroke-CAP icon: a thick stub whose ends render with the matching `stroke-linecap`.
function CapIcon({ cap, size = 17 }: { cap: 'butt' | 'round' | 'square'; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth={5} strokeLinecap={cap}>
      <line x1="5" y1="9" x2="13" y2="9" />
    </svg>
  )
}

// Compact labelled slider used inside the contextual options bar.
function BarSlider({ label, min, max, step = 1, value, onChange, fmt, width = 78 }: {
  label: string; min: number; max: number; step?: number; value: number
  onChange: (v: number) => void; fmt: (v: number) => string; width?: number
}) {
  return (
    <label className="flex items-center gap-1.5 flex-shrink-0" title={label}>
      <span className="text-[10px] uppercase whitespace-nowrap" style={{ color: C.textDim }}>{label}</span>
      <div style={{ width }}>
        <RangeSlider className="w-full" min={min} max={max} step={step} value={value} onChange={onChange}
          accent={C.accent} trackColor="rgba(255,255,255,0.15)" aria-label={label} />
      </div>
      <span className="text-[10px] w-8 text-right tabular-nums" style={{ color: C.text }}>{fmt(value)}</span>
    </label>
  )
}
// Compact text/icon button used inside the contextual options bar.
function BarButton({ label, icon, onClick, title }: { label?: string; icon?: React.ReactNode; onClick: () => void; title: string }) {
  return (
    <button title={title} onClick={onClick}
      className="h-7 px-2 rounded flex items-center gap-1.5 text-[11px] transition-colors flex-shrink-0"
      style={{ background: C.toolbar, color: C.text }}
      onMouseEnter={e => { e.currentTarget.style.background = C.active }}
      onMouseLeave={e => { e.currentTarget.style.background = C.toolbar }}>
      {icon}{label && <span className="whitespace-nowrap">{label}</span>}
    </button>
  )
}

// Persistent Affinity-style options bar under the menu bar (full width, flush
// left). Shows tool-contextual controls (node-type conversions in direct-select,
// freehand settings, shape params, pathfinder, path ops) plus always-present
// default commands (align / distribute / flip / order / group).
function ApexOptionsBar(props: {
  tool: Tool; selCount: number; nodeMode: boolean; nodeSelCount: number
  activeAnchorType: AnchorType | null; setAnchorType: (t: AnchorType) => void; toolLabel: string
  align: (m: 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom') => void
  distribute: (a: 'h' | 'v') => void; flip: (a: 'h' | 'v') => void
  reorder: (m: 'front' | 'back' | 'forward' | 'backward') => void; rotate90: (d: 1 | -1) => void
  duplicateSel: () => void; groupSel: () => void; ungroupSel: () => void; t: TFunction
  context?: React.ReactNode
}) {
  const { nodeMode, nodeSelCount, activeAnchorType, setAnchorType, toolLabel, align, distribute, flip, reorder, rotate90, duplicateSel, groupSel, ungroupSel, t, context } = props
  const has = props.selCount >= 1, dist = props.selCount >= 3, grp = props.selCount >= 2
  const S = 15
  const iconBtn = (title: string, dis: boolean, cb: () => void, icon: React.ReactNode, flipX?: boolean) => (
    <button key={title} title={title} disabled={dis} onClick={cb}
      className="w-7 h-7 rounded flex items-center justify-center transition-colors flex-shrink-0"
      style={{ color: dis ? C.textDim : C.text, opacity: dis ? 0.4 : 1, cursor: dis ? 'default' : 'pointer', transform: flipX ? 'scaleX(-1)' : undefined }}
      onMouseEnter={e => { if (!dis) e.currentTarget.style.background = C.active }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}>
      {icon}
    </button>
  )
  const sep = (k: string) => <div key={k} className="w-px h-5 mx-1 flex-shrink-0" style={{ background: C.border }} />
  return (
    <div className="flex items-center gap-0.5 h-full px-2 overflow-x-auto" style={{ color: C.text }}>
      {nodeMode ? (
        <>
          <span className="text-[11px] font-medium mr-1 flex-shrink-0" style={{ color: C.textDim }}>
            {t('apex_node_type')}{nodeSelCount > 1 ? ` (${nodeSelCount})` : ''}
          </span>
          {([['sharp', t('apex_node_sharp')], ['smooth', t('apex_node_smooth')], ['symmetric', t('apex_node_symmetric')], ['smart', t('apex_node_smart')]] as [AnchorType, string][]).map(([type, label]) => {
            const active = activeAnchorType === type, off = nodeSelCount === 0
            return (
              <button key={type} title={off ? `${label} — ${t('apex_node_pick_hint')}` : label} disabled={off}
                onClick={() => setAnchorType(type)}
                className="h-7 px-2 rounded flex items-center gap-1.5 text-[11px] transition-colors flex-shrink-0"
                style={{ background: active ? C.accent : C.toolbar, color: active ? '#fff' : (off ? C.textDim : C.text), opacity: off ? 0.5 : 1, cursor: off ? 'default' : 'pointer' }}
                onMouseEnter={e => { if (!active && !off) e.currentTarget.style.background = C.active }}
                onMouseLeave={e => { if (!active && !off) e.currentTarget.style.background = C.toolbar }}>
                <NodeTypeIcon type={type} /><span>{label}</span>
              </button>
            )
          })}
        </>
      ) : (
        <span className="text-[11px] font-semibold mr-1 flex-shrink-0" style={{ color: C.textDim }}>{toolLabel}</span>
      )}
      {!nodeMode && context && <>{sep('sc')}{context}</>}
      {has && <>
        {sep('s0')}
        {iconBtn(t('apex_align_left'),     !has, () => align('left'),    <AlignLeft size={S} />)}
        {iconBtn(t('apex_align_center_h'), !has, () => align('hcenter'), <AlignCenter size={S} />)}
        {iconBtn(t('apex_align_right'),    !has, () => align('right'),   <AlignRight size={S} />)}
        {iconBtn(t('apex_align_top'),      !has, () => align('top'),     <AlignStartVertical size={S} />)}
        {iconBtn(t('apex_align_center_v'), !has, () => align('vcenter'), <AlignCenterVertical size={S} />)}
        {iconBtn(t('apex_align_bottom'),   !has, () => align('bottom'),  <AlignEndVertical size={S} />)}
        {sep('s1')}
        {iconBtn(t('apex_distribute_h'), !dist, () => distribute('h'), <AlignHorizontalDistributeCenter size={S} />)}
        {iconBtn(t('apex_distribute_v'), !dist, () => distribute('v'), <AlignVerticalDistributeCenter size={S} />)}
        {sep('s2')}
        {iconBtn(t('apex_flip_h'), !has, () => flip('h'), <FlipHorizontal size={S} />)}
        {iconBtn(t('apex_flip_v'), !has, () => flip('v'), <FlipVertical size={S} />)}
        {iconBtn(t('apex_rotate_ccw'), !has, () => rotate90(-1), <RotateCw size={S} />, true)}
        {iconBtn(t('apex_rotate_cw'),  !has, () => rotate90(1),  <RotateCw size={S} />)}
        {sep('s3')}
        {iconBtn(t('apex_bring_front'), !has, () => reorder('front'), <BringToFront size={S} />)}
        {iconBtn(t('apex_send_back'),   !has, () => reorder('back'),  <SendToBack size={S} />)}
        {sep('s4')}
        {iconBtn(t('apex_group'),     !grp, groupSel,     <Group size={S} />)}
        {iconBtn(t('apex_ungroup'),   !has, ungroupSel,   <Ungroup size={S} />)}
        {iconBtn(t('apex_duplicate'), !has, duplicateSel, <Copy size={S} />)}
      </>}
    </div>
  )
}

function ElementThumb({ el }: { el: VectorElement }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    const c2d = cv.getContext('2d')
    if (!c2d) return
    const dpr = window.devicePixelRatio || 1
    const S = 18 * dpr
    cv.width = S; cv.height = S
    c2d.clearRect(0, 0, S, S)
    const b = elBBox(el)
    if (b.w <= 0 && b.h <= 0) return
    const pad = 2 * dpr
    const scale = Math.min((S - pad * 2) / Math.max(1, b.w), (S - pad * 2) / Math.max(1, b.h))
    c2d.save()
    c2d.translate(S / 2 - (b.x + b.w / 2) * scale, S / 2 - (b.y + b.h / 2) * scale)
    c2d.scale(scale, scale)
    // Strip the blend mode: against the thumb's transparent backdrop a mode
    // like `multiply` would render nothing.
    paintElement(c2d, el.blend ? { ...el, blend: undefined } as VectorElement : el, 1, scale, false)
    c2d.restore()
  }, [el])
  return <canvas ref={ref} className="mx-1 flex-shrink-0"
    style={{ width: 18, height: 18, borderRadius: 3, background: 'rgba(255,255,255,0.08)' }} />
}

function LayerRow({
  el, depth, selected, isGroup, collapsed, renaming, renameDraft, dnd,
  onToggleCollapse, onSelect, onStartRename, onRenameDraft, onCommitRename,
  onToggleVisible, onToggleLock, onContextMenuRow,
  onDragStartRow, onDragOverRow, onDropRow, onDragEndRow,
}: {
  el: VectorElement; depth: number; selected: boolean; isGroup: boolean
  collapsed: boolean; renaming: boolean; renameDraft: string
  dnd: 'before' | 'after' | 'inside' | null
  onToggleCollapse: () => void
  onSelect: (e: React.MouseEvent) => void
  onStartRename: () => void; onRenameDraft: (v: string) => void; onCommitRename: () => void
  onToggleVisible: (e: React.MouseEvent) => void; onToggleLock: () => void
  onContextMenuRow: (e: React.MouseEvent) => void
  onDragStartRow: () => void
  onDragOverRow: (e: React.DragEvent) => void
  onDropRow: (e: React.DragEvent) => void
  onDragEndRow: () => void
}) {
  const GroupIcon = collapsed ? Folder : FolderOpen

  return (
    <div
      draggable
      onDragStart={onDragStartRow}
      onDragOver={onDragOverRow}
      onDrop={onDropRow}
      onDragEnd={onDragEndRow}
      onClick={onSelect}
      onDoubleClick={e => { e.stopPropagation(); onStartRename() }}
      onContextMenu={onContextMenuRow}
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
      {el.type === 'symmetry'
        ? <svg width="12" height="12" viewBox="0 0 16 16" className="mx-1 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
            <line x1="8" y1="1.5" x2="8" y2="14.5" strokeDasharray="2 1.6" />
            <path d="M6 4.5 L2.5 8 L6 11.5" fill="currentColor" stroke="none" />
            <path d="M10 4.5 L13.5 8 L10 11.5" fill="none" />
          </svg>
        : isGroup ? <GroupIcon size={12} className="mx-1 flex-shrink-0" /> : <ElementThumb el={el} />}
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
        <button onClick={e => { e.stopPropagation(); onToggleVisible(e) }} className={`p-0.5 rounded ${el.visible ? 'opacity-0 group-hover:opacity-100' : ''}`}>
          {el.visible ? <Eye size={10} /> : <EyeOff size={10} style={{ opacity: 0.5 }} />}
        </button>
        <button onClick={e => { e.stopPropagation(); onToggleLock() }} className={`p-0.5 rounded ${el.locked ? '' : 'opacity-0 group-hover:opacity-100'}`}>
          {el.locked ? <Lock size={10} style={{ color: '#e84a90' }} /> : <Unlock size={10} />}
        </button>
      </div>
    </div>
  )
}

// ── Export dialog (Illustrator-style: live preview left, options right) ─────────
interface ExportScale { s: number; suffix: string }
interface ExportOpts {
  format: 'svg' | 'png' | 'jpeg' | 'webp' | 'pdf'
  scope: 'selection' | 'page' | 'pages' | 'document'
  pagesSpec: string                                   // "1,3-5"
  scales: ExportScale[]                               // raster: one output per scale
  quality: number                                     // jpeg/webp: 10..100
  background: 'transparent' | 'white' | 'artboard'
  dest: 'download' | 'drive'
  svgPrecision: number                                // SVG decimal places 0..4
  svgResponsive: boolean                              // SVG without fixed width/height
  prefix: string                                      // filename prefix
}
const EXPORT_DEFAULTS: ExportOpts = {
  format: 'png', scope: 'page', pagesSpec: '', scales: [{ s: 1, suffix: '' }],
  quality: 90, background: 'transparent', dest: 'download',
  svgPrecision: 3, svgResponsive: false, prefix: '',
}

// Zero-based indices → compact "1,3-5" spec (used by the thumbnail toggles).
function compressPagesSpec(list: number[]): string {
  const out: string[] = []
  for (let i = 0; i < list.length;) {
    let j = i
    while (j + 1 < list.length && list[j + 1] === list[j] + 1) j++
    out.push(j > i ? `${list[i] + 1}-${list[j] + 1}` : `${list[i] + 1}`)
    i = j + 1
  }
  return out.join(',')
}

// "1,3-5" → zero-based page indices, clamped and deduplicated.
function parsePagesSpec(spec: string, max: number): number[] {
  const out = new Set<number>()
  for (const part of spec.split(',')) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(part)
    if (!m) continue
    const a = parseInt(m[1]), b = m[2] ? parseInt(m[2]) : a
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) if (i >= 1 && i <= max) out.add(i - 1)
  }
  return [...out].sort((x, y) => x - y)
}

// Restrict a page to the export scope: selection keeps the subtree (orphans
// reparented to root) with a tight artboard; the background option overrides
// the artboard fill.
function scopeData(pd: VectorPageData, selection: string[] | null, bg: ExportOpts['background']): VectorPageData | null {
  let els = pd.elements
  let ab = pd.artboards[0] ?? { id: 'ab', name: '', x: 0, y: 0, width: 1000, height: 1000, background: '#ffffff' }
  if (selection) {
    const ids = new Set(selection)
    for (const id of selection) {
      const el = pd.elements.find(e => e.id === id)
      if (el && isContainer(el)) descendantIds(pd.elements, id).forEach(d => ids.add(d))
    }
    els = pd.elements.filter(e => ids.has(e.id))
      .map(e => e.parentId && !ids.has(e.parentId) ? { ...e, parentId: null } as VectorElement : e)
    const bb = selBBox(els.filter(e => !isContainer(e)))
    if (!bb) return null
    ab = { ...ab, x: bb.x, y: bb.y, width: Math.max(1, bb.w), height: Math.max(1, bb.h) }
  }
  const background = bg === 'transparent' ? 'transparent' : bg === 'white' ? '#ffffff'
    : (!ab.background || ab.background === 'transparent' ? '#ffffff' : ab.background)
  return { artboards: [{ ...ab, background }], elements: els, guides: [] }
}

function ApexExportDialog(props: {
  t: TFunction
  pageData: VectorPageData
  selectedIds: string[]
  pages: { id: string; name: string }[]
  currentPageIdx: number
  projectId: string | null
  title: string
  onClose: () => void
}) {
  const { t, onClose } = props
  const [opts, setOpts] = useState<ExportOpts>(() => {
    try { return { ...EXPORT_DEFAULTS, ...JSON.parse(localStorage.getItem('apex:export') || '{}') } }
    catch { return EXPORT_DEFAULTS }
  })
  const patch = useCallback((p: Partial<ExportOpts>) => {
    setOpts(prev => {
      const next = { ...prev, ...p }
      try { localStorage.setItem('apex:export', JSON.stringify(next)) } catch { /* quota */ }
      return next
    })
  }, [])
  const [preview, setPreview]   = useState<{ url: string; w: number; h: number; bytes: number } | null>(null)
  const [prevIdx, setPrevIdx]   = useState(0)     // position within the scoped page list
  const [busy, setBusy]         = useState(false)
  const [err, setErr]           = useState<string | null>(null)
  const [done, setDone]         = useState<string | null>(null)
  const [view, setView]         = useState({ z: 1, x: 0, y: 0 })
  const pageCacheRef = useRef(new Map<string, VectorPageData>())
  const seqRef       = useRef(0)
  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  const BOX = { w: 520, h: 400 }

  const hasSelection = props.selectedIds.length > 0
  const multiPage    = props.pages.length > 1

  const scopePages = useCallback((): number[] => {
    if (opts.scope === 'selection' || opts.scope === 'page') return [props.currentPageIdx]
    if (opts.scope === 'document') return props.pages.map((_, i) => i)
    return parsePagesSpec(opts.pagesSpec, props.pages.length)
  }, [opts.scope, opts.pagesSpec, props.currentPageIdx, props.pages])

  const getPage = useCallback(async (idx: number): Promise<VectorPageData | null> => {
    if (idx === props.currentPageIdx) return props.pageData
    const pg = props.pages[idx]
    if (!pg || !props.projectId) return null
    const hit = pageCacheRef.current.get(pg.id)
    if (hit) return hit
    const r = await apexApi.getPage(props.projectId, pg.id)
    const data = migrateGroups(r.data.data ?? makePage1())
    pageCacheRef.current.set(pg.id, data)
    return data
  }, [props.currentPageIdx, props.pageData, props.pages, props.projectId])

  // Page thumbnails for the Export-for-Screens-style picker strip (lazy, cached).
  useEffect(() => {
    if (props.pages.length < 2) return
    let stop = false
    ;(async () => {
      const { pageDataToSvg } = await import('./apexSvg')
      for (let i = 0; i < props.pages.length; i++) {
        if (stop) return
        const pg = props.pages[i]
        if (thumbs[pg.id]) continue
        const pd = await getPage(i)
        if (!pd) continue
        const scoped = scopeData(pd, null, 'artboard')
        if (!scoped) continue
        const ab = scoped.artboards[0]
        const svg = pageDataToSvg(scoped)
        const img = new Image()
        try {
          await new Promise<void>((res, rej) => {
            img.onload = () => res(); img.onerror = () => rej(new Error('thumb'))
            img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
          })
        } catch { continue }
        const s = 54 / ab.height
        const cv = document.createElement('canvas')
        cv.width = Math.max(1, Math.round(ab.width * s)); cv.height = 54
        cv.getContext('2d')!.drawImage(img, 0, 0, cv.width, cv.height)
        if (stop) return
        setThumbs(prev => ({ ...prev, [pg.id]: cv.toDataURL('image/png') }))
      }
    })()
    return () => { stop = true }
  }, [props.pages, getPage, thumbs])

  // Rasterise one scoped page to a canvas at the given scale.
  const rasterOne = useCallback(async (idx: number, scale: number): Promise<HTMLCanvasElement | null> => {
    const pd = await getPage(idx)
    if (!pd) return null
    const sel = opts.scope === 'selection' ? props.selectedIds : null
    if (sel && !sel.length) return null
    // JPEG and PDF embeds have no alpha channel: transparent becomes white.
    const noAlpha = opts.format === 'jpeg' || opts.format === 'pdf'
    const bg = noAlpha && opts.background === 'transparent' ? 'white' : opts.background
    const scoped = scopeData(pd, sel, bg)
    if (!scoped) return null
    const { pageDataToSvg } = await import('./apexSvg')
    const svg = pageDataToSvg(scoped)
    const ab = scoped.artboards[0]
    const img = new Image()
    await new Promise<void>((res, rej) => {
      img.onload = () => res()
      img.onerror = () => rej(new Error('raster'))
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
    })
    const cv = document.createElement('canvas')
    cv.width = Math.max(1, Math.round(ab.width * scale))
    cv.height = Math.max(1, Math.round(ab.height * scale))
    cv.getContext('2d')!.drawImage(img, 0, 0, cv.width, cv.height)
    return cv
  }, [getPage, opts, props.selectedIds])

  // Build one page of the export exactly as it will be written.
  const buildOne = useCallback(async (idx: number, scale: number): Promise<{ blob: Blob; w: number; h: number } | null> => {
    if (opts.format === 'svg') {
      const pd = await getPage(idx)
      if (!pd) return null
      const sel = opts.scope === 'selection' ? props.selectedIds : null
      if (sel && !sel.length) return null
      const scoped = scopeData(pd, sel, opts.background)
      if (!scoped) return null
      const { pageDataToSvg } = await import('./apexSvg')
      const svg = pageDataToSvg(scoped, { precision: opts.svgPrecision, responsive: opts.svgResponsive })
      const ab = scoped.artboards[0]
      return { blob: new Blob([svg], { type: 'image/svg+xml' }), w: Math.round(ab.width), h: Math.round(ab.height) }
    }
    const cv = await rasterOne(idx, scale)
    if (!cv) return null
    if (opts.format === 'pdf') {
      // Single-page preview only — the real export assembles ONE multi-page PDF.
      const blob = await new Promise<Blob | null>(res => cv.toBlob(res, 'image/png'))
      return blob ? { blob, w: cv.width, h: cv.height } : null
    }
    const mime = opts.format === 'png' ? 'image/png' : opts.format === 'jpeg' ? 'image/jpeg' : 'image/webp'
    const blob = await new Promise<Blob | null>(res => cv.toBlob(res, mime, opts.quality / 100))
    return blob ? { blob, w: cv.width, h: cv.height } : null
  }, [getPage, opts, props.selectedIds, rasterOne])

  // Assemble the scoped pages into one PDF (pages rasterised ×2 for quality,
  // PDF page size = artboard size in points).
  const buildPdf = useCallback(async (pages: number[]): Promise<Blob | null> => {
    const { PDFDocument } = await import('pdf-lib')
    const doc = await PDFDocument.create()
    for (const idx of pages) {
      const cv = await rasterOne(idx, 2)
      if (!cv) continue
      const png = await new Promise<Blob | null>(res => cv.toBlob(res, 'image/png'))
      if (!png) continue
      const embedded = await doc.embedPng(await png.arrayBuffer())
      const page = doc.addPage([cv.width / 2, cv.height / 2])
      page.drawImage(embedded, { x: 0, y: 0, width: cv.width / 2, height: cv.height / 2 })
    }
    if (!doc.getPageCount()) return null
    const bytes = await doc.save()
    return new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' })
  }, [rasterOne])

  // Live preview of the scoped page under the pager.
  useEffect(() => {
    const seq = ++seqRef.current
    const timer = setTimeout(() => {
      const pages = scopePages()
      if (!pages.length) { setPreview(null); setErr(t('apex_export_empty')); return }
      const idx = pages[Math.min(prevIdx, pages.length - 1)]
      buildOne(idx, opts.scales[0]?.s ?? 1)
        .then(r => {
          if (seqRef.current !== seq) return
          setPreview(prev => {
            if (prev) URL.revokeObjectURL(prev.url)
            return r ? { url: URL.createObjectURL(r.blob), w: r.w, h: r.h, bytes: r.blob.size } : null
          })
          setErr(r ? null : t('apex_export_empty'))
          if (r) {
            const z = Math.min(BOX.w / r.w, BOX.h / r.h, 1)
            setView({ z, x: (BOX.w - r.w * z) / 2, y: (BOX.h - r.h * z) / 2 })
          }
        })
        .catch(() => { if (seqRef.current === seq) { setPreview(null); setErr(t('apex_export_failed')) } })
    }, 250)
    return () => clearTimeout(timer)
  }, [buildOne, scopePages, prevIdx, t]) // eslint-disable-line react-hooks/exhaustive-deps

  const doExport = useCallback(async () => {
    if (busy) return
    setBusy(true); setErr(null); setDone(null)
    try {
      const pages = scopePages()
      if (!pages.length) { setErr(t('apex_export_empty')); return }
      const base = (opts.prefix + (props.title.trim() || 'apex')).replace(/[/\\:]+/g, '-')
      const save = async (blob: Blob, name: string) => {
        if (opts.dest === 'drive') {
          const { filesApi } = await import('@kubuno/drive')
          await filesApi.uploadFile(new File([blob], name, { type: blob.type }), null)
        } else {
          const a = document.createElement('a')
          a.href = URL.createObjectURL(blob)
          a.download = name
          a.click()
          setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
        }
      }
      let n = 0
      if (opts.format === 'pdf') {
        const blob = await buildPdf(pages)
        if (blob) { await save(blob, `${base}.pdf`); n = 1 }
      } else if (opts.format === 'svg') {
        for (const idx of pages) {
          const r = await buildOne(idx, 1)
          if (!r) continue
          await save(r.blob, `${base}${pages.length > 1 ? `-p${idx + 1}` : ''}.svg`)
          n++
        }
      } else {
        const ext = opts.format === 'jpeg' ? 'jpg' : opts.format
        for (const idx of pages) {
          for (const sc of opts.scales) {
            const r = await buildOne(idx, sc.s)
            if (!r) continue
            const suffix = (pages.length > 1 ? `-p${idx + 1}` : '')
              + (sc.suffix || (sc.s !== 1 ? `@${sc.s}x` : ''))
            await save(r.blob, `${base}${suffix}.${ext}`)
            n++
          }
        }
      }
      if (!n) { setErr(t('apex_export_empty')); return }
      if (opts.dest === 'drive') { setDone(t('apex_export_done_drive', { count: n })) }
      else onClose()
    } catch {
      setErr(t('apex_export_failed'))
    } finally {
      setBusy(false)
    }
  }, [busy, buildOne, buildPdf, scopePages, opts, props.title, onClose, t])

  const seg = <K extends string>(value: K, entries: [K, string, boolean?][], set: (v: K) => void) => (
    <div className="flex rounded overflow-hidden" style={{ border: `1px solid ${C.border}` }}>
      {entries.map(([v, label, disabled]) => (
        <button key={v} onClick={() => !disabled && set(v)} disabled={disabled}
          className="flex-1 px-2 py-1 text-[11px] transition-colors disabled:opacity-40"
          style={{ background: value === v ? C.accent + '30' : 'transparent', color: value === v ? C.accent : C.textDim }}>
          {label}
        </button>
      ))}
    </div>
  )
  const label = (txt: string) => <span className="text-[11px]" style={{ color: C.textDim }}>{txt}</span>

  const isRaster = opts.format !== 'svg' && opts.format !== 'pdf'
  const nPages = scopePages().length
  const nFiles = opts.format === 'pdf' ? Math.min(1, nPages) : isRaster ? nPages * opts.scales.length : nPages
  const onWheel = (e: React.WheelEvent) => {
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const mx = e.clientX - box.left, my = e.clientY - box.top
    setView(v => {
      const z = Math.min(16, Math.max(0.02, v.z * (e.deltaY < 0 ? 1.2 : 1 / 1.2)))
      return { z, x: mx - (mx - v.x) * (z / v.z), y: my - (my - v.y) * (z / v.z) }
    })
  }
  const onDown = (e: React.PointerEvent) => {
    const start = { px: e.clientX, py: e.clientY }
    const v0 = view
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent) => setView({ ...v0, x: v0.x + ev.clientX - start.px, y: v0.y + ev.clientY - start.py })
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up) }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.45)' }} onClick={onClose}>
      <div className="rounded-xl shadow-2xl" style={{ background: C.panel, border: `1px solid ${C.border}`, width: 960, maxWidth: 'calc(100vw - 40px)' }}
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center px-4 py-2.5" style={{ borderBottom: `1px solid ${C.border}` }}>
          <span className="flex-1 text-center text-[13px] font-semibold" style={{ color: C.text }}>{t('apex_export_title')}</span>
          <button onClick={onClose} className="w-6 h-6 rounded flex items-center justify-center hover:bg-white/10" style={{ color: C.textDim }}>✕</button>
        </div>
        <div className="flex items-stretch">
          {/* Preview pane (left, as in the reference mock) */}
          <div className="flex flex-col gap-2 px-4 py-3" style={{ flexShrink: 0 }}>
            <div className="flex items-center gap-2" style={{ width: BOX.w }}>
              <span className="flex-1 text-[11px] truncate" style={{ color: C.textDim }}>
                {t('apex_trace_preview')}
                {preview && (
                  <span className="ml-2 tabular-nums" style={{ opacity: 0.8 }}>
                    {preview.w}×{preview.h}px · {preview.bytes > 1024 * 1024 ? `${(preview.bytes / 1048576).toFixed(1)} Mo` : `${Math.max(1, Math.round(preview.bytes / 1024))} Ko`}
                  </span>
                )}
              </span>
              {nPages > 1 && (
                <span className="flex items-center gap-1 text-[11px] tabular-nums" style={{ color: C.textDim }}>
                  <button onClick={() => setPrevIdx(i => Math.max(0, i - 1))} className="w-5 h-5 rounded hover:bg-white/10">‹</button>
                  {Math.min(prevIdx, nPages - 1) + 1}/{nPages}
                  <button onClick={() => setPrevIdx(i => Math.min(nPages - 1, i + 1))} className="w-5 h-5 rounded hover:bg-white/10">›</button>
                </span>
              )}
              <button onClick={() => {
                if (!preview) return
                const z = Math.min(BOX.w / preview.w, BOX.h / preview.h, 1)
                setView({ z, x: (BOX.w - preview.w * z) / 2, y: (BOX.h - preview.h * z) / 2 })
              }} className="px-2 h-6 rounded text-[11px] hover:bg-white/10" style={{ color: C.textDim, border: `1px solid ${C.border}` }}>
                {t('apex_fit')}
              </button>
            </div>
            <div className="relative rounded overflow-hidden select-none" onWheel={onWheel} onPointerDown={onDown}
              style={{
                width: BOX.w, height: BOX.h, cursor: 'grab', touchAction: 'none',
                backgroundImage: 'conic-gradient(#3a3a3a 0 25%, #2e2e2e 0 50%, #3a3a3a 0 75%, #2e2e2e 0)',
                backgroundSize: '16px 16px', border: `1px solid ${C.border}`,
              }}>
              {preview && (
                <img src={preview.url} alt="" draggable={false}
                  style={{
                    position: 'absolute', left: 0, top: 0, width: preview.w, height: preview.h,
                    transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})`,
                    transformOrigin: '0 0', imageRendering: view.z > 3 ? 'pixelated' : undefined, maxWidth: 'none',
                  }} />
              )}
            </div>
            {/* Page picker strip (Export-for-Screens style): thumbnails with
                checkboxes in "pages" scope; click previews the page. */}
            {multiPage && (
              <div className="flex gap-2 overflow-x-auto pb-1" style={{ width: BOX.w }}>
                {props.pages.map((pg, i) => {
                  const scoped = scopePages()
                  const pos = scoped.indexOf(i)
                  const inScope = pos >= 0
                  const toggle = () => {
                    if (opts.scope !== 'pages') return
                    const cur = parsePagesSpec(opts.pagesSpec, props.pages.length)
                    const next = cur.includes(i) ? cur.filter(x => x !== i) : [...cur, i].sort((a, b) => a - b)
                    patch({ pagesSpec: compressPagesSpec(next) })
                  }
                  return (
                    <div key={pg.id} className="relative flex flex-col items-center gap-0.5 flex-shrink-0 cursor-pointer"
                      onClick={() => { if (inScope) setPrevIdx(pos); else toggle() }}>
                      <div className="rounded overflow-hidden flex items-center justify-center"
                        style={{
                          width: 76, height: 56, background: '#ffffff',
                          border: `2px solid ${inScope ? C.accent : C.border}`,
                          opacity: inScope ? 1 : 0.55,
                        }}>
                        {thumbs[pg.id] && <img src={thumbs[pg.id]} alt="" draggable={false} style={{ maxWidth: '100%', maxHeight: '100%' }} />}
                      </div>
                      {opts.scope === 'pages' && (
                        <input type="checkbox" checked={inScope} onChange={toggle} onClick={e => e.stopPropagation()}
                          className="absolute top-0.5 left-0.5" style={{ accentColor: C.accent }} />
                      )}
                      <span className="text-[10px] max-w-[76px] truncate" style={{ color: C.textDim }}>{i + 1} · {pg.name}</span>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
          {/* Options (right) */}
          <div className="flex flex-col gap-3 px-4 py-3" style={{ borderLeft: `1px solid ${C.border}`, flex: 1, minWidth: 0 }}>
            <div className="flex flex-col gap-1">
              {label(t('apex_export_format'))}
              {seg(opts.format, [['svg', 'SVG'], ['png', 'PNG'], ['jpeg', 'JPEG'], ['webp', 'WebP'], ['pdf', 'PDF']], v => patch({ format: v }))}
            </div>
            <div className="flex flex-col gap-1">
              {label(t('apex_export_scope'))}
              <div className="grid grid-cols-2 gap-1.5">
                {seg(opts.scope, [['selection', t('apex_export_scope_selection'), !hasSelection], ['page', t('apex_export_scope_page')]], v => patch({ scope: v }))}
                {seg(opts.scope, [['pages', t('apex_export_scope_pages'), !multiPage], ['document', t('apex_export_scope_document'), !multiPage]], v => patch({ scope: v }))}
              </div>
            </div>
            {opts.scope === 'pages' && (
              <input value={opts.pagesSpec} onChange={e => patch({ pagesSpec: e.target.value })}
                placeholder={t('apex_export_pages_hint')}
                className="px-2 py-1 rounded text-[12px] outline-none"
                style={{ background: '#2c2c2c', border: `1px solid ${C.border}`, color: C.text }} />
            )}
            {isRaster && (
              <div className="flex flex-col gap-1">
                <div className="grid gap-1.5 text-[11px]" style={{ gridTemplateColumns: '90px 1fr 20px', color: C.textDim }}>
                  <span>{t('apex_export_scale')}</span><span>{t('apex_export_suffix')}</span><span />
                  {opts.scales.map((sc, i) => (
                    <Fragment key={i}>
                      <select value={sc.s}
                        onChange={e => patch({ scales: opts.scales.map((x, k) => k === i ? { ...x, s: Number(e.target.value) } : x) })}
                        className="px-1.5 py-1 rounded text-[12px] outline-none"
                        style={{ background: '#2c2c2c', border: `1px solid ${C.border}`, color: C.text }}>
                        {[0.5, 1, 2, 3, 4].map(v => <option key={v} value={v}>×{v}</option>)}
                      </select>
                      <input value={sc.suffix}
                        placeholder={sc.s !== 1 ? `@${sc.s}x` : t('apex_export_suffix_none')}
                        onChange={e => patch({ scales: opts.scales.map((x, k) => k === i ? { ...x, suffix: e.target.value } : x) })}
                        className="px-2 py-1 rounded text-[12px] outline-none"
                        style={{ background: '#2c2c2c', border: `1px solid ${C.border}`, color: C.text }} />
                      <button onClick={() => patch({ scales: opts.scales.filter((_, k) => k !== i) })}
                        disabled={opts.scales.length < 2}
                        className="w-5 self-center rounded hover:bg-white/10 disabled:opacity-30 text-[13px]"
                        style={{ color: C.textDim }}>✕</button>
                    </Fragment>
                  ))}
                </div>
                {opts.scales.length < 4 && (
                  <button onClick={() => {
                    const next = [2, 3, 4, 0.5].find(v => !opts.scales.some(x => x.s === v)) ?? 2
                    patch({ scales: [...opts.scales, { s: next, suffix: `@${next}x` }] })
                  }}
                    className="px-2 py-1 rounded text-[11px] hover:bg-white/10"
                    style={{ border: `1px dashed ${C.border}`, color: C.textDim }}>
                    + {t('apex_export_add_scale')}
                  </button>
                )}
              </div>
            )}
            {opts.format === 'svg' && (
              <>
                <div className="flex flex-col gap-1">
                  {label(t('apex_export_precision'))}
                  {seg<string>(String(opts.svgPrecision), [['0', '0'], ['1', '1'], ['2', '2'], ['3', '3'], ['4', '4']], v => patch({ svgPrecision: Number(v) }))}
                </div>
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input type="checkbox" checked={opts.svgResponsive} onChange={e => patch({ svgResponsive: e.target.checked })}
                    style={{ accentColor: C.accent }} />
                  <span className="text-[12px]" style={{ color: C.text }}>{t('apex_export_responsive')}</span>
                </label>
              </>
            )}
            {(opts.format === 'jpeg' || opts.format === 'webp') && (
              <div className="flex flex-col gap-1">
                {label(t('apex_export_quality'))}
                <div className="flex items-center gap-2">
                  <RangeSlider min={10} max={100} step={1} className="flex-1" value={opts.quality}
                    onChange={v => patch({ quality: v })} accent={C.accent} trackColor="rgba(255,255,255,0.15)"
                    aria-label={t('apex_export_quality')} />
                  <span className="w-8 text-right text-[12px] tabular-nums" style={{ color: C.text }}>{opts.quality}</span>
                </div>
                <div className="flex justify-between text-[10px]" style={{ color: C.textDim, opacity: 0.75 }}>
                  <span>{t('apex_export_quality_small')}</span><span>{t('apex_export_quality_large')}</span>
                </div>
              </div>
            )}
            <div className="flex flex-col gap-1">
              {label(t('apex_export_background'))}
              {seg(opts.background, [
                ['transparent', t('apex_export_bg_transparent'), opts.format === 'jpeg'],
                ['white', t('apex_export_bg_white')],
                ['artboard', t('apex_export_bg_artboard')],
              ], v => patch({ background: v }))}
            </div>
            <div className="flex flex-col gap-1">
              {label(t('apex_export_dest'))}
              {seg(opts.dest, [['download', t('apex_export_dest_download')], ['drive', 'Drive']], v => patch({ dest: v }))}
            </div>
            <div className="flex items-center gap-2">
              {label(t('apex_export_prefix'))}
              <input value={opts.prefix} onChange={e => patch({ prefix: e.target.value })}
                className="flex-1 px-2 py-1 rounded text-[12px] outline-none"
                style={{ background: '#2c2c2c', border: `1px solid ${C.border}`, color: C.text }} />
            </div>
            <div className="text-[11px]" style={{ color: C.textDim }}>
              {t('apex_export_summary', { pages: nPages, count: nFiles })}
            </div>
            {err && <div className="text-[12px]" style={{ color: '#f87171' }}>{err}</div>}
            {done && <div className="text-[12px]" style={{ color: '#4ade80' }}>{done}</div>}
          </div>
        </div>
        <div className="flex items-center gap-2 px-4 py-2.5" style={{ borderTop: `1px solid ${C.border}` }}>
          <div style={{ flex: 1 }} />
          <button onClick={() => { void doExport() }} disabled={busy}
            className="h-8 px-4 rounded text-[12px] font-medium hover:brightness-110 disabled:opacity-60"
            style={{ background: C.accent, color: '#fff' }}>
            {busy ? '…' : t('apex_export_do')}
          </button>
          <button onClick={onClose} className="h-8 px-4 rounded text-[12px] hover:brightness-110"
            style={{ background: C.toolbar, color: C.text, border: `1px solid ${C.border}` }}>{t('common_cancel')}</button>
        </div>
      </div>
    </div>
  )
}
