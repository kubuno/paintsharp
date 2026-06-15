// Paintsharp primitive: right-click floating context menu, shared by every editor.
// Délègue désormais au MenuDropdown du core (thème sombre) — plus de div maison.
// Usage (inchangé) :
//   const ctx = useContextMenu()
//   <div onContextMenu={e => ctx.open(e, [{ label:'Dupliquer', onClick:dup }, 'sep', ...])}>…</div>
//   {ctx.menu}
import { useState } from 'react'
import { MenuDropdown, type MenuItem } from '@ui'

export type CtxItem =
  | { label: string; onClick: () => void; disabled?: boolean; danger?: boolean; shortcut?: string }
  | 'sep'

function toMenuItems(items: CtxItem[]): MenuItem[] {
  return items.map<MenuItem>(it =>
    it === 'sep'
      ? { type: 'separator' }
      : { type: 'action', label: it.label, onClick: it.onClick, disabled: it.disabled, danger: it.danger, shortcut: it.shortcut },
  )
}

export function useContextMenu() {
  const [state, setState] = useState<{ x: number; y: number; items: CtxItem[] } | null>(null)
  const open = (e: { preventDefault: () => void; clientX: number; clientY: number }, items: CtxItem[]) => {
    e.preventDefault()
    if (items.length) setState({ x: e.clientX, y: e.clientY, items })
  }
  const close = () => setState(null)
  const menu = state
    ? <MenuDropdown items={toMenuItems(state.items)} pos={{ top: state.y, left: state.x, minWidth: 220 }} onClose={close} theme="dark" />
    : null
  return { open, close, menu }
}
