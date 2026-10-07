// Multi-selection.
//
// Replaces the old single `activeId: string | null`. `primaryId` keeps the whole
// existing single-target semantics (rename, mask editing, tool target), so the
// tools do not have to be rewritten to gain multi-selection.

import type { Layer, LayerId, LayerSelection } from '../types.ts'
import { EMPTY_SELECTION } from '../types.ts'
import { findLayer, flatten, isDescendant } from './tree.ts'

export function selectionOf(ids: readonly LayerId[], primaryId?: LayerId | null): LayerSelection {
  return {
    ids: [...ids],
    primaryId: primaryId ?? (ids.length > 0 ? ids[0] : null),
    anchorId: primaryId ?? (ids.length > 0 ? ids[0] : null),
  }
}

export function singleSelection(id: LayerId | null): LayerSelection {
  return id ? { ids: [id], primaryId: id, anchorId: id } : EMPTY_SELECTION
}

/**
 * The ANTICHAIN of the selection: when a group and one of its descendants are
 * both selected, structural operations must consider only the ancestor.
 * Without this, "delete" removes the child twice — once on its own, once with
 * its parent — and the second removal silently targets the wrong node.
 *
 * Returned in display order (top first), which is also the order in which
 * grouping and reordering must preserve relative positions.
 */
export function topmostSelection(sel: LayerSelection, tree: readonly Layer[]): LayerId[] {
  const selected = new Set(sel.ids)
  const out: LayerId[] = []
  for (const e of flatten(tree)) {
    if (!selected.has(e.layer.id)) continue
    const covered = out.some(a => isDescendant(tree, a, e.layer.id))
    if (!covered) out.push(e.layer.id)
  }
  return out
}

/** Drops ids that no longer exist and repairs `primaryId` / `anchorId`. */
export function normalizeSelection(sel: LayerSelection, tree: readonly Layer[]): LayerSelection {
  const ids = sel.ids.filter(id => findLayer(tree, id) !== null)
  const primaryId = sel.primaryId && ids.includes(sel.primaryId)
    ? sel.primaryId
    : (ids[0] ?? null)
  const anchorId = sel.anchorId && ids.includes(sel.anchorId) ? sel.anchorId : primaryId
  return { ids, primaryId, anchorId }
}

/** Ctrl/Cmd-click. */
export function toggleSelection(sel: LayerSelection, id: LayerId): LayerSelection {
  if (sel.ids.includes(id)) {
    const ids = sel.ids.filter(x => x !== id)
    return { ids, primaryId: ids[0] ?? null, anchorId: ids[0] ?? null }
  }
  return { ids: [...sel.ids, id], primaryId: id, anchorId: id }
}

/** Shift-click: the range in FLATTENED display order, groups traversed. */
export function selectRange(sel: LayerSelection, tree: readonly Layer[], targetId: LayerId): LayerSelection {
  const flat = flatten(tree)
  const order = flat.map(e => e.layer.id)
  const anchor = sel.anchorId ?? sel.primaryId ?? targetId
  const a = order.indexOf(anchor)
  const b = order.indexOf(targetId)
  if (a < 0 || b < 0) return singleSelection(targetId)
  const [lo, hi] = a <= b ? [a, b] : [b, a]
  return { ids: order.slice(lo, hi + 1), primaryId: targetId, anchorId: anchor }
}
