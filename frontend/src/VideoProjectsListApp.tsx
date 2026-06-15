import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Plus, Film, Clock, Trash2, MoreVertical, RotateCcw, Copy, ExternalLink } from 'lucide-react'
import { motionApi, type VideoProjectSummary } from './api'
import { format, formatDistanceToNow } from 'date-fns'
import { useTranslation } from 'react-i18next'
import { getDateLocale } from '@kubuno/sdk'
import { Button, MenuDropdown, type MenuItem, type MenuDropdownPos } from '@ui'
import type { StartPageRecentItem } from '@ui'
import { ModuleStartPage } from '@kubuno/drive'
import type { FileItem } from '@kubuno/drive'
const PRESETS = [
  { label: '4K UHD (3840×2160) 25 fps',  w: 3840, h: 2160, fps: 25,  dur: 750 },
  { label: 'Full HD (1920×1080) 25 fps',  w: 1920, h: 1080, fps: 25,  dur: 750 },
  { label: 'Full HD (1920×1080) 30 fps',  w: 1920, h: 1080, fps: 30,  dur: 900 },
  { label: 'Full HD (1920×1080) 60 fps',  w: 1920, h: 1080, fps: 60,  dur: 1800 },
  { label: 'HD 720 (1280×720) 25 fps',   w: 1280, h: 720,  fps: 25,  dur: 750 },
  { label: 'Social (1080×1080) 30 fps',  w: 1080, h: 1080, fps: 30,  dur: 900 },
  { label: 'Vertical (1080×1920) 30 fps', w: 1080, h: 1920, fps: 30,  dur: 900 },
  { label: 'Cinéma (2048×858) 24 fps',   w: 2048, h: 858,  fps: 24,  dur: 720 },
]

export function VideoProjectsListApp({ trashed }: { trashed?: boolean }) {
  const { t, i18n } = useTranslation('paintsharp')
  const navigate  = useNavigate()
  const qc        = useQueryClient()
  const [menu, setMenu]           = useState<{ id: string; pos: MenuDropdownPos } | null>(null)
  const [newPos, setNewPos]       = useState<MenuDropdownPos | null>(null)
  const [createError, setCreateError] = useState<string | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['motion-projects', { trashed }],
    queryFn:  () => motionApi.listProjects({ trashed }).then(r => r.data.projects),
  })

  const createMut = useMutation({
    mutationFn: (opts?: { w?: number; h?: number; fps?: number; dur?: number }) =>
      motionApi.createProject(opts
        ? { composition: { width: opts.w, height: opts.h, fps: opts.fps, duration_frames: opts.dur } }
        : undefined,
      ),
    onSuccess: (res) => navigate(`/paintsharp/motion/${res.data.id}`),
    onError:   (err: unknown) => {
      setCreateError((err as { message?: string })?.message ?? t('videolist_error_unknown'))
    },
  })

  const createDefault = () => createMut.mutate({})

  const trashMut = useMutation({
    mutationFn: (id: string) => motionApi.trashProject(id),
    onSuccess:  () => { qc.invalidateQueries({ queryKey: ['motion-projects'] }); setMenu(null) },
  })

  const restoreMut = useMutation({
    mutationFn: (id: string) => motionApi.restoreProject(id),
    onSuccess:  () => { qc.invalidateQueries({ queryKey: ['motion-projects'] }); setMenu(null) },
  })

  const deleteMut = useMutation({
    mutationFn: (id: string) => motionApi.deleteProject(id),
    onSuccess:  () => { qc.invalidateQueries({ queryKey: ['motion-projects'] }); setMenu(null) },
  })

  const duplicateMut = useMutation({
    mutationFn: (id: string) => motionApi.duplicateProject(id),
    onSuccess:  () => { qc.invalidateQueries({ queryKey: ['motion-projects'] }); setMenu(null) },
  })

  const title = trashed ? t('videolist_title_trash') : t('videolist_title')
  const items = data ?? []

  const newButton = !trashed ? (
    <div>
      <Button icon={<Plus size={15} />}
        onClick={e => { const r = e.currentTarget.getBoundingClientRect(); setNewPos(p => p ? null : { top: r.bottom + 4, left: r.right - 288 }) }}
        loading={createMut.isPending}>
        {t('videolist_new')}
      </Button>
      {newPos && (
        <MenuDropdown
          pos={{ ...newPos, minWidth: 288 }}
          onClose={() => setNewPos(null)}
          items={[
            ...PRESETS.map<MenuItem>(p => ({
              type: 'action', label: p.label, shortcut: `${p.fps}fps`,
              onClick: () => createMut.mutate({ w: p.w, h: p.h, fps: p.fps, dur: p.dur }),
            })),
            { type: 'separator' },
            { type: 'action', label: t('videolist_preset_default'), onClick: () => createDefault() },
          ]}
        />
      )}
    </div>
  ) : null

  const grid = (
      <div className="flex-1 overflow-y-auto p-6">
        {isLoading && (
          <div className="flex items-center justify-center h-32">
            <p className="text-sm text-text-tertiary">{t('common_loading')}</p>
          </div>
        )}

        {!isLoading && items.length === 0 && (
          <div className="flex flex-col items-center justify-center h-64 gap-4">
            <Film size={48} className="text-text-tertiary opacity-40" />
            <p className="text-sm text-text-secondary">
              {trashed ? t('videolist_empty_trash') : t('videolist_empty')}
            </p>
            {!trashed && (
              <Button icon={<Plus size={15} />} onClick={createDefault}>
                {t('videolist_create')}
              </Button>
            )}
          </div>
        )}

        {!isLoading && items.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
            {items.map((proj) => (
              <VideoCard
                key={proj.id}
                proj={proj}
                trashed={trashed}
                menu={menu}
                setMenu={setMenu}
                onOpen={() => navigate(`/paintsharp/motion/${proj.id}`)}
                onTrash={() => trashMut.mutate(proj.id)}
                onRestore={() => restoreMut.mutate(proj.id)}
                onDelete={() => deleteMut.mutate(proj.id)}
                onDuplicate={() => duplicateMut.mutate(proj.id)}
              />
            ))}
          </div>
        )}
      </div>
  )

  // Ouverture d'un fichier .kbmot depuis le navigateur → éditeur Motion.
  const handleOpenFile = (file: FileItem): boolean => {
    motionApi.openByFile(file.id).then(({ id }) => navigate(`/paintsharp/motion/${id}`)).catch(() => {})
    return true
  }

  // Vue par défaut : StartPage (récents + navigation des répertoires via ModuleFileBrowser).
  if (!trashed) {
    const recentItems: StartPageRecentItem[] = items.slice(0, 12).map(p => ({
      id:       p.id,
      name:     p.title || t('videolist_title'),
      subtitle: format(new Date(p.updated_at), 'd MMM', { locale: getDateLocale(i18n.language) }),
      icon:     <Film size={18} className="text-text-tertiary" strokeWidth={1.5} />,
      onClick:  () => navigate(`/paintsharp/motion/${p.id}`),
      actions: [
        { id: 'open',  label: t('videolist_open', { defaultValue: 'Ouvrir' }), icon: <ExternalLink size={15} />, onClick: () => navigate(`/paintsharp/motion/${p.id}`) },
        { id: 'dup',   label: t('common_duplicate'),                           icon: <Copy size={15} />,         onClick: () => duplicateMut.mutate(p.id) },
        { id: 'trash', label: t('common_move_to_trash', { defaultValue: 'Mettre à la corbeille' }), icon: <Trash2 size={15} />, danger: true, onClick: () => trashMut.mutate(p.id) },
      ],
    }))
    return (
      <div className="flex flex-col h-full">
        {createError && (
          <div className="flex items-center justify-between px-4 py-2 text-sm bg-danger-light text-danger border-b border-danger/20">
            <span>{t('videolist_create_error', { error: createError })}</span>
            <button onClick={() => setCreateError(null)} className="ml-4 font-bold">×</button>
          </div>
        )}
        <div className="flex-1 min-h-0">
          <ModuleStartPage
            recentTitle={t('videolist_recent', { defaultValue: 'Récents' })}
            recentItems={recentItems}
            recentEmpty={
              <div className="flex flex-col items-center gap-2">
                <Film size={32} className="text-text-tertiary opacity-30" strokeWidth={1.5} />
                <p className="text-text-tertiary text-xs">{t('videolist_empty')}</p>
              </div>
            }
            browse={{
              folderPathPrefix: 'PaintSharp/Motion',
              title: t('videolist_title'),
              fileTypeModuleId: 'paintsharp-motion',
              onOpenFile: handleOpenFile,
              toolbarContent: newButton,
            }}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--body-bg)' }}>
      {createError && (
        <div className="flex items-center justify-between px-4 py-2 text-sm bg-danger-light text-danger border-b border-danger/20">
          <span>{t('videolist_create_error', { error: createError })}</span>
          <button onClick={() => setCreateError(null)} className="ml-4 font-bold">×</button>
        </div>
      )}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border">
        <div className="flex items-center gap-2">
          <Film size={18} className="text-text-secondary" />
          <h1 className="text-base font-medium text-text-primary">{title}</h1>
          {items.length > 0 && (
            <span className="text-sm text-text-tertiary">({items.length})</span>
          )}
        </div>
        {newButton}
      </div>
      {grid}
    </div>
  )
}

function VideoCard({
  proj, trashed, menu, setMenu, onOpen, onTrash, onRestore, onDelete, onDuplicate,
}: {
  proj:        VideoProjectSummary
  trashed?:    boolean
  menu:        { id: string; pos: MenuDropdownPos } | null
  setMenu:     (m: { id: string; pos: MenuDropdownPos } | null) => void
  onOpen:      () => void
  onTrash:     () => void
  onRestore:   () => void
  onDelete:    () => void
  onDuplicate: () => void
}) {
  const { t, i18n } = useTranslation('paintsharp')
  const isMenuOpen = menu?.id === proj.id
  const comp = proj.composition
  const durationSec = (comp.duration_frames / comp.fps).toFixed(1)

  const menuItems: MenuItem[] = !trashed
    ? [
        { type: 'action', label: t('common_duplicate'), icon: <Copy size={13} />, onClick: onDuplicate },
        { type: 'separator' },
        { type: 'action', label: t('videolist_to_trash'), icon: <Trash2 size={13} />, danger: true, onClick: onTrash },
      ]
    : [
        { type: 'action', label: t('videolist_restore'), icon: <RotateCcw size={13} />, onClick: onRestore },
        { type: 'action', label: t('videolist_delete_forever'), icon: <Trash2 size={13} />, danger: true, onClick: onDelete },
      ]

  return (
    <div className="group relative rounded-xl overflow-hidden border border-border
                    hover:border-border-strong transition-all hover:shadow-sm bg-surface-0">
      <button
        className="block w-full aspect-video relative"
        onClick={onOpen}
        style={{ background: '#0d0d0d' }}
      >
        {proj.thumbnail_path ? (
          <img src={proj.thumbnail_path} alt={proj.title} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center gap-1.5">
            <Film size={28} style={{ color: '#4ae84a', opacity: 0.6 }} />
            <span className="text-[10px]" style={{ color: '#888' }}>
              {comp.width}×{comp.height} · {comp.fps}fps
            </span>
          </div>
        )}
        <div className="absolute bottom-1.5 right-1.5">
          <span className="text-[9px] px-1.5 py-0.5 rounded"
                style={{ background: 'rgba(0,0,0,0.55)', color: '#ccc' }}>
            {durationSec}s
          </span>
        </div>
      </button>

      <div className="px-2.5 py-2">
        <div className="flex items-start justify-between gap-1">
          <button onClick={onOpen}
                  className="text-sm font-medium text-text-primary truncate text-left flex-1 hover:text-primary transition-colors">
            {proj.title}
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation()
              const r = e.currentTarget.getBoundingClientRect()
              setMenu(isMenuOpen ? null : { id: proj.id, pos: { top: r.bottom + 4, left: r.right - 176 } })
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
          {formatDistanceToNow(new Date(proj.updated_at), { addSuffix: true, locale: getDateLocale(i18n.language) })}
        </p>
      </div>
    </div>
  )
}
