import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Plus, Image, Clock, Star, Trash2, MoreVertical, Pencil, RotateCcw, Copy, ExternalLink } from 'lucide-react'
import { layerApi, type LayerDocumentSummary } from './api'
import { format, formatDistanceToNow } from 'date-fns'
import { useTranslation } from 'react-i18next'
import { getDateLocale } from '@kubuno/sdk'
import { Button, MenuDropdown, type MenuItem, type MenuDropdownPos } from '@ui'
import type { StartPageRecentItem } from '@ui'
import { ModuleStartPage } from '@kubuno/drive'
import type { FileItem } from '@kubuno/drive'
import NewLayerDocumentModal, { type NewLayerDocParams } from './NewLayerDocumentModal'

export function LayerDocsApp({
  starred, trashed,
}: { starred?: boolean; trashed?: boolean }) {
  const { t, i18n } = useTranslation('paintsharp')
  const navigate = useNavigate()
  const qc       = useQueryClient()
  const [menu, setMenu] = useState<{ id: string; pos: MenuDropdownPos } | null>(null)
  const [showNewModal, setShowNewModal] = useState(false)

  const { data, isLoading } = useQuery({
    queryKey: ['paintsharp-layer-docs', { starred, trashed }],
    queryFn:  () => layerApi.listDocs({ starred, trashed }).then(r => r.data.documents),
  })

  const [createError, setCreateError] = useState<string | null>(null)

  const createMut = useMutation({
    mutationFn: (opts: Partial<NewLayerDocParams>) =>
      layerApi.createDoc({
        title:      opts.title ?? t('layerdocs_default_title'),
        width:      opts.width,
        height:     opts.height,
        color_mode: opts.color_mode,
        bit_depth:  opts.bit_depth,
        dpi:        opts.dpi,
      }),
    onSuccess: (res) => navigate(`/paintsharp/layer/${res.data.id}`),
    onError:   (err: unknown) => {
      const msg = (err as { message?: string })?.message ?? t('layerdocs_unknown_error')
      setCreateError(msg)
    },
  })

  // Fenêtre flottante « Nouveau document » (façon Photoshop).
  const newModal = showNewModal ? (
    <NewLayerDocumentModal
      onClose={() => setShowNewModal(false)}
      onCreate={(p) => { setShowNewModal(false); createMut.mutate(p) }}
      loading={createMut.isPending}
    />
  ) : null

  const trashMut = useMutation({
    mutationFn: (id: string) => layerApi.trashDoc(id),
    onSuccess:  () => { qc.invalidateQueries({ queryKey: ['paintsharp-layer-docs'] }); setMenu(null) },
  })

  const restoreMut = useMutation({
    mutationFn: (id: string) => layerApi.restoreDoc(id),
    onSuccess:  () => { qc.invalidateQueries({ queryKey: ['paintsharp-layer-docs'] }); setMenu(null) },
  })

  const deleteMut = useMutation({
    mutationFn: (id: string) => layerApi.deleteDoc(id),
    onSuccess:  () => { qc.invalidateQueries({ queryKey: ['paintsharp-layer-docs'] }); setMenu(null) },
  })

  const starMut = useMutation({
    mutationFn: ({ id, val }: { id: string; val: boolean }) =>
      layerApi.updateDoc(id, { is_starred: val }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['paintsharp-layer-docs'] }),
  })

  const duplicateMut = useMutation({
    mutationFn: (id: string) => layerApi.duplicateDoc(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['paintsharp-layer-docs'] }); setMenu(null) },
  })

  const title    = starred ? t('layerdocs_title_starred') : trashed ? t('layerdocs_title_trashed') : t('layerdocs_title')
  const docs     = data ?? []

  // Le bouton « Nouveau » ouvre la fenêtre flottante (plus de menu déroulant de presets).
  const newButton = !trashed ? (
    <Button icon={<Plus size={15} />} onClick={() => setShowNewModal(true)} loading={createMut.isPending}>
      {t('layerdocs_new_doc')}
    </Button>
  ) : null

  const grid = (
      <div className="flex-1 overflow-y-auto p-6">
        {isLoading && (
          <div className="flex items-center justify-center h-32">
            <p className="text-sm text-text-tertiary">{t('common_loading')}</p>
          </div>
        )}

        {!isLoading && docs.length === 0 && (
          <div className="flex flex-col items-center justify-center h-64 gap-4">
            <Image size={48} className="text-text-tertiary opacity-40" />
            <p className="text-sm text-text-secondary">
              {trashed ? t('layerdocs_empty_trashed') :
               starred ? t('layerdocs_empty_starred') :
               t('layerdocs_empty')}
            </p>
            {!trashed && !starred && (
              <Button icon={<Plus size={15} />} onClick={() => setShowNewModal(true)}>
                {t('layerdocs_create_doc')}
              </Button>
            )}
          </div>
        )}

        {!isLoading && docs.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
            {docs.map((doc) => (
              <LayerDocCard
                key={doc.id}
                doc={doc}
                trashed={trashed}
                menu={menu}
                setMenu={setMenu}
                onOpen={() => navigate(`/paintsharp/layer/${doc.id}`)}
                onStar={(val) => starMut.mutate({ id: doc.id, val })}
                onTrash={() => trashMut.mutate(doc.id)}
                onRestore={() => restoreMut.mutate(doc.id)}
                onDelete={() => deleteMut.mutate(doc.id)}
                onDuplicate={() => duplicateMut.mutate(doc.id)}
              />
            ))}
          </div>
        )}
      </div>
  )

  // Ouverture d'un fichier .kblay depuis le navigateur → éditeur Layer.
  const handleOpenFile = (file: FileItem): boolean => {
    layerApi.openByFile(file.id).then(({ id }) => navigate(`/paintsharp/layer/${id}`)).catch(() => {})
    return true
  }

  // Vue par défaut : StartPage (récents + navigation des répertoires via ModuleFileBrowser).
  if (!starred && !trashed) {
    const recentItems: StartPageRecentItem[] = docs.slice(0, 12).map(d => ({
      id:       d.id,
      name:     d.title || t('layerdocs_title'),
      subtitle: format(new Date(d.updated_at), 'd MMM', { locale: getDateLocale(i18n.language) }),
      icon:     <Image size={18} className="text-text-tertiary" strokeWidth={1.5} />,
      onClick:  () => navigate(`/paintsharp/layer/${d.id}`),
      actions: [
        { id: 'open',  label: t('layerdocs_open', { defaultValue: 'Ouvrir' }), icon: <ExternalLink size={15} />, onClick: () => navigate(`/paintsharp/layer/${d.id}`) },
        { id: 'dup',   label: t('common_duplicate'),                           icon: <Copy size={15} />,         onClick: () => duplicateMut.mutate(d.id) },
        { id: 'trash', label: t('layerdocs_to_trash', { defaultValue: t('common_move_to_trash', { defaultValue: 'Mettre à la corbeille' }) }), icon: <Trash2 size={15} />, danger: true, onClick: () => trashMut.mutate(d.id) },
      ],
    }))
    return (
      <div className="flex flex-col h-full">
        {createError && (
          <div className="flex items-center justify-between px-4 py-2 text-sm bg-danger-light text-danger border-b border-danger/20">
            <span>{t('layerdocs_create_error', { message: createError })}</span>
            <button onClick={() => setCreateError(null)} className="ml-4 font-bold">×</button>
          </div>
        )}
        <div className="flex-1 min-h-0">
          <ModuleStartPage
            recentTitle={t('layerdocs_recent', { defaultValue: 'Récents' })}
            recentItems={recentItems}
            recentEmpty={
              <div className="flex flex-col items-center gap-2">
                <Image size={32} className="text-text-tertiary opacity-30" strokeWidth={1.5} />
                <p className="text-text-tertiary text-xs">{t('layerdocs_empty')}</p>
              </div>
            }
            browse={{
              folderPathPrefix: 'PaintSharp/Layer',
              title: t('layerdocs_title'),
              fileTypeModuleId: 'paintsharp-layer',
              onOpenFile: handleOpenFile,
              toolbarContent: newButton,
            }}
          />
        </div>
        {newModal}
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--body-bg)' }}>
      {createError && (
        <div className="flex items-center justify-between px-4 py-2 text-sm bg-danger-light text-danger border-b border-danger/20">
          <span>{t('layerdocs_create_error', { message: createError })}</span>
          <button onClick={() => setCreateError(null)} className="ml-4 font-bold">×</button>
        </div>
      )}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border">
        <div className="flex items-center gap-2">
          <Image size={18} className="text-text-secondary" />
          <h1 className="text-base font-medium text-text-primary">{title}</h1>
          {docs.length > 0 && (
            <span className="text-sm text-text-tertiary">({docs.length})</span>
          )}
        </div>
        {newButton}
      </div>
      {grid}
      {newModal}
    </div>
  )
}

function LayerDocCard({
  doc, trashed, menu, setMenu, onOpen, onStar, onTrash, onRestore, onDelete, onDuplicate,
}: {
  doc:         LayerDocumentSummary
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
  const isMenuOpen = menu?.id === doc.id

  const menuItems: MenuItem[] = !trashed
    ? [
        { type: 'action', label: doc.is_starred ? t('layerdocs_unstar') : t('layerdocs_star'),
          icon: <Star size={13} className={doc.is_starred ? 'text-warning fill-warning' : ''} />,
          onClick: () => onStar(!doc.is_starred) },
        { type: 'action', label: t('common_rename'), icon: <Pencil size={13} />, onClick: () => {} },
        { type: 'action', label: t('common_duplicate'), icon: <Copy size={13} />, onClick: onDuplicate },
        { type: 'separator' },
        { type: 'action', label: t('layerdocs_move_to_trash'), icon: <Trash2 size={13} />, danger: true, onClick: onTrash },
      ]
    : [
        { type: 'action', label: t('layerdocs_restore'), icon: <RotateCcw size={13} />, onClick: onRestore },
        { type: 'action', label: t('layerdocs_delete_forever'), icon: <Trash2 size={13} />, danger: true, onClick: onDelete },
      ]

  return (
    <div className="group relative rounded-xl overflow-hidden border border-border
                    hover:border-border-strong transition-all hover:shadow-sm bg-surface-0">
      <button
        className="block w-full aspect-video relative"
        onClick={onOpen}
        style={{ background: '#2a2a2a' }}
      >
        {doc.thumbnail_path ? (
          <img src={doc.thumbnail_path} alt={doc.title} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center gap-1.5">
            <Image size={28} style={{ color: '#4a90e8', opacity: 0.6 }} />
            <span className="text-[10px]" style={{ color: '#666' }}>
              {doc.width}×{doc.height}
            </span>
          </div>
        )}
      </button>

      <div className="px-2.5 py-2">
        <div className="flex items-start justify-between gap-1">
          <button onClick={onOpen}
                  className="text-sm font-medium text-text-primary truncate text-left flex-1 hover:text-primary transition-colors">
            {doc.title}
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation()
              const r = e.currentTarget.getBoundingClientRect()
              setMenu(isMenuOpen ? null : { id: doc.id, pos: { top: r.bottom + 4, left: r.right - 176 } })
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
          {formatDistanceToNow(new Date(doc.updated_at), { addSuffix: true, locale: getDateLocale(i18n.language) })}
        </p>
      </div>
    </div>
  )
}
