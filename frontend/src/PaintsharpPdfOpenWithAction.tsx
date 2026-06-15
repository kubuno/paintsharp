import { useNavigate } from 'react-router-dom'
import { FileText } from 'lucide-react'
import { useFilesOpenWith } from '@kubuno/drive'
import { pdfWriterApi } from './api'

/** PdfWriter sait ouvrir les PDF bruts (import à la volée côté serveur). */
export function isPdfFile(mimeType: string, name: string): boolean {
  return mimeType === 'application/pdf' || name.toLowerCase().endsWith('.pdf')
}

// Action « Ouvrir avec » contribuée au slot files-open-with : ouvre/Importe un PDF
// brut du module Files dans PdfWriter. Ne se rend que pour les fichiers PDF.
export default function PaintsharpPdfOpenWithAction() {
  const file     = useFilesOpenWith()
  const navigate = useNavigate()

  if (!file || !isPdfFile(file.mime_type, file.name)) return null

  const handleOpen = () => {
    pdfWriterApi.openByFile(file.id)
      .then(({ id }) => navigate(`/paintsharp/pdfwriter/${id}`))
      .catch(() => {})
  }

  return (
    <button
      onClick={handleOpen}
      className="w-full flex items-center gap-3 px-3 py-2 text-sm text-text-primary
                 hover:bg-surface-1 cursor-pointer outline-none transition-colors"
    >
      <FileText size={15} className="text-text-secondary" />
      PdfWriter
    </button>
  )
}
