// Right-click host for the Layer editor, driven by the unified `MenuNode` model.
//
// It renders through `MenuDropdown` from `@ui` — the same primitive as the
// shared `useContextMenu()` of `ui/ContextMenu.tsx`, never a hand-rolled
// floating div. The only difference is the item type: `MenuNode` instead of the
// flat legacy `CtxItem`, which unlocks submenus, real checkboxes, radio groups,
// icons and headings.
//
// `ui/ContextMenu.tsx` is deliberately left untouched: Apex, Vertex, Motion,
// Keyframe, FontEditor and PdfWriter keep using it unchanged.
import { useCallback, useState } from 'react'
import { MenuDropdown } from '@ui'
import { toUiMenuItems, type MenuNode } from '../../ui/menuModel'

interface OpenEventLike {
  preventDefault: () => void
  clientX: number
  clientY: number
}

export interface LayerContextMenuHandle {
  /** Opens the menu at the pointer. A node list that resolves to nothing (every
   *  entry hidden by its `when` guard) simply does not open. */
  open: (e: OpenEventLike, nodes: MenuNode[]) => void
  close: () => void
  isOpen: boolean
  /** Render this in the component tree — a portal, so placement is irrelevant. */
  menu: React.ReactNode
}

export function useLayerContextMenu(minWidth = 240): LayerContextMenuHandle {
  const [state, setState] = useState<{ x: number; y: number; nodes: MenuNode[] } | null>(null)

  const close = useCallback(() => setState(null), [])

  const open = useCallback((e: OpenEventLike, nodes: MenuNode[]) => {
    e.preventDefault()
    // toUiMenuItems drops hidden entries and collapses the separator runs they
    // leave behind; if nothing actionable remains, do not open an empty box.
    if (toUiMenuItems(nodes).some(i => i.type !== 'separator')) {
      setState({ x: e.clientX, y: e.clientY, nodes })
    }
  }, [])

  const menu = state
    ? <MenuDropdown
        items={toUiMenuItems(state.nodes)}
        pos={{ top: state.y, left: state.x, minWidth }}
        onClose={close}
        theme="dark"
      />
    : null

  return { open, close, isOpen: state !== null, menu }
}
