import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import {
  Plus, Clock, Star, Trash2, MoreVertical, RotateCcw,
  FileEdit, Upload, File, Copy, ExternalLink,
} from 'lucide-react'
import { pdfWriterApi, type PdfDocumentSummary } from './api'
import { Button, MenuDropdown, type MenuItem, type MenuDropdownPos } from '@ui'
import type { StartPageRecentItem } from '@ui'
import { ModuleStartPage } from '@kubuno/drive'
import type { FileItem } from '@kubuno/drive'
import { format, formatDistanceToNow } from 'date-fns'
import { useTranslation } from 'react-i18next'
import { getDateLocale } from '@kubuno/sdk'

interface Props {
  starred?: boolean
  trashed?: boolean
}

export function PdfWriterApp({ starred, trashed }: Props = {}) {
  const { t, i18n } = useTranslation('paintsharp')
  const navigate = useNavigate()
  const qc       = useQueryClient()
  const [menu, setMenu]           = useState<{ id: string; pos: MenuDropdownPos } | null>(null)
  const [importing, setImporting] = useState(false)

  const { data, isLoading } = useQuery({
    queryKey: ['pdf-docs', { starred, trashed }],
    queryFn:  () => pdfWriterApi.listDocuments({ starred, trashed }).then(r => r.data.documents),
  })

  const createMut = useMutation({
    mutationFn: () => pdfWriterApi.createDocument({ title: t('pdfapp_untitled_doc') }),
    onSuccess:  (res) => navigate(`/paintsharp/pdfwriter/${res.data.id}`),
  })

  const trashMut = useMutation({
    mutationFn: (id: string) => pdfWriterApi.trashDocument(id),
    onSuccess:  () => { qc.invalidateQueries({ queryKey: ['pdf-docs'] }); setMenu(null) },
  })

  const restoreMut = useMutation({
    mutationFn: (id: string) => pdfWriterApi.restoreDocument(id),
    onSuccess:  () => { qc.invalidateQueries({ queryKey: ['pdf-docs'] }); setMenu(null) },
  })

  const deleteMut = useMutation({
    mutationFn: (id: string) => pdfWriterApi.deleteDocument(id),
    onSuccess:  () => { qc.invalidateQueries({ queryKey: ['pdf-docs'] }); setMenu(null) },
  })

  const starMut = useMutation({
    mutationFn: ({ id, val }: { id: string; val: boolean }) =>
      pdfWriterApi.updateDocument(id, { is_starred: val }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pdf-docs'] }),
  })

  const duplicateMut = useMutation({
    mutationFn: (id: string) => pdfWriterApi.duplicateDocument(id),
    onSuccess:  () => { qc.invalidateQueries({ queryKey: ['pdf-docs'] }); setMenu(null) },
  })

  const handleImport = () => {
    const input = document.createElement('input')
    input.type   = 'accept'
    input.accept = '.pdf,application/pdf'
    // workaround: set type after
    input.type   = 'file'
    input.accept = '.pdf,application/pdf'
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0]
      if (!file) return
      setImporting(true)
      try {
        const fd = new FormData()
        fd.append('file', file)
        fd.append('title', file.name.replace(/\.pdf$/i, ''))
        const res = await pdfWriterApi.importDocument(fd)
        navigate(`/paintsharp/pdfwriter/${res.data.id}`)
      } catch {
        // noop
      } finally {
        setImporting(false)
      }
    }
    input.click()
  }

  const title = starred ? t('pdfapp_title_starred') : trashed ? t('pdfapp_title_trash') : t('pdfapp_title')
  const docs  = data ?? []

  const grid = (
      <div className="flex-1 overflow-y-auto p-6">
        {isLoading && (
          <div className="flex items-center justify-center h-32">
            <p className="text-sm text-text-tertiary">{t('common_loading')}</p>
          </div>
        )}

        {!isLoading && docs.length === 0 && (
          <div className="flex flex-col items-center justify-center h-64 gap-4">
            <FileEdit size={48} className="text-text-tertiary opacity-40" />
            <p className="text-sm text-text-secondary">
              {trashed ? t('pdfapp_empty_trash') :
               starred ? t('pdfapp_empty_starred') :
               t('pdfapp_empty')}
            </p>
            {!trashed && !starred && (
              <div className="flex gap-2">
                <Button variant="secondary" icon={<Upload size={14} />} onClick={handleImport}>
                  {t('pdfapp_import_pdf')}
                </Button>
                <Button icon={<Plus size={15} />} onClick={() => createMut.mutate()}>
                  {t('pdfapp_create_blank')}
                </Button>
              </div>
            )}
          </div>
        )}

        {!isLoading && docs.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
            {docs.map((doc) => (
              <DocCard
                key={doc.id}
                doc={doc}
                trashed={trashed}
                menu={menu}
                setMenu={setMenu}
                onOpen={() => navigate(`/paintsharp/pdfwriter/${doc.id}`)}
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

  // Ouverture d'un fichier .kbpdf depuis le navigateur → éditeur PdfWriter.
  const handleOpenFile = (file: FileItem): boolean => {
    pdfWriterApi.openByFile(file.id).then(({ id }) => navigate(`/paintsharp/pdfwriter/${id}`)).catch(() => {})
    return true
  }

  // Vue par défaut : StartPage (récents + navigation des répertoires via ModuleFileBrowser).
  if (!starred && !trashed) {
    const recentItems: StartPageRecentItem[] = docs.slice(0, 12).map(d => ({
      id:       d.id,
      name:     d.title || t('pdfapp_title'),
      subtitle: format(new Date(d.updated_at), 'd MMM', { locale: getDateLocale(i18n.language) }),
      icon:     <FileEdit size={18} className="text-text-tertiary" strokeWidth={1.5} />,
      onClick:  () => navigate(`/paintsharp/pdfwriter/${d.id}`),
      actions: [
        { id: 'open',  label: t('pdfapp_open', { defaultValue: 'Ouvrir' }), icon: <ExternalLink size={15} />, onClick: () => navigate(`/paintsharp/pdfwriter/${d.id}`) },
        { id: 'dup',   label: t('common_duplicate'),                        icon: <Copy size={15} />,         onClick: () => duplicateMut.mutate(d.id) },
        { id: 'trash', label: t('pdfapp_to_trash'),                        icon: <Trash2 size={15} />, danger: true, onClick: () => trashMut.mutate(d.id) },
      ],
    }))
    return (
      <ModuleStartPage
        recentTitle={t('pdfapp_recent', { defaultValue: 'Récents' })}
        recentItems={recentItems}
        recentEmpty={
          <div className="flex flex-col items-center gap-2">
            <FileEdit size={32} className="text-text-tertiary opacity-30" strokeWidth={1.5} />
            <p className="text-text-tertiary text-xs">{t('pdfapp_empty')}</p>
          </div>
        }
        browse={{
          folderPathPrefix: 'PaintSharp/PdfWriter',
          title: t('pdfapp_title'),
          fileTypeModuleId: 'paintsharp-pdfwriter',
          onOpenFile: handleOpenFile,
          hideImport: true, // l'import générique ne crée pas de doc éditable ; on garde l'import PDF→.kbpdf custom
          toolbarContent: (
            <div className="flex items-center gap-2">
              <Button size="sm" variant="secondary" icon={<Upload size={14} />} onClick={handleImport} loading={importing}>{t('pdfapp_import')}</Button>
              <Button size="sm" icon={<Plus size={14} />} onClick={() => createMut.mutate()} loading={createMut.isPending}>{t('pdfapp_new')}</Button>
            </div>
          ),
        }}
      />
    )
  }

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--body-bg)' }}>
      <div className="flex items-center justify-between px-6 py-4 border-b border-border">
        <div className="flex items-center gap-2">
          <FileEdit size={18} className="text-text-secondary" />
          <h1 className="text-base font-medium text-text-primary">{title}</h1>
          {docs.length > 0 && (<span className="text-sm text-text-tertiary">({docs.length})</span>)}
        </div>
      </div>
      {grid}
    </div>
  )
}

function DocCard({
  doc, trashed, menu, setMenu, onOpen, onStar, onTrash, onRestore, onDelete, onDuplicate,
}: {
  doc:         PdfDocumentSummary
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
        { type: 'action', label: doc.is_starred ? t('pdfapp_unstar') : t('pdfapp_star'),
          icon: <Star size={13} className={doc.is_starred ? 'text-warning fill-warning' : ''} />,
          onClick: () => onStar(!doc.is_starred) },
        { type: 'action', label: t('common_duplicate'), icon: <Copy size={13} />, onClick: onDuplicate },
        { type: 'separator' },
        { type: 'action', label: t('pdfapp_to_trash'), icon: <Trash2 size={13} />, danger: true, onClick: onTrash },
      ]
    : [
        { type: 'action', label: t('pdfapp_restore'), icon: <RotateCcw size={13} />, onClick: onRestore },
        { type: 'action', label: t('pdfapp_delete_forever'), icon: <Trash2 size={13} />, danger: true, onClick: onDelete },
      ]

  return (
    <div className="group relative rounded-xl overflow-hidden border border-border
                    hover:border-border-strong transition-all hover:shadow-sm bg-surface-0">
      <button
        className="block w-full aspect-video relative"
        onClick={onOpen}
        style={{ background: '#f5f5f5' }}
      >
        {doc.thumbnail_path ? (
          <img src={doc.thumbnail_path} alt={doc.title} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center gap-2">
            <File size={32} className="text-red-400 opacity-70" />
            <span className="text-xs text-text-tertiary">
              {t('pdfapp_page_count', { count: doc.page_count })}
            </span>
          </div>
        )}
      </button>

      <div className="px-2.5 py-2">
        <div className="flex items-start justify-between gap-1">
          <button
            onClick={onOpen}
            className="text-sm font-medium text-text-primary truncate text-left flex-1 hover:text-primary transition-colors"
          >
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
