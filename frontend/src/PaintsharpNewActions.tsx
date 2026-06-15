import { Plus, FileEdit } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { paintsharpApi, pdfWriterApi } from './api'

export default function PaintsharpNewActions() {
  const navigate = useNavigate()
  const { t } = useTranslation('paintsharp')

  const createScene = useMutation({
    mutationFn: () => paintsharpApi.createScene({ title: t('common_untitled') }),
    onSuccess:  (res) => navigate(`/paintsharp/scene/${res.data.id}`),
  })

  const createPdf = useMutation({
    mutationFn: () => pdfWriterApi.createDocument({ title: t('paintsharp_untitled_document') }),
    onSuccess:  (res) => navigate(`/paintsharp/pdfwriter/${res.data.id}`),
  })

  return (
    <>
      <button
        onClick={() => createScene.mutate()}
        disabled={createScene.isPending}
        className="flex items-center gap-2 w-full px-3 py-2 text-sm text-text-primary
                   hover:bg-surface-2 transition-colors disabled:opacity-50"
      >
        <Plus size={15} className="text-text-secondary" />
        {t('paintsharp_new_scene_3d')}
      </button>
      <button
        onClick={() => createPdf.mutate()}
        disabled={createPdf.isPending}
        className="flex items-center gap-2 w-full px-3 py-2 text-sm text-text-primary
                   hover:bg-surface-2 transition-colors disabled:opacity-50"
      >
        <FileEdit size={15} className="text-text-secondary" />
        {t('paintsharp_new_pdf_document')}
      </button>
    </>
  )
}
