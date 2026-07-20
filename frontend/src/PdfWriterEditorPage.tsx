import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import * as pdfjsLib from 'pdfjs-dist'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import {
  Save, Download, ZoomIn, ZoomOut, RotateCw,
  Plus, Trash2, ChevronLeft, ChevronRight,
  MousePointer2, Type, Highlighter, Underline, Strikethrough,
  MessageSquare, Pen, Square, Circle, Minus, MoveRight,
  Stamp, PenLine, TextCursorInput, CheckSquare,
  Loader2, X, Star, Image as ImageIcon, Wand2,
  Undo2, Redo2, Copy, ArrowUp, ArrowDown,
  Hand, Maximize2, Check, ScanText, Printer,
  Scissors, ClipboardPaste, Bold, Italic,
  TextAlignStart, TextAlignCenter, TextAlignEnd,
  AlignStartVertical, AlignCenterVertical, AlignEndVertical,
  AlignStartHorizontal, AlignCenterHorizontal, AlignEndHorizontal,
  AlignHorizontalSpaceBetween, AlignVerticalSpaceBetween,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { uid } from './uid'
import { pdfWriterApi, type Annotation, type PdfSignature, type TextAnnotation, type ShapeAnnotation } from './api'
import { extractPageElements } from './pdfExtract'
import { buildAnnotatedPdf, svgPathBounds, type ExportPage } from './pdfExport'
import { useAuthStore } from '@kubuno/sdk'
import { useConfirm } from '@kubuno/sdk'
import { ConfirmDialog } from '@ui'
import { Button, MenuDropdown, RangeSlider, FontSizeField, type MenuItem } from '@ui'
import { C, EditorShell, DockArea, ColorField, paintsharpMenus } from './ui'
import { useDebouncedAutosave } from './useAutosave'
import { recognizeImage, disposeOcr, type OcrLang } from './pdfOcr'
import { usePdfFonts } from './pdfFonts'
import { PdfSignatureDialog, type PlacedSignature } from './PdfSignatureDialog'

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).href

// ── Types locaux ─────────────────────────────────────────────────────────────

type Tool =
  | 'select' | 'text' | 'highlight' | 'underline' | 'strikethrough'
  | 'sticky-note' | 'freehand' | 'rect' | 'ellipse' | 'line' | 'arrow'
  | 'stamp' | 'signature' | 'form-text' | 'form-checkbox'

const STAMP_TYPES = [
  { key: 'approved',     labelKey: 'pdf_stamp_approved',     color: '#1e8e3e' },
  { key: 'not-approved', labelKey: 'pdf_stamp_not_approved', color: '#d93025' },
  { key: 'rejected',     labelKey: 'pdf_stamp_rejected',     color: '#d93025' },
  { key: 'confidential', labelKey: 'pdf_stamp_confidential', color: '#d93025' },
  { key: 'draft',        labelKey: 'pdf_stamp_draft',        color: '#f9ab00' },
  { key: 'revised',      labelKey: 'pdf_stamp_revised',      color: '#1a73e8' },
  { key: 'final',        labelKey: 'pdf_stamp_final',        color: '#1e8e3e' },
  { key: 'for-review',   labelKey: 'pdf_stamp_for_review',   color: '#1a73e8' },
]

const MIN_SCALE = 0.1
const MAX_SCALE = 6
const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s))
const VIEW_PAD = 56 // marge interne du conteneur de page (px) pour les ajustements

// ── Composant principal ───────────────────────────────────────────────────────

export default function PdfWriterEditorPage() {
  const { t } = useTranslation('paintsharp')
  const { confirm, confirmState, handleConfirm, handleCancel } = useConfirm()
  const { id }    = useParams<{ id: string }>()
  const navigate  = useNavigate()
  const qc        = useQueryClient()
  const token     = useAuthStore(s => s.accessToken)

  // ── État général ──────────────────────────────────────────────────────────
  const [activeTool, setActiveTool] = useState<Tool>('select')
  const [currentPage, setCurrentPage]   = useState(1)
  const [scale, setScale]               = useState(1.0)
  const [pdfDoc, setPdfDoc]             = useState<PDFDocumentProxy | null>(null)
  const [loading, setLoading]           = useState(true)
  const [saving, setSaving]             = useState(false)
  const [dirty, setDirty]               = useState(false)

  // Annotations pour la page courante (éditables en mémoire, sauvegardées à la demande)
  const [annotations, setAnnotations]   = useState<Annotation[]>([])
  // Sélection multiple (façon Acrobat : Maj-clic + rectangle élastique). Le dernier
  // élément ajouté est le « primaire » (poignées de redimensionnement, panneau de propriétés).
  const [selectedIds, setSelectedIds]   = useState<string[]>([])
  const selectedId = selectedIds.length ? selectedIds[selectedIds.length - 1] : null
  const selectOnly = useCallback((id: string | null) => setSelectedIds(id ? [id] : []), [])
  const toggleSel  = useCallback((id: string) => setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]), [])
  const clearSel   = useCallback(() => setSelectedIds([]), [])
  // Édition de texte en place (double-clic) + déplacement/redimensionnement d'éléments.
  const [editingTextId, setEditingTextId] = useState<string | null>(null)
  const [converting, setConverting]     = useState(false)
  // Drag d'élément(s) : déplacement (potentiellement groupé), redimensionnement
  // ou rotation (élément unique, poignée dédiée).
  const elDragRef = useRef<{
    id: string; mode: 'move' | 'resize' | 'rotate'; handle?: string; startX: number; startY: number
    orig: { x: number; y: number; width: number; height: number }
    origRot?: number                                  // rotation de départ (mode rotate)
    center?: { x: number; y: number }                 // centre de rotation (points PDF)
    startAngle?: number                               // angle curseur→centre au mousedown
    group?: { id: string; x: number; y: number }[]   // positions d'origine pour un déplacement groupé
    moved?: boolean                                   // a réellement bougé (sinon = simple clic)
  } | null>(null)
  const dragSnappedRef = useRef(false) // historique : snapshot une fois au 1er mouvement
  // Positions d'origine des éléments sélectionnés (pour un déplacement groupé).
  const dragOrigRef = useRef<Map<string, { x: number; y: number; points?: [number, number][] }>>(new Map())
  const imgInputRef = useRef<HTMLInputElement>(null)
  // Menu contextuel (clic droit) sur un objet — rendu via MenuDropdown de @ui.
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; id: string } | null>(null)
  // Menu des niveaux de zoom (façon Acrobat).
  const [zoomMenu, setZoomMenu] = useState<{ x: number; y: number } | null>(null)
  // OCR (reconnaissance de texte) — dialogue d'options + état d'avancement.
  const [ocrDialog, setOcrDialog]   = useState(false)
  const [ocrLang, setOcrLang]       = useState<OcrLang>('fra+eng')
  const [ocrScope, setOcrScope]     = useState<'page' | 'doc'>('page')
  const [ocrMode, setOcrMode]       = useState<'editable' | 'invisible'>('editable')
  const [ocrRunning, setOcrRunning] = useState(false)
  const [ocrStatus, setOcrStatus]   = useState('')
  const [ocrPct, setOcrPct]         = useState(0)
  const [ocrResultMsg, setOcrResultMsg] = useState<string | null>(null)
  // Presse-papiers interne (couper / copier / coller d'annotations).
  const clipboardRef = useRef<Annotation[]>([])
  const [clipCount, setClipCount] = useState(0)
  // Version de l'historique → recalcul de canUndo/canRedo au rendu.
  const [histVer, setHistVer] = useState(0)
  // Signature en attente de placement (clic sur la page).
  const pendingSigRef = useRef<PlacedSignature | null>(null)
  // Tampon personnalisé (texte + couleur libres).
  const [customStampText, setCustomStampText]   = useState('')
  const [customStampColor, setCustomStampColor] = useState('#d93025')
  // Polices proposées (intégrées + System/Fonts) et police par défaut du texte.
  const fonts = usePdfFonts()
  const fontsRef = useRef(fonts)
  fontsRef.current = fonts
  const [fontFamily, setFontFamily] = useState('Helvetica')
  // Impression en cours (export → iframe cachée → print).
  const [printing, setPrinting] = useState(false)

  // ── Navigation du canevas (pan / zoom façon Acrobat) ────────────────────────
  const scrollRef = useRef<HTMLDivElement>(null)
  const [handTool, setHandTool]   = useState(false)   // outil Main actif
  const [spaceDown, setSpaceDown] = useState(false)   // barre d'espace maintenue → pan temporaire
  const panRef = useRef<{ x: number; y: number; sl: number; st: number } | null>(null)
  const [panning, setPanning]     = useState(false)
  // Repères d'alignement magnétiques (en px écran) affichés pendant un déplacement.
  const [guides, setGuides] = useState<{ v: number[]; h: number[] }>({ v: [], h: [] })
  // Rectangle de sélection élastique (en px écran, relatif au conteneur de page).
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const marqueeStartRef = useRef<{ x: number; y: number } | null>(null)
  const shiftRef = useRef(false)

  // Outil en cours de tracé (freehand)
  const [drawing, setDrawing]           = useState(false)
  // Points de l'encre en cours — en ref (pas de re-render par point : tracé fluide).
  const freehandRef = useRef<[number, number][]>([])

  // Outil en cours de tracé (shapes / markup)
  const [shapeDraft, setShapeDraft]     = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [shapeStart, setShapeStart]     = useState<{ x: number; y: number } | null>(null)

  // Modal signature
  const [showSigPanel, setShowSigPanel]     = useState(false)
  const [showStampPicker, setShowStampPicker] = useState(false)
  const [activeStamp, setActiveStamp]       = useState<string>('approved')
  const [selectedColor, setSelectedColor]   = useState('#ffff00')
  const [fontSize, setFontSize]             = useState(14)

  // Refs
  const canvasRef     = useRef<HTMLCanvasElement>(null)
  const overlayRef    = useRef<SVGSVGElement>(null)
  const drawCanvasRef = useRef<HTMLCanvasElement>(null)
  const pageRef       = useRef<PDFPageProxy | null>(null)

  // Aligne la taille logique (CSS px) de l'overlay SVG + du calque de dessin sur la
  // page rendue, en sur-échantillonnant le canevas de dessin selon le DPR (traits nets).
  const syncOverlaySize = useCallback((w: number, h: number, dpr: number) => {
    const ov = overlayRef.current
    if (ov) {
      ov.setAttribute('width',  String(w))
      ov.setAttribute('height', String(h))
      ov.setAttribute('viewBox', `0 0 ${w} ${h}`)
    }
    const dc = drawCanvasRef.current
    if (dc) {
      dc.width  = Math.round(w * dpr)
      dc.height = Math.round(h * dpr)
      dc.style.width  = `${w}px`
      dc.style.height = `${h}px`
      dc.getContext('2d')?.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
  }, [])

  // ── Données serveur ───────────────────────────────────────────────────────
  const { data: docData } = useQuery({
    queryKey: ['pdf-doc', id],
    queryFn:  () => pdfWriterApi.getDocument(id!).then(r => r.data),
    enabled:  !!id,
  })

  // ── Titre éditable (standard WorkspaceShell) — synchronisé depuis le document ─
  const [titleDraft, setTitleDraft] = useState('')
  useEffect(() => { if (docData?.title != null) setTitleDraft(docData.title) }, [docData?.title])
  const renameMut = useMutation({
    mutationFn: (title: string) => pdfWriterApi.updateDocument(id!, { title }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['pdf-doc', id] }) },
  })
  const starMut = useMutation({
    mutationFn: (is_starred: boolean) => pdfWriterApi.updateDocument(id!, { is_starred }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['pdf-doc', id] }) },
  })
  const trashMut = useMutation({
    mutationFn: () => pdfWriterApi.trashDocument(id!),
    onSuccess: () => { navigate('/paintsharp/pdfwriter') },
  })
  const commitTitle = () => {
    const v = titleDraft.trim()
    if (v && v !== docData?.title) renameMut.mutate(v)
    else if (!v && docData?.title) setTitleDraft(docData.title)
  }

  const { data: pageData } = useQuery({
    queryKey: ['pdf-page', id, currentPage],
    queryFn:  () => pdfWriterApi.getPage(id!, currentPage).then(r => r.data),
    enabled:  !!id,
    staleTime: 0,
  })

  // Pages « converties en éléments éditables » (contenu extrait) → on masque le rendu
  // d'origine et on n'affiche que les éléments (texte/images) manipulables.
  // editMode = document entier éditable → chaque page est extraite paresseusement.
  const docSettings = (docData as unknown as { settings?: { extractedPages?: number[]; editMode?: boolean } } | undefined)?.settings
  const editMode    = docSettings?.editMode === true
  const isExtracted = (docSettings?.extractedPages ?? []).includes(currentPage)
  const docSettingsRef = useRef(docSettings)
  docSettingsRef.current = docSettings
  const extractingRef = useRef<Set<number>>(new Set())

  const { data: sigsData } = useQuery({
    queryKey: ['pdf-signatures'],
    queryFn:  () => pdfWriterApi.listSignatures().then(r => r.data.signatures),
  })

  const saveMut = useMutation({
    mutationFn: () => pdfWriterApi.savePage(id!, currentPage, { annotations }),
    onSuccess:  () => { setDirty(false); setSaving(false) },
    onSettled:  () => setSaving(false),
  })

  // Autosave fiable (debounce + flush au démontage/fermeture) en plus de
  // l'enregistrement manuel. (Sauve les annotations de la page courante.)
  useDebouncedAutosave(annotations, !!id, () => saveMut.mutate())

  // ── Gestion des pages (façon Acrobat : ajouter / supprimer / pivoter) ───────
  const refreshDoc = () => { qc.invalidateQueries({ queryKey: ['pdf-doc', id] }); qc.invalidateQueries({ queryKey: ['pdf-page', id] }) }
  const addPageMut = useMutation({
    mutationFn: (after: number) => pdfWriterApi.addPage(id!, { width: pageW, height: pageH, after }),
    onSuccess: (r) => { refreshDoc(); if (r?.data?.page_number) setCurrentPage(r.data.page_number) },
  })
  const deletePageMut = useMutation({
    mutationFn: (n: number) => pdfWriterApi.deletePage(id!, n),
    onSuccess: () => { refreshDoc(); setCurrentPage(p => Math.max(1, p - 1)) },
  })
  const rotatePageMut = useMutation({
    mutationFn: ({ n, rot }: { n: number; rot: number }) => pdfWriterApi.rotatePage(id!, n, rot),
    onSuccess: () => refreshDoc(),
  })

  // Remappe des annotations pour une rotation de page de +90° horaire : les
  // objets restent « collés » au contenu (comme Acrobat). Point (x,y) de
  // l'ancien espace affiché (hauteur oldH) → (oldH − y, x) dans le nouveau.
  const remapAnnotations90 = (anns: Annotation[], oldH: number): Annotation[] =>
    anns.map(a => {
      const an = a as unknown as {
        type: string; x: number; y: number; width?: number; height?: number
        points?: [number, number][]; rotation?: number
      }
      if (an.points?.length) {
        const pts = an.points.map(p => [oldH - p[1], p[0]] as [number, number])
        return { ...a, points: pts, x: 0, y: 0 } as Annotation
      }
      if (an.type === 'line' || an.type === 'arrow') {
        // Vecteur exact via ses deux extrémités (pas de champ rotation à gérer).
        const p1 = { x: oldH - an.y, y: an.x }
        const p2 = { x: oldH - (an.y + (an.height ?? 0)), y: an.x + (an.width ?? 0) }
        return { ...a, x: p1.x, y: p1.y, width: p2.x - p1.x, height: p2.y - p1.y } as Annotation
      }
      const w = an.width ?? 20, h = an.height ?? 20
      const cx = an.x + w / 2, cy = an.y + h / 2
      const ncx = oldH - cy, ncy = cx
      const rot = ((an.rotation ?? 0) + 90) % 360
      return { ...a, x: ncx - w / 2, y: ncy - h / 2, rotation: rot === 0 ? undefined : rot } as Annotation
    })

  // Pivote une page de +90° en remappant d'abord ses annotations, pour qu'elles
  // suivent le contenu.
  const rotatePagePlus90 = useCallback(async (n: number) => {
    const meta = docData?.pages?.find(p => p.page_number === n)
    const rot = meta?.rotation ?? (n === currentPage ? (pageData?.rotation ?? 0) : 0)
    const bw = meta?.width ?? pageData?.width ?? 595
    const bh = meta?.height ?? pageData?.height ?? 842
    const oldH = rot % 180 !== 0 ? bw : bh   // hauteur AFFICHÉE avant rotation
    try {
      if (n === currentPage) {
        const remapped = remapAnnotations90(annotationsRef.current, oldH)
        setAnnotations(remapped)
        await pdfWriterApi.savePage(id!, n, { annotations: remapped })
      } else {
        const r = await pdfWriterApi.getPage(id!, n)
        const remapped = remapAnnotations90((r.data.annotations as Annotation[]) ?? [], oldH)
        await pdfWriterApi.savePage(id!, n, { annotations: remapped })
      }
    } catch { /* remap best-effort : la rotation reste appliquée */ }
    rotatePageMut.mutate({ n, rot: (rot + 90) % 360 })
  }, [docData?.pages, currentPage, pageData?.rotation, pageData?.width, pageData?.height, id, rotatePageMut])

  // Sync annotations quand on change de page (réinitialise l'historique annuler/rétablir)
  useEffect(() => {
    if (pageData) {
      setAnnotations((pageData.annotations as Annotation[]) ?? [])
      clearSel()
      historyRef.current = { past: [], future: [] }
      setHistVer(v => v + 1)
    }
  }, [pageData])

  // ── Chargement PDF ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!id || !token) return
    let cancelled = false

    setLoading(true)
    const url = pdfWriterApi.sourceUrl(id)

    const loadPdf = async () => {
      try {
        const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
        if (!resp.ok) { setLoading(false); return }
        const buf = await resp.arrayBuffer()
        if (cancelled) return
        // pdfjs v6 : le teardown passe par la tâche de chargement, plus par le doc.
        const task = pdfjsLib.getDocument({ data: buf })
        const doc = await task.promise
        if (cancelled) { task.destroy(); return }
        setPdfDoc(doc)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    loadPdf()
    return () => { cancelled = true }
  }, [id, token])

  // Index de la page dans le binaire source : suit les réorganisations. Tant que
  // les métadonnées serveur n'ont pas répondu, on suppose l'ordre d'origine.
  const srcIdx = pageData ? (pageData.source_index ?? null) : currentPage - 1
  const dbRot  = pageData?.rotation ?? 0
  const hasSourcePage = !!pdfDoc && srcIdx != null && srcIdx >= 0 && srcIdx < (pdfDoc?.numPages ?? 0)

  // Rendu de la page courante (sauf si la page est « extraite » → page blanche + éléments)
  useLayoutEffect(() => {
    if (!pdfDoc || !canvasRef.current || isExtracted || !hasSourcePage) return
    let cancelled = false

    pdfDoc.getPage((srcIdx as number) + 1).then(page => {
      if (cancelled) return
      pageRef.current = page
      // Logical viewport (CSS px) drives the overlay/coordinate space; the canvas
      // backing store is oversampled by the device pixel ratio so text stays crisp
      // at any zoom — like Acrobat's rendering. The DB rotation is applied on top
      // of the page's intrinsic /Rotate.
      const rot    = (((page.rotate + dbRot) % 360) + 360) % 360
      const dpr    = Math.min(window.devicePixelRatio || 1, 3)
      const vp     = rot === page.rotate ? page.getViewport({ scale }) : page.getViewport({ scale, rotation: rot })
      const vpHi   = rot === page.rotate ? page.getViewport({ scale: scale * dpr }) : page.getViewport({ scale: scale * dpr, rotation: rot })
      const canvas = canvasRef.current!
      canvas.width        = Math.round(vpHi.width)
      canvas.height       = Math.round(vpHi.height)
      canvas.style.width  = `${vp.width}px`
      canvas.style.height = `${vp.height}px`
      const ctx    = canvas.getContext('2d')!
      page.render({ canvas, canvasContext: ctx, viewport: vpHi })

      syncOverlaySize(vp.width, vp.height, dpr)
    })

    return () => { cancelled = true }
  }, [pdfDoc, currentPage, scale, isExtracted, srcIdx, dbRot, hasSourcePage])

  // Dimensions de page (points) — issues de la page serveur, sinon A4 par défaut.
  // La rotation 90/270 échange largeur et hauteur AFFICHÉES (espace annotations).
  const basePageW = pageData?.width  ?? 595
  const basePageH = pageData?.height ?? 842
  const rotSwap = dbRot % 180 !== 0
  const pageW = rotSwap ? basePageH : basePageW
  const pageH = rotSwap ? basePageW : basePageH

  // ── Rendu d'une page VIERGE quand il n'y a pas de page source ───────────────
  // (document créé sans import — ou page ajoutée après import : l'API source ne
  //  la contient pas ; on dessine alors une vraie page blanche dimensionnée.)
  useLayoutEffect(() => {
    if ((pdfDoc && !isExtracted && hasSourcePage) || loading || !canvasRef.current) return
    const dpr = Math.min(window.devicePixelRatio || 1, 3)
    const w = Math.max(1, Math.round(pageW * scale))
    const h = Math.max(1, Math.round(pageH * scale))
    const canvas = canvasRef.current
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr)
    canvas.style.width = `${w}px`; canvas.style.height = `${h}px`
    const ctx = canvas.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, w, h)
    syncOverlaySize(w, h, dpr)
  }, [pdfDoc, loading, scale, pageW, pageH, currentPage, isExtracted, hasSourcePage])

  // ── Calcul du zoom initial ────────────────────────────────────────────────
  useEffect(() => {
    if (!pdfDoc) return
    pdfDoc.getPage(1).then(page => {
      const vp = page.getViewport({ scale: 1 })
      const fit = Math.min((window.innerWidth - 480) / vp.width, (window.innerHeight - 112) / vp.height, 1.5)
      setScale(Math.max(0.5, fit))
    })
  }, [pdfDoc])

  // Zoom initial pour une page vierge (sans PDF).
  useEffect(() => {
    if (pdfDoc || !pageData) return
    const fit = Math.min((window.innerWidth - 480) / pageW, (window.innerHeight - 112) / pageH, 1.5)
    setScale(Math.max(0.5, fit))
  }, [pdfDoc, pageData, pageW, pageH])

  // ── Sauvegarde auto Ctrl+S ────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        handleSave()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // ── Helpers ───────────────────────────────────────────────────────────────

  // ── Annuler / Rétablir (historique des annotations de la page courante) ──────
  const annotationsRef = useRef(annotations)
  annotationsRef.current = annotations
  const scaleRef = useRef(scale)
  scaleRef.current = scale
  const historyRef = useRef<{ past: Annotation[][]; future: Annotation[][] }>({ past: [], future: [] })
  const clone = (a: Annotation[]) => JSON.parse(JSON.stringify(a)) as Annotation[]
  // À appeler AVANT une modification discrète (ajout, suppression, début de drag, édition…).
  const snapshot = useCallback(() => {
    const h = historyRef.current
    h.past.push(clone(annotationsRef.current))
    if (h.past.length > 60) h.past.shift()
    h.future = []
    setHistVer(v => v + 1)
  }, [])
  const undo = useCallback(() => {
    const h = historyRef.current
    if (!h.past.length) return
    h.future.push(clone(annotationsRef.current))
    setAnnotations(h.past.pop()!); clearSel(); setDirty(true)
    setHistVer(v => v + 1)
  }, [])
  const redo = useCallback(() => {
    const h = historyRef.current
    if (!h.future.length) return
    h.past.push(clone(annotationsRef.current))
    setAnnotations(h.future.pop()!); clearSel(); setDirty(true)
    setHistVer(v => v + 1)
  }, [])
  void histVer // (lu implicitement : déclenche le re-rendu de canUndo/canRedo)
  const canUndo = historyRef.current.past.length > 0
  const canRedo = historyRef.current.future.length > 0

  const addAnnotation = useCallback((ann: Annotation) => {
    snapshot()
    setAnnotations(prev => [...prev, ann])
    setDirty(true)
    selectOnly(ann.id)
  }, [snapshot])

  const deleteSelected = useCallback(() => {
    const ids = selectedIds
    if (!ids.length) return
    snapshot()
    const set = new Set(ids)
    setAnnotations(prev => prev.filter(a => !set.has(a.id)))
    clearSel()
    setDirty(true)
  }, [selectedIds, snapshot, clearSel])

  // Met à jour un élément (déplacement / redimensionnement / édition de contenu).
  const updateAnn = useCallback((aid: string, patch: Record<string, unknown>) => {
    setAnnotations(prev => prev.map(a => a.id === aid ? { ...a, ...patch } as Annotation : a))
    setDirty(true)
  }, [])

  // Boîte englobante d'une annotation en points PDF (gère freehand + éléments ponctuels).
  const bboxOf = useCallback((a: Annotation): { x: number; y: number; w: number; h: number } => {
    const an = a as unknown as { x: number; y: number; width?: number; height?: number; points?: [number, number][]; type: string }
    if (an.type === 'freehand' && an.points?.length) {
      const xs = an.points.map(p => p[0]), ys = an.points.map(p => p[1])
      const x0 = Math.min(...xs), y0 = Math.min(...ys)
      return { x: x0, y: y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0 }
    }
    if (an.type === 'sticky-note') return { x: an.x, y: an.y, w: 20, h: 20 }
    const w = an.width ?? 0, h = an.height ?? 0
    return { x: Math.min(an.x, an.x + w), y: Math.min(an.y, an.y + h), w: Math.abs(w), h: Math.abs(h) }
  }, [])

  // Déplace l'élément sélectionné au clavier (flèches). Pas fin = 1 pt, Maj = 10 pt.
  const nudgeSelected = useCallback((dx: number, dy: number) => {
    const ids = selectedIds
    if (!ids.length) return
    snapshot()
    const set = new Set(ids)
    setAnnotations(prev => prev.map(a => {
      if (!set.has(a.id)) return a
      const an = a as unknown as { x: number; y: number; points?: [number, number][] }
      if (an.points) return { ...a, points: an.points.map(p => [p[0] + dx, p[1] + dy] as [number, number]) } as Annotation
      return { ...a, x: an.x + dx, y: an.y + dy } as Annotation
    }))
    setDirty(true)
  }, [selectedIds, snapshot])

  // Dupliquer un élément (décalé) + ordre d'empilement (z) via l'ordre du tableau.
  const duplicateAnn = useCallback((aid: string) => {
    const src = annotationsRef.current.find(a => a.id === aid)
    if (!src) return
    snapshot()
    const copy = { ...clone([src])[0], id: uid() } as Annotation & { x: number; y: number }
    copy.x += 12; copy.y += 12
    setAnnotations(prev => [...prev, copy]); selectOnly(copy.id); setDirty(true)
  }, [snapshot])
  const reorderAnn = useCallback((aid: string, mode: 'front' | 'back' | 'forward' | 'backward') => {
    snapshot()
    setAnnotations(prev => {
      const i = prev.findIndex(a => a.id === aid)
      if (i < 0) return prev
      const arr = [...prev]; const [el] = arr.splice(i, 1)
      if (mode === 'front') arr.push(el)
      else if (mode === 'back') arr.unshift(el)
      else if (mode === 'forward') arr.splice(Math.min(arr.length, i + 1), 0, el)
      else arr.splice(Math.max(0, i - 1), 0, el)
      return arr
    })
    setDirty(true)
  }, [snapshot])

  // ── Presse-papiers interne (couper / copier / coller) ───────────────────────
  const copySelection = useCallback(() => {
    const set = new Set(selectedIds)
    const items = annotationsRef.current.filter(a => set.has(a.id))
    if (!items.length) return
    clipboardRef.current = clone(items)
    setClipCount(items.length)
  }, [selectedIds])
  const cutSelection = useCallback(() => {
    if (!selectedIds.length) return
    copySelection()
    deleteSelected()
  }, [selectedIds, copySelection, deleteSelected])
  const pasteClipboard = useCallback(() => {
    const items = clipboardRef.current
    if (!items.length) return
    snapshot()
    const copies = clone(items).map(a => {
      const c = { ...a, id: uid(), page: currentPage } as Annotation & { x: number; y: number; points?: [number, number][] }
      if (c.points) c.points = c.points.map(p => [p[0] + 16, p[1] + 16] as [number, number])
      c.x += 16; c.y += 16
      return c as Annotation
    })
    setAnnotations(prev => [...prev, ...copies])
    setSelectedIds(copies.map(c => c.id))
    setDirty(true)
  }, [snapshot, currentPage])

  // ── Alignement / distribution de la sélection multiple ─────────────────────
  type AlignKind = 'left' | 'center-h' | 'right' | 'top' | 'center-v' | 'bottom'
  const moveAnnBy = (a: Annotation, dx: number, dy: number): Annotation => {
    const an = a as unknown as { points?: [number, number][]; x: number; y: number }
    if (an.points) return { ...a, points: an.points.map(p => [p[0] + dx, p[1] + dy] as [number, number]), x: an.x + dx, y: an.y + dy } as Annotation
    return { ...a, x: an.x + dx, y: an.y + dy } as Annotation
  }
  const alignSelected = useCallback((kind: AlignKind) => {
    const set = new Set(selectedIds)
    const sel = annotationsRef.current.filter(a => set.has(a.id))
    if (sel.length < 2) return
    snapshot()
    const boxes = new Map(sel.map(a => [a.id, bboxOf(a)]))
    const xs = sel.map(a => boxes.get(a.id)!)
    const left   = Math.min(...xs.map(b => b.x)),        right  = Math.max(...xs.map(b => b.x + b.w))
    const top    = Math.min(...xs.map(b => b.y)),        bottom = Math.max(...xs.map(b => b.y + b.h))
    const midX   = (left + right) / 2,                   midY   = (top + bottom) / 2
    setAnnotations(prev => prev.map(a => {
      if (!set.has(a.id)) return a
      const b = boxes.get(a.id)!
      let dx = 0, dy = 0
      if (kind === 'left') dx = left - b.x
      else if (kind === 'right') dx = right - (b.x + b.w)
      else if (kind === 'center-h') dx = midX - (b.x + b.w / 2)
      else if (kind === 'top') dy = top - b.y
      else if (kind === 'bottom') dy = bottom - (b.y + b.h)
      else if (kind === 'center-v') dy = midY - (b.y + b.h / 2)
      return moveAnnBy(a, dx, dy)
    }))
    setDirty(true)
  }, [selectedIds, snapshot, bboxOf])
  const distributeSelected = useCallback((axis: 'h' | 'v') => {
    const set = new Set(selectedIds)
    const sel = annotationsRef.current.filter(a => set.has(a.id))
    if (sel.length < 3) return
    snapshot()
    const entries = sel.map(a => ({ a, b: bboxOf(a) }))
    entries.sort((p, q) => axis === 'h' ? (p.b.x + p.b.w / 2) - (q.b.x + q.b.w / 2) : (p.b.y + p.b.h / 2) - (q.b.y + q.b.h / 2))
    const first = entries[0], last = entries[entries.length - 1]
    const c0 = axis === 'h' ? first.b.x + first.b.w / 2 : first.b.y + first.b.h / 2
    const c1 = axis === 'h' ? last.b.x + last.b.w / 2 : last.b.y + last.b.h / 2
    const step = (c1 - c0) / (entries.length - 1)
    const targets = new Map(entries.map((e, i) => [e.a.id, c0 + step * i]))
    setAnnotations(prev => prev.map(a => {
      if (!targets.has(a.id)) return a
      const b = bboxOf(a)
      const cur = axis === 'h' ? b.x + b.w / 2 : b.y + b.h / 2
      const d = targets.get(a.id)! - cur
      return moveAnnBy(a, axis === 'h' ? d : 0, axis === 'h' ? 0 : d)
    }))
    setDirty(true)
  }, [selectedIds, snapshot, bboxOf])

  // ── Rotation : helpers ──────────────────────────────────────────────────────
  const rotationOf = (a: Annotation): number => ((a as { rotation?: number }).rotation ?? 0)
  // Ramène un point (points PDF) dans le repère NON pivoté d'un élément, pour
  // que le hit-test par boîte englobante reste valable sur un objet pivoté.
  const unrotatePoint = (a: Annotation, pt: { x: number; y: number }): { x: number; y: number } => {
    const rot = rotationOf(a)
    if (!rot) return pt
    const b = bboxOf(a)
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2
    const rad = (-rot * Math.PI) / 180
    const dx = pt.x - cx, dy = pt.y - cy
    return { x: cx + dx * Math.cos(rad) - dy * Math.sin(rad), y: cy + dx * Math.sin(rad) + dy * Math.cos(rad) }
  }
  const hitTestR = (a: Annotation, pt: { x: number; y: number }): boolean => hitTest(a, unrotatePoint(a, pt))

  // Test de présence d'un point (en points PDF) sur un élément (boîte englobante).
  const hitTest = (a: Annotation, pt: { x: number; y: number }): boolean => {
    const an = a as unknown as { x: number; y: number; width?: number; height?: number; points?: [number, number][]; type: string }
    if (an.type === 'sticky-note') return pt.x >= an.x && pt.x <= an.x + 20 && pt.y >= an.y && pt.y <= an.y + 20
    if (an.type === 'freehand' && an.points?.length) {
      const xs = an.points.map(p => p[0]), ys = an.points.map(p => p[1])
      return pt.x >= Math.min(...xs) - 4 && pt.x <= Math.max(...xs) + 4 && pt.y >= Math.min(...ys) - 4 && pt.y <= Math.max(...ys) + 4
    }
    const w = an.width ?? 0, h = an.height ?? 0
    const x0 = Math.min(an.x, an.x + w), x1 = Math.max(an.x, an.x + w)
    const y0 = Math.min(an.y, an.y + h), y1 = Math.max(an.y, an.y + h)
    return pt.x >= x0 - 2 && pt.x <= x1 + 2 && pt.y >= y0 - 2 && pt.y <= y1 + 2
  }

  const startResize = (e: React.MouseEvent, a: Annotation, handle: string) => {
    e.stopPropagation()
    const an = a as unknown as { x: number; y: number; width?: number; height?: number }
    const { x, y } = coordsFromEvent(e)
    elDragRef.current = { id: a.id, mode: 'resize', handle, startX: x, startY: y, orig: { x: an.x, y: an.y, width: an.width ?? 0, height: an.height ?? 0 } }
  }

  const handleSave = useCallback(() => {
    setSaving(true)
    saveMut.mutate()
  }, [saveMut])

  const coordsFromEvent = (e: React.MouseEvent): { x: number; y: number } => {
    const rect = canvasRef.current!.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  // Active le MODE ÉDITION du document entier : extrait la page courante tout de
  // suite et marque le document → les autres pages s'extraient paresseusement à
  // l'ouverture (cf. effet plus bas).
  const enableEditMode = useCallback(async () => {
    const page = pageRef.current
    if (!page || converting) return
    setConverting(true)
    try {
      const els = await extractPageElements(page, currentPage, fontsRef.current)
      setAnnotations(els)
      clearSel()
      await pdfWriterApi.savePage(id!, currentPage, { annotations: els })
      const cur = (docSettingsRef.current ?? {}) as Record<string, unknown>
      const set = new Set<number>(((cur.extractedPages as number[]) ?? []))
      set.add(currentPage)
      await pdfWriterApi.updateDocument(id!, { settings: { ...cur, extractedPages: [...set], editMode: true } })
      qc.invalidateQueries({ queryKey: ['pdf-doc', id] })
      setDirty(false)
    } finally { setConverting(false) }
  }, [converting, currentPage, id, qc])

  // Extraction paresseuse : en mode édition, dès qu'on ouvre une page non encore
  // extraite, on en extrait le contenu (texte + calque image) et on le persiste.
  useEffect(() => {
    if (!editMode || !pdfDoc || isExtracted) return
    const pnum = currentPage
    if (extractingRef.current.has(pnum)) return
    extractingRef.current.add(pnum)
    let cancelled = false
    setConverting(true)
    ;(async () => {
      const page = await pdfDoc.getPage(pnum)
      if (cancelled) return
      const els = await extractPageElements(page, pnum, fontsRef.current)
      if (cancelled) return
      setAnnotations(els); clearSel()
      await pdfWriterApi.savePage(id!, pnum, { annotations: els })
      const cur = (docSettingsRef.current ?? {}) as Record<string, unknown>
      const set = new Set<number>(((cur.extractedPages as number[]) ?? [])); set.add(pnum)
      await pdfWriterApi.updateDocument(id!, { settings: { ...cur, extractedPages: [...set], editMode: true } })
      qc.invalidateQueries({ queryKey: ['pdf-doc', id] })
    })().catch(() => {}).finally(() => { extractingRef.current.delete(pnum); if (!cancelled) setConverting(false) })
    return () => { cancelled = true }
  }, [editMode, pdfDoc, currentPage, isExtracted, id, qc])

  // Ajoute une image (téléversée) comme élément déplaçable/redimensionnable.
  const addImageFile = (file: File) => {
    const reader = new FileReader()
    reader.onload = () => {
      const src = reader.result as string
      const probe = new Image()
      probe.onload = () => {
        const ratio = probe.height / probe.width || 1
        const w = Math.min(pageW * 0.5, probe.width || 200)
        const h = w * ratio
        addAnnotation({
          id: uid(), type: 'image', page: currentPage,
          x: pageW / 2 - w / 2, y: pageH / 2 - h / 2, width: w, height: h,
          src, opacity: 1, createdAt: new Date().toISOString(),
        } as Annotation)
        setActiveTool('select')
      }
      probe.src = src
    }
    reader.readAsDataURL(file)
  }

  // ── Zoom / ajustement (façon Acrobat) ──────────────────────────────────────
  // Fixe l'échelle en gardant le point (cx,cy) écran stable sous le curseur.
  const zoomTo = useCallback((next: number, cx?: number, cy?: number) => {
    const sc = scrollRef.current
    const prev = scaleRef.current
    const ns = clampScale(+next.toFixed(3))
    if (ns === prev) return
    if (sc && cx != null && cy != null) {
      const rect = sc.getBoundingClientRect()
      const ox = cx - rect.left, oy = cy - rect.top
      const ratio = ns / prev
      const targetL = ratio * (sc.scrollLeft + ox) - ox
      const targetT = ratio * (sc.scrollTop + oy) - oy
      // Le canevas se redimensionne au commit React ; on applique le scroll après.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const s2 = scrollRef.current; if (!s2) return
        s2.scrollLeft = targetL; s2.scrollTop = targetT
      }))
    }
    setScale(ns)
  }, [])
  const zoomBy = useCallback((factor: number) => {
    const sc = scrollRef.current
    if (sc) { const r = sc.getBoundingClientRect(); zoomTo(scaleRef.current * factor, r.left + sc.clientWidth / 2, r.top + sc.clientHeight / 2) }
    else zoomTo(scaleRef.current * factor)
  }, [zoomTo])
  const fitToWidth = useCallback(() => {
    const sc = scrollRef.current; if (!sc) return
    setScale(clampScale((sc.clientWidth - VIEW_PAD) / pageW))
  }, [pageW])
  const fitToPage = useCallback(() => {
    const sc = scrollRef.current; if (!sc) return
    setScale(clampScale(Math.min((sc.clientWidth - VIEW_PAD) / pageW, (sc.clientHeight - VIEW_PAD) / pageH)))
  }, [pageW, pageH])

  // Zoom à la molette (Ctrl/⌘ enfoncé), centré sur le curseur. Listener natif
  // non-passif (React rend onWheel passif → preventDefault inopérant).
  useEffect(() => {
    const sc = scrollRef.current; if (!sc) return
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      const factor = Math.exp(-e.deltaY * 0.0015)
      zoomTo(scaleRef.current * factor, e.clientX, e.clientY)
    }
    sc.addEventListener('wheel', onWheel, { passive: false })
    return () => sc.removeEventListener('wheel', onWheel)
  }, [zoomTo])

  // ── Pan (outil Main / barre d'espace / clic du milieu) ──────────────────────
  const startPan = useCallback((clientX: number, clientY: number) => {
    const sc = scrollRef.current; if (!sc) return
    panRef.current = { x: clientX, y: clientY, sl: sc.scrollLeft, st: sc.scrollTop }
    setPanning(true)
  }, [])
  useEffect(() => {
    if (!panning) return
    const onMove = (e: MouseEvent) => {
      const p = panRef.current, sc = scrollRef.current
      if (!p || !sc) return
      sc.scrollLeft = p.sl - (e.clientX - p.x)
      sc.scrollTop  = p.st - (e.clientY - p.y)
    }
    const onUp = () => { panRef.current = null; setPanning(false) }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [panning])

  // Barre d'espace maintenue → pan temporaire (relâchée → on revient à l'outil).
  useEffect(() => {
    const tagEditable = () => { const t = (document.activeElement?.tagName || '').toLowerCase(); return t === 'input' || t === 'textarea' }
    const down = (e: KeyboardEvent) => { if (e.code === 'Space' && !tagEditable()) { e.preventDefault(); setSpaceDown(true) } }
    const up   = (e: KeyboardEvent) => { if (e.code === 'Space') setSpaceDown(false) }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up) }
  }, [])

  const totalPages = docData?.page_count ?? pdfDoc?.numPages ?? 1

  // Raccourcis clavier : annuler/rétablir, suppression, déplacement aux flèches,
  // zoom (Ctrl ±/0), tout sélectionner, échap.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea') return
      const k = e.key.toLowerCase()
      const mod = e.ctrlKey || e.metaKey
      if (mod && k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo() }
      else if (mod && k === 'y') { e.preventDefault(); redo() }
      else if (mod && k === 'a') { e.preventDefault(); setSelectedIds(annotationsRef.current.map(a => a.id)) }
      else if (mod && k === 'c') { e.preventDefault(); copySelection() }
      else if (mod && k === 'x') { e.preventDefault(); cutSelection() }
      else if (mod && k === 'v') { e.preventDefault(); pasteClipboard() }
      else if (mod && k === 'd') { e.preventDefault(); if (selectedIds.length === 1) duplicateAnn(selectedIds[0]) }
      else if (mod && (k === '+' || k === '=')) { e.preventDefault(); zoomBy(1.15) }
      else if (mod && k === '-') { e.preventDefault(); zoomBy(1 / 1.15) }
      else if (mod && k === '0') { e.preventDefault(); fitToPage() }
      else if (e.key === 'PageUp')   { e.preventDefault(); setCurrentPage(n => Math.max(1, n - 1)) }
      else if (e.key === 'PageDown') { e.preventDefault(); setCurrentPage(n => Math.min(totalPages, n + 1)) }
      else if (e.key === 'Escape') { setEditingTextId(null); setMarquee(null); marqueeStartRef.current = null; pendingSigRef.current = null; clearSel() }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.length) { e.preventDefault(); deleteSelected() }
      else if (e.key === 'ArrowUp')    { e.preventDefault(); nudgeSelected(0, e.shiftKey ? -10 : -1) }
      else if (e.key === 'ArrowDown')  { e.preventDefault(); nudgeSelected(0, e.shiftKey ?  10 :  1) }
      else if (e.key === 'ArrowLeft')  { e.preventDefault(); nudgeSelected(e.shiftKey ? -10 : -1, 0) }
      else if (e.key === 'ArrowRight') { e.preventDefault(); nudgeSelected(e.shiftKey ?  10 :  1, 0) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo, deleteSelected, selectedIds, nudgeSelected, zoomBy, fitToPage, clearSel, copySelection, cutSelection, pasteClipboard, duplicateAnn, totalPages])

  const pxToPoint = (px: number) => px / scale  // canvas px → PDF points

  // ── Export : aplatir toutes les annotations dans un vrai PDF ────────────────
  const [exporting, setExporting] = useState(false)
  // Construit le PDF final (source réordonnée/pivotée + annotations aplaties).
  const buildExportBlob = useCallback(async (): Promise<Blob> => {
    // Persist the current page first so its in-memory annotations are included.
    await pdfWriterApi.savePage(id!, currentPage, { annotations: annotationsRef.current })

    // Gather every page's size + annotations (annotations live per-page server-side).
    const pageList: ExportPage[] = (docData?.pages ?? []).map(p => ({
      page_number: p.page_number, width: p.width, height: p.height, rotation: p.rotation,
      sourceIndex: p.source_index,
    }))
    if (pageList.length === 0) pageList.push({ page_number: 1, width: pageW, height: pageH, rotation: dbRot, sourceIndex: srcIdx })

    const annotationsByPage = new Map<number, Annotation[]>()
    await Promise.all(pageList.map(async p => {
      if (p.page_number === currentPage) { annotationsByPage.set(p.page_number, annotationsRef.current); return }
      try {
        const r = await pdfWriterApi.getPage(id!, p.page_number)
        annotationsByPage.set(p.page_number, (r.data.annotations as Annotation[]) ?? [])
      } catch { annotationsByPage.set(p.page_number, []) }
    }))

    // Fetch the source PDF bytes (404 = blank document → pdf-lib builds fresh pages).
    let sourceBytes: ArrayBuffer | null = null
    try {
      const resp = await fetch(pdfWriterApi.sourceUrl(id!), { headers: { Authorization: `Bearer ${token}` } })
      if (resp.ok) sourceBytes = await resp.arrayBuffer()
    } catch { /* no source → blank */ }

    const bytes = await buildAnnotatedPdf({ sourceBytes, pages: pageList, annotationsByPage })
    return new Blob([bytes as BlobPart], { type: 'application/pdf' })
  }, [id, currentPage, docData?.pages, pageW, pageH, token, dbRot, srcIdx])

  const handleExport = useCallback(async () => {
    if (!id || exporting) return
    setExporting(true)
    try {
      const blob = await buildExportBlob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${(docData?.title || 'document').replace(/[/\\?%*:|"<>]/g, '-')}.pdf`
      document.body.appendChild(a); a.click(); a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 4000)
    } finally {
      setExporting(false)
    }
  }, [id, exporting, buildExportBlob, docData?.title])

  // ── Impression : PDF aplati → iframe cachée → boîte de dialogue du navigateur ─
  const printFrameRef = useRef<HTMLIFrameElement | null>(null)
  const handlePrint = useCallback(async () => {
    if (!id || printing) return
    setPrinting(true)
    try {
      const blob = await buildExportBlob()
      const url = URL.createObjectURL(blob)
      printFrameRef.current?.remove()
      const frame = document.createElement('iframe')
      frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;'
      frame.src = url
      frame.onload = () => {
        try { frame.contentWindow?.focus(); frame.contentWindow?.print() } catch { /* blocked */ }
        setTimeout(() => URL.revokeObjectURL(url), 60_000)
      }
      document.body.appendChild(frame)
      printFrameRef.current = frame
    } finally {
      setPrinting(false)
    }
  }, [id, printing, buildExportBlob])
  useEffect(() => () => { printFrameRef.current?.remove() }, [])

  // ── OCR : reconnaissance de texte (façon Acrobat « Reconnaître le texte ») ───
  // Rend la page source en image haute résolution, lance l'OCR WASM côté
  // navigateur, puis insère chaque mot reconnu comme texte ÉDITABLE (fond blanc
  // qui masque le glyphe scanné dessous) → le document devient éditable/cherchable.
  const ocrStatusLabel = useCallback((s: string): string => {
    if (s.includes('core')) return t('pdf_ocr_loading_core', { defaultValue: 'Chargement du moteur…' })
    if (s.includes('language') || s.includes('traineddata')) return t('pdf_ocr_loading_lang', { defaultValue: 'Chargement de la langue…' })
    if (s.includes('initializ')) return t('pdf_ocr_init', { defaultValue: 'Initialisation…' })
    if (s.includes('recogniz')) return t('pdf_ocr_recognizing', { defaultValue: 'Reconnaissance du texte…' })
    return t('pdf_ocr_working', { defaultValue: 'Traitement…' })
  }, [t])

  // Lance l'OCR : portée page courante ou document entier ; mode « texte
  // éditable » (fond blanc qui remplace visuellement le scan) ou « couche
  // invisible » (texte transparent superposé → document recherchable, aspect
  // intact — l'équivalent de « image + texte caché » d'Acrobat).
  const runOcr = useCallback(async (opts: { lang: OcrLang; scope: 'page' | 'doc'; mode: 'editable' | 'invisible' }) => {
    setOcrDialog(false)
    if (!pdfDoc || ocrRunning) return
    setOcrRunning(true); setOcrResultMsg(null); setOcrPct(0)
    setOcrStatus(t('pdf_ocr_preparing', { defaultValue: 'Préparation de la page…' }))
    try {
      const metas = (docData?.pages ?? []).filter(p => p.source_index != null && p.source_index < pdfDoc.numPages)
      const targets = opts.scope === 'doc'
        ? metas.map(p => ({ n: p.page_number, src: p.source_index as number, rot: p.rotation, w: p.width }))
        : hasSourcePage ? [{ n: currentPage, src: srcIdx as number, rot: dbRot, w: basePageW }] : []
      if (!targets.length) {
        setOcrResultMsg(t('pdf_ocr_no_source', { defaultValue: 'Aucune page numérisée à reconnaître.' }))
        return
      }
      let total = 0
      const nb = targets.length
      for (let i = 0; i < nb; i++) {
        const tgt = targets[i]
        const pagePrefix = nb > 1 ? `${t('pdf_page', { defaultValue: 'Page' })} ${i + 1}/${nb} — ` : ''
        const page = await pdfDoc.getPage(tgt.src + 1)
        // Cible ~2000 px de large pour une bonne précision sans exploser la mémoire.
        const ocrScale = Math.min(3, Math.max(1.6, 2000 / (tgt.w || 595)))
        // N'imposer une rotation au viewport QUE si elle diffère de celle de la
        // page (pdf.js v6 : un paramètre `rotation` explicite peut invalider le
        // canal de rendu déjà ouvert pour cette page).
        const rot = (((page.rotate + tgt.rot) % 360) + 360) % 360
        const vp = rot === page.rotate ? page.getViewport({ scale: ocrScale }) : page.getViewport({ scale: ocrScale, rotation: rot })
        const cv = document.createElement('canvas')
        cv.width = Math.round(vp.width); cv.height = Math.round(vp.height)
        const ctx = cv.getContext('2d')
        if (!ctx) throw new Error('canvas 2d indisponible')
        ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, cv.width, cv.height)
        // Hors-écran : `canvas: null` + intent 'print' → canal de rendu séparé.
        // (pdf.js v6 associe un canal par page/intent : réutiliser l'intent
        // 'display' ferait peindre le worker DANS le canvas principal.)
        await page.render({ canvas: null, canvasContext: ctx, viewport: vp, intent: 'print' }).promise
        const res = await recognizeImage(cv, opts.lang, (status, p) => {
          setOcrStatus(pagePrefix + ocrStatusLabel(status))
          setOcrPct(Math.round(((i + p) / nb) * 100))
        })
        const now = new Date().toISOString()
        // Un élément par LIGNE reconnue : édition naturelle et pages allégées.
        const newAnns: Annotation[] = res.lines
          .filter(l => l.confidence >= 30 && l.text.trim().length > 0)
          .map(l => {
            const x = l.x0 / ocrScale, y = l.y0 / ocrScale
            const width = Math.max(4, (l.x1 - l.x0) / ocrScale)
            const height = Math.max(6, (l.y1 - l.y0) / ocrScale)
            return {
              id: uid(), type: 'text', page: tgt.n,
              x, y, width: width + 4, height,
              content: l.text, fontSize: Math.max(5, +(height * 0.78).toFixed(1)),
              fontFamily: 'Helvetica', color: '#111111', bold: false, italic: false, align: 'left',
              ...(opts.mode === 'editable' ? { backgroundColor: '#ffffff' } : { invisible: true }),
              createdAt: now,
            } as Annotation
          })
        total += newAnns.length
        if (!newAnns.length) continue
        if (tgt.n === currentPage) {
          snapshot()
          setAnnotations(prev => [...prev, ...newAnns])
          setDirty(true)
        } else {
          // Autre page : fusionner avec ses annotations persistées puis sauver.
          try {
            const r = await pdfWriterApi.getPage(id!, tgt.n)
            const existing = (r.data.annotations as Annotation[]) ?? []
            await pdfWriterApi.savePage(id!, tgt.n, { annotations: [...existing, ...newAnns] })
          } catch { /* page inaccessible : ignorée */ }
        }
      }
      qc.invalidateQueries({ queryKey: ['pdf-page', id] })
      setOcrResultMsg(total
        ? t('pdf_ocr_done_lines', { defaultValue: '{{count}} ligne(s) de texte reconnue(s) et insérée(s).', count: total })
        : t('pdf_ocr_empty', { defaultValue: 'Aucun texte n’a été détecté.' }))
    } catch (err) {
      console.error('[OCR]', err)
      setOcrResultMsg(t('pdf_ocr_error', { defaultValue: 'La reconnaissance a échoué. Réessayez.' }))
    } finally {
      setOcrRunning(false)
    }
  }, [pdfDoc, currentPage, ocrRunning, snapshot, ocrStatusLabel, t, docData?.pages, hasSourcePage, srcIdx, dbRot, basePageW, id, qc])

  // Libère le worker OCR (et le cœur WASM) au démontage de l'éditeur.
  useEffect(() => () => { disposeOcr() }, [])

  // ── Interactions canvas ───────────────────────────────────────────────────

  const SNAP_PX = 6

  // Trace l'encre en cours, lissée par courbes quadratiques (milieux de segments),
  // sur le calque de dessin sur-échantillonné (DPR) → rendu net et fluide.
  const drawInk = () => {
    const dc = drawCanvasRef.current; if (!dc) return
    const ctx = dc.getContext('2d'); if (!ctx) return
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, dc.width, dc.height); ctx.restore()
    const pts = freehandRef.current
    if (pts.length < 2) return
    ctx.beginPath()
    ctx.moveTo(pts[0][0] * scale, pts[0][1] * scale)
    for (let i = 1; i < pts.length - 1; i++) {
      const cx = pts[i][0] * scale, cy = pts[i][1] * scale
      const mx = ((pts[i][0] + pts[i + 1][0]) / 2) * scale, my = ((pts[i][1] + pts[i + 1][1]) / 2) * scale
      ctx.quadraticCurveTo(cx, cy, mx, my)
    }
    const last = pts[pts.length - 1]
    ctx.lineTo(last[0] * scale, last[1] * scale)
    ctx.strokeStyle = selectedColor
    ctx.lineWidth = 2 * scale
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'
    ctx.stroke()
  }

  // Magnétisme : aligne la boîte déplacée (en points) sur les bords/centres des
  // autres éléments et de la page. Renvoie le décalage à appliquer + les repères.
  const computeSnap = (box: { x: number; y: number; w: number; h: number }, excl: Set<string>) => {
    const thr = SNAP_PX / scale
    const vT: number[] = [0, pageW / 2, pageW]
    const hT: number[] = [0, pageH / 2, pageH]
    annotationsRef.current.forEach(a => {
      if (excl.has(a.id)) return
      const b = bboxOf(a)
      vT.push(b.x, b.x + b.w / 2, b.x + b.w)
      hT.push(b.y, b.y + b.h / 2, b.y + b.h)
    })
    const boxV = [box.x, box.x + box.w / 2, box.x + box.w]
    const boxH = [box.y, box.y + box.h / 2, box.y + box.h]
    let dx = 0, dy = 0, gv: number | null = null, gh: number | null = null, bestX = thr + 1, bestY = thr + 1
    for (const t of vT) for (const v of boxV) { const d = t - v; if (Math.abs(d) < Math.abs(bestX)) { bestX = d; gv = t } }
    for (const t of hT) for (const v of boxH) { const d = t - v; if (Math.abs(d) < Math.abs(bestY)) { bestY = d; gh = t } }
    if (Math.abs(bestX) <= thr) dx = bestX; else gv = null
    if (Math.abs(bestY) <= thr) dy = bestY; else gh = null
    return { dx, dy, guides: { v: gv != null ? [gv] : [], h: gh != null ? [gh] : [] } }
  }

  const handleCanvasMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return  // clic gauche seul (le clic du milieu → pan via le conteneur)
    shiftRef.current = e.shiftKey
    const { x, y } = coordsFromEvent(e)

    // Signature en attente : le clic la pose, centrée sous le curseur.
    if (activeTool === 'signature' && pendingSigRef.current) {
      const sig = pendingSigRef.current
      pendingSigRef.current = null
      const w = Math.min(200, pageW * 0.4)
      const h = Math.max(20, w * (sig.ratio || 0.35))
      addAnnotation({
        id: uid(), type: 'signature', page: currentPage,
        x: pxToPoint(x) - w / 2, y: pxToPoint(y) - h / 2, width: w, height: h,
        signatureData: sig.data, color: sig.color,
        createdAt: new Date().toISOString(),
      } as Annotation)
      setActiveTool('select')
      return
    }

    // Outil sélection : saisir l'élément le plus haut sous le curseur (déplacement,
    // éventuellement groupé). Maj-clic = ajouter/retirer de la sélection. Clic dans
    // le vide = rectangle de sélection élastique.
    if (activeTool === 'select') {
      const pt = { x: pxToPoint(x), y: pxToPoint(y) }
      const hit = [...annotations].reverse().find(a => hitTestR(a, pt))
      if (hit) {
        if (e.shiftKey) { toggleSel(hit.id); return }
        // Conserver une sélection multiple si on saisit un élément déjà sélectionné.
        const ids = selectedIds.includes(hit.id) && selectedIds.length > 1 ? selectedIds : [hit.id]
        if (!(selectedIds.includes(hit.id) && selectedIds.length > 1)) selectOnly(hit.id)
        const a = hit as unknown as { x: number; y: number; width?: number; height?: number }
        dragOrigRef.current = new Map()
        ids.forEach(eid => {
          const el = annotationsRef.current.find(z => z.id === eid) as unknown as { x: number; y: number; points?: [number, number][] } | undefined
          if (el) dragOrigRef.current.set(eid, { x: el.x, y: el.y, points: el.points ? el.points.map(p => [...p] as [number, number]) : undefined })
        })
        elDragRef.current = { id: hit.id, mode: 'move', startX: x, startY: y, orig: { x: a.x, y: a.y, width: a.width ?? 0, height: a.height ?? 0 } }
      } else {
        if (!e.shiftKey) clearSel()
        marqueeStartRef.current = { x, y }
      }
      return
    }

    if (activeTool === 'freehand') {
      setDrawing(true)
      freehandRef.current = [[pxToPoint(x), pxToPoint(y)]]
      return
    }

    if (['rect', 'ellipse', 'line', 'arrow', 'highlight', 'underline', 'strikethrough'].includes(activeTool)) {
      setShapeStart({ x: pxToPoint(x), y: pxToPoint(y) })
      return
    }

    const ptX = pxToPoint(x)
    const ptY = pxToPoint(y)
    const newId = uid()

    if (activeTool === 'text') {
      const tid = uid()
      addAnnotation({
        id: tid, type: 'text', page: currentPage,
        x: ptX, y: ptY, width: 220, height: Math.max(40, fontSize * 1.6),
        content: t('pdf_default_text'), fontSize, fontFamily,
        color: selectedColor === '#ffff00' ? '#000000' : selectedColor,
        bold: false, italic: false, align: 'left',
        createdAt: new Date().toISOString(),
      })
      setActiveTool('select')
      // Ouvre directement l'édition en place (double-clic implicite, façon Acrobat).
      snapshot()
      setEditingTextId(tid)
      return
    }

    if (activeTool === 'sticky-note') {
      addAnnotation({
        id: newId, type: 'sticky-note', page: currentPage,
        x: ptX, y: ptY,
        content: '', color: '#ffff88', isOpen: true,
        createdAt: new Date().toISOString(),
      })
      setActiveTool('select')
      return
    }

    if (activeTool === 'stamp') {
      addAnnotation({
        id: newId, type: 'stamp', page: currentPage,
        x: ptX - 80, y: ptY - 20,
        stampType: activeStamp as never,
        ...(activeStamp === 'custom' ? { customLabel: customStampText || 'STAMP', color: customStampColor } : {}),
        width: 160, height: 40, opacity: 1,
        createdAt: new Date().toISOString(),
      } as Annotation)
      setActiveTool('select')
      return
    }

    if (activeTool === 'form-text') {
      addAnnotation({
        id: newId, type: 'form-text', page: currentPage,
        x: ptX, y: ptY, width: 180, height: 28,
        fieldName: `field_${Date.now()}`, value: '',
        required: false, label: t('pdf_form_text_label'),
        createdAt: new Date().toISOString(),
      })
      setActiveTool('select')
      return
    }

    if (activeTool === 'form-checkbox') {
      addAnnotation({
        id: newId, type: 'form-checkbox', page: currentPage,
        x: ptX, y: ptY, width: 16, height: 16,
        fieldName: `check_${Date.now()}`, value: false,
        required: false,
        createdAt: new Date().toISOString(),
      })
      setActiveTool('select')
      return
    }
  }

  const handleCanvasMouseMove = (e: React.MouseEvent) => {
    const { x, y } = coordsFromEvent(e)
    const ptX = pxToPoint(x), ptY = pxToPoint(y)

    // Déplacement (éventuellement groupé) / redimensionnement / rotation en cours.
    if (elDragRef.current) {
      if (!dragSnappedRef.current) { snapshot(); dragSnappedRef.current = true } // historique
      const { mode, handle, startX, startY, orig } = elDragRef.current
      let dx = pxToPoint(x - startX), dy = pxToPoint(y - startY)
      if (mode === 'rotate') {
        const d = elDragRef.current
        const c = d.center!
        const ang = Math.atan2(ptY - c.y, ptX - c.x)
        let deg = (d.origRot ?? 0) + ((ang - (d.startAngle ?? 0)) * 180) / Math.PI
        // Maj = crans de 15° ; petit aimant autour de 0/90/180/270.
        if (shiftRef.current) deg = Math.round(deg / 15) * 15
        deg = ((deg % 360) + 360) % 360
        for (const snap of [0, 90, 180, 270, 360]) if (Math.abs(deg - snap) < 3) deg = snap % 360
        updateAnn(d.id, { rotation: deg === 0 ? undefined : Math.round(deg * 10) / 10 })
        elDragRef.current.moved = true
        return
      }
      if (mode === 'resize') {
        // Un objet pivoté se redimensionne dans SON repère : on projette le delta
        // curseur sur les axes locaux de l'élément.
        const el = annotationsRef.current.find(a => a.id === elDragRef.current!.id)
        const rot = el ? rotationOf(el) : 0
        if (rot) {
          const rad = (-rot * Math.PI) / 180
          const ldx = dx * Math.cos(rad) - dy * Math.sin(rad)
          const ldy = dx * Math.sin(rad) + dy * Math.cos(rad)
          dx = ldx; dy = ldy
        }
      }
      if (mode === 'move') {
        // Maj = contraindre au seul axe dominant (déplacement droit).
        if (shiftRef.current) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0 }
        // Magnétisme sur la boîte de l'élément primaire (sauf si Maj).
        let gv: number[] = [], gh: number[] = []
        if (!shiftRef.current) {
          const base = bboxOf(annotationsRef.current.find(a => a.id === elDragRef.current!.id)!)
          // base reflète la position COURANTE ; on repart de l'origine du primaire.
          const o = dragOrigRef.current.get(elDragRef.current!.id)
          const ox = o?.x ?? base.x, oy = o?.y ?? base.y
          const snap = computeSnap({ x: ox + dx, y: oy + dy, w: base.w, h: base.h }, new Set(dragOrigRef.current.keys()))
          dx += snap.dx; dy += snap.dy; gv = snap.guides.v; gh = snap.guides.h
        }
        setGuides({ v: gv, h: gh })
        const fdx = dx, fdy = dy
        setAnnotations(prev => prev.map(a => {
          const o = dragOrigRef.current.get(a.id)
          if (!o) return a
          if (o.points) return { ...a, points: o.points.map(p => [p[0] + fdx, p[1] + fdy] as [number, number]) } as Annotation
          return { ...a, x: o.x + fdx, y: o.y + fdy } as Annotation
        }))
        setDirty(true)
      } else {
        const h = handle ?? ''
        let nx = orig.x, ny = orig.y, nw = orig.width, nh = orig.height
        if (h.includes('e')) nw = Math.max(8, orig.width + dx)
        if (h.includes('s')) nh = Math.max(8, orig.height + dy)
        if (h.includes('w')) { nx = orig.x + dx; nw = Math.max(8, orig.width - dx) }
        if (h.includes('n')) { ny = orig.y + dy; nh = Math.max(8, orig.height - dy) }
        // Maj sur une poignée d'angle = conserver le ratio d'origine.
        if (shiftRef.current && h.length === 2 && orig.width > 0 && orig.height > 0) {
          const ar = orig.width / orig.height
          if (nw / nh > ar) nw = nh * ar; else nh = nw / ar
          if (h.includes('w')) nx = orig.x + (orig.width - nw)
          if (h.includes('n')) ny = orig.y + (orig.height - nh)
        }
        updateAnn(elDragRef.current.id, { x: nx, y: ny, width: nw, height: nh })
      }
      elDragRef.current.moved = true
      return
    }

    // Rectangle de sélection élastique.
    if (marqueeStartRef.current) {
      const s = marqueeStartRef.current
      setMarquee({ x: Math.min(s.x, x), y: Math.min(s.y, y), w: Math.abs(x - s.x), h: Math.abs(y - s.y) })
      return
    }

    if (drawing && activeTool === 'freehand') {
      freehandRef.current.push([ptX, ptY])
      drawInk()
      return
    }

    if (shapeStart && ['rect', 'ellipse', 'line', 'arrow', 'highlight', 'underline', 'strikethrough'].includes(activeTool)) {
      if (activeTool === 'line' || activeTool === 'arrow') {
        let ex = ptX, ey = ptY
        if (shiftRef.current) {
          // Aimanter l'angle au multiple de 45°.
          const ang = Math.atan2(ey - shapeStart.y, ex - shapeStart.x)
          const snapped = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4)
          const len = Math.hypot(ex - shapeStart.x, ey - shapeStart.y)
          ex = shapeStart.x + Math.cos(snapped) * len
          ey = shapeStart.y + Math.sin(snapped) * len
        }
        setShapeDraft({ x: shapeStart.x, y: shapeStart.y, w: ex - shapeStart.x, h: ey - shapeStart.y })
      } else {
        let w = ptX - shapeStart.x, h = ptY - shapeStart.y
        // Maj = carré / cercle parfait pour rect & ellipse.
        if (shiftRef.current && (activeTool === 'rect' || activeTool === 'ellipse')) {
          const s = Math.max(Math.abs(w), Math.abs(h))
          w = Math.sign(w || 1) * s; h = Math.sign(h || 1) * s
        }
        setShapeDraft({ x: Math.min(shapeStart.x, shapeStart.x + w), y: Math.min(shapeStart.y, shapeStart.y + h), w: Math.abs(w), h: Math.abs(h) })
      }
    }
  }

  const handleCanvasMouseUp = (e: React.MouseEvent) => {
    if (elDragRef.current) {
      // Drag sans mouvement = simple clic : aucun snapshot n'a été pris (il n'est
      // capturé qu'au premier mousemove), donc rien à nettoyer ici.
      elDragRef.current = null; dragSnappedRef.current = false; dragOrigRef.current = new Map()
      setGuides({ v: [], h: [] })
      return
    }

    // Fin du rectangle élastique → sélectionner les éléments intersectés.
    // (On recalcule la boîte depuis le point de départ + la position de relâchement
    //  plutôt que de lire l'état `marquee`, qui peut être périmé sans re-render.)
    if (marqueeStartRef.current) {
      const s = marqueeStartRef.current
      const up = coordsFromEvent(e)
      const m = { x: Math.min(s.x, up.x), y: Math.min(s.y, up.y), w: Math.abs(up.x - s.x), h: Math.abs(up.y - s.y) }
      marqueeStartRef.current = null
      setMarquee(null)
      if (m.w > 3 || m.h > 3) {
        const r = { x: pxToPoint(m.x), y: pxToPoint(m.y), w: pxToPoint(m.w), h: pxToPoint(m.h) }
        const ids = annotationsRef.current.filter(a => {
          const b = bboxOf(a)
          return b.x < r.x + r.w && b.x + b.w > r.x && b.y < r.y + r.h && b.y + b.h > r.y
        }).map(a => a.id)
        setSelectedIds(prev => e.shiftKey ? [...new Set([...prev, ...ids])] : ids)
      }
      return
    }

    const { x, y } = coordsFromEvent(e)
    const ptX = pxToPoint(x), ptY = pxToPoint(y)
    const newId = uid()

    if (drawing && activeTool === 'freehand') {
      setDrawing(false)
      const pts = [...freehandRef.current, [ptX, ptY]] as [number, number][]
      if (pts.length > 2) {
        addAnnotation({
          id: newId, type: 'freehand', page: currentPage,
          x: 0, y: 0,
          points: pts,
          color: selectedColor, strokeWidth: 2, opacity: 1,
          createdAt: new Date().toISOString(),
        })
      }
      freehandRef.current = []
      // Effacer le canvas de tracé (l'encre devient une annotation SVG).
      const dc = drawCanvasRef.current
      if (dc) { const c = dc.getContext('2d'); if (c) { c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, dc.width, dc.height); c.restore() } }
      return
    }

    if (shapeStart && shapeDraft && (Math.abs(shapeDraft.w) > 3 || Math.abs(shapeDraft.h) > 3)) {
      const { x: sx, y: sy, w, h } = shapeDraft

      if (['highlight', 'underline', 'strikethrough'].includes(activeTool)) {
        addAnnotation({
          id: newId, type: activeTool as 'highlight' | 'underline' | 'strikethrough',
          page: currentPage, x: sx, y: sy, width: w, height: h,
          color: selectedColor, opacity: 0.4,
          createdAt: new Date().toISOString(),
        })
      } else {
        addAnnotation({
          id: newId, type: activeTool as 'rect' | 'ellipse' | 'line' | 'arrow',
          page: currentPage, x: sx, y: sy, width: w, height: h,
          strokeColor: selectedColor, strokeWidth: 2,
          fillColor: undefined, fillOpacity: 0.1, opacity: 1,
          createdAt: new Date().toISOString(),
        })
      }
      setActiveTool('select')
    }

    setShapeStart(null)
    setShapeDraft(null)
  }

  // ── Rendu SVG des annotations ─────────────────────────────────────────────

  const selectedSet = new Set(selectedIds)
  // Chaque annotation pivotée est enveloppée dans un <g rotate> autour du centre
  // de sa boîte englobante (le corps est rendu dans le repère non pivoté).
  const renderAnnotations = () => annotations.map(ann => {
    const body = renderAnnBody(ann)
    if (!body) return null
    const rot = rotationOf(ann)
    if (!rot) return body
    const b = bboxOf(ann)
    return (
      <g key={`rot-${ann.id}`} transform={`rotate(${rot} ${(b.x + b.w / 2) * scale} ${(b.y + b.h / 2) * scale})`}>
        {body}
      </g>
    )
  })

  const renderAnnBody = (ann: Annotation) => {
    const isSelected = selectedSet.has(ann.id)
    const sel = isSelected ? 'drop-shadow(0 0 3px #1a73e8)' : undefined

    // Le mousedown de l'overlay gère déjà sélection + déplacement ; on garde le clic
    // ici uniquement pour le Maj-clic d'ajout/retrait sans déplacement.
    const onSelect = (e: React.MouseEvent) => {
      if (activeTool === 'select' && e.shiftKey) { e.stopPropagation(); toggleSel(ann.id) }
    }

    const px = (n: number) => n * scale

    switch (ann.type) {
      case 'highlight':
      case 'underline':
      case 'strikethrough': {
        const a = ann as import('./api').MarkupAnnotation
        return (
          <rect
            key={ann.id}
            x={px(a.x)} y={px(a.y)} width={px(a.width)} height={px(a.height)}
            fill={a.type === 'highlight' ? a.color : 'none'}
            fillOpacity={a.type === 'highlight' ? a.opacity : 0}
            stroke={a.type !== 'highlight' ? a.color : 'none'}
            strokeWidth={a.type === 'underline' ? 1.5 : a.type === 'strikethrough' ? 1.5 : 0}
            style={{ filter: sel, cursor: 'pointer' }}
            onClick={onSelect}
          />
        )
      }

      case 'text': {
        const a = ann as import('./api').TextAnnotation
        if (a.invisible) {
          // Couche OCR invisible : sélectionnable (cadre en pointillés au survol de
          // la sélection) mais transparente — le scan reste visible dessous.
          return (
            <rect
              key={ann.id}
              x={px(a.x)} y={px(a.y)} width={px(a.width)} height={px(a.height)}
              fill="transparent"
              stroke={isSelected ? '#1a73e8' : 'none'} strokeWidth={1} strokeDasharray="3,2"
              style={{ cursor: 'pointer' }}
              onClick={onSelect}
            />
          )
        }
        return (
          <g key={ann.id} style={{ cursor: 'pointer' }} onClick={onSelect}>
            {/* Le cadre de sélection + poignées est rendu par renderResizeHandles (évite le doublon).
                Pas de filtre drop-shadow ici → pas de halo bleu derrière le texte. */}
            {a.scaleX != null ? (
              // Texte EXTRAIT : rendu en SVG <text> (bien plus léger que foreignObject —
              // crucial sur les pages denses) ; étiré horizontalement via une matrice
              // pour coller à la largeur d'origine, ancré à gauche sur px(a.x).
              <text
                x={px(a.x)} y={px(a.y + a.fontSize)}
                fontSize={a.fontSize * scale}
                fontFamily={a.fontFamily}
                fill={a.color}
                fontWeight={a.bold ? 'bold' : 'normal'}
                fontStyle={a.italic ? 'italic' : 'normal'}
                transform={a.scaleX !== 1 ? `matrix(${a.scaleX},0,0,1,${px(a.x) * (1 - a.scaleX)},0)` : undefined}
                style={{ whiteSpace: 'pre', cursor: activeTool === 'select' ? 'move' : 'pointer' }}
              >
                {a.content}
              </text>
            ) : (
              <foreignObject x={px(a.x)} y={px(a.y)} width={px(a.width)} height={px(a.height)}>
                <div
                  style={{
                    fontSize:   a.fontSize * scale,
                    fontFamily: a.fontFamily,
                    color:      a.color,
                    fontWeight: a.bold ? 'bold' : 'normal',
                    fontStyle:  a.italic ? 'italic' : 'normal',
                    textDecoration: a.underline ? 'underline' : undefined,
                    textAlign:  a.align,
                    lineHeight: 1.2,
                    width:      '100%',
                    height:     '100%',
                    overflow:   'hidden',
                    background: a.backgroundColor || 'transparent',
                    border:     a.borderColor ? `1px solid ${a.borderColor}` : 'none',
                    padding:    '2px',
                    whiteSpace: 'pre-wrap',
                    wordBreak:  'break-word',
                  }}
                >
                  {a.content}
                </div>
              </foreignObject>
            )}
          </g>
        )
      }

      case 'sticky-note': {
        const a = ann as import('./api').StickyNoteAnnotation
        return (
          <g key={ann.id} style={{ filter: sel, cursor: 'pointer' }} onClick={onSelect}>
            <rect
              x={px(a.x)} y={px(a.y)} width={20} height={20}
              fill={a.color} rx={2}
              stroke={isSelected ? '#1a73e8' : 'rgba(0,0,0,0.2)'} strokeWidth={1}
            />
            {a.isOpen && (
              <foreignObject x={px(a.x) + 22} y={px(a.y)} width={180} height={100}>
                <div style={{
                  background: a.color, border: '1px solid rgba(0,0,0,0.2)',
                  borderRadius: 4, padding: 6, fontSize: 11,
                  whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  boxShadow: '2px 2px 6px rgba(0,0,0,0.15)',
                }}>
                  {a.content || t('pdf_empty_note')}
                </div>
              </foreignObject>
            )}
          </g>
        )
      }

      case 'freehand': {
        const a = ann as import('./api').FreehandAnnotation
        if (a.points.length < 2) return null
        const d = a.points.map((p, i) =>
          `${i === 0 ? 'M' : 'L'}${px(p[0])},${px(p[1])}`
        ).join(' ')
        return (
          <path
            key={ann.id}
            d={d}
            fill="none"
            stroke={a.color}
            strokeWidth={a.strokeWidth * scale}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={a.opacity}
            style={{ filter: sel, cursor: 'pointer' }}
            onClick={onSelect}
          />
        )
      }

      case 'rect':
      case 'ellipse': {
        const a = ann as import('./api').ShapeAnnotation
        const dash = a.lineStyle === 'dashed' ? `${Math.max(4, a.strokeWidth * 3) * scale},${Math.max(3, a.strokeWidth * 2) * scale}`
          : a.lineStyle === 'dotted' ? `${Math.max(0.8, a.strokeWidth * 0.8) * scale},${Math.max(2.5, a.strokeWidth * 2) * scale}` : undefined
        if (a.type === 'rect') {
          return (
            <rect
              key={ann.id}
              x={px(a.x)} y={px(a.y)} width={px(a.width)} height={px(a.height)}
              fill={a.fillColor || 'none'} fillOpacity={a.fillOpacity || 0}
              stroke={a.strokeColor} strokeWidth={a.strokeWidth * scale}
              strokeDasharray={dash} strokeLinecap="round"
              opacity={a.opacity}
              style={{ filter: sel, cursor: 'pointer' }}
              onClick={onSelect}
            />
          )
        }
        return (
          <ellipse
            key={ann.id}
            cx={px(a.x + a.width / 2)} cy={px(a.y + a.height / 2)}
            rx={px(a.width / 2)} ry={px(a.height / 2)}
            fill={a.fillColor || 'none'} fillOpacity={a.fillOpacity || 0}
            stroke={a.strokeColor} strokeWidth={a.strokeWidth * scale}
            strokeDasharray={dash} strokeLinecap="round"
            opacity={a.opacity}
            style={{ filter: sel, cursor: 'pointer' }}
            onClick={onSelect}
          />
        )
      }

      case 'line':
      case 'arrow': {
        const a = ann as import('./api').ShapeAnnotation
        const x1 = px(a.x), y1 = px(a.y)
        const x2 = px(a.x + a.width), y2 = px(a.y + a.height)
        const dash = a.lineStyle === 'dashed' ? `${Math.max(4, a.strokeWidth * 3) * scale},${Math.max(3, a.strokeWidth * 2) * scale}`
          : a.lineStyle === 'dotted' ? `${Math.max(0.8, a.strokeWidth * 0.8) * scale},${Math.max(2.5, a.strokeWidth * 2) * scale}` : undefined
        return (
          <g key={ann.id} style={{ filter: sel, cursor: 'pointer' }} onClick={onSelect}>
            {a.type === 'arrow' && (
              <defs>
                <marker id={`arrow-${ann.id}`} markerWidth={10} markerHeight={7} refX={9} refY={3.5} orient="auto" markerUnits="strokeWidth">
                  <polygon points="0 0, 10 3.5, 0 7" fill={a.strokeColor} />
                </marker>
              </defs>
            )}
            {/* Zone de saisie élargie invisible (les lignes fines sont dures à attraper). */}
            <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="transparent" strokeWidth={Math.max(10, a.strokeWidth * scale + 8)} />
            <line
              x1={x1} y1={y1} x2={x2} y2={y2}
              stroke={a.strokeColor} strokeWidth={a.strokeWidth * scale}
              strokeDasharray={dash} strokeLinecap="round"
              opacity={a.opacity}
              markerEnd={a.type === 'arrow' ? `url(#arrow-${ann.id})` : undefined}
            />
          </g>
        )
      }

      case 'stamp': {
        const a = ann as import('./api').StampAnnotation
        const isCustom = a.stampType === 'custom'
        const s = isCustom
          ? { color: a.color || '#d93025', label: (a.customLabel || 'STAMP').toUpperCase() }
          : (() => { const st = STAMP_TYPES.find(x => x.key === a.stampType); return st ? { color: st.color, label: t(st.labelKey) } : null })()
        if (!s) return null
        const fs = Math.min(20, Math.max(8, a.height * 0.42)) * scale
        return (
          <g key={ann.id} style={{ filter: sel, cursor: 'pointer', opacity: a.opacity }} onClick={onSelect}>
            <rect
              x={px(a.x)} y={px(a.y)} width={px(a.width)} height={px(a.height)}
              fill="none" stroke={s.color} strokeWidth={2.5 * scale} rx={3 * scale}
            />
            <text
              x={px(a.x + a.width / 2)} y={px(a.y + a.height / 2)}
              textAnchor="middle" dominantBaseline="central" fill={s.color}
              fontSize={fs} fontWeight="bold" fontFamily="Helvetica, Arial, sans-serif"
              letterSpacing="1"
            >
              {s.label}
            </text>
          </g>
        )
      }

      case 'signature': {
        const a = ann as import('./api').SignatureAnnotation
        if (!a.signatureData) return null
        const isDataUri = a.signatureData.startsWith('data:')
        if (isDataUri) {
          return (
            <image
              key={ann.id}
              href={a.signatureData}
              x={px(a.x)} y={px(a.y)} width={px(a.width)} height={px(a.height)}
              preserveAspectRatio="xMidYMid meet"
              style={{ filter: sel, cursor: 'pointer' }}
              onClick={onSelect}
            />
          )
        }
        // SVG path (coordonnées du pad de signature) : mis à l'échelle pour tenir
        // dans la boîte posée, centré, ratio conservé — cohérent avec l'export.
        const b = svgPathBounds(a.signatureData)
        const s = b ? Math.min(px(a.width) / b.w, px(a.height) / b.h) : 1
        const tx = b ? px(a.x) - b.x * s + (px(a.width) - b.w * s) / 2 : px(a.x)
        const ty = b ? px(a.y) - b.y * s + (px(a.height) - b.h * s) / 2 : px(a.y)
        return (
          <g
            key={ann.id}
            transform={`translate(${tx}, ${ty}) scale(${s})`}
            style={{ filter: sel, cursor: 'pointer' }}
            onClick={onSelect}
          >
            <path d={a.signatureData} fill="none" stroke={a.color || '#1a1a1a'}
              strokeWidth={s > 0 ? (1.5 * scale) / s : 1.5} strokeLinecap="round" strokeLinejoin="round" />
            {/* Zone cliquable pleine boîte (le path seul est difficile à attraper). */}
            <rect x={b ? b.x : 0} y={b ? b.y : 0} width={b ? b.w : 10} height={b ? b.h : 10} fill="transparent" stroke="none" />
          </g>
        )
      }

      case 'form-text': {
        const a = ann as import('./api').FormFieldAnnotation
        return (
          <g key={ann.id} style={{ filter: sel, cursor: 'pointer' }} onClick={onSelect}>
            <rect
              x={px(a.x)} y={px(a.y)} width={px(a.width)} height={px(a.height)}
              fill="white" stroke={isSelected ? '#1a73e8' : '#aaa'} strokeWidth={1} rx={2}
            />
            {a.label && (
              <text x={px(a.x) + 4} y={px(a.y) - 4} fontSize={9} fill="#666">
                {a.label}
              </text>
            )}
            {String(a.value) && (
              <text x={px(a.x) + 4} y={px(a.y) + px(a.height) / 2 + 4} fontSize={12} fill="#333">
                {String(a.value)}
              </text>
            )}
          </g>
        )
      }

      case 'form-checkbox': {
        const a = ann as import('./api').FormFieldAnnotation
        return (
          <g key={ann.id} style={{ filter: sel, cursor: 'pointer' }} onClick={onSelect}>
            <rect
              x={px(a.x)} y={px(a.y)} width={px(a.width)} height={px(a.height)}
              fill="white" stroke={isSelected ? '#1a73e8' : '#aaa'} strokeWidth={1} rx={2}
            />
            {a.value === true && (
              <path
                d={`M${px(a.x) + 3},${px(a.y) + px(a.height) / 2}
                   L${px(a.x) + px(a.width) / 2 - 1},${px(a.y) + px(a.height) - 3}
                   L${px(a.x) + px(a.width) - 2},${px(a.y) + 3}`}
                fill="none" stroke="#1a73e8" strokeWidth={2}
              />
            )}
          </g>
        )
      }

      case 'image': {
        const a = ann as import('./api').ImageAnnotation
        return (
          <image
            key={ann.id}
            href={a.src}
            x={px(a.x)} y={px(a.y)} width={px(a.width)} height={px(a.height)}
            preserveAspectRatio="none"
            opacity={a.opacity ?? 1}
            style={{ cursor: activeTool === 'select' ? 'move' : 'pointer' }}
            onClick={onSelect}
          />
        )
      }

      default:
        return null
    }
  }

  // ── Poignées de redimensionnement / cadres de sélection ─────────────────────
  const renderResizeHandles = () => {
    if (activeTool !== 'select' || !selectedIds.length) return null
    const px = (n: number) => n * scale
    // Sélection multiple : cadre léger autour de chaque élément (pas de poignées).
    if (selectedIds.length > 1) {
      return (
        <g pointerEvents="none">
          {selectedIds.map(idSel => {
            const el = annotations.find(z => z.id === idSel); if (!el) return null
            const b = bboxOf(el)
            return <rect key={idSel} x={px(b.x) - 1} y={px(b.y) - 1} width={px(b.w) + 2} height={px(b.h) + 2}
              fill="#1a73e814" stroke="#1a73e8" strokeWidth={1} strokeDasharray="3,2" />
          })}
        </g>
      )
    }
    const a = annotations.find(x => x.id === selectedId) as unknown as { x: number; y: number; width?: number; height?: number } | undefined
    if (!a || a.width == null || a.height == null) return null
    const S = 8
    const ann = annotations.find(x => x.id === selectedId)!
    const rot = rotationOf(ann)
    const cx = a.x + a.width / 2, cy = a.y + a.height / 2
    const pts: Array<[string, number, number]> = [
      ['nw', a.x, a.y], ['n', a.x + a.width / 2, a.y], ['ne', a.x + a.width, a.y],
      ['e', a.x + a.width, a.y + a.height / 2], ['se', a.x + a.width, a.y + a.height],
      ['s', a.x + a.width / 2, a.y + a.height], ['sw', a.x, a.y + a.height], ['w', a.x, a.y + a.height / 2],
    ]
    // Poignée de rotation : au-dessus du bord supérieur, reliée par un petit trait.
    const rotY = a.y - 22 / scale
    const startRotate = (e: React.MouseEvent) => {
      e.stopPropagation()
      const { x: mx, y: my } = coordsFromEvent(e)
      const c = { x: cx, y: cy }
      elDragRef.current = {
        id: ann.id, mode: 'rotate', startX: mx, startY: my,
        orig: { x: a.x, y: a.y, width: a.width!, height: a.height! },
        origRot: rot, center: c,
        startAngle: Math.atan2(pxToPoint(my) - c.y, pxToPoint(mx) - c.x),
      }
    }
    return (
      <g transform={rot ? `rotate(${rot} ${px(cx)} ${px(cy)})` : undefined}>
        <rect x={px(a.x)} y={px(a.y)} width={px(a.width)} height={px(a.height)}
          fill="none" stroke="#1a73e8" strokeWidth={1} strokeDasharray="4,2" pointerEvents="none" />
        <line x1={px(cx)} y1={px(a.y)} x2={px(cx)} y2={px(rotY)} stroke="#1a73e8" strokeWidth={1} pointerEvents="none" />
        <circle cx={px(cx)} cy={px(rotY)} r={5.5}
          fill="#fff" stroke="#1a73e8" strokeWidth={1.5}
          style={{ cursor: 'grab' }}
          onMouseDown={startRotate}>
          <title>{t('pdf_rotate_handle', { defaultValue: 'Pivoter (Maj = par 15°)' })}</title>
        </circle>
        {pts.map(([h, hx, hy]) => (
          <rect key={h} x={px(hx) - S / 2} y={px(hy) - S / 2} width={S} height={S}
            fill="#fff" stroke="#1a73e8" strokeWidth={1.5}
            style={{ cursor: `${h}-resize` }}
            onMouseDown={(e) => startResize(e, ann, h)} />
        ))}
      </g>
    )
  }

  // ── Draft pendant le tracé de forme ──────────────────────────────────────
  const renderShapeDraft = () => {
    if (!shapeDraft) return null
    const { x, y, w, h } = shapeDraft
    const px = (n: number) => n * scale
    if (['highlight', 'underline', 'strikethrough'].includes(activeTool)) {
      return (
        <rect
          x={px(x)} y={px(y)} width={px(w)} height={px(h)}
          fill={selectedColor} fillOpacity={0.3}
          stroke={selectedColor} strokeWidth={1} strokeDasharray="3,2"
          pointerEvents="none"
        />
      )
    }
    if (activeTool === 'rect') {
      return (
        <rect
          x={px(x)} y={px(y)} width={px(w)} height={px(h)}
          fill="none" stroke={selectedColor} strokeWidth={2} strokeDasharray="4,2"
          pointerEvents="none"
        />
      )
    }
    if (activeTool === 'ellipse') {
      return (
        <ellipse
          cx={px(x + w / 2)} cy={px(y + h / 2)}
          rx={px(w / 2)} ry={px(h / 2)}
          fill="none" stroke={selectedColor} strokeWidth={2} strokeDasharray="4,2"
          pointerEvents="none"
        />
      )
    }
    if (activeTool === 'line' || activeTool === 'arrow') {
      return (
        <line
          x1={px(x)} y1={px(y)} x2={px(x + w)} y2={px(y + h)}
          stroke={selectedColor} strokeWidth={2} strokeDasharray="4,2"
          pointerEvents="none"
        />
      )
    }
    return null
  }

  // ── Repères d'alignement magnétiques (pendant un déplacement) ──────────────
  const renderGuides = () => {
    if (!guides.v.length && !guides.h.length) return null
    const px = (n: number) => n * scale
    return (
      <g pointerEvents="none">
        {guides.v.map((gx, i) => <line key={`v${i}`} x1={px(gx)} y1={0} x2={px(gx)} y2={px(pageH)} stroke="#e0457b" strokeWidth={1} strokeDasharray="4,3" />)}
        {guides.h.map((gy, i) => <line key={`h${i}`} x1={0} y1={px(gy)} x2={px(pageW)} y2={px(gy)} stroke="#e0457b" strokeWidth={1} strokeDasharray="4,3" />)}
      </g>
    )
  }

  // ── Rectangle de sélection élastique ───────────────────────────────────────
  const renderMarquee = () => {
    if (!marquee) return null
    return <rect x={marquee.x} y={marquee.y} width={marquee.w} height={marquee.h}
      fill="#1a73e81f" stroke="#1a73e8" strokeWidth={1} strokeDasharray="4,2" pointerEvents="none" />
  }

  // ── Outil cursor ──────────────────────────────────────────────────────────
  const panActive = handTool || spaceDown
  const canvasCursor = useMemo(() => {
    if (panActive)                    return panning ? 'grabbing' : 'grab'
    if (activeTool === 'select')      return 'default'
    if (activeTool === 'text')        return 'text'
    if (activeTool === 'signature')   return 'copy'
    return 'crosshair'
  }, [activeTool, panActive, panning])

  // ── Panel propriétés annotation sélectionnée ──────────────────────────────
  const selectedAnn = annotations.find(a => a.id === selectedId)

  // Snapshot d'historique « une fois par rafale » : les sliders émettent des
  // dizaines de changements ; on ne capture qu'au début de chaque geste (clé +
  // fenêtre de 800 ms), pour un Ctrl+Z qui annule le geste entier.
  const burstRef = useRef<{ key: string; at: number }>({ key: '', at: 0 })
  const snapshotOnce = useCallback((key: string) => {
    const now = Date.now()
    if (burstRef.current.key !== key || now - burstRef.current.at > 800) snapshot()
    burstRef.current = { key, at: now }
  }, [snapshot])

  // Applique un patch à toute la sélection (éventuellement filtrée par types).
  const updateSelProps = useCallback((patch: Record<string, unknown>, types?: string[], burstKey?: string) => {
    const set = new Set(selectedIds)
    if (!set.size) return
    if (burstKey) snapshotOnce(burstKey); else snapshot()
    setAnnotations(prev => prev.map(a =>
      set.has(a.id) && (!types || types.includes(a.type)) ? { ...a, ...patch } as Annotation : a))
    setDirty(true)
  }, [selectedIds, snapshot, snapshotOnce])

  // Types présents dans la sélection (pour afficher les bons contrôles).
  const selTypes = useMemo(() => new Set<string>(annotations.filter(a => selectedIds.includes(a.id)).map(a => a.type)), [annotations, selectedIds])
  const selHas = (...ts: string[]) => ts.some(x => selTypes.has(x))

  // ── Signatures : enregistrement / suppression / placement au clic ───────────
  const createSigMut = useMutation({
    mutationFn: (data: { name: string; sig_type: string; data: string }) => pdfWriterApi.createSignature(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pdf-signatures'] }),
  })
  const deleteSigMut = useMutation({
    mutationFn: (sigId: string) => pdfWriterApi.deleteSignature(sigId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pdf-signatures'] }),
  })
  // Le dialogue renvoie la signature choisie → on passe en mode « placement » :
  // le prochain clic sur la page pose la signature, centrée sous le curseur.
  const startSigPlacement = (sig: PlacedSignature) => {
    pendingSigRef.current = sig
    setShowSigPanel(false)
    setHandTool(false)
    setActiveTool('signature')
  }

  // ── Miniatures pages (rendu via l'index source ; glisser-déposer = réordonner) ─
  const pageMetaOf = (num: number) => docData?.pages?.find(p => p.page_number === num)
  const reorderMut = useMutation({
    mutationFn: (order: number[]) => pdfWriterApi.reorderPages(id!, order),
    onSuccess: () => refreshDoc(),
  })
  const [dragPage, setDragPage] = useState<number | null>(null)
  const [dropTarget, setDropTarget] = useState<number | null>(null)
  const handlePageDrop = (from: number, to: number) => {
    setDragPage(null); setDropTarget(null)
    if (from === to || reorderMut.isPending) return
    // Nouvel ordre : `order[i] = ancien numéro de la page qui devient i+1`.
    const order = Array.from({ length: totalPages }, (_, i) => i + 1)
    order.splice(from - 1, 1)
    order.splice(to - 1, 0, from)
    reorderMut.mutate(order)
    setCurrentPage(to)
  }

  const ThumbPage = ({ num }: { num: number }) => {
    const cRef = useRef<HTMLCanvasElement>(null)
    const meta = pageMetaOf(num)
    const mSrc = meta ? (meta.source_index ?? null) : num - 1
    const mRot = meta?.rotation ?? 0
    useEffect(() => {
      if (!cRef.current) return
      const canvas = cRef.current
      if (pdfDoc && mSrc != null && mSrc < pdfDoc.numPages) {
        pdfDoc.getPage(mSrc + 1).then(page => {
          const rot = (((page.rotate + mRot) % 360) + 360) % 360
          const vp = rot === page.rotate ? page.getViewport({ scale: 0.18 }) : page.getViewport({ scale: 0.18, rotation: rot })
          canvas.width  = vp.width
          canvas.height = vp.height
          page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport: vp })
        })
      } else {
        // Vignette d'une page vierge (dimensions affichées, rotation comprise).
        const w = meta?.width ?? 595, h = meta?.height ?? 842
        const swap = mRot % 180 !== 0
        canvas.width  = Math.round((swap ? h : w) * 0.12)
        canvas.height = Math.round((swap ? w : h) * 0.12)
        const ctx = canvas.getContext('2d')!
        ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height)
      }
    }, [num, mSrc, mRot, meta?.width, meta?.height])

    return (
      <div
        draggable
        onDragStart={(e) => { setDragPage(num); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(num)) }}
        onDragOver={(e) => {
          // Le numéro glissé est lu dans le DataTransfer au drop : l'état React ne
          // sert qu'au retour visuel (il peut être en retard d'un rendu).
          if (e.dataTransfer.types.includes('text/plain')) {
            e.preventDefault(); e.dataTransfer.dropEffect = 'move'
            if (dragPage !== num) setDropTarget(num)
          }
        }}
        onDragLeave={() => { if (dropTarget === num) setDropTarget(null) }}
        onDrop={(e) => {
          e.preventDefault()
          const from = dragPage ?? parseInt(e.dataTransfer.getData('text/plain'), 10)
          if (!Number.isNaN(from) && from >= 1) handlePageDrop(from, num)
        }}
        onDragEnd={() => { setDragPage(null); setDropTarget(null) }}
        className={`group relative flex flex-col items-center gap-1 p-1.5 rounded transition-all ${
          num === currentPage ? 'bg-[#5a9bdc33] ring-1 ring-primary' : 'hover:bg-[#454545]'} ${
          dragPage === num ? 'opacity-40' : ''} ${
          dropTarget === num ? (dragPage != null && dragPage < num ? 'border-b-2 border-[#5a9bdc]' : 'border-t-2 border-[#5a9bdc]') : ''}`}
      >
        <button onClick={() => setCurrentPage(num)} className="flex flex-col items-center gap-1 cursor-grab active:cursor-grabbing">
          <canvas ref={cRef} className="rounded shadow-sm border border-[#212121] max-w-[80px]" />
          <span className="text-[10px] text-[#8e8e8e]">{num}</span>
        </button>
        {/* Actions au survol : pivoter / supprimer */}
        <div className="absolute top-1 right-1 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <button title={t('pdf_rotate_page')} onClick={() => rotatePagePlus90(num)}
                  className="p-1 rounded bg-[#1e1e1ecc] hover:bg-[#454545] text-[#d6d6d6]"><RotateCw size={11} /></button>
          <button title={t('pdf_delete_page')} disabled={totalPages <= 1}
                  onClick={() => deletePageMut.mutate(num)}
                  className="p-1 rounded bg-[#1e1e1ecc] hover:bg-[#3a1a1a] text-[#e84a4a] disabled:opacity-30"><Trash2 size={11} /></button>
        </div>
      </div>
    )
  }

  // ── Rendu ─────────────────────────────────────────────────────────────────

  const pdfPanels = {
    pages: { label: t('pdf_pages'), render: () => (
      <div className="flex flex-col">
        <div className="flex items-center justify-between px-2 py-1.5 border-b border-[#212121]">
          <span className="text-[11px] text-[#8e8e8e]">{t('pdf_pages')} · {totalPages}</span>
          <button title={t('pdf_add_page')} onClick={() => addPageMut.mutate(currentPage)}
                  className="flex items-center gap-1 px-1.5 py-1 rounded text-[11px] bg-[#2a2a2a] hover:bg-[#454545] text-[#d6d6d6]">
            <Plus size={12} /> {t('pdf_add_page')}
          </button>
        </div>
        <div className="flex flex-col gap-1 p-1.5 overflow-y-auto">
          {Array.from({ length: totalPages }, (_, i) => (
            <ThumbPage key={i + 1} num={i + 1} />
          ))}
        </div>
      </div>
    ) },
    properties: { label: t('pdf_properties'), render: () => (
      <div className="flex flex-col" style={{ background: C.panel }}>
            {/* ── Réglages de l'outil (défauts des prochains objets) ── */}
            {!selectedAnn && (<>
            <div className="px-3 py-2 border-b border-[#212121]">
              <p className="text-[11px] text-[#8e8e8e] mb-1.5">{t('pdf_color')}</p>
              <div className="flex items-center gap-2">
                <ColorField t={t} C={C} color={selectedColor} onChange={setSelectedColor} width={32} height={32} />
                <div className="flex gap-1">
                  {['#ffff00', '#90EE90', '#ADD8E6', '#FFB6C1', '#FF8C00', '#ff0000'].map(c => (
                    <button
                      key={c}
                      onClick={() => setSelectedColor(c)}
                      className={`w-5 h-5 rounded border-2 transition-all ${
                        selectedColor === c ? 'border-[#5a9bdc] scale-110' : 'border-[#212121]'
                      }`}
                      style={{ background: c }}
                    />
                  ))}
                </div>
              </div>
            </div>
            <div className="px-3 py-2 border-b border-[#212121]">
              <p className="text-[11px] text-[#8e8e8e] mb-1.5">{t('pdf_default_font', { defaultValue: 'Police du texte' })}</p>
              <FontSizeField theme="dark" height={26} fontSize={12} fontWidth={150} sizeWidth={64}
                font={fontFamily} onFontChange={setFontFamily} fonts={fonts}
                size={String(Math.round(fontSize))} onSizeChange={v => setFontSize(Number(v))}
                sizes={[6, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72, 96]} minSize={6} maxSize={96} />
            </div>
            </>)}

            {/* ── Objet(s) sélectionné(s) ── */}
            {selectedAnn && (
              <div className="px-3 py-2 border-b border-[#212121]">
                <p className="text-[11px] text-[#8e8e8e] mb-1.5">
                  {selectedIds.length > 1
                    ? t('pdf_selected_count', { defaultValue: '{{count}} objets sélectionnés', count: selectedIds.length })
                    : t(`pdf_anntype_${selectedAnn.type.replace(/-/g, '_')}`)}
                </p>

                {/* Géométrie (sélection simple avec boîte) */}
                {selectedIds.length === 1 && (selectedAnn as { width?: number }).width != null && (() => {
                  const a = selectedAnn as unknown as { x: number; y: number; width: number; height: number; rotation?: number }
                  const num = (label: string, value: number, set: (v: number) => void, min = -10000, max = 10000) => (
                    <label className="flex items-center gap-1 text-[10px] text-[#8e8e8e]">
                      {label}
                      <input type="number" value={Math.round(value * 10) / 10}
                        onChange={e => { const v = +e.target.value; if (!Number.isNaN(v)) set(Math.max(min, Math.min(max, v))) }}
                        className="w-[52px] h-5 text-[11px] text-center outline-none rounded-sm"
                        style={{ background: '#252525', color: C.text, border: `1px solid ${C.border}` }} />
                    </label>
                  )
                  return (
                    <div className="grid grid-cols-2 gap-1.5 mb-2">
                      {num('X', a.x, v => updateSelProps({ x: v }, undefined, 'geo-x'))}
                      {num('Y', a.y, v => updateSelProps({ y: v }, undefined, 'geo-y'))}
                      {num('L', a.width, v => updateSelProps({ width: Math.max(4, v) }, undefined, 'geo-w'), 4)}
                      {num('H', a.height, v => updateSelProps({ height: Math.max(4, v) }, undefined, 'geo-h'), 4)}
                      {num('∠°', a.rotation ?? 0, v => updateSelProps({ rotation: ((v % 360) + 360) % 360 || undefined }, undefined, 'geo-r'), -360, 360)}
                    </div>
                  )
                })()}

                {/* Texte : police, taille, styles, alignement, couleurs */}
                {selHas('text') && !(selectedAnn as TextAnnotation).invisible && (() => {
                  const a = selectedAnn as TextAnnotation
                  const tgl = (active: boolean, icon: React.ReactNode, title: string, patch: Record<string, unknown>) => (
                    <button title={title} onClick={() => updateSelProps(patch, ['text'])}
                      className={`w-7 h-7 flex items-center justify-center rounded transition-colors ${
                        active ? 'bg-[#5a9bdc33] text-[#5a9bdc]' : 'text-[#8e8e8e] hover:bg-[#454545]'}`}>
                      {icon}
                    </button>
                  )
                  return (
                    <div className="flex flex-col gap-2 mb-2">
                      <FontSizeField theme="dark" height={26} fontSize={12} fontWidth={150} sizeWidth={64}
                        font={a.fontFamily} onFontChange={v => updateSelProps({ fontFamily: v }, ['text'])} fonts={fonts}
                        size={String(Math.round(a.fontSize))} onSizeChange={v => updateSelProps({ fontSize: Number(v) }, ['text'], 'fontsize')}
                        sizes={[6, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72, 96]} minSize={6} maxSize={96} />
                      <div className="flex items-center gap-1">
                        {tgl(a.bold, <Bold size={13} />, t('pdf_bold', { defaultValue: 'Gras' }), { bold: !a.bold })}
                        {tgl(a.italic, <Italic size={13} />, t('pdf_italic', { defaultValue: 'Italique' }), { italic: !a.italic })}
                        {tgl(!!a.underline, <Underline size={13} />, t('pdf_underline', { defaultValue: 'Souligné' }), { underline: !a.underline })}
                        <div className="w-px h-4 bg-[#454545] mx-0.5" />
                        {tgl(a.align === 'left', <TextAlignStart size={13} />, t('pdf_align_text_left', { defaultValue: 'Aligné à gauche' }), { align: 'left' })}
                        {tgl(a.align === 'center', <TextAlignCenter size={13} />, t('pdf_align_text_center', { defaultValue: 'Centré' }), { align: 'center' })}
                        {tgl(a.align === 'right', <TextAlignEnd size={13} />, t('pdf_align_text_right', { defaultValue: 'Aligné à droite' }), { align: 'right' })}
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[10px] text-[#8e8e8e]">{t('pdf_text_color', { defaultValue: 'Texte' })}</span>
                          <ColorField t={t} C={C} color={a.color} onChange={v => updateSelProps({ color: v }, ['text'], 'txtcol')} width={26} height={22} />
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className="text-[10px] text-[#8e8e8e]">{t('pdf_text_bg', { defaultValue: 'Fond' })}</span>
                          <ColorField t={t} C={C} color={a.backgroundColor || '#ffffff'} onChange={v => updateSelProps({ backgroundColor: v }, ['text'], 'txtbg')} width={26} height={22} />
                          {a.backgroundColor && (
                            <button onClick={() => updateSelProps({ backgroundColor: undefined }, ['text'])}
                              title={t('pdf_no_fill', { defaultValue: 'Aucun' })}
                              className="text-[10px] text-[#8e8e8e] hover:text-[#d6d6d6] underline">{t('pdf_none', { defaultValue: 'aucun' })}</button>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })()}

                {/* Formes : contour, épaisseur, style de trait, remplissage */}
                {selHas('rect', 'ellipse', 'line', 'arrow') && (() => {
                  const a = annotations.find(x => selectedIds.includes(x.id) && ['rect', 'ellipse', 'line', 'arrow'].includes(x.type)) as ShapeAnnotation
                  const SH = ['rect', 'ellipse', 'line', 'arrow']
                  return (
                    <div className="flex flex-col gap-2 mb-2">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-[#8e8e8e] w-14">{t('pdf_stroke', { defaultValue: 'Contour' })}</span>
                        <ColorField t={t} C={C} color={a.strokeColor} onChange={v => updateSelProps({ strokeColor: v }, SH, 'stroke')} width={26} height={22} />
                        <RangeSlider min={0.5} max={12} step={0.5} value={a.strokeWidth}
                          onChange={v => updateSelProps({ strokeWidth: v }, SH.concat('freehand'), 'strokew')}
                          className="flex-1" accent="#5a9bdc" trackColor="rgba(255,255,255,0.15)"
                          aria-label={t('pdf_stroke_width', { defaultValue: 'Épaisseur' })} />
                        <span className="text-xs text-[#8e8e8e] w-6 text-right">{a.strokeWidth}</span>
                      </div>
                      <div className="flex items-center gap-1">
                        {(['solid', 'dashed', 'dotted'] as const).map(ls => (
                          <button key={ls} onClick={() => updateSelProps({ lineStyle: ls === 'solid' ? undefined : ls }, SH)}
                            title={t(`pdf_line_${ls}`, { defaultValue: ls === 'solid' ? 'Continu' : ls === 'dashed' ? 'Tirets' : 'Pointillés' })}
                            className={`flex-1 h-7 flex items-center justify-center rounded transition-colors ${
                              (a.lineStyle ?? 'solid') === ls ? 'bg-[#5a9bdc33] text-[#5a9bdc]' : 'text-[#8e8e8e] hover:bg-[#454545]'}`}>
                            <svg width="34" height="6"><line x1="1" y1="3" x2="33" y2="3" stroke="currentColor" strokeWidth="2"
                              strokeDasharray={ls === 'dashed' ? '6,4' : ls === 'dotted' ? '1.5,3.5' : undefined} strokeLinecap="round" /></svg>
                          </button>
                        ))}
                      </div>
                      {['rect', 'ellipse'].includes(a.type) && (
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] text-[#8e8e8e] w-14">{t('pdf_fill', { defaultValue: 'Fond' })}</span>
                          <ColorField t={t} C={C} color={a.fillColor || '#ffffff'} onChange={v => updateSelProps({ fillColor: v, fillOpacity: a.fillOpacity ?? 0.35 }, SH, 'fill')} width={26} height={22} />
                          {a.fillColor
                            ? (<>
                              <RangeSlider min={0.05} max={1} step={0.05} value={a.fillOpacity ?? 0.35}
                                onChange={v => updateSelProps({ fillOpacity: v }, SH, 'fillop')}
                                className="flex-1" accent="#5a9bdc" trackColor="rgba(255,255,255,0.15)"
                                aria-label={t('pdf_fill_opacity', { defaultValue: 'Opacité du fond' })} />
                              <button onClick={() => updateSelProps({ fillColor: undefined }, SH)}
                                className="text-[10px] text-[#8e8e8e] hover:text-[#d6d6d6] underline">{t('pdf_none', { defaultValue: 'aucun' })}</button>
                            </>)
                            : <span className="text-[10px] text-[#8e8e8e]">{t('pdf_no_fill', { defaultValue: 'Aucun' })}</span>}
                        </div>
                      )}
                    </div>
                  )
                })()}

                {/* Encre / surlignage : couleur */}
                {selHas('freehand', 'highlight', 'underline', 'strikethrough') && (() => {
                  const a = annotations.find(x => selectedIds.includes(x.id) && ['freehand', 'highlight', 'underline', 'strikethrough'].includes(x.type)) as unknown as { color: string; strokeWidth?: number }
                  const MK = ['freehand', 'highlight', 'underline', 'strikethrough']
                  return (
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-[10px] text-[#8e8e8e] w-14">{t('pdf_color')}</span>
                      <ColorField t={t} C={C} color={a.color} onChange={v => updateSelProps({ color: v }, MK, 'mkcol')} width={26} height={22} />
                      {a.strokeWidth != null && (
                        <RangeSlider min={0.5} max={12} step={0.5} value={a.strokeWidth}
                          onChange={v => updateSelProps({ strokeWidth: v }, ['freehand'], 'inkw')}
                          className="flex-1" accent="#5a9bdc" trackColor="rgba(255,255,255,0.15)"
                          aria-label={t('pdf_stroke_width', { defaultValue: 'Épaisseur' })} />
                      )}
                    </div>
                  )
                })()}

                {/* Opacité (types qui la portent) */}
                {selHas('image', 'stamp', 'highlight', 'freehand', 'rect', 'ellipse', 'line', 'arrow') && (() => {
                  const a = selectedAnn as unknown as { opacity?: number }
                  const OP = ['image', 'stamp', 'highlight', 'freehand', 'rect', 'ellipse', 'line', 'arrow']
                  return (
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-[10px] text-[#8e8e8e] w-14">{t('pdf_opacity', { defaultValue: 'Opacité' })}</span>
                      <RangeSlider min={0.1} max={1} step={0.05} value={a.opacity ?? 1}
                        onChange={v => updateSelProps({ opacity: v }, OP, 'opacity')}
                        className="flex-1" accent="#5a9bdc" trackColor="rgba(255,255,255,0.15)"
                        aria-label={t('pdf_opacity', { defaultValue: 'Opacité' })} />
                      <span className="text-xs text-[#8e8e8e] w-8 text-right">{Math.round(((a.opacity ?? 1) * 100))}%</span>
                    </div>
                  )
                })()}

                {/* Tampon personnalisé : texte + couleur */}
                {selHas('stamp') && (selectedAnn as import('./api').StampAnnotation).stampType === 'custom' && (() => {
                  const a = selectedAnn as import('./api').StampAnnotation
                  return (
                    <div className="flex items-center gap-2 mb-2">
                      <input value={a.customLabel ?? ''} onChange={e => updateSelProps({ customLabel: e.target.value }, ['stamp'], 'stamptxt')}
                        placeholder={t('pdf_stamp_custom_text', { defaultValue: 'Texte du tampon' })}
                        className="flex-1 h-6 px-1.5 text-[11px] outline-none rounded-sm"
                        style={{ background: '#252525', color: C.text, border: `1px solid ${C.border}` }} />
                      <ColorField t={t} C={C} color={a.color || '#d93025'} onChange={v => updateSelProps({ color: v }, ['stamp'], 'stampcol')} width={26} height={22} />
                    </div>
                  )
                })()}

                {/* Champ de formulaire : libellé, nom, requis */}
                {selHas('form-text', 'form-checkbox', 'form-date', 'form-dropdown') && (() => {
                  const a = selectedAnn as import('./api').FormFieldAnnotation
                  const FF = ['form-text', 'form-checkbox', 'form-date', 'form-dropdown']
                  return (
                    <div className="flex flex-col gap-1.5 mb-2">
                      <input value={a.label ?? ''} onChange={e => updateSelProps({ label: e.target.value }, FF, 'fflabel')}
                        placeholder={t('pdf_form_label', { defaultValue: 'Libellé' })}
                        className="h-6 px-1.5 text-[11px] outline-none rounded-sm"
                        style={{ background: '#252525', color: C.text, border: `1px solid ${C.border}` }} />
                      <input value={a.fieldName} onChange={e => updateSelProps({ fieldName: e.target.value }, FF, 'ffname')}
                        placeholder={t('pdf_form_name', { defaultValue: 'Nom technique' })}
                        className="h-6 px-1.5 text-[11px] outline-none rounded-sm font-mono"
                        style={{ background: '#252525', color: C.textDim, border: `1px solid ${C.border}` }} />
                      <label className="flex items-center gap-2 text-[11px] text-[#8e8e8e] cursor-pointer select-none">
                        <input type="checkbox" checked={a.required} onChange={e => updateSelProps({ required: e.target.checked }, FF)} />
                        {t('pdf_form_required', { defaultValue: 'Champ requis' })}
                      </label>
                    </div>
                  )
                })()}

                {/* Alignement (sélection multiple) */}
                {selectedIds.length > 1 && (
                  <div className="flex items-center gap-0.5 mb-2">
                    {([
                      ['left', <AlignStartVertical key="a" size={13} />], ['center-h', <AlignCenterVertical key="b" size={13} />], ['right', <AlignEndVertical key="c" size={13} />],
                      ['top', <AlignStartHorizontal key="d" size={13} />], ['center-v', <AlignCenterHorizontal key="e" size={13} />], ['bottom', <AlignEndHorizontal key="f" size={13} />],
                    ] as [AlignKind, React.ReactNode][]).map(([k, icon]) => (
                      <button key={k} onClick={() => alignSelected(k)} title={t(`pdf_align_${k.replace('-', '_')}`, { defaultValue: k })}
                        className="w-7 h-7 flex items-center justify-center rounded text-[#8e8e8e] hover:bg-[#454545] transition-colors">
                        {icon}
                      </button>
                    ))}
                    <div className="w-px h-4 bg-[#454545] mx-0.5" />
                    <button onClick={() => distributeSelected('h')} disabled={selectedIds.length < 3} title={t('pdf_distribute_h', { defaultValue: 'Répartir horizontalement' })}
                      className="w-7 h-7 flex items-center justify-center rounded text-[#8e8e8e] hover:bg-[#454545] disabled:opacity-30 transition-colors">
                      <AlignHorizontalSpaceBetween size={13} />
                    </button>
                    <button onClick={() => distributeSelected('v')} disabled={selectedIds.length < 3} title={t('pdf_distribute_v', { defaultValue: 'Répartir verticalement' })}
                      className="w-7 h-7 flex items-center justify-center rounded text-[#8e8e8e] hover:bg-[#454545] disabled:opacity-30 transition-colors">
                      <AlignVerticalSpaceBetween size={13} />
                    </button>
                  </div>
                )}

                <button
                  onClick={deleteSelected}
                  className="flex items-center gap-1.5 px-2 py-1.5 text-xs text-[#e84a4a] hover:bg-[#3a1a1a] rounded-lg w-full transition-colors"
                >
                  <Trash2 size={12} /> {t('common_delete')}
                </button>
              </div>
            )}

            {/* Page courante — gestion */}
            <div className="px-3 py-2 border-b border-[#212121]">
              <p className="text-[11px] text-[#8e8e8e] mb-1.5">{t('pdf_current_page')}</p>
              <div className="flex flex-col gap-1">
                <button
                  onClick={() => {
                    if (!pdfDoc) return
                    pdfWriterApi.addPage(id!, { after: currentPage }).then(() => {
                      qc.invalidateQueries({ queryKey: ['pdf-doc', id] })
                      setCurrentPage(currentPage + 1)
                    })
                  }}
                  className="flex items-center gap-1.5 px-2 py-1.5 text-xs bg-[#2a2a2a] hover:bg-[#454545] rounded-lg transition-colors"
                >
                  <Plus size={12} /> {t('pdf_add_after')}
                </button>
                <button
                  onClick={async () => {
                    if (totalPages <= 1) return
                    const ok = await confirm({
                      title:        t('pdf_delete_page_title'),
                      message:      t('pdf_delete_page_msg', { page: currentPage }),
                      confirmLabel: t('common_delete'),
                      cancelLabel:  t('common_cancel'),
                      variant:      'danger',
                    })
                    if (!ok) return
                    pdfWriterApi.deletePage(id!, currentPage).then(() => {
                      qc.invalidateQueries({ queryKey: ['pdf-doc', id] })
                      setCurrentPage(Math.max(1, currentPage - 1))
                    })
                  }}
                  className="flex items-center gap-1.5 px-2 py-1.5 text-xs text-[#e84a4a] hover:bg-[#3a1a1a] rounded-lg transition-colors"
                >
                  <Trash2 size={12} /> {t('pdf_delete_page')}
                </button>
                <button
                  onClick={() => rotatePagePlus90(currentPage)}
                  className="flex items-center gap-1.5 px-2 py-1.5 text-xs bg-[#2a2a2a] hover:bg-[#454545] rounded-lg transition-colors"
                >
                  <RotateCw size={12} /> {t('pdf_rotate_90')}
                </button>
              </div>
            </div>

      </div>
    ) },
  }

  return (
    <>
      <EditorShell theme={C}
        chromeless
        topbarHeight={64}
        onBack={() => navigate('/paintsharp/pdfwriter')}
        title={titleDraft}
        onTitleChange={setTitleDraft}
        onTitleCommit={commitTitle}
        titlePlaceholder={t('common_untitled', { defaultValue: 'Sans titre' })}
        saveStatus={saveMut.isPending ? t('pdf_saving', { defaultValue: 'Enregistrement…' }) : (dirty ? t('pdf_unsaved_changes', { defaultValue: 'Modifications non enregistrées' }) : t('doc_saved', { defaultValue: 'Enregistré' }))}
        subtitle="PdfWriter"
        docInfo={`${currentPage} / ${totalPages}`}
        titleActions={(
          <button
            onClick={() => starMut.mutate(!docData?.is_starred)}
            title={docData?.is_starred ? t('pdf_unstar', { defaultValue: 'Retirer des favoris' }) : t('pdf_star', { defaultValue: 'Ajouter aux favoris' })}
            className="p-1.5 rounded hover:bg-white/10 flex-shrink-0 transition-colors"
            style={{ color: docData?.is_starred ? '#f9ab00' : C.textDim }}>
            <Star size={15} fill={docData?.is_starred ? 'currentColor' : 'none'} />
          </button>
        )}
        onDelete={() => trashMut.mutate()}
        deleteTitle={t('pdf_move_to_trash', { defaultValue: 'Mettre à la corbeille' })}
        deleteConfirm={{
          title: t('pdf_delete_confirm_title', { defaultValue: 'Supprimer ce document ?' }),
          message: t('pdf_delete_confirm_msg', { defaultValue: 'Le document sera déplacé dans la corbeille.' }),
          confirmLabel: t('common_delete', { defaultValue: 'Supprimer' }),
          variant: 'danger',
        }}
        menus={paintsharpMenus(t, {
          onSave:   handleSave,
          onExport: handleExport, exportLabel: t('common_export'),
          fileExtra: [
            { label: t('pdf_print', { defaultValue: 'Imprimer…' }), onClick: handlePrint, shortcut: 'Ctrl+P' },
          ],
          onClose:  () => navigate('/paintsharp/pdfwriter'),
          onUndo: undo, onRedo: redo, canUndo, canRedo,
          editExtra: [
            { label: t('common_cut', { defaultValue: 'Couper' }), onClick: cutSelection, disabled: !selectedIds.length, shortcut: 'Ctrl+X' },
            { label: t('common_copy', { defaultValue: 'Copier' }), onClick: copySelection, disabled: !selectedIds.length, shortcut: 'Ctrl+C' },
            { label: t('common_paste', { defaultValue: 'Coller' }), onClick: pasteClipboard, disabled: clipCount === 0, shortcut: 'Ctrl+V' },
            { label: t('common_duplicate', { defaultValue: 'Dupliquer' }), onClick: () => { if (selectedId) duplicateAnn(selectedId) }, disabled: !selectedId, shortcut: 'Ctrl+D' },
            'sep',
            { label: t('pdf_select_all', { defaultValue: 'Tout sélectionner' }), onClick: () => setSelectedIds(annotations.map(a => a.id)), shortcut: 'Ctrl+A' },
            { label: t('common_delete', { defaultValue: 'Supprimer' }), onClick: deleteSelected, disabled: !selectedIds.length, shortcut: 'Suppr' },
          ],
          extraMenus: [
            { label: t('pdf_menu_insert', { defaultValue: 'Insertion' }), items: [
              { label: t('pdf_tool_text', { defaultValue: 'Zone de texte' }), onClick: () => setActiveTool('text') },
              { label: t('pdf_add_image', { defaultValue: 'Image' }), onClick: () => imgInputRef.current?.click() },
              { label: t('pdf_tool_sticky_note', { defaultValue: 'Note' }), onClick: () => setActiveTool('sticky-note') },
              'sep',
              { label: t('pdf_tool_stamp', { defaultValue: 'Tampon' }), onClick: () => { setShowStampPicker(true) } },
              { label: t('pdf_tool_signature', { defaultValue: 'Signature' }), onClick: () => setShowSigPanel(true) },
              'sep',
              { label: t('pdf_tool_form_text', { defaultValue: 'Champ texte' }), onClick: () => setActiveTool('form-text') },
              { label: t('pdf_tool_form_checkbox', { defaultValue: 'Case à cocher' }), onClick: () => setActiveTool('form-checkbox') },
            ] },
            { label: t('pdf_menu_page', { defaultValue: 'Page' }), items: [
              { label: t('pdf_add_after', { defaultValue: 'Ajouter une page après' }), onClick: () => addPageMut.mutate(currentPage) },
              { label: t('pdf_delete_page', { defaultValue: 'Supprimer la page' }), onClick: () => deletePageMut.mutate(currentPage), disabled: totalPages <= 1 },
              { label: t('pdf_rotate_90', { defaultValue: 'Pivoter de 90°' }), onClick: () => rotatePagePlus90(currentPage) },
              'sep',
              { label: t('pdf_prev_page', { defaultValue: 'Page précédente' }), onClick: () => setCurrentPage(n => Math.max(1, n - 1)), disabled: currentPage <= 1, shortcut: 'PgUp' },
              { label: t('pdf_next_page', { defaultValue: 'Page suivante' }), onClick: () => setCurrentPage(n => Math.min(totalPages, n + 1)), disabled: currentPage >= totalPages, shortcut: 'PgDn' },
            ] },
            { label: t('pdf_menu_tools', { defaultValue: 'Outils' }), items: [
              { label: t('pdf_ocr_menu', { defaultValue: 'Reconnaître le texte (OCR)…' }), onClick: () => setOcrDialog(true), disabled: !pdfDoc || ocrRunning },
              ...(!editMode ? [{ label: t('pdf_edit_content', { defaultValue: 'Modifier le contenu' }), onClick: enableEditMode, disabled: converting }] : []),
            ] },
          ],
          onZoomIn:  () => zoomBy(1.15),
          onZoomOut: () => zoomBy(1 / 1.15),
          onFit: fitToPage,
          viewExtra: [
            { label: t('pdf_fit_width', { defaultValue: 'Ajuster à la largeur' }), onClick: fitToWidth },
            { label: t('pdf_zoom_100', { defaultValue: 'Taille réelle (100 %)' }), onClick: () => zoomTo(1), shortcut: 'Ctrl+0' },
          ],
        })}
        topbarActions={<>
        <div className="flex items-center gap-1 bg-[#2a2a2a] rounded-lg px-1">
          <button onClick={() => zoomBy(1 / 1.15)} title={t('pdf_zoom_out', { defaultValue: 'Zoom arrière (Ctrl -)' })}
                  className="p-1.5 rounded hover:bg-[#454545] text-[#8e8e8e]">
            <ZoomOut size={14} />
          </button>
          <button
            onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setZoomMenu({ x: r.left, y: r.bottom + 4 }) }}
            title={t('pdf_zoom_presets', { defaultValue: 'Niveau de zoom' })}
            className="text-xs text-[#8e8e8e] w-14 text-center hover:bg-[#454545] rounded py-1"
          >
            {Math.round(scale * 100)}%
          </button>
          <button onClick={() => zoomBy(1.15)} title={t('pdf_zoom_in', { defaultValue: 'Zoom avant (Ctrl +)' })}
                  className="p-1.5 rounded hover:bg-[#454545] text-[#8e8e8e]">
            <ZoomIn size={14} />
          </button>
          <button onClick={fitToWidth} title={t('pdf_fit_width', { defaultValue: 'Ajuster à la largeur' })}
                  className="p-1.5 rounded hover:bg-[#454545] text-[#8e8e8e]">
            <Maximize2 size={13} className="rotate-45" />
          </button>
        </div>

        {/* Navigation de pages (numéro éditable, façon Acrobat) */}
        <div className="flex items-center gap-1 bg-[#2a2a2a] rounded-lg px-1">
          <button
            onClick={() => setCurrentPage(n => Math.max(1, n - 1))}
            disabled={currentPage <= 1}
            className="p-1.5 rounded hover:bg-[#454545] text-[#8e8e8e] disabled:opacity-30"
          >
            <ChevronLeft size={14} />
          </button>
          <input
            key={`pg-${currentPage}`}
            defaultValue={currentPage}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') {
                const v = parseInt((e.target as HTMLInputElement).value, 10)
                if (!Number.isNaN(v)) setCurrentPage(Math.min(totalPages, Math.max(1, v)))
                ;(e.target as HTMLInputElement).blur()
              }
            }}
            onBlur={(e) => { e.target.value = String(currentPage) }}
            title={t('pdf_goto_page', { defaultValue: 'Aller à la page…' })}
            className="w-9 text-xs text-center bg-transparent text-[#d6d6d6] outline-none rounded py-1 hover:bg-[#454545] focus:bg-[#1e1e1e]"
          />
          <span className="text-xs text-[#8e8e8e] whitespace-nowrap pr-1">/ {totalPages}</span>
          <button
            onClick={() => setCurrentPage(n => Math.min(totalPages, n + 1))}
            disabled={currentPage >= totalPages}
            className="p-1.5 rounded hover:bg-[#454545] text-[#8e8e8e] disabled:opacity-30"
          >
            <ChevronRight size={14} />
          </button>
        </div>

        <div className="w-px h-5 bg-border mx-1" />

        {/* Annuler / Rétablir */}
        <button onClick={undo} disabled={!canUndo} title={t('pdf_undo', { defaultValue: 'Annuler (Ctrl+Z)' })}
          className="p-1.5 rounded hover:bg-[#454545] text-[#8e8e8e] disabled:opacity-30"><Undo2 size={16} /></button>
        <button onClick={redo} disabled={!canRedo} title={t('pdf_redo', { defaultValue: 'Rétablir (Ctrl+Maj+Z)' })}
          className="p-1.5 rounded hover:bg-[#454545] text-[#8e8e8e] disabled:opacity-30"><Redo2 size={16} /></button>

        <div className="w-px h-5 bg-border mx-1" />

        {/* Activer l'édition de contenu sur tout le document (extraction texte + images) */}
        {!editMode && (
          <button
            onClick={enableEditMode}
            disabled={converting}
            title={t('pdf_edit_content_hint', { defaultValue: 'Rendre tout le PDF éditable : son contenu (texte et images) devient des éléments déplaçables/modifiables (chaque page est convertie à son ouverture)' })}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-[#212121] rounded-lg
                       hover:bg-[#454545] text-[#8e8e8e] transition-colors disabled:opacity-40"
          >
            {converting ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
            {t('pdf_edit_content', { defaultValue: 'Modifier le contenu' })}
          </button>
        )}

        {/* OCR : reconnaître le texte (façon Acrobat) */}
        <button
          onClick={() => { if (!pdfDoc || ocrRunning) return; setOcrDialog(true) }}
          disabled={!pdfDoc || ocrRunning}
          title={t('pdf_ocr_hint', { defaultValue: 'Reconnaître le texte de la page (OCR) et l’insérer comme texte éditable' })}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-[#212121] rounded-lg
                     hover:bg-[#454545] text-[#8e8e8e] transition-colors disabled:opacity-40"
        >
          {ocrRunning ? <Loader2 size={14} className="animate-spin" /> : <ScanText size={14} />}
          {t('pdf_ocr', { defaultValue: 'OCR' })}
        </button>

        {/* Ajouter une image */}
        <button
          onClick={() => imgInputRef.current?.click()}
          title={t('pdf_add_image', { defaultValue: 'Ajouter une image' })}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-[#212121] rounded-lg
                     hover:bg-[#454545] text-[#8e8e8e] transition-colors"
        >
          <ImageIcon size={14} />
          {t('pdf_add_image', { defaultValue: 'Image' })}
        </button>
        <input
          ref={imgInputRef} type="file" accept="image/*" hidden
          onChange={(e) => { const f = e.target.files?.[0]; if (f) addImageFile(f); e.target.value = '' }}
        />

        {/* Imprimer (PDF aplati → dialogue d'impression du navigateur) */}
        <button
          onClick={handlePrint}
          disabled={printing}
          title={t('pdf_print_hint', { defaultValue: 'Imprimer le document avec ses annotations' })}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-[#212121] rounded-lg
                     hover:bg-[#454545] text-[#8e8e8e] transition-colors disabled:opacity-50"
        >
          {printing ? <Loader2 size={14} className="animate-spin" /> : <Printer size={14} />}
          {t('pdf_print_short', { defaultValue: 'Imprimer' })}
        </button>

        {/* Exporter un vrai PDF avec les annotations fusionnées */}
        <button
          onClick={handleExport}
          disabled={exporting}
          title={t('pdf_export_hint')}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-[#212121] rounded-lg
                     hover:bg-[#454545] text-[#8e8e8e] transition-colors disabled:opacity-50"
        >
          {exporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
          {t('common_export')}
        </button>

        {/* Sauvegarder */}
        <Button
          size="sm"
          onClick={handleSave}
          disabled={saving || !dirty}
          loading={saving}
          icon={<Save size={14} />}
        >
          {t('common_save')}
        </Button>
        </>}
        toolRail={<>
          {/* Outil Main (pan) — comme Acrobat ; barre d'espace = pan temporaire. */}
          <button
            title={t('pdf_tool_hand', { defaultValue: 'Main (déplacer la vue) — barre d’espace' })}
            onClick={() => setHandTool(h => !h)}
            className={`w-9 h-9 flex items-center justify-center rounded-lg transition-colors ${
              handTool ? 'bg-[#5a9bdc33] text-[#5a9bdc]' : 'text-[#8e8e8e] hover:bg-[#454545]'}`}
          >
            <Hand size={16} />
          </button>
          <div className="w-6 h-px bg-border my-1" />
          {([
            { tool: 'select',          Icon: MousePointer2,  title: t('pdf_tool_select') },
            null,
            { tool: 'text',            Icon: Type,           title: t('pdf_tool_text') },
            { tool: 'highlight',       Icon: Highlighter,    title: t('pdf_tool_highlight') },
            { tool: 'underline',       Icon: Underline,      title: t('pdf_tool_underline') },
            { tool: 'strikethrough',   Icon: Strikethrough,  title: t('pdf_tool_strikethrough') },
            { tool: 'sticky-note',     Icon: MessageSquare,  title: t('pdf_tool_sticky_note') },
            null,
            { tool: 'freehand',        Icon: Pen,            title: t('pdf_tool_freehand') },
            { tool: 'rect',            Icon: Square,         title: t('pdf_tool_rect') },
            { tool: 'ellipse',         Icon: Circle,         title: t('pdf_tool_ellipse') },
            { tool: 'line',            Icon: Minus,          title: t('pdf_tool_line') },
            { tool: 'arrow',           Icon: MoveRight,      title: t('pdf_tool_arrow') },
            null,
            { tool: 'stamp',           Icon: Stamp,          title: t('pdf_tool_stamp'), action: () => setShowStampPicker(p => !p) },
            { tool: 'signature',       Icon: PenLine,        title: t('pdf_tool_signature'), action: () => setShowSigPanel(p => !p) },
            null,
            { tool: 'form-text',       Icon: TextCursorInput, title: t('pdf_tool_form_text') },
            { tool: 'form-checkbox',   Icon: CheckSquare,    title: t('pdf_tool_form_checkbox') },
          ] as (null | { tool: Tool; Icon: React.FC<{ size?: number }>; title: string; action?: () => void })[])
            .map((item, i) => {
              if (!item) return <div key={i} className="w-6 h-px bg-border my-1" />
              const { tool, Icon, title, action } = item
              return (
                <button
                  key={tool}
                  title={title}
                  onClick={() => { setHandTool(false); setActiveTool(tool); action?.() }}
                  className={`w-9 h-9 flex items-center justify-center rounded-lg transition-colors ${
                    activeTool === tool && !handTool
                      ? 'bg-[#5a9bdc33] text-[#5a9bdc]'
                      : 'text-[#8e8e8e] hover:bg-[#454545]'
                  }`}
                >
                  <Icon size={16} />
                </button>
              )
            })
          }
        </>}>
        <DockArea theme={C} storageKey="kubuno:paintsharp:pdfDockLayout" viewportBg="#e5e5e5"
          defaultArrangement={{ left: [['pages']], right: [['properties']] }} panels={pdfPanels}>
        <div
          ref={scrollRef}
          className="w-full h-full overflow-auto flex items-start justify-center py-6 px-6"
          style={{ background: '#e5e5e5', cursor: panActive ? (panning ? 'grabbing' : 'grab') : undefined }}
          onMouseDown={(e) => {
            // Pan : clic du milieu, ou clic gauche quand l'outil Main / barre d'espace est actif.
            if (e.button === 1 || (e.button === 0 && panActive)) { e.preventDefault(); startPan(e.clientX, e.clientY) }
          }}
        >
          {loading && (
            <div className="flex items-center gap-2 text-[#8e8e8e] mt-20">
              <Loader2 size={24} className="animate-spin" />
              <span className="text-sm">{t('pdf_loading_pdf')}</span>
            </div>
          )}

          {(!loading || pdfDoc) && (
            <div className="relative shadow-2xl rounded" style={{ display: 'inline-block' }}>
              {/* Canvas PDF */}
              <canvas ref={canvasRef} className="block rounded" />

              {/* Canvas dessin libre (par-dessus) */}
              <canvas
                ref={drawCanvasRef}
                className="absolute inset-0 rounded"
                style={{ pointerEvents: 'none' }}
              />

              {/* SVG annotations */}
              <svg
                ref={overlayRef}
                className="absolute inset-0 rounded"
                style={{ cursor: canvasCursor, overflow: 'visible', pointerEvents: panActive ? 'none' : undefined }}
                onMouseDown={handleCanvasMouseDown}
                onMouseMove={(e) => {
                  handleCanvasMouseMove(e)
                  // Survol : curseur « déplacer » au-dessus d'un objet (outil sélection, hors drag).
                  if (activeTool === 'select' && !elDragRef.current && !marqueeStartRef.current && overlayRef.current) {
                    const { x, y } = coordsFromEvent(e)
                    const pt = { x: pxToPoint(x), y: pxToPoint(y) }
                    const over = annotations.some(a => hitTestR(a, pt))
                    overlayRef.current.style.cursor = over ? 'move' : 'default'
                  }
                }}
                onMouseUp={handleCanvasMouseUp}
                onMouseLeave={(e) => { if (elDragRef.current || marqueeStartRef.current) handleCanvasMouseUp(e) }}
                onDoubleClick={(e) => {
                  const { x, y } = coordsFromEvent(e)
                  const pt = { x: pxToPoint(x), y: pxToPoint(y) }
                  // Texte / note / champ texte : édition en place. Case à cocher : bascule.
                  const hit = [...annotations].reverse().find(a =>
                    ['text', 'sticky-note', 'form-text', 'form-date', 'form-dropdown'].includes(a.type) && hitTestR(a, pt))
                  if (hit) { elDragRef.current = null; selectOnly(hit.id); snapshot(); setEditingTextId(hit.id); return }
                  const chk = [...annotations].reverse().find(a => a.type === 'form-checkbox' && hitTestR(a, pt))
                  if (chk) { snapshot(); updateAnn(chk.id, { value: !(chk as import('./api').FormFieldAnnotation).value }) }
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  const { x, y } = coordsFromEvent(e)
                  const pt = { x: pxToPoint(x), y: pxToPoint(y) }
                  const hit = [...annotations].reverse().find(a => hitTestR(a, pt))
                  if (hit) {
                    if (!selectedIds.includes(hit.id)) selectOnly(hit.id)
                    setCtxMenu({ x: e.clientX, y: e.clientY, id: hit.id })
                  } else setCtxMenu(null)
                }}
              >
                {renderAnnotations()}
                {renderResizeHandles()}
                {renderShapeDraft()}
                {renderGuides()}
                {renderMarquee()}
              </svg>

              {/* Éditeur en place (double-clic) : texte, note ou valeur de champ */}
              {editingTextId && (() => {
                const ann = annotations.find(x => x.id === editingTextId)
                if (!ann) return null
                if (ann.type === 'text') {
                  const a = ann as import('./api').TextAnnotation
                  return (
                    <textarea
                      autoFocus
                      value={a.content}
                      onChange={(e) => updateAnn(a.id, { content: e.target.value })}
                      onBlur={() => setEditingTextId(null)}
                      onKeyDown={(e) => { if (e.key === 'Escape') setEditingTextId(null); e.stopPropagation() }}
                      className="absolute z-10 resize-none outline outline-2 outline-[#1a73e8] bg-white/95"
                      style={{
                        left: a.x * scale, top: a.y * scale,
                        width: Math.max(60, a.width * scale), height: Math.max(24, a.height * scale),
                        // La zone d'édition rend le texte à la MÊME échelle que la page
                        // (avant : taille en pt écran fixe, décalée dès que zoom ≠ 100 %).
                        fontSize: a.fontSize * scale, fontFamily: a.fontFamily, color: a.color,
                        fontWeight: a.bold ? 'bold' : 'normal', fontStyle: a.italic ? 'italic' : 'normal',
                        textDecoration: a.underline ? 'underline' : undefined,
                        textAlign: a.align, padding: '2px', lineHeight: 1.2,
                        transform: a.rotation ? `rotate(${a.rotation}deg)` : undefined,
                        transformOrigin: 'center',
                      }}
                    />
                  )
                }
                if (ann.type === 'sticky-note') {
                  const a = ann as import('./api').StickyNoteAnnotation
                  return (
                    <textarea
                      autoFocus
                      value={a.content}
                      placeholder={t('pdf_empty_note')}
                      onChange={(e) => updateAnn(a.id, { content: e.target.value })}
                      onBlur={() => setEditingTextId(null)}
                      onKeyDown={(e) => { if (e.key === 'Escape') setEditingTextId(null); e.stopPropagation() }}
                      className="absolute z-10 resize-none outline outline-2 outline-[#1a73e8] rounded"
                      style={{
                        left: a.x * scale + 22, top: a.y * scale,
                        width: 180, height: 100,
                        background: a.color, color: '#222', fontSize: 12, padding: 6,
                      }}
                    />
                  )
                }
                if (ann.type === 'form-text' || ann.type === 'form-date' || ann.type === 'form-dropdown') {
                  const a = ann as import('./api').FormFieldAnnotation
                  return (
                    <input
                      autoFocus
                      value={String(a.value ?? '')}
                      onChange={(e) => updateAnn(a.id, { value: e.target.value })}
                      onBlur={() => setEditingTextId(null)}
                      onKeyDown={(e) => { if (e.key === 'Escape' || e.key === 'Enter') setEditingTextId(null); e.stopPropagation() }}
                      className="absolute z-10 outline outline-2 outline-[#1a73e8] bg-white"
                      style={{
                        left: a.x * scale, top: a.y * scale,
                        width: Math.max(60, a.width * scale), height: Math.max(20, a.height * scale),
                        fontSize: 12 * scale, color: '#333', padding: '0 4px',
                      }}
                    />
                  )
                }
                return null
              })()}
            </div>
          )}
        </div>
        </DockArea>
      </EditorShell>

      {/* ── Menu contextuel d'un objet (clic droit) — MenuDropdown de @ui ── */}
      {ctxMenu && (() => {
        const a = annotations.find(x => x.id === ctxMenu.id)
        if (!a) return null
        const multi = selectedIds.length > 1
        const items: MenuItem[] = []
        if (a.type === 'text') items.push({ type: 'action', label: t('pdf_ctx_edit_text', { defaultValue: 'Modifier le texte' }), icon: <Type size={14} />, onClick: () => { snapshot(); setEditingTextId(a.id) } })
        if (a.type === 'sticky-note') items.push({ type: 'action', label: t('pdf_ctx_edit_note', { defaultValue: 'Modifier la note' }), icon: <MessageSquare size={14} />, onClick: () => { snapshot(); setEditingTextId(a.id) } })
        items.push(
          { type: 'action', label: t('common_cut', { defaultValue: 'Couper' }), icon: <Scissors size={14} />, shortcut: 'Ctrl+X', onClick: () => cutSelection() },
          { type: 'action', label: t('common_copy', { defaultValue: 'Copier' }), icon: <Copy size={14} />, shortcut: 'Ctrl+C', onClick: () => copySelection() },
          { type: 'action', label: t('common_paste', { defaultValue: 'Coller' }), icon: <ClipboardPaste size={14} />, shortcut: 'Ctrl+V', disabled: clipCount === 0, onClick: () => pasteClipboard() },
          { type: 'action', label: t('common_duplicate', { defaultValue: 'Dupliquer' }), shortcut: 'Ctrl+D', onClick: () => duplicateAnn(a.id) },
          { type: 'separator' },
          ...(multi ? [
            {
              type: 'submenu', label: t('pdf_ctx_align', { defaultValue: 'Aligner' }), icon: <AlignStartVertical size={14} />, items: [
                { type: 'action', label: t('pdf_align_left',     { defaultValue: 'Bords gauches' }),        icon: <AlignStartVertical size={14} />,   onClick: () => alignSelected('left') },
                { type: 'action', label: t('pdf_align_center_h', { defaultValue: 'Centres (vertical)' }),   icon: <AlignCenterVertical size={14} />,  onClick: () => alignSelected('center-h') },
                { type: 'action', label: t('pdf_align_right',    { defaultValue: 'Bords droits' }),         icon: <AlignEndVertical size={14} />,     onClick: () => alignSelected('right') },
                { type: 'separator' },
                { type: 'action', label: t('pdf_align_top',      { defaultValue: 'Bords supérieurs' }),     icon: <AlignStartHorizontal size={14} />, onClick: () => alignSelected('top') },
                { type: 'action', label: t('pdf_align_center_v', { defaultValue: 'Centres (horizontal)' }), icon: <AlignCenterHorizontal size={14} />, onClick: () => alignSelected('center-v') },
                { type: 'action', label: t('pdf_align_bottom',   { defaultValue: 'Bords inférieurs' }),     icon: <AlignEndHorizontal size={14} />,   onClick: () => alignSelected('bottom') },
                { type: 'separator' },
                { type: 'action', label: t('pdf_distribute_h', { defaultValue: 'Répartir horizontalement' }), icon: <AlignHorizontalSpaceBetween size={14} />, disabled: selectedIds.length < 3, onClick: () => distributeSelected('h') },
                { type: 'action', label: t('pdf_distribute_v', { defaultValue: 'Répartir verticalement' }),   icon: <AlignVerticalSpaceBetween size={14} />,   disabled: selectedIds.length < 3, onClick: () => distributeSelected('v') },
              ],
            } as MenuItem,
            { type: 'separator' } as MenuItem,
          ] : []),
          { type: 'action', label: t('pdf_ctx_to_front', { defaultValue: 'Mettre au premier plan' }), icon: <ArrowUp size={14} />, onClick: () => reorderAnn(a.id, 'front') },
          { type: 'action', label: t('pdf_ctx_forward', { defaultValue: 'Avancer' }), onClick: () => reorderAnn(a.id, 'forward') },
          { type: 'action', label: t('pdf_ctx_backward', { defaultValue: 'Reculer' }), onClick: () => reorderAnn(a.id, 'backward') },
          { type: 'action', label: t('pdf_ctx_to_back', { defaultValue: 'Mettre à l’arrière-plan' }), icon: <ArrowDown size={14} />, onClick: () => reorderAnn(a.id, 'back') },
          { type: 'separator' },
          { type: 'action', label: t('common_delete', { defaultValue: 'Supprimer' }), icon: <Trash2 size={14} />, danger: true, onClick: () => deleteSelected() },
        )
        return <MenuDropdown items={items} pos={{ top: ctxMenu.y, left: ctxMenu.x }} onClose={() => setCtxMenu(null)} />
      })()}

      {/* ── Menu des niveaux de zoom (façon Acrobat) ── */}
      {zoomMenu && (() => {
        const presets = [0.5, 0.75, 1, 1.25, 1.5, 2, 4]
        const items: MenuItem[] = [
          { type: 'action', label: t('pdf_fit_width', { defaultValue: 'Ajuster à la largeur' }), onClick: () => fitToWidth() },
          { type: 'action', label: t('pdf_fit_page', { defaultValue: 'Page entière' }), onClick: () => fitToPage() },
          { type: 'separator' },
          ...presets.map<MenuItem>(p => ({
            type: 'action',
            label: `${Math.round(p * 100)}%`,
            icon: Math.round(scale * 100) === Math.round(p * 100) ? <Check size={14} /> : undefined,
            onClick: () => zoomTo(p),
          })),
        ]
        return <MenuDropdown items={items} pos={{ top: zoomMenu.y, left: zoomMenu.x }} onClose={() => setZoomMenu(null)} />
      })()}

      {/* ── Dialogue d'options OCR (langue · portée · mode) ── */}
      {ocrDialog && !ocrRunning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 no-print"
             onClick={() => setOcrDialog(false)}>
          <div className="bg-[#323232] rounded-2xl shadow-2xl p-5 w-[400px]" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2 mb-4">
              <ScanText size={18} className="text-[#5a9bdc]" />
              <h3 className="text-base font-semibold text-[#d6d6d6]">{t('pdf_ocr_title', { defaultValue: 'Reconnaissance de texte' })}</h3>
            </div>
            {([
              { label: t('pdf_ocr_lang', { defaultValue: 'Langue' }), value: ocrLang, set: (v: string) => setOcrLang(v as typeof ocrLang), opts: [
                ['fra+eng', t('pdf_ocr_lang_fra_eng', { defaultValue: 'Français + Anglais' })],
                ['fra',     t('pdf_ocr_lang_fra',     { defaultValue: 'Français' })],
                ['eng',     t('pdf_ocr_lang_eng',     { defaultValue: 'Anglais' })],
              ] },
              { label: t('pdf_ocr_scope', { defaultValue: 'Portée' }), value: ocrScope, set: (v: string) => setOcrScope(v as typeof ocrScope), opts: [
                ['page', t('pdf_ocr_scope_page', { defaultValue: 'Page courante' })],
                ['doc',  t('pdf_ocr_scope_doc',  { defaultValue: 'Document entier' })],
              ] },
              { label: t('pdf_ocr_mode', { defaultValue: 'Résultat' }), value: ocrMode, set: (v: string) => setOcrMode(v as typeof ocrMode), opts: [
                ['editable',  t('pdf_ocr_mode_editable',  { defaultValue: 'Texte éditable' })],
                ['invisible', t('pdf_ocr_mode_invisible', { defaultValue: 'Couche invisible (recherchable)' })],
              ] },
            ] as { label: string; value: string; set: (v: string) => void; opts: [string, string][] }[]).map(row => (
              <div key={row.label} className="mb-3">
                <p className="text-[11px] text-[#8e8e8e] mb-1.5">{row.label}</p>
                <div className="flex gap-1.5">
                  {row.opts.map(([v, lbl]) => (
                    <button key={v} onClick={() => row.set(v)}
                            className={`flex-1 text-xs py-1.5 px-2 rounded-lg border transition-colors ${
                              row.value === v
                                ? 'bg-[#5a9bdc] border-[#5a9bdc] text-white'
                                : 'bg-[#2a2a2a] border-[#454545] text-[#8e8e8e] hover:bg-[#3a3a3a]'}`}>
                      {lbl}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setOcrDialog(false)}
                      className="px-3 py-1.5 text-sm rounded-lg border border-[#454545] text-[#8e8e8e] hover:bg-[#3a3a3a]">
                {t('common_cancel', { defaultValue: 'Annuler' })}
              </button>
              <button onClick={() => runOcr({ lang: ocrLang, scope: ocrScope, mode: ocrMode })}
                      className="px-3 py-1.5 text-sm rounded-lg bg-[#5a9bdc] text-white hover:bg-[#4a8bcc] flex items-center gap-1.5">
                <ScanText size={14} />
                {t('pdf_ocr_run', { defaultValue: 'Lancer l’OCR' })}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Fenêtre d'avancement / résultat OCR ── */}
      {(ocrRunning || ocrResultMsg) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 no-print"
             onClick={() => { if (!ocrRunning) setOcrResultMsg(null) }}>
          <div className="bg-[#323232] rounded-2xl shadow-2xl p-5 w-[380px]" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2 mb-3">
              <ScanText size={18} className="text-[#5a9bdc]" />
              <h3 className="text-base font-semibold text-[#d6d6d6]">{t('pdf_ocr_title', { defaultValue: 'Reconnaissance de texte' })}</h3>
            </div>
            {ocrRunning ? (
              <>
                <p className="text-xs text-[#8e8e8e] mb-2">{ocrStatus}</p>
                <div className="h-2 rounded-full bg-[#1e1e1e] overflow-hidden">
                  <div className="h-full bg-[#5a9bdc] transition-all" style={{ width: `${ocrPct}%` }} />
                </div>
                <p className="text-[11px] text-[#8e8e8e] mt-2 text-right">{ocrPct}%</p>
              </>
            ) : (
              <>
                <p className="text-sm text-[#d6d6d6] mb-4">{ocrResultMsg}</p>
                <div className="flex justify-end">
                  <Button size="sm" onClick={() => setOcrResultMsg(null)}>{t('common_ok', { defaultValue: 'OK' })}</Button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {/* ── Picker de tampon ── */}
      {showStampPicker && (
        <div
          className="fixed left-14 top-48 bg-[#323232] border border-[#212121] rounded-xl shadow-xl z-50 p-2 w-52"
          onClick={e => e.stopPropagation()}
        >
          <div className="flex items-center justify-between mb-2 px-1">
            <span className="text-xs font-medium text-[#d6d6d6]">{t('pdf_choose_stamp')}</span>
            <button onClick={() => setShowStampPicker(false)} className="text-[#8e8e8e] hover:text-[#d6d6d6]">
              <X size={13} />
            </button>
          </div>
          <div className="flex flex-col gap-1">
            {STAMP_TYPES.map(st => (
              <button
                key={st.key}
                onClick={() => {
                  setActiveStamp(st.key)
                  setActiveTool('stamp')
                  setShowStampPicker(false)
                }}
                className={`flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs transition-colors ${
                  activeStamp === st.key ? 'bg-[#454545] font-medium' : 'hover:bg-[#454545]'
                }`}
              >
                <span
                  className="text-[10px] font-bold px-1.5 py-0.5 rounded border-2"
                  style={{ color: st.color, borderColor: st.color }}
                >
                  {t(st.labelKey).slice(0, 6)}
                </span>
                <span className="text-[#8e8e8e]">{t(st.labelKey)}</span>
              </button>
            ))}
            {/* Tampon personnalisé : texte + couleur libres */}
            <div className="border-t border-[#212121] mt-1 pt-2 flex flex-col gap-1.5">
              <span className="text-[10px] text-[#8e8e8e] px-1">{t('pdf_stamp_custom', { defaultValue: 'Tampon personnalisé' })}</span>
              <div className="flex items-center gap-1.5 px-1">
                <input
                  value={customStampText}
                  onChange={e => setCustomStampText(e.target.value)}
                  placeholder={t('pdf_stamp_custom_text', { defaultValue: 'Texte du tampon' })}
                  className="flex-1 h-6 px-1.5 text-[11px] outline-none rounded-sm min-w-0"
                  style={{ background: '#252525', color: C.text, border: `1px solid ${C.border}` }}
                />
                <ColorField t={t} C={C} color={customStampColor} onChange={setCustomStampColor} width={24} height={22} />
              </div>
              <button
                disabled={!customStampText.trim()}
                onClick={() => { setActiveStamp('custom'); setActiveTool('stamp'); setShowStampPicker(false) }}
                className="mx-1 mb-0.5 px-2 py-1.5 rounded-lg text-xs bg-[#2a2a2a] hover:bg-[#454545] text-[#d6d6d6] disabled:opacity-40 transition-colors"
              >
                {t('pdf_stamp_use_custom', { defaultValue: 'Utiliser ce tampon' })}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Dialogue signature (dessiner / taper / importer, aperçus, gestion) ── */}
      {showSigPanel && (
        <PdfSignatureDialog
          t={t}
          sigs={sigsData ?? []}
          busy={createSigMut.isPending}
          onPlace={startSigPlacement}
          onSave={(d) => createSigMut.mutate(d)}
          onDelete={(sigId) => deleteSigMut.mutate(sigId)}
          onClose={() => setShowSigPanel(false)}
        />
      )}

      {confirmState && (
        <ConfirmDialog {...confirmState} onConfirm={handleConfirm} onCancel={handleCancel} />
      )}
    </>
  )
}