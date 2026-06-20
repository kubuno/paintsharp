// Paintsharp primitive: Photoshop-style Navigator (minimap). A downscaled thumbnail
// of the document with a red viewport rectangle + zoom field/slider. Engine-
// agnostic: the host supplies `refresh` (paint the thumbnail), `screenToDoc`
// (map a viewport corner to doc space) and zoom/pan callbacks.
import { useEffect, useRef } from 'react'
import { RangeSlider } from '@ui'

export function Navigator({ docW, docH, refresh, screenToDoc, onCenter, zoom, onZoom, viewW, viewH, C }: {
  docW:number; docH:number; refresh:(cv:HTMLCanvasElement)=>void
  screenToDoc:(x:number,y:number)=>[number,number]; onCenter:(dx:number,dy:number)=>void
  zoom:number; onZoom:(z:number)=>void; viewW:number; viewH:number
  C:{ textDim:string; border:string; accent:string }
}) {
  const canRef = useRef<HTMLCanvasElement>(null)
  const drag = useRef(false)
  const refreshRef = useRef(refresh); refreshRef.current = refresh
  const maxW = 208, maxH = 150
  const scale = Math.min(maxW/docW, maxH/docH)
  const tw = Math.max(1, Math.round(docW*scale)), th = Math.max(1, Math.round(docH*scale))
  useEffect(() => {
    const cv = canRef.current; if (!cv) return
    cv.width = tw; cv.height = th
    const tick = () => refreshRef.current(cv); tick()
    const id = setInterval(tick, 700)
    return () => clearInterval(id)
  }, [tw, th])
  const goTo = (e:{clientX:number;clientY:number}) => {
    const cv = canRef.current; if (!cv) return
    const r = cv.getBoundingClientRect()
    onCenter((e.clientX-r.left)/scale, (e.clientY-r.top)/scale)
  }
  useEffect(() => {
    const m = (e:PointerEvent) => { if (drag.current) goTo(e) }
    const u = () => { drag.current = false }
    window.addEventListener('pointermove', m); window.addEventListener('pointerup', u)
    return () => { window.removeEventListener('pointermove', m); window.removeEventListener('pointerup', u) }
  }) // eslint-disable-line react-hooks/exhaustive-deps
  // Visible-region rectangle (bbox of the viewport's 4 corners mapped to doc).
  const corners = [[0,0],[viewW,0],[viewW,viewH],[0,viewH]].map(([x,y]) => screenToDoc(x,y))
  const xs = corners.map(c=>c[0]), ys = corners.map(c=>c[1])
  const rx = Math.min(...xs)*scale, ry = Math.min(...ys)*scale
  const rw = (Math.max(...xs)-Math.min(...xs))*scale, rh = (Math.max(...ys)-Math.min(...ys))*scale
  return (
    <div className="p-2">
      <div className="relative mx-auto" style={{ width:tw, height:th }}>
        <canvas ref={canRef} onPointerDown={e=>{ drag.current=true; goTo(e) }}
                style={{ width:tw, height:th, cursor:'move', background:'#1c1c1c', display:'block' }} />
        <div className="absolute pointer-events-none"
             style={{ left:Math.max(0,rx), top:Math.max(0,ry), width:Math.min(tw,rw), height:Math.min(th,rh),
                      border:'2px solid #e8483a', boxShadow:'0 0 0 1px rgba(0,0,0,0.4)' }} />
      </div>
      <div className="flex items-center gap-2 mt-2">
        <input type="number" min={2} max={2000} value={Math.round(zoom*100)} onChange={e=>onZoom(Math.max(2,Math.min(2000,+e.target.value))/100)}
               className="w-12 h-5 text-[10px] text-center outline-none" style={{ background:'#252525', color:C.textDim, border:`1px solid ${C.border}`, borderRadius:2 }} />
        <span className="text-[10px]" style={{ color:C.textDim }}>%</span>
        <RangeSlider min={2} max={2000} value={Math.round(zoom*100)} onChange={v=>onZoom(v/100)}
               className="flex-1" accent={C.accent} trackColor="rgba(255,255,255,0.15)" aria-label="Zoom" />
      </div>
    </div>
  )
}
