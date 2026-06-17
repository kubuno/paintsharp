// LayerQuickPaint — a small, self-contained 2D-canvas painter "provided by Layer".
//
// It is deliberately lightweight (no WebGL, no document model): a transparent
// raster surface with brush / eraser / colour / size / clear / undo, meant to be
// embedded wherever a quick freehand drawing is needed. Keyframe embeds one per
// animation frame to draw cel/frame-by-frame artwork.
//
// The surface is `width`×`height` internal pixels but displayed at `cssWidth`×
// `cssHeight` CSS pixels, so the host can align it 1:1 over another canvas at any
// zoom. It loads `value` (a PNG data URL) and calls `onCommit` with the new PNG
// after every stroke.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Brush, Eraser, RotateCcw, Trash2 } from 'lucide-react'

export interface LayerQuickPaintProps {
  width: number
  height: number
  cssWidth: number
  cssHeight: number
  value: string | null
  onCommit: (dataUrl: string) => void
}

const SWATCHES = ['#000000', '#ffffff', '#e84a4a', '#f9ab00', '#22c55e', '#3b82f6', '#a855f7', '#ec4899']

export function LayerQuickPaint({ width, height, cssWidth, cssHeight, value, onCommit }: LayerQuickPaintProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null)
  const drawing = useRef(false)
  const last = useRef<{ x: number; y: number } | null>(null)
  const undoStack = useRef<ImageData[]>([])

  const [tool, setTool] = useState<'brush' | 'eraser'>('brush')
  const [color, setColor] = useState('#000000')
  const [size, setSize] = useState(8)
  const toolRef = useRef(tool), colorRef = useRef(color), sizeRef = useRef(size)
  useEffect(() => { toolRef.current = tool }, [tool])
  useEffect(() => { colorRef.current = color }, [color])
  useEffect(() => { sizeRef.current = size }, [size])

  // (Re)load the surface when the source image changes (e.g. switching frame).
  useEffect(() => {
    const c = canvasRef.current; if (!c) return
    const ctx = c.getContext('2d'); if (!ctx) return
    ctxRef.current = ctx
    ctx.clearRect(0, 0, width, height)
    undoStack.current = []
    if (value) {
      const img = new Image()
      img.onload = () => { ctx.clearRect(0, 0, width, height); ctx.drawImage(img, 0, 0, width, height) }
      img.src = value
    }
  }, [value, width, height])

  const toCanvas = (e: React.PointerEvent): { x: number; y: number } => {
    const c = canvasRef.current!
    const r = c.getBoundingClientRect()
    return { x: (e.clientX - r.left) * (width / r.width), y: (e.clientY - r.top) * (height / r.height) }
  }

  const stroke = useCallback((from: { x: number; y: number }, to: { x: number; y: number }) => {
    const ctx = ctxRef.current; if (!ctx) return
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'
    ctx.lineWidth = sizeRef.current
    if (toolRef.current === 'eraser') { ctx.globalCompositeOperation = 'destination-out'; ctx.strokeStyle = 'rgba(0,0,0,1)' }
    else { ctx.globalCompositeOperation = 'source-over'; ctx.strokeStyle = colorRef.current }
    ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke()
    // A dot so single clicks register.
    ctx.beginPath(); ctx.arc(to.x, to.y, sizeRef.current / 2, 0, Math.PI * 2)
    ctx.fillStyle = toolRef.current === 'eraser' ? 'rgba(0,0,0,1)' : colorRef.current
    ctx.fill()
    ctx.globalCompositeOperation = 'source-over'
  }, [])

  const onDown = (e: React.PointerEvent) => {
    e.preventDefault()
    const ctx = ctxRef.current; if (!ctx) return
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    undoStack.current.push(ctx.getImageData(0, 0, width, height))
    if (undoStack.current.length > 30) undoStack.current.shift()
    drawing.current = true
    const p = toCanvas(e); last.current = p
    stroke(p, p)
  }
  const onMove = (e: React.PointerEvent) => {
    if (!drawing.current) return
    const p = toCanvas(e)
    if (last.current) stroke(last.current, p)
    last.current = p
  }
  const onUp = () => {
    if (!drawing.current) return
    drawing.current = false; last.current = null
    const c = canvasRef.current; if (c) onCommit(c.toDataURL('image/png'))
  }

  const undo = () => {
    const ctx = ctxRef.current; const prev = undoStack.current.pop()
    if (!ctx || !prev) return
    ctx.putImageData(prev, 0, 0)
    const c = canvasRef.current; if (c) onCommit(c.toDataURL('image/png'))
  }
  const clear = () => {
    const ctx = ctxRef.current; if (!ctx) return
    undoStack.current.push(ctx.getImageData(0, 0, width, height))
    ctx.clearRect(0, 0, width, height)
    const c = canvasRef.current; if (c) onCommit(c.toDataURL('image/png'))
  }

  return (
    <>
      {/* Floating toolbar (screen-space, fixed height) */}
      <div className="absolute left-1/2 -translate-x-1/2 -top-11 flex items-center gap-1.5 px-2 py-1.5 rounded-lg z-30"
           style={{ background: 'rgba(20,20,20,0.95)', border: '1px solid #333', boxShadow: '0 4px 16px rgba(0,0,0,0.5)' }}
           onPointerDown={e => e.stopPropagation()}>
        <button onClick={() => setTool('brush')} title="Brush"
                className="w-7 h-7 flex items-center justify-center rounded"
                style={{ color: tool === 'brush' ? '#e8824a' : '#bbb', background: tool === 'brush' ? '#e8824a22' : 'transparent' }}><Brush size={14} /></button>
        <button onClick={() => setTool('eraser')} title="Eraser"
                className="w-7 h-7 flex items-center justify-center rounded"
                style={{ color: tool === 'eraser' ? '#e8824a' : '#bbb', background: tool === 'eraser' ? '#e8824a22' : 'transparent' }}><Eraser size={14} /></button>
        <div className="w-px h-5" style={{ background: '#3a3a3a' }} />
        <input type="color" value={color} onChange={e => setColor(e.target.value)} className="w-6 h-6 rounded bg-transparent cursor-pointer" title="Colour" />
        <div className="flex items-center gap-1">
          {SWATCHES.map(s => (
            <button key={s} onClick={() => { setColor(s); setTool('brush') }} className="w-4 h-4 rounded-full border border-white/20" style={{ background: s }} />
          ))}
        </div>
        <div className="w-px h-5" style={{ background: '#3a3a3a' }} />
        <input type="range" min={1} max={80} value={size} onChange={e => setSize(+e.target.value)} className="w-20 accent-[#e8824a]" title="Size" />
        <span className="text-[10px] w-6 text-center" style={{ color: '#bbb' }}>{size}</span>
        <div className="w-px h-5" style={{ background: '#3a3a3a' }} />
        <button onClick={undo} title="Undo" className="w-7 h-7 flex items-center justify-center rounded text-[#bbb] hover:bg-white/10"><RotateCcw size={14} /></button>
        <button onClick={clear} title="Clear" className="w-7 h-7 flex items-center justify-center rounded text-[#bbb] hover:bg-white/10"><Trash2 size={14} /></button>
      </div>
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerLeave={onUp}
        style={{ width: cssWidth, height: cssHeight, display: 'block', cursor: 'crosshair', touchAction: 'none' }}
      />
    </>
  )
}
