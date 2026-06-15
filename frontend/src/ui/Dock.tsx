// Paintsharp primitive: a draggable / dockable panel system shared by every Paintsharp
// sub-editor. Panels are tabs that can be re-docked left/right, merged into a
// tab group, split top/bottom, or torn off as floating windows — with a single
// ghost rectangle showing the exact landing zone during a drag.
//
// The host supplies a panel registry { id → { label, render } } and a default
// arrangement; DockArea owns the layout state, persistence, drag logic and the
// viewport-with-docks row. Panel ids are plain strings (editor-defined).
import { useEffect, useRef, useState } from 'react'
import type { ReactNode, CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import { C as DEFAULT_THEME } from './theme'

export type PanelId = string
export type DockSideKey = 'left' | 'right' | 'float'
export interface DockGroup { id: string; panels: PanelId[]; active: PanelId; x?: number; y?: number }
export interface DockLayout { left: DockGroup[]; right: DockGroup[]; float: DockGroup[] }
export type DropTarget =
  | { type:'tabs';   side:DockSideKey; gid:string }
  | { type:'split';  side:'left'|'right'; gid:string; where:'top'|'bottom' }
  | { type:'newcol'; side:'left'|'right' }
  | { type:'float';  x:number; y:number }

export type DockPanel = { label: ReactNode; render: () => ReactNode }
export type DockController = { activate: (id: PanelId) => void }
type DockTheme = { panel:string; header:string; border:string; text:string; textDim:string }

let _gid = 1
const newGid = () => 'g' + (_gid++)

function activatePanel(layout: DockLayout, id: PanelId): DockLayout {
  const upd = (arr: DockGroup[]) => arr.map(g => g.panels.includes(id) ? { ...g, active:id } : g)
  return { left:upd(layout.left), right:upd(layout.right), float:upd(layout.float) }
}
function removePanel(layout: DockLayout, id: PanelId): DockLayout {
  const strip = (arr: DockGroup[]) => arr
    .map(g => g.panels.includes(id) ? { ...g, panels:g.panels.filter(p=>p!==id), active: g.active===id ? g.panels.filter(p=>p!==id)[0] : g.active } : g)
    .filter(g => g.panels.length > 0)
  return { left:strip(layout.left), right:strip(layout.right), float:strip(layout.float) }
}
function applyDrop(layout: DockLayout, id: PanelId, tgt: DropTarget): DockLayout {
  const L = removePanel(layout, id)
  const mk = (panels: PanelId[]): DockGroup => ({ id:newGid(), panels, active:panels[0] })
  if (tgt.type === 'float') return { ...L, float:[...L.float, { ...mk([id]), x:tgt.x, y:tgt.y }] }
  if (tgt.type === 'newcol') return { ...L, [tgt.side]:[...L[tgt.side], mk([id])] }
  const arr = [...L[tgt.side]]
  const gi = arr.findIndex(g => g.id === tgt.gid)
  if (gi < 0) { // target group vanished (was the dragged panel alone) → recreate as a column entry
    const side = tgt.side === 'float' ? 'right' : tgt.side
    return { ...L, [side]: [...L[side], mk([id])] }
  }
  if (tgt.type === 'tabs') { arr[gi] = { ...arr[gi], panels:[...arr[gi].panels, id], active:id }; return { ...L, [tgt.side]:arr } }
  arr.splice(tgt.where === 'top' ? gi : gi+1, 0, mk([id]))   // split
  return { ...L, [tgt.side]:arr }
}

// Build a layout from a default arrangement (each inner array = one tab group).
function buildDefault(arr: { left?: PanelId[][]; right?: PanelId[][]; float?: PanelId[][] }): DockLayout {
  const mk = (gs?: PanelId[][]) => (gs ?? []).map(panels => ({ id:newGid(), panels:[...panels], active:panels[0] }))
  return { left: mk(arr.left), right: mk(arr.right), float: mk(arr.float) }
}

// Drop any panels no longer in the registry; append any registry panels missing
// from the persisted layout (so newly-added panels always appear). Generic
// replacement for per-editor migrations.
function reconcile(layout: DockLayout, known: Set<PanelId>): DockLayout {
  const sides: DockSideKey[] = ['left','right','float']
  const out: DockLayout = { left:[], right:[], float:[] }
  const present = new Set<PanelId>()
  for (const side of sides) {
    out[side] = layout[side]
      .map(g => {
        const panels = g.panels.filter(p => known.has(p))
        panels.forEach(p => present.add(p))
        return { ...g, panels, active: panels.includes(g.active) ? g.active : panels[0] }
      })
      .filter(g => g.panels.length > 0)
  }
  for (const p of known) if (!present.has(p)) out.right.unshift({ id:newGid(), panels:[p], active:p })
  return out
}

export function DockArea({
  panels, storageKey, defaultArrangement, viewportBg = '#141414', hidden = false,
  theme = DEFAULT_THEME, moveTitle, children, className = 'flex flex-1 min-w-0', style, viewportRef, controllerRef,
}: {
  panels: Record<string, DockPanel>
  storageKey: string
  defaultArrangement: { left?: PanelId[][]; right?: PanelId[][]; float?: PanelId[][] }
  viewportBg?: string
  hidden?: boolean
  theme?: DockTheme
  moveTitle?: string
  children: ReactNode            // the viewport content (canvas, overlays, popovers)
  className?: string
  style?: CSSProperties
  viewportRef?: React.Ref<HTMLDivElement>   // attached to the inner viewport wrapper (for sizing/centering)
  controllerRef?: React.MutableRefObject<DockController | null>   // imperative handle (reveal/activate a panel)
}) {
  const known = new Set(Object.keys(panels))
  const [layout, setLayout] = useState<DockLayout>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(storageKey) || '')
      if (v?.left && v?.right && v?.float) return reconcile(v, known)
    } catch { /* ignore */ }
    return reconcile(buildDefault(defaultArrangement), known)
  })
  const [docking, setDocking] = useState(false)
  const [ghostRect, setGhostRect] = useState<{left:number;top:number;width:number;height:number}|null>(null)
  const dragPanelRef = useRef<PanelId|null>(null)
  const dragStartPt = useRef({x:0,y:0}); const dragMoved = useRef(false)
  const bodyAreaRef = useRef<HTMLDivElement>(null)
  const dragSize = useRef({ w:256, h:300 })
  useEffect(() => { try { localStorage.setItem(storageKey, JSON.stringify(layout)) } catch { /* ignore */ } }, [layout, storageKey])
  // Imperative handle: let the host reveal/activate a panel (e.g. from a menu).
  if (controllerRef) controllerRef.current = { activate: (id) => setLayout(prev => activatePanel(prev, id)) }

  // Hit-test the cursor against rendered group boxes → drop target + ghost rect.
  function computeDropTarget(x:number, y:number): { tgt:DropTarget; rect:{left:number;top:number;width:number;height:number} } {
    const root = bodyAreaRef.current ?? document
    const boxes = Array.from(root.querySelectorAll('[data-grp]')) as HTMLElement[]
    for (const el of boxes) {
      const r = el.getBoundingClientRect()
      if (x>=r.left && x<=r.right && y>=r.top && y<=r.bottom) {
        const side = el.getAttribute('data-side') as DockSideKey
        const gid = el.getAttribute('data-grp')!
        const strip = el.querySelector('[data-strip]') as HTMLElement | null
        const box = { left:r.left, top:r.top, width:r.width, height:r.height }
        if (strip) { const sr = strip.getBoundingClientRect(); if (y <= sr.bottom) return { tgt:{type:'tabs',side,gid}, rect:box } }
        const rel = (y - r.top) / r.height
        if (side!=='float' && rel<0.30) return { tgt:{type:'split',side,gid,where:'top'}, rect:{...box, height:r.height/2} }
        if (side!=='float' && rel>0.70) return { tgt:{type:'split',side,gid,where:'bottom'}, rect:{...box, top:r.top+r.height/2, height:r.height/2} }
        return { tgt:{type:'tabs',side,gid}, rect:box }
      }
    }
    const b = bodyAreaRef.current?.getBoundingClientRect()
    if (b && x < b.left+60)  return { tgt:{type:'newcol',side:'left'},  rect:{left:b.left, top:b.top, width:256, height:b.height} }
    if (b && x > b.right-60)  return { tgt:{type:'newcol',side:'right'}, rect:{left:b.right-256, top:b.top, width:256, height:b.height} }
    return { tgt:{type:'float',x,y}, rect:{left:Math.max(8,x-dragSize.current.w/2), top:Math.max(56,y-14), width:dragSize.current.w, height:dragSize.current.h} }
  }
  function startPanelDrag(panel: PanelId, e: ReactPointerEvent) {
    e.preventDefault()
    dragPanelRef.current = panel; dragStartPt.current = {x:e.clientX,y:e.clientY}; dragMoved.current = false
    const box = (e.currentTarget as HTMLElement).closest('[data-grp]') as HTMLElement | null
    const r = box?.getBoundingClientRect(); dragSize.current = { w:r?.width||256, h:r?.height||300 }
    setDocking(true)
  }
  useEffect(() => {
    if (!docking) return
    const move = (e: PointerEvent) => {
      if (Math.hypot(e.clientX-dragStartPt.current.x, e.clientY-dragStartPt.current.y) > 5) dragMoved.current = true
      setGhostRect(dragMoved.current ? computeDropTarget(e.clientX, e.clientY).rect : null)
    }
    const up = (e: PointerEvent) => {
      const p = dragPanelRef.current
      if (p) {
        if (!dragMoved.current) setLayout(prev => activatePanel(prev, p))           // simple click on a tab → switch
        else { const { tgt } = computeDropTarget(e.clientX, e.clientY); setLayout(prev => applyDrop(prev, p, tgt)) }
      }
      dragPanelRef.current = null; setDocking(false); setGhostRect(null)
    }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
  }, [docking]) // eslint-disable-line react-hooks/exhaustive-deps

  const groupBox = (grp: DockGroup, side: DockSideKey) => (
    <div key={grp.id} data-grp={grp.id} data-side={side} className="flex flex-col min-h-0" style={{ flex: side==='float' ? '1 1 auto' : 1 }}>
      <div data-strip className="flex flex-shrink-0 flex-wrap" style={{ background:theme.header, borderBottom:`1px solid ${theme.border}` }}>
        {grp.panels.map(p => (
          <button key={p} onPointerDown={(e)=>startPanelDrag(p, e)} title={moveTitle}
                  className="px-2.5 h-7 text-[11px] font-medium cursor-grab"
                  style={{ color: grp.active===p?theme.text:theme.textDim, background: grp.active===p?theme.panel:'transparent', borderRight:`1px solid ${theme.border}` }}>
            {panels[p]?.label}
          </button>
        ))}
      </div>
      <div className="flex flex-col flex-1 min-h-0 overflow-y-auto">{panels[grp.active]?.render()}</div>
    </div>
  )
  const column = (side: 'left'|'right') => {
    const groups = layout[side]; if (!groups.length) return null
    return (
      <div key={side} className="flex flex-col flex-shrink-0"
           style={{ width:256, background:theme.panel, order: side==='left'?0:2,
                    borderLeft: side==='right'?`1px solid ${theme.border}`:'none',
                    borderRight: side==='left'?`1px solid ${theme.border}`:'none' }}>
        {groups.map(grp => groupBox(grp, side))}
      </div>
    )
  }
  const floats = layout.float.map(grp => (
    <div key={grp.id} className="fixed flex flex-col shadow-2xl"
         style={{ left:grp.x, top:grp.y, width:256, maxHeight:'72vh', background:theme.panel,
                  border:`1px solid ${theme.border}`, borderRadius:5, zIndex:80 }}>
      {groupBox(grp, 'float')}
    </div>
  ))

  return (
    <>
      <div className={className} style={style} ref={bodyAreaRef}>
        <div className="flex-1 relative overflow-hidden" style={{ background:viewportBg, order:1 }} ref={viewportRef}>
          {children}
        </div>
        {!hidden && column('left')}
        {!hidden && column('right')}
        {!hidden && floats}
      </div>
      {/* Single ghost rectangle = exact landing zone of the dragged panel. */}
      {docking && ghostRect && (
        <div className="fixed inset-0 z-[100]" style={{ cursor:'grabbing' }}>
          <div className="absolute" style={{ left:ghostRect.left, top:ghostRect.top, width:ghostRect.width, height:ghostRect.height,
                        background:'rgba(90,160,255,0.22)', border:'2px solid rgba(90,160,255,0.95)', borderRadius:4 }} />
        </div>
      )}
    </>
  )
}
