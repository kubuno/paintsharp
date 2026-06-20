import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@kubuno/sdk'
import { Palette, Save, ChevronLeft, ExternalLink, Check } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Toggle, Button, Tabs, NumberInput, RangeSlider } from '@ui'

type Tab = 'vertex' | 'media' | 'canvas' | 'about'

interface PaintsharpSettings {
  'paintsharp.max_scene_bytes':         number
  'paintsharp.max_asset_bytes':         number
  'paintsharp.max_media_bytes':         number
  'paintsharp.default_canvas_width':    number
  'paintsharp.default_canvas_height':   number
  'paintsharp.default_canvas_fps':      number
  'paintsharp.max_texture_size':        number
  'paintsharp.enable_collaboration':    boolean
  'paintsharp.thumbnail_quality':       number
}

function formatMb(bytes: number): string {
  const mb = bytes / 1048576
  return mb >= 1024 ? `${(mb / 1024).toFixed(0)} Go` : `${mb.toFixed(0)} Mo`
}

function mbFromBytes(bytes: number): number { return Math.round(bytes / 1048576) }
function bytesFromMb(mb: number): number    { return mb * 1048576 }

// ── Vertex & Assets settings ──────────────────────────────────────────────────

function VertexTab() {
  const { t } = useTranslation('paintsharp')
  const qc = useQueryClient()

  const { data: settings } = useQuery({
    queryKey: ['admin-settings'],
    queryFn: () =>
      api.get<{ settings: { key: string; value: unknown }[] }>('/admin/settings').then((r) => {
        const map: Record<string, unknown> = {}
        r.data.settings.forEach((s) => { map[s.key] = s.value })
        return map as unknown as PaintsharpSettings
      }),
  })

  const maxScene = settings ? mbFromBytes(settings['paintsharp.max_scene_bytes'] as number ?? 52428800) : 50
  const maxAsset = settings ? mbFromBytes(settings['paintsharp.max_asset_bytes'] as number ?? 104857600) : 100
  const maxTex   = settings ? (settings['paintsharp.max_texture_size'] as number ?? 4096) : 4096
  const collab   = settings ? (settings['paintsharp.enable_collaboration'] as boolean ?? true) : true

  const [localScene, setLocalScene] = useState<number | null>(null)
  const [localAsset, setLocalAsset] = useState<number | null>(null)
  const [localTex,   setLocalTex]   = useState<number | null>(null)
  const [localCollab, setLocalCollab] = useState<boolean | null>(null)
  const [saved, setSaved] = useState(false)

  const save = useMutation({
    mutationFn: (updates: Record<string, unknown>) => api.patch('/admin/settings', updates),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-settings'] })
      setLocalScene(null); setLocalAsset(null); setLocalTex(null); setLocalCollab(null)
      setSaved(true); setTimeout(() => setSaved(false), 2000)
    },
  })

  const isDirty = localScene !== null || localAsset !== null || localTex !== null || localCollab !== null

  function handleSave() {
    const updates: Record<string, unknown> = {}
    if (localScene !== null) updates['paintsharp.max_scene_bytes'] = bytesFromMb(localScene)
    if (localAsset !== null) updates['paintsharp.max_asset_bytes'] = bytesFromMb(localAsset)
    if (localTex   !== null) updates['paintsharp.max_texture_size'] = localTex
    if (localCollab !== null) updates['paintsharp.enable_collaboration'] = localCollab
    if (Object.keys(updates).length > 0) save.mutate(updates)
  }

  const curScene  = localScene  ?? maxScene
  const curAsset  = localAsset  ?? maxAsset
  const curTex    = localTex    ?? maxTex
  const curCollab = localCollab ?? collab

  const TEX_OPTIONS = [512, 1024, 2048, 4096, 8192]

  return (
    <div>
      <div className="bg-white rounded-xl border border-border divide-y divide-border">
        {/* Max scene size */}
        <div className="p-5">
          <label className="block text-sm font-medium text-text-primary mb-1">
            {t('settings_max_scene_label')}
          </label>
          <p className="text-xs text-text-secondary mb-3">
            {t('settings_max_scene_desc')} <span className="font-medium">{formatMb(bytesFromMb(curScene))}</span>
          </p>
          <div className="flex items-center gap-3">
            <RangeSlider min={10} max={500} step={10} value={curScene}
                   onChange={setLocalScene} className="flex-1" aria-label={t('settings_max_scene_label')} />
            <span className="text-sm font-medium text-text-primary w-16 text-right">{curScene} Mo</span>
          </div>
        </div>

        {/* Max asset size */}
        <div className="p-5">
          <label className="block text-sm font-medium text-text-primary mb-1">
            {t('settings_max_asset_label')}
          </label>
          <p className="text-xs text-text-secondary mb-3">
            {t('settings_max_asset_desc')} <span className="font-medium">{formatMb(bytesFromMb(curAsset))}</span>
          </p>
          <div className="flex items-center gap-3">
            <RangeSlider min={10} max={1000} step={10} value={curAsset}
                   onChange={setLocalAsset} className="flex-1" aria-label={t('settings_max_asset_label')} />
            <span className="text-sm font-medium text-text-primary w-20 text-right">{curAsset} Mo</span>
          </div>
        </div>

        {/* Max texture resolution */}
        <div className="p-5">
          <label className="block text-sm font-medium text-text-primary mb-2">
            {t('settings_max_texture_label')}
          </label>
          <div className="flex flex-wrap gap-2">
            {TEX_OPTIONS.map(v => (
              <button
                key={v}
                onClick={() => setLocalTex(v)}
                className={`px-3 py-1.5 text-sm rounded-lg border transition-colors
                  ${curTex === v
                    ? 'border-primary bg-primary-light text-primary font-medium'
                    : 'border-border text-text-secondary hover:border-border-strong'
                  }`}
              >
                {v} px
              </button>
            ))}
          </div>
        </div>

        {/* Collaboration */}
        <div className="p-5">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-text-primary">{t('settings_collab_label')}</p>
              <p className="text-xs text-text-secondary mt-0.5">
                {t('settings_collab_desc')}
              </p>
            </div>
            <Toggle checked={curCollab} onChange={() => setLocalCollab(!curCollab)} />
          </div>
        </div>
      </div>

      {isDirty && (
        <div className="mt-4 flex justify-end">
          <Button onClick={handleSave} disabled={save.isPending}>
            {saved ? <Check size={15} /> : <Save size={15} />}
            {saved ? t('settings_saved') : t('common_save')}
          </Button>
        </div>
      )}
    </div>
  )
}

// ── Media (Motion) settings ───────────────────────────────────────────────────

function MediaTab() {
  const { t } = useTranslation('paintsharp')
  const qc = useQueryClient()

  const { data: settings } = useQuery({
    queryKey: ['admin-settings'],
    queryFn: () =>
      api.get<{ settings: { key: string; value: unknown }[] }>('/admin/settings').then((r) => {
        const map: Record<string, unknown> = {}
        r.data.settings.forEach((s) => { map[s.key] = s.value })
        return map as unknown as PaintsharpSettings
      }),
  })

  const maxMedia = settings ? mbFromBytes(settings['paintsharp.max_media_bytes'] as number ?? 5368709120) : 5120

  const [localMedia, setLocalMedia] = useState<number | null>(null)
  const [saved, setSaved] = useState(false)

  const save = useMutation({
    mutationFn: (updates: Record<string, unknown>) => api.patch('/admin/settings', updates),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-settings'] })
      setLocalMedia(null)
      setSaved(true); setTimeout(() => setSaved(false), 2000)
    },
  })

  const curMedia = localMedia ?? maxMedia

  return (
    <div>
      <div className="bg-white rounded-xl border border-border divide-y divide-border">
        <div className="p-5">
          <label className="block text-sm font-medium text-text-primary mb-1">
            {t('settings_max_media_label')}
          </label>
          <p className="text-xs text-text-secondary mb-3">
            {t('settings_max_media_desc')} <span className="font-medium">{formatMb(bytesFromMb(curMedia))}</span>
          </p>
          <div className="flex items-center gap-3">
            <RangeSlider min={100} max={10240} step={100} value={curMedia}
                   onChange={setLocalMedia} className="flex-1" aria-label={t('settings_max_media_label')} />
            <span className="text-sm font-medium text-text-primary w-20 text-right">
              {curMedia >= 1024 ? `${(curMedia / 1024).toFixed(1)} Go` : `${curMedia} Mo`}
            </span>
          </div>
        </div>

        <div className="p-5">
          <p className="text-sm font-medium text-text-primary mb-2">{t('settings_video_formats_label')}</p>
          <div className="flex flex-wrap gap-2">
            {['MP4', 'MOV', 'MKV', 'AVI', 'WEBM', 'M4V'].map(f => (
              <span key={f} className="text-xs px-2 py-1 rounded-lg bg-surface-2 text-text-secondary font-mono">{f}</span>
            ))}
          </div>
          <p className="text-xs text-text-tertiary mt-2">{t('settings_codecs_hint')}</p>
        </div>

        <div className="p-5">
          <p className="text-sm font-medium text-text-primary mb-2">{t('settings_audio_formats_label')}</p>
          <div className="flex flex-wrap gap-2">
            {['MP3', 'WAV', 'AAC', 'FLAC', 'OGG', 'M4A'].map(f => (
              <span key={f} className="text-xs px-2 py-1 rounded-lg bg-surface-2 text-text-secondary font-mono">{f}</span>
            ))}
          </div>
        </div>
      </div>

      {localMedia !== null && (
        <div className="mt-4 flex justify-end">
          <Button onClick={() => save.mutate({ 'paintsharp.max_media_bytes': bytesFromMb(curMedia) })} disabled={save.isPending}>
            {saved ? <Check size={15} /> : <Save size={15} />}
            {saved ? t('settings_saved') : t('common_save')}
          </Button>
        </div>
      )}
    </div>
  )
}

// ── Canvas defaults (Keyframe / Layer / Apex) ─────────────────────────────────

function CanvasTab() {
  const { t } = useTranslation('paintsharp')
  const qc = useQueryClient()

  const { data: settings } = useQuery({
    queryKey: ['admin-settings'],
    queryFn: () =>
      api.get<{ settings: { key: string; value: unknown }[] }>('/admin/settings').then((r) => {
        const map: Record<string, unknown> = {}
        r.data.settings.forEach((s) => { map[s.key] = s.value })
        return map as unknown as PaintsharpSettings
      }),
  })

  const defW   = settings ? (settings['paintsharp.default_canvas_width']  as number ?? 1920) : 1920
  const defH   = settings ? (settings['paintsharp.default_canvas_height'] as number ?? 1080) : 1080
  const defFps = settings ? (settings['paintsharp.default_canvas_fps']    as number ?? 24) : 24
  const thumbQ = settings ? (settings['paintsharp.thumbnail_quality']     as number ?? 85) : 85

  const [localW,   setLocalW]   = useState<number | null>(null)
  const [localH,   setLocalH]   = useState<number | null>(null)
  const [localFps, setLocalFps] = useState<number | null>(null)
  const [localQ,   setLocalQ]   = useState<number | null>(null)
  const [saved,    setSaved]    = useState(false)

  const save = useMutation({
    mutationFn: (updates: Record<string, unknown>) => api.patch('/admin/settings', updates),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-settings'] })
      setLocalW(null); setLocalH(null); setLocalFps(null); setLocalQ(null)
      setSaved(true); setTimeout(() => setSaved(false), 2000)
    },
  })

  const curW   = localW   ?? defW
  const curH   = localH   ?? defH
  const curFps = localFps ?? defFps
  const curQ   = localQ   ?? thumbQ
  const isDirty = localW !== null || localH !== null || localFps !== null || localQ !== null

  const PRESETS = [
    { label: '720p',                 w: 1280, h: 720  },
    { label: '1080p',                w: 1920, h: 1080 },
    { label: '4K',                   w: 3840, h: 2160 },
    { label: t('settings_preset_square'), w: 1080, h: 1080 },
  ]

  const FPS_OPTIONS = [12, 24, 25, 30, 60]

  function handleSave() {
    const updates: Record<string, unknown> = {}
    if (localW   !== null) updates['paintsharp.default_canvas_width']  = localW
    if (localH   !== null) updates['paintsharp.default_canvas_height'] = localH
    if (localFps !== null) updates['paintsharp.default_canvas_fps']    = localFps
    if (localQ   !== null) updates['paintsharp.thumbnail_quality']     = localQ
    if (Object.keys(updates).length > 0) save.mutate(updates)
  }

  return (
    <div>
      <div className="bg-white rounded-xl border border-border divide-y divide-border">
        {/* Resolution default */}
        <div className="p-5">
          <label className="block text-sm font-medium text-text-primary mb-2">
            {t('settings_default_resolution_label')}
          </label>
          <div className="flex flex-wrap gap-2 mb-3">
            {PRESETS.map(p => (
              <button
                key={p.label}
                onClick={() => { setLocalW(p.w); setLocalH(p.h) }}
                className={`px-3 py-1.5 text-sm rounded-lg border transition-colors
                  ${curW === p.w && curH === p.h
                    ? 'border-primary bg-primary-light text-primary font-medium'
                    : 'border-border text-text-secondary hover:border-border-strong'
                  }`}
              >
                {p.label} ({p.w}×{p.h})
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <label className="text-xs text-text-tertiary mb-1 block">{t('settings_width_label')}</label>
              <NumberInput
                min={320} max={7680} value={curW}
                onChange={(v) => setLocalW(v)}
                className="w-full"
              />
            </div>
            <div className="flex-1">
              <label className="text-xs text-text-tertiary mb-1 block">{t('settings_height_label')}</label>
              <NumberInput
                min={240} max={4320} value={curH}
                onChange={(v) => setLocalH(v)}
                className="w-full"
              />
            </div>
          </div>
        </div>

        {/* FPS default */}
        <div className="p-5">
          <label className="block text-sm font-medium text-text-primary mb-2">
            {t('settings_default_fps_label')}
          </label>
          <div className="flex flex-wrap gap-2">
            {FPS_OPTIONS.map(fps => (
              <button
                key={fps}
                onClick={() => setLocalFps(fps)}
                className={`px-3 py-1.5 text-sm rounded-lg border transition-colors
                  ${curFps === fps
                    ? 'border-primary bg-primary-light text-primary font-medium'
                    : 'border-border text-text-secondary hover:border-border-strong'
                  }`}
              >
                {fps} fps
              </button>
            ))}
          </div>
        </div>

        {/* Thumbnail quality */}
        <div className="p-5">
          <label className="block text-sm font-medium text-text-primary mb-1">
            {t('settings_thumbnail_quality_label')}
          </label>
          <p className="text-xs text-text-secondary mb-3">
            {t('settings_thumbnail_quality_desc')} <span className="font-medium">{curQ}</span>
          </p>
          <div className="flex items-center gap-3">
            <RangeSlider min={50} max={100} step={5} value={curQ}
                   onChange={setLocalQ} className="flex-1" aria-label={t('settings_thumbnail_quality_label')} />
            <span className="text-sm font-medium text-text-primary w-12 text-right">{curQ}</span>
          </div>
        </div>
      </div>

      {isDirty && (
        <div className="mt-4 flex justify-end">
          <Button onClick={handleSave} disabled={save.isPending}>
            {saved ? <Check size={15} /> : <Save size={15} />}
            {saved ? t('settings_saved') : t('common_save')}
          </Button>
        </div>
      )}
    </div>
  )
}

// ── About ─────────────────────────────────────────────────────────────────────

function AboutTab() {
  const { t } = useTranslation('paintsharp')
  const SUBMODULES = [
    { name: 'Vertex',    desc: t('settings_submodule_vertex_desc'),   color: '#e8824a' },
    { name: 'Layer',     desc: t('settings_submodule_layer_desc'),    color: '#4a90e8' },
    { name: 'Apex',      desc: t('settings_submodule_apex_desc'),     color: '#e84a90' },
    { name: 'Keyframe',  desc: t('settings_submodule_keyframe_desc'), color: '#e8e84a' },
    { name: 'Motion',    desc: t('settings_submodule_motion_desc'),   color: '#4ae84a' },
  ]

  return (
    <div className="bg-white rounded-xl border border-border overflow-hidden">
      <div className="flex items-center gap-3 p-5 border-b border-border">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center"
             style={{ background: '#1a1a2e' }}>
          <Palette size={20} style={{ color: '#e8824a' }} />
        </div>
        <div>
          <p className="text-sm font-semibold text-text-primary">Kubuno Paintsharp</p>
          <p className="text-xs text-text-tertiary">v0.1.0 · {t('settings_official_module')}</p>
        </div>
        <span className="ml-auto text-xs font-medium px-2 py-0.5 rounded-full bg-orange-100 text-orange-700">
          Rust
        </span>
      </div>

      <div className="divide-y divide-border">
        <div className="px-5 py-4">
          <p className="text-xs font-semibold text-text-tertiary uppercase tracking-wider mb-2">{t('settings_description_label')}</p>
          <p className="text-sm text-text-secondary leading-relaxed">
            {t('settings_description_text')}
          </p>
        </div>

        <div className="px-5 py-4">
          <p className="text-xs font-semibold text-text-tertiary uppercase tracking-wider mb-3">{t('settings_submodules_label')}</p>
          <div className="space-y-2">
            {SUBMODULES.map(s => (
              <div key={s.name} className="flex items-center gap-3">
                <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: s.color }} />
                <span className="text-sm font-medium text-text-primary w-20">{s.name}</span>
                <span className="text-xs text-text-secondary">{s.desc}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="px-5 py-4 grid grid-cols-2 gap-4">
          <div>
            <p className="text-xs font-semibold text-text-tertiary uppercase tracking-wider mb-2">{t('settings_author_label')}</p>
            <p className="text-sm text-text-primary">Kubuno Contributors</p>
          </div>
          <div>
            <p className="text-xs font-semibold text-text-tertiary uppercase tracking-wider mb-2">{t('settings_license_label')}</p>
            <p className="text-sm text-text-primary">AGPL-3.0</p>
          </div>
        </div>

        <div className="px-5 py-4">
          <p className="text-xs font-semibold text-text-tertiary uppercase tracking-wider mb-3">{t('settings_technologies_label')}</p>
          <div className="flex flex-wrap gap-2">
            {['Rust', 'Axum 0.7', 'SQLx 0.8', 'PostgreSQL 16', 'tokio', 'WebSocket', 'Three.js', 'Canvas 2D', 'Fabric.js (Apex)'].map(t => (
              <span key={t} className="text-xs px-2 py-1 rounded-lg bg-surface-2 text-text-secondary font-mono">{t}</span>
            ))}
          </div>
        </div>

        <div className="px-5 py-4">
          <p className="text-xs font-semibold text-text-tertiary uppercase tracking-wider mb-2">{t('settings_links_label')}</p>
          <a href="https://github.com/kubuno/kubuno" target="_blank" rel="noopener noreferrer"
             className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline">
            <ExternalLink size={13} />
            github.com/kubuno/kubuno
          </a>
        </div>
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function PaintsharpSettingsPage() {
  const { t } = useTranslation('paintsharp')
  const [tab, setTab] = useState<Tab>('vertex')

  const TABS: { id: Tab; label: string }[] = [
    { id: 'vertex', label: t('settings_tab_vertex') },
    { id: 'media',  label: t('settings_tab_media') },
    { id: 'canvas', label: t('settings_tab_canvas') },
    { id: 'about',  label: t('settings_tab_about') },
  ]

  return (
    <div className="max-w-2xl">
      <div className="flex items-center gap-3 mb-6">
        <Link to="/admin?tab=modules" className="p-1.5 rounded-lg hover:bg-surface-2 text-text-secondary hover:text-text-primary transition-colors">
          <ChevronLeft size={18} />
        </Link>
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center"
               style={{ background: '#1a1a2e' }}>
            <Palette size={16} style={{ color: '#e8824a' }} />
          </div>
          <div>
            <h1 className="text-lg font-medium text-text-primary">{t('settings_page_title')}</h1>
            <p className="text-xs text-text-tertiary">{t('settings_page_subtitle')}</p>
          </div>
        </div>
      </div>

      <Tabs tabs={TABS} value={tab} onChange={setTab} className="mb-6" />

      {tab === 'vertex' && <VertexTab />}
      {tab === 'media'  && <MediaTab />}
      {tab === 'canvas' && <CanvasTab />}
      {tab === 'about'  && <AboutTab />}
    </div>
  )
}
