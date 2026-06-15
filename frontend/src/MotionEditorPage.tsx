import { useState, useRef, useEffect, useCallback, memo } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams, useNavigate } from 'react-router-dom'
import { useDebouncedAutosave } from './useAutosave'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Play, Pause, SkipBack, SkipForward, ChevronLeft,
  Film, Volume2, VolumeX, Plus, Trash2,
  Download, Upload, ZoomIn, ZoomOut,
  ChevronDown, ChevronRight, Lock, Eye, Scissors, Wand2,
} from 'lucide-react'
import {
  motionApi,
  type VideoProject, type VideoMedia, type VideoTrack, type VideoClip, type TimelineData,
} from './api'
import { api } from '@kubuno/sdk'
import { useFilesDialogStore } from '@kubuno/drive'
import { Button } from '@ui'
import { C as SHELL_C, EditorShell, DockArea, paintsharpMenus, useContextMenu, type CtxItem } from './ui'

const C = SHELL_C   // shared Paintsharp palette for the editor chrome

// ── Utilities ─────────────────────────────────────────────────────────────────

function frameToTime(frame: number, fps: number): string {
  const secs  = Math.floor(frame / fps)
  const frs   = frame % fps
  const m     = Math.floor(secs / 60)
  const s     = secs % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(frs).padStart(2, '0')}`
}

// ── Video Preview Engine ──────────────────────────────────────────────────────

interface FrameDecoder {
  seekToFrame(frame: number, fps: number): Promise<void>
  getVideoElement(): HTMLVideoElement | null
}

class VideoElementDecoder implements FrameDecoder {
  private video: HTMLVideoElement

  constructor(src: string) {
    this.video = document.createElement('video')
    this.video.src = src
    this.video.preload = 'auto'
    this.video.crossOrigin = 'anonymous'
  }

  async seekToFrame(frame: number, fps: number) {
    const time = frame / fps
    if (Math.abs(this.video.currentTime - time) < 1 / fps) return
    this.video.currentTime = time
    await new Promise<void>((resolve) => {
      const handler = () => { this.video.removeEventListener('seeked', handler); resolve() }
      this.video.addEventListener('seeked', handler)
    })
  }

  getVideoElement() { return this.video }
}

// ── Track colors ──────────────────────────────────────────────────────────────

const TRACK_COLORS: Record<string, string> = {
  video:    '#3b82f6',
  audio:    '#22c55e',
  fx:       '#a855f7',
  subtitle: '#f59e0b',
}

// ── Effets (basés sur les filtres canvas, appliqués au moniteur programme) ──────
const EFFECT_DEFS: Record<string, { css: (v: number) => string; def: number; min: number; max: number; step: number; labelKey: string }> = {
  brightness: { css: v => `brightness(${v})`,    def: 1,  min: 0, max: 3,   step: 0.05, labelKey: 'motion_fx_brightness' },
  contrast:   { css: v => `contrast(${v})`,      def: 1,  min: 0, max: 3,   step: 0.05, labelKey: 'motion_fx_contrast' },
  saturate:   { css: v => `saturate(${v})`,      def: 1,  min: 0, max: 3,   step: 0.05, labelKey: 'motion_fx_saturate' },
  grayscale:  { css: v => `grayscale(${v})`,     def: 1,  min: 0, max: 1,   step: 0.05, labelKey: 'motion_fx_grayscale' },
  sepia:      { css: v => `sepia(${v})`,         def: 1,  min: 0, max: 1,   step: 0.05, labelKey: 'motion_fx_sepia' },
  blur:       { css: v => `blur(${v}px)`,        def: 4,  min: 0, max: 20,  step: 0.5,  labelKey: 'motion_fx_blur' },
  hue:        { css: v => `hue-rotate(${v}deg)`, def: 90, min: 0, max: 360, step: 5,    labelKey: 'motion_fx_hue' },
}
function clipFilterString(clip: VideoClip): string {
  return (clip.effects ?? [])
    .map(e => { const d = EFFECT_DEFS[e.type]; return d ? d.css(Number((e.params as { value?: number })?.value ?? d.def)) : '' })
    .filter(Boolean)
    .join(' ')
}

// ── Clip Block Component ──────────────────────────────────────────────────────

const ClipBlock = memo(function ClipBlock({
  clip, track, media, pxPerFrame, selected, onSelect, onDelete, onClipMouseDown, onClipContextMenu,
}: {
  clip:       VideoClip
  track:      VideoTrack
  media:      VideoMedia[]
  pxPerFrame: number
  selected:   boolean
  onSelect:   () => void
  onDelete:   () => void
  onClipMouseDown: (e: React.MouseEvent, clip: VideoClip, mode: 'move' | 'trim-l' | 'trim-r') => void
  onClipContextMenu: (e: React.MouseEvent, clip: VideoClip) => void
}) {
  const mediaItem = media.find(m => m.id === clip.mediaId)
  const color     = TRACK_COLORS[track.type] ?? '#6b7280'
  const width     = (clip.endFrame - clip.startFrame) * pxPerFrame
  const left      = clip.startFrame * pxPerFrame

  return (
    <div
      className="absolute top-1 bottom-1 rounded select-none overflow-hidden border transition-all"
      style={{
        left,
        width: Math.max(width, 4),
        background: color + (selected ? 'ee' : '88'),
        borderColor: selected ? color : color + '44',
        boxShadow: selected ? `0 0 0 2px ${color}` : 'none',
        cursor: 'grab',
      }}
      onMouseDown={(e) => { onSelect(); onClipMouseDown(e, clip, 'move') }}
      onContextMenu={(e) => { onSelect(); onClipContextMenu(e, clip) }}
    >
      <div className="flex items-center h-full px-2 gap-1 pointer-events-none">
        <span className="text-[10px] text-white font-medium truncate">
          {mediaItem?.original_name ?? clip.id.slice(0, 8)}
        </span>
      </div>
      {/* Poignées de rognage (trim) */}
      <div onMouseDown={(e) => { e.stopPropagation(); onSelect(); onClipMouseDown(e, clip, 'trim-l') }}
           className="absolute left-0 top-0 bottom-0 w-1.5" style={{ cursor: 'ew-resize', background: '#ffffff33' }} />
      <div onMouseDown={(e) => { e.stopPropagation(); onSelect(); onClipMouseDown(e, clip, 'trim-r') }}
           className="absolute right-0 top-0 bottom-0 w-1.5" style={{ cursor: 'ew-resize', background: '#ffffff33' }} />
      {selected && (
        <button
          className="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 rounded bg-white/20 hover:bg-white/40 transition-colors"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); onDelete() }}
        >
          <Trash2 size={10} className="text-white" />
        </button>
      )}
    </div>
  )
})

// ── Timeline Ruler ────────────────────────────────────────────────────────────

function TimelineRuler({ fps, totalFrames, pxPerFrame, scrollLeft }: {
  fps:        number
  totalFrames: number
  pxPerFrame: number
  scrollLeft: number
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const w   = canvas.offsetWidth
    const h   = canvas.offsetHeight
    canvas.width  = w * dpr
    canvas.height = h * dpr
    ctx.scale(dpr, dpr)

    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = '#1a1a1a'
    ctx.fillRect(0, 0, w, h)

    // Determine tick interval (try to show ~1 tick per 80px)
    const secInterval = Math.ceil(80 / (pxPerFrame * fps))
    const frameInterval = secInterval * fps

    ctx.fillStyle = '#9ca3af'
    ctx.font = '9px monospace'
    ctx.textAlign = 'center'

    const startFrame = Math.floor(scrollLeft / pxPerFrame)
    const endFrame   = Math.min(totalFrames, startFrame + Math.ceil(w / pxPerFrame) + frameInterval)

    for (let f = Math.floor(startFrame / frameInterval) * frameInterval; f <= endFrame; f += frameInterval) {
      const x = f * pxPerFrame - scrollLeft
      if (x < -10 || x > w + 10) continue

      ctx.strokeStyle = '#4b5563'
      ctx.lineWidth   = 1
      ctx.beginPath()
      ctx.moveTo(x, h - 8)
      ctx.lineTo(x, h)
      ctx.stroke()

      const label = frameToTime(f, fps)
      ctx.fillText(label, x, h - 10)
    }
  }, [fps, totalFrames, pxPerFrame, scrollLeft])

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-full"
      style={{ display: 'block' }}
    />
  )
}

// ── Track Row ─────────────────────────────────────────────────────────────────

function TrackRow({
  track, media, pxPerFrame, currentFrame, scrollLeft, onDeleteClip,
  selectedClipId, onSelectClip, onClipMouseDown, onClipContextMenu,
}: {
  track:          VideoTrack
  media:          VideoMedia[]
  pxPerFrame:     number
  currentFrame:   number
  scrollLeft:     number
  onDeleteClip:   (trackId: string, clipId: string) => void
  onClipMouseDown: (e: React.MouseEvent, clip: VideoClip, mode: 'move' | 'trim-l' | 'trim-r') => void
  onClipContextMenu: (e: React.MouseEvent, clip: VideoClip) => void
  selectedClipId: string | null
  onSelectClip:   (clipId: string | null) => void
}) {
  const [expanded, setExpanded] = useState(true)
  const trackH = expanded ? track.height || 48 : 28

  return (
    <div className="flex border-b border-border/30" style={{ height: trackH }}>
      {/* Track header */}
      <div className="w-48 flex-shrink-0 flex items-center gap-1 px-2 bg-surface-1 border-r border-border/30">
        <button onClick={() => setExpanded(v => !v)} className="text-text-tertiary hover:text-text-primary">
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: TRACK_COLORS[track.type] ?? '#6b7280' }} />
        <span className="text-xs text-text-primary truncate flex-1">{track.name}</span>
        <div className="flex items-center gap-0.5 ml-1">
          {track.type === 'audio' && (
            <button className="p-0.5 hover:bg-surface-2 rounded text-text-tertiary hover:text-text-primary">
              {track.muted ? <VolumeX size={11} /> : <Volume2 size={11} />}
            </button>
          )}
          <button className="p-0.5 hover:bg-surface-2 rounded text-text-tertiary hover:text-text-primary">
            {track.locked ? <Lock size={11} /> : <Eye size={11} />}
          </button>
        </div>
      </div>

      {/* Clips area */}
      {expanded && (
        <div
          className="flex-1 relative overflow-hidden"
          style={{ background: '#111' }}
        >
          <div
            className="absolute inset-0"
            style={{ transform: `translateX(${-scrollLeft}px)` }}
          >
            {track.clips.map((clip) => (
              <ClipBlock
                key={clip.id}
                clip={clip}
                track={track}
                media={media}
                pxPerFrame={pxPerFrame}
                selected={selectedClipId === clip.id}
                onSelect={() => onSelectClip(clip.id)}
                onDelete={() => onDeleteClip(track.id, clip.id)}
                onClipMouseDown={onClipMouseDown}
                onClipContextMenu={onClipContextMenu}
              />
            ))}
          </div>
          {/* Playhead line */}
          <div
            className="absolute top-0 bottom-0 w-px pointer-events-none z-10"
            style={{
              left: currentFrame * pxPerFrame - scrollLeft,
              background: '#ef4444',
            }}
          />
        </div>
      )}
    </div>
  )
}

// ── Export Modal ──────────────────────────────────────────────────────────────

function ExportModal({ project, onClose }: { project: VideoProject; onClose: () => void }) {
  const { t } = useTranslation('paintsharp')
  const [isExporting, setIsExporting] = useState(false)
  const [jobStatus, setJobStatus] = useState<string | null>(null)
  const qc = useQueryClient()

  const exportMut = useMutation({
    mutationFn: () => motionApi.createRenderJob(project.id, project.render_settings),
    onSuccess: (res) => {
      setJobStatus(t('motion_job_created', { id: res.data.job_id }))
      setIsExporting(false)
      qc.invalidateQueries({ queryKey: ['motion-render-jobs', project.id] })
    },
    onError: () => {
      setJobStatus(t('motion_render_error'))
      setIsExporting(false)
    },
  })

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="bg-surface-0 rounded-xl border border-border shadow-xl w-96 p-6"
           onClick={(e) => e.stopPropagation()}>
        <h2 className="text-base font-semibold text-text-primary mb-4">{t('motion_export_title')}</h2>

        <div className="space-y-3 mb-6">
          <div>
            <p className="text-xs text-text-secondary mb-1">{t('motion_export_format')}</p>
            <p className="text-sm text-text-primary font-medium">
              {project.render_settings.codec.toUpperCase()} / {project.render_settings.container.toUpperCase()}
            </p>
          </div>
          <div>
            <p className="text-xs text-text-secondary mb-1">{t('motion_export_resolution')}</p>
            <p className="text-sm text-text-primary font-medium">
              {project.composition.width}×{project.composition.height} @ {project.composition.fps} fps
            </p>
          </div>
          <div>
            <p className="text-xs text-text-secondary mb-1">{t('motion_export_duration')}</p>
            <p className="text-sm text-text-primary font-medium">
              {frameToTime(project.composition.duration_frames, project.composition.fps)}
            </p>
          </div>
        </div>

        {jobStatus && (
          <div className="mb-4 p-3 rounded-lg bg-surface-2 text-sm text-text-secondary">
            {jobStatus}
          </div>
        )}

        <div className="flex gap-3 justify-end">
          <Button variant="ghost" onClick={onClose}>{t('common_cancel')}</Button>
          <Button icon={<Download size={14} />} onClick={() => { setIsExporting(true); exportMut.mutate(undefined) }} loading={isExporting || exportMut.isPending}>
            {t('motion_export_start')}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ── Main Editor ───────────────────────────────────────────────────────────────

export default function MotionEditorPage() {
  const { t } = useTranslation('paintsharp')
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const qc       = useQueryClient()

  const [isPlaying,     setIsPlaying]     = useState(false)
  const [currentFrame,  setCurrentFrame]  = useState(0)
  const [pxPerFrame,    setPxPerFrame]    = useState(2)
  const [scrollLeft,    setScrollLeft]    = useState(0)
  const [selectedClip,  setSelectedClip]  = useState<string | null>(null)
  const [showExport,    setShowExport]    = useState(false)
  const [isSaving,      setIsSaving]      = useState(false)
  // Zoom / panoramique du moniteur programme (façon Layer).
  const [viewZoom, setViewZoom] = useState(1)
  const [viewPan,  setViewPan]  = useState({ x: 0, y: 0 })
  const zoomRef = useRef(1)
  const previewWrapRef = useRef<HTMLDivElement>(null)
  const panDragRef = useRef<{ x: number; y: number; px: number; py: number } | null>(null)

  const previewCanvasRef = useRef<HTMLCanvasElement>(null)
  const timelineRef      = useRef<HTMLDivElement>(null)
  const rafRef           = useRef<number | undefined>(undefined)
  const lastTimeRef      = useRef<number>(0)
  const decodersRef      = useRef<Map<string, FrameDecoder>>(new Map())
  // Refs « vivantes » → pilotage lecture/rendu sans closures périmées.
  const frameRef    = useRef(0)
  const tlDataRef   = useRef<TimelineData | null>(null)
  const mediaRef    = useRef<VideoMedia[] | undefined>(undefined)
  const projectRef  = useRef<VideoProject | undefined>(undefined)

  const { data: project, isLoading } = useQuery({
    queryKey: ['motion-project', id],
    queryFn:  () => motionApi.getProject(id!).then(r => r.data),
    enabled:  !!id,
  })

  // ── Titre éditable (standard WorkspaceShell) — synchronisé depuis le projet ────
  // NB : les projets vidéo n'ont pas de champ `is_starred` (modèle/API sans favoris)
  // → pas d'étoile pour Motion (contrairement à Layer/Apex/Vertex).
  const [titleDraft, setTitleDraft] = useState('')
  useEffect(() => { if (project?.title != null) setTitleDraft(project.title) }, [project?.title])
  const renameMut = useMutation({
    mutationFn: (title: string) => motionApi.updateProject(id!, { title }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['motion-project', id] }) },
  })
  const trashMut = useMutation({
    mutationFn: () => motionApi.trashProject(id!),
    onSuccess: () => { navigate('/paintsharp/motion') },
  })
  const commitTitle = () => {
    const v = titleDraft.trim()
    if (v && v !== project?.title) renameMut.mutate(v)
    else if (!v && project?.title) setTitleDraft(project.title)
  }

  const { data: media } = useQuery({
    queryKey: ['motion-media', id],
    queryFn:  () => motionApi.listMedia(id!).then(r => r.data.media),
    enabled:  !!id,
  })

  const [timeline, setTimeline] = useState<TimelineData | null>(null)

  useEffect(() => {
    if (project && !timeline) {
      setTimeline(project.timeline_data)
    }
  }, [project, timeline])

  // Maintien des refs vivantes pour la boucle de lecture.
  useEffect(() => { frameRef.current = currentFrame }, [currentFrame])
  useEffect(() => { tlDataRef.current = timeline }, [timeline])
  useEffect(() => { mediaRef.current = media }, [media])
  useEffect(() => { projectRef.current = project }, [project])
  useEffect(() => { zoomRef.current = viewZoom }, [viewZoom])

  // Zoom centré curseur + panoramique du moniteur.
  const resetView = useCallback(() => { setViewZoom(1); setViewPan({ x: 0, y: 0 }) }, [])
  const zoomAt = useCallback((factor: number, clientX?: number, clientY?: number) => {
    const cont = previewWrapRef.current; if (!cont) return
    const r = cont.getBoundingClientRect()
    const cx = clientX ?? r.left + r.width / 2, cy = clientY ?? r.top + r.height / 2
    const nz = Math.max(0.2, Math.min(8, zoomRef.current * factor)); const k = nz / zoomRef.current
    setViewZoom(nz)
    setViewPan(p => ({ x: k * p.x + (1 - k) * (cx - (r.left + r.width / 2)), y: k * p.y + (1 - k) * (cy - (r.top + r.height / 2)) }))
  }, [])
  useEffect(() => {
    const cont = previewWrapRef.current; if (!cont) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      if (e.ctrlKey || e.metaKey) zoomAt(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX, e.clientY)
      else setViewPan(p => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }))
    }
    cont.addEventListener('wheel', onWheel, { passive: false })
    return () => cont.removeEventListener('wheel', onWheel)
  }, [zoomAt])

  const saveTimelineMut = useMutation({
    mutationFn: (data: TimelineData) => motionApi.saveTimeline(id!, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['motion-project', id] })
      setIsSaving(false)
    },
  })

  // Sauvegarde automatique (debounce + flush au démontage/fermeture).
  useDebouncedAutosave(timeline, !!id && !!timeline, (d) => { if (d) saveTimelineMut.mutate(d) })

  const handleSave = useCallback(() => {
    if (!timeline) return
    setIsSaving(true)
    saveTimelineMut.mutate(timeline)
  }, [timeline, saveTimelineMut])

  // Élément <video> (lecture + audio) pour un média donné.
  const decoderFor = useCallback((mediaId: string): HTMLVideoElement | null => {
    const project = projectRef.current; if (!project) return null
    let d = decodersRef.current.get(mediaId)
    if (!d) { d = new VideoElementDecoder(motionApi.getMediaStreamUrl(project.id, mediaId)); decodersRef.current.set(mediaId, d) }
    return d.getVideoElement()
  }, [])

  // Dessine la frame courante (synchrone : on dessine l'image courante du <video>,
  // sans seek par frame qui figeait l'aperçu).
  const drawCanvas = useCallback(() => {
    const canvas = previewCanvasRef.current
    const project = projectRef.current, media = mediaRef.current, timeline = tlDataRef.current
    if (!canvas || !project) return
    const ctx = canvas.getContext('2d'); if (!ctx) return
    const { width, height } = project.composition
    const dpr = window.devicePixelRatio || 1
    canvas.width = canvas.offsetWidth * dpr; canvas.height = canvas.offsetHeight * dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const cw = canvas.offsetWidth, ch = canvas.offsetHeight
    const scale = Math.min(cw / width, ch / height)
    const ox = (cw - width * scale) / 2, oy = (ch - height * scale) / 2
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cw, ch)
    if (!timeline || !media) return
    const frame = Math.floor(frameRef.current)
    for (const track of timeline.tracks) {
      if (track.type !== 'video') continue
      for (const clip of track.clips) {
        if (frame < clip.startFrame || frame > clip.endFrame) continue
        if (!media.find(m => m.id === clip.mediaId)) continue
        const vid = decoderFor(clip.mediaId)
        if (!vid || vid.readyState < 2) continue
        const tf = clip.transform, filt = clipFilterString(clip)
        ctx.save()
        if (filt) ctx.filter = filt
        if (tf) {
          ctx.globalAlpha = Math.max(0, Math.min(1, (tf.opacity ?? 100) / 100))
          ctx.globalCompositeOperation = (tf.blend as GlobalCompositeOperation) || 'source-over'
          const cx = ox + width * scale / 2, cy = oy + height * scale / 2
          ctx.translate(cx + (tf.x ?? 0) * scale, cy + (tf.y ?? 0) * scale)
          ctx.rotate(((tf.rotation ?? 0) * Math.PI) / 180)
          ctx.scale(tf.scale ?? 1, tf.scale ?? 1)
          ctx.drawImage(vid, -width * scale / 2, -height * scale / 2, width * scale, height * scale)
        } else {
          ctx.drawImage(vid, ox, oy, width * scale, height * scale)
        }
        ctx.restore()
      }
    }
  }, [decoderFor])

  // Synchronise les éléments média (vidéo + audio) avec la tête de lecture :
  // positionne currentTime, règle le volume, lit/pause selon l'état.
  const syncMedia = useCallback((frame: number, playing: boolean) => {
    const project = projectRef.current, media = mediaRef.current, timeline = tlDataRef.current
    if (!project || !media || !timeline) return
    const fps = project.composition.fps
    const active = new Set<string>()
    for (const track of timeline.tracks) {
      if (track.type !== 'video' && track.type !== 'audio') continue
      for (const clip of track.clips) {
        if (frame < clip.startFrame || frame >= clip.endFrame) continue
        if (!media.find(m => m.id === clip.mediaId)) continue
        active.add(clip.mediaId)
        const vid = decoderFor(clip.mediaId); if (!vid) continue
        const srcTime = (clip.inPoint + (frame - clip.startFrame)) / fps
        vid.volume = track.muted ? 0 : Math.max(0, Math.min(1, clip.volume ?? 1))
        vid.playbackRate = clip.speed && clip.speed > 0 ? clip.speed : 1
        if (playing) {
          if (Math.abs(vid.currentTime - srcTime) > 0.35) { try { vid.currentTime = srcTime } catch { /* not seekable yet */ } }
          if (vid.paused) vid.play().catch(() => { /* autoplay refusée — geste utilisateur requis */ })
        } else {
          if (!vid.paused) vid.pause()
          if (Math.abs(vid.currentTime - srcTime) > 1 / fps) { try { vid.currentTime = srcTime } catch { /* */ } }
        }
      }
    }
    // Met en pause les médias inactifs.
    for (const [mid, d] of decodersRef.current) {
      if (!active.has(mid)) { const v = d.getVideoElement(); if (v && !v.paused) v.pause() }
    }
  }, [decoderFor])

  // Boucle de lecture : avance l'horloge, synchronise les médias, dessine.
  useEffect(() => {
    if (!isPlaying || !project) return
    const fps = project.composition.fps
    const maxFrame = project.composition.duration_frames
    const tick = (ts: number) => {
      const elapsed = ts - (lastTimeRef.current || ts)
      lastTimeRef.current = ts
      let nf = 0, stop = false
      setCurrentFrame(f => { nf = f + (elapsed * fps) / 1000; if (nf >= maxFrame) { nf = maxFrame; stop = true } return nf })
      syncMedia(Math.floor(nf), !stop)
      drawCanvas()
      if (stop) { setIsPlaying(false); return }
      rafRef.current = requestAnimationFrame(tick)
    }
    lastTimeRef.current = 0
    rafRef.current = requestAnimationFrame(tick)
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); syncMedia(Math.floor(frameRef.current), false) }
  }, [isPlaying, project, syncMedia, drawCanvas])

  // Scrubbing / pause : positionne les médias et redessine (après le seek).
  useEffect(() => {
    if (isPlaying) return
    syncMedia(Math.floor(currentFrame), false)
    drawCanvas()
    const r = requestAnimationFrame(drawCanvas)
    const t = setTimeout(drawCanvas, 140)
    return () => { cancelAnimationFrame(r); clearTimeout(t) }
  }, [currentFrame, isPlaying, timeline, media, project, syncMedia, drawCanvas])

  // Media import
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleImport = async (files: FileList) => {
    if (!id || files.length === 0) return
    for (let i = 0; i < files.length; i++) {
      const formData = new FormData()
      formData.append('file', files[i])
      try {
        await api.post(`/paintsharp/video-projects/${id}/media`, formData)
      } catch (e) {
        console.error('Import failed', e)
      }
    }
    qc.invalidateQueries({ queryKey: ['motion-media', id] })
  }

  const [importErr, setImportErr] = useState<string | null>(null)
  const handleImportFromFiles = async () => {
    const file = await useFilesDialogStore.getState().openFile({
      title: t('motion_import_dialog_title'),
      acceptMimes: ['video/*', 'audio/*'],
    })
    if (!file || !id) return
    setImportErr(null)
    try {
      // Le fichier est déjà dans Files : on le référence côté serveur (IPC) au lieu
      // de le télécharger puis ré-uploader depuis le navigateur.
      await motionApi.importMediaFromFile(id, file.id)
      qc.invalidateQueries({ queryKey: ['motion-media', id] })
    } catch (e) {
      console.error('Import from Files failed', e)
      setImportErr(t('motion_import_failed'))
    }
  }

  const addTrack = (type: VideoTrack['type']) => {
    if (!timeline) return
    const newTrack: VideoTrack = {
      id:     crypto.randomUUID(),
      type,
      name:   type === 'video' ? t('motion_track_video') : type === 'audio' ? t('motion_track_audio') : type === 'fx' ? t('motion_track_fx') : t('motion_track_subtitle'),
      muted:  false,
      locked: false,
      height: 48,
      clips:  [],
    }
    setTimeline(t => t ? { ...t, tracks: [...t.tracks, newTrack] } : t)
  }

  const deleteClip = (trackId: string, clipId: string) => {
    setTimeline(t => t ? {
      ...t,
      tracks: t.tracks.map(tr =>
        tr.id === trackId
          ? { ...tr, clips: tr.clips.filter(c => c.id !== clipId) }
          : tr
      ),
    } : t)
  }

  const updateClip = useCallback((clipId: string, patch: Partial<VideoClip>) => {
    setTimeline(tl => {
      if (!tl) return tl
      const next = { ...tl, tracks: tl.tracks.map(tr => ({ ...tr, clips: tr.clips.map(c => c.id === clipId ? { ...c, ...patch } : c) })) }
      saveTimelineMut.mutate(next)
      return next
    })
  }, [saveTimelineMut])

  // ── Effets de clip (ajout / réglage / suppression) ─────────────────────────
  const addEffect = useCallback((clipId: string, type: string) => {
    const d = EFFECT_DEFS[type]; if (!d) return
    setTimeline(tl => {
      if (!tl) return tl
      const next = { ...tl, tracks: tl.tracks.map(tr => ({ ...tr, clips: tr.clips.map(c =>
        c.id === clipId ? { ...c, effects: [...(c.effects ?? []), { type, params: { value: d.def } }] } : c) })) }
      saveTimelineMut.mutate(next)
      return next
    })
  }, [saveTimelineMut])
  const updateEffect = useCallback((clipId: string, idx: number, value: number) => {
    setTimeline(tl => tl && ({ ...tl, tracks: tl.tracks.map(tr => ({ ...tr, clips: tr.clips.map(c =>
      c.id === clipId ? { ...c, effects: c.effects.map((e, i) => i === idx ? { ...e, params: { ...e.params, value } } : e) } : c) })) }))
  }, [])
  const commitEffects = useCallback(() => { setTimeline(tl => { if (tl) saveTimelineMut.mutate(tl); return tl }) }, [saveTimelineMut])
  const removeEffect = useCallback((clipId: string, idx: number) => {
    setTimeline(tl => {
      if (!tl) return tl
      const next = { ...tl, tracks: tl.tracks.map(tr => ({ ...tr, clips: tr.clips.map(c =>
        c.id === clipId ? { ...c, effects: c.effects.filter((_, i) => i !== idx) } : c) })) }
      saveTimelineMut.mutate(next)
      return next
    })
  }, [saveTimelineMut])

  // ── Édition des clips : déplacer / rogner (trim) au glissé ──────────────────
  const clipDrag = useRef<{ id: string; trackId: string; mode: 'move' | 'trim-l' | 'trim-r'; startX: number; s0: number; e0: number; in0: number; out0: number; moved: boolean } | null>(null)
  const onClipMouseDown = useCallback((e: React.MouseEvent, clip: VideoClip, mode: 'move' | 'trim-l' | 'trim-r') => {
    if (e.button !== 0) return
    e.preventDefault()
    clipDrag.current = { id: clip.id, trackId: clip.trackId, mode, startX: e.clientX, s0: clip.startFrame, e0: clip.endFrame, in0: clip.inPoint, out0: clip.outPoint, moved: false }
    const onMove = (ev: MouseEvent) => {
      const d = clipDrag.current; if (!d) return
      const df = Math.round((ev.clientX - d.startX) / pxPerFrame)
      if (df !== 0) d.moved = true
      setTimeline(tl => tl && ({ ...tl, tracks: tl.tracks.map(tr => tr.id !== d.trackId ? tr : ({
        ...tr, clips: tr.clips.map(c => {
          if (c.id !== d.id) return c
          if (d.mode === 'move')   { const ns = Math.max(0, d.s0 + df); return { ...c, startFrame: ns, endFrame: ns + (d.e0 - d.s0) } }
          if (d.mode === 'trim-l') { const ns = Math.min(Math.max(0, d.s0 + df), d.e0 - 1); return { ...c, startFrame: ns, inPoint: Math.max(0, d.in0 + (ns - d.s0)) } }
          const ne = Math.max(d.s0 + 1, d.e0 + df); return { ...c, endFrame: ne, outPoint: d.out0 + (ne - d.e0) }
        }),
      })) }))
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp)
      const moved = clipDrag.current?.moved; clipDrag.current = null
      if (moved) setTimeline(tl => { if (tl) saveTimelineMut.mutate(tl); return tl })
    }
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp)
  }, [pxPerFrame, saveTimelineMut])

  // ── Découper le clip sélectionné à la tête de lecture (touche S) ────────────
  const splitAtPlayhead = useCallback(() => {
    if (!selectedClip) return
    const F = Math.round(currentFrame)
    setTimeline(tl => {
      if (!tl) return tl
      const next = { ...tl, tracks: tl.tracks.map(tr => {
        const idx = tr.clips.findIndex(c => c.id === selectedClip)
        if (idx < 0) return tr
        const c = tr.clips[idx]
        if (F <= c.startFrame || F >= c.endFrame) return tr
        const off = c.inPoint + (F - c.startFrame)
        const left:  VideoClip = { ...c, endFrame: F, outPoint: off }
        const right: VideoClip = { ...c, id: crypto.randomUUID(), startFrame: F, inPoint: off }
        return { ...tr, clips: [...tr.clips.slice(0, idx), left, right, ...tr.clips.slice(idx + 1)] }
      }) }
      saveTimelineMut.mutate(next)
      return next
    })
  }, [selectedClip, currentFrame, saveTimelineMut])

  const duplicateClip = useCallback((clipId: string) => {
    setTimeline(tl => {
      if (!tl) return tl
      const next = { ...tl, tracks: tl.tracks.map(tr => {
        const c = tr.clips.find(cl => cl.id === clipId)
        if (!c) return tr
        const len = c.endFrame - c.startFrame
        const copy: VideoClip = { ...structuredClone(c), id: crypto.randomUUID(), startFrame: c.endFrame, endFrame: c.endFrame + len }
        return { ...tr, clips: [...tr.clips, copy] }
      }) }
      saveTimelineMut.mutate(next)
      return next
    })
  }, [saveTimelineMut])

  // ── Menu contextuel (clic droit sur un clip) ───────────────────────────────
  const ctx = useContextMenu()
  const onClipContextMenu = useCallback((e: React.MouseEvent, clip: VideoClip) => {
    const tr = timeline?.tracks.find(t => t.clips.some(c => c.id === clip.id))
    const items: CtxItem[] = [
      { label: t('motion_split'),       onClick: splitAtPlayhead, shortcut: 'S' },
      { label: t('motion_duplicate'),   onClick: () => duplicateClip(clip.id) },
      'sep',
      ...(clip.transform ? [{ label: t('motion_tf_reset'), onClick: () => updateClip(clip.id, { transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 100, blend: 'source-over' } }) } as CtxItem] : []),
      ...(clip.effects?.length ? [{ label: t('motion_clear_effects'), onClick: () => updateClip(clip.id, { effects: [] }) } as CtxItem] : []),
      'sep',
      { label: t('motion_delete'), onClick: () => { if (tr) deleteClip(tr.id, clip.id); setSelectedClip(null) }, danger: true, shortcut: 'Suppr' },
    ]
    ctx.open(e, items)
  }, [ctx, t, timeline, splitAtPlayhead, duplicateClip, updateClip])

  const fps        = project?.composition.fps ?? 25
  const maxFrame   = project?.composition.duration_frames ?? 750
  const currentMs  = frameToTime(Math.floor(currentFrame), fps)
  const totalMs    = frameToTime(maxFrame, fps)

  // ── Raccourcis clavier (lecture / découpe / suppression / pas image) ────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName)) return
      if (e.code === 'Space') { e.preventDefault(); setIsPlaying(p => !p) }
      else if (e.key.toLowerCase() === 's') { splitAtPlayhead() }
      else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedClip && timeline) {
          const tr = timeline.tracks.find(t => t.clips.some(c => c.id === selectedClip))
          if (tr) { deleteClip(tr.id, selectedClip); setSelectedClip(null) }
        }
      } else if (e.code === 'ArrowLeft')  { setCurrentFrame(f => Math.max(0, f - 1)) }
      else if (e.code === 'ArrowRight')   { setCurrentFrame(f => Math.min(maxFrame, f + 1)) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [splitAtPlayhead, selectedClip, timeline, maxFrame])

  if (isLoading) {
    return (
      <div className="h-full flex items-center justify-center" style={{ background: '#0a0a0a' }}>
        <p className="text-sm text-gray-500">{t('common_loading')}</p>
      </div>
    )
  }

  if (!project || !timeline) {
    return (
      <div className="h-full flex items-center justify-center" style={{ background: '#0a0a0a' }}>
        <p className="text-sm text-gray-500">{t('motion_project_not_found')}</p>
      </div>
    )
  }

  const motionPanels = {
    media: { label: t('motion_media'), render: () => (
      <div className="flex flex-col h-full" style={{ background: '#0d0d0d' }}>
          <div className="flex items-center justify-between px-3 py-2 border-b"
               style={{ borderColor: '#1f2937' }}>
            <span className="text-xs font-medium text-gray-400">{t('motion_media')}</span>
            <div className="flex items-center gap-1">
              <button
                onClick={handleImportFromFiles}
                title={t('motion_import_from_files')}
                className="p-0.5 rounded hover:bg-white/10 transition-colors text-gray-500 hover:text-white"
              >
                <Film size={12} />
              </button>
              <button
                onClick={() => fileInputRef.current?.click()}
                title={t('motion_import_from_computer')}
                className="p-0.5 rounded hover:bg-white/10 transition-colors text-gray-500 hover:text-white"
              >
                <Upload size={12} />
              </button>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="video/*,audio/*"
              className="hidden"
              onChange={(e) => e.target.files && handleImport(e.target.files)}
            />
          </div>
          {importErr && (
            <div className="px-3 py-1.5 text-[10px]" style={{ color: '#e84a4a', background: '#3a1a1a' }}>{importErr}</div>
          )}

          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {(media ?? []).map(m => (
              <div key={m.id}
                   className="flex items-center gap-2 p-2 rounded cursor-pointer hover:bg-white/5
                              transition-colors group"
                   draggable
                   onDragStart={(e) => {
                     e.dataTransfer.setData('media-id', m.id)
                     e.dataTransfer.setData('mime-type', m.mime_type)
                   }}
              >
                <div className="w-8 h-6 rounded bg-white/10 flex items-center justify-center flex-shrink-0">
                  {m.mime_type.startsWith('video/') ? (
                    <Film size={12} className="text-blue-400" />
                  ) : (
                    <Volume2 size={12} className="text-green-400" />
                  )}
                </div>
                <div className="min-w-0">
                  <p className="text-[10px] text-gray-300 truncate">{m.original_name}</p>
                  <p className="text-[9px] text-gray-600">{(m.size_bytes / 1024 / 1024).toFixed(1)} MB</p>
                </div>
              </div>
            ))}
            {(media ?? []).length === 0 && (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <Upload size={20} className="text-gray-600 mb-2" />
                <p className="text-[10px] text-gray-600">{t('motion_import_media_hint')}</p>
              </div>
            )}
          </div>
      </div>
    ) },
    inspector: { label: t('motion_inspector'), render: () => (
      <div className="flex flex-col h-full" style={{ background: '#0d0d0d' }}>
          <div className="px-3 py-2 border-b text-xs font-medium text-gray-400"
               style={{ borderColor: '#1f2937' }}>
            {t('motion_inspector')}
          </div>
          {(() => {
            const clip = selectedClip ? timeline?.tracks.flatMap(tr => tr.clips).find(c => c.id === selectedClip) : null
            if (!clip) return (
              <div className="flex items-center justify-center h-24">
                <p className="text-[10px] text-gray-600">{t('motion_select_clip')}</p>
              </div>
            )
            const Field = ({ label, value, min, max, step, onChange }: { label: string; value: number; min?: number; max?: number; step?: number; onChange: (v: number) => void }) => (
              <label className="flex items-center justify-between gap-2 mb-2">
                <span className="text-[10px] text-gray-500">{label}</span>
                <input type="number" value={value} min={min} max={max} step={step ?? 1}
                       onChange={e => onChange(Number(e.target.value))}
                       className="w-20 h-6 text-right text-[11px] rounded px-1.5 outline-none"
                       style={{ background: '#1a1a1a', border: '1px solid #333', color: '#e0e0e0' }} />
              </label>
            )
            const tf = clip.transform ?? { x: 0, y: 0, scale: 1, rotation: 0, opacity: 100, blend: 'source-over' }
            const patchTf = (p: Partial<typeof tf>) => updateClip(clip.id, { transform: { ...tf, ...p } })
            const Section = ({ title }: { title: string }) => (
              <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 mt-3 mb-2 pb-1 border-b" style={{ borderColor: '#1f2937' }}>{title}</p>
            )
            return (
              <div className="p-3 overflow-y-auto">
                <p className="text-gray-400 font-medium text-xs">{t('motion_clip_selected')}</p>

                <Section title={t('motion_transform')} />
                <Field label={t('motion_tf_pos_x')}   value={Math.round(tf.x)} step={1}   onChange={v => patchTf({ x: v })} />
                <Field label={t('motion_tf_pos_y')}   value={Math.round(tf.y)} step={1}   onChange={v => patchTf({ y: v })} />
                <Field label={t('motion_tf_zoom')}    value={+(tf.scale).toFixed(3)} min={0.05} step={0.05} onChange={v => patchTf({ scale: Math.max(0.05, v) })} />
                <Field label={t('motion_tf_rotation')}value={Math.round(tf.rotation)} step={1} onChange={v => patchTf({ rotation: v })} />
                <Field label={t('motion_tf_opacity')} value={Math.round(tf.opacity)} min={0} max={100} step={1} onChange={v => patchTf({ opacity: Math.max(0, Math.min(100, v)) })} />
                <label className="flex items-center justify-between gap-2 mb-2">
                  <span className="text-[10px] text-gray-500">{t('motion_tf_blend')}</span>
                  <select value={tf.blend} onChange={e => patchTf({ blend: e.target.value })}
                          className="w-28 h-6 text-[11px] rounded px-1 outline-none"
                          style={{ background: '#1a1a1a', border: '1px solid #333', color: '#e0e0e0' }}>
                    {['source-over','screen','multiply','overlay','lighten','darken','color-dodge','difference'].map(b => (
                      <option key={b} value={b}>{b === 'source-over' ? t('motion_blend_normal') : b}</option>
                    ))}
                  </select>
                </label>
                {(tf.x !== 0 || tf.y !== 0 || tf.scale !== 1 || tf.rotation !== 0 || tf.opacity !== 100 || tf.blend !== 'source-over') && (
                  <button onClick={() => updateClip(clip.id, { transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 100, blend: 'source-over' } })}
                          className="text-[10px] text-gray-500 hover:text-white mt-1">{t('motion_tf_reset')}</button>
                )}

                <Section title={t('motion_clip')} />
                <Field label={t('motion_clip_start')}    value={clip.startFrame} min={0} onChange={v => { const dur = clip.endFrame - clip.startFrame; updateClip(clip.id, { startFrame: Math.max(0, v), endFrame: Math.max(0, v) + dur }) }} />
                <Field label={t('motion_clip_duration')} value={clip.endFrame - clip.startFrame} min={1} onChange={v => updateClip(clip.id, { endFrame: clip.startFrame + Math.max(1, v) })} />
                <Field label={t('motion_clip_speed')}    value={clip.speed} min={0.1} max={8} step={0.1} onChange={v => updateClip(clip.id, { speed: Math.max(0.1, v) })} />
                <Field label={t('motion_clip_volume')}   value={clip.volume} min={0} max={1} step={0.05} onChange={v => updateClip(clip.id, { volume: Math.max(0, Math.min(1, v)) })} />

                <Section title={t('motion_effects')} />
                {(clip.effects ?? []).length === 0 && (
                  <p className="text-[10px] text-gray-600 mb-2">{t('motion_no_effects')}</p>
                )}
                {(clip.effects ?? []).map((e, i) => {
                  const d = EFFECT_DEFS[e.type]; if (!d) return null
                  const val = Number((e.params as { value?: number })?.value ?? d.def)
                  return (
                    <div key={i} className="mb-2">
                      <div className="flex items-center justify-between mb-0.5">
                        <span className="text-[10px] text-gray-400">{t(d.labelKey)}</span>
                        <button onClick={() => removeEffect(clip.id, i)} className="text-gray-600 hover:text-[#e84a4a]"><Trash2 size={10} /></button>
                      </div>
                      <input type="range" min={d.min} max={d.max} step={d.step} value={val}
                             onChange={ev => updateEffect(clip.id, i, Number(ev.target.value))}
                             onMouseUp={commitEffects} onTouchEnd={commitEffects}
                             className="w-full h-1 accent-[#a855f7]" />
                    </div>
                  )
                })}
              </div>
            )
          })()}
      </div>
    ) },
    effects: { label: t('motion_effects'), render: () => (
      <div className="flex flex-col h-full" style={{ background: '#0d0d0d' }}>
        <div className="px-3 py-2 border-b text-xs font-medium text-gray-400" style={{ borderColor: '#1f2937' }}>
          {t('motion_effects')}
        </div>
        {!selectedClip ? (
          <div className="flex items-center justify-center h-24"><p className="text-[10px] text-gray-600">{t('motion_select_clip')}</p></div>
        ) : (
          <div className="p-2 grid grid-cols-2 gap-1.5">
            {Object.entries(EFFECT_DEFS).map(([type, d]) => (
              <button key={type} onClick={() => addEffect(selectedClip, type)}
                      className="flex items-center gap-1.5 px-2 py-2 rounded text-[10px] text-gray-300 hover:bg-white/5 border transition-colors"
                      style={{ borderColor: '#1f2937' }}>
                <Wand2 size={12} className="text-[#a855f7] flex-shrink-0" />
                <span className="truncate">{t(d.labelKey)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    ) },
  }

  return (
    <>
      {showExport && (
        <ExportModal project={project} onClose={() => setShowExport(false)} />
      )}
      <EditorShell theme={C}
        chromeless
        topbarHeight={64}
        onBack={() => navigate('/paintsharp/motion')}
        title={titleDraft}
        onTitleChange={setTitleDraft}
        onTitleCommit={commitTitle}
        titlePlaceholder={t('common_untitled', { defaultValue: 'Sans titre' })}
        saveStatus={(isSaving || saveTimelineMut.isPending) ? t('motion_saving') : t('doc_saved', { defaultValue: 'Enregistré' })}
        subtitle="Motion"
        docInfo={`${project.composition.width}×${project.composition.height} · ${fps}fps`}
        onDelete={() => trashMut.mutate()}
        deleteTitle={t('motion_move_to_trash', { defaultValue: 'Mettre à la corbeille' })}
        deleteConfirm={{
          title: t('motion_delete_confirm_title', { defaultValue: 'Supprimer ce projet ?' }),
          message: t('motion_delete_confirm_msg', { defaultValue: 'Le projet sera déplacé dans la corbeille.' }),
          confirmLabel: t('common_delete', { defaultValue: 'Supprimer' }),
          variant: 'danger',
        }}
        menus={paintsharpMenus(t, {
          onSave:   handleSave,
          onExport: () => setShowExport(true), exportLabel: t('common_export'),
          onClose:  () => navigate('/paintsharp/motion'),
        })}
        topbarActions={<>
          <Button variant="secondary" size="sm" onClick={handleSave} disabled={isSaving || saveTimelineMut.isPending} className="text-xs">{isSaving ? t('motion_saving') : t('common_save')}</Button>
          <Button size="sm" icon={<Download size={12} />} onClick={() => setShowExport(true)} className="text-xs">{t('common_export')}</Button>
        </>}
        optionsBar={<>
            <button onClick={() => setCurrentFrame(0)} className="text-gray-400 hover:text-white transition-colors">
              <SkipBack size={16} />
            </button>
            <button
              onClick={() => { setIsPlaying(v => !v); lastTimeRef.current = 0 }}
              className="w-8 h-8 rounded-full flex items-center justify-center
                         bg-white hover:bg-gray-200 transition-colors text-black"
            >
              {isPlaying ? <Pause size={14} /> : <Play size={14} />}
            </button>
            <button onClick={() => setCurrentFrame(maxFrame)} className="text-gray-400 hover:text-white transition-colors">
              <SkipForward size={16} />
            </button>
            <button onClick={splitAtPlayhead} disabled={!selectedClip}
                    title={t('motion_split')}
                    className="text-gray-400 hover:text-white transition-colors disabled:opacity-30 ml-1">
              <Scissors size={15} />
            </button>

            <span className="text-xs font-mono text-gray-400 ml-2">
              {currentMs} / {totalMs}
            </span>

            <div className="flex-1" />

            {/* Zoom */}
            <button onClick={() => setPxPerFrame(v => Math.max(0.5, v / 1.5))}
                    className="text-gray-500 hover:text-white transition-colors">
              <ZoomOut size={14} />
            </button>
            <span className="text-[10px] text-gray-600 w-10 text-center">
              {pxPerFrame.toFixed(1)}px
            </span>
            <button onClick={() => setPxPerFrame(v => Math.min(20, v * 1.5))}
                    className="text-gray-500 hover:text-white transition-colors">
              <ZoomIn size={14} />
            </button>
        </>}
        bottomBar={
      <div className="flex-shrink-0" style={{ height: 260, background: '#0d0d0d', borderTop: '1px solid #1f2937' }}>
        {/* Timeline toolbar */}
        <div className="flex items-center gap-2 px-3 h-8 border-b" style={{ borderColor: '#1f2937' }}>
          <span className="text-[10px] text-gray-500">{t('motion_tracks')}</span>
          <button
            onClick={() => addTrack('video')}
            className="flex items-center gap-1 px-2 py-0.5 text-[10px] rounded border
                       hover:bg-white/5 transition-colors text-gray-400 hover:text-white"
            style={{ borderColor: '#374151' }}
          >
            <Plus size={10} />
            {t('motion_track_video')}
          </button>
          <button
            onClick={() => addTrack('audio')}
            className="flex items-center gap-1 px-2 py-0.5 text-[10px] rounded border
                       hover:bg-white/5 transition-colors text-gray-400 hover:text-white"
            style={{ borderColor: '#374151' }}
          >
            <Plus size={10} />
            {t('motion_track_audio')}
          </button>
          <div className="flex-1" />
          <button onClick={() => setScrollLeft(s => Math.max(0, s - 100))} className="text-gray-600 hover:text-gray-400">
            <ChevronLeft size={12} />
          </button>
          <button onClick={() => setScrollLeft(s => s + 100)} className="text-gray-600 hover:text-gray-400">
            <ChevronRight size={12} />
          </button>
        </div>

        {/* Ruler */}
        <div className="flex border-b" style={{ borderColor: '#1f2937', height: 24 }}>
          <div className="w-48 flex-shrink-0 border-r" style={{ borderColor: '#1f2937', background: '#0a0a0a' }} />
          <div className="flex-1 overflow-hidden">
            <TimelineRuler
              fps={fps}
              totalFrames={maxFrame}
              pxPerFrame={pxPerFrame}
              scrollLeft={scrollLeft}
            />
          </div>
        </div>

        {/* Tracks */}
        <div
          ref={timelineRef}
          className="overflow-y-auto"
          style={{ height: 260 - 8 - 24 }}
          onDrop={(e) => {
            e.preventDefault()
            const mediaId  = e.dataTransfer.getData('media-id')
            const mimeType = e.dataTransfer.getData('mime-type')
            if (!mediaId || !timeline) return

            const trackType: VideoTrack['type'] = mimeType.startsWith('audio/') ? 'audio' : 'video'
            const existingTrack = timeline.tracks.find(t => t.type === trackType)

            const mediaItem = media?.find(m => m.id === mediaId)
            const dur = Math.floor((Number((mediaItem?.probe_data as Record<string, unknown>)?.duration ?? 5)) * fps)

            const newClip: VideoClip = {
              id:         crypto.randomUUID(),
              mediaId,
              trackId:    existingTrack?.id ?? '',
              startFrame: 0,
              endFrame:   dur,
              inPoint:    0,
              outPoint:   dur,
              speed:      1,
              volume:     1,
              effects:    [],
            }

            if (existingTrack) {
              setTimeline(t => t ? {
                ...t,
                tracks: t.tracks.map(tr =>
                  tr.id === existingTrack.id
                    ? { ...tr, clips: [...tr.clips, { ...newClip, trackId: tr.id }] }
                    : tr
                ),
              } : t)
            } else {
              const newTrack: VideoTrack = {
                id:     crypto.randomUUID(),
                type:   trackType,
                name:   trackType === 'video' ? t('motion_track_video') : t('motion_track_audio'),
                muted:  false,
                locked: false,
                height: 48,
                clips:  [{ ...newClip, trackId: '' }],
              }
              setTimeline(t => t ? { ...t, tracks: [...t.tracks, newTrack] } : t)
            }
          }}
          onDragOver={(e) => e.preventDefault()}
        >
          {timeline.tracks.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-2">
              <Film size={20} className="text-gray-700" />
              <p className="text-[10px] text-gray-600">
                {t('motion_empty_timeline')}
              </p>
            </div>
          ) : (
            timeline.tracks.map(track => (
              <TrackRow
                key={track.id}
                track={track}
                media={media ?? []}
                pxPerFrame={pxPerFrame}
                currentFrame={currentFrame}
                scrollLeft={scrollLeft}

                onDeleteClip={deleteClip}
                selectedClipId={selectedClip}
                onSelectClip={setSelectedClip}
                onClipMouseDown={onClipMouseDown}
                onClipContextMenu={onClipContextMenu}
              />
            ))
          )}
        </div>
      </div>
        }>
        <DockArea theme={C} storageKey="kubuno:paintsharp:motionDockLayout" viewportBg="#050505"
          defaultArrangement={{ left: [['media', 'effects']], right: [['inspector']] }} panels={motionPanels}>
        <div ref={previewWrapRef}
             className="relative w-full h-full flex flex-col items-center justify-center p-2 overflow-hidden" style={{ background: '#050505' }}
             onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); panDragRef.current = { x: e.clientX, y: e.clientY, px: viewPan.x, py: viewPan.y } } }}
             onMouseMove={(e) => { const pd = panDragRef.current; if (pd) setViewPan({ x: pd.px + (e.clientX - pd.x), y: pd.py + (e.clientY - pd.y) }) }}
             onMouseUp={() => { panDragRef.current = null }}
             onMouseLeave={() => { panDragRef.current = null }}>
          <div className="text-[10px] text-gray-600 mb-1">{t('motion_program')}</div>
          <div className="relative w-full" style={{ aspectRatio: `${project.composition.width}/${project.composition.height}`, maxHeight: '100%', transform: `translate(${viewPan.x}px, ${viewPan.y}px) scale(${viewZoom})` }}>
            <canvas ref={previewCanvasRef} className="w-full h-full rounded" style={{ background: '#000' }} />
          </div>
          <div className="text-[10px] text-gray-500 mt-1 font-mono">{currentMs}</div>
          {/* Contrôles de zoom (façon Layer) */}
          <div className="absolute bottom-3 right-3 flex items-center gap-1 px-1.5 py-1 rounded-lg" style={{ background: 'rgba(0,0,0,0.6)', border: '1px solid #1f2937' }}>
            <button onClick={() => zoomAt(1 / 1.2)} className="w-6 h-6 flex items-center justify-center rounded text-gray-400 hover:bg-white/10"><ZoomOut size={13} /></button>
            <button onClick={resetView} className="px-1.5 text-[10px] font-mono text-gray-400 hover:text-white" title={t('motion_zoom_reset')}>{Math.round(viewZoom * 100)}%</button>
            <button onClick={() => zoomAt(1.2)} className="w-6 h-6 flex items-center justify-center rounded text-gray-400 hover:bg-white/10"><ZoomIn size={13} /></button>
          </div>
        </div>
        </DockArea>
      </EditorShell>
      {ctx.menu}
    </>
  )
}