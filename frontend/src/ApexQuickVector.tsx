// ApexQuickVector — a small, self-contained vector painter "provided by Apex".
//
// Companion to LayerQuickPaint (raster): instead of pixels it builds smooth vector
// strokes (freehand pen → midpoint-quadratic smoothing) that stay editable —
// select / move / delete / recolour individual strokes. On every change it commits
// BOTH a rasterised PNG (so Keyframe can render frames uniformly) AND the vector
// path list (so re-opening a frame restores full editability).
import { useCallback, useEffect, useRef, useState } from 'react'
import { PenTool, MousePointer2, RotateCcw, Trash2, X } from 'lucide-react'
import { RangeSlider } from '@ui'

export interface VPath {
  id: string
  pts: [number, number][]
  color: string
  width: number
  fill: string | null
  closed: boolean
}

export interface ApexQuickVectorProps {
  width: number
  height: number
  cssWidth: number
  cssHeight: number
  initialPaths: VPath[] | null
  onCommit: (png: string, paths: VPath[]) => void
}

const SWATCHES = ['#000000', '#ffffff', '#e84a4a', '#f9ab00', '#22c55e', '#3b82f6', '#a855f7', '#ec4899']
const uid = () => crypto.randomUUID()

// Draw one stroke with midpoint-quadratic smoothing.
function tracePath(ctx: CanvasRenderingContext2D, p: VPath) {
  const pts = p.pts
  if (pts.length === 0) return
  ctx.beginPath()
  ctx.moveTo(pts[0][0], pts[0][1])
  if (pts.length === 1) { ctx.lineTo(pts[0][0] + 0.01, pts[0][1]) }
  else if (pts.length === 2) { ctx.lineTo(pts[1][0], pts[1][1]) }
  else {
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2
      ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my)
    }
    ctx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1])
  }
  if (p.closed) ctx.closePath()
}

function paintAll(ctx: CanvasRenderingContext2D, w: number, h: number, paths: VPath[], selectedId: string | null) {
  ctx.clearRect(0, 0, w, h)
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'
  for (const p of paths) {
    tracePath(ctx, p)
    if (p.fill) { ctx.fillStyle = p.fill; ctx.fill() }
    ctx.strokeStyle = p.color; ctx.lineWidth = p.width; ctx.stroke()
    if (p.id === selectedId) {
      ctx.save(); ctx.strokeStyle = '#4a90e8'; ctx.lineWidth = Math.max(1, p.width + 2); ctx.globalAlpha = 0.4
      tracePath(ctx, p); ctx.stroke(); ctx.restore()
    }
  }
}

export function ApexQuickVector({ width, height, cssWidth, cssHeight, initialPaths, onCommit }: ApexQuickVectorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null)
  const [paths, setPaths] = useState<VPath[]>(initialPaths ?? [])
  const [tool, setTool] = useState<'pen' | 'select'>('pen')
  const [color, setColor] = useState('#000000')
  const [strokeW, setStrokeW] = useState(6)
  const [filled, setFilled] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const drawing = useRef<VPath | null>(null)
  const moveRef = useRef<{ id: string; sx: number; sy: number; base: [number, number][] } | null>(null)
  const undoStack = useRef<VPath[][]>([])

  // The host swaps frames by changing `initialPaths`; resync.
  useEffect(() => { setPaths(initialPaths ?? []); setSelected(null); undoStack.current = [] }, [initialPaths])

  useEffect(() => {
    const c = canvasRef.current; if (!c) return
    ctxRef.current = c.getContext('2d')
    if (ctxRef.current) paintAll(ctxRef.current, width, height, drawing.current ? [...paths, drawing.current] : paths, selected)
  }, [paths, selected, width, height])

  const toCanvas = (e: React.PointerEvent): [number, number] => {
    const r = canvasRef.current!.getBoundingClientRect()
    return [(e.clientX - r.left) * (width / r.width), (e.clientY - r.top) * (height / r.height)]
  }
  const distToPath = (p: VPath, x: number, y: number) => {
    let best = Infinity
    for (const [px, py] of p.pts) best = Math.min(best, Math.hypot(px - x, py - y))
    return best
  }

  const pushUndo = () => { undoStack.current.push(paths.map(p => ({ ...p, pts: p.pts.slice() }))); if (undoStack.current.length > 40) undoStack.current.shift() }
  const commit = useCallback((next: VPath[]) => {
    const c = canvasRef.current, ctx = ctxRef.current
    if (c && ctx) { paintAll(ctx, width, height, next, null); onCommit(c.toDataURL('image/png'), next) }
  }, [width, height, onCommit])

  const onDown = (e: React.PointerEvent) => {
    e.preventDefault(); ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    const [x, y] = toCanvas(e)
    if (tool === 'pen') {
      pushUndo()
      drawing.current = { id: uid(), pts: [[x, y]], color, width: strokeW, fill: filled ? color : null, closed: filled }
    } else {
      // select / move
      let hit: string | null = null, bd = 10
      for (const p of paths) { const d = distToPath(p, x, y); if (d < bd) { bd = d; hit = p.id } }
      setSelected(hit)
      if (hit) { const p = paths.find(pp => pp.id === hit)!; moveRef.current = { id: hit, sx: x, sy: y, base: p.pts.map(pt => [pt[0], pt[1]]) } }
    }
  }
  const onMove = (e: React.PointerEvent) => {
    const [x, y] = toCanvas(e)
    if (drawing.current) {
      const lastPt = drawing.current.pts[drawing.current.pts.length - 1]
      if (Math.hypot(x - lastPt[0], y - lastPt[1]) > 1.5) { drawing.current.pts.push([x, y]); setPaths(p => [...p]) }
    } else if (moveRef.current) {
      const m = moveRef.current, dx = x - m.sx, dy = y - m.sy
      setPaths(ps => ps.map(p => p.id === m.id ? { ...p, pts: m.base.map(([bx, by]) => [bx + dx, by + dy] as [number, number]) } : p))
    }
  }
  const onUp = () => {
    if (drawing.current) {
      const d = drawing.current; drawing.current = null
      if (d.pts.length >= 1) { const next = [...paths, d]; setPaths(next); commit(next) }
    } else if (moveRef.current) { moveRef.current = null; commit(paths) }
  }

  const undo = () => { const prev = undoStack.current.pop(); if (prev) { setPaths(prev); commit(prev) } }
  const clearAll = () => { if (paths.length) { pushUndo(); setPaths([]); commit([]) } }
  const deleteSel = () => { if (selected) { pushUndo(); const next = paths.filter(p => p.id !== selected); setSelected(null); setPaths(next); commit(next) } }

  // Recolour the selected stroke when the colour changes in select mode.
  useEffect(() => {
    if (tool === 'select' && selected) {
      setPaths(ps => { const next = ps.map(p => p.id === selected ? { ...p, color } : p); commit(next); return next })
    }
  }, [color]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <div className="absolute left-1/2 -translate-x-1/2 -top-11 flex items-center gap-1.5 px-2 py-1.5 rounded-lg z-30"
           style={{ background: 'rgba(20,20,20,0.95)', border: '1px solid #333', boxShadow: '0 4px 16px rgba(0,0,0,0.5)' }}
           onPointerDown={e => e.stopPropagation()}>
        <button onClick={() => setTool('pen')} title="Pen"
                className="w-7 h-7 flex items-center justify-center rounded" style={{ color: tool === 'pen' ? '#e8824a' : '#bbb', background: tool === 'pen' ? '#e8824a22' : 'transparent' }}><PenTool size={14} /></button>
        <button onClick={() => setTool('select')} title="Select"
                className="w-7 h-7 flex items-center justify-center rounded" style={{ color: tool === 'select' ? '#e8824a' : '#bbb', background: tool === 'select' ? '#e8824a22' : 'transparent' }}><MousePointer2 size={14} /></button>
        <div className="w-px h-5" style={{ background: '#3a3a3a' }} />
        <input type="color" value={color} onChange={e => setColor(e.target.value)} className="w-6 h-6 rounded bg-transparent cursor-pointer" title="Colour" />
        <div className="flex items-center gap-1">
          {SWATCHES.map(s => <button key={s} onClick={() => setColor(s)} className="w-4 h-4 rounded-full border border-white/20" style={{ background: s }} />)}
        </div>
        <div className="w-px h-5" style={{ background: '#3a3a3a' }} />
        <RangeSlider min={1} max={60} value={strokeW} onChange={setStrokeW} className="w-16" accent="#e8824a" trackColor="rgba(255,255,255,0.15)" aria-label="Width" />
        <span className="text-[10px] w-5 text-center" style={{ color: '#bbb' }}>{strokeW}</span>
        <button onClick={() => setFilled(f => !f)} title="Fill" className="px-1.5 h-6 rounded text-[10px]" style={{ color: filled ? '#e8824a' : '#bbb', background: filled ? '#e8824a22' : 'transparent', border: '1px solid #3a3a3a' }}>Fill</button>
        <div className="w-px h-5" style={{ background: '#3a3a3a' }} />
        {selected && <button onClick={deleteSel} title="Delete stroke" className="w-7 h-7 flex items-center justify-center rounded text-[#e84a4a] hover:bg-white/10"><X size={14} /></button>}
        <button onClick={undo} title="Undo" className="w-7 h-7 flex items-center justify-center rounded text-[#bbb] hover:bg-white/10"><RotateCcw size={14} /></button>
        <button onClick={clearAll} title="Clear" className="w-7 h-7 flex items-center justify-center rounded text-[#bbb] hover:bg-white/10"><Trash2 size={14} /></button>
      </div>
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerLeave={onUp}
        style={{ width: cssWidth, height: cssHeight, display: 'block', cursor: tool === 'pen' ? 'crosshair' : 'default', touchAction: 'none' }}
      />
    </>
  )
}
