// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Layer-group reconstruction from `PROP_ITEM_PATH`. Derived from the GIMP source code
// (app/xcf/xcf-load.c, `gimp_item_stack_get_parent_by_path` and `xcf_fix_item_path`),
// Copyright (C) 1995 Spencer Kimball and Peter Mattis and the GIMP contributors,
// licensed GPL-3.0-or-later. Reimplemented in TypeScript for Kubuno (AGPL-3.0-or-later).
//
// The layer list in the file is FLAT. Two properties rebuild the tree: PROP_GROUP_ITEM
// says "this layer is a group", PROP_ITEM_PATH gives the insertion path. Layers arrive
// top-first and each is appended at the END of its parent's child list — which
// reproduces GIMP's own ordering, and matches Layer's convention (index 0 = topmost),
// so no reversal is ever needed. PSD, by contrast, stores bottom-first.

import type { ImportedGroup, ImportedNode } from '../types'

/** Mutable twin of `ImportedNode`, used while the tree is still being built. */
export type MutableNode = MutableRaster | MutableGroup

export interface MutableRaster {
  kind: 'raster'
  node: Omit<ImportedNode & { kind: 'raster' }, 'kind'>
}

export interface MutableGroup {
  kind: 'group'
  node: Omit<ImportedGroup, 'kind' | 'children'>
  children: MutableNode[]
}

/**
 * Inserts a node at `path`. The last index of the path is the position INSIDE the
 * parent, not another parent, so only `path[0 .. n-2]` are traversed.
 *
 * A path pointing at a missing node, or at a node that is not a group, is not a fatal
 * error: the node lands at the level reached so far, and the caller emits one aggregate
 * warning. GIMP has a whole repair pass (`xcf_fix_item_path`) for exactly this case.
 */
export function insertByPath(
  roots: MutableNode[],
  path: readonly number[],
  node: MutableNode,
): boolean {
  let container = roots
  let intact = true
  for (let i = 0; i < path.length - 1; i++) {
    const parent = container[path[i]]
    if (!parent || parent.kind !== 'group') {
      intact = false
      break
    }
    container = parent.children
  }
  container.push(node)
  return intact
}

/** Freezes the mutable tree into the immutable pivot model. */
export function freezeTree(nodes: readonly MutableNode[]): ImportedNode[] {
  return nodes.map((n) =>
    n.kind === 'group'
      ? ({ ...n.node, kind: 'group', children: freezeTree(n.children) } as ImportedNode)
      : ({ ...n.node, kind: 'raster' } as ImportedNode),
  )
}
