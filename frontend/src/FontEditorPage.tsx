// FontEditor — the PaintSharp type-design sub-editor (FontForge/Glyphr-style):
// a glyph overview grid, a Bézier glyph editor with vertical metrics and
// draggable advance width, kerning pairs, a live text preview and OTF export.
// Same UI/UX shell as Apex: EditorShell + DockArea + tool rail + options bar.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  MousePointer, Spline, PenTool, Square, Circle, Hand, Search, Star, Trash2,
  Magnet, Grid3x3, PaintBucket, ZoomIn, ZoomOut, FlipHorizontal, FlipVertical,
  Copy, ClipboardPaste, X, RefreshCw, Grid2x2, Pencil,
} from 'lucide-react'
import type { TFunction } from 'i18next'
import { ConfirmDialog } from '@ui'
import { fontApi, type FontContour, type FontData, type FontGlyph, type FontGlyphPoint } from './api'
import type { FontFileFormat } from './fontFormats'
import { C as SHELL_C, EditorShell, DockArea, paintsharpMenus, useContextMenu, type CtxItem } from './ui'
import { useDebouncedAutosave } from './useAutosave'
import {
  buildGlyphPath, closestOnSegment, contoursBounds, countDrawnGlyphs,
  defaultAdvance, offsetContours, pathfinderContours, reverseContour,
  simplifyContour, smoothContour, splitSegment, type PathfinderOp,
} from './fontGeometry'

const C = SHELL_C

type Tool = 'select' | 'node' | 'pen' | 'pencil' | 'rect' | 'ellipse' | 'hand' | 'zoom'

interface CanvasState { zoom: number; panX: number; panY: number }

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i)

// Export formats offered in the Fichier menu (kept local so the heavy
// fontFormats/opentype/fonteditor-core chunk stays lazy).
const EXPORT_FORMATS: FontFileFormat[] = ['otf', 'ttf', 'woff', 'woff2', 'eot', 'svg']
const IMPORT_ACCEPT = '.ttf,.otf,.woff,.woff2,.eot,.svg'

// Character set shown in the overview grid (FontForge-style template cells).
const SECTIONS: { key: string; cps: number[] }[] = [
  { key: 'font_sec_upper',  cps: range(65, 90) },
  { key: 'font_sec_lower',  cps: range(97, 122) },
  { key: 'font_sec_digits', cps: range(48, 57) },
  { key: 'font_sec_punct',  cps: [
    ...range(32, 47), ...range(58, 64), ...range(91, 96), ...range(123, 126),
    0xA1, 0xBF, 0xAB, 0xBB, 0x2018, 0x2019, 0x201C, 0x201D, 0x2013, 0x2014, 0x2026, 0x20AC,
  ] },
  { key: 'font_sec_accents', cps: [
    ...range(0xC0, 0xFF).filter(c => c !== 0xD7 && c !== 0xF7), 0x152, 0x153,
  ] },
]

function cloneFont(f: FontData): FontData { return JSON.parse(JSON.stringify(f)) as FontData }

function charLabel(cp: number): string {
  return cp === 32 ? '␣' : String.fromCodePoint(cp)
}

// ── Mini glyph cell (overview grid + glyphs panel) ──────────────────────────────
function GlyphCell({ font, cp, size, active, showLabel, onOpen, onContextMenu }: {
  font: FontData; cp: number; size: number; active?: boolean; showLabel?: boolean
  onOpen: (cp: number) => void
  onContextMenu?: (e: React.MouseEvent, cp: number) => void
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const glyph = font.glyphs[String(cp)]
  const drawn = !!glyph && glyph.contours.length > 0

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = size * dpr
    canvas.height = size * dpr
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, size, size)
    const upem = font.unitsPerEm || 1000
    if (drawn) {
      const scale = (size * 0.62) / upem
      const adv = glyph.advance ?? upem * 0.5
      const ox = (size - adv * scale) / 2
      const oy = size * 0.74
      const path = buildGlyphPath(glyph.contours, (x, y) => [ox + x * scale, oy - y * scale])
      ctx.fillStyle = C.text
      ctx.fill(path, 'evenodd')
    } else {
      // Template character (greyed placeholder, FontForge-style).
      ctx.fillStyle = 'rgba(142,142,142,0.28)'
      ctx.font = `${Math.round(size * 0.56)}px system-ui, sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'alphabetic'
      ctx.fillText(String.fromCodePoint(cp), size / 2, size * 0.72)
    }
  }, [font, cp, size, drawn, glyph])

  return (
    <button
      onClick={() => onOpen(cp)}
      onContextMenu={e => onContextMenu?.(e, cp)}
      title={`U+${cp.toString(16).toUpperCase().padStart(4, '0')}`}
      className="flex flex-col items-center rounded transition-colors"
      style={{
        background: active ? C.accent + '26' : C.panel,
        border: `1px solid ${active ? C.accent : C.border}`,
        padding: 2,
      }}
    >
      <canvas ref={ref} style={{ width: size, height: size, display: 'block' }} />
      {showLabel && (
        <span className="text-[10px] leading-tight" style={{ color: drawn ? C.text : C.textDim }}>
          {charLabel(cp)}
        </span>
      )}
    </button>
  )
}

// ── Text preview panel ──────────────────────────────────────────────────────────
// The canvas is sized from its OWN box (not the padded panel) and the text is
// word-wrapped with the font's real advances + kerning, so nothing ever spills
// out of the panel however narrow it gets.
const PREVIEW_PAD = 10

function PreviewPanel({ font, t }: { font: FontData; t: TFunction }) {
  const [text, setText] = useState('Abc 123')
  const [size, setSize] = useState(72)
  const ref = useRef<HTMLCanvasElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const [hostW, setHostW] = useState(0)

  // Track the canvas host width (the dock panel is resizable).
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const ro = new ResizeObserver(() => setHostW(host.clientWidth))
    ro.observe(host)
    setHostW(host.clientWidth)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const canvas = ref.current
    if (!canvas || hostW <= 0) return
    const upem = font.unitsPerEm || 1000
    const scale = size / upem
    const kern = new Map(font.kerning.map(k => [`${k.left}:${k.right}`, k.value]))
    const missingW = upem * 0.45 * scale + 6          // tofu box + gap
    const advanceOf = (cp: number): number => {
      const g = font.glyphs[String(cp)]
      if (g && g.contours.length > 0) return (g.advance ?? upem * 0.5) * scale
      if (cp === 32) return (g?.advance ?? upem * 0.3) * scale
      return missingW
    }
    const kernOf = (a: number, b?: number) => (b == null ? 0 : (kern.get(`${a}:${b}`) ?? 0) * scale)

    // Word-wrap on the available width, keeping the author's explicit newlines.
    const avail = Math.max(40, hostW - PREVIEW_PAD * 2)
    const runW = (cps: number[]) =>
      cps.reduce((w, c, i) => w + advanceOf(c) + kernOf(c, cps[i + 1]), 0)
    const lines: number[][] = []
    for (const raw of text.split('\n')) {
      const words = raw.split(/(\s+)/).filter(w => w !== '')
      let cur: number[] = []
      for (const word of words) {
        const wcps = [...word].map(ch => ch.codePointAt(0)!)
        if (cur.length && runW([...cur, ...wcps]) > avail) {
          lines.push(cur)
          cur = /^\s+$/.test(word) ? [] : wcps      // a wrapped line never starts with a space
        } else cur.push(...wcps)
        // A single word longer than the line: hard-break it glyph by glyph.
        while (runW(cur) > avail && cur.length > 1) {
          const overflow: number[] = []
          while (cur.length > 1 && runW(cur) > avail) overflow.unshift(cur.pop()!)
          lines.push(cur)
          cur = overflow
        }
      }
      lines.push(cur)
    }

    const lineH = size * 1.35
    const w = hostW
    const h = Math.max(60, lines.length * lineH + size * 0.45)
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    canvas.style.width = `${w}px`
    canvas.style.height = `${h}px`
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    let baseline = size * 1.05
    for (const cps of lines) {
      let pen = PREVIEW_PAD
      for (let i = 0; i < cps.length; i++) {
        const cp = cps[i]
        const g = font.glyphs[String(cp)]
        if (g && g.contours.length > 0) {
          const path = buildGlyphPath(g.contours, (x, y) => [pen + x * scale, baseline - y * scale])
          ctx.fillStyle = C.text
          ctx.fill(path, 'evenodd')
        } else if (cp !== 32) {
          // Missing glyph → tofu box.
          const bw = upem * 0.45 * scale, bh = (font.capHeight || upem * 0.7) * scale
          ctx.strokeStyle = 'rgba(142,142,142,0.5)'
          ctx.lineWidth = 1
          ctx.strokeRect(pen + 2, baseline - bh, bw, bh)
        }
        pen += advanceOf(cp) + kernOf(cp, cps[i + 1])
      }
      baseline += lineH
    }
  }, [font, text, size, hostW])

  return (
    <div className="flex flex-col gap-2 p-2 h-full overflow-y-auto overflow-x-hidden">
      <textarea
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder={t('font_preview_placeholder')}
        rows={2}
        className="w-full text-sm px-2 py-1.5 rounded outline-none resize-y"
        style={{ background: '#252525', color: C.text, border: `1px solid ${C.border}` }}
      />
      <label className="flex items-center gap-2 text-[11px]" style={{ color: C.textDim }}>
        <span className="flex-shrink-0">{t('font_preview_size')}</span>
        <input type="range" min={12} max={180} value={size} onChange={e => setSize(+e.target.value)}
               className="flex-1 min-w-0" style={{ accentColor: C.accent }} />
        <span className="w-7 text-right flex-shrink-0" style={{ color: C.text }}>{size}</span>
      </label>
      <div ref={hostRef} className="rounded w-full overflow-hidden"
           style={{ background: '#181818', border: `1px solid ${C.border}` }}>
        <canvas ref={ref} className="block max-w-full" />
      </div>
    </div>
  )
}

// ── Kerning panel ───────────────────────────────────────────────────────────────
function KerningPanel({ font, commit, t }: {
  font: FontData
  commit: (mut: (f: FontData) => void) => void
  t: TFunction
}) {
  const [left, setLeft] = useState('A')
  const [right, setRight] = useState('V')
  const [value, setValue] = useState(-50)
  const ref = useRef<HTMLCanvasElement>(null)
  const ctxMenu = useContextMenu()

  const lcp = left.codePointAt(0), rcp = right.codePointAt(0)

  // Live preview of the pair with the pending value applied.
  useEffect(() => {
    const canvas = ref.current
    if (!canvas || lcp == null || rcp == null) return
    const w = 200, h = 84, size = 64
    const dpr = window.devicePixelRatio || 1
    canvas.width = w * dpr; canvas.height = h * dpr
    canvas.style.width = `${w}px`; canvas.style.height = `${h}px`
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    const upem = font.unitsPerEm || 1000
    const scale = size / upem
    let pen = 16
    const baseline = h * 0.78
    for (const [i, cp] of [lcp, rcp].entries()) {
      const g = font.glyphs[String(cp)]
      if (g && g.contours.length > 0) {
        const path = buildGlyphPath(g.contours, (x, y) => [pen + x * scale, baseline - y * scale])
        ctx.fillStyle = C.text
        ctx.fill(path, 'evenodd')
        pen += (g.advance ?? upem * 0.5) * scale
      } else {
        ctx.fillStyle = 'rgba(142,142,142,0.4)'
        ctx.font = `${size}px system-ui, sans-serif`
        ctx.fillText(String.fromCodePoint(cp), pen, baseline)
        pen += size * 0.55
      }
      if (i === 0) pen += value * scale
    }
  }, [font, lcp, rcp, value])

  const chInput = (v: string, set: (s: string) => void, label: string) => (
    <label className="flex flex-col gap-0.5 text-[10px]" style={{ color: C.textDim }}>
      {label}
      <input value={v} maxLength={2}
             onChange={e => set([...e.target.value].slice(-1).join(''))}
             className="w-10 h-7 text-center text-xs rounded outline-none"
             style={{ background: '#252525', color: C.text, border: `1px solid ${C.border}` }} />
    </label>
  )

  return (
    <div className="flex flex-col gap-2 p-2 h-full overflow-y-auto">
      <div className="flex items-end gap-2">
        {chInput(left, setLeft, t('font_kern_left'))}
        {chInput(right, setRight, t('font_kern_right'))}
        <label className="flex flex-col gap-0.5 text-[10px] flex-1" style={{ color: C.textDim }}>
          {t('font_kern_value')}
          <input type="number" value={value} onChange={e => setValue(Math.round(+e.target.value) || 0)}
                 className="w-full h-7 text-center text-xs rounded outline-none"
                 style={{ background: '#252525', color: C.text, border: `1px solid ${C.border}` }} />
        </label>
      </div>
      <div className="rounded self-start max-w-full overflow-hidden"
           style={{ background: '#181818', border: `1px solid ${C.border}` }}>
        <canvas ref={ref} className="block max-w-full" />
      </div>
      <button
        disabled={lcp == null || rcp == null}
        onClick={() => {
          if (lcp == null || rcp == null) return
          commit(f => {
            f.kerning = f.kerning.filter(k => !(k.left === lcp && k.right === rcp))
            if (value !== 0) f.kerning.push({ left: lcp, right: rcp, value })
          })
        }}
        className="px-2 py-1.5 rounded text-[11px]"
        style={{ background: C.accent, color: '#fff' }}
      >
        {t('font_kern_add')}
      </button>
      <div className="h-px" style={{ background: C.border }} />
      {font.kerning.length === 0 && (
        <p className="text-[11px] text-center py-2" style={{ color: C.textDim }}>{t('font_kern_empty')}</p>
      )}
      {font.kerning.map((k, i) => {
        const edit = () => { setLeft(String.fromCodePoint(k.left)); setRight(String.fromCodePoint(k.right)); setValue(k.value) }
        const remove = () => commit(f => { f.kerning.splice(i, 1) })
        return (
          <div key={`${k.left}:${k.right}`} className="flex items-center gap-2 px-1 py-0.5 rounded hover:bg-white/5"
               onContextMenu={e => ctxMenu.open(e, [
                 { label: t('font_kern_edit'), onClick: edit },
                 { label: t('font_kern_tighten'), onClick: () => commit(f => { const p = f.kerning[i]; if (p) p.value -= 10 }) },
                 { label: t('font_kern_loosen'),  onClick: () => commit(f => { const p = f.kerning[i]; if (p) p.value += 10 }) },
                 'sep',
                 { label: t('font_kern_remove'), onClick: remove, danger: true },
               ])}>
            <button className="text-xs flex-1 text-left" style={{ color: C.text }} onClick={edit}>
              {String.fromCodePoint(k.left)}{String.fromCodePoint(k.right)}
              <span className="ml-2 text-[11px]" style={{ color: C.textDim }}>{k.value}</span>
            </button>
            <button title={t('font_kern_remove')} onClick={remove}
                    className="w-5 h-5 rounded flex items-center justify-center hover:bg-white/10"
                    style={{ color: C.textDim }}>
              <X size={11} />
            </button>
          </div>
        )
      })}
      {ctxMenu.menu}
    </div>
  )
}

// Compact label+number row for the properties panel.
function NumRow({ label, value, onCommit, min = -10000, max = 10000 }: {
  label: string; value: number; onCommit: (v: number) => void; min?: number; max?: number
}) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => { setDraft(String(value)) }, [value])
  const commitDraft = () => {
    const v = Math.round(+draft)
    if (Number.isFinite(v)) onCommit(Math.max(min, Math.min(max, v)))
    else setDraft(String(value))
  }
  return (
    <label className="flex items-center justify-between gap-2 text-[11px]" style={{ color: C.textDim }}>
      <span className="truncate">{label}</span>
      <input type="number" value={draft}
             onChange={e => setDraft(e.target.value)}
             onBlur={commitDraft}
             onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
             className="w-16 h-6 text-[11px] text-center rounded outline-none flex-shrink-0"
             style={{ background: '#252525', color: C.text, border: `1px solid ${C.border}` }} />
    </label>
  )
}

function TextRow({ label, value, onCommit }: { label: string; value: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => { setDraft(value) }, [value])
  return (
    <label className="flex items-center justify-between gap-2 text-[11px]" style={{ color: C.textDim }}>
      <span className="truncate">{label}</span>
      <input value={draft}
             onChange={e => setDraft(e.target.value)}
             onBlur={() => { if (draft.trim()) onCommit(draft.trim()); else setDraft(value) }}
             onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
             className="w-28 h-6 text-[11px] px-1.5 rounded outline-none flex-shrink-0"
             style={{ background: '#252525', color: C.text, border: `1px solid ${C.border}` }} />
    </label>
  )
}

// ── Vertical metric guides (draggable on the canvas) ────────────────────────────
type MetricKey = 'ascender' | 'capHeight' | 'xHeight' | 'descender'
const METRIC_KEYS: MetricKey[] = ['ascender', 'capHeight', 'xHeight', 'descender']
const METRIC_LABELS: Record<MetricKey, string> = {
  ascender:  'font_ascender',
  capHeight: 'font_capheight',
  xHeight:   'font_xheight',
  descender: 'font_descender',
}

/** Keeps the guides consistently ordered: descender < 0 < xHeight < capHeight < ascender. */
function clampMetric(f: FontData, key: MetricKey, v: number): number {
  switch (key) {
    case 'ascender':  return Math.max(f.capHeight + 10, v)
    case 'capHeight': return Math.min(f.ascender - 10, Math.max(f.xHeight + 10, v))
    case 'xHeight':   return Math.min(f.capHeight - 10, Math.max(10, v))
    case 'descender': return Math.min(-10, v)
  }
}

// ── Drag state ──────────────────────────────────────────────────────────────────
type DragState =
  | { type: 'pan'; sx: number; sy: number; orig: CanvasState }
  | { type: 'pen-handle'; index: number; start: [number, number] }
  | { type: 'advance'; origJson: string }
  | { type: 'metric'; key: MetricKey; origJson: string }
  | { type: 'move-points'; start: [number, number]; origJson: string }
  | { type: 'move-contours'; start: [number, number]; origJson: string }
  | { type: 'handle'; ci: number; pi: number; side: 'hIn' | 'hOut'; mirrored: boolean; origJson: string }
  | { type: 'shape'; x0: number; y0: number }
  | { type: 'marquee'; x0: number; y0: number }
  | { type: 'pencil' }

// ── Main editor page ────────────────────────────────────────────────────────────
export default function FontEditorPage() {
  const { t } = useTranslation('paintsharp')
  const { id: projectId } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()

  const { data: project } = useQuery({
    queryKey: ['font-project', projectId],
    queryFn:  () => fontApi.getProject(projectId!).then(r => r.data),
    enabled:  !!projectId,
  })

  // ── Document state ────────────────────────────────────────────────────────────
  const [font, setFont] = useState<FontData | null>(null)
  const loadedRef = useRef(false)
  useEffect(() => {
    if (project?.data && !loadedRef.current) {
      loadedRef.current = true
      setFont(project.data)
    }
  }, [project])

  // ── Title / star / trash (standard WorkspaceShell wiring, as in Apex) ─────────
  const [titleDraft, setTitleDraft] = useState('')
  useEffect(() => { if (project?.title != null) setTitleDraft(project.title) }, [project?.title])
  const renameMut = useMutation({
    mutationFn: (title: string) => fontApi.updateProject(projectId!, { title }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['font-project', projectId] }) },
  })
  const starMut = useMutation({
    mutationFn: (is_starred: boolean) => fontApi.updateProject(projectId!, { is_starred }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['font-project', projectId] }) },
  })
  const trashMut = useMutation({
    mutationFn: () => fontApi.trashProject(projectId!),
    onSuccess: () => { navigate('/paintsharp/fonteditor') },
  })
  const commitTitle = () => {
    const v = titleDraft.trim()
    if (v && v !== project?.title) renameMut.mutate(v)
    else if (!v && project?.title) setTitleDraft(project.title)
  }

  // ── Editor state ──────────────────────────────────────────────────────────────
  const [view, setView] = useState<'grid' | number>('grid')
  const [openTabs, setOpenTabs] = useState<number[]>([])
  const [tool, setTool] = useState<Tool>('select')
  const [cs, setCs] = useState<CanvasState>({ zoom: 0.4, panX: 120, panY: 420 })
  const [sel, setSel] = useState<{ contours: number[]; points: string[] }>({ contours: [], points: [] })
  const [penPts, setPenPts] = useState<FontGlyphPoint[] | null>(null)
  const [penMouse, setPenMouse] = useState<[number, number] | null>(null)
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const [shapeDraft, setShapeDraft] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const [pencilPts, setPencilPts] = useState<[number, number][] | null>(null)
  // The freehand samples are ALSO mirrored in a ref: pointerup needs the full
  // trace even if React hasn't re-rendered the last few pointermoves yet.
  const pencilPtsRef = useRef<[number, number][] | null>(null)
  useEffect(() => { pencilPtsRef.current = pencilPts }, [pencilPts])
  const [showFill, setShowFill] = useState(true)
  const [showGrid, setShowGrid] = useState(false)
  const [snapOn, setSnapOn] = useState(true)
  const [exportNote, setExportNote] = useState<string | null>(null)
  // Guide (metric line / advance line) hovered or being dragged — drives the
  // highlight and the resize cursor.
  const [hotGuide, setHotGuide] = useState<MetricKey | 'advance' | null>(null)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const clipboardRef = useRef<FontContour[] | null>(null)
  const historyRef = useRef<{ undo: string[]; redo: string[] }>({ undo: [], redo: [] })
  const spaceRef = useRef(false)

  // Mirrors kept in refs for pointer handlers.
  const fontRef = useRef(font);       useEffect(() => { fontRef.current = font }, [font])
  const csRef = useRef(cs);           useEffect(() => { csRef.current = cs }, [cs])
  const toolRef = useRef(tool);       useEffect(() => { toolRef.current = tool }, [tool])
  const selRef = useRef(sel);         useEffect(() => { selRef.current = sel }, [sel])
  const viewRef = useRef(view);       useEffect(() => { viewRef.current = view }, [view])
  const penRef = useRef(penPts);      useEffect(() => { penRef.current = penPts }, [penPts])
  const snapRef = useRef(snapOn);     useEffect(() => { snapRef.current = snapOn }, [snapOn])

  const cp = typeof view === 'number' ? view : null
  const glyph: FontGlyph | null = font && cp != null ? font.glyphs[String(cp)] ?? null : null
  const advance = glyph?.advance ?? (font && cp != null ? defaultAdvance(font, cp) : 600)
  const advanceRef = useRef(advance); useEffect(() => { advanceRef.current = advance }, [advance])

  // ── History / commit ──────────────────────────────────────────────────────────
  const pushHistory = useCallback((snapshotJson: string) => {
    const h = historyRef.current
    h.undo.push(snapshotJson)
    if (h.undo.length > 100) h.undo.shift()
    h.redo = []
  }, [])

  const commit = useCallback((mut: (f: FontData) => void) => {
    setFont(prev => {
      if (!prev) return prev
      pushHistory(JSON.stringify(prev))
      const next = cloneFont(prev)
      mut(next)
      return next
    })
  }, [pushHistory])

  const undo = useCallback(() => {
    const h = historyRef.current
    const snap = h.undo.pop()
    if (!snap || !fontRef.current) return
    h.redo.push(JSON.stringify(fontRef.current))
    setFont(JSON.parse(snap) as FontData)
    setSel({ contours: [], points: [] })
  }, [])

  const redo = useCallback(() => {
    const h = historyRef.current
    const snap = h.redo.pop()
    if (!snap || !fontRef.current) return
    h.undo.push(JSON.stringify(fontRef.current))
    setFont(JSON.parse(snap) as FontData)
    setSel({ contours: [], points: [] })
  }, [])

  const ensureGlyph = useCallback((f: FontData, code: number): FontGlyph => {
    const key = String(code)
    if (!f.glyphs[key]) f.glyphs[key] = { unicode: code, advance: defaultAdvance(f, code), contours: [] }
    return f.glyphs[key]
  }, [])

  // ── Autosave (debounced) + thumbnail ──────────────────────────────────────────
  const saveMut = useMutation({
    mutationFn: (data: FontData) => fontApi.saveData(projectId!, data, countDrawnGlyphs(data)),
  })
  const lastThumbRef = useRef(0)
  const regenThumbnail = useCallback((data: FontData) => {
    if (!projectId) return
    const now = Date.now()
    if (now - lastThumbRef.current < 8000) return
    lastThumbRef.current = now
    const w = 320, h = 180
    const canvas = document.createElement('canvas')
    canvas.width = w; canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.fillStyle = '#1e1e1e'
    ctx.fillRect(0, 0, w, h)
    const drawnCps = Object.values(data.glyphs).filter(g => g.contours.length > 0)
      .sort((a, b) => a.unicode - b.unicode).slice(0, 6)
    if (!drawnCps.length) return
    const upem = data.unitsPerEm || 1000
    const scale = 110 / upem
    const total = drawnCps.reduce((s, g) => s + (g.advance ?? upem * 0.5) * scale, 0)
    let pen = Math.max(12, (w - total) / 2)
    const baseline = h * 0.72
    for (const g of drawnCps) {
      const path = buildGlyphPath(g.contours, (x, y) => [pen + x * scale, baseline - y * scale])
      ctx.fillStyle = '#d6d6d6'
      ctx.fill(path, 'evenodd')
      pen += (g.advance ?? upem * 0.5) * scale
    }
    fontApi.updateProject(projectId, { thumbnail_path: canvas.toDataURL('image/png') }).catch(() => {})
  }, [projectId])

  const flushSave = useDebouncedAutosave(font, !!font && !!projectId, (data) => {
    if (!data) return
    saveMut.mutate(data)
    regenThumbnail(data)
  }, 1500)

  const saveNow = useCallback(() => {
    if (fontRef.current && projectId) {
      saveMut.mutate(fontRef.current)
      regenThumbnail(fontRef.current)
    }
  }, [projectId, regenThumbnail]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Coordinate mapping ────────────────────────────────────────────────────────
  const toScreen = useCallback((x: number, y: number, c: CanvasState = csRef.current): [number, number] =>
    [c.panX + x * c.zoom, c.panY - y * c.zoom], [])
  const toFont = useCallback((sx: number, sy: number, c: CanvasState = csRef.current): [number, number] =>
    [(sx - c.panX) / c.zoom, (c.panY - sy) / c.zoom], [])

  const snapPt = useCallback((x: number, y: number): [number, number] => {
    let X = Math.round(x), Y = Math.round(y)
    const f = fontRef.current
    if (snapRef.current && f) {
      const tol = 6 / csRef.current.zoom
      for (const gx of [0, advanceRef.current]) if (Math.abs(x - gx) < tol) X = gx
      for (const gy of [0, f.xHeight, f.capHeight, f.ascender, f.descender]) if (Math.abs(y - gy) < tol) Y = gy
    }
    return [X, Y]
  }, [])

  // Fit the em box in the canvas.
  const centerGlyph = useCallback((adv: number) => {
    const canvas = canvasRef.current
    const f = fontRef.current
    if (!canvas || !f) return
    const { width: cw, height: ch } = canvas.getBoundingClientRect()
    if (!cw || !ch) return
    const pad = 70
    const spanX = Math.max(adv + 200, f.unitsPerEm)
    const spanY = (f.ascender - f.descender) + 240
    const zoom = Math.min((cw - pad) / spanX, (ch - pad) / spanY)
    const panX = (cw - adv * zoom) / 2
    const panY = ch / 2 + ((f.ascender + f.descender) / 2) * zoom
    setCs({ zoom, panX, panY })
  }, [])

  const openGlyph = useCallback((code: number) => {
    setView(code)
    setOpenTabs(prev => (prev.includes(code) ? prev : [...prev, code]))
    setSel({ contours: [], points: [] })
    setPenPts(null)
    const f = fontRef.current
    const adv = f?.glyphs[String(code)]?.advance ?? (f ? defaultAdvance(f, code) : 600)
    setTimeout(() => centerGlyph(adv), 30)
  }, [centerGlyph])

  const closeTab = useCallback((code: number) => {
    setOpenTabs(prev => prev.filter(c => c !== code))
    setView(v => (v === code ? 'grid' : v))
  }, [])

  const zoomAt = useCallback((sx: number, sy: number, factor: number) => {
    setCs(prev => {
      const nz = Math.max(0.03, Math.min(12, prev.zoom * factor))
      const k = nz / prev.zoom
      return { zoom: nz, panX: sx - (sx - prev.panX) * k, panY: sy - (sy - prev.panY) * k }
    })
  }, [])

  // ── Selection helpers / edit operations ───────────────────────────────────────
  const selectedContourIdxs = useCallback((): number[] => {
    const s = selRef.current
    const set = new Set<number>(s.contours)
    for (const key of s.points) set.add(+key.split(':')[0])
    return [...set]
  }, [])

  const targetContourIdxs = useCallback((): number[] => {
    const g = cp != null && fontRef.current ? fontRef.current.glyphs[String(cp)] : null
    if (!g) return []
    const selIdx = selectedContourIdxs()
    return selIdx.length ? selIdx : g.contours.map((_, i) => i)
  }, [cp, selectedContourIdxs])

  const flipSel = useCallback((axis: 'h' | 'v') => {
    if (cp == null) return
    const idxs = targetContourIdxs()
    if (!idxs.length) return
    commit(f => {
      const g = ensureGlyph(f, cp)
      const targets = idxs.map(i => g.contours[i]).filter(Boolean)
      const b = contoursBounds(targets)
      if (!b) return
      const mx = (p: [number, number]): [number, number] =>
        axis === 'h' ? [b.minX + b.maxX - p[0], p[1]] : [p[0], b.minY + b.maxY - p[1]]
      for (const c of targets) {
        for (const p of c) {
          const [x, y] = mx([p.x, p.y])
          p.x = Math.round(x); p.y = Math.round(y)
          if (p.hIn)  { const [hx, hy] = mx(p.hIn);  p.hIn  = [Math.round(hx), Math.round(hy)] }
          if (p.hOut) { const [hx, hy] = mx(p.hOut); p.hOut = [Math.round(hx), Math.round(hy)] }
        }
      }
    })
  }, [cp, commit, ensureGlyph, targetContourIdxs])

  const reverseSel = useCallback(() => {
    if (cp == null) return
    const idxs = targetContourIdxs()
    if (!idxs.length) return
    commit(f => {
      const g = ensureGlyph(f, cp)
      for (const i of idxs) if (g.contours[i]) g.contours[i] = reverseContour(g.contours[i])
    })
  }, [cp, commit, ensureGlyph, targetContourIdxs])

  const clearGlyph = useCallback(() => {
    if (cp == null) return
    setSel({ contours: [], points: [] })
    commit(f => { const g = f.glyphs[String(cp)]; if (g) g.contours = [] })
  }, [cp, commit])

  const copySel = useCallback(() => {
    const g = cp != null && fontRef.current ? fontRef.current.glyphs[String(cp)] : null
    if (!g) return
    const idxs = targetContourIdxs()
    clipboardRef.current = JSON.parse(JSON.stringify(idxs.map(i => g.contours[i]).filter(Boolean))) as FontContour[]
  }, [cp, targetContourIdxs])

  const pasteSel = useCallback(() => {
    if (cp == null || !clipboardRef.current?.length) return
    const pasted = clipboardRef.current
    const prevLen = fontRef.current?.glyphs[String(cp)]?.contours.length ?? 0
    commit(f => {
      const g = ensureGlyph(f, cp)
      g.contours.push(...(JSON.parse(JSON.stringify(pasted)) as FontContour[]))
    })
    setSel({ contours: pasted.map((_, i) => prevLen + i), points: [] })
  }, [cp, commit, ensureGlyph])

  const cutSel = useCallback(() => {
    if (cp == null) return
    const g = fontRef.current?.glyphs[String(cp)]
    if (!g) return
    const idxs = targetContourIdxs()
    if (!idxs.length) return
    clipboardRef.current = JSON.parse(JSON.stringify(idxs.map(i => g.contours[i]).filter(Boolean))) as FontContour[]
    const dead = new Set(idxs)
    commit(f => {
      const gg = f.glyphs[String(cp)]
      if (gg) gg.contours = gg.contours.filter((_, i) => !dead.has(i))
    })
    setSel({ contours: [], points: [] })
  }, [cp, commit, targetContourIdxs])

  const duplicateSel = useCallback(() => {
    if (cp == null) return
    const f0 = fontRef.current
    const g = f0?.glyphs[String(cp)]
    if (!f0 || !g) return
    const idxs = targetContourIdxs()
    if (!idxs.length) return
    const off = Math.max(1, Math.round((f0.unitsPerEm || 1000) / 40))
    const shift = (h: [number, number]): [number, number] => [h[0] + off, h[1] - off]
    const copies: FontContour[] = idxs.map(i => g.contours[i]).filter(Boolean).map(c => c.map(p => ({
      x: p.x + off, y: p.y - off,
      ...(p.hIn  ? { hIn:  shift(p.hIn)  } : {}),
      ...(p.hOut ? { hOut: shift(p.hOut) } : {}),
    })))
    const prevLen = g.contours.length
    commit(f => { ensureGlyph(f, cp).contours.push(...(JSON.parse(JSON.stringify(copies)) as FontContour[])) })
    setSel({ contours: copies.map((_, i) => prevLen + i), points: [] })
  }, [cp, commit, ensureGlyph, targetContourIdxs])

  // ── Point-level ops (node tool: double-click and context menu) ────────────────
  const togglePointSmooth = useCallback((ci: number, pi: number) => {
    if (cp == null) return
    commit(f => {
      const g = f.glyphs[String(cp)]
      const pt = g?.contours[ci]?.[pi]
      if (!g || !pt) return
      if (pt.hIn || pt.hOut) { delete pt.hIn; delete pt.hOut }
      else {
        const c = g.contours[ci]
        const prev = c[(pi - 1 + c.length) % c.length]
        const next = c[(pi + 1) % c.length]
        const dx = next.x - prev.x, dy = next.y - prev.y
        const len = Math.hypot(dx, dy) || 1
        const hl = Math.max(20, len / 4)
        pt.hOut = [Math.round(pt.x + (dx / len) * hl), Math.round(pt.y + (dy / len) * hl)]
        pt.hIn  = [Math.round(pt.x - (dx / len) * hl), Math.round(pt.y - (dy / len) * hl)]
      }
    })
  }, [cp, commit])

  const insertPointOnSegment = useCallback((ci: number, pi: number, tt: number) => {
    if (cp == null) return
    commit(f => {
      const c = f.glyphs[String(cp)]?.contours[ci]
      if (!c) return
      const a = c[pi], b = c[(pi + 1) % c.length]
      const r = splitSegment(a, b, tt)
      c[pi] = r.a
      c[(pi + 1) % c.length] = r.b
      c.splice(pi + 1, 0, r.mid)
    })
  }, [cp, commit])

  const deletePointAt = useCallback((ci: number, pi: number) => {
    if (cp == null) return
    commit(f => {
      const g = f.glyphs[String(cp)]
      const c = g?.contours[ci]
      if (!g || !c) return
      if (c.length <= 3) g.contours.splice(ci, 1)
      else c.splice(pi, 1)
    })
    setSel({ contours: [], points: [] })
  }, [cp, commit])

  // ── Glyph-level ops (overview grid / glyphs panel context menu) ───────────────
  const copyGlyphAt = useCallback((code: number) => {
    const g = fontRef.current?.glyphs[String(code)]
    clipboardRef.current = g ? (JSON.parse(JSON.stringify(g.contours)) as FontContour[]) : []
  }, [])

  const pasteIntoGlyphAt = useCallback((code: number) => {
    const clip = clipboardRef.current
    if (!clip?.length) return
    commit(f => { ensureGlyph(f, code).contours.push(...(JSON.parse(JSON.stringify(clip)) as FontContour[])) })
  }, [commit, ensureGlyph])

  const clearGlyphAt = useCallback((code: number) => {
    commit(f => { const g = f.glyphs[String(code)]; if (g) g.contours = [] })
    if (viewRef.current === code) setSel({ contours: [], points: [] })
  }, [commit])

  const deleteSel = useCallback(() => {
    if (cp == null) return
    const s = selRef.current
    if (!s.points.length && !s.contours.length) return
    commit(f => {
      const g = f.glyphs[String(cp)]
      if (!g) return
      if (s.points.length) {
        // Remove selected points; drop contours that fall under 3 points.
        const byContour = new Map<number, Set<number>>()
        for (const key of s.points) {
          const [ci, pi] = key.split(':').map(Number)
          if (!byContour.has(ci)) byContour.set(ci, new Set())
          byContour.get(ci)!.add(pi)
        }
        const keep: FontContour[] = []
        g.contours.forEach((c, ci) => {
          const dead = byContour.get(ci)
          if (!dead) { keep.push(c); return }
          const rest = c.filter((_, pi) => !dead.has(pi))
          if (rest.length >= 3) keep.push(rest)
        })
        g.contours = keep
      } else {
        const dead = new Set(s.contours)
        g.contours = g.contours.filter((_, i) => !dead.has(i))
      }
    })
    setSel({ contours: [], points: [] })
  }, [cp, commit])

  const selectAll = useCallback(() => {
    const g = cp != null && fontRef.current ? fontRef.current.glyphs[String(cp)] : null
    if (!g) return
    setSel({ contours: g.contours.map((_, i) => i), points: [] })
  }, [cp])

  const nudgeSel = useCallback((dx: number, dy: number) => {
    if (cp == null) return
    const s = selRef.current
    if (!s.points.length && !s.contours.length) return
    commit(f => {
      const g = f.glyphs[String(cp)]
      if (!g) return
      const movePoint = (p: FontGlyphPoint) => {
        p.x += dx; p.y += dy
        if (p.hIn)  p.hIn  = [p.hIn[0] + dx,  p.hIn[1] + dy]
        if (p.hOut) p.hOut = [p.hOut[0] + dx, p.hOut[1] + dy]
      }
      if (s.points.length) {
        for (const key of s.points) {
          const [ci, pi] = key.split(':').map(Number)
          const p = g.contours[ci]?.[pi]
          if (p) movePoint(p)
        }
      } else {
        for (const ci of s.contours) g.contours[ci]?.forEach(movePoint)
      }
    })
  }, [cp, commit])

  // ── Advanced vector ops (ported from Apex) ────────────────────────────────────

  /** Replaces the target contours (selection, else all) through `fn`. */
  const applyToTargets = useCallback((fn: (targets: FontContour[]) => FontContour[]) => {
    if (cp == null) return
    const g = fontRef.current?.glyphs[String(cp)]
    if (!g || !g.contours.length) return
    const idxs = selectedContourIdxs()
    const target = idxs.length ? idxs : g.contours.map((_, i) => i)
    commit(f => {
      const gg = f.glyphs[String(cp)]
      if (!gg) return
      const res = fn(target.map(i => gg.contours[i]).filter(Boolean))
      if (!res) return
      const dead = new Set(target)
      gg.contours = gg.contours.filter((_, i) => !dead.has(i)).concat(res)
    })
    setSel({ contours: [], points: [] })
  }, [cp, commit, selectedContourIdxs])

  const pathfinderSel = useCallback((op: PathfinderOp) => {
    applyToTargets(targets => {
      if (op !== 'union' && targets.length < 2) return targets
      const a = op === 'union' ? targets : [targets[0]]
      const b = op === 'union' ? [] : targets.slice(1)
      return pathfinderContours(a, b, op) ?? targets
    })
  }, [applyToTargets])

  const simplifySel = useCallback(() => {
    const eps = Math.max(1, (fontRef.current?.unitsPerEm ?? 1000) / 250)
    applyToTargets(targets => targets.map(c => simplifyContour(c, eps)))
  }, [applyToTargets])

  const smoothSel = useCallback(() => {
    applyToTargets(targets => targets.map(smoothContour))
  }, [applyToTargets])

  const offsetSel = useCallback((d: number) => {
    applyToTargets(targets => offsetContours(targets, d))
  }, [applyToTargets])

  const rotateSel = useCallback((dir: 1 | -1) => {
    applyToTargets(targets => {
      const b = contoursBounds(targets)
      if (!b) return targets
      const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2
      // y-up: dir=1 → 90° clockwise, dir=-1 → counter-clockwise.
      const rot = (x: number, y: number): [number, number] =>
        dir === 1 ? [Math.round(cx + (y - cy)), Math.round(cy - (x - cx))]
                  : [Math.round(cx - (y - cy)), Math.round(cy + (x - cx))]
      return targets.map(c => c.map(p => {
        const [x, y] = rot(p.x, p.y)
        return {
          x, y,
          ...(p.hIn  ? { hIn:  rot(p.hIn[0],  p.hIn[1])  } : {}),
          ...(p.hOut ? { hOut: rot(p.hOut[0], p.hOut[1]) } : {}),
        }
      }))
    })
  }, [applyToTargets])

  const closePen = useCallback(() => {
    const pts = penRef.current
    if (cp == null || !pts || pts.length < 2) { setPenPts(null); return }
    commit(f => { ensureGlyph(f, cp).contours.push(pts) })
    setPenPts(null)
    setPenMouse(null)
  }, [cp, commit, ensureGlyph])

  // ── Hit testing ───────────────────────────────────────────────────────────────
  const hitPoint = useCallback((sx: number, sy: number): { ci: number; pi: number } | null => {
    const g = cp != null && fontRef.current ? fontRef.current.glyphs[String(cp)] : null
    if (!g) return null
    for (let ci = 0; ci < g.contours.length; ci++) {
      const c = g.contours[ci]
      for (let pi = 0; pi < c.length; pi++) {
        const [px, py] = toScreen(c[pi].x, c[pi].y)
        if (Math.hypot(px - sx, py - sy) <= 6) return { ci, pi }
      }
    }
    return null
  }, [cp, toScreen])

  const hitHandle = useCallback((sx: number, sy: number): { ci: number; pi: number; side: 'hIn' | 'hOut' } | null => {
    const g = cp != null && fontRef.current ? fontRef.current.glyphs[String(cp)] : null
    if (!g) return null
    // Only handles of points in selected contours / selected points are visible.
    const visible = new Set(selectedContourIdxs())
    for (let ci = 0; ci < g.contours.length; ci++) {
      if (!visible.has(ci)) continue
      const c = g.contours[ci]
      for (let pi = 0; pi < c.length; pi++) {
        for (const side of ['hIn', 'hOut'] as const) {
          const h = c[pi][side]
          if (!h) continue
          const [px, py] = toScreen(h[0], h[1])
          if (Math.hypot(px - sx, py - sy) <= 6) return { ci, pi, side }
        }
      }
    }
    return null
  }, [cp, toScreen, selectedContourIdxs])

  const hitContour = useCallback((sx: number, sy: number): number | null => {
    const canvas = canvasRef.current
    const g = cp != null && fontRef.current ? fontRef.current.glyphs[String(cp)] : null
    if (!canvas || !g) return null
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.lineWidth = 8
    let hit: number | null = null
    for (let ci = g.contours.length - 1; ci >= 0; ci--) {
      const path = buildGlyphPath([g.contours[ci]], (x, y) => toScreen(x, y))
      if (ctx.isPointInStroke(path, sx, sy) || ctx.isPointInPath(path, sx, sy, 'evenodd')) { hit = ci; break }
    }
    ctx.restore()
    return hit
  }, [cp, toScreen])

  /** Horizontal metric guide under the cursor (baseline excluded: it IS the origin). */
  const hitMetric = useCallback((sy: number): MetricKey | null => {
    const f = fontRef.current
    if (!f) return null
    let best: { key: MetricKey; d: number } | null = null
    for (const key of METRIC_KEYS) {
      const [, gy] = toScreen(0, f[key])
      const d = Math.abs(gy - sy)
      if (d <= 5 && (!best || d < best.d)) best = { key, d }
    }
    return best?.key ?? null
  }, [toScreen])

  const hitSegment = useCallback((sx: number, sy: number): { ci: number; pi: number; t: number } | null => {
    const g = cp != null && fontRef.current ? fontRef.current.glyphs[String(cp)] : null
    if (!g) return null
    const [fx, fy] = toFont(sx, sy)
    const tolF = 6 / csRef.current.zoom
    let best: { ci: number; pi: number; t: number; dist: number } | null = null
    for (let ci = 0; ci < g.contours.length; ci++) {
      const c = g.contours[ci]
      for (let pi = 0; pi < c.length; pi++) {
        const r = closestOnSegment(c[pi], c[(pi + 1) % c.length], [fx, fy])
        if (r.dist <= tolF && (!best || r.dist < best.dist)) best = { ci, pi, t: r.t, dist: r.dist }
      }
    }
    return best
  }, [cp, toFont])

  // ── Pointer handlers ──────────────────────────────────────────────────────────
  const applyFromSnapshot = useCallback((origJson: string, mut: (f: FontData) => void) => {
    const base = JSON.parse(origJson) as FontData
    mut(base)
    setFont(base)
  }, [])

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    const f = fontRef.current
    if (!canvas || !f || cp == null) return
    canvas.setPointerCapture(e.pointerId)
    const rect = canvas.getBoundingClientRect()
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top
    const [fx, fy] = toFont(sx, sy)
    const tl = toolRef.current

    if (e.button === 1 || tl === 'hand' || spaceRef.current) {
      dragRef.current = { type: 'pan', sx: e.clientX, sy: e.clientY, orig: { ...csRef.current } }
      return
    }
    if (tl === 'zoom') { zoomAt(sx, sy, e.altKey ? 1 / 1.25 : 1.25); return }

    if (tl === 'pencil') {
      pencilPtsRef.current = [[fx, fy]]
      setPencilPts(pencilPtsRef.current)
      dragRef.current = { type: 'pencil' }
      return
    }

    if (tl === 'pen') {
      const pts = penRef.current
      if (pts && pts.length >= 2) {
        const [f0x, f0y] = toScreen(pts[0].x, pts[0].y)
        if (Math.hypot(f0x - sx, f0y - sy) <= 8) { closePen(); return }
      }
      const [X, Y] = snapPt(fx, fy)
      const idx = pts?.length ?? 0
      setPenPts(prev => [...(prev ?? []), { x: X, y: Y }])
      dragRef.current = { type: 'pen-handle', index: idx, start: [X, Y] }
      return
    }

    if (tl === 'rect' || tl === 'ellipse') {
      const [X, Y] = snapPt(fx, fy)
      dragRef.current = { type: 'shape', x0: X, y0: Y }
      setShapeDraft({ x0: X, y0: Y, x1: X, y1: Y })
      return
    }

    // Advance-width line (select/node tools).
    const [advSx] = toScreen(advanceRef.current, 0)
    if (Math.abs(advSx - sx) <= 5) {
      dragRef.current = { type: 'advance', origJson: JSON.stringify(f) }
      return
    }

    // Vertical metric guides — only where they are not covered by the outline,
    // so clicking a contour that crosses a guide still selects the contour.
    const mkey = hitMetric(sy)
    if (mkey && !hitPoint(sx, sy) && !hitHandle(sx, sy) && hitContour(sx, sy) == null) {
      dragRef.current = { type: 'metric', key: mkey, origJson: JSON.stringify(f) }
      return
    }

    if (tl === 'node') {
      const h = hitHandle(sx, sy)
      if (h) {
        const p = f.glyphs[String(cp)]?.contours[h.ci]?.[h.pi]
        let mirrored = false
        if (p?.hIn && p?.hOut) {
          const dx1 = p.hOut[0] - p.x, dy1 = p.hOut[1] - p.y
          const dx2 = p.hIn[0] - p.x,  dy2 = p.hIn[1] - p.y
          mirrored = Math.abs(dx1 + dx2) < 2 && Math.abs(dy1 + dy2) < 2
        }
        dragRef.current = { type: 'handle', ...h, mirrored, origJson: JSON.stringify(f) }
        return
      }
      const p = hitPoint(sx, sy)
      if (p) {
        const key = `${p.ci}:${p.pi}`
        setSel(prev => {
          if (e.shiftKey) {
            const pts = prev.points.includes(key) ? prev.points.filter(k => k !== key) : [...prev.points, key]
            return { contours: [], points: pts }
          }
          return prev.points.includes(key) ? prev : { contours: [], points: [key] }
        })
        dragRef.current = { type: 'move-points', start: [fx, fy], origJson: JSON.stringify(f) }
        return
      }
    }

    const ci = hitContour(sx, sy)
    if (ci != null) {
      setSel(prev => {
        if (e.shiftKey) {
          const cts = prev.contours.includes(ci) ? prev.contours.filter(c => c !== ci) : [...prev.contours, ci]
          return { contours: cts, points: [] }
        }
        return prev.contours.includes(ci) ? { contours: prev.contours, points: [] } : { contours: [ci], points: [] }
      })
      dragRef.current = { type: 'move-contours', start: [fx, fy], origJson: JSON.stringify(f) }
      return
    }

    if (!e.shiftKey) setSel({ contours: [], points: [] })
    dragRef.current = { type: 'marquee', x0: fx, y0: fy }
    setMarquee({ x0: fx, y0: fy, x1: fx, y1: fy })
  }, [cp, toFont, toScreen, snapPt, zoomAt, closePen, hitHandle, hitPoint, hitContour, hitMetric])

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas || cp == null) return
    const rect = canvas.getBoundingClientRect()
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top
    const [fx, fy] = toFont(sx, sy)
    const d = dragRef.current

    if (!d) {
      if (toolRef.current === 'pen' && penRef.current?.length) setPenMouse([fx, fy])
      // Guide hover feedback (select/node tools only).
      const tl = toolRef.current
      if (tl === 'select' || tl === 'node') {
        const [advSx] = toScreen(advanceRef.current, 0)
        const over: MetricKey | 'advance' | null =
          Math.abs(advSx - sx) <= 5 ? 'advance'
          : (hitMetric(sy) && !hitPoint(sx, sy) && !hitHandle(sx, sy) && hitContour(sx, sy) == null ? hitMetric(sy) : null)
        setHotGuide(prev => (prev === over ? prev : over))
      } else setHotGuide(prev => (prev === null ? prev : null))
      return
    }

    switch (d.type) {
      case 'pan': {
        setCs({ ...d.orig, panX: d.orig.panX + (e.clientX - d.sx), panY: d.orig.panY + (e.clientY - d.sy) })
        break
      }
      case 'pen-handle': {
        const [X, Y] = snapPt(fx, fy)
        setPenPts(prev => {
          if (!prev) return prev
          const next = prev.slice()
          const p = { ...next[d.index] }
          if (Math.hypot(X - p.x, Y - p.y) > 2) {
            p.hOut = [X, Y]
            p.hIn = [2 * p.x - X, 2 * p.y - Y]
          } else {
            delete p.hOut; delete p.hIn
          }
          next[d.index] = p
          return next
        })
        break
      }
      case 'advance': {
        const [X] = snapPt(fx, fy)
        applyFromSnapshot(d.origJson, f => {
          const g = ensureGlyph(f, cp)
          g.advance = Math.max(0, Math.round(X))
        })
        setHotGuide('advance')
        break
      }
      case 'metric': {
        // No snapping here: the dragged guide is itself a snap target, which
        // would make it sticky. Round to the nearest font unit instead.
        applyFromSnapshot(d.origJson, f => {
          f[d.key] = clampMetric(f, d.key, Math.round(fy))
        })
        setHotGuide(d.key)
        break
      }
      case 'move-points': {
        const dx = Math.round(fx - d.start[0]), dy = Math.round(fy - d.start[1])
        const keys = selRef.current.points
        applyFromSnapshot(d.origJson, f => {
          const g = f.glyphs[String(cp)]
          if (!g) return
          for (const key of keys) {
            const [ci, pi] = key.split(':').map(Number)
            const p = g.contours[ci]?.[pi]
            if (!p) continue
            p.x += dx; p.y += dy
            if (p.hIn)  p.hIn  = [p.hIn[0] + dx,  p.hIn[1] + dy]
            if (p.hOut) p.hOut = [p.hOut[0] + dx, p.hOut[1] + dy]
          }
        })
        break
      }
      case 'move-contours': {
        const dx = Math.round(fx - d.start[0]), dy = Math.round(fy - d.start[1])
        const idxs = selRef.current.contours
        applyFromSnapshot(d.origJson, f => {
          const g = f.glyphs[String(cp)]
          if (!g) return
          for (const ci of idxs) {
            g.contours[ci]?.forEach(p => {
              p.x += dx; p.y += dy
              if (p.hIn)  p.hIn  = [p.hIn[0] + dx,  p.hIn[1] + dy]
              if (p.hOut) p.hOut = [p.hOut[0] + dx, p.hOut[1] + dy]
            })
          }
        })
        break
      }
      case 'handle': {
        const [X, Y] = snapPt(fx, fy)
        const mirror = d.mirrored && !e.altKey
        applyFromSnapshot(d.origJson, f => {
          const p = f.glyphs[String(cp)]?.contours[d.ci]?.[d.pi]
          if (!p) return
          p[d.side] = [X, Y]
          const other = d.side === 'hIn' ? 'hOut' : 'hIn'
          if (mirror && p[other]) p[other] = [2 * p.x - X, 2 * p.y - Y]
        })
        break
      }
      case 'shape': {
        const [X, Y] = snapPt(fx, fy)
        setShapeDraft({ x0: d.x0, y0: d.y0, x1: X, y1: Y })
        break
      }
      case 'marquee': {
        setMarquee({ x0: d.x0, y0: d.y0, x1: fx, y1: fy })
        break
      }
      case 'pencil': {
        if (pencilPtsRef.current) {
          pencilPtsRef.current = [...pencilPtsRef.current, [fx, fy]]
          setPencilPts(pencilPtsRef.current)
        }
        break
      }
    }
  }, [cp, toFont, toScreen, snapPt, applyFromSnapshot, ensureGlyph, hitMetric, hitPoint, hitHandle, hitContour])

  const onPointerUp = useCallback(() => {
    const d = dragRef.current
    dragRef.current = null
    if (!d || cp == null) { setMarquee(null); return }

    switch (d.type) {
      case 'pen-handle':
        break   // point already in penPts; nothing to finalize
      case 'advance':
      case 'metric':
      case 'move-points':
      case 'move-contours':
      case 'handle': {
        // Live edits already applied — record the pre-drag state for undo.
        if (fontRef.current && JSON.stringify(fontRef.current) !== d.origJson) pushHistory(d.origJson)
        break
      }
      case 'shape': {
        const draft = shapeDraft
        setShapeDraft(null)
        if (!draft) break
        const x0 = Math.min(draft.x0, draft.x1), x1 = Math.max(draft.x0, draft.x1)
        const y0 = Math.min(draft.y0, draft.y1), y1 = Math.max(draft.y0, draft.y1)
        if (x1 - x0 < 4 || y1 - y0 < 4) break
        let contour: FontContour
        if (toolRef.current === 'rect') {
          contour = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]
        } else {
          const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2
          const rx = (x1 - x0) / 2, ry = (y1 - y0) / 2
          const kx = rx * 0.5523, ky = ry * 0.5523
          const R = Math.round
          contour = [
            { x: R(cx + rx), y: R(cy), hIn: [R(cx + rx), R(cy - ky)], hOut: [R(cx + rx), R(cy + ky)] },
            { x: R(cx), y: R(cy + ry), hIn: [R(cx + kx), R(cy + ry)], hOut: [R(cx - kx), R(cy + ry)] },
            { x: R(cx - rx), y: R(cy), hIn: [R(cx - rx), R(cy + ky)], hOut: [R(cx - rx), R(cy - ky)] },
            { x: R(cx), y: R(cy - ry), hIn: [R(cx - kx), R(cy - ry)], hOut: [R(cx + kx), R(cy - ry)] },
          ]
        }
        {
          const prevLen = fontRef.current?.glyphs[String(cp)]?.contours.length ?? 0
          commit(f => { ensureGlyph(f, cp).contours.push(contour) })
          setSel({ contours: [prevLen], points: [] })
        }
        break
      }
      case 'marquee': {
        const m = marquee
        setMarquee(null)
        if (!m) break
        const x0 = Math.min(m.x0, m.x1), x1 = Math.max(m.x0, m.x1)
        const y0 = Math.min(m.y0, m.y1), y1 = Math.max(m.y0, m.y1)
        if (x1 - x0 < 3 && y1 - y0 < 3) break
        const g = fontRef.current?.glyphs[String(cp)]
        if (!g) break
        if (toolRef.current === 'node') {
          const pts: string[] = []
          g.contours.forEach((c, ci) => c.forEach((p, pi) => {
            if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) pts.push(`${ci}:${pi}`)
          }))
          setSel({ contours: [], points: pts })
        } else {
          const cts: number[] = []
          g.contours.forEach((c, ci) => {
            const b = contoursBounds([c])
            if (b && b.minX >= x0 && b.maxX <= x1 && b.minY >= y0 && b.maxY <= y1) cts.push(ci)
          })
          setSel({ contours: cts, points: [] })
        }
        break
      }
      case 'pencil': {
        // Fit the freehand trace into a smooth closed contour: closed RDP then
        // Catmull-Rom-style auto handles (same primitives as Tracé > Simplifier/Lisser).
        const pts = pencilPtsRef.current
        pencilPtsRef.current = null
        setPencilPts(null)
        if (!pts || pts.length < 3) break
        const eps = Math.max(1, 3 / csRef.current.zoom)
        const raw: FontContour = pts.map(([x, y]) => ({ x: Math.round(x), y: Math.round(y) }))
        const contour = smoothContour(simplifyContour(raw, eps))
        if (contour.length < 3) break
        const prevLen = fontRef.current?.glyphs[String(cp)]?.contours.length ?? 0
        commit(f => { ensureGlyph(f, cp).contours.push(contour) })
        setSel({ contours: [prevLen], points: [] })
        break
      }
      case 'pan':
        break
    }
  }, [cp, commit, ensureGlyph, marquee, shapeDraft, pushHistory])

  const onDoubleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas || cp == null || toolRef.current !== 'node') return
    const rect = canvas.getBoundingClientRect()
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top
    // Toggle smooth (mirrored handles) ↔ corner (no handles), else insert a point.
    const p = hitPoint(sx, sy)
    if (p) { togglePointSmooth(p.ci, p.pi); return }
    const seg = hitSegment(sx, sy)
    if (seg) insertPointOnSegment(seg.ci, seg.pi, seg.t)
  }, [cp, hitPoint, hitSegment, togglePointSmooth, insertPointOnSegment])

  // ── Right-click context menus ─────────────────────────────────────────────────
  const ctxMenu = useContextMenu()

  /** Contour-level items, shared by the canvas menu (a contour is selected). */
  const contourItems = useCallback((multi: boolean): CtxItem[] => [
    { label: t('apex_ctx_cut'),    onClick: cutSel,       shortcut: 'Ctrl+X' },
    { label: t('font_glyph_copy'), onClick: copySel,      shortcut: 'Ctrl+C' },
    { label: t('font_glyph_paste'), onClick: pasteSel,    shortcut: 'Ctrl+V', disabled: !clipboardRef.current?.length },
    { label: t('apex_duplicate'),  onClick: duplicateSel, shortcut: 'Ctrl+D' },
    'sep',
    { label: t('font_flip_h'),      onClick: () => flipSel('h') },
    { label: t('font_flip_v'),      onClick: () => flipSel('v') },
    { label: t('apex_rotate_cw'),   onClick: () => rotateSel(1) },
    { label: t('apex_rotate_ccw'),  onClick: () => rotateSel(-1) },
    { label: t('font_reverse_contours'), onClick: reverseSel },
    'sep',
    ...(multi ? [
      { label: t('apex_pf_union'),     onClick: () => pathfinderSel('union') } as CtxItem,
      { label: t('apex_pf_subtract'),  onClick: () => pathfinderSel('subtract') } as CtxItem,
      { label: t('apex_pf_intersect'), onClick: () => pathfinderSel('intersect') } as CtxItem,
      { label: t('apex_pf_exclude'),   onClick: () => pathfinderSel('exclude') } as CtxItem,
      'sep' as CtxItem,
    ] : []),
    { label: t('apex_path_simplify'),   onClick: simplifySel },
    { label: t('apex_path_smooth'),     onClick: smoothSel },
    { label: t('apex_path_offset_out'), onClick: () => offsetSel(10) },
    { label: t('apex_path_offset_in'),  onClick: () => offsetSel(-10) },
    'sep',
    { label: t('font_delete_selection'), onClick: deleteSel, danger: true, shortcut: 'Suppr' },
  ], [t, cutSel, copySel, pasteSel, duplicateSel, flipSel, rotateSel, reverseSel,
      pathfinderSel, simplifySel, smoothSel, offsetSel, deleteSel])

  const onCanvasContextMenu = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault()
    const canvas = canvasRef.current
    const f = fontRef.current
    if (!canvas || !f || cp == null) return
    const rect = canvas.getBoundingClientRect()
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top
    const hasClip = !!clipboardRef.current?.length

    // A guide under the cursor gets its own menu (reset / align on the em box).
    const mkey = hitMetric(sy)
    const [advSx] = toScreen(advanceRef.current, 0)
    const onAdvance = Math.abs(advSx - sx) <= 5
    if ((mkey || onAdvance) && !hitPoint(sx, sy) && hitContour(sx, sy) == null) {
      const b = contoursBounds(f.glyphs[String(cp)]?.contours ?? [])
      ctxMenu.open(e, onAdvance
        ? [
            { label: t('font_ctx_advance_fit'), onClick: () => commit(ff => {
                const bb = contoursBounds(ff.glyphs[String(cp)]?.contours ?? [])
                if (bb) ensureGlyph(ff, cp).advance = Math.max(0, Math.round(bb.maxX + bb.minX))
              }), disabled: !b },
            { label: t('font_ctx_advance_em'), onClick: () => commit(ff => { ensureGlyph(ff, cp).advance = ff.unitsPerEm }) },
          ]
        : [
            { label: `${t(METRIC_LABELS[mkey!])} — ${Math.round(f[mkey!])}`, onClick: () => {}, disabled: true },
            'sep',
            { label: t('font_ctx_metric_reset'), onClick: () => commit(ff => {
                const u = ff.unitsPerEm || 1000
                const defs: Record<MetricKey, number> = {
                  ascender: Math.round(u * 0.8), capHeight: Math.round(u * 0.7),
                  xHeight: Math.round(u * 0.5), descender: -Math.round(u * 0.2),
                }
                ff[mkey!] = defs[mkey!]
              }) },
          ])
      return
    }

    // Point (node tool) → point items first, then the contour ones.
    const hp = toolRef.current === 'node' ? hitPoint(sx, sy) : null
    if (hp) {
      const key = `${hp.ci}:${hp.pi}`
      if (!selRef.current.points.includes(key)) setSel({ contours: [], points: [key] })
      const pt = f.glyphs[String(cp)]?.contours[hp.ci]?.[hp.pi]
      ctxMenu.open(e, [
        { label: pt?.hIn || pt?.hOut ? t('font_ctx_make_corner') : t('font_ctx_make_smooth'),
          onClick: () => togglePointSmooth(hp.ci, hp.pi) },
        { label: t('font_ctx_delete_point'), onClick: () => deletePointAt(hp.ci, hp.pi), danger: true },
        'sep',
        ...contourItems(false),
      ])
      return
    }

    // Segment (node tool) → insert a point here.
    const seg = toolRef.current === 'node' ? hitSegment(sx, sy) : null
    if (seg) {
      setSel({ contours: [seg.ci], points: [] })
      ctxMenu.open(e, [
        { label: t('font_ctx_insert_point'), onClick: () => insertPointOnSegment(seg.ci, seg.pi, seg.t) },
        'sep',
        ...contourItems(false),
      ])
      return
    }

    const ci = hitContour(sx, sy)
    if (ci != null) {
      const already = selRef.current.contours.includes(ci)
      if (!already) setSel({ contours: [ci], points: [] })
      const multi = already && selRef.current.contours.length > 1
      ctxMenu.open(e, contourItems(multi))
      return
    }

    // Empty canvas.
    ctxMenu.open(e, [
      { label: t('menu_undo'), onClick: undo, shortcut: 'Ctrl+Z' },
      { label: t('menu_redo'), onClick: redo, shortcut: 'Ctrl+Y' },
      'sep',
      { label: t('font_glyph_paste'), onClick: pasteSel, shortcut: 'Ctrl+V', disabled: !hasClip },
      { label: t('font_select_all'),  onClick: selectAll, shortcut: 'Ctrl+A' },
      'sep',
      { label: `${showFill ? '✓ ' : ''}${t('font_toggle_fill')}`, onClick: () => setShowFill(v => !v) },
      { label: `${showGrid ? '✓ ' : ''}${t('font_toggle_grid')}`, onClick: () => setShowGrid(v => !v) },
      { label: `${snapOn ? '✓ ' : ''}${t('font_snap_toggle')}`,   onClick: () => setSnapOn(v => !v) },
      'sep',
      { label: t('font_fit'), onClick: () => centerGlyph(advanceRef.current) },
      { label: t('font_glyph_clear'), onClick: clearGlyph, danger: true },
    ])
  }, [cp, ctxMenu, t, toScreen, hitMetric, hitPoint, hitContour, hitSegment, contourItems, commit,
      ensureGlyph, togglePointSmooth, deletePointAt, insertPointOnSegment, undo, redo, pasteSel,
      selectAll, clearGlyph, centerGlyph, showFill, showGrid, snapOn])

  /** Context menu on a glyph cell (overview grid & glyphs panel). */
  const onGlyphCellContextMenu = useCallback((e: React.MouseEvent, code: number) => {
    e.preventDefault()
    const g = fontRef.current?.glyphs[String(code)]
    const drawn = !!g && g.contours.length > 0
    ctxMenu.open(e, [
      { label: t('font_ctx_open'), onClick: () => openGlyph(code) },
      'sep',
      { label: t('font_ctx_copy_glyph'),  onClick: () => copyGlyphAt(code), disabled: !drawn },
      { label: t('font_ctx_paste_glyph'), onClick: () => pasteIntoGlyphAt(code), disabled: !clipboardRef.current?.length },
      'sep',
      { label: t('font_glyph_clear'), onClick: () => clearGlyphAt(code), disabled: !drawn, danger: true },
    ])
  }, [ctxMenu, t, openGlyph, copyGlyphAt, pasteIntoGlyphAt, clearGlyphAt])

  /** Context menu on a bottom tab. */
  const onTabContextMenu = useCallback((e: React.MouseEvent, code: number) => {
    e.preventDefault()
    ctxMenu.open(e, [
      { label: t('font_ctx_close_tab'), onClick: () => closeTab(code) },
      { label: t('font_ctx_close_others'), onClick: () => { setOpenTabs([code]); setView(code) } },
      { label: t('font_ctx_close_all'), onClick: () => { setOpenTabs([]); setView('grid') } },
    ])
  }, [ctxMenu, t, closeTab])

  // Wheel zoom (non-passive so we can prevent the page scroll).
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || cp == null) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = canvas.getBoundingClientRect()
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.12 : 1 / 1.12)
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [cp, zoomAt])

  // ── Keyboard shortcuts ────────────────────────────────────────────────────────
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return
      if (e.code === 'Space') { spaceRef.current = true }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault(); if (e.shiftKey) redo(); else undo(); return
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveNow(); return }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); selectAll(); return }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') { copySel(); return }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'x') { cutSel(); return }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') { pasteSel(); return }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSel(); return }
      if (typeof viewRef.current !== 'number') return
      switch (e.key) {
        case 'Escape':
          if (penRef.current) { setPenPts(null); setPenMouse(null) }
          else setSel({ contours: [], points: [] })
          break
        case 'Enter':
          if (penRef.current) closePen()
          break
        case 'Delete':
        case 'Backspace':
          deleteSel()
          break
        case 'ArrowLeft':  e.preventDefault(); nudgeSel(e.shiftKey ? -10 : -1, 0); break
        case 'ArrowRight': e.preventDefault(); nudgeSel(e.shiftKey ? 10 : 1, 0); break
        case 'ArrowUp':    e.preventDefault(); nudgeSel(0, e.shiftKey ? 10 : 1); break
        case 'ArrowDown':  e.preventDefault(); nudgeSel(0, e.shiftKey ? -10 : -1); break
        default: {
          if (e.ctrlKey || e.metaKey || e.altKey) break
          const k = e.key.toLowerCase()
          const map: Record<string, Tool> = { v: 'select', a: 'node', p: 'pen', n: 'pencil', r: 'rect', e: 'ellipse', h: 'hand', z: 'zoom' }
          if (map[k]) { setTool(map[k]); if (map[k] !== 'pen') { setPenPts(null); setPenMouse(null) } setPencilPts(null) }
        }
      }
    }
    const onKeyUp = (e: KeyboardEvent) => { if (e.code === 'Space') spaceRef.current = false }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => { window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp) }
  }, [undo, redo, saveNow, selectAll, copySel, cutSel, pasteSel, duplicateSel, deleteSel, nudgeSel, closePen])

  // ── Canvas rendering ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (cp == null || !font) return
    const canvas = canvasRef.current
    if (!canvas) return
    const draw = () => {
      const cw = canvas.clientWidth, ch = canvas.clientHeight
      if (!cw || !ch) return
      const dpr = window.devicePixelRatio || 1
      if (canvas.width !== cw * dpr || canvas.height !== ch * dpr) {
        canvas.width = cw * dpr
        canvas.height = ch * dpr
      }
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.fillStyle = C.bg
      ctx.fillRect(0, 0, cw, ch)

      const g = font.glyphs[String(cp)]
      const adv = g?.advance ?? defaultAdvance(font, cp)

      // Em band (subtle) between origin and advance.
      const [bx0, by0] = toScreen(0, font.ascender, cs)
      const [bx1, by1] = toScreen(adv, font.descender, cs)
      ctx.fillStyle = 'rgba(255,255,255,0.035)'
      ctx.fillRect(bx0, by0, bx1 - bx0, by1 - by0)

      // Unit grid.
      if (showGrid && cs.zoom > 0.12) {
        const step = 100 * cs.zoom >= 24 ? 50 : 100
        ctx.strokeStyle = 'rgba(255,255,255,0.05)'
        ctx.lineWidth = 1
        const [fx0, fy1] = toFont(0, ch, cs)
        const [fx1, fy0] = toFont(cw, 0, cs)
        for (let x = Math.floor(fx0 / step) * step; x <= fx1; x += step) {
          const [sx] = toScreen(x, 0, cs)
          ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, ch); ctx.stroke()
        }
        for (let y = Math.floor(fy1 / step) * step; y <= fy0; y += step) {
          const [, sy] = toScreen(0, y, cs)
          ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(cw, sy); ctx.stroke()
        }
      }

      // Vertical metrics — every named guide is draggable, so the hovered/dragged
      // one is highlighted and gets a grab knob on the right edge.
      const metricLines: [MetricKey | null, number, string, string][] = [
        ['ascender',  font.ascender,  t('font_ascender'),  'rgba(90,155,220,0.55)'],
        ['capHeight', font.capHeight, t('font_capheight'), 'rgba(142,142,142,0.55)'],
        ['xHeight',   font.xHeight,   t('font_xheight'),   'rgba(142,142,142,0.55)'],
        [null,        0,              t('font_baseline'),  'rgba(214,214,214,0.8)'],
        ['descender', font.descender, t('font_descender'), 'rgba(90,155,220,0.55)'],
      ]
      ctx.font = '10px system-ui, sans-serif'
      ctx.textBaseline = 'bottom'
      for (const [key, y, label, color] of metricLines) {
        const hot = key != null && hotGuide === key
        const [, sy] = toScreen(0, y, cs)
        ctx.strokeStyle = hot ? C.accent : color
        ctx.lineWidth = hot ? 1.5 : 1
        ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(cw, sy); ctx.stroke()
        ctx.fillStyle = hot ? C.accent : 'rgba(142,142,142,0.8)'
        ctx.fillText(key ? `${label} ${Math.round(y)}` : label, 6, sy - 2)
        if (hot) { ctx.fillRect(cw - 12, sy - 3, 8, 6) }
      }

      // Origin + advance lines (the advance one is draggable too).
      const advW = hotGuide === 'advance' ? 2.5 : 1.5
      for (const [x, color, w] of [[0, 'rgba(214,214,214,0.5)', 1], [adv, C.accent, advW]] as [number, string, number][]) {
        const [sx] = toScreen(x, 0, cs)
        ctx.strokeStyle = color
        ctx.lineWidth = w
        ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, ch); ctx.stroke()
      }
      ctx.fillStyle = C.accent
      const [advSx] = toScreen(adv, 0, cs)
      ctx.fillText(String(Math.round(adv)), advSx + 4, 14)

      // Glyph contours.
      if (g) {
        const selCts = new Set(sel.contours)
        for (const key of sel.points) selCts.add(+key.split(':')[0])
        if (showFill && g.contours.length) {
          const path = buildGlyphPath(g.contours, (x, y) => toScreen(x, y, cs))
          ctx.fillStyle = tool === 'select'
            ? 'rgba(214,214,214,0.82)'
            : 'rgba(214,214,214,0.25)'
          ctx.fill(path, 'evenodd')
        }
        g.contours.forEach((c, ci) => {
          const path = buildGlyphPath([c], (x, y) => toScreen(x, y, cs))
          ctx.strokeStyle = selCts.has(ci) ? C.accent : (showFill && tool === 'select' ? 'rgba(0,0,0,0.35)' : C.textDim)
          ctx.lineWidth = selCts.has(ci) ? 1.5 : 1
          ctx.stroke(path)
        })

        // Points & handles (node/pen tools, or when a contour is selected).
        const showPts = tool === 'node' || tool === 'pen' || selCts.size > 0
        if (showPts) {
          g.contours.forEach((c, ci) => {
            const inSel = selCts.has(ci)
            c.forEach((p, pi) => {
              const key = `${ci}:${pi}`
              const isSel = sel.points.includes(key)
              const [px, py] = toScreen(p.x, p.y, cs)
              // Handles (selected contour or selected point only, to limit clutter).
              if ((inSel || isSel) && tool === 'node') {
                for (const side of ['hIn', 'hOut'] as const) {
                  const h = p[side]
                  if (!h) continue
                  const [hx, hy] = toScreen(h[0], h[1], cs)
                  ctx.strokeStyle = 'rgba(90,155,220,0.6)'
                  ctx.lineWidth = 1
                  ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(hx, hy); ctx.stroke()
                  ctx.fillStyle = '#5a9bdc'
                  ctx.beginPath(); ctx.arc(hx, hy, 3, 0, Math.PI * 2); ctx.fill()
                }
              }
              ctx.fillStyle = isSel ? C.accent : (p.hIn || p.hOut ? '#8e8e8e' : '#c9c9c9')
              ctx.strokeStyle = '#1e1e1e'
              ctx.lineWidth = 1
              if (p.hIn || p.hOut) { ctx.beginPath(); ctx.arc(px, py, 3.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke() }
              else { ctx.fillRect(px - 3, py - 3, 6, 6); ctx.strokeRect(px - 3, py - 3, 6, 6) }
            })
          })
        }
      }

      // Pen-in-progress preview.
      if (penPts?.length) {
        ctx.strokeStyle = C.accent
        ctx.lineWidth = 1.2
        const path = new Path2D()
        const [p0x, p0y] = toScreen(penPts[0].x, penPts[0].y, cs)
        path.moveTo(p0x, p0y)
        for (let i = 0; i < penPts.length - 1; i++) {
          const a = penPts[i], b = penPts[i + 1]
          const c1 = a.hOut ?? [a.x, a.y], c2 = b.hIn ?? [b.x, b.y]
          const [c1x, c1y] = toScreen(c1[0], c1[1], cs)
          const [c2x, c2y] = toScreen(c2[0], c2[1], cs)
          const [bx, by] = toScreen(b.x, b.y, cs)
          path.bezierCurveTo(c1x, c1y, c2x, c2y, bx, by)
        }
        ctx.stroke(path)
        // Rubber band to the cursor.
        if (penMouse) {
          const last = penPts[penPts.length - 1]
          const c1 = last.hOut ?? [last.x, last.y]
          const [lx, ly] = toScreen(last.x, last.y, cs)
          const [c1x, c1y] = toScreen(c1[0], c1[1], cs)
          const [mx, my] = toScreen(penMouse[0], penMouse[1], cs)
          ctx.setLineDash([4, 3])
          ctx.beginPath(); ctx.moveTo(lx, ly); ctx.quadraticCurveTo(c1x, c1y, mx, my); ctx.stroke()
          ctx.setLineDash([])
        }
        // Points + closing target on the first one.
        penPts.forEach((p, i) => {
          const [px, py] = toScreen(p.x, p.y, cs)
          if (p.hOut) {
            const [hx, hy] = toScreen(p.hOut[0], p.hOut[1], cs)
            ctx.strokeStyle = 'rgba(90,155,220,0.6)'
            ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(hx, hy); ctx.stroke()
            ctx.fillStyle = '#5a9bdc'
            ctx.beginPath(); ctx.arc(hx, hy, 2.6, 0, Math.PI * 2); ctx.fill()
          }
          ctx.fillStyle = C.accent
          ctx.fillRect(px - 3, py - 3, 6, 6)
          if (i === 0 && penPts.length >= 2) {
            ctx.strokeStyle = C.accent
            ctx.beginPath(); ctx.arc(px, py, 7, 0, Math.PI * 2); ctx.stroke()
          }
        })
      }

      // Freehand pencil trace preview.
      if (pencilPts && pencilPts.length >= 2) {
        ctx.strokeStyle = C.accent
        ctx.lineWidth = 1.4
        ctx.beginPath()
        const [p0x, p0y] = toScreen(pencilPts[0][0], pencilPts[0][1], cs)
        ctx.moveTo(p0x, p0y)
        for (let i = 1; i < pencilPts.length; i++) {
          const [px, py] = toScreen(pencilPts[i][0], pencilPts[i][1], cs)
          ctx.lineTo(px, py)
        }
        ctx.stroke()
      }

      // Shape draft preview.
      if (shapeDraft) {
        const [ax, ay] = toScreen(shapeDraft.x0, shapeDraft.y0, cs)
        const [bx2, by2] = toScreen(shapeDraft.x1, shapeDraft.y1, cs)
        ctx.strokeStyle = C.accent
        ctx.lineWidth = 1
        ctx.setLineDash([4, 3])
        if (tool === 'rect') ctx.strokeRect(Math.min(ax, bx2), Math.min(ay, by2), Math.abs(bx2 - ax), Math.abs(by2 - ay))
        else {
          ctx.beginPath()
          ctx.ellipse((ax + bx2) / 2, (ay + by2) / 2, Math.abs(bx2 - ax) / 2, Math.abs(by2 - ay) / 2, 0, 0, Math.PI * 2)
          ctx.stroke()
        }
        ctx.setLineDash([])
      }

      // Marquee.
      if (marquee) {
        const [ax, ay] = toScreen(marquee.x0, marquee.y0, cs)
        const [bx2, by2] = toScreen(marquee.x1, marquee.y1, cs)
        ctx.strokeStyle = C.accent
        ctx.fillStyle = C.accent + '18'
        ctx.lineWidth = 1
        ctx.setLineDash([4, 3])
        const rx = Math.min(ax, bx2), ry = Math.min(ay, by2)
        ctx.fillRect(rx, ry, Math.abs(bx2 - ax), Math.abs(by2 - ay))
        ctx.strokeRect(rx, ry, Math.abs(bx2 - ax), Math.abs(by2 - ay))
        ctx.setLineDash([])
      }
    }
    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [font, cp, cs, sel, tool, penPts, penMouse, marquee, shapeDraft, pencilPts, showFill, showGrid, hotGuide, toScreen, toFont, t])

  // ── Derived metrics for the properties panel ──────────────────────────────────
  const glyphBounds = useMemo(() => (glyph ? contoursBounds(glyph.contours) : null), [glyph])
  const lsb = glyphBounds ? Math.round(glyphBounds.minX) : 0
  const rsb = glyphBounds ? Math.round(advance - glyphBounds.maxX) : advance

  // ── Export / Import (all common font formats) ─────────────────────────────────
  const doExport = useCallback((fmt: FontFileFormat) => {
    const f = fontRef.current
    if (!f) return
    import('./fontFormats')
      .then(({ exportFont }) => exportFont(f, fmt, project?.title || 'police'))
      .then(name => setExportNote(t('font_export_done', { name })))
      .catch((err: unknown) => setExportNote(t('font_export_error', { message: (err as Error)?.message ?? '?' })))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.title, t])

  const importInputRef = useRef<HTMLInputElement>(null)
  const [pendingImport, setPendingImport] = useState<FontData | null>(null)

  // Replaces the whole document with the imported font — undoable (Ctrl+Z).
  const applyImport = useCallback((imported: FontData) => {
    setFont(prev => {
      if (prev) pushHistory(JSON.stringify(prev))
      return imported
    })
    setView('grid')
    setOpenTabs([])
    setSel({ contours: [], points: [] })
    setPenPts(null)
  }, [pushHistory])

  const onImportFile = useCallback((f: File) => {
    import('./fontFormats')
      .then(async ({ bufferToFontData, formatOfFileName }) => {
        const format = formatOfFileName(f.name)
        if (!format) throw new Error(f.name)
        return bufferToFontData(await f.arrayBuffer(), format)
      })
      .then(data => {
        const cur = fontRef.current
        if (cur && countDrawnGlyphs(cur) > 0) setPendingImport(data)
        else applyImport(data)
      })
      .catch((err: unknown) => setExportNote(t('font_import_error', { message: (err as Error)?.message ?? '?' })))
  }, [applyImport, t])
  useEffect(() => {
    if (!exportNote) return
    const id = setTimeout(() => setExportNote(null), 6000)
    return () => clearTimeout(id)
  }, [exportNote])

  // ── Dock panels ───────────────────────────────────────────────────────────────
  if (!font) {
    return (
      <div className="h-full flex items-center justify-center" style={{ background: C.bg }}>
        <p className="text-sm" style={{ color: C.textDim }}>{t('common_loading')}</p>
      </div>
    )
  }

  const fontPanels = {
    glyphs: { label: t('font_panel_glyphs'), render: () => (
      <div className="p-2 overflow-y-auto h-full">
        {SECTIONS.map(sec => (
          <div key={sec.key} className="mb-2">
            <div className="text-[10px] uppercase tracking-wide px-0.5 pb-1" style={{ color: C.textDim }}>
              {t(sec.key)}
            </div>
            <div className="flex flex-wrap gap-1">
              {sec.cps.map(code => (
                <GlyphCell key={code} font={font} cp={code} size={30}
                           active={view === code} onOpen={openGlyph}
                           onContextMenu={onGlyphCellContextMenu} />
              ))}
            </div>
          </div>
        ))}
      </div>
    ) },
    properties: { label: t('font_panel_props'), render: () => (
      <div className="p-2 flex flex-col gap-3 overflow-y-auto h-full">
        {cp != null && (
          <>
            <div className="flex items-center gap-2">
              <div className="w-10 h-10 rounded flex items-center justify-center text-xl font-medium flex-shrink-0"
                   style={{ background: '#252525', border: `1px solid ${C.border}`, color: C.text }}>
                {charLabel(cp)}
              </div>
              <div className="min-w-0">
                <div className="text-xs" style={{ color: C.text }}>{t('font_glyph')}</div>
                <div className="text-[10px]" style={{ color: C.textDim }}>
                  {t('font_unicode')} U+{cp.toString(16).toUpperCase().padStart(4, '0')}
                  {' · '}{t('font_contours')}: {glyph?.contours.length ?? 0}
                </div>
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <div className="text-[10px] uppercase tracking-wide" style={{ color: C.textDim }}>{t('font_metrics')}</div>
              <NumRow label={t('font_advance')} value={Math.round(advance)} min={0}
                onCommit={v => commit(f => { ensureGlyph(f, cp).advance = v })} />
              <NumRow label={t('font_lsb')} value={lsb}
                onCommit={v => {
                  const delta = v - lsb
                  if (!delta || !glyph) return
                  commit(f => {
                    f.glyphs[String(cp)]?.contours.forEach(c => c.forEach(p => {
                      p.x += delta
                      if (p.hIn)  p.hIn  = [p.hIn[0] + delta,  p.hIn[1]]
                      if (p.hOut) p.hOut = [p.hOut[0] + delta, p.hOut[1]]
                    }))
                  })
                }} />
              <NumRow label={t('font_rsb')} value={rsb}
                onCommit={v => {
                  const delta = v - rsb
                  if (!delta) return
                  commit(f => { const g = ensureGlyph(f, cp); g.advance = Math.max(0, g.advance + delta) })
                }} />
            </div>
            <div className="flex flex-col gap-1.5">
              <div className="text-[10px] uppercase tracking-wide" style={{ color: C.textDim }}>{t('font_ops')}</div>
              <div className="grid grid-cols-2 gap-1">
                {[
                  { label: t('font_flip_h'), icon: FlipHorizontal, fn: () => flipSel('h') },
                  { label: t('font_flip_v'), icon: FlipVertical,   fn: () => flipSel('v') },
                  { label: t('font_glyph_copy'),  icon: Copy,           fn: copySel },
                  { label: t('font_glyph_paste'), icon: ClipboardPaste, fn: pasteSel },
                  { label: t('font_reverse_contours'), icon: RefreshCw, fn: reverseSel },
                  { label: t('font_glyph_clear'), icon: Trash2,         fn: clearGlyph },
                ].map(({ label, icon: Icon, fn }) => (
                  <button key={label} onClick={fn} title={label}
                    className="flex items-center gap-1.5 px-2 py-1.5 rounded text-[10px] text-left transition-colors hover:bg-white/10"
                    style={{ background: '#2a2a2a', color: C.text }}>
                    <Icon size={11} className="flex-shrink-0" /> <span className="truncate">{label}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="h-px" style={{ background: C.border }} />
          </>
        )}
        <div className="flex flex-col gap-1.5">
          <div className="text-[10px] uppercase tracking-wide" style={{ color: C.textDim }}>{t('font_info')}</div>
          <TextRow label={t('font_family')} value={font.familyName}
                   onCommit={v => commit(f => { f.familyName = v })} />
          <TextRow label={t('font_style')} value={font.styleName}
                   onCommit={v => commit(f => { f.styleName = v })} />
          <NumRow label={t('font_upem')} value={font.unitsPerEm} min={16} max={16384}
                  onCommit={v => commit(f => { f.unitsPerEm = v })} />
          <NumRow label={t('font_ascender')} value={font.ascender} min={1}
                  onCommit={v => commit(f => { f.ascender = v })} />
          <NumRow label={t('font_descender')} value={font.descender} max={-1}
                  onCommit={v => commit(f => { f.descender = v })} />
          <NumRow label={t('font_capheight')} value={font.capHeight} min={1}
                  onCommit={v => commit(f => { f.capHeight = v })} />
          <NumRow label={t('font_xheight')} value={font.xHeight} min={1}
                  onCommit={v => commit(f => { f.xHeight = v })} />
        </div>
      </div>
    ) },
    preview: { label: t('font_panel_preview'), render: () => <PreviewPanel font={font} t={t} /> },
    kerning: { label: t('font_panel_kerning'), render: () => <KerningPanel font={font} commit={commit} t={t} /> },
  }

  const toolHint = tool === 'pen' ? t('font_pen_hint')
    : tool === 'node' ? t('font_node_hint')
    : tool === 'select' ? `${t('font_select_hint')} · ${t('font_guides_hint')}`
    : t('font_select_hint')

  const cursor = tool === 'hand' ? 'grab'
    : tool === 'zoom' ? 'zoom-in'
    : tool === 'pen' || tool === 'pencil' || tool === 'rect' || tool === 'ellipse' ? 'crosshair'
    : hotGuide === 'advance' ? 'ew-resize'
    : hotGuide ? 'ns-resize'
    : 'default'

  return (
    <EditorShell theme={C}
      chromeless
      topbarHeight={64}
      optionsBarHeight={40}
      onBack={() => { flushSave(); navigate('/paintsharp/fonteditor') }}
      title={titleDraft}
      onTitleChange={setTitleDraft}
      onTitleCommit={commitTitle}
      titlePlaceholder={t('common_untitled', { defaultValue: 'Sans titre' })}
      saveStatus={saveMut.isPending ? t('font_saving') : t('font_saved')}
      subtitle="FontEditor"
      docInfo={`${font.unitsPerEm} upm · ${t('fontproj_glyph_count', { count: countDrawnGlyphs(font) })}`}
      titleActions={
        <button
          onClick={() => starMut.mutate(!project?.is_starred)}
          title={project?.is_starred ? t('fontproj_unstar') : t('fontproj_star')}
          className="p-1.5 rounded hover:bg-white/10 flex-shrink-0 transition-colors"
          style={{ color: project?.is_starred ? '#f9ab00' : C.textDim }}>
          <Star size={15} fill={project?.is_starred ? 'currentColor' : 'none'} />
        </button>
      }
      onDelete={() => trashMut.mutate()}
      deleteTitle={t('font_move_to_trash')}
      deleteConfirm={{
        title: t('font_delete_confirm_title'),
        message: t('font_delete_confirm_msg'),
        confirmLabel: t('common_delete', { defaultValue: 'Supprimer' }),
        variant: 'danger',
      }}
      menus={paintsharpMenus(t, {
        onSave: saveNow,
        onClose: () => { flushSave(); navigate('/paintsharp/fonteditor') },
        fileExtra: [
          { label: t('font_import_font'), onClick: () => importInputRef.current?.click() },
          'sep',
          ...EXPORT_FORMATS.map(fmt => ({
            label: t('font_export_fmt', { fmt: fmt.toUpperCase() }),
            onClick: () => doExport(fmt),
          })),
        ],
        onUndo: undo, onRedo: redo,
        editExtra: [
          { label: t('apex_ctx_cut'),     onClick: cutSel,   shortcut: 'Ctrl+X' },
          { label: t('font_glyph_copy'),  onClick: copySel,  shortcut: 'Ctrl+C' },
          { label: t('font_glyph_paste'), onClick: pasteSel, shortcut: 'Ctrl+V' },
          { label: t('apex_duplicate'),   onClick: duplicateSel, shortcut: 'Ctrl+D' },
          'sep',
          { label: t('font_select_all'), onClick: selectAll, shortcut: 'Ctrl+A' },
          { label: t('font_delete_selection'), onClick: deleteSel, shortcut: 'Suppr' },
        ],
        extraMenus: [{
          label: t('font_menu_glyph'),
          items: [
            { label: t('font_flip_h'), onClick: () => flipSel('h'), disabled: cp == null },
            { label: t('font_flip_v'), onClick: () => flipSel('v'), disabled: cp == null },
            { label: t('apex_rotate_cw'),  onClick: () => rotateSel(1),  disabled: cp == null },
            { label: t('apex_rotate_ccw'), onClick: () => rotateSel(-1), disabled: cp == null },
            { label: t('font_reverse_contours'), onClick: reverseSel, disabled: cp == null },
            'sep',
            { label: t('font_glyph_clear'), onClick: clearGlyph, disabled: cp == null },
          ],
        }, {
          label: t('apex_menu_path'),
          items: [
            { label: t('apex_pf_union'),     onClick: () => pathfinderSel('union'),     disabled: cp == null },
            { label: t('apex_pf_subtract'),  onClick: () => pathfinderSel('subtract'),  disabled: cp == null },
            { label: t('apex_pf_intersect'), onClick: () => pathfinderSel('intersect'), disabled: cp == null },
            { label: t('apex_pf_exclude'),   onClick: () => pathfinderSel('exclude'),   disabled: cp == null },
            'sep',
            { label: t('apex_path_simplify'), onClick: simplifySel, disabled: cp == null },
            { label: t('apex_path_smooth'),   onClick: smoothSel,   disabled: cp == null },
            'sep',
            { label: t('apex_path_offset_out'), onClick: () => offsetSel(10),  disabled: cp == null },
            { label: t('apex_path_offset_in'),  onClick: () => offsetSel(-10), disabled: cp == null },
          ],
        }],
        onZoomIn:  () => { const c = canvasRef.current; if (c) zoomAt(c.clientWidth / 2, c.clientHeight / 2, 1.25) },
        onZoomOut: () => { const c = canvasRef.current; if (c) zoomAt(c.clientWidth / 2, c.clientHeight / 2, 1 / 1.25) },
        onFit:     () => centerGlyph(advance),
        viewExtra: [
          { label: `${showFill ? '✓ ' : ''}${t('font_toggle_fill')}`, onClick: () => setShowFill(v => !v) },
          { label: `${showGrid ? '✓ ' : ''}${t('font_toggle_grid')}`, onClick: () => setShowGrid(v => !v) },
          { label: `${snapOn ? '✓ ' : ''}${t('font_snap_toggle')}`,  onClick: () => setSnapOn(v => !v) },
        ],
      })}
      topbarActions={<>
        {exportNote && <span className="text-xs max-w-72 truncate" style={{ color: C.accent }}>{exportNote}</span>}
        {penPts && <span className="text-xs" style={{ color: C.accent }}>{t('font_pen_hint')}</span>}
        <button onClick={saveNow} className="px-3 py-1 rounded text-xs" style={{ background: C.accent, color: '#fff' }}>
          {t('common_save')}
        </button>
      </>}
      optionsBar={
        <div className="flex items-center gap-2 h-full px-3 overflow-x-auto">
          <span className="text-[11px] font-medium flex-shrink-0" style={{ color: C.text }}>
            {cp != null ? `${t('font_glyph')} ${charLabel(cp)} · U+${cp.toString(16).toUpperCase().padStart(4, '0')}` : t('font_tab_overview')}
          </span>
          <div className="h-4 w-px flex-shrink-0" style={{ background: C.border }} />
          {cp != null && (
            <>
              {[
                { title: t('font_flip_h'), icon: FlipHorizontal, fn: () => flipSel('h') },
                { title: t('font_flip_v'), icon: FlipVertical,   fn: () => flipSel('v') },
                { title: t('font_delete_selection'), icon: Trash2, fn: deleteSel },
              ].map(({ title, icon: Icon, fn }) => (
                <button key={title} title={title} onClick={fn}
                  className="w-7 h-7 rounded flex items-center justify-center flex-shrink-0 hover:bg-white/10"
                  style={{ color: C.textDim }}>
                  <Icon size={14} />
                </button>
              ))}
              <div className="h-4 w-px flex-shrink-0" style={{ background: C.border }} />
              <span className="text-[11px] truncate" style={{ color: C.textDim }}>
                {toolHint}
              </span>
            </>
          )}
          {cp == null && (
            <span className="text-[11px]" style={{ color: C.textDim }}>{t('font_grid_hint')}</span>
          )}
        </div>
      }
      toolRailWidth={72}
      toolRail={<>
        <div className="grid grid-cols-2 gap-0.5">
          {([
            { id: 'select',  icon: MousePointer, label: t('font_tool_select') },
            { id: 'node',    icon: Spline,       label: t('font_tool_node') },
            { id: 'pen',     icon: PenTool,      label: t('font_tool_pen') },
            { id: 'pencil',  icon: Pencil,       label: t('apex_tool_pencil') },
            { id: 'rect',    icon: Square,       label: t('font_tool_rect') },
            { id: 'ellipse', icon: Circle,       label: t('font_tool_ellipse') },
            { id: 'zoom',    icon: Search,       label: t('font_tool_zoom') },
            { id: 'hand',    icon: Hand,         label: t('font_tool_hand') },
          ] as { id: Tool; icon: React.ComponentType<{ size?: number }>; label: string }[]).map(({ id, icon: Icon, label }) => (
            <button key={id} title={label}
              onClick={() => { if (id !== 'pen') { setPenPts(null); setPenMouse(null) } setPencilPts(null); setTool(id) }}
              className="w-8 h-8 rounded flex items-center justify-center transition-colors"
              style={{
                background: tool === id ? C.accent + '30' : 'transparent',
                color: tool === id ? C.accent : C.textDim,
              }}>
              <Icon size={16} />
            </button>
          ))}
        </div>

        <div className="h-px w-full my-1.5" style={{ background: C.border }} />
        <div className="flex flex-wrap gap-0.5">
          <button title={t('font_toggle_fill')} onClick={() => setShowFill(v => !v)}
            className="w-8 h-7 rounded flex items-center justify-center transition-colors"
            style={{ background: showFill ? C.accent + '30' : 'transparent', color: showFill ? C.accent : C.textDim }}>
            <PaintBucket size={14} />
          </button>
          <button title={t('font_snap_toggle')} onClick={() => setSnapOn(v => !v)}
            className="w-8 h-7 rounded flex items-center justify-center transition-colors"
            style={{ background: snapOn ? C.accent + '30' : 'transparent', color: snapOn ? C.accent : C.textDim }}>
            <Magnet size={14} />
          </button>
          <button title={t('font_toggle_grid')} onClick={() => setShowGrid(v => !v)}
            className="w-8 h-7 rounded flex items-center justify-center transition-colors"
            style={{ background: showGrid ? C.accent + '30' : 'transparent', color: showGrid ? C.accent : C.textDim }}>
            <Grid3x3 size={14} />
          </button>
        </div>

        <div style={{ flex: 1 }} />
        <button title={t('font_zoom_in')}
          onClick={() => { const c = canvasRef.current; if (c) zoomAt(c.clientWidth / 2, c.clientHeight / 2, 1.25) }}
          className="w-8 h-7 rounded flex items-center justify-center hover:bg-white/10"
          style={{ color: C.textDim }}>
          <ZoomIn size={13} />
        </button>
        <span className="text-[10px] text-center" style={{ color: C.textDim }}>{Math.round(cs.zoom * 100)}%</span>
        <button title={t('font_zoom_out')}
          onClick={() => { const c = canvasRef.current; if (c) zoomAt(c.clientWidth / 2, c.clientHeight / 2, 1 / 1.25) }}
          className="w-8 h-7 rounded flex items-center justify-center hover:bg-white/10"
          style={{ color: C.textDim }}>
          <ZoomOut size={13} />
        </button>
        <button title={t('font_fit')}
          onClick={() => centerGlyph(advance)}
          className="w-8 h-7 rounded flex items-center justify-center hover:bg-white/10 text-[10px]"
          style={{ color: C.textDim }}>
          {t('font_fit')}
        </button>
      </>}
      bottomBar={
        <div className="flex items-center gap-1 px-2 flex-shrink-0 overflow-x-auto"
             style={{ height: 32, background: C.header, borderTop: `1px solid ${C.border}` }}>
          <button
            onClick={() => setView('grid')}
            className="px-3 py-0.5 rounded text-xs flex-shrink-0 transition-colors flex items-center gap-1.5"
            style={{
              background: view === 'grid' ? C.accent + '25' : 'transparent',
              color:      view === 'grid' ? C.accent : C.textDim,
              border:     `1px solid ${view === 'grid' ? C.accent + '60' : 'transparent'}`,
            }}>
            <Grid2x2 size={12} /> {t('font_tab_overview')}
          </button>
          {openTabs.map(code => (
            <span key={code} className="flex items-center flex-shrink-0 rounded"
                  onContextMenu={e => onTabContextMenu(e, code)}
                  style={{
                    background: view === code ? C.accent + '25' : 'transparent',
                    border: `1px solid ${view === code ? C.accent + '60' : 'transparent'}`,
                  }}>
              <button onClick={() => openGlyph(code)}
                      className="pl-2.5 pr-1 py-0.5 text-xs"
                      style={{ color: view === code ? C.accent : C.textDim }}>
                {charLabel(code)}
              </button>
              <button onClick={() => closeTab(code)}
                      className="w-4 h-4 mr-1 rounded flex items-center justify-center hover:bg-white/10"
                      style={{ color: C.textDim }}>
                <X size={9} />
              </button>
            </span>
          ))}
        </div>
      }>
      <DockArea theme={C} storageKey="kubuno:paintsharp:fontDockLayout" viewportBg={C.bg}
        defaultArrangement={{ left: [['glyphs']], right: [['properties'], ['preview', 'kerning']] }}
        panels={fontPanels}>
        {view === 'grid' ? (
          <div className="w-full h-full overflow-y-auto p-5" style={{ background: C.bg }}>
            {SECTIONS.map(sec => (
              <div key={sec.key} className="mb-5">
                <div className="text-[11px] uppercase tracking-wide pb-2" style={{ color: C.textDim }}>
                  {t(sec.key)}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {sec.cps.map(code => (
                    <GlyphCell key={code} font={font} cp={code} size={62} showLabel
                               active={false} onOpen={openGlyph}
                               onContextMenu={onGlyphCellContextMenu} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <canvas ref={canvasRef} className="block w-full h-full" style={{ cursor, touchAction: 'none' }}
                  onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
                  onPointerCancel={onPointerUp} onDoubleClick={onDoubleClick}
                  onPointerLeave={() => setHotGuide(null)}
                  onContextMenu={onCanvasContextMenu} />
        )}
      </DockArea>
      {ctxMenu.menu}
      {/* Hidden picker for Fichier → Importer une police… */}
      <input ref={importInputRef} type="file" accept={IMPORT_ACCEPT} style={{ display: 'none' }}
             onChange={e => {
               const f = e.target.files?.[0]
               if (f) onImportFile(f)
               e.target.value = ''
             }} />
      {pendingImport && (
        <ConfirmDialog
          title={t('font_import_confirm_title')}
          message={t('font_import_confirm_msg')}
          confirmLabel={t('font_import_confirm_ok')}
          variant="warning"
          onConfirm={() => { applyImport(pendingImport); setPendingImport(null) }}
          onCancel={() => setPendingImport(null)}
        />
      )}
    </EditorShell>
  )
}
