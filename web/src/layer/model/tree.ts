// Layer-tree helpers (immutable; the layer list is a tree via `children`).
//
// These operate directly on the wire type `LayerStructureItem` shared with the
// backend. Extracted verbatim from LayerEditorPage during the layer/ refactor —
// no behavioural change.
import type { LayerStructureItem } from '../../api'

export function findInTree(nodes: LayerStructureItem[], id: string | null): LayerStructureItem | null {
  if (!id) return null
  for (const n of nodes) {
    if (n.id === id) return n
    if (n.children) { const f = findInTree(n.children, id); if (f) return f }
  }
  return null
}

export function mapTree(nodes: LayerStructureItem[], id: string, patch: Partial<LayerStructureItem>): LayerStructureItem[] {
  return nodes.map(n => {
    if (n.id === id) return { ...n, ...patch }
    if (n.children) return { ...n, children: mapTree(n.children, id, patch) }
    return n
  })
}

export function removeFromTree(nodes: LayerStructureItem[], id: string): { tree: LayerStructureItem[]; removed: LayerStructureItem | null } {
  let removed: LayerStructureItem | null = null
  const walk = (list: LayerStructureItem[]): LayerStructureItem[] => {
    const out: LayerStructureItem[] = []
    for (const n of list) {
      if (n.id === id) { removed = n; continue }
      out.push(n.children ? { ...n, children: walk(n.children) } : n)
    }
    return out
  }
  return { tree: walk(nodes), removed }
}

/** Raster leaves (depth-first) — used for texture management & flat queries. */
export function leaves(nodes: LayerStructureItem[]): LayerStructureItem[] {
  const out: LayerStructureItem[] = []
  const walk = (list: LayerStructureItem[]) => list.forEach(n => n.children ? walk(n.children) : out.push(n))
  walk(nodes)
  return out
}

/** Every node in the subtree (groups + leaves). */
export function allNodes(nodes: LayerStructureItem[]): LayerStructureItem[] {
  const out: LayerStructureItem[] = []
  const walk = (list: LayerStructureItem[]) => list.forEach(n => { out.push(n); if (n.children) walk(n.children) })
  walk(nodes)
  return out
}

/**
 * Insert `node` above (or below) `targetId` in the same parent list; if the
 * target is a group and `intoGroup`, insert as its first child instead.
 */
export function insertNode(nodes: LayerStructureItem[], node: LayerStructureItem, targetId: string | null, after = false, intoGroup = false): LayerStructureItem[] {
  if (!targetId) return [node, ...nodes]
  let done = false
  const walk = (list: LayerStructureItem[]): LayerStructureItem[] => {
    const out: LayerStructureItem[] = []
    for (const n of list) {
      if (n.id === targetId) {
        if (intoGroup && n.children) { out.push({ ...n, children: [node, ...n.children] }); done = true; continue }
        if (after) { out.push(n); out.push(node) } else { out.push(node); out.push(n) }
        done = true
      } else out.push(n.children ? { ...n, children: walk(n.children) } : n)
    }
    return out
  }
  const r = walk(nodes)
  return done ? r : [node, ...nodes]
}

/** Is `id` a descendant of `ancestorId`? (blocks dropping a group into itself) */
export function isDescendant(nodes: LayerStructureItem[], ancestorId: string, id: string): boolean {
  const a = findInTree(nodes, ancestorId)
  return !!(a?.children && findInTree(a.children, id))
}
