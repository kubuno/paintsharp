import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import {
  Plus, Box, Clock, Star, Trash2, MoreVertical, Pencil, RotateCcw,
  Image, PenTool, Film, Clapperboard, ArrowRight, FileEdit, ExternalLink,
} from 'lucide-react'
import { PaintsharpLogo } from './PaintsharpLogo'
import { paintsharpApi, type SceneSummary } from './api'
import { ApexProjectsApp } from './ApexProjectsApp'
import { LayerDocsApp } from './LayerDocsApp'
import { Button, MenuDropdown, type MenuItem, type MenuDropdownPos } from '@ui'
import type { StartPageRecentItem } from '@ui'
import { ModuleStartPage } from '@kubuno/drive'
import type { FileItem } from '@kubuno/drive'
import { AnimationsListApp } from './AnimationsListApp'
import { VideoProjectsListApp } from './VideoProjectsListApp'
import { PdfWriterApp } from './PdfWriterApp'
import { format, formatDistanceToNow } from 'date-fns'
import { useTranslation } from 'react-i18next'
import { getDateLocale } from '@kubuno/sdk'

// ── Page d'accueil de la suite Paintsharp ─────────────────────────────────────────
function PaintsharpSuiteHome() {
  const navigate = useNavigate()
  const { t } = useTranslation('paintsharp')

  const SUBMODULES = [
    {
      id:    'vertex',
      label: 'Vertex',
      desc:  t('paintsharp_vertex_desc'),
      icon:  Box,
      color: '#e8824a',
      path:  '/paintsharp/vertex',
      ready: true,
    },
    {
      id:    'layer',
      label: 'Layer',
      desc:  t('paintsharp_layer_desc'),
      icon:  Image,
      color: '#4a90e8',
      path:  '/paintsharp/layer',
      ready: true,
    },
    {
      id:    'apex',
      label: 'Apex',
      desc:  t('paintsharp_apex_desc'),
      icon:  PenTool,
      color: '#e84a90',
      path:  '/paintsharp/apex',
      ready: true,
    },
    {
      id:    'motion',
      label: 'Motion',
      desc:  t('paintsharp_motion_desc'),
      icon:  Film,
      color: '#4ae84a',
      path:  '/paintsharp/motion',
      ready: true,
    },
    {
      id:    'keyframe',
      label: 'Keyframe',
      desc:  t('paintsharp_keyframe_desc'),
      icon:  Clapperboard,
      color: '#e8e84a',
      path:  '/paintsharp/keyframe',
      ready: true,
    },
    {
      id:    'pdfwriter',
      label: 'PdfWriter',
      desc:  t('paintsharp_pdfwriter_desc'),
      icon:  FileEdit,
      color: '#e84a4a',
      path:  '/paintsharp/pdfwriter',
      ready: true,
    },
  ]

  return (
    <div className="h-full overflow-y-auto" style={{ background: 'var(--body-bg)' }}>
      <div className="max-w-4xl mx-auto px-6 py-8">
        <div className="flex items-center gap-3 mb-2">
          <PaintsharpLogo size={40} />
          <div>
            <h1 className="text-xl font-semibold text-text-primary">PaintSharp</h1>
            <p className="text-sm text-text-secondary">{t('paintsharp_suite_subtitle')}</p>
          </div>
        </div>

        <p className="text-sm text-text-secondary mb-8 ml-1">
          {t('paintsharp_suite_intro')}
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {SUBMODULES.map(({ id, label, desc, icon: Icon, color, path, ready }) => (
            <button
              key={id}
              onClick={() => ready && navigate(path)}
              className={`
                text-left p-4 rounded-xl border transition-all group
                ${ready
                  ? 'hover:shadow-md hover:border-border-strong cursor-pointer'
                  : 'opacity-60 cursor-default'
                }
              `}
              style={{ background: 'var(--color-surface-0)', borderColor: 'var(--color-border)' }}
            >
              <div className="flex items-start justify-between mb-3">
                <div className="w-10 h-10 rounded-lg flex items-center justify-center"
                     style={{ background: color + '20' }}>
                  <Icon size={20} style={{ color }} />
                </div>
                {ready
                  ? <ArrowRight size={16} className="text-text-tertiary opacity-0 group-hover:opacity-100 transition-opacity mt-2" />
                  : <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-surface-2 text-text-tertiary">
                      {t('paintsharp_coming_soon')}
                    </span>
                }
              </div>
              <h3 className="text-sm font-medium text-text-primary mb-1">{label}</h3>
              <p className="text-xs text-text-secondary leading-relaxed">{desc}</p>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}


export function LayerApp({ starred, trashed }: { starred?: boolean; trashed?: boolean } = {}) {
  return <LayerDocsApp starred={starred} trashed={trashed} />
}
export function ApexApp({ starred, trashed }: { starred?: boolean; trashed?: boolean } = {}) {
  return <ApexProjectsApp starred={starred} trashed={trashed} />
}
export function KeyframeApp({ trashed }: { trashed?: boolean } = {}) {
  return <AnimationsListApp trashed={trashed} />
}
export function MotionApp({ trashed }: { trashed?: boolean } = {}) {
  return <VideoProjectsListApp trashed={trashed} />
}
export function PdfWriterListApp({ starred, trashed }: { starred?: boolean; trashed?: boolean } = {}) {
  return <PdfWriterApp starred={starred} trashed={trashed} />
}

// ── Liste des scènes Vertex ───────────────────────────────────────────────────
export function VertexScenesApp({
  starred, trashed,
}: { starred?: boolean; trashed?: boolean }) {
  const navigate    = useNavigate()
  const qc          = useQueryClient()
  const { t, i18n } = useTranslation('paintsharp')
  const [menu, setMenu] = useState<{ id: string; pos: MenuDropdownPos } | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['paintsharp-scenes', { starred, trashed }],
    queryFn:  () => paintsharpApi.listScenes({ starred, trashed }).then(r => r.data.scenes),
  })

  const createMut = useMutation({
    mutationFn: () => paintsharpApi.createScene({ title: t('common_untitled') }),
    onSuccess:  (res) => navigate(`/paintsharp/scene/${res.data.id}`),
  })

  const trashMut = useMutation({
    mutationFn: (id: string) => paintsharpApi.trashScene(id),
    onSuccess:  () => { qc.invalidateQueries({ queryKey: ['paintsharp-scenes'] }); setMenu(null) },
  })

  const restoreMut = useMutation({
    mutationFn: (id: string) => paintsharpApi.restoreScene(id),
    onSuccess:  () => { qc.invalidateQueries({ queryKey: ['paintsharp-scenes'] }); setMenu(null) },
  })

  const deleteMut = useMutation({
    mutationFn: (id: string) => paintsharpApi.deleteScene(id),
    onSuccess:  () => { qc.invalidateQueries({ queryKey: ['paintsharp-scenes'] }); setMenu(null) },
  })

  const starMut = useMutation({
    mutationFn: ({ id, val }: { id: string; val: boolean }) =>
      paintsharpApi.updateScene(id, { is_starred: val }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['paintsharp-scenes'] }),
  })

  const title  = starred ? t('paintsharp_vertex_title_starred') : trashed ? t('paintsharp_vertex_title_trash') : t('paintsharp_vertex_title_scenes')
  const scenes = data ?? []

  const grid = (
      <div className="flex-1 overflow-y-auto p-6">
        {isLoading && (
          <div className="flex items-center justify-center h-32">
            <p className="text-sm text-text-tertiary">{t('common_loading')}</p>
          </div>
        )}

        {!isLoading && scenes.length === 0 && (
          <div className="flex flex-col items-center justify-center h-64 gap-4">
            <Box size={48} className="text-text-tertiary opacity-40" />
            <p className="text-sm text-text-secondary">
              {trashed ? t('paintsharp_empty_scenes_trash') :
               starred ? t('paintsharp_empty_scenes_starred') :
               t('paintsharp_empty_scenes')}
            </p>
            {!trashed && !starred && (
              <Button icon={<Plus size={15} />} onClick={() => createMut.mutate()}>
                {t('paintsharp_create_scene')}
              </Button>
            )}
          </div>
        )}

        {!isLoading && scenes.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
            {scenes.map((scene) => (
              <SceneCard
                key={scene.id}
                scene={scene}
                trashed={trashed}
                menu={menu}
                setMenu={setMenu}
                onOpen={() => navigate(`/paintsharp/scene/${scene.id}`)}
                onStar={(val) => starMut.mutate({ id: scene.id, val })}
                onTrash={() => trashMut.mutate(scene.id)}
                onRestore={() => restoreMut.mutate(scene.id)}
                onDelete={() => deleteMut.mutate(scene.id)}
              />
            ))}
          </div>
        )}
      </div>
  )

  // Ouverture d'un fichier .kbscn depuis le navigateur → éditeur Vertex.
  const handleOpenFile = (file: FileItem): boolean => {
    paintsharpApi.openByFile(file.id).then(({ id }) => navigate(`/paintsharp/scene/${id}`)).catch(() => {})
    return true
  }

  // Vue par défaut : StartPage (récents + navigation des répertoires via ModuleFileBrowser).
  if (!starred && !trashed) {
    const recentItems: StartPageRecentItem[] = scenes.slice(0, 12).map(s => ({
      id:       s.id,
      name:     s.title || t('common_untitled'),
      subtitle: format(new Date(s.updated_at), 'd MMM', { locale: getDateLocale(i18n.language) }),
      icon:     <Box size={18} className="text-text-tertiary" strokeWidth={1.5} />,
      onClick:  () => navigate(`/paintsharp/scene/${s.id}`),
      actions: [
        { id: 'open',  label: t('paintsharp_open', { defaultValue: 'Ouvrir' }), icon: <ExternalLink size={15} />, onClick: () => navigate(`/paintsharp/scene/${s.id}`) },
        { id: 'trash', label: t('common_move_to_trash', { defaultValue: 'Mettre à la corbeille' }), icon: <Trash2 size={15} />, danger: true, onClick: () => trashMut.mutate(s.id) },
      ],
    }))
    return (
      <ModuleStartPage
        recentTitle={t('paintsharp_recent', { defaultValue: 'Récents' })}
        recentItems={recentItems}
        recentEmpty={
          <div className="flex flex-col items-center gap-2">
            <Box size={32} className="text-text-tertiary opacity-30" strokeWidth={1.5} />
            <p className="text-text-tertiary text-xs">{t('paintsharp_empty_scenes')}</p>
          </div>
        }
        browse={{
          folderPathPrefix: 'PaintSharp/Vertex',
          title: t('paintsharp_vertex_title_scenes'),
          fileTypeModuleId: 'paintsharp-vertex',
          onOpenFile: handleOpenFile,
          toolbarContent: (
            <Button size="sm" icon={<Plus size={14} />} onClick={() => createMut.mutate()} loading={createMut.isPending}>
              {t('paintsharp_new_scene')}
            </Button>
          ),
        }}
      />
    )
  }

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--body-bg)' }}>
      <div className="flex items-center justify-between px-6 py-4 border-b border-border">
        <div className="flex items-center gap-2">
          <Box size={18} className="text-text-secondary" />
          <h1 className="text-base font-medium text-text-primary">{title}</h1>
          {scenes.length > 0 && (
            <span className="text-sm text-text-tertiary">({scenes.length})</span>
          )}
        </div>
      </div>
      {grid}
    </div>
  )
}

// ── Composant racine ──────────────────────────────────────────────────────────
export default function PaintsharpApp() {
  return <PaintsharpSuiteHome />
}

// ── Carte de scène ────────────────────────────────────────────────────────────
function SceneCard({
  scene, trashed, menu, setMenu, onOpen, onStar, onTrash, onRestore, onDelete,
}: {
  scene:      SceneSummary
  trashed?:   boolean
  menu:       { id: string; pos: MenuDropdownPos } | null
  setMenu:    (m: { id: string; pos: MenuDropdownPos } | null) => void
  onOpen:     () => void
  onStar:     (val: boolean) => void
  onTrash:    () => void
  onRestore:  () => void
  onDelete:   () => void
}) {
  const { t, i18n } = useTranslation('paintsharp')
  const isMenuOpen = menu?.id === scene.id

  const menuItems: MenuItem[] = !trashed
    ? [
        { type: 'action', label: scene.is_starred ? t('paintsharp_unstar') : t('paintsharp_star'),
          icon: <Star size={13} className={scene.is_starred ? 'text-warning fill-warning' : ''} />,
          onClick: () => onStar(!scene.is_starred) },
        { type: 'action', label: t('common_rename'), icon: <Pencil size={13} />, onClick: () => {} },
        { type: 'separator' },
        { type: 'action', label: t('paintsharp_move_to_trash'), icon: <Trash2 size={13} />, danger: true, onClick: onTrash },
      ]
    : [
        { type: 'action', label: t('paintsharp_restore'), icon: <RotateCcw size={13} />, onClick: onRestore },
        { type: 'action', label: t('paintsharp_delete_forever'), icon: <Trash2 size={13} />, danger: true, onClick: onDelete },
      ]

  return (
    <div className="group relative rounded-xl overflow-hidden border border-border
                    hover:border-border-strong transition-all hover:shadow-sm bg-surface-0">
      <button className="block w-full aspect-video relative" onClick={onOpen}
              style={{ background: '#1a1a2e' }}>
        {scene.thumbnail_url ? (
          <img src={scene.thumbnail_url} alt={scene.title} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <Box size={32} style={{ color: '#e8824a', opacity: 0.6 }} />
          </div>
        )}
        {(scene.vertex_count > 0 || scene.face_count > 0) && (
          <div className="absolute bottom-1.5 left-1.5 flex gap-1">
            {scene.vertex_count > 0 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded"
                    style={{ background: 'rgba(0,0,0,0.6)', color: '#aaa' }}>
                {fmtCount(scene.vertex_count)}V
              </span>
            )}
            {scene.face_count > 0 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded"
                    style={{ background: 'rgba(0,0,0,0.6)', color: '#aaa' }}>
                {fmtCount(scene.face_count)}F
              </span>
            )}
          </div>
        )}
      </button>

      <div className="px-2.5 py-2">
        <div className="flex items-start justify-between gap-1">
          <button onClick={onOpen}
                  className="text-sm font-medium text-text-primary truncate text-left flex-1 hover:text-primary transition-colors">
            {scene.title}
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation()
              const r = e.currentTarget.getBoundingClientRect()
              setMenu(isMenuOpen ? null : { id: scene.id, pos: { top: r.bottom + 4, left: r.right - 176 } })
            }}
            className="p-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity
                       text-text-tertiary hover:text-text-primary hover:bg-surface-2"
          >
            <MoreVertical size={14} />
          </button>
          {isMenuOpen && menu && (
            <MenuDropdown pos={menu.pos} onClose={() => setMenu(null)} items={menuItems} />
          )}
        </div>
        <p className="text-xs text-text-tertiary mt-0.5">
          <Clock size={10} className="inline mr-1" />
          {formatDistanceToNow(new Date(scene.updated_at), { addSuffix: true, locale: getDateLocale(i18n.language) })}
        </p>
      </div>
    </div>
  )
}

function fmtCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `${(n / 1_000).toFixed(0)}k`
  return String(n)
}
