// Professional signature dialog for PdfWriter — Acrobat-style: draw a smoothed
// ink signature, type one in a cursive font, or import an image (with optional
// white-background removal). Saved signatures are listed with live previews.
import { useEffect, useRef, useState } from 'react'
import { pickImageFile } from '@kubuno/sdk'
import type { TFunction } from 'i18next'
import { X, Trash2, Undo2, PenLine, Type as TypeIcon, ImagePlus, Loader2 } from 'lucide-react'
import { Button, RangeSlider } from '@ui'
import type { PdfSignature } from './api'
import { svgPathBounds } from './pdfExport'

const PEN_COLORS = ['#1a1a1a', '#1a4b8e', '#8e1a1a']
const TYPE_FONTS = [
  { label: 'Segoe Script',       css: "'Segoe Script', 'Brush Script MT', cursive" },
  { label: 'Brush Script',       css: "'Brush Script MT', 'Segoe Script', cursive" },
  { label: 'Lucida Handwriting', css: "'Lucida Handwriting', 'Segoe Script', cursive" },
  { label: 'Cursive',            css: 'cursive' },
  { label: 'Serif italique',     css: 'Georgia, serif' },
]

const PAD_W = 420
const PAD_H = 150

export interface PlacedSignature {
  /** SVG path (draw) or PNG data URL (type / import). */
  data: string
  /** height / width of the signature's natural bounds (placement box aspect). */
  ratio: number
  /** Stroke color for SVG-path signatures. */
  color?: string
}

export function PdfSignatureDialog({ t, sigs, busy, onPlace, onSave, onDelete, onClose }: {
  t: TFunction
  sigs: PdfSignature[]
  busy?: boolean
  /** Place the signature on the page (click-to-place). */
  onPlace: (sig: PlacedSignature) => void
  /** Persist a signature in the user's library. */
  onSave: (data: { name: string; sig_type: 'draw' | 'text' | 'image'; data: string }) => void
  onDelete: (id: string) => void
  onClose: () => void
}) {
  const [tab, setTab] = useState<'draw' | 'type' | 'import'>('draw')
  const [penColor, setPenColor] = useState(PEN_COLORS[0])
  const [penWidth, setPenWidth] = useState(2)
  const [saveToLibrary, setSaveToLibrary] = useState(true)
  const [sigName, setSigName] = useState('')

  // ── Draw tab: smoothed HiDPI ink pad ────────────────────────────────────────
  const padRef = useRef<HTMLCanvasElement>(null)
  const strokesRef = useRef<[number, number][][]>([])
  const currentRef = useRef<[number, number][]>([])
  const drawingRef = useRef(false)
  const [strokeCount, setStrokeCount] = useState(0)

  const redrawPad = () => {
    const cv = padRef.current; if (!cv) return
    const ctx = cv.getContext('2d'); if (!ctx) return
    const dpr = Math.min(window.devicePixelRatio || 1, 3)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, cv.width, cv.height)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.strokeStyle = penColor
    ctx.lineWidth = penWidth
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'
    const paint = (pts: [number, number][]) => {
      if (pts.length < 2) return
      ctx.beginPath()
      ctx.moveTo(pts[0][0], pts[0][1])
      for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2
        ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my)
      }
      const last = pts[pts.length - 1]
      ctx.lineTo(last[0], last[1])
      ctx.stroke()
    }
    strokesRef.current.forEach(paint)
    paint(currentRef.current)
    // Baseline guide.
    ctx.strokeStyle = 'rgba(0,0,0,0.15)'; ctx.lineWidth = 1; ctx.setLineDash([4, 4])
    ctx.beginPath(); ctx.moveTo(16, PAD_H - 34); ctx.lineTo(PAD_W - 16, PAD_H - 34); ctx.stroke()
    ctx.setLineDash([])
  }

  useEffect(() => {
    const cv = padRef.current; if (!cv) return
    const dpr = Math.min(window.devicePixelRatio || 1, 3)
    cv.width = PAD_W * dpr; cv.height = PAD_H * dpr
    cv.style.width = `${PAD_W}px`; cv.style.height = `${PAD_H}px`
    redrawPad()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])
  useEffect(() => { redrawPad() }, [penColor, penWidth, strokeCount]) // eslint-disable-line react-hooks/exhaustive-deps

  const padPoint = (e: React.PointerEvent): [number, number] => {
    const r = padRef.current!.getBoundingClientRect()
    return [e.clientX - r.left, e.clientY - r.top]
  }
  const onPadDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture(e.pointerId)
    drawingRef.current = true
    currentRef.current = [padPoint(e)]
  }
  const onPadMove = (e: React.PointerEvent) => {
    if (!drawingRef.current) return
    currentRef.current.push(padPoint(e))
    redrawPad()
  }
  const onPadUp = () => {
    if (!drawingRef.current) return
    drawingRef.current = false
    if (currentRef.current.length > 1) {
      strokesRef.current.push(currentRef.current)
      setStrokeCount(strokesRef.current.length)
    }
    currentRef.current = []
    redrawPad()
  }
  const clearPad   = () => { strokesRef.current = []; currentRef.current = []; setStrokeCount(0) }
  const undoStroke = () => { strokesRef.current.pop(); setStrokeCount(strokesRef.current.length) }

  const drawnPath = (): string | null => {
    const all = strokesRef.current
    if (!all.length) return null
    return all.map(pts =>
      pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')
    ).join(' ')
  }

  // ── Type tab ────────────────────────────────────────────────────────────────
  const [typedText, setTypedText] = useState('')
  const [typedFont, setTypedFont] = useState(TYPE_FONTS[0].css)

  const typedToPng = (): { data: string; ratio: number } | null => {
    const text = typedText.trim()
    if (!text) return null
    const scale = 3
    const meas = document.createElement('canvas').getContext('2d')!
    meas.font = `52px ${typedFont}`
    const w = Math.max(60, Math.ceil(meas.measureText(text).width) + 40)
    const h = 96
    const cv = document.createElement('canvas')
    cv.width = w * scale; cv.height = h * scale
    const ctx = cv.getContext('2d')!
    ctx.scale(scale, scale)
    ctx.font = `52px ${typedFont}`
    ctx.fillStyle = penColor
    ctx.textBaseline = 'middle'
    ctx.fillText(text, 20, h / 2)
    return { data: cv.toDataURL('image/png'), ratio: h / w }
  }

  // ── Import tab ──────────────────────────────────────────────────────────────
  const [removeWhite, setRemoveWhite] = useState(true)
  const [imported, setImported] = useState<{ data: string; ratio: number } | null>(null)

  const importFile = (file: File) => {
    const reader = new FileReader()
    reader.onload = () => {
      const img = new Image()
      img.onload = () => {
        const maxW = 800
        const s = Math.min(1, maxW / (img.width || 1))
        const w = Math.max(1, Math.round(img.width * s)), h = Math.max(1, Math.round(img.height * s))
        const cv = document.createElement('canvas')
        cv.width = w; cv.height = h
        const ctx = cv.getContext('2d')!
        ctx.drawImage(img, 0, 0, w, h)
        if (removeWhite) {
          const d = ctx.getImageData(0, 0, w, h)
          const px = d.data
          for (let i = 0; i < px.length; i += 4) {
            // Near-white → transparent ; grey shades keep a proportional alpha.
            const lum = (px[i] + px[i + 1] + px[i + 2]) / 3
            if (lum > 235) px[i + 3] = 0
            else if (lum > 190) px[i + 3] = Math.round(px[i + 3] * (235 - lum) / 45)
          }
          ctx.putImageData(d, 0, 0)
        }
        setImported({ data: cv.toDataURL('image/png'), ratio: h / w })
      }
      img.src = reader.result as string
    }
    reader.readAsDataURL(file)
  }

  /** Signature image import: the image comes from the core picker. */
  const importFromPicker = async () => {
    const file = await pickImageFile({ title: t('pdf_sig_import', { defaultValue: 'Importer une signature' }) })
    if (file) importFile(file)
  }

  // ── Apply (place + optional save) ───────────────────────────────────────────
  const currentSignature = (): { placed: PlacedSignature; sig_type: 'draw' | 'text' | 'image' } | null => {
    if (tab === 'draw') {
      const d = drawnPath()
      if (!d) return null
      const b = svgPathBounds(d)
      return { placed: { data: d, ratio: b ? b.h / b.w : 0.35, color: penColor }, sig_type: 'draw' }
    }
    if (tab === 'type') {
      const png = typedToPng()
      return png ? { placed: png, sig_type: 'text' } : null
    }
    return imported ? { placed: imported, sig_type: 'image' } : null
  }
  const canApply = tab === 'draw' ? strokeCount > 0 : tab === 'type' ? typedText.trim().length > 0 : !!imported

  const apply = () => {
    const cur = currentSignature()
    if (!cur) return
    if (saveToLibrary) {
      onSave({ name: sigName.trim() || t('pdf_signature_name', { defaultValue: 'Ma signature' }), sig_type: cur.sig_type, data: cur.placed.data })
    }
    onPlace(cur.placed)
  }

  // ── Saved-signature preview ─────────────────────────────────────────────────
  const SigPreview = ({ sig }: { sig: PdfSignature }) => {
    if (sig.data.startsWith('data:')) {
      return <img src={sig.data} alt={sig.name} className="max-h-10 max-w-[130px] object-contain" style={{ filter: 'invert(0.85)' }} />
    }
    const b = svgPathBounds(sig.data)
    if (!b) return <span className="text-xs text-[#8e8e8e]">{sig.name}</span>
    return (
      <svg width={130} height={40} viewBox={`${b.x - 4} ${b.y - 4} ${b.w + 8} ${b.h + 8}`} preserveAspectRatio="xMidYMid meet">
        <path d={sig.data} fill="none" stroke="#d6d6d6" strokeWidth={Math.max(1.5, b.w / 90)} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }

  const tabBtn = (key: 'draw' | 'type' | 'import', icon: React.ReactNode, label: string) => (
    <button
      onClick={() => setTab(key)}
      className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg transition-colors ${
        tab === key ? 'bg-[#5a9bdc33] text-[#5a9bdc]' : 'text-[#8e8e8e] hover:bg-[#454545]'}`}
    >
      {icon}{label}
    </button>
  )

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 no-print" onClick={onClose}>
      <div className="bg-[#323232] rounded-2xl shadow-2xl p-5 w-[540px] max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-base font-semibold text-[#d6d6d6]">{t('pdf_add_signature')}</h3>
          <button onClick={onClose} className="text-[#8e8e8e] hover:text-[#d6d6d6]"><X size={18} /></button>
        </div>

        {/* Saved signatures with previews */}
        {sigs.length > 0 && (
          <div className="mb-4">
            <p className="text-xs text-[#8e8e8e] mb-2">{t('pdf_saved_signatures')}</p>
            <div className="flex flex-wrap gap-2">
              {sigs.map(sig => (
                <div key={sig.id} className="group relative border border-[#212121] rounded-lg hover:bg-[#3d3d3d] transition-colors">
                  <button
                    onClick={() => {
                      const b = sig.data.startsWith('data:') ? null : svgPathBounds(sig.data)
                      onPlace({ data: sig.data, ratio: b ? b.h / b.w : 0.35 })
                    }}
                    title={sig.name}
                    className="px-3 py-2 flex items-center justify-center min-w-[80px]"
                  >
                    <SigPreview sig={sig} />
                  </button>
                  <button
                    onClick={() => onDelete(sig.id)}
                    title={t('common_delete', { defaultValue: 'Supprimer' })}
                    className="absolute -top-1.5 -right-1.5 p-1 rounded-full bg-[#1e1e1e] text-[#e84a4a] opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Tabs */}
        <div className="flex items-center gap-1 mb-3 border-b border-[#212121] pb-2">
          {tabBtn('draw',   <PenLine size={13} />,  t('pdf_sig_tab_draw',   { defaultValue: 'Dessiner' }))}
          {tabBtn('type',   <TypeIcon size={13} />, t('pdf_sig_tab_type',   { defaultValue: 'Taper' }))}
          {tabBtn('import', <ImagePlus size={13} />, t('pdf_sig_tab_import', { defaultValue: 'Importer' }))}
        </div>

        {tab === 'draw' && (
          <>
            <canvas
              ref={padRef}
              className="block w-full rounded-xl border-2 border-[#212121]"
              style={{ touchAction: 'none', cursor: 'crosshair', background: '#fafafa' }}
              onPointerDown={onPadDown}
              onPointerMove={onPadMove}
              onPointerUp={onPadUp}
              onPointerLeave={onPadUp}
            />
            <div className="flex items-center justify-between mt-2 gap-3">
              <div className="flex items-center gap-2">
                {PEN_COLORS.map(c => (
                  <button key={c} onClick={() => setPenColor(c)}
                    className={`w-5 h-5 rounded-full border-2 transition-transform ${penColor === c ? 'border-[#5a9bdc] scale-110' : 'border-[#212121]'}`}
                    style={{ background: c }} />
                ))}
                <div className="w-24 ml-2">
                  <RangeSlider min={1} max={5} step={0.5} value={penWidth} onChange={setPenWidth}
                    accent="#5a9bdc" trackColor="rgba(255,255,255,0.15)" aria-label={t('pdf_sig_pen_width', { defaultValue: 'Épaisseur' })} />
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button onClick={undoStroke} disabled={!strokeCount} title={t('pdf_undo', { defaultValue: 'Annuler' })}
                  className="p-1.5 rounded hover:bg-[#454545] text-[#8e8e8e] disabled:opacity-30"><Undo2 size={14} /></button>
                <button onClick={clearPad} disabled={!strokeCount}
                  className="text-xs text-[#8e8e8e] hover:text-[#d6d6d6] disabled:opacity-30 px-2 py-1">{t('pdf_clear')}</button>
              </div>
            </div>
          </>
        )}

        {tab === 'type' && (
          <>
            <input
              autoFocus
              value={typedText}
              onChange={e => setTypedText(e.target.value)}
              placeholder={t('pdf_sig_type_placeholder', { defaultValue: 'Votre nom…' })}
              className="w-full px-3 py-2 rounded-lg bg-[#252525] border border-[#212121] text-[#d6d6d6] text-sm outline-none focus:border-[#5a9bdc]"
            />
            <div className="flex flex-col gap-1 mt-3 max-h-56 overflow-y-auto">
              {TYPE_FONTS.map(f => (
                <button
                  key={f.label}
                  onClick={() => setTypedFont(f.css)}
                  className={`flex items-center justify-between px-3 py-2 rounded-lg border transition-colors ${
                    typedFont === f.css ? 'border-[#5a9bdc] bg-[#5a9bdc1a]' : 'border-[#212121] hover:bg-[#3d3d3d]'}`}
                >
                  <span className="text-2xl text-[#d6d6d6]" style={{ fontFamily: f.css, fontStyle: f.css.includes('Georgia') ? 'italic' : undefined }}>
                    {typedText.trim() || t('pdf_sig_type_sample', { defaultValue: 'Signature' })}
                  </span>
                  <span className="text-[10px] text-[#8e8e8e] ml-3">{f.label}</span>
                </button>
              ))}
            </div>
          </>
        )}

        {tab === 'import' && (
          <>
            <div
              className="flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-[#212121] py-6 cursor-pointer hover:border-[#5a9bdc] transition-colors"
              onClick={() => { void importFromPicker() }}
            >
              {imported
                ? <img src={imported.data} alt="" className="max-h-24 max-w-[300px] object-contain" style={{ background: 'repeating-conic-gradient(#3a3a3a 0% 25%, #2e2e2e 0% 50%) 0 0 / 14px 14px' }} />
                : <><ImagePlus size={22} className="text-[#8e8e8e]" /><span className="text-xs text-[#8e8e8e]">{t('pdf_sig_import_hint', { defaultValue: 'Cliquer pour choisir une image (PNG, JPG)' })}</span></>}
            </div>
            <label className="flex items-center gap-2 mt-2 text-xs text-[#8e8e8e] cursor-pointer select-none">
              <input type="checkbox" checked={removeWhite} onChange={e => setRemoveWhite(e.target.checked)} />
              {t('pdf_sig_remove_white', { defaultValue: 'Rendre le fond blanc transparent' })}
            </label>
          </>
        )}

        {/* Save-to-library + actions */}
        <div className="flex items-center gap-2 mt-4">
          <label className="flex items-center gap-2 text-xs text-[#8e8e8e] cursor-pointer select-none whitespace-nowrap">
            <input type="checkbox" checked={saveToLibrary} onChange={e => setSaveToLibrary(e.target.checked)} />
            {t('pdf_sig_save', { defaultValue: 'Enregistrer' })}
          </label>
          <input
            value={sigName}
            onChange={e => setSigName(e.target.value)}
            disabled={!saveToLibrary}
            placeholder={t('pdf_signature_name', { defaultValue: 'Ma signature' })}
            className="flex-1 px-2 py-1.5 rounded-lg bg-[#252525] border border-[#212121] text-[#d6d6d6] text-xs outline-none focus:border-[#5a9bdc] disabled:opacity-40"
          />
          <Button variant="secondary" size="sm" onClick={onClose}>{t('common_cancel')}</Button>
          <Button size="sm" onClick={apply} disabled={!canApply || busy} icon={busy ? <Loader2 size={13} className="animate-spin" /> : undefined}>
            {t('pdf_place_signature')}
          </Button>
        </div>
        <p className="text-[10px] text-[#8e8e8e] mt-2">{t('pdf_sig_place_hint', { defaultValue: 'Cliquez ensuite sur la page à l’endroit où poser la signature.' })}</p>
      </div>
    </div>
  )
}
