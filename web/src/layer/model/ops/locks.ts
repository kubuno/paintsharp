// Locks.
//
// A lock is an editing aid, never a security guarantee: the UI greys the action
// out and the model refuses the command, so it never enters the history at all.
// Every command funnels through `can()`; nothing checks `locks.*` by hand.

import type { Layer, LayerId, LayerLocks } from '../types.ts'
import { findPath, getAtPath } from './tree.ts'

export type LockCapability =
  | 'paint' | 'paintAlpha' | 'move' | 'transform' | 'delete' | 'reorder'
  | 'reparent' | 'rename' | 'changeProps' | 'editMask'

const NO_LOCKS: LayerLocks = {
  transparency: false, pixels: false, position: false, nesting: false, all: false,
}

/**
 * Locks as they actually apply, ancestors included.
 *
 * A locked GROUP propagates `all` and `position` down; the other locks do not
 * propagate (a group with locked pixels does not stop you painting a child —
 * Photoshop parity).
 */
export function effectiveLocks(tree: readonly Layer[], id: LayerId): LayerLocks {
  const path = findPath(tree, id)
  if (!path) return { ...NO_LOCKS }
  const self = getAtPath(tree, path)
  if (!self) return { ...NO_LOCKS }
  const out: LayerLocks = { ...self.locks }
  for (let k = 1; k < path.length; k++) {
    const ancestor = getAtPath(tree, path.slice(0, k))
    if (!ancestor) continue
    if (ancestor.locks.all) { out.all = true; out.position = true }
    if (ancestor.locks.position) out.position = true
    if (ancestor.locks.nesting) out.nesting = true
  }
  // A Background layer is implicitly pinned and opaque.
  if (self.kind === 'raster' && self.isBackground) {
    out.position = true
    out.transparency = true
  }
  return out
}

export function can(tree: readonly Layer[], id: LayerId, cap: LockCapability): boolean {
  const l = effectiveLocks(tree, id)
  if (l.all) return false
  switch (cap) {
    case 'paint': return !l.pixels
    case 'paintAlpha': return !l.pixels && !l.transparency
    case 'move':
    case 'transform': return !l.position
    case 'reparent': return !l.nesting
    // Masks stay editable under a pixel lock — Photoshop parity.
    case 'delete': case 'reorder': case 'rename': case 'changeProps': case 'editMask':
      return true
  }
}

/** Convenience for the ops: the subset of `ids` allowed to do `cap`. */
export function allowed(tree: readonly Layer[], ids: readonly LayerId[], cap: LockCapability): LayerId[] {
  return ids.filter(id => can(tree, id, cap))
}
