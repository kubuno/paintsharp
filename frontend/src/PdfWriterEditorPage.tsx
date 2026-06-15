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
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { pdfWriterApi, type Annotation, type PdfSignature } from './api'
import { extractPageElements } from './pdfExtract'
import { useAuthStore } from '@kubuno/sdk'
import { useConfirm } from '@kubuno/sdk'
import { ConfirmDialog } from '@ui'
import { Button, MenuDropdown, type MenuItem } from '@ui'
import { C, EditorShell, DockArea, ColorField, paintsharpMenus } from './ui'
import { useDebouncedAutosave } from './useAutosave'

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
  const [selectedId, setSelectedId]     = useState<string | null>(null)
  // Édition de texte en place (double-clic) + déplacement/redimensionnement d'éléments.
  const [editingTextId, setEditingTextId] = useState<string | null>(null)
  const [converting, setConverting]     = useState(false)
  const elDragRef = useRef<{ id: string; mode: 'move' | 'resize'; handle?: string; startX: number; startY: number; orig: { x: number; y: number; width: number; height: number } } | null>(null)
  const dragSnappedRef = useRef(false) // historique : snapshot une fois au 1er mouvement
  const imgInputRef = useRef<HTMLInputElement>(null)
  // Menu contextuel (clic droit) sur un objet — rendu via MenuDropdown de @ui.
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; id: string } | null>(null)

  // Outil en cours de tracé (freehand)
  const [drawing, setDrawing]           = useState(false)
  const [freehandPts, setFreehandPts]   = useState<[number, number][]>([])

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
      setSelectedId(null)
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
      const vp     = page.getViewport({ scale })
      const canvas = canvasRef.current!
      canvas.width  = vp.width
      canvas.height = vp.height
      const ctx    = canvas.getContext('2d')!
      page.render({ canvas, canvasContext: ctx, viewport: vp })

      // Synchroniser les dimensions des overlays
      if (overlayRef.current) {
        overlayRef.current.setAttribute('width',  String(vp.width))
        overlayRef.current.setAttribute('height', String(vp.height))
        overlayRef.current.setAttribute('viewBox', `0 0 ${vp.width} ${vp.height}`)
      }
      if (drawCanvasRef.current) {
        drawCanvasRef.current.width  = vp.width
        drawCanvasRef.current.height = vp.height
      }
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
    const w = Math.max(1, Math.round(pageW * scale))
    const h = Math.max(1, Math.round(pageH * scale))
    const canvas = canvasRef.current
    canvas.width = w; canvas.height = h
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, w, h)
    if (overlayRef.current) {
      overlayRef.current.setAttribute('width',  String(w))
      overlayRef.current.setAttribute('height', String(h))
      overlayRef.current.setAttribute('viewBox', `0 0 ${w} ${h}`)
    }
    if (drawCanvasRef.current) { drawCanvasRef.current.width = w; drawCanvasRef.current.height = h }
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
    setAnnotations(h.past.pop()!); setSelectedId(null); setDirty(true)
  }, [])
  const redo = useCallback(() => {
    const h = historyRef.current
    if (!h.future.length) return
    h.past.push(clone(annotationsRef.current))
    setAnnotations(h.future.pop()!); setSelectedId(null); setDirty(true)
  }, [])

  const addAnnotation = useCallback((ann: Annotation) => {
    snapshot()
    setAnnotations(prev => [...prev, ann])
    setDirty(true)
    setSelectedId(ann.id)
  }, [snapshot])

  const deleteSelected = useCallback(() => {
    if (!selectedId) return
    snapshot()
    setAnnotations(prev => prev.filter(a => a.id !== selectedId))
    setSelectedId(null)
    setDirty(true)
  }, [selectedId, snapshot])

  // Met à jour un élément (déplacement / redimensionnement / édition de contenu).
  const updateAnn = useCallback((aid: string, patch: Record<string, unknown>) => {
    setAnnotations(prev => prev.map(a => a.id === aid ? { ...a, ...patch } as Annotation : a))
    setDirty(true)
  }, [])

  // Dupliquer un élément (décalé) + ordre d'empilement (z) via l'ordre du tableau.
  const duplicateAnn = useCallback((aid: string) => {
    const src = annotationsRef.current.find(a => a.id === aid)
    if (!src) return
    snapshot()
    const copy = { ...clone([src])[0], id: crypto.randomUUID() } as Annotation & { x: number; y: number }
    copy.x += 12; copy.y += 12
    setAnnotations(prev => [...prev, copy]); setSelectedId(copy.id); setDirty(true)
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
      setSelectedId(null)
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
      setAnnotations(els); setSelectedId(null)
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

  // Raccourcis clavier : Ctrl+Z annuler, Ctrl+Maj+Z / Ctrl+Y rétablir, Suppr supprimer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea') return
      const k = e.key.toLowerCase()
      if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo() }
      else if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); redo() }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) { e.preventDefault(); deleteSelected() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo, deleteSelected, selectedId])

  const pxToPoint = (px: number) => px / scale  // canvas px → PDF points

  const totalPages = docData?.page_count ?? pdfDoc?.numPages ?? 1

  // ── Interactions canvas ───────────────────────────────────────────────────

  const handleCanvasMouseDown = (e: React.MouseEvent) => {
    const { x, y } = coordsFromEvent(e)

    // Outil sélection : on saisit l'élément le plus haut sous le curseur pour le
    // déplacer (les poignées de redimensionnement interceptent déjà leur mousedown).
    if (activeTool === 'select') {
      const pt = { x: pxToPoint(x), y: pxToPoint(y) }
      const hit = [...annotations].reverse().find(a => hitTest(a, pt))
      if (hit) {
        const a = hit as unknown as { x: number; y: number; width?: number; height?: number }
        setSelectedId(hit.id)
        elDragRef.current = { id: hit.id, mode: 'move', startX: x, startY: y, orig: { x: a.x, y: a.y, width: a.width ?? 0, height: a.height ?? 0 } }
      } else {
        setSelectedId(null)
      }
      return
    }

    if (activeTool === 'freehand') {
      setDrawing(true)
      setFreehandPts([[pxToPoint(x), pxToPoint(y)]])
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

    // Déplacement / redimensionnement d'un élément en cours.
    if (elDragRef.current) {
      if (!dragSnappedRef.current) { snapshot(); dragSnappedRef.current = true } // historique
      const { id: eid, mode, handle, startX, startY, orig } = elDragRef.current
      const dx = pxToPoint(x - startX), dy = pxToPoint(y - startY)
      if (mode === 'move') {
        updateAnn(eid, { x: orig.x + dx, y: orig.y + dy })
      } else {
        const h = handle ?? ''
        let nx = orig.x, ny = orig.y, nw = orig.width, nh = orig.height
        if (h.includes('e')) nw = Math.max(8, orig.width + dx)
        if (h.includes('s')) nh = Math.max(8, orig.height + dy)
        if (h.includes('w')) { nx = orig.x + dx; nw = Math.max(8, orig.width - dx) }
        if (h.includes('n')) { ny = orig.y + dy; nh = Math.max(8, orig.height - dy) }
        updateAnn(eid, { x: nx, y: ny, width: nw, height: nh })
      }
      return
    }

    if (drawing && activeTool === 'freehand') {
      setFreehandPts(prev => [...prev, [ptX, ptY]])
      // Dessin temps réel sur le canvas de tracé
      const dc = drawCanvasRef.current
      if (dc) {
        const ctx = dc.getContext('2d')!
        const pts = [...freehandPts, [ptX, ptY]] as [number, number][]
        if (pts.length >= 2) {
          const last = pts[pts.length - 2]
          ctx.beginPath()
          ctx.moveTo(last[0] * scale, last[1] * scale)
          ctx.lineTo(ptX * scale, ptY * scale)
          ctx.strokeStyle = selectedColor
          ctx.lineWidth   = 2
          ctx.lineCap     = 'round'
          ctx.stroke()
        }
      }
      return
    }

    if (shapeStart && ['rect', 'ellipse', 'line', 'arrow', 'highlight', 'underline', 'strikethrough'].includes(activeTool)) {
      setShapeDraft({
        x: Math.min(shapeStart.x, ptX),
        y: Math.min(shapeStart.y, ptY),
        w: Math.abs(ptX - shapeStart.x),
        h: Math.abs(ptY - shapeStart.y),
      })
    }
  }

  const handleCanvasMouseUp = (e: React.MouseEvent) => {
    if (elDragRef.current) { elDragRef.current = null; dragSnappedRef.current = false; return }
    const { x, y } = coordsFromEvent(e)
    const ptX = pxToPoint(x), ptY = pxToPoint(y)
    const newId = crypto.randomUUID()

    if (drawing && activeTool === 'freehand') {
      setDrawing(false)
      const pts = [...freehandPts, [ptX, ptY]] as [number, number][]
      if (pts.length > 2) {
        addAnnotation({
          id: newId, type: 'freehand', page: currentPage,
          x: 0, y: 0,
          points: pts,
          color: selectedColor, strokeWidth: 2, opacity: 1,
          createdAt: new Date().toISOString(),
        })
      }
      setFreehandPts([])
      // Effacer le canvas de tracé
      const dc = drawCanvasRef.current
      if (dc) dc.getContext('2d')?.clearRect(0, 0, dc.width, dc.height)
      return
    }

    if (shapeStart && shapeDraft && shapeDraft.w > 3 && shapeDraft.h > 3) {
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

  const renderAnnotations = () => annotations.map(ann => {
    const isSelected = ann.id === selectedId
    const sel = isSelected ? 'drop-shadow(0 0 3px #1a73e8)' : undefined

    const onSelect = (e: React.MouseEvent) => {
      if (activeTool === 'select') { e.stopPropagation(); setSelectedId(ann.id) }
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

  // ── Poignées de redimensionnement de l'élément sélectionné ──────────────────
  const renderResizeHandles = () => {
    if (activeTool !== 'select' || !selectedId) return null
    const a = annotations.find(x => x.id === selectedId) as unknown as { x: number; y: number; width?: number; height?: number } | undefined
    if (!a || a.width == null || a.height == null) return null
    const px = (n: number) => n * scale
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

  // ── Outil cursor ──────────────────────────────────────────────────────────
  const canvasCursor = useMemo(() => {
    if (activeTool === 'select')      return 'default'
    if (activeTool === 'text')        return 'text'
    if (activeTool === 'freehand')    return 'crosshair'
    return 'crosshair'
  }, [activeTool])

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

            {/* Taille police */}
            <div className="px-3 py-2 border-b border-[#212121]">
              <p className="text-[11px] text-[#8e8e8e] mb-1.5">{t('pdf_text_size')}</p>
              <div className="flex items-center gap-2">
                <input
                  type="range" min={8} max={72} value={fontSize}
                  onChange={e => setFontSize(Number(e.target.value))}
                  className="flex-1 h-1 accent-[#5a9bdc]"
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
          onExport: () => window.open(pdfWriterApi.sourceUrl(id!), '_blank'), exportLabel: t('common_export'),
          onClose:  () => navigate('/paintsharp/pdfwriter'),
          onZoomIn:  () => setScale(s => Math.min(4.0, +(s + 0.1).toFixed(1))),
          onZoomOut: () => setScale(s => Math.max(0.3, +(s - 0.1).toFixed(1))),
        })}
        topbarActions={<>
        <div className="flex items-center gap-1 bg-[#2a2a2a] rounded-lg px-1">
          <button onClick={() => setScale(s => Math.max(0.3, +(s - 0.1).toFixed(1)))}
                  className="p-1.5 rounded hover:bg-[#454545] text-[#8e8e8e]">
            <ZoomOut size={14} />
          </button>
          <span className="text-xs text-[#8e8e8e] w-12 text-center">
            {Math.round(scale * 100)}%
          </span>
          <button onClick={() => setScale(s => Math.min(4.0, +(s + 0.1).toFixed(1)))}
                  className="p-1.5 rounded hover:bg-[#454545] text-[#8e8e8e]">
            <ZoomIn size={14} />
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

        {/* Télécharger la source */}
        <a
          href={pdfWriterApi.sourceUrl(id!)}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-[#212121] rounded-lg
                     hover:bg-[#454545] text-[#8e8e8e] transition-colors"
        >
          <Download size={14} />
          {t('common_export')}
        </a>

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
                  onClick={() => { setActiveTool(tool); action?.() }}
                  className={`w-9 h-9 flex items-center justify-center rounded-lg transition-colors ${
                    activeTool === tool
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
        <div className="w-full h-full overflow-auto flex items-start justify-center py-6 px-6" style={{ background: '#e5e5e5' }}>
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
                style={{ cursor: canvasCursor, overflow: 'visible' }}
                onMouseDown={handleCanvasMouseDown}
                onMouseMove={handleCanvasMouseMove}
                onMouseUp={handleCanvasMouseUp}
                onDoubleClick={(e) => {
                  const { x, y } = coordsFromEvent(e)
                  const pt = { x: pxToPoint(x), y: pxToPoint(y) }
                  const hit = [...annotations].reverse().find(a => a.type === 'text' && hitTest(a, pt))
                  if (hit) { elDragRef.current = null; setSelectedId(hit.id); snapshot(); setEditingTextId(hit.id) }
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  const { x, y } = coordsFromEvent(e)
                  const pt = { x: pxToPoint(x), y: pxToPoint(y) }
                  const hit = [...annotations].reverse().find(a => hitTest(a, pt))
                  if (hit) { setSelectedId(hit.id); setCtxMenu({ x: e.clientX, y: e.clientY, id: hit.id }) }
                  else setCtxMenu(null)
                }}
              >
                {renderAnnotations()}
                {renderResizeHandles()}
                {renderShapeDraft()}
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
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
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