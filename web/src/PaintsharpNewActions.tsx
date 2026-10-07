/**
 * Items of the sidebar "New" button for PaintSharp — DATA for the project's
 * menu component (`MenuDropdown` from @ui), contributed through the generic
 * 'shell.new-actions' extension point (see entry.ts). Evaluated when the menu
 * opens, so labels are always fresh, without hooks.
 */
import type { MenuItem } from '@ui'
import { Plus, FileEdit } from 'lucide-react'
// `navigate` is the core's SPA navigation helper for code running outside
// React: the shell hands it the router's real `navigate`.
import { i18n, navigate } from '@kubuno/sdk'
import { paintsharpApi, pdfWriterApi } from './api'

// Creation failures were already silent in the previous useMutation-based menu
// (no onError handler); keep that behaviour without unhandled rejections.
const run = (fn: () => Promise<void>) => () => { fn().catch(() => {}) }

const newScene = async () => {
  const res = await paintsharpApi.createScene({ title: i18n.t('paintsharp:common_untitled') })
  navigate(`/paintsharp/scene/${res.data.id}`)
}

const newPdfDocument = async () => {
  const res = await pdfWriterApi.createDocument({ title: i18n.t('paintsharp:paintsharp_untitled_document') })
  navigate(`/paintsharp/pdfwriter/${res.data.id}`)
}

export function paintsharpNewActionItems(): MenuItem[] {
  if (!window.location.pathname.startsWith('/paintsharp')) return []

  return [
    {
      type: 'action',
      label: i18n.t('paintsharp:paintsharp_new_scene_3d'),
      icon: <Plus size={16} className="text-text-secondary" />,
      onClick: run(newScene),
    },
    {
      type: 'action',
      label: i18n.t('paintsharp:paintsharp_new_pdf_document'),
      icon: <FileEdit size={16} className="text-text-secondary" />,
      onClick: run(newPdfDocument),
    },
  ]
}
