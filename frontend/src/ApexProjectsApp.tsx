import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Plus, PenTool, Clock, Star, Trash2, MoreVertical, Pencil, RotateCcw, Copy, ExternalLink } from 'lucide-react'
import { apexApi, type VectorProjectSummary } from './api'
import { format, formatDistanceToNow } from 'date-fns'
import { useTranslation } from 'react-i18next'
import { getDateLocale } from '@kubuno/sdk'
import { Button, MenuDropdown, type MenuItem, type MenuDropdownPos } from '@ui'
import type { StartPageRecentItem } from '@ui'
import { ModuleStartPage } from '@kubuno/drive'
import type { FileItem } from '@kubuno/drive'
export function ApexProjectsApp({
  starred, trashed,
}: { starred?: boolean; trashed?: boolean }) {
  const { t, i18n } = useTranslation('paintsharp')
  const navigate = useNavigate()
  const qc       = useQueryClient()
  const [menu, setMenu] = useState<{ id: string; pos: MenuDropdownPos } | null>(null)
  const [createError, setCreateError] = useState<string | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['paintsharp-vectors', { starred, trashed }],
    queryFn:  () => apexApi.listProjects({ starred, trashed }).then(r => r.data.projects),
  })

  const createMut = useMutation({
    mutationFn: () => apexApi.createProject({ title: t('apexproj_default_title') }),
    onSuccess:  (res) => navigate(`/paintsharp/apex/${res.data.id}`),
    onError:    (err: unknown) => {
      const msg = (err as { message?: string })?.message ?? t('apexproj_unknown_error')
      setCreateError(msg)
    },
  })

  const trashMut = useMutation({
    mutationFn: (id: string) => apexApi.trashProject(id),
    onSuccess:  () => { qc.invalidateQueries({ queryKey: ['paintsharp-vectors'] }); setMenu(null) },
  })

  const restoreMut = useMutation({
    mutationFn: (id: string) => apexApi.restoreProject(id),
    onSuccess:  () => { qc.invalidateQueries({ queryKey: ['paintsharp-vectors'] }); setMenu(null) },
  })

  const deleteMut = useMutation({
    mutationFn: (id: string) => apexApi.deleteProject(id),
    onSuccess:  () => { qc.invalidateQueries({ queryKey: ['paintsharp-vectors'] }); setMenu(null) },
  })

  const starMut = useMutation({
    mutationFn: ({ id, val }: { id: string; val: boolean }) =>
      apexApi.updateProject(id, { is_starred: val }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['paintsharp-vectors'] }),
  })

  const duplicateMut = useMutation({
    mutationFn: (id: string) => apexApi.duplicateProject(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['paintsharp-vectors'] }); setMenu(null) },
  })

  const title    = starred ? t('apexproj_title_starred') : trashed ? t('apexproj_title_trashed') : t('apexproj_title')
  const projects = data ?? []

  const grid = (
    <div className="flex-1 overflow-y-auto p-6">
      {isLoading && (
        <div className="flex items-center justify-center h-32">
          <p className="text-sm text-text-tertiary">{t('common_loading')}</p>
        </div>
      )}

      {!isLoading && projects.length === 0 && (
        <div className="flex flex-col items-center justify-center h-64 gap-4">
          <PenTool size={48} className="text-text-tertiary opacity-40" />
          <p className="text-sm text-text-secondary">
            {trashed ? t('apexproj_empty_trashed') :
             starred ? t('apexproj_empty_starred') :
             t('apexproj_empty')}
          </p>
          {!trashed && !starred && (
            <Button icon={<Plus size={15} />} onClick={() => createMut.mutate()}>
              {t('apexproj_create_project')}
            </Button>
          )}
        </div>
      )}

      {!isLoading && projects.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
          {projects.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              trashed={trashed}
              menu={menu}
              setMenu={setMenu}
              onOpen={() => navigate(`/paintsharp/apex/${project.id}`)}
              onStar={(val) => starMut.mutate({ id: project.id, val })}
              onTrash={() => trashMut.mutate(project.id)}
              onRestore={() => restoreMut.mutate(project.id)}
              onDelete={() => deleteMut.mutate(project.id)}
              onDuplicate={() => duplicateMut.mutate(project.id)}
            />
          ))}
        </div>
      )}
    </div>
  )

  // Ouverture d'un fichier .kbvec depuis le navigateur → éditeur Apex.
  const handleOpenFile = (file: FileItem): boolean => {
    apexApi.openByFile(file.id).then(({ id }) => navigate(`/paintsharp/apex/${id}`)).catch(() => {})
    return true
  }

  // Vue par défaut : StartPage (récents + navigation des répertoires via ModuleFileBrowser).
  if (!starred && !trashed) {
    const recentItems: StartPageRecentItem[] = projects.slice(0, 12).map(p => ({
      id:       p.id,
      name:     p.title || t('apexproj_default_title'),
      subtitle: format(new Date(p.updated_at), 'd MMM', { locale: getDateLocale(i18n.language) }),
      icon:     <PenTool size={18} className="text-text-tertiary" strokeWidth={1.5} />,
      onClick:  () => navigate(`/paintsharp/apex/${p.id}`),
      actions: [
        { id: 'open',  label: t('apexproj_open', { defaultValue: 'Ouvrir' }), icon: <ExternalLink size={15} />, onClick: () => navigate(`/paintsharp/apex/${p.id}`) },
        { id: 'dup',   label: t('common_duplicate'),                          icon: <Copy size={15} />,         onClick: () => duplicateMut.mutate(p.id) },
        { id: 'trash', label: t('apexproj_move_to_trash'),                    icon: <Trash2 size={15} />, danger: true, onClick: () => trashMut.mutate(p.id) },
      ],
    }))
    return (
      <div className="flex flex-col h-full">
        {createError && (
          <div className="flex items-center justify-between px-4 py-2 text-sm bg-danger-light text-danger border-b border-danger/20">
            <span>{t('apexproj_create_error', { message: createError })}</span>
            <button onClick={() => setCreateError(null)} className="ml-4 font-bold">×</button>
          </div>
        )}
        <div className="flex-1 min-h-0">
          <ModuleStartPage
            recentTitle={t('apexproj_recent', { defaultValue: 'Récents' })}
            recentItems={recentItems}
            recentEmpty={
              <div className="flex flex-col items-center gap-2">
                <PenTool size={32} className="text-text-tertiary opacity-30" strokeWidth={1.5} />
                <p className="text-text-tertiary text-xs">{t('apexproj_empty')}</p>
              </div>
            }
            browse={{
              folderPathPrefix: 'PaintSharp/Apex',
              title: t('apexproj_title'),
              fileTypeModuleId: 'paintsharp-apex',
              onOpenFile: handleOpenFile,
              toolbarContent: (
                <Button size="sm" icon={<Plus size={14} />} onClick={() => createMut.mutate()} loading={createMut.isPending}>
                  {t('apexproj_new_project')}
                </Button>
              ),
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
          <span>{t('apexproj_create_error', { message: createError })}</span>
          <button onClick={() => setCreateError(null)} className="ml-4 font-bold">×</button>
        </div>
      )}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border">
        <div className="flex items-center gap-2">
          <PenTool size={18} className="text-text-secondary" />
          <h1 className="text-base font-medium text-text-primary">{title}</h1>
          {projects.length > 0 && (
            <span className="text-sm text-text-tertiary">({projects.length})</span>
          )}
        </div>
      </div>
      {grid}
    </div>
  )
}

function ProjectCard({
  project, trashed, menu, setMenu, onOpen, onStar, onTrash, onRestore, onDelete, onDuplicate,
}: {
  project:     VectorProjectSummary
  trashed?:    boolean
  menu:        { id: string; pos: MenuDropdownPos } | null
  setMenu:     (m: { id: string; pos: MenuDropdownPos } | null) => void
  onOpen:      () => void
  onStar:      (val: boolean) => void
  onTrash:     () => void
  onRestore:   () => void
  onDelete:    () => void
  onDuplicate: () => void
}) {
  const { t, i18n } = useTranslation('paintsharp')
  const isMenuOpen = menu?.id === project.id

  const menuItems: MenuItem[] = !trashed
    ? [
        { type: 'action', label: project.is_starred ? t('apexproj_unstar') : t('apexproj_star'),
          icon: <Star size={13} className={project.is_starred ? 'text-warning fill-warning' : ''} />,
          onClick: () => onStar(!project.is_starred) },
        { type: 'action', label: t('common_rename'), icon: <Pencil size={13} />, onClick: () => {} },
        { type: 'action', label: t('common_duplicate'), icon: <Copy size={13} />, onClick: onDuplicate },
        { type: 'separator' },
        { type: 'action', label: t('apexproj_move_to_trash'), icon: <Trash2 size={13} />, danger: true, onClick: onTrash },
      ]
    : [
        { type: 'action', label: t('apexproj_restore'), icon: <RotateCcw size={13} />, onClick: onRestore },
        { type: 'action', label: t('apexproj_delete_forever'), icon: <Trash2 size={13} />, danger: true, onClick: onDelete },
      ]

  return (
    <div className="group relative rounded-xl overflow-hidden border border-border
                    hover:border-border-strong transition-all hover:shadow-sm bg-surface-0">
      <button
        className="block w-full aspect-video relative"
        onClick={onOpen}
        style={{ background: '#1e1e1e' }}
      >
        {project.thumbnail_path ? (
          <img src={project.thumbnail_path} alt={project.title} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <PenTool size={32} style={{ color: '#e84a90', opacity: 0.6 }} />
          </div>
        )}
      </button>

      <div className="px-2.5 py-2">
        <div className="flex items-start justify-between gap-1">
          <button onClick={onOpen}
                  className="text-sm font-medium text-text-primary truncate text-left flex-1 hover:text-primary transition-colors">
            {project.title}
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation()
              const r = e.currentTarget.getBoundingClientRect()
              setMenu(isMenuOpen ? null : { id: project.id, pos: { top: r.bottom + 4, left: r.right - 176 } })
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
          {formatDistanceToNow(new Date(project.updated_at), { addSuffix: true, locale: getDateLocale(i18n.language) })}
        </p>
      </div>
    </div>
  )
}
