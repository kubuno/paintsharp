// EmbedShell — a bare drop-in replacement for EditorShell (WorkspaceShell) used
// when a Paintsharp editor is mounted *inside* another editor (e.g. Keyframe draws
// a cel with the real Apex/Layer editor). WorkspaceShell is a singleton-ish host
// chrome that cannot be nested (a second instance renders nothing), so embedded
// editors swap it for this lightweight shell which accepts the SAME props (only a
// subset is used) and lays out: a slim top bar (Done + title + actions), an
// optional options bar, the tool rail on the left, the viewport, and a bottom bar.
import type { ReactNode } from 'react'
import { ChevronLeft } from 'lucide-react'

interface EmbedShellProps {
  theme?: { bg?: string; header?: string; border?: string; text?: string; textDim?: string; accent?: string }
  onBack?: () => void
  title?: string
  subtitle?: string
  topbarActions?: ReactNode
  optionsBar?: ReactNode
  toolRail?: ReactNode
  toolRailWidth?: number
  bottomBar?: ReactNode
  children?: ReactNode
  [key: string]: unknown   // tolerate the rest of EditorShell's props (menus, delete…)
}

export function EmbedShell({
  theme, onBack, title, subtitle, topbarActions, optionsBar, toolRail, toolRailWidth = 56, bottomBar, children,
}: EmbedShellProps) {
  const bg = theme?.bg ?? '#141414'
  const header = theme?.header ?? '#1c1c1c'
  const border = theme?.border ?? '#333'
  const text = theme?.text ?? '#e0e0e0'
  const dim = theme?.textDim ?? '#9e9e9e'
  return (
    <div className="w-full h-full flex flex-col" style={{ background: bg, color: text }}>
      {/* Top bar */}
      <div className="flex items-center gap-2 px-2 flex-shrink-0" style={{ height: 44, background: header, borderBottom: `1px solid ${border}` }}>
        <button onClick={onBack} title="Done"
                className="flex items-center gap-1 h-7 px-2 rounded text-xs hover:bg-white/10" style={{ color: text }}>
          <ChevronLeft size={16} /> {title ?? 'Done'}
        </button>
        {subtitle && <span className="text-[10px]" style={{ color: dim }}>{subtitle}</span>}
        <div className="flex-1" />
        {topbarActions}
      </div>
      {/* Options bar */}
      {optionsBar && (
        <div className="flex items-center gap-2 px-2 flex-shrink-0" style={{ height: 32, background: header, borderBottom: `1px solid ${border}` }}>
          {optionsBar}
        </div>
      )}
      {/* Body: tool rail + viewport */}
      <div className="flex flex-1 min-h-0">
        {toolRail && (
          <div className="flex flex-col items-center gap-0.5 py-2 flex-shrink-0 overflow-y-auto"
               style={{ width: toolRailWidth, background: header, borderRight: `1px solid ${border}` }}>
            {toolRail}
          </div>
        )}
        <div className="flex-1 min-w-0 relative">{children}</div>
      </div>
      {/* Bottom bar */}
      {bottomBar}
    </div>
  )
}
