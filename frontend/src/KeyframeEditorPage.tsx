import {
  useRef, useState, useEffect, useCallback, useLayoutEffect, memo,
} from 'react'
import { useTranslation } from 'react-i18next'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Play, Pause, SkipBack, SkipForward, ChevronLeft, ChevronRight,
  Repeat, Download, ZoomIn, ZoomOut, Plus, Eye, EyeOff,
  Trash2, ChevronDown, ChevronRight as ChevronRightIcon,
  MousePointer, Square, Type, Image as ImageIcon, Layers, GripVertical,
} from 'lucide-react'
import clsx from 'clsx'
import { keyframeApi, type AnimData, type AnimLayer, type AnimProperty, type AnimKeyframe, type EasingDef } from './api'
import { Dropdown } from '@ui'
import { useFilesDialogStore } from '@kubuno/drive'
import { C as SHELL_C, EditorShell, DockArea, paintsharpMenus, useContextMenu, type CtxItem } from './ui'
import { useDebouncedAutosave } from './useAutosave'

const C = SHELL_C   // shared Paintsharp palette for the editor chrome

// ─────────────────────────────────────────────────────────────────────────────
// Interpolation engine
// ─────────────────────────────────────────────────────────────────────────────

function lerp(a: number, b: number, t: number): number { return a + (b - a) * t }

function cubicBezierX(cx1: number, cx2: number, u: number): number {
  return 3 * cx1 * u * (1 - u) ** 2 + 3 * cx2 * u * u * (1 - u) + u * u * u
}
function cubicBezierY(cy1: number, cy2: number, u: number): number {
  return 3 * cy1 * u * (1 - u) ** 2 + 3 * cy2 * u * u * (1 - u) + u * u * u
}
function cubicBezierDx(cx1: number, cx2: number, u: number): number {
  return 3 * cx1 * (1 - u) ** 2 - 6 * cx1 * u * (1 - u) + 3 * cx2 * (2 * u - 3 * u * u) + 3 * u * u
}
function solveBezierT(cx1: number, cx2: number, t: number): number {
  let u = t
  for (let i = 0; i < 8; i++) {
    const x = cubicBezierX(cx1, cx2, u) - t
    const d = cubicBezierDx(cx1, cx2, u)
    if (Math.abs(d) < 1e-6) break
    u -= x / d
    u = Math.max(0, Math.min(1, u))
  }
  return u
}

function applyEasing(easing: EasingDef, t: number): number {
  if (easing.type === 'linear') return t
  if (easing.type === 'hold')   return 0
  if (easing.type === 'spring') return t
  const { cx1, cy1, cx2, cy2 } = easing
  const u = solveBezierT(cx1, cx2, t)
  return cubicBezierY(cy1, cy2, u)
}

function interpolateNum(prop: AnimProperty<number>, frame: number): number {
  const kfs = prop.keyframes
  if (kfs.length === 0) return prop.staticValue
  if (frame <= kfs[0].frame) return kfs[0].value
  if (frame >= kfs[kfs.length - 1].frame) return kfs[kfs.length - 1].value
  let i = 0
  while (i < kfs.length - 1 && kfs[i + 1].frame <= frame) i++
  const a = kfs[i], b = kfs[i + 1]
  const t = (frame - a.frame) / (b.frame - a.frame)
  if (a.interpolation === 'hold') return a.value
  if (a.interpolation === 'linear') return lerp(a.value, b.value, t)
  const eased = applyEasing(a.easing, t)
  return lerp(a.value, b.value, eased)
}

function interpolateStr(prop: AnimProperty<string>, frame: number): string {
  const kfs = prop.keyframes
  if (kfs.length === 0) return prop.staticValue
  if (frame <= kfs[0].frame) return kfs[0].value
  return kfs[kfs.length - 1].value
}

// ─────────────────────────────────────────────────────────────────────────────
// Scene renderer (Canvas 2D)
// ─────────────────────────────────────────────────────────────────────────────

class SceneRenderer {
  private ctx:    CanvasRenderingContext2D
  private width:  number
  private height: number
  private dpr:    number
  private imgCache = new Map<string, HTMLImageElement>()

  constructor(canvas: HTMLCanvasElement, w: number, h: number) {
    this.dpr    = Math.min(window.devicePixelRatio || 1, 2)
    this.width  = w
    this.height = h
    canvas.width  = w * this.dpr
    canvas.height = h * this.dpr
    canvas.style.width  = `${w}px`
    canvas.style.height = `${h}px`
    this.ctx = canvas.getContext('2d')!
    this.ctx.scale(this.dpr, this.dpr)
  }

  render(anim: AnimData, frame: number, bg: string, selectedId?: string | null, onionFrames?: number[]): void {
    const ctx = this.ctx
    ctx.clearRect(0, 0, this.width, this.height)
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, this.width, this.height)

    // Pelure d'oignon : frames voisines en fantôme.
    if (onionFrames && onionFrames.length) {
      for (const of of onionFrames) {
        if (of === frame || of < 0) continue
        const ghosts = [...anim.layers].filter(l => l.visible && of >= l.inPoint && of < l.outPoint).reverse()
        ctx.save()
        ctx.globalAlpha = 0.22
        for (const layer of ghosts) this.drawLayerTransformed(layer, of, ctx)
        ctx.restore()
      }
    }

    const visible = [...anim.layers]
      .filter(l => l.visible && frame >= l.inPoint && frame < l.outPoint)
      .reverse()

    for (const layer of visible) this.drawLayerTransformed(layer, frame, ctx)

    // Cadre de sélection (espace monde, pour une épaisseur de trait constante).
    if (selectedId) {
      const layer = anim.layers.find(l => l.id === selectedId)
      if (layer && frame >= layer.inPoint && frame < layer.outPoint) {
        const { w, h } = kfLayerSize(layer, frame)
        const corners = [[0, 0], [w, 0], [w, h], [0, h]].map(([lx, ly]) => kfLocalToWorld(layer, frame, lx, ly))
        ctx.save()
        ctx.globalAlpha = 1
        ctx.strokeStyle = '#4a90e8'; ctx.lineWidth = 1.5; ctx.setLineDash([5, 3])
        ctx.beginPath()
        ctx.moveTo(corners[0].x, corners[0].y)
        for (let i = 1; i < 4; i++) ctx.lineTo(corners[i].x, corners[i].y)
        ctx.closePath(); ctx.stroke()
        ctx.setLineDash([])
        // 8 poignées de redimensionnement.
        ctx.fillStyle = '#fff'; ctx.strokeStyle = '#4a90e8'; ctx.lineWidth = 1.5
        for (const hp of kfHandleWorld(layer, frame)) { ctx.beginPath(); ctx.rect(hp.x - 4, hp.y - 4, 8, 8); ctx.fill(); ctx.stroke() }
        ctx.restore()
      }
    }
  }

  // Dessine un calque avec sa transformation complète (réutilisé par la pelure d'oignon).
  private drawLayerTransformed(layer: AnimLayer, frame: number, ctx: CanvasRenderingContext2D): void {
    ctx.save()
    const px  = interpolateNum(layer.properties.positionX, frame)
    const py  = interpolateNum(layer.properties.positionY, frame)
    const rot = interpolateNum(layer.properties.rotation, frame) * Math.PI / 180
    const sx  = interpolateNum(layer.properties.scaleX, frame)
    const sy  = interpolateNum(layer.properties.scaleY, frame)
    const ax  = interpolateNum(layer.properties.anchorX, frame)
    const ay  = interpolateNum(layer.properties.anchorY, frame)
    const op  = interpolateNum(layer.properties.opacity, frame)
    ctx.globalAlpha *= op / 100
    ctx.translate(px, py)
    ctx.rotate(rot)
    ctx.scale(sx, sy)
    ctx.translate(-ax, -ay)
    this.renderLayer(layer, frame, ctx)
    ctx.restore()
  }

  private renderLayer(layer: AnimLayer, frame: number, ctx: CanvasRenderingContext2D): void {
    const d = layer.data

    if (d.type === 'solid' || d.type === 'shape') {
      const fill = layer.properties.fillColor
        ? interpolateStr(layer.properties.fillColor, frame) : '#ffffff'
      const sw   = layer.properties.strokeWidth
        ? interpolateNum(layer.properties.strokeWidth, frame) : 0
      const stroke = layer.properties.strokeColor
        ? interpolateStr(layer.properties.strokeColor, frame) : null

      ctx.beginPath()
      if (d.type === 'solid') {
        ctx.rect(0, 0, d.width, d.height)
      } else if (d.shape === 'rect') {
        const r = d.cornerRadius ?? 0
        if (r > 0) ctx.roundRect(0, 0, d.width, d.height, r)
        else       ctx.rect(0, 0, d.width, d.height)
      } else if (d.shape === 'ellipse') {
        ctx.ellipse(d.width / 2, d.height / 2, d.width / 2, d.height / 2, 0, 0, Math.PI * 2)
      }
      ctx.fillStyle = fill
      ctx.fill()
      if (stroke && sw > 0) {
        ctx.strokeStyle = stroke
        ctx.lineWidth   = sw
        ctx.stroke()
      }
    } else if (d.type === 'text') {
      const fontSize = layer.properties.fontSize
        ? interpolateNum(layer.properties.fontSize, frame) : d.fontSize
      const fill = layer.properties.fillColor
        ? interpolateStr(layer.properties.fillColor, frame) : '#ffffff'
      ctx.font         = `${d.fontWeight} ${fontSize}px "${d.fontFamily}", sans-serif`
      ctx.fillStyle    = fill
      ctx.textAlign    = d.textAlign as CanvasTextAlign
      ctx.textBaseline = 'top'
      ctx.fillText(d.content, 0, 0)
    } else if (d.type === 'image' || d.type === 'vector') {
      const src = (d as any).storagePath as string | undefined
      if (!src) return
      let img = this.imgCache.get(src)
      if (!img) {
        img = new Image()
        img.src = src
        img.onload = () => this.imgCache.set(src, img!)
        this.imgCache.set(src, img)
      }
      if (img.complete && img.naturalWidth > 0) {
        ctx.drawImage(img, 0, 0, d.width, d.height)
      }
    }
  }
}

// ── Hit-testing & transforms sur la scène (édition directe au canevas) ────────
function kfNum(prop: AnimProperty<number> | undefined, frame: number, def = 0): number {
  return prop ? interpolateNum(prop, frame) : def
}
function kfLayerSize(layer: AnimLayer, frame: number): { w: number; h: number } {
  const d = layer.data as { type: string; width?: number; height?: number; content?: string; fontSize?: number }
  if (d.type === 'text') {
    const fs = kfNum(layer.properties.fontSize as AnimProperty<number> | undefined, frame, d.fontSize ?? 32)
    return { w: Math.max(20, (d.content?.length ?? 4) * fs * 0.55), h: fs * 1.25 }
  }
  return { w: d.width ?? 100, h: d.height ?? 100 }
}
// local (lx,ly) → world, suivant T(px,py)·R·S·T(-ax,-ay)
function kfLocalToWorld(layer: AnimLayer, frame: number, lx: number, ly: number): { x: number; y: number } {
  const px = kfNum(layer.properties.positionX, frame), py = kfNum(layer.properties.positionY, frame)
  const rot = kfNum(layer.properties.rotation, frame) * Math.PI / 180
  const sx = kfNum(layer.properties.scaleX, frame, 1), sy = kfNum(layer.properties.scaleY, frame, 1)
  const ax = kfNum(layer.properties.anchorX, frame), ay = kfNum(layer.properties.anchorY, frame)
  let x = (lx - ax) * sx, y = (ly - ay) * sy
  const c = Math.cos(rot), s = Math.sin(rot)
  return { x: px + (c * x - s * y), y: py + (s * x + c * y) }
}
// world → local (inverse de la transformation ci-dessus)
function kfWorldToLocal(layer: AnimLayer, frame: number, wx: number, wy: number): { x: number; y: number } {
  const px = kfNum(layer.properties.positionX, frame), py = kfNum(layer.properties.positionY, frame)
  const rot = kfNum(layer.properties.rotation, frame) * Math.PI / 180
  const sx = kfNum(layer.properties.scaleX, frame, 1) || 1e-6, sy = kfNum(layer.properties.scaleY, frame, 1) || 1e-6
  const ax = kfNum(layer.properties.anchorX, frame), ay = kfNum(layer.properties.anchorY, frame)
  let x = wx - px, y = wy - py
  const c = Math.cos(-rot), s = Math.sin(-rot)
  ;[x, y] = [c * x - s * y, s * x + c * y]
  return { x: x / sx + ax, y: y / sy + ay }
}
function kfHitLayer(layer: AnimLayer, frame: number, wx: number, wy: number): boolean {
  const { w, h } = kfLayerSize(layer, frame)
  const p = kfWorldToLocal(layer, frame, wx, wy)
  return p.x >= 0 && p.x <= w && p.y >= 0 && p.y <= h
}

// Poignées de redimensionnement (8, dans l'ordre nw,n,ne,e,se,s,sw,w) en coords
// locales [0,0]-[w,h], + l'index de la poignée opposée (ancre du redimensionnement).
const KF_OPPOSITE = [4, 5, 6, 7, 0, 1, 2, 3]
function kfHandleLocals(w: number, h: number): [number, number][] {
  return [[0, 0], [w / 2, 0], [w, 0], [w, h / 2], [w, h], [w / 2, h], [0, h], [0, h / 2]]
}
function kfHandleWorld(layer: AnimLayer, frame: number): { x: number; y: number }[] {
  const { w, h } = kfLayerSize(layer, frame)
  return kfHandleLocals(w, h).map(([lx, ly]) => kfLocalToWorld(layer, frame, lx, ly))
}

// ─────────────────────────────────────────────────────────────────────────────
// Easing presets
// ─────────────────────────────────────────────────────────────────────────────

const EASING_PRESETS: Array<{ id: string; labelKey: string; preset: EasingDef }> = [
  { id: 'linear',     labelKey: 'keyframe_easing_linear',     preset: { type: 'cubic-bezier', cx1: 0.0,  cy1: 0.0,  cx2: 1.0,  cy2: 1.0 } },
  { id: 'ease',       labelKey: 'keyframe_easing_ease',       preset: { type: 'cubic-bezier', cx1: 0.25, cy1: 0.1,  cx2: 0.25, cy2: 1.0 } },
  { id: 'ease_in',    labelKey: 'keyframe_easing_ease_in',    preset: { type: 'cubic-bezier', cx1: 0.42, cy1: 0.0,  cx2: 1.0,  cy2: 1.0 } },
  { id: 'ease_out',   labelKey: 'keyframe_easing_ease_out',   preset: { type: 'cubic-bezier', cx1: 0.0,  cy1: 0.0,  cx2: 0.58, cy2: 1.0 } },
  { id: 'ease_inout', labelKey: 'keyframe_easing_ease_inout', preset: { type: 'cubic-bezier', cx1: 0.42, cy1: 0.0,  cx2: 0.58, cy2: 1.0 } },
  { id: 'back',       labelKey: 'keyframe_easing_back',       preset: { type: 'cubic-bezier', cx1: 0.34, cy1: 1.56, cx2: 0.64, cy2: 1.0 } },
  { id: 'hold',       labelKey: 'keyframe_easing_hold',       preset: { type: 'hold' } },
]

// ─────────────────────────────────────────────────────────────────────────────
// Property keys & labels
// ─────────────────────────────────────────────────────────────────────────────

const PROP_KEYS: Array<{ key: keyof AnimLayer['properties']; labelKey: string; step: number; fmt: (v: number | string) => string }> = [
  { key: 'positionX',  labelKey: 'keyframe_prop_position_x', step: 1,    fmt: v => `${Number(v).toFixed(1)}` },
  { key: 'positionY',  labelKey: 'keyframe_prop_position_y', step: 1,    fmt: v => `${Number(v).toFixed(1)}` },
  { key: 'rotation',   labelKey: 'keyframe_prop_rotation',   step: 0.5,  fmt: v => `${Number(v).toFixed(1)}°` },
  { key: 'scaleX',     labelKey: 'keyframe_prop_scale_x',    step: 0.01, fmt: v => `${Number(v).toFixed(3)}` },
  { key: 'scaleY',     labelKey: 'keyframe_prop_scale_y',    step: 0.01, fmt: v => `${Number(v).toFixed(3)}` },
  { key: 'opacity',    labelKey: 'keyframe_prop_opacity',    step: 1,    fmt: v => `${Number(v).toFixed(0)}%` },
]

// ─────────────────────────────────────────────────────────────────────────────
// TransportBar
// ─────────────────────────────────────────────────────────────────────────────

function TransportBar({
  frame, totalFrames, fps, isPlaying, looping,
  onFrameChange, onPlayPause, onFpsChange, onToggleLoop,
}: {
  frame: number; totalFrames: number; fps: number; isPlaying: boolean; looping: boolean
  onFrameChange: (f: number) => void
  onPlayPause: () => void
  onFpsChange: (fps: number) => void
  onToggleLoop: () => void
}) {
  const { t } = useTranslation('paintsharp')
  const curTime = (frame / fps).toFixed(2)
  const T = (totalFrames / fps).toFixed(2)
  return (
    <>
      {/* Transport */}
      <button onClick={() => onFrameChange(0)} className="text-[#9e9e9e] hover:text-white p-0.5">
        <SkipBack size={13} />
      </button>
      <button onClick={() => onFrameChange(Math.max(0, frame - 1))} className="text-[#9e9e9e] hover:text-white p-0.5">
        <ChevronLeft size={13} />
      </button>
      <button
        onClick={onPlayPause}
        className={clsx(
          'w-7 h-6 flex items-center justify-center rounded transition-colors',
          isPlaying ? 'bg-[#e8824a] text-white' : 'bg-[#333] text-[#e0e0e0] hover:bg-[#444]'
        )}
      >
        {isPlaying ? <Pause size={13} /> : <Play size={13} />}
      </button>
      <button onClick={() => onFrameChange(Math.min(totalFrames - 1, frame + 1))} className="text-[#9e9e9e] hover:text-white p-0.5">
        <ChevronRight size={13} />
      </button>
      <button onClick={() => onFrameChange(totalFrames - 1)} className="text-[#9e9e9e] hover:text-white p-0.5">
        <SkipForward size={13} />
      </button>

      {/* Frame counter */}
      <div className="flex items-center gap-1 text-[11px] ml-1">
        <span className="text-[#7a7a7a]">{t('keyframe_frame_short')}</span>
        <input
          type="number" min={0} max={totalFrames - 1} value={frame}
          onChange={e => onFrameChange(Math.max(0, Math.min(totalFrames - 1, +e.target.value)))}
          className="w-12 h-5 text-center rounded text-[11px] border outline-none"
          style={{ background: '#2c2c2c', borderColor: '#3a3a3a', color: '#e0e0e0' }}
          onFocus={e => e.target.select()}
        />
        <span style={{ color: '#5a5a5a' }}>/ {totalFrames}</span>
        <span style={{ color: '#5a5a5a' }} className="mx-0.5">—</span>
        <span style={{ color: '#9e9e9e' }} className="font-mono">{curTime}s</span>
        <span style={{ color: '#5a5a5a' }}>/ {T}s</span>
      </div>

      {/* FPS */}
      <div className="flex items-center gap-1 ml-1">
        <span className="text-[10px]" style={{ color: '#7a7a7a' }}>FPS</span>
        <Dropdown
          variant="dark"
          value={String(fps)}
          onChange={v => onFpsChange(+v)}
          height={20}
          fontSize={10}
          options={[12, 15, 24, 25, 30, 60].map(f => ({ value: String(f), label: String(f) }))}
        />
      </div>

      <button onClick={onToggleLoop} title={t('keyframe_loop')} className="p-0.5" style={{ color: looping ? '#e8824a' : '#7a7a7a' }}>
        <Repeat size={13} />
      </button>
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Graph editor
// ─────────────────────────────────────────────────────────────────────────────

function GraphEditor({ kf, onApplyPreset }: {
  kf: AnimKeyframe<number> | null
  onApplyPreset: (preset: EasingDef) => void
}) {
  const { t } = useTranslation('paintsharp')
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    const W = canvas.width, H = canvas.height

    ctx.fillStyle = '#161616'
    ctx.fillRect(0, 0, W, H)

    ctx.strokeStyle = '#2a2a2a'
    ctx.lineWidth   = 0.5
    for (let i = 1; i < 4; i++) {
      ctx.beginPath(); ctx.moveTo(i * W / 4, 0); ctx.lineTo(i * W / 4, H)
      ctx.moveTo(0, i * H / 4); ctx.lineTo(W, i * H / 4); ctx.stroke()
    }

    ctx.strokeStyle = '#2e2e2e'
    ctx.lineWidth   = 1
    ctx.beginPath(); ctx.moveTo(0, H); ctx.lineTo(W, 0); ctx.stroke()

    const easing: EasingDef = kf?.easing ?? { type: 'cubic-bezier', cx1: 0.42, cy1: 0, cx2: 0.58, cy2: 1 }
    const { cx1 = 0.42, cy1 = 0, cx2 = 0.58, cy2 = 1 } =
      easing.type === 'cubic-bezier' ? easing : { cx1: 0, cy1: 0, cx2: 1, cy2: 1 }

    ctx.strokeStyle = '#e8824a'
    ctx.lineWidth   = 2
    ctx.beginPath()
    ctx.moveTo(0, H)
    ctx.bezierCurveTo(cx1 * W, (1 - cy1) * H, cx2 * W, (1 - cy2) * H, W, 0)
    ctx.stroke()

    ;([[0, H], [W, 0]] as [number, number][]).forEach(([x, y]) => {
      ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2)
      ctx.fillStyle = '#fff'; ctx.strokeStyle = '#e8824a'; ctx.lineWidth = 1.5
      ctx.fill(); ctx.stroke()
    })

    const handles: [number, number][] = [[cx1 * W, (1 - cy1) * H], [cx2 * W, (1 - cy2) * H]]
    const anchors: [number, number][] = [[0, H], [W, 0]]
    handles.forEach(([hx, hy], i) => {
      ctx.beginPath(); ctx.moveTo(anchors[i][0], anchors[i][1]); ctx.lineTo(hx, hy)
      ctx.strokeStyle = '#555'; ctx.lineWidth = 1; ctx.stroke()
      ctx.beginPath(); ctx.arc(hx, hy, 4, 0, Math.PI * 2)
      ctx.fillStyle = '#e8824a'; ctx.fill()
    })
  }, [kf])

  return (
    <div className="border-t flex-shrink-0" style={{ borderColor: '#333', background: '#1a1a1a', height: 116 }}>
      <div className="flex items-center px-2 h-7 border-b gap-1" style={{ borderColor: '#2a2a2a' }}>
        <span className="text-[10px] mr-1" style={{ color: '#7a7a7a' }}>{t('keyframe_easing')}</span>
        {EASING_PRESETS.map(({ id, labelKey, preset }) => (
          <button key={id} onClick={() => onApplyPreset(preset)}
                  className="px-1.5 h-5 text-[9px] rounded transition-colors"
                  style={{ color: '#9e9e9e', background: 'transparent' }}
                  onMouseEnter={e => (e.currentTarget.style.background = '#333')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
            {t(labelKey)}
          </button>
        ))}
      </div>
      <div className="flex gap-2 p-2">
        <canvas ref={canvasRef} width={96} height={80}
                className="rounded border" style={{ borderColor: '#333' }} />
        <div className="flex flex-col gap-1 text-[9px]" style={{ color: '#7a7a7a' }}>
          {kf && <>
            <span>{t('keyframe_frame_label', { frame: kf.frame })}</span>
            <span>{t('keyframe_value_label', { value: typeof kf.value === 'number' ? kf.value.toFixed(2) : kf.value })}</span>
            <span style={{ color: '#5a5a5a' }}>
              {kf.easing.type === 'cubic-bezier'
                ? `bezier(${kf.easing.cx1.toFixed(2)}, ${kf.easing.cy1.toFixed(2)}, ${kf.easing.cx2.toFixed(2)}, ${kf.easing.cy2.toFixed(2)})`
                : kf.easing.type}
            </span>
          </>}
          {!kf && <span>{t('keyframe_select_keyframe')}</span>}
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Keyframe diamond
// ─────────────────────────────────────────────────────────────────────────────

const KfDiamond = memo(function KfDiamond({
  kf, pxPerFrame, duration, isSelected, onSelect, onMove,
}: {
  kf: AnimKeyframe<number>; pxPerFrame: number; duration: number
  isSelected: boolean
  onSelect: (id: string, multi: boolean) => void
  onMove:   (id: string, frame: number) => void
}) {
  const { t } = useTranslation('paintsharp')
  const handleMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation()
    onSelect(kf.id, e.ctrlKey || e.metaKey)
    const startX = e.clientX, startFrame = kf.frame
    const onMove_ = (ev: MouseEvent) => {
      const dx = ev.clientX - startX
      onMove(kf.id, Math.round(Math.max(0, Math.min(duration, startFrame + dx / pxPerFrame))))
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove_)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove_)
    document.addEventListener('mouseup', onUp)
  }

  return (
    <div
      onMouseDown={handleMouseDown}
      title={t('keyframe_diamond_tooltip', { frame: kf.frame, value: typeof kf.value === 'number' ? kf.value.toFixed(2) : kf.value })}
      className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-2.5 h-2.5 rotate-45 cursor-ew-resize"
      style={{
        left:            kf.frame * pxPerFrame,
        background:      isSelected ? '#fff' : '#e8824a',
        border:          `1px solid ${isSelected ? '#e8824a' : '#c0622e'}`,
        zIndex:          isSelected ? 10 : 5,
      }}
    />
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// Timeline track (for one property)
// ─────────────────────────────────────────────────────────────────────────────

function PropTrack({
  kfs, pxPerFrame, duration, selectedIds,
  onSelect, onMove,
}: {
  kfs: AnimKeyframe<number>[]
  pxPerFrame: number; duration: number
  selectedIds: Set<string>
  onSelect: (id: string, multi: boolean) => void
  onMove:   (id: string, frame: number) => void
}) {
  return (
    <div className="relative h-7 border-b" style={{ borderColor: '#2a2a2a' }}>
      <div className="absolute inset-0" style={{ background: '#1a1a1a' }} />
      {kfs.map(kf => (
        <KfDiamond
          key={kf.id}
          kf={kf}
          pxPerFrame={pxPerFrame}
          duration={duration}
          isSelected={selectedIds.has(kf.id)}
          onSelect={onSelect}
          onMove={onMove}
        />
      ))}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer row in timeline
// ─────────────────────────────────────────────────────────────────────────────

function LayerTrackRow({
  layer, pxPerFrame, duration, selectedKfIds, expanded,
  onSelect, onMove,
}: {
  layer: AnimLayer; pxPerFrame: number; duration: number
  selectedKfIds: Set<string>; expanded: boolean
  onSelect: (id: string, multi: boolean) => void
  onMove:   (id: string, frame: number) => void
}) {
  return (
    <>
      {/* Summary track */}
      <div className="relative h-8 border-b" style={{ borderColor: '#2a2a2a', background: '#1e1e1e' }}>
        {PROP_KEYS.map(({ key }) => {
          const prop = layer.properties[key] as AnimProperty<number> | undefined
          if (!prop) return null
          return prop.keyframes.map(kf => (
            <KfDiamond
              key={kf.id}
              kf={kf}
              pxPerFrame={pxPerFrame}
              duration={duration}
              isSelected={selectedKfIds.has(kf.id)}
              onSelect={onSelect}
              onMove={onMove}
            />
          ))
        })}
      </div>
      {/* Per-property tracks */}
      {expanded && PROP_KEYS.map(({ key }) => {
        const prop = layer.properties[key] as AnimProperty<number> | undefined
        if (!prop) return null
        return (
          <PropTrack
            key={key}
            kfs={prop.keyframes}
            pxPerFrame={pxPerFrame}
            duration={duration}
            selectedIds={selectedKfIds}
            onSelect={onSelect}
            onMove={onMove}
          />
        )
      })}
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Timeline header (ruler)
// ─────────────────────────────────────────────────────────────────────────────

function TimelineRuler({ duration, fps, pxPerFrame, scrollX, onScrub }: {
  duration: number; fps: number; pxPerFrame: number; scrollX: number
  onScrub: (frame: number) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    const W = canvas.width, H = canvas.height

    ctx.clearRect(0, 0, W, H)
    ctx.fillStyle = '#252525'
    ctx.fillRect(0, 0, W, H)

    const startFrame = Math.floor(scrollX / pxPerFrame)
    const endFrame   = Math.ceil((scrollX + W) / pxPerFrame)
    const step       = pxPerFrame < 3 ? fps * 5 : pxPerFrame < 8 ? fps : Math.ceil(fps / 6)

    ctx.fillStyle   = '#7a7a7a'
    ctx.strokeStyle = '#3a3a3a'
    ctx.lineWidth   = 0.5
    ctx.font        = '9px monospace'
    ctx.textBaseline = 'top'

    for (let f = startFrame; f <= endFrame; f++) {
      if (f % step !== 0) continue
      const x = f * pxPerFrame - scrollX
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke()
      if (f % (step * 2) === 0 || step === 1) {
        ctx.fillText(fps > 0 ? `${(f / fps).toFixed(1)}s` : `${f}`, x + 2, 2)
      }
    }
  }, [duration, fps, pxPerFrame, scrollX])

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x    = e.clientX - rect.left + scrollX
    onScrub(Math.round(Math.max(0, Math.min(duration - 1, x / pxPerFrame))))
  }

  return (
    <canvas
      ref={canvasRef}
      width={2000}
      height={24}
      className="cursor-col-resize"
      style={{ width: '100%', height: 24, display: 'block' }}
      onClick={handleClick}
    />
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Playhead
// ─────────────────────────────────────────────────────────────────────────────

function Playhead({ frame, pxPerFrame, scrollX, height }: {
  frame: number; pxPerFrame: number; scrollX: number; height: number
}) {
  const left = frame * pxPerFrame - scrollX
  if (left < 0 || left > 4000) return null
  return (
    <div className="absolute top-0 pointer-events-none z-20" style={{ left, height }}>
      <div className="absolute top-0 left-1/2 -translate-x-px w-px h-full"
           style={{ background: '#e8824a', opacity: 0.85 }} />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Properties panel
// ─────────────────────────────────────────────────────────────────────────────

function PropertiesPanel({
  layer, frame, onUpdateProp, onToggleKeyframe,
}: {
  layer: AnimLayer | null; frame: number
  onUpdateProp: (layerId: string, key: string, value: number) => void
  onToggleKeyframe: (layerId: string, key: string, frame: number, currentValue: number) => void
}) {
  const { t } = useTranslation('paintsharp')
  if (!layer) {
    return (
      <div className="flex items-center justify-center h-full text-[11px]" style={{ color: '#5a5a5a' }}>
        {t('keyframe_select_layer')}
      </div>
    )
  }

  return (
    <div className="overflow-y-auto h-full text-[11px]" style={{ color: '#e0e0e0' }}>
      <div className="px-3 py-2 border-b" style={{ borderColor: '#2a2a2a' }}>
        <p className="text-[10px] font-medium" style={{ color: '#9e9e9e' }}>{t('keyframe_layer_caps')}</p>
        <p className="truncate">{layer.name}</p>
      </div>
      <div className="px-2 py-2">
        <p className="text-[9px] mb-2 px-1" style={{ color: '#7a7a7a' }}>{t('keyframe_transform_caps')}</p>
        {PROP_KEYS.map(({ key, labelKey, step, fmt }) => {
          const prop = layer.properties[key] as AnimProperty<number> | undefined
          if (!prop) return null
          const currentVal = interpolateNum(prop, frame)
          const hasKf      = prop.keyframes.some(k => k.frame === frame)

          return (
            <div key={key} className="flex items-center h-7 px-1 gap-1 group hover:bg-[#2a2a2a] rounded">
              <span className="w-20 text-[10px] truncate flex-shrink-0" style={{ color: '#9e9e9e' }}>
                {t(labelKey)}
              </span>
              <input
                type="number"
                step={step}
                value={parseFloat(currentVal.toFixed(4))}
                onChange={e => onUpdateProp(layer.id, key, +e.target.value)}
                className="flex-1 min-w-0 h-5 text-right text-[10px] rounded border px-1 outline-none"
                style={{ background: '#2c2c2c', borderColor: '#3a3a3a', color: '#e0e0e0' }}
              />
              <span className="w-6 text-[9px] text-right flex-shrink-0" style={{ color: '#7a7a7a' }}>
                {fmt(currentVal).replace(/[\d.-]+/, '')}
              </span>
              <button
                onClick={() => onToggleKeyframe(layer.id, key, frame, currentVal)}
                title={hasKf ? t('keyframe_remove_keyframe') : t('keyframe_create_keyframe')}
                className="w-4 h-4 flex items-center justify-center flex-shrink-0 rounded"
                style={{ color: hasKf ? '#e8824a' : '#5a5a5a' }}
              >
                ◆
              </button>
            </div>
          )
        })}
        {layer.properties.fillColor && (
          <div className="flex items-center h-7 px-1 gap-1 mt-1">
            <span className="w-20 text-[10px] flex-shrink-0" style={{ color: '#9e9e9e' }}>{t('keyframe_color')}</span>
            <input
              type="color"
              value={interpolateStr(layer.properties.fillColor, frame)}
              onChange={() => { /* color keyframe editing: future */ }}
              className="w-8 h-5 rounded cursor-pointer border"
              style={{ borderColor: '#3a3a3a' }}
            />
          </div>
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Main editor
// ─────────────────────────────────────────────────────────────────────────────

export default function KeyframeEditorPage() {
  const { t } = useTranslation('paintsharp')
  const { id }  = useParams<{ id: string }>()
  const navigate = useNavigate()

  // ── Server state ──────────────────────────────────────────────────────────
  const { data: anim, isLoading } = useQuery({
    queryKey: ['paintsharp-animation', id],
    queryFn:  () => keyframeApi.getAnimation(id!).then(r => r.data),
    enabled:  !!id,
  })

  const saveMut = useMutation({
    mutationFn: (d: AnimData) => keyframeApi.saveData(id!, d),
  })

  const qc = useQueryClient()

  // ── Titre éditable (standard WorkspaceShell) — synchronisé depuis l'animation ─
  // NB : les animations n'ont pas de champ `is_starred` (modèle/API sans favoris)
  // → pas d'étoile pour Keyframe (comme Motion).
  const [titleDraft, setTitleDraft] = useState('')
  useEffect(() => { if (anim?.title != null) setTitleDraft(anim.title) }, [anim?.title])
  const renameMut = useMutation({
    mutationFn: (title: string) => keyframeApi.updateAnimation(id!, { title }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['paintsharp-animation', id] }) },
  })
  const trashMut = useMutation({
    mutationFn: () => keyframeApi.trashAnimation(id!),
    onSuccess: () => { navigate('/paintsharp/keyframe') },
  })
  const commitTitle = () => {
    const v = titleDraft.trim()
    if (v && v !== anim?.title) renameMut.mutate(v)
    else if (!v && anim?.title) setTitleDraft(anim.title)
  }

  // ── Local animation state ─────────────────────────────────────────────────
  const [animData, setAnimData] = useState<AnimData | null>(null)
  const [comp, setComp]         = useState({ width: 720, height: 480, fps: 24, duration_frames: 120, background: '#1a1a2e', pixelRatio: 1 })

  // Autosave fiable (debounce + flush au démontage/fermeture) — complète les
  // sauvegardes event-driven existantes pour ne rien perdre.
  useDebouncedAutosave(animData, !!id && !!animData, (d) => { if (d) saveMut.mutate(d) })

  useEffect(() => {
    if (!anim) return
    setAnimData(anim.anim_data)
    setComp(c => ({ ...c, ...anim.composition }))
  }, [anim])

  // ── Playback ──────────────────────────────────────────────────────────────
  const [frame,     setFrame]     = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [looping,   setLooping]   = useState(true)
  const rafRef  = useRef<number>(0)
  const lastRef = useRef<number>(0)
  const accRef  = useRef<number>(0)

  useEffect(() => {
    if (!isPlaying) { cancelAnimationFrame(rafRef.current); return }
    const tick = (now: number) => {
      if (lastRef.current) {
        accRef.current += (now - lastRef.current) / 1000
        const fpp = 1 / comp.fps
        while (accRef.current >= fpp) {
          accRef.current -= fpp
          setFrame(f => {
            const next = f + 1
            if (next >= comp.duration_frames) return looping ? 0 : comp.duration_frames - 1
            return next
          })
        }
      }
      lastRef.current = now
      rafRef.current  = requestAnimationFrame(tick)
    }
    lastRef.current = 0
    accRef.current  = 0
    rafRef.current  = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [isPlaying, looping, comp.fps, comp.duration_frames])

  const handlePlayPause = () => setIsPlaying(p => !p)

  // ── Canvas rendering ──────────────────────────────────────────────────────
  const canvasRef    = useRef<HTMLCanvasElement>(null)
  const rendererRef  = useRef<SceneRenderer | null>(null)
  const renderSizeRef = useRef<string>('')
  const containerRef = useRef<HTMLDivElement>(null)
  const [sceneScale, setSceneScale] = useState(1)
  // Zoom / panoramique de la zone de travail (façon Layer).
  const [viewZoom, setViewZoom] = useState(1)
  const [viewPan,  setViewPan]  = useState({ x: 0, y: 0 })
  const zoomRef = useRef(1); useEffect(() => { zoomRef.current = viewZoom }, [viewZoom])
  const panDragRef = useRef<{ x: number; y: number; px: number; py: number } | null>(null)
  const resetView = useCallback(() => { setViewZoom(1); setViewPan({ x: 0, y: 0 }) }, [])
  const zoomAt = useCallback((factor: number, clientX?: number, clientY?: number) => {
    const cont = containerRef.current; if (!cont) return
    const r = cont.getBoundingClientRect()
    const cx = clientX ?? r.left + r.width / 2, cy = clientY ?? r.top + r.height / 2
    const nz = Math.max(0.1, Math.min(8, zoomRef.current * factor))
    const k = nz / zoomRef.current
    setViewZoom(nz)
    setViewPan(p => ({ x: k * p.x + (1 - k) * (cx - (r.left + r.width / 2)), y: k * p.y + (1 - k) * (cy - (r.top + r.height / 2)) }))
  }, [])

  // Molette : Ctrl/⌘ = zoom (centré curseur), sinon panoramique.
  useEffect(() => {
    const cont = containerRef.current; if (!cont) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      if (e.ctrlKey || e.metaKey) zoomAt(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX, e.clientY)
      else setViewPan(p => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }))
    }
    cont.addEventListener('wheel', onWheel, { passive: false })
    return () => cont.removeEventListener('wheel', onWheel)
  }, [zoomAt])


  useEffect(() => {
    if (!canvasRef.current || !containerRef.current) return
    const ro = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect
      const sx = (width  - 40) / comp.width
      const sy = (height - 40) / comp.height
      setSceneScale(Math.min(sx, sy, 1))
    })
    ro.observe(containerRef.current)
    return () => ro.disconnect()
  }, [comp.width, comp.height])

  // ── Selection ─────────────────────────────────────────────────────────────
  const [selectedLayerId, setSelectedLayerId] = useState<string | null>(null)
  const [selectedKfIds,   setSelectedKfIds]   = useState<Set<string>>(new Set())
  const [expandedLayers,  setExpandedLayers]  = useState<Set<string>>(new Set())
  // Édition directe sur la scène.
  const [tool,    setTool]    = useState<'select' | 'rectangle' | 'text'>('select')
  const [autoKey, setAutoKey] = useState(false)   // enregistre un keyframe à chaque modif
  const [onion,   setOnion]   = useState(false)   // pelure d'oignon

  // Crée le renderer paresseusement (le canevas est garanti monté une fois
  // animData chargé) et le recrée si la taille de composition change ; sinon
  // le canevas restait à 300×150 quand le canvasRef n'était pas prêt au montage.
  useLayoutEffect(() => {
    if (!canvasRef.current || !animData) return
    const key = `${comp.width}x${comp.height}`
    if (!rendererRef.current || renderSizeRef.current !== key) {
      rendererRef.current = new SceneRenderer(canvasRef.current, comp.width, comp.height)
      renderSizeRef.current = key
    }
    rendererRef.current.render(animData, frame, comp.background, selectedLayerId, onion ? [frame - 2, frame - 1, frame + 1, frame + 2] : undefined)
  }, [animData, frame, comp.background, comp.width, comp.height, selectedLayerId, onion])

  const selectedLayer = animData?.layers.find(l => l.id === selectedLayerId) ?? null
  const firstSelectedKf = selectedLayer
    ? PROP_KEYS.flatMap(({ key }) => {
        const prop = selectedLayer.properties[key] as AnimProperty<number> | undefined
        return prop?.keyframes.filter(k => selectedKfIds.has(k.id)) ?? []
      })[0] ?? null
    : null

  const selectKf = (id: string, multi: boolean) => {
    setSelectedKfIds(prev => {
      if (multi) {
        const next = new Set(prev)
        next.has(id) ? next.delete(id) : next.add(id)
        return next
      }
      return new Set([id])
    })
  }

  // ── Timeline scroll ───────────────────────────────────────────────────────
  const [tlZoom,    setTlZoom]   = useState(1)
  const [tlScrollX, setTlScrollX] = useState(0)
  const PX_PER_FRAME = 4 * tlZoom
  const tlBodyRef    = useRef<HTMLDivElement>(null)
  const layerListRef = useRef<HTMLDivElement>(null)

  const syncScroll = (e: React.UIEvent<HTMLDivElement>) => {
    setTlScrollX(e.currentTarget.scrollLeft)
    if (layerListRef.current) {
      layerListRef.current.scrollTop = e.currentTarget.scrollTop
    }
  }
  const syncScrollLeft = (e: React.UIEvent<HTMLDivElement>) => {
    if (tlBodyRef.current) {
      tlBodyRef.current.scrollTop = e.currentTarget.scrollTop
    }
  }

  // ── Keyframe editing ──────────────────────────────────────────────────────
  const updateAnimData = useCallback((updater: (d: AnimData) => AnimData) => {
    setAnimData(prev => {
      if (!prev) return prev
      const next = updater(prev)
      saveMut.mutate(next)
      return next
    })
  }, [saveMut])

  const handleKfMove = useCallback((kfId: string, newFrame: number) => {
    updateAnimData(d => ({
      ...d,
      layers: d.layers.map(l => ({
        ...l,
        properties: Object.fromEntries(
          Object.entries(l.properties).map(([k, p]) => {
            const prop = p as AnimProperty<number>
            return [k, {
              ...prop,
              keyframes: prop.keyframes.map((kf: AnimKeyframe<number>) =>
                kf.id === kfId ? { ...kf, frame: newFrame } : kf
              ).sort((a: AnimKeyframe<number>, b: AnimKeyframe<number>) => a.frame - b.frame),
            }]
          })
        ) as unknown as AnimLayer['properties'],
      })),
    }))
  }, [updateAnimData])

  const handleToggleKeyframe = useCallback((
    layerId: string, propKey: string, atFrame: number, currentVal: number
  ) => {
    updateAnimData(d => ({
      ...d,
      layers: d.layers.map(l => {
        if (l.id !== layerId) return l
        const prop = l.properties[propKey as keyof typeof l.properties] as AnimProperty<number>
        if (!prop) return l
        const existing = prop.keyframes.findIndex(k => k.frame === atFrame)
        const newKfs = existing >= 0
          ? prop.keyframes.filter((_, i) => i !== existing)
          : [...prop.keyframes, {
              id:            crypto.randomUUID(),
              frame:         atFrame,
              value:         currentVal,
              interpolation: 'bezier' as const,
              easing:        { type: 'cubic-bezier' as const, cx1: 0.42, cy1: 0, cx2: 0.58, cy2: 1 },
              handleIn:      { x: 0, y: 0 },
              handleOut:     { x: 0, y: 0 },
            }].sort((a, b) => a.frame - b.frame)

        return {
          ...l,
          properties: {
            ...l.properties,
            [propKey]: { ...prop, keyframes: newKfs },
          },
        }
      }),
    }))
  }, [updateAnimData])

  const handleApplyEasingPreset = useCallback((preset: EasingDef) => {
    if (selectedKfIds.size === 0) return
    updateAnimData(d => ({
      ...d,
      layers: d.layers.map(l => ({
        ...l,
        properties: Object.fromEntries(
          Object.entries(l.properties).map(([k, p]) => {
            const prop = p as AnimProperty<number>
            return [k, {
              ...prop,
              keyframes: prop.keyframes.map((kf: AnimKeyframe<number>) =>
                selectedKfIds.has(kf.id) ? { ...kf, easing: preset } : kf
              ),
            }]
          })
        ) as unknown as AnimLayer['properties'],
      })),
    }))
  }, [selectedKfIds, updateAnimData])

  const handleUpdateProp = useCallback((layerId: string, propKey: string, value: number) => {
    updateAnimData(d => ({
      ...d,
      layers: d.layers.map(l => {
        if (l.id !== layerId) return l
        const prop = l.properties[propKey as keyof typeof l.properties] as AnimProperty<number>
        if (!prop) return l
        const hasKf = prop.keyframes.some(k => k.frame === frame)
        return {
          ...l,
          properties: {
            ...l.properties,
            [propKey]: hasKf
              ? {
                  ...prop,
                  keyframes: prop.keyframes.map(k =>
                    k.frame === frame ? { ...k, value } : k
                  ),
                }
              : { ...prop, staticValue: value },
          },
        }
      }),
    }))
  }, [updateAnimData, frame])

  const handleAddLayer = useCallback(() => {
    const id = crypto.randomUUID()
    const make = (v: number): AnimProperty<number> => ({ staticValue: v, keyframes: [] })
    const newLayer: AnimLayer = {
      id, type: 'shape', name: t('keyframe_new_layer'),
      parentId: null, inPoint: 0, outPoint: comp.duration_frames,
      solo: false, locked: false, visible: true, blendMode: 'normal',
      data: { type: 'shape', shape: 'rect', width: 100, height: 100, cornerRadius: 0 },
      effects: [],
      properties: {
        positionX:   make(comp.width / 2 - 50),
        positionY:   make(comp.height / 2 - 50),
        rotation:    make(0),
        scaleX:      make(1),
        scaleY:      make(1),
        opacity:     make(100),
        anchorX:     make(0),
        anchorY:     make(0),
        fillColor:   { staticValue: '#4a90e8', keyframes: [] } as AnimProperty<string>,
        strokeWidth: make(0),
        strokeColor: { staticValue: 'transparent', keyframes: [] } as AnimProperty<string>,
      },
    }
    updateAnimData(d => ({ ...d, layers: [newLayer, ...d.layers] }))
    setSelectedLayerId(id)
  }, [updateAnimData, comp, t])

  const handleImportImage = useCallback(async () => {
    const file = await useFilesDialogStore.getState().openFile({
      title: t('keyframe_import_image'),
      acceptMimes: ['image/*'],
    })
    if (!file) return
    const layerId = crypto.randomUUID()
    const make    = (v: number): AnimProperty<number> => ({ staticValue: v, keyframes: [] })
    const imgUrl  = `/api/v1/drive/${file.id}/download`
    const newLayer: AnimLayer = {
      id: layerId, type: 'image', name: file.name,
      parentId: null, inPoint: 0, outPoint: comp.duration_frames,
      solo: false, locked: false, visible: true, blendMode: 'normal',
      data: { type: 'image', assetId: file.id, width: 400, height: 300, storagePath: imgUrl } as unknown as AnimLayer['data'],
      effects: [],
      properties: {
        positionX:   make(comp.width  / 2 - 200),
        positionY:   make(comp.height / 2 - 150),
        rotation:    make(0),
        scaleX:      make(1),
        scaleY:      make(1),
        opacity:     make(100),
        anchorX:     make(0),
        anchorY:     make(0),
      },
    }
    // Load image to get actual dimensions
    const img = document.createElement('img')
    img.onload = () => {
      const w = img.naturalWidth  || 400
      const h = img.naturalHeight || 300
      const layer: AnimLayer = {
        ...newLayer,
        data: { type: 'image', assetId: file.id, width: w, height: h, storagePath: imgUrl } as unknown as AnimLayer['data'],
        properties: {
          ...newLayer.properties,
          positionX: make(comp.width  / 2 - w / 2),
          positionY: make(comp.height / 2 - h / 2),
        },
      }
      updateAnimData(d => ({ ...d, layers: [layer, ...d.layers] }))
      setSelectedLayerId(layerId)
    }
    img.onerror = () => {
      updateAnimData(d => ({ ...d, layers: [newLayer, ...d.layers] }))
      setSelectedLayerId(layerId)
    }
    img.src = imgUrl
  }, [updateAnimData, comp, t])

  const handleToggleVisible = useCallback((layerId: string) => {
    updateAnimData(d => ({
      ...d,
      layers: d.layers.map(l =>
        l.id === layerId ? { ...l, visible: !l.visible } : l
      ),
    }))
  }, [updateAnimData])

  const handleDeleteLayer = useCallback((layerId: string) => {
    updateAnimData(d => ({ ...d, layers: d.layers.filter(l => l.id !== layerId) }))
    if (selectedLayerId === layerId) setSelectedLayerId(null)
  }, [updateAnimData, selectedLayerId])

  // ── Réorganisation des calques (glisser-déposer dans la liste) ──────────────
  const dragLayerRef = useRef<string | null>(null)
  const [dragOverLayer, setDragOverLayer] = useState<string | null>(null)
  const handleReorderLayer = useCallback((dragId: string, targetId: string, after: boolean) => {
    if (dragId === targetId) return
    updateAnimData(d => {
      const arr = [...d.layers]
      const from = arr.findIndex(l => l.id === dragId)
      if (from < 0) return d
      const [moved] = arr.splice(from, 1)
      let to = arr.findIndex(l => l.id === targetId)
      if (to < 0) return d
      if (after) to += 1
      arr.splice(to, 0, moved)
      return { ...d, layers: arr }
    })
  }, [updateAnimData])

  const duplicateLayer = useCallback((layerId: string) => {
    updateAnimData(d => {
      const idx = d.layers.findIndex(l => l.id === layerId)
      if (idx < 0) return d
      const copy = { ...structuredClone(d.layers[idx]), id: crypto.randomUUID(), name: `${d.layers[idx].name} copy` }
      const arr = [...d.layers]; arr.splice(idx, 0, copy)
      return { ...d, layers: arr }
    })
  }, [updateAnimData])

  const moveLayer = useCallback((layerId: string, dir: -1 | 1) => {
    updateAnimData(d => {
      const i = d.layers.findIndex(l => l.id === layerId)
      const j = i + dir
      if (i < 0 || j < 0 || j >= d.layers.length) return d
      const arr = [...d.layers];[arr[i], arr[j]] = [arr[j], arr[i]]
      return { ...d, layers: arr }
    })
  }, [updateAnimData])

  // ── Menu contextuel (clic droit sur un calque) ─────────────────────────────
  const ctx = useContextMenu()
  const onLayerContextMenu = useCallback((e: React.MouseEvent, layer: AnimLayer) => {
    setSelectedLayerId(layer.id)
    const idx = animData?.layers.findIndex(l => l.id === layer.id) ?? -1
    const last = (animData?.layers.length ?? 1) - 1
    const items: CtxItem[] = [
      { label: t('apex_duplicate'), onClick: () => duplicateLayer(layer.id), shortcut: 'Ctrl+D' },
      { label: layer.visible ? t('vertex_ctx_hide') : t('vertex_ctx_show'), onClick: () => handleToggleVisible(layer.id) },
      'sep',
      { label: t('keyframe_move_up'),   onClick: () => moveLayer(layer.id, -1), disabled: idx <= 0 },
      { label: t('keyframe_move_down'), onClick: () => moveLayer(layer.id, 1),  disabled: idx >= last },
      'sep',
      { label: t('layer_delete'), onClick: () => handleDeleteLayer(layer.id), danger: true, shortcut: 'Suppr' },
    ]
    ctx.open(e, items)
  }, [ctx, t, animData, duplicateLayer, moveLayer, handleToggleVisible, handleDeleteLayer])

  // ── Édition directe sur la scène (sélection / déplacement / création) ───────
  const stageDrag = useRef<{ id: string; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null)

  // Écrit positionX/Y sans sauvegarder (pendant le drag) ; crée un keyframe si
  // la propriété est déjà animée ou si l'auto-key est actif, sinon valeur statique.
  const setPosNoSave = useCallback((layerId: string, x: number, y: number) => {
    setAnimData(prev => {
      if (!prev) return prev
      const setP = (prop: AnimProperty<number>, val: number): AnimProperty<number> => {
        if (prop.keyframes.length > 0 || autoKey) {
          const i = prop.keyframes.findIndex(k => k.frame === frame)
          const kfs = i >= 0
            ? prop.keyframes.map((k, j) => j === i ? { ...k, value: val } : k)
            : [...prop.keyframes, { id: crypto.randomUUID(), frame, value: val, interpolation: 'bezier' as const, easing: { type: 'cubic-bezier' as const, cx1: .42, cy1: 0, cx2: .58, cy2: 1 }, handleIn: { x: 0, y: 0 }, handleOut: { x: 0, y: 0 } }].sort((a, b) => a.frame - b.frame)
          return { ...prop, keyframes: kfs }
        }
        return { ...prop, staticValue: val }
      }
      return { ...prev, layers: prev.layers.map(l => l.id === layerId
        ? { ...l, properties: { ...l.properties, positionX: setP(l.properties.positionX, x), positionY: setP(l.properties.positionY, y) } }
        : l) }
    })
  }, [autoKey, frame])

  // Écrit plusieurs propriétés numériques (auto-key aware) sans sauvegarder —
  // pour le redimensionnement (scaleX/scaleY + positionX/positionY).
  const setLayerNums = useCallback((layerId: string, props: Partial<Record<keyof AnimLayer['properties'], number>>) => {
    setAnimData(prev => {
      if (!prev) return prev
      const setP = (prop: AnimProperty<number>, val: number): AnimProperty<number> => {
        if (prop.keyframes.length > 0 || autoKey) {
          const i = prop.keyframes.findIndex(k => k.frame === frame)
          const kfs = i >= 0
            ? prop.keyframes.map((k, j) => j === i ? { ...k, value: val } : k)
            : [...prop.keyframes, { id: crypto.randomUUID(), frame, value: val, interpolation: 'bezier' as const, easing: { type: 'cubic-bezier' as const, cx1: .42, cy1: 0, cx2: .58, cy2: 1 }, handleIn: { x: 0, y: 0 }, handleOut: { x: 0, y: 0 } }].sort((a, b) => a.frame - b.frame)
          return { ...prop, keyframes: kfs }
        }
        return { ...prop, staticValue: val }
      }
      return { ...prev, layers: prev.layers.map(l => {
        if (l.id !== layerId) return l
        const np = { ...l.properties }
        const npRec = np as unknown as Record<string, AnimProperty<number> | undefined>
        for (const [k, v] of Object.entries(props)) {
          if (typeof v !== 'number') continue
          const cur = npRec[k]
          if (cur) npRec[k] = setP(cur, v)
        }
        return { ...l, properties: np }
      }) }
    })
  }, [autoKey, frame])

  const createLayerAt = useCallback((kind: 'rectangle' | 'text', wx: number, wy: number) => {
    const lid = crypto.randomUUID()
    const make = (v: number): AnimProperty<number> => ({ staticValue: v, keyframes: [] })
    const base = { id: lid, parentId: null, inPoint: 0, outPoint: comp.duration_frames, solo: false, locked: false, visible: true, blendMode: 'normal' as const, effects: [] }
    const layer: AnimLayer = kind === 'rectangle'
      ? { ...base, type: 'shape', name: t('keyframe_tool_rectangle'),
          data: { type: 'shape', shape: 'rect', width: 120, height: 120, cornerRadius: 0 } as unknown as AnimLayer['data'],
          properties: { positionX: make(wx - 60), positionY: make(wy - 60), rotation: make(0), scaleX: make(1), scaleY: make(1), opacity: make(100), anchorX: make(0), anchorY: make(0), fillColor: { staticValue: '#4a90e8', keyframes: [] } as AnimProperty<string>, strokeWidth: make(0), strokeColor: { staticValue: 'transparent', keyframes: [] } as AnimProperty<string> } }
      : { ...base, type: 'text', name: t('keyframe_tool_text'),
          data: { type: 'text', content: t('keyframe_default_text'), fontSize: 48, fontFamily: 'Inter', fontWeight: 700, textAlign: 'left' } as unknown as AnimLayer['data'],
          properties: { positionX: make(wx), positionY: make(wy), rotation: make(0), scaleX: make(1), scaleY: make(1), opacity: make(100), anchorX: make(0), anchorY: make(0), fillColor: { staticValue: '#ffffff', keyframes: [] } as AnimProperty<string>, fontSize: make(48) } }
    updateAnimData(d => ({ ...d, layers: [layer, ...d.layers] }))
    setSelectedLayerId(lid); setTool('select')
  }, [comp.duration_frames, updateAnimData, t])

  // Indépendant du zoom/pan : on déduit l'échelle depuis le rect rendu du canevas.
  const worldFromEvent = useCallback((e: React.MouseEvent) => {
    const c = canvasRef.current!; const r = c.getBoundingClientRect()
    return { x: (e.clientX - r.left) * comp.width / r.width, y: (e.clientY - r.top) * comp.height / r.height }
  }, [comp.width, comp.height])

  const resizeDrag = useRef<{ id: string; handle: number; w: number; h: number; ax: number; ay: number; rot: number; sx0: number; sy0: number; owx: number; owy: number; moved: boolean } | null>(null)

  const onStageDown = useCallback((e: React.MouseEvent) => {
    // Panoramique : bouton du milieu (ou Espace n'est pas dispo, réservé à la lecture).
    if (e.button === 1) { e.preventDefault(); panDragRef.current = { x: e.clientX, y: e.clientY, px: viewPan.x, py: viewPan.y }; return }
    if (e.button !== 0 || !animData) return
    const { x, y } = worldFromEvent(e)
    if (tool === 'rectangle') { createLayerAt('rectangle', x, y); return }
    if (tool === 'text')      { createLayerAt('text', x, y); return }
    // Poignée de redimensionnement du calque sélectionné ?
    if (selectedLayerId) {
      const sel = animData.layers.find(l => l.id === selectedLayerId && !l.locked && frame >= l.inPoint && frame < l.outPoint)
      if (sel) {
        const rect = canvasRef.current!.getBoundingClientRect()
        const tol = 11 * comp.width / rect.width
        const handles = kfHandleWorld(sel, frame)
        const hi = handles.findIndex(hp => Math.hypot(hp.x - x, hp.y - y) <= tol)
        if (hi >= 0) {
          const { w, h } = kfLayerSize(sel, frame)
          const Ol = kfHandleLocals(w, h)[KF_OPPOSITE[hi]]
          const Ow = kfLocalToWorld(sel, frame, Ol[0], Ol[1])
          resizeDrag.current = { id: sel.id, handle: hi, w, h,
            ax: kfNum(sel.properties.anchorX, frame), ay: kfNum(sel.properties.anchorY, frame),
            rot: kfNum(sel.properties.rotation, frame) * Math.PI / 180,
            sx0: kfNum(sel.properties.scaleX, frame, 1), sy0: kfNum(sel.properties.scaleY, frame, 1),
            owx: Ow.x, owy: Ow.y, moved: false }
          return
        }
      }
    }
    const hit = animData.layers.find(l => l.visible && !l.locked && frame >= l.inPoint && frame < l.outPoint && kfHitLayer(l, frame, x, y))
    if (hit) {
      setSelectedLayerId(hit.id)
      stageDrag.current = { id: hit.id, sx: x, sy: y, ox: kfNum(hit.properties.positionX, frame), oy: kfNum(hit.properties.positionY, frame), moved: false }
    } else setSelectedLayerId(null)
  }, [animData, frame, tool, worldFromEvent, createLayerAt, viewPan, selectedLayerId, comp.width])

  const onStageMove = useCallback((e: React.MouseEvent) => {
    const pd = panDragRef.current
    if (pd) { setViewPan({ x: pd.px + (e.clientX - pd.x), y: pd.py + (e.clientY - pd.y) }); return }
    const rz = resizeDrag.current
    if (rz) {
      const { x, y } = worldFromEvent(e); rz.moved = true
      const cosI = Math.cos(-rz.rot), sinI = Math.sin(-rz.rot)
      const dx = x - rz.owx, dy = y - rz.owy
      const lx = cosI * dx - sinI * dy, ly = sinI * dx + cosI * dy
      const locals = kfHandleLocals(rz.w, rz.h)
      const Hl = locals[rz.handle], Ol = locals[KF_OPPOSITE[rz.handle]]
      let nsx = Hl[0] !== Ol[0] ? lx / (Hl[0] - Ol[0]) : rz.sx0
      let nsy = Hl[1] !== Ol[1] ? ly / (Hl[1] - Ol[1]) : rz.sy0
      if (e.shiftKey && Hl[0] !== Ol[0] && Hl[1] !== Ol[1]) { const f = Math.max(Math.abs(nsx), Math.abs(nsy)); nsx = f; nsy = f }
      nsx = Math.max(0.02, nsx); nsy = Math.max(0.02, nsy)
      const c = Math.cos(rz.rot), s = Math.sin(rz.rot)
      const ox = nsx * (Ol[0] - rz.ax), oy = nsy * (Ol[1] - rz.ay)
      setLayerNums(rz.id, { scaleX: nsx, scaleY: nsy, positionX: rz.owx - (c * ox - s * oy), positionY: rz.owy - (s * ox + c * oy) })
      return
    }
    const d = stageDrag.current; if (!d) return
    const { x, y } = worldFromEvent(e)
    d.moved = true
    setPosNoSave(d.id, d.ox + (x - d.sx), d.oy + (y - d.sy))
  }, [worldFromEvent, setPosNoSave, setLayerNums])

  const onStageUp = useCallback(() => {
    panDragRef.current = null
    if (stageDrag.current?.moved || resizeDrag.current?.moved) setAnimData(prev => { if (prev) saveMut.mutate(prev); return prev })
    stageDrag.current = null
    resizeDrag.current = null
  }, [saveMut])

  const handleExport = () => {
    window.open(keyframeApi.exportLottie(id!), '_blank')
  }

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName)) return
      if (e.code === 'Space') { e.preventDefault(); handlePlayPause() }
      if (e.code === 'Home')  { setFrame(0) }
      if (e.code === 'End')   { setFrame(comp.duration_frames - 1) }
      if (e.code === 'Comma') { setFrame(f => Math.max(0, f - 1)) }
      if (e.code === 'Period'){ setFrame(f => Math.min(comp.duration_frames - 1, f + 1)) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [comp.duration_frames, handlePlayPause])

  // ─────────────────────────────────────────────────────────────────────────
  if (isLoading || !animData) {
    return (
      <div className="h-full flex items-center justify-center" style={{ background: '#111' }}>
        <p className="text-sm" style={{ color: '#7a7a7a' }}>{t('common_loading')}</p>
      </div>
    )
  }

  const tlContentWidth = comp.duration_frames * PX_PER_FRAME

  const keyframePanels = {
    properties: { label: t('keyframe_properties_caps'), render: () => (
      <div className="flex flex-col h-full">
          <div className="flex items-center justify-between px-2 h-8 border-b flex-shrink-0"
               style={{ borderColor: '#2a2a2a' }}>
            <span className="text-[10px] font-medium" style={{ color: '#9e9e9e' }}>{t('keyframe_properties_caps')}</span>
            <button onClick={handleAddLayer} title={t('keyframe_add_layer')}
                    className="w-5 h-5 flex items-center justify-center rounded"
                    style={{ color: '#9e9e9e' }}
                    onMouseEnter={e => (e.currentTarget.style.color = '#e0e0e0')}
                    onMouseLeave={e => (e.currentTarget.style.color = '#9e9e9e')}>
              <Plus size={12} />
            </button>
          </div>
          <div className="flex-1 overflow-hidden">
            <PropertiesPanel
              layer={selectedLayer}
              frame={frame}
              onUpdateProp={handleUpdateProp}
              onToggleKeyframe={handleToggleKeyframe}
            />
          </div>
      </div>
    ) },
  }

  return (
    <EditorShell theme={C}
      chromeless
      topbarHeight={64}
      onBack={() => navigate('/paintsharp/keyframe')}
      title={titleDraft}
      onTitleChange={setTitleDraft}
      onTitleCommit={commitTitle}
      titlePlaceholder={t('common_untitled', { defaultValue: 'Sans titre' })}
      saveStatus={saveMut.isPending ? t('keyframe_saving', { defaultValue: 'Enregistrement…' }) : t('doc_saved', { defaultValue: 'Enregistré' })}
      subtitle="Keyframe"
      docInfo={`${comp.width}×${comp.height} · ${comp.fps}fps`}
      onDelete={() => trashMut.mutate()}
      deleteTitle={t('keyframe_move_to_trash', { defaultValue: 'Mettre à la corbeille' })}
      deleteConfirm={{
        title: t('keyframe_delete_confirm_title', { defaultValue: 'Supprimer cette animation ?' }),
        message: t('keyframe_delete_confirm_msg', { defaultValue: 'L\'animation sera déplacée dans la corbeille.' }),
        confirmLabel: t('common_delete', { defaultValue: 'Supprimer' }),
        variant: 'danger',
      }}
      menus={paintsharpMenus(t, {
        onSave:   () => saveMut.mutate(animData),
        onExport: handleExport, exportLabel: t('common_export'),
        onClose:  () => navigate('/paintsharp/keyframe'),
      })}
      topbarActions={
        <button onClick={handleExport} className="flex items-center gap-1.5 h-6 px-2.5 text-white text-[10px] rounded" style={{ background: C.accent }}>
          <Download size={11} />{t('common_export')}
        </button>
      }
      optionsBar={<>
        <TransportBar frame={frame} totalFrames={comp.duration_frames} fps={comp.fps} isPlaying={isPlaying} looping={looping}
          onFrameChange={f => { setIsPlaying(false); setFrame(Math.max(0, Math.min(comp.duration_frames - 1, f))) }}
          onPlayPause={handlePlayPause} onFpsChange={fps => setComp(c => ({ ...c, fps }))} onToggleLoop={() => setLooping(l => !l)} />
        <div className="flex-1" />
        <button onClick={() => setAutoKey(a => !a)} title={t('keyframe_autokey')}
                className="flex items-center gap-1 h-6 px-2 rounded text-[10px]"
                style={{ background: autoKey ? '#e8824a22' : 'transparent', color: autoKey ? '#e8824a' : '#9e9e9e', border: `1px solid ${autoKey ? '#e8824a' : '#3a3a3a'}` }}>
          <span style={{ fontSize: 11 }}>◆</span> {t('keyframe_autokey')}
        </button>
        <button onClick={() => setOnion(o => !o)} title={t('keyframe_onion')}
                className="flex items-center gap-1 h-6 px-2 rounded text-[10px]"
                style={{ background: onion ? '#e8824a22' : 'transparent', color: onion ? '#e8824a' : '#9e9e9e', border: `1px solid ${onion ? '#e8824a' : '#3a3a3a'}` }}>
          <Layers size={11} /> {t('keyframe_onion')}
        </button>
      </>}
      toolRail={<>          {([
            { Icon: MousePointer, title: t('keyframe_tool_select'),    onClick: () => setTool('select'),    active: tool === 'select' },
            { Icon: Square,       title: t('keyframe_tool_rectangle'), onClick: () => setTool('rectangle'), active: tool === 'rectangle' },
            { Icon: Type,         title: t('keyframe_tool_text'),      onClick: () => setTool('text'),      active: tool === 'text' },
            { Icon: ImageIcon,    title: t('keyframe_import_image'),   onClick: handleImportImage,          active: false },
          ] as { Icon: React.ComponentType<{ size?: number }>; title: string; onClick: () => void; active: boolean }[]).map(({ Icon, title, onClick, active }) => (
            <button key={title} title={title}
                    className="w-7 h-7 flex items-center justify-center rounded transition-colors"
                    style={{ color: active ? '#e8824a' : '#9e9e9e', background: active ? '#e8824a22' : 'transparent' }}
                    onClick={onClick}
                    onMouseEnter={e => { if (!active) e.currentTarget.style.background = '#2a2a2a' }}
                    onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent' }}>
              <Icon size={14} />
            </button>
          ))}</>}
      bottomBar={
      <div className="flex-shrink-0 border-t" style={{ borderColor: '#333', height: 280 }}>
        <div className="flex h-full flex-col">

          {/* Timeline top row */}
          <div className="flex border-b flex-shrink-0" style={{ borderColor: '#333', height: 28 }}>
            {/* Layer list header */}
            <div className="flex items-center justify-between px-2 flex-shrink-0 border-r"
                 style={{ width: 200, background: '#252525', borderColor: '#333' }}>
              <div className="flex items-center gap-1">
                <button onClick={handleAddLayer} className="text-[#7a7a7a] hover:text-[#e0e0e0]">
                  <Plus size={11} />
                </button>
                <span className="text-[10px]" style={{ color: '#7a7a7a' }}>{t('keyframe_layers')}</span>
              </div>
              <div className="flex items-center gap-0.5">
                <button onClick={() => setTlZoom(z => Math.max(0.25, z / 1.5))}
                        className="w-5 h-5 flex items-center justify-center text-[#7a7a7a] hover:text-[#e0e0e0]">
                  <ZoomOut size={10} />
                </button>
                <button onClick={() => setTlZoom(z => Math.min(8, z * 1.5))}
                        className="w-5 h-5 flex items-center justify-center text-[#7a7a7a] hover:text-[#e0e0e0]">
                  <ZoomIn size={10} />
                </button>
              </div>
            </div>

            {/* Ruler */}
            <div className="flex-1 overflow-hidden relative">
              <TimelineRuler
                duration={comp.duration_frames}
                fps={comp.fps}
                pxPerFrame={PX_PER_FRAME}
                scrollX={tlScrollX}
                onScrub={f => { setIsPlaying(false); setFrame(f) }}
              />
              <Playhead frame={frame} pxPerFrame={PX_PER_FRAME} scrollX={tlScrollX} height={280} />
            </div>
          </div>

          {/* Timeline body */}
          <div className="flex flex-1 overflow-hidden">
            {/* Layer list */}
            <div
              ref={layerListRef}
              className="flex-shrink-0 overflow-y-hidden border-r select-none"
              style={{ width: 200, background: '#1e1e1e', borderColor: '#333' }}
              onScroll={syncScrollLeft}
            >
              {animData.layers.map(layer => {
                const isExpanded = expandedLayers.has(layer.id)
                const isSelected = selectedLayerId === layer.id
                return (
                  <div key={layer.id}>
                    {/* Layer header row */}
                    <div
                      draggable
                      onDragStart={(e) => { dragLayerRef.current = layer.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', layer.id) }}
                      onDragOver={(e) => { const dg = dragLayerRef.current; if (!dg || dg === layer.id) return; e.preventDefault(); setDragOverLayer(layer.id) }}
                      onDragLeave={() => setDragOverLayer(p => p === layer.id ? null : p)}
                      onDrop={(e) => { e.preventDefault(); const dg = e.dataTransfer.getData('text/plain') || dragLayerRef.current
                        if (dg && dg !== layer.id) { const r = e.currentTarget.getBoundingClientRect(); handleReorderLayer(dg, layer.id, (e.clientY - r.top) > r.height / 2) }
                        dragLayerRef.current = null; setDragOverLayer(null) }}
                      onDragEnd={() => { dragLayerRef.current = null; setDragOverLayer(null) }}
                      onContextMenu={(e) => onLayerContextMenu(e, layer)}
                      className="flex items-center h-8 px-1 gap-1 cursor-pointer border-b"
                      style={{
                        background:   isSelected ? '#283040' : 'transparent',
                        borderColor:  '#2a2a2a',
                        boxShadow:    dragOverLayer === layer.id ? 'inset 0 -2px 0 #e8824a' : undefined,
                      }}
                      onClick={() => setSelectedLayerId(layer.id)}
                    >
                      <GripVertical size={10} className="flex-shrink-0 opacity-40" style={{ color: '#7a7a7a', cursor: 'grab' }} />
                      <button
                        onClick={(e) => { e.stopPropagation(); setExpandedLayers(s => { const n = new Set(s); n.has(layer.id) ? n.delete(layer.id) : n.add(layer.id); return n }) }}
                        className="w-4 h-4 flex items-center justify-center flex-shrink-0"
                        style={{ color: '#7a7a7a' }}
                      >
                        {isExpanded ? <ChevronDown size={10} /> : <ChevronRightIcon size={10} />}
                      </button>
                      <span className="text-[10px] flex-1 truncate" style={{ color: isSelected ? '#e0e0e0' : '#b0b0b0' }}>
                        {layer.name}
                      </span>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleToggleVisible(layer.id) }}
                        className="w-4 h-4 flex items-center justify-center flex-shrink-0"
                        style={{ color: layer.visible ? '#7a7a7a' : '#3a3a3a' }}
                      >
                        {layer.visible ? <Eye size={10} /> : <EyeOff size={10} />}
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDeleteLayer(layer.id) }}
                        className="w-4 h-4 flex items-center justify-center flex-shrink-0 opacity-0 group-hover:opacity-100"
                        style={{ color: '#7a7a7a' }}
                        onMouseEnter={e => (e.currentTarget.style.color = '#e84a4a')}
                        onMouseLeave={e => (e.currentTarget.style.color = '#7a7a7a')}
                      >
                        <Trash2 size={10} />
                      </button>
                    </div>
                    {/* Property rows */}
                    {isExpanded && PROP_KEYS.map(({ key, labelKey }) => {
                      const prop = layer.properties[key] as AnimProperty<number> | undefined
                      if (!prop) return null
                      return (
                        <div key={key}
                             className="flex items-center h-7 pl-6 pr-1 border-b"
                             style={{ borderColor: '#2a2a2a', background: '#181818' }}>
                          <span className="text-[9px] truncate" style={{ color: '#7a7a7a' }}>{t(labelKey)}</span>
                        </div>
                      )
                    })}
                  </div>
                )
              })}
            </div>

            {/* Keyframe tracks */}
            <div
              ref={tlBodyRef}
              className="flex-1 overflow-auto relative"
              onScroll={syncScroll}
            >
              <div style={{ width: Math.max(tlContentWidth, 800), minHeight: '100%', position: 'relative' }}>
                {animData.layers.map(layer => (
                  <LayerTrackRow
                    key={layer.id}
                    layer={layer}
                    pxPerFrame={PX_PER_FRAME}
                    duration={comp.duration_frames}
                    selectedKfIds={selectedKfIds}
                    expanded={expandedLayers.has(layer.id)}
                    onSelect={selectKf}
                    onMove={handleKfMove}
                  />
                ))}
              </div>
            </div>
          </div>

          {/* Graph editor */}
          <GraphEditor
            kf={firstSelectedKf}
            onApplyPreset={handleApplyEasingPreset}
          />
        </div>
      </div>
      }>
      <DockArea theme={C} storageKey="kubuno:paintsharp:keyframeDockLayout" viewportBg="#141414"
        defaultArrangement={{ right: [['properties']] }} panels={keyframePanels}>
        <div
          ref={containerRef}
          className="w-full h-full flex items-center justify-center overflow-hidden"
          style={{ background: '#141414' }}
        >
          <div style={{ transform: `translate(${viewPan.x}px, ${viewPan.y}px) scale(${sceneScale * viewZoom})`, transformOrigin: 'center center' }}>
            <canvas
              ref={canvasRef}
              onMouseDown={onStageDown}
              onMouseMove={onStageMove}
              onMouseUp={onStageUp}
              onMouseLeave={onStageUp}
              style={{
                display:   'block',
                boxShadow: '0 4px 32px rgba(0,0,0,0.8)',
                cursor:    tool === 'select' ? 'default' : 'crosshair',
              }}
            />
          </div>
          {/* Contrôles de zoom (façon Layer) */}
          <div className="absolute bottom-3 right-3 flex items-center gap-1 px-1.5 py-1 rounded-lg"
               style={{ background: 'rgba(0,0,0,0.6)', border: '1px solid #333' }}>
            <button onClick={() => zoomAt(1 / 1.2)} className="w-6 h-6 flex items-center justify-center rounded text-[#b0b0b0] hover:bg-white/10"><ZoomOut size={13} /></button>
            <button onClick={resetView} className="px-1.5 text-[10px] font-mono text-[#b0b0b0] hover:text-white" title={t('keyframe_zoom_reset')}>{Math.round(viewZoom * 100)}%</button>
            <button onClick={() => zoomAt(1.2)} className="w-6 h-6 flex items-center justify-center rounded text-[#b0b0b0] hover:bg-white/10"><ZoomIn size={13} /></button>
          </div>
        </div>
      </DockArea>
      {ctx.menu}
    </EditorShell>
  )
}