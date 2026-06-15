import { Box, Image, PenTool, Film, Clapperboard, Trash2, FileEdit } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { SidebarNavItem } from '@kubuno/sdk'
import { PaintsharpLogo } from './PaintsharpLogo'

const NAV = [
  { to: '/paintsharp',           label: 'PaintSharp',     icon: PaintsharpLogo, end: true },
  { to: '/paintsharp/vertex',    label: 'Vertex',    icon: Box,          end: false },
  { to: '/paintsharp/layer',     label: 'Layer',     icon: Image,        end: false },
  { to: '/paintsharp/apex',      label: 'Apex',      icon: PenTool,      end: false },
  { to: '/paintsharp/motion',    label: 'Motion',    icon: Film,         end: false },
  { to: '/paintsharp/keyframe',  label: 'Keyframe',  icon: Clapperboard, end: false },
  { to: '/paintsharp/pdfwriter', label: 'PdfWriter', icon: FileEdit,     end: false },
]

export default function PaintsharpSidebarBody({ collapsed = false }: { collapsed?: boolean }) {
  const { t } = useTranslation('paintsharp')

  return (
    <nav className="px-2 py-2 flex flex-col gap-0.5">
      {NAV.map(({ to, label, icon: Icon, end }) => (
        <SidebarNavItem key={to} collapsed={collapsed} to={to} end={end}
          label={label} icon={<Icon size={16} className="flex-shrink-0" />} />
      ))}

      {!collapsed && <div className="mx-2 my-1 h-px bg-border" />}

      <SidebarNavItem collapsed={collapsed} to="/paintsharp/trash"
        label={t('paintsharp_nav_trash')} icon={<Trash2 size={16} className="flex-shrink-0" />} />
    </nav>
  )
}
