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
  Hand, Maximize2, Check, ScanText,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { pdfWriterApi, type Annotation, type PdfSignature } from './api'
import { extractPageElements } from './pdfExtract'
import { buildAnnotatedPdf, type ExportPage } from './pdfExport'
import { useAuthStore } from '@kubuno/sdk'
import { useConfirm } from '@kubuno/sdk'
import { ConfirmDialog } from '@ui'
import { Button, MenuDropdown, RangeSlider, type MenuItem } from '@ui'
import { C, EditorShell, DockArea, ColorField, paintsharpMenus } from './ui'
import { useDebouncedAutosave } from './useAutosave'
import { recognizeImage, disposeOcr, type OcrLang } from './pdfOcr'

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
  // Drag d'élément(s) : déplacement (potentiellement groupé) ou redimensionnement (élément unique).
  const elDragRef = useRef<{
    id: string; mode: 'move' | 'resize'; handle?: string; startX: number; startY: number
    orig: { x: number; y: number; width: number; height: number }
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
  // OCR (reconnaissance de texte) — état d'avancement + menu de langue.
  const [ocrMenu, setOcrMenu]       = useState<{ x: number; y: number } | null>(null)
  const [ocrRunning, setOcrRunning] = useState(false)
  const [ocrStatus, setOcrStatus]   = useState('')
  const [ocrPct, setOcrPct]         = useState(0)
  const [ocrResultMsg, setOcrResultMsg] = useState<string | null>(null)

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

  // Sync annotations quand on change de page (réinitialise l'historique annuler/rétablir)
  useEffect(() => {
    if (pageData) {
      setAnnotations((pageData.annotations as Annotation[]) ?? [])
      clearSel()
      historyRef.current = { past: [], future: [] }
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

  // Rendu de la page courante (sauf si la page est « extraite » → page blanche + éléments)
  useLayoutEffect(() => {
    if (!pdfDoc || !canvasRef.current || isExtracted) return
    let cancelled = false

    pdfDoc.getPage(currentPage).then(page => {
      if (cancelled) return
      pageRef.current = page
      // Logical viewport (CSS px) drives the overlay/coordinate space; the canvas
      // backing store is oversampled by the device pixel ratio so text stays crisp
      // at any zoom — like Acrobat's rendering.
      const dpr    = Math.min(window.devicePixelRatio || 1, 3)
      const vp     = page.getViewport({ scale })
      const vpHi   = page.getViewport({ scale: scale * dpr })
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
  }, [pdfDoc, currentPage, scale, isExtracted])

  // Dimensions de page (points) — issues de la page serveur, sinon A4 par défaut.
  const pageW = pageData?.width  ?? 595
  const pageH = pageData?.height ?? 842

  // ── Rendu d'une page VIERGE quand il n'y a pas de binaire PDF ───────────────
  // (document créé sans import → l'API source renvoie 404 ; on dessine alors
  //  une vraie page blanche dimensionnée, au lieu d'un canvas 300×150 résiduel.)
  useLayoutEffect(() => {
    if ((pdfDoc && !isExtracted) || loading || !canvasRef.current) return
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
  }, [pdfDoc, loading, scale, pageW, pageH, currentPage, isExtracted])

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
  }, [])
  const undo = useCallback(() => {
    const h = historyRef.current
    if (!h.past.length) return
    h.future.push(clone(annotationsRef.current))
    setAnnotations(h.past.pop()!); clearSel(); setDirty(true)
  }, [])
  const redo = useCallback(() => {
    const h = historyRef.current
    if (!h.future.length) return
    h.past.push(clone(annotationsRef.current))
    setAnnotations(h.future.pop()!); clearSel(); setDirty(true)
  }, [])

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
    const copy = { ...clone([src])[0], id: crypto.randomUUID() } as Annotation & { x: number; y: number }
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
      const els = await extractPageElements(page, currentPage)
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
      const els = await extractPageElements(page, pnum)
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
          id: crypto.randomUUID(), type: 'image', page: currentPage,
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
      else if (mod && (k === '+' || k === '=')) { e.preventDefault(); zoomBy(1.15) }
      else if (mod && k === '-') { e.preventDefault(); zoomBy(1 / 1.15) }
      else if (mod && k === '0') { e.preventDefault(); fitToPage() }
      else if (e.key === 'Escape') { setEditingTextId(null); setMarquee(null); marqueeStartRef.current = null; clearSel() }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.length) { e.preventDefault(); deleteSelected() }
      else if (e.key === 'ArrowUp')    { e.preventDefault(); nudgeSelected(0, e.shiftKey ? -10 : -1) }
      else if (e.key === 'ArrowDown')  { e.preventDefault(); nudgeSelected(0, e.shiftKey ?  10 :  1) }
      else if (e.key === 'ArrowLeft')  { e.preventDefault(); nudgeSelected(e.shiftKey ? -10 : -1, 0) }
      else if (e.key === 'ArrowRight') { e.preventDefault(); nudgeSelected(e.shiftKey ?  10 :  1, 0) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo, deleteSelected, selectedIds.length, nudgeSelected, zoomBy, fitToPage, clearSel])

  const pxToPoint = (px: number) => px / scale  // canvas px → PDF points

  const totalPages = docData?.page_count ?? pdfDoc?.numPages ?? 1

  // ── Export : aplatir toutes les annotations dans un vrai PDF ────────────────
  const [exporting, setExporting] = useState(false)
  const handleExport = useCallback(async () => {
    if (!id || exporting) return
    setExporting(true)
    try {
      // Persist the current page first so its in-memory annotations are included.
      await pdfWriterApi.savePage(id, currentPage, { annotations: annotationsRef.current })

      // Gather every page's size + annotations (annotations live per-page server-side).
      const pageList: ExportPage[] = (docData?.pages ?? []).map(p => ({
        page_number: p.page_number, width: p.width, height: p.height, rotation: p.rotation,
      }))
      if (pageList.length === 0) pageList.push({ page_number: 1, width: pageW, height: pageH, rotation: 0 })

      const annotationsByPage = new Map<number, Annotation[]>()
      await Promise.all(pageList.map(async p => {
        if (p.page_number === currentPage) { annotationsByPage.set(p.page_number, annotationsRef.current); return }
        try {
          const r = await pdfWriterApi.getPage(id, p.page_number)
          annotationsByPage.set(p.page_number, (r.data.annotations as Annotation[]) ?? [])
        } catch { annotationsByPage.set(p.page_number, []) }
      }))

      // Fetch the source PDF bytes (404 = blank document → pdf-lib builds fresh pages).
      let sourceBytes: ArrayBuffer | null = null
      try {
        const resp = await fetch(pdfWriterApi.sourceUrl(id), { headers: { Authorization: `Bearer ${token}` } })
        if (resp.ok) sourceBytes = await resp.arrayBuffer()
      } catch { /* no source → blank */ }

      const bytes = await buildAnnotatedPdf({ sourceBytes, pages: pageList, annotationsByPage })
      const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${(docData?.title || 'document').replace(/[/\\?%*:|"<>]/g, '-')}.pdf`
      document.body.appendChild(a); a.click(); a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 4000)
    } finally {
      setExporting(false)
    }
  }, [id, exporting, currentPage, docData?.pages, docData?.title, pageW, pageH, token])

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

  const runOcr = useCallback(async (lang: OcrLang) => {
    setOcrMenu(null)
    if (!pdfDoc || ocrRunning) return
    setOcrRunning(true); setOcrResultMsg(null); setOcrPct(0)
    setOcrStatus(t('pdf_ocr_preparing', { defaultValue: 'Préparation de la page…' }))
    try {
      const page = await pdfDoc.getPage(currentPage)
      // Cible ~2000 px de large pour une bonne précision sans exploser la mémoire.
      const ocrScale = Math.min(3, Math.max(1.6, 2000 / (pageData?.width ?? pageW)))
      const vp = page.getViewport({ scale: ocrScale })
      const cv = document.createElement('canvas')
      cv.width = Math.round(vp.width); cv.height = Math.round(vp.height)
      const ctx = cv.getContext('2d')
      if (!ctx) throw new Error('canvas 2d indisponible')
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, cv.width, cv.height)
      await page.render({ canvas: cv, canvasContext: ctx, viewport: vp }).promise
      const res = await recognizeImage(cv, lang, (status, p) => { setOcrStatus(ocrStatusLabel(status)); setOcrPct(Math.round(p * 100)) })
      const now = new Date().toISOString()
      const newAnns: Annotation[] = res.words
        .filter(w => w.confidence >= 30 && w.text.trim().length > 0)
        .map(w => {
          const x = w.x0 / ocrScale, y = w.y0 / ocrScale
          const width = Math.max(4, (w.x1 - w.x0) / ocrScale)
          const height = Math.max(6, (w.y1 - w.y0) / ocrScale)
          return {
            id: crypto.randomUUID(), type: 'text', page: currentPage,
            x, y, width, height,
            content: w.text, fontSize: Math.max(6, +(height * 0.82).toFixed(1)),
            fontFamily: 'sans-serif', color: '#111111', bold: false, italic: false, align: 'left',
            backgroundColor: '#ffffff', createdAt: now,
          } as Annotation
        })
      if (newAnns.length) {
        snapshot()
        setAnnotations(prev => [...prev, ...newAnns])
        setDirty(true)
        setOcrResultMsg(t('pdf_ocr_done', { defaultValue: '{{count}} mot(s) reconnu(s) et insérés comme texte éditable.', count: newAnns.length }))
      } else {
        setOcrResultMsg(t('pdf_ocr_empty', { defaultValue: 'Aucun texte n’a été détecté sur cette page.' }))
      }
    } catch (err) {
      console.error('[OCR]', err)
      setOcrResultMsg(t('pdf_ocr_error', { defaultValue: 'La reconnaissance a échoué. Réessayez.' }))
    } finally {
      setOcrRunning(false)
    }
  }, [pdfDoc, currentPage, pageData, pageW, ocrRunning, snapshot, ocrStatusLabel, t])

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
    ctx.lineWidth = 2
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

    // Outil sélection : saisir l'élément le plus haut sous le curseur (déplacement,
    // éventuellement groupé). Maj-clic = ajouter/retirer de la sélection. Clic dans
    // le vide = rectangle de sélection élastique.
    if (activeTool === 'select') {
      const pt = { x: pxToPoint(x), y: pxToPoint(y) }
      const hit = [...annotations].reverse().find(a => hitTest(a, pt))
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
    const newId = crypto.randomUUID()

    if (activeTool === 'text') {
      addAnnotation({
        id: newId, type: 'text', page: currentPage,
        x: ptX, y: ptY, width: 200, height: 40,
        content: t('pdf_default_text'), fontSize, fontFamily: 'sans-serif',
        color: '#000000', bold: false, italic: false, align: 'left',
        createdAt: new Date().toISOString(),
      })
      setActiveTool('select')
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
        width: 160, height: 40, opacity: 1,
        createdAt: new Date().toISOString(),
      })
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

    // Déplacement (éventuellement groupé) / redimensionnement d'un élément en cours.
    if (elDragRef.current) {
      if (!dragSnappedRef.current) { snapshot(); dragSnappedRef.current = true } // historique
      const { mode, handle, startX, startY, orig } = elDragRef.current
      let dx = pxToPoint(x - startX), dy = pxToPoint(y - startY)
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
      const moved = elDragRef.current.moved
      elDragRef.current = null; dragSnappedRef.current = false; dragOrigRef.current = new Map()
      setGuides({ v: [], h: [] })
      // Drag sans mouvement = simple clic : ne pas créer d'entrée d'historique inutile.
      if (!moved && historyRef.current.past.length) historyRef.current.past.pop()
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
    const newId = crypto.randomUUID()

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
  const renderAnnotations = () => annotations.map(ann => {
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
                    textAlign:  a.align,
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
            strokeWidth={a.strokeWidth}
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
        if (a.type === 'rect') {
          return (
            <rect
              key={ann.id}
              x={px(a.x)} y={px(a.y)} width={px(a.width)} height={px(a.height)}
              fill={a.fillColor || 'none'} fillOpacity={a.fillOpacity || 0}
              stroke={a.strokeColor} strokeWidth={a.strokeWidth}
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
            stroke={a.strokeColor} strokeWidth={a.strokeWidth}
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
        return (
          <g key={ann.id} style={{ filter: sel, cursor: 'pointer' }} onClick={onSelect}>
            {a.type === 'arrow' && (
              <defs>
                <marker id={`arrow-${ann.id}`} markerWidth={10} markerHeight={7} refX={10} refY={3.5} orient="auto">
                  <polygon points="0 0, 10 3.5, 0 7" fill={a.strokeColor} />
                </marker>
              </defs>
            )}
            <line
              x1={x1} y1={y1} x2={x2} y2={y2}
              stroke={a.strokeColor} strokeWidth={a.strokeWidth}
              opacity={a.opacity}
              markerEnd={a.type === 'arrow' ? `url(#arrow-${ann.id})` : undefined}
            />
          </g>
        )
      }

      case 'stamp': {
        const a = ann as import('./api').StampAnnotation
        const s = STAMP_TYPES.find(st => st.key === a.stampType)
        if (!s) return null
        return (
          <g key={ann.id} style={{ filter: sel, cursor: 'pointer', opacity: a.opacity }} onClick={onSelect}>
            <rect
              x={px(a.x)} y={px(a.y)} width={px(a.width)} height={px(a.height)}
              fill="none" stroke={s.color} strokeWidth={2.5} rx={3}
            />
            <text
              x={px(a.x + a.width / 2)} y={px(a.y + a.height / 2) + 5}
              textAnchor="middle" fill={s.color}
              fontSize={14} fontWeight="bold" fontFamily="sans-serif"
              letterSpacing="1"
            >
              {t(s.labelKey)}
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
        // SVG path
        return (
          <g
            key={ann.id}
            transform={`translate(${px(a.x)}, ${px(a.y)})`}
            style={{ filter: sel, cursor: 'pointer' }}
            onClick={onSelect}
          >
            <path d={a.signatureData} fill="none" stroke="#1a1a1a" strokeWidth={1.5} />
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
  })

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
    const pts: Array<[string, number, number]> = [
      ['nw', a.x, a.y], ['n', a.x + a.width / 2, a.y], ['ne', a.x + a.width, a.y],
      ['e', a.x + a.width, a.y + a.height / 2], ['se', a.x + a.width, a.y + a.height],
      ['s', a.x + a.width / 2, a.y + a.height], ['sw', a.x, a.y + a.height], ['w', a.x, a.y + a.height / 2],
    ]
    return (
      <g>
        <rect x={px(a.x)} y={px(a.y)} width={px(a.width)} height={px(a.height)}
          fill="none" stroke="#1a73e8" strokeWidth={1} strokeDasharray="4,2" pointerEvents="none" />
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
    return 'crosshair'
  }, [activeTool, panActive, panning])

  // ── Panel propriétés annotation sélectionnée ──────────────────────────────
  const selectedAnn = annotations.find(a => a.id === selectedId)

  // ── Signature panel ───────────────────────────────────────────────────────
  const sigCanvasRef = useRef<HTMLCanvasElement>(null)
  const [sigDrawing, setSigDrawing] = useState(false)
  const [sigPts, setSigPts] = useState<[number, number][]>([])
  const [sigStrokes, setSigStrokes] = useState<[number, number][][]>([])

  const handleSigMouseDown = (e: React.MouseEvent) => {
    const rect = sigCanvasRef.current!.getBoundingClientRect()
    setSigDrawing(true)
    setSigPts([[e.clientX - rect.left, e.clientY - rect.top]])
  }

  const handleSigMouseMove = (e: React.MouseEvent) => {
    if (!sigDrawing || !sigCanvasRef.current) return
    const rect = sigCanvasRef.current.getBoundingClientRect()
    const pt: [number, number] = [e.clientX - rect.left, e.clientY - rect.top]
    setSigPts(prev => [...prev, pt])
    const ctx = sigCanvasRef.current.getContext('2d')!
    if (sigPts.length > 0) {
      const last = sigPts[sigPts.length - 1]
      ctx.beginPath()
      ctx.moveTo(last[0], last[1])
      ctx.lineTo(pt[0], pt[1])
      ctx.strokeStyle = '#1a1a1a'
      ctx.lineWidth   = 2
      ctx.lineCap     = 'round'
      ctx.stroke()
    }
  }

  const handleSigMouseUp = () => {
    setSigDrawing(false)
    if (sigPts.length > 1) {
      setSigStrokes(prev => [...prev, sigPts])
    }
    setSigPts([])
  }

  const clearSig = () => {
    setSigStrokes([])
    setSigPts([])
    if (sigCanvasRef.current) {
      sigCanvasRef.current.getContext('2d')?.clearRect(0, 0, 360, 120)
    }
  }

  const placeSigMut = useMutation({
    mutationFn: (data: string) => pdfWriterApi.createSignature({ name: t('pdf_signature_name'), sig_type: 'draw', data }),
    onSuccess: (_res, data) => {
      const newId = crypto.randomUUID()
      addAnnotation({
        id: newId, type: 'signature', page: currentPage,
        x: 80, y: 80, width: 160, height: 60,
        signatureData: data,
        createdAt: new Date().toISOString(),
      })
      setShowSigPanel(false)
      clearSig()
      qc.invalidateQueries({ queryKey: ['pdf-signatures'] })
    },
  })

  const placeSig = () => {
    // Convertir le canvas de signature en SVG path
    const allStrokes = [...sigStrokes]
    if (sigPts.length > 1) allStrokes.push(sigPts)
    if (allStrokes.length === 0) return

    const paths = allStrokes.map(pts =>
      pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')
    ).join(' ')

    placeSigMut.mutate(paths)
  }

  const placeSavedSig = (sig: PdfSignature) => {
    const newId = crypto.randomUUID()
    addAnnotation({
      id: newId, type: 'signature', page: currentPage,
      x: 80, y: 80, width: 160, height: 60,
      signatureData: sig.data,
      createdAt: new Date().toISOString(),
    })
    setShowSigPanel(false)
  }

  // ── Miniatures pages ──────────────────────────────────────────────────────
  const ThumbPage = ({ num }: { num: number }) => {
    const cRef = useRef<HTMLCanvasElement>(null)
    useEffect(() => {
      if (!cRef.current) return
      const canvas = cRef.current
      if (pdfDoc) {
        pdfDoc.getPage(num).then(page => {
          const vp = page.getViewport({ scale: 0.18 })
          canvas.width  = vp.width
          canvas.height = vp.height
          page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport: vp })
        })
      } else {
        // Vignette d'une page vierge.
        canvas.width  = Math.round(pageW * 0.12)
        canvas.height = Math.round(pageH * 0.12)
        const ctx = canvas.getContext('2d')!
        ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height)
      }
    }, [num])

    return (
      <div className={`group relative flex flex-col items-center gap-1 p-1.5 rounded transition-all ${
        num === currentPage ? 'bg-[#5a9bdc33] ring-1 ring-primary' : 'hover:bg-[#454545]'}`}>
        <button onClick={() => setCurrentPage(num)} className="flex flex-col items-center gap-1">
          <canvas ref={cRef} className="rounded shadow-sm border border-[#212121] max-w-[80px]" />
          <span className="text-[10px] text-[#8e8e8e]">{num}</span>
        </button>
        {/* Actions au survol : pivoter / supprimer */}
        <div className="absolute top-1 right-1 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <button title={t('pdf_rotate_page')} onClick={() => rotatePageMut.mutate({ n: num, rot: 90 })}
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

            {/* Font size */}
            <div className="px-3 py-2 border-b border-[#212121]">
              <p className="text-[11px] text-[#8e8e8e] mb-1.5">{t('pdf_text_size')}</p>
              <div className="flex items-center gap-2">
                <RangeSlider
                  min={8} max={72} value={fontSize}
                  onChange={setFontSize}
                  className="flex-1" accent="#5a9bdc" trackColor="rgba(255,255,255,0.15)"
                  aria-label={t('pdf_text_size')}
                />
                <span className="text-xs text-[#8e8e8e] w-7 text-right">{fontSize}</span>
              </div>
            </div>

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
                  onClick={() => {
                    pdfWriterApi.rotatePage(id!, currentPage, 90).then(() => {
                      qc.invalidateQueries({ queryKey: ['pdf-page', id, currentPage] })
                    })
                  }}
                  className="flex items-center gap-1.5 px-2 py-1.5 text-xs bg-[#2a2a2a] hover:bg-[#454545] rounded-lg transition-colors"
                >
                  <RotateCw size={12} /> {t('pdf_rotate_90')}
                </button>
              </div>
            </div>

            {/* Annotation sélectionnée */}
            {selectedAnn && (
              <div className="px-3 py-2">
                <p className="text-[11px] text-[#8e8e8e] mb-1.5">{t('pdf_selected_annotation')}</p>
                <p className="text-xs text-[#d6d6d6] mb-1">{t(`pdf_anntype_${selectedAnn.type.replace(/-/g, '_')}`)}</p>
                <button
                  onClick={deleteSelected}
                  className="flex items-center gap-1.5 px-2 py-1.5 text-xs text-[#e84a4a] hover:bg-[#3a1a1a] rounded-lg w-full transition-colors"
                >
                  <Trash2 size={12} /> {t('common_delete')}
                </button>
              </div>
            )}
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
          onClose:  () => navigate('/paintsharp/pdfwriter'),
          onZoomIn:  () => setScale(s => Math.min(4.0, +(s + 0.1).toFixed(1))),
          onZoomOut: () => setScale(s => Math.max(0.3, +(s - 0.1).toFixed(1))),
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

        {/* Navigation de pages */}
        <div className="flex items-center gap-1 bg-[#2a2a2a] rounded-lg px-1">
          <button
            onClick={() => setCurrentPage(n => Math.max(1, n - 1))}
            disabled={currentPage <= 1}
            className="p-1.5 rounded hover:bg-[#454545] text-[#8e8e8e] disabled:opacity-30"
          >
            <ChevronLeft size={14} />
          </button>
          <span className="text-xs text-[#8e8e8e] whitespace-nowrap px-1">
            {currentPage} / {totalPages}
          </span>
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
        <button onClick={undo} title={t('pdf_undo', { defaultValue: 'Annuler (Ctrl+Z)' })}
          className="p-1.5 rounded hover:bg-[#454545] text-[#8e8e8e]"><Undo2 size={16} /></button>
        <button onClick={redo} title={t('pdf_redo', { defaultValue: 'Rétablir (Ctrl+Maj+Z)' })}
          className="p-1.5 rounded hover:bg-[#454545] text-[#8e8e8e]"><Redo2 size={16} /></button>

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
          onClick={(e) => { if (!pdfDoc || ocrRunning) return; const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setOcrMenu({ x: r.left, y: r.bottom + 4 }) }}
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
                    const over = annotations.some(a => hitTest(a, pt))
                    overlayRef.current.style.cursor = over ? 'move' : 'default'
                  }
                }}
                onMouseUp={handleCanvasMouseUp}
                onMouseLeave={(e) => { if (elDragRef.current || marqueeStartRef.current) handleCanvasMouseUp(e) }}
                onDoubleClick={(e) => {
                  const { x, y } = coordsFromEvent(e)
                  const pt = { x: pxToPoint(x), y: pxToPoint(y) }
                  const hit = [...annotations].reverse().find(a => a.type === 'text' && hitTest(a, pt))
                  if (hit) { elDragRef.current = null; selectOnly(hit.id); snapshot(); setEditingTextId(hit.id) }
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  const { x, y } = coordsFromEvent(e)
                  const pt = { x: pxToPoint(x), y: pxToPoint(y) }
                  const hit = [...annotations].reverse().find(a => hitTest(a, pt))
                  if (hit) { selectOnly(hit.id); setCtxMenu({ x: e.clientX, y: e.clientY, id: hit.id }) }
                  else setCtxMenu(null)
                }}
              >
                {renderAnnotations()}
                {renderResizeHandles()}
                {renderShapeDraft()}
                {renderGuides()}
                {renderMarquee()}
              </svg>

              {/* Éditeur de texte en place (double-clic sur un élément texte) */}
              {editingTextId && (() => {
                const a = annotations.find(x => x.id === editingTextId) as import('./api').TextAnnotation | undefined
                if (!a || a.type !== 'text') return null
                return (
                  <textarea
                    autoFocus
                    value={a.content}
                    onChange={(e) => updateAnn(a.id, { content: e.target.value })}
                    onBlur={() => setEditingTextId(null)}
                    onKeyDown={(e) => { if (e.key === 'Escape') setEditingTextId(null) }}
                    className="absolute z-10 resize-none outline outline-2 outline-[#1a73e8] bg-white/95"
                    style={{
                      left: a.x * scale, top: a.y * scale,
                      width: Math.max(60, a.width * scale), height: Math.max(20, a.height * scale),
                      fontSize: a.fontSize, fontFamily: a.fontFamily, color: a.color,
                      fontWeight: a.bold ? 'bold' : 'normal', fontStyle: a.italic ? 'italic' : 'normal',
                      textAlign: a.align, padding: '2px', lineHeight: 1.2,
                    }}
                  />
                )
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
        const items: MenuItem[] = []
        if (a.type === 'text') items.push({ type: 'action', label: t('pdf_ctx_edit_text', { defaultValue: 'Modifier le texte' }), icon: <Type size={14} />, onClick: () => { snapshot(); setEditingTextId(a.id) } })
        items.push(
          { type: 'action', label: t('common_duplicate', { defaultValue: 'Dupliquer' }), icon: <Copy size={14} />, onClick: () => duplicateAnn(a.id) },
          { type: 'separator' },
          { type: 'action', label: t('pdf_ctx_to_front', { defaultValue: 'Mettre au premier plan' }), icon: <ArrowUp size={14} />, onClick: () => reorderAnn(a.id, 'front') },
          { type: 'action', label: t('pdf_ctx_forward', { defaultValue: 'Avancer' }), onClick: () => reorderAnn(a.id, 'forward') },
          { type: 'action', label: t('pdf_ctx_backward', { defaultValue: 'Reculer' }), onClick: () => reorderAnn(a.id, 'backward') },
          { type: 'action', label: t('pdf_ctx_to_back', { defaultValue: 'Mettre à l’arrière-plan' }), icon: <ArrowDown size={14} />, onClick: () => reorderAnn(a.id, 'back') },
          { type: 'separator' },
          { type: 'action', label: t('common_delete', { defaultValue: 'Supprimer' }), icon: <Trash2 size={14} />, onClick: () => deleteSelected() },
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

      {/* ── Menu de langue OCR ── */}
      {ocrMenu && (() => {
        const items: MenuItem[] = [
          { type: 'action', label: t('pdf_ocr_lang_fra_eng', { defaultValue: 'Français + Anglais' }), onClick: () => runOcr('fra+eng') },
          { type: 'action', label: t('pdf_ocr_lang_fra', { defaultValue: 'Français' }), onClick: () => runOcr('fra') },
          { type: 'action', label: t('pdf_ocr_lang_eng', { defaultValue: 'Anglais' }), onClick: () => runOcr('eng') },
        ]
        return <MenuDropdown items={items} pos={{ top: ocrMenu.y, left: ocrMenu.x }} onClose={() => setOcrMenu(null)} />
      })()}

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
          </div>
        </div>
      )}

      {/* ── Panel signature ── */}
      {showSigPanel && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 no-print"
          onClick={() => setShowSigPanel(false)}
        >
          <div
            className="bg-[#323232] rounded-2xl shadow-2xl p-5 w-[440px]"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-semibold text-[#d6d6d6]">{t('pdf_add_signature')}</h3>
              <button onClick={() => setShowSigPanel(false)} className="text-[#8e8e8e] hover:text-[#d6d6d6]">
                <X size={18} />
              </button>
            </div>

            {/* Signatures sauvegardées */}
            {sigsData && sigsData.length > 0 && (
              <div className="mb-4">
                <p className="text-xs text-[#8e8e8e] mb-2">{t('pdf_saved_signatures')}</p>
                <div className="flex flex-wrap gap-2">
                  {sigsData.map(sig => (
                    <button
                      key={sig.id}
                      onClick={() => placeSavedSig(sig)}
                      className="px-3 py-1.5 border border-[#212121] rounded-lg hover:bg-[#454545] text-sm transition-colors"
                    >
                      {sig.name}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Dessiner une nouvelle signature */}
            <p className="text-xs text-[#8e8e8e] mb-2">{t('pdf_draw_new_signature')}</p>
            <canvas
              ref={sigCanvasRef}
              width={360}
              height={120}
              className="block w-full rounded-xl border-2 border-[#212121]"
              style={{ touchAction: 'none', cursor: 'crosshair', background: '#fafafa' }}
              onMouseDown={handleSigMouseDown}
              onMouseMove={handleSigMouseMove}
              onMouseUp={handleSigMouseUp}
              onMouseLeave={handleSigMouseUp}
            />
            <div className="flex items-center justify-between mt-3">
              <button
                onClick={clearSig}
                className="text-xs text-[#8e8e8e] hover:text-[#d6d6d6] transition-colors"
              >
                {t('pdf_clear')}
              </button>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setShowSigPanel(false)}
                >
                  {t('common_cancel')}
                </Button>
                <Button
                  size="sm"
                  onClick={placeSig}
                  disabled={sigStrokes.length === 0 && sigPts.length < 2}
                >
                  {t('pdf_place_signature')}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {confirmState && (
        <ConfirmDialog {...confirmState} onConfirm={handleConfirm} onCancel={handleCancel} />
      )}
    </>
  )
}