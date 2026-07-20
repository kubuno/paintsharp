import { useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Plus, Type, Clock, Star, Trash2, MoreVertical, Pencil, RotateCcw, Copy, ExternalLink, Upload } from 'lucide-react'
import { fontApi, type FontProjectSummary } from './api'
import { format, formatDistanceToNow } from 'date-fns'
import { useTranslation } from 'react-i18next'
import { getDateLocale } from '@kubuno/sdk'
import { Button, MenuDropdown, type MenuItem, type MenuDropdownPos } from '@ui'
import type { StartPageRecentItem } from '@ui'
import { ModuleStartPage } from '@kubuno/drive'
import type { FileItem } from '@kubuno/drive'

export function FontProjectsApp({
  starred, trashed,
}: { starred?: boolean; trashed?: boolean }) {
  const { t, i18n } = useTranslation('paintsharp')
  const navigate = useNavigate()
  const qc       = useQueryClient()
  const [menu, setMenu] = useState<{ id: string; pos: MenuDropdownPos } | null>(null)
  const importInputRef = useRef<HTMLInputElement>(null)
  const [importing, setImporting] = useState(false)

  // Import a picked font file (ttf/otf/woff/woff2/eot/svg) as a new project.
  const handleImportPicked = (f: File) => {
    setImporting(true)
    import('./fontFormats')
      .then(({ importPickedFontAsProject }) => importPickedFontAsProject(f))
      .then(id => navigate(`/paintsharp/fonteditor/${id}`))
      .catch(() => setImporting(false))
  }

  const { data, isLoading } = useQuery({
    queryKey: ['paintsharp-fonts', { starred, trashed }],
    queryFn:  () => fontApi.listProjects({ starred, trashed }).then(r => r.data.projects),
  })

  const createMut = useMutation({
    mutationFn: () => fontApi.createProject({ title: t('fontproj_default_title') }),
    onSuccess:  (res) => navigate(`/paintsharp/fonteditor/${res.data.id}`),
  })

  const trashMut = useMutation({
    mutationFn: (id: string) => fontApi.trashProject(id),
    onSuccess:  () => { qc.invalidateQueries({ queryKey: ['paintsharp-fonts'] }); setMenu(null) },
  })

  const restoreMut = useMutation({
    mutationFn: (id: string) => fontApi.restoreProject(id),
    onSuccess:  () => { qc.invalidateQueries({ queryKey: ['paintsharp-fonts'] }); setMenu(null) },
  })

  const deleteMut = useMutation({
    mutationFn: (id: string) => fontApi.deleteProject(id),
    onSuccess:  () => { qc.invalidateQueries({ queryKey: ['paintsharp-fonts'] }); setMenu(null) },
  })

  const starMut = useMutation({
    mutationFn: ({ id, val }: { id: string; val: boolean }) =>
      fontApi.updateProject(id, { is_starred: val }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['paintsharp-fonts'] }),
  })

  const duplicateMut = useMutation({
    mutationFn: (id: string) => fontApi.duplicateProject(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['paintsharp-fonts'] }); setMenu(null) },
  })

  const title    = starred ? t('fontproj_title_starred') : trashed ? t('fontproj_title_trashed') : t('fontproj_title')
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
          <Type size={48} className="text-text-tertiary opacity-40" />
          <p className="text-sm text-text-secondary">
            {trashed ? t('fontproj_empty_trashed') :
             starred ? t('fontproj_empty_starred') :
             t('fontproj_empty')}
          </p>
          {!trashed && !starred && (
            <Button icon={<Plus size={15} />} onClick={() => createMut.mutate()}>
              {t('fontproj_create_project')}
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
              onOpen={() => navigate(`/paintsharp/fonteditor/${project.id}`)}
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

  // Opening a .kbfnt file from the browser → FontEditor.
  const handleOpenFile = (file: FileItem): boolean => {
    fontApi.openByFile(file.id).then(({ id }) => navigate(`/paintsharp/fonteditor/${id}`)).catch(() => {})
    return true
  }

  // Default view: StartPage (recents + directory browsing via ModuleFileBrowser).
  if (!starred && !trashed) {
    const recentItems: StartPageRecentItem[] = projects.slice(0, 12).map(p => ({
      id:       p.id,
      name:     p.title || t('fontproj_default_title'),
      subtitle: format(new Date(p.updated_at), 'd MMM', { locale: getDateLocale(i18n.language) }),
      icon:     <Type size={18} className="text-text-tertiary" strokeWidth={1.5} />,
      onClick:  () => navigate(`/paintsharp/fonteditor/${p.id}`),
      actions: [
        { id: 'open',  label: t('fontproj_open', { defaultValue: 'Ouvrir' }), icon: <ExternalLink size={15} />, onClick: () => navigate(`/paintsharp/fonteditor/${p.id}`) },
        { id: 'dup',   label: t('common_duplicate'),                          icon: <Copy size={15} />,         onClick: () => duplicateMut.mutate(p.id) },
        { id: 'trash', label: t('fontproj_move_to_trash'),                    icon: <Trash2 size={15} />, danger: true, onClick: () => trashMut.mutate(p.id) },
      ],
    }))
    return (
      <ModuleStartPage
        recentTitle={t('fontproj_recent', { defaultValue: 'Récents' })}
        recentItems={recentItems}
        recentEmpty={
          <div className="flex flex-col items-center gap-2">
            <Type size={32} className="text-text-tertiary opacity-30" strokeWidth={1.5} />
            <p className="text-text-tertiary text-xs">{t('fontproj_empty')}</p>
          </div>
        }
        browse={{
          folderPathPrefix: 'PaintSharp/FontEditor',
          title: t('fontproj_title'),
          fileTypeModuleId: 'paintsharp-fonteditor',
          onOpenFile: handleOpenFile,
          toolbarContent: (
            <>
              <input ref={importInputRef} type="file" accept=".ttf,.otf,.woff,.woff2,.eot,.svg" style={{ display: 'none' }}
                     onChange={e => {
                       const f = e.target.files?.[0]
                       if (f) handleImportPicked(f)
                       e.target.value = ''
                     }} />
              <Button size="sm" icon={<Upload size={14} />} onClick={() => importInputRef.current?.click()} loading={importing}>
                {t('fontproj_import')}
              </Button>
              <Button size="sm" icon={<Plus size={14} />} onClick={() => createMut.mutate()} loading={createMut.isPending}>
                {t('fontproj_new_project')}
              </Button>
            </>
          ),
        }}
      />
    )
  }

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--body-bg)' }}>
      <div className="flex items-center justify-between px-6 py-4 border-b border-border">
        <div className="flex items-center gap-2">
          <Type size={18} className="text-text-secondary" />
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
  project:     FontProjectSummary
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
        { type: 'action', label: project.is_starred ? t('fontproj_unstar') : t('fontproj_star'),
          icon: <Star size={13} className={project.is_starred ? 'text-warning fill-warning' : ''} />,
          onClick: () => onStar(!project.is_starred) },
        { type: 'action', label: t('common_rename'), icon: <Pencil size={13} />, onClick: () => {} },
        { type: 'action', label: t('common_duplicate'), icon: <Copy size={13} />, onClick: onDuplicate },
        { type: 'separator' },
        { type: 'action', label: t('fontproj_move_to_trash'), icon: <Trash2 size={13} />, danger: true, onClick: onTrash },
      ]
    : [
        { type: 'action', label: t('fontproj_restore'), icon: <RotateCcw size={13} />, onClick: onRestore },
        { type: 'action', label: t('fontproj_delete_forever'), icon: <Trash2 size={13} />, danger: true, onClick: onDelete },
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
            <Type size={32} style={{ color: '#a04ae8', opacity: 0.6 }} />
          </div>
        )}
        {project.glyph_count > 0 && (
          <span className="absolute bottom-1.5 left-1.5 text-[10px] px-1.5 py-0.5 rounded"
                style={{ background: 'rgba(0,0,0,0.6)', color: '#aaa' }}>
            {t('fontproj_glyph_count', { count: project.glyph_count })}
          </span>
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
