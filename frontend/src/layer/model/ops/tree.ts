// Immutable tree navigation and mutation, addressed by PATH.
//
// A path is the list of child indices from the root: `[2, 0, 3]` is
// `tree[2].children[0].children[3]`. Paths are what the history commands store
// (§10.2): they are small, stable inside one command, and make insert/remove
// exactly invertible.
//
// Convention, inherited from PSD and from the layers panel: `children[0]` is
// the TOP of the stack. The compositor therefore walks a sibling list backwards.
//
// Every function here is pure: it returns a new tree and never mutates its
// input. Untouched subtrees are shared by reference, so replacing a leaf in a
// 500-layer document allocates a handful of objects, not 500.

import {
  isContainer,
  rectUnion,
  type ContainerLayer,
  type Layer,
  type LayerId,
  type LayerPatch,
  type LayerPath,
  type Mat2x3,
  type RectI,
} from '../types.ts'

// ── Queries ──────────────────────────────────────────────────────────────────

export interface FlatEntry {
  layer: Layer
  path: LayerPath
  depth: number
  parentId: LayerId | null
}

/** Depth-first, top-of-stack first — i.e. the order the panel displays. */
export function flatten(tree: readonly Layer[]): FlatEntry[] {
  const out: FlatEntry[] = []
  const walkList = (list: readonly Layer[], prefix: number[], depth: number, parentId: LayerId | null) => {
    for (let i = 0; i < list.length; i++) {
      const layer = list[i]
      const path = [...prefix, i]
      out.push({ layer, path, depth, parentId })
      if (isContainer(layer)) walkList(layer.children, path, depth + 1, layer.id)
    }
  }
  walkList(tree, [], 0, null)
  return out
}

/** Visits every node. Return `false` from `fn` to skip a subtree. */
export function walk(tree: readonly Layer[], fn: (l: Layer, path: LayerPath) => void | boolean): void {
  const rec = (list: readonly Layer[], prefix: number[]) => {
    for (let i = 0; i < list.length; i++) {
      const path = [...prefix, i]
      const r = fn(list[i], path)
      if (r === false) continue
      const kids = isContainer(list[i]) ? (list[i] as ContainerLayer).children : null
      if (kids) rec(kids, path)
    }
  }
  rec(tree, [])
}

export function findLayer(tree: readonly Layer[], id: LayerId | null): Layer | null {
  if (!id) return null
  for (const n of tree) {
    if (n.id === id) return n
    if (isContainer(n)) {
      const f = findLayer(n.children, id)
      if (f) return f
    }
  }
  return null
}

export function findPath(tree: readonly Layer[], id: LayerId | null): LayerPath | null {
  if (!id) return null
  const rec = (list: readonly Layer[], prefix: number[]): LayerPath | null => {
    for (let i = 0; i < list.length; i++) {
      if (list[i].id === id) return [...prefix, i]
      if (isContainer(list[i])) {
        const f = rec((list[i] as ContainerLayer).children, [...prefix, i])
        if (f) return f
      }
    }
    return null
  }
  return rec(tree, [])
}

export function getAtPath(tree: readonly Layer[], path: LayerPath): Layer | null {
  let list: readonly Layer[] = tree
  let node: Layer | null = null
  for (const i of path) {
    if (i < 0 || i >= list.length) return null
    node = list[i]
    list = isContainer(node) ? node.children : []
  }
  return node
}

/** The list a path addresses INTO (i.e. the parent's child list). */
export function listAtPath(tree: readonly Layer[], path: LayerPath): readonly Layer[] | null {
  if (path.length === 0) return null
  let list: readonly Layer[] = tree
  for (let k = 0; k < path.length - 1; k++) {
    const n: Layer | undefined = list[path[k]]
    if (!n || !isContainer(n)) return null
    list = n.children
  }
  return list
}

export function parentOf(tree: readonly Layer[], id: LayerId): Layer | null {
  const p = findPath(tree, id)
  if (!p || p.length < 2) return null
  return getAtPath(tree, p.slice(0, -1))
}

export interface Siblings {
  list: readonly Layer[]
  index: number
  parentId: LayerId | null
  path: LayerPath
}

export function siblingsOf(tree: readonly Layer[], id: LayerId): Siblings | null {
  const path = findPath(tree, id)
  if (!path) return null
  const list = listAtPath(tree, path)
  if (!list) return null
  const parent = path.length >= 2 ? getAtPath(tree, path.slice(0, -1)) : null
  return { list, index: path[path.length - 1], parentId: parent ? parent.id : null, path }
}

export function isDescendant(tree: readonly Layer[], ancestorId: LayerId, id: LayerId): boolean {
  const a = findLayer(tree, ancestorId)
  if (!a || !isContainer(a)) return false
  return findLayer(a.children, id) !== null
}

/** Every node of the subtree rooted at `l`, `l` included. */
export function subtreeNodes(l: Layer): Layer[] {
  const out: Layer[] = [l]
  if (isContainer(l)) for (const c of l.children) out.push(...subtreeNodes(c))
  return out
}

/** Layers that actually contribute: visible, and with every ancestor visible. */
export function visibleLayers(tree: readonly Layer[]): Layer[] {
  const out: Layer[] = []
  const rec = (list: readonly Layer[]) => {
    for (const n of list) {
      if (!n.visible) continue
      out.push(n)
      if (isContainer(n)) rec(n.children)
    }
  }
  rec(tree)
  return out
}

// ── Mutations (all immutable) ────────────────────────────────────────────────

function withChildren(node: Layer, children: Layer[]): Layer {
  return { ...(node as ContainerLayer), children } as Layer
}

export function replaceAtPath(tree: readonly Layer[], path: LayerPath, node: Layer): Layer[] {
  if (path.length === 0) return [...tree]
  const [i, ...rest] = path
  const out = [...tree]
  if (i < 0 || i >= out.length) return out
  if (rest.length === 0) { out[i] = node; return out }
  const parent = out[i]
  if (!isContainer(parent)) return out
  out[i] = withChildren(parent, replaceAtPath(parent.children, rest, node))
  return out
}

export function removeAtPath(tree: readonly Layer[], path: LayerPath): { tree: Layer[]; removed: Layer | null } {
  if (path.length === 0) return { tree: [...tree], removed: null }
  const [i, ...rest] = path
  const out = [...tree]
  if (i < 0 || i >= out.length) return { tree: out, removed: null }
  if (rest.length === 0) {
    const [removed] = out.splice(i, 1)
    return { tree: out, removed }
  }
  const parent = out[i]
  if (!isContainer(parent)) return { tree: out, removed: null }
  const r = removeAtPath(parent.children, rest)
  out[i] = withChildren(parent, r.tree)
  return { tree: out, removed: r.removed }
}

/** Inserts at `path`: the last index is the position in the parent list. */
export function insertAtPath(tree: readonly Layer[], path: LayerPath, node: Layer): Layer[] {
  if (path.length === 0) return [node, ...tree]
  const [i, ...rest] = path
  const out = [...tree]
  if (rest.length === 0) {
    out.splice(Math.max(0, Math.min(i, out.length)), 0, node)
    return out
  }
  if (i < 0 || i >= out.length) return out
  const parent = out[i]
  if (!isContainer(parent)) return out
  out[i] = withChildren(parent, insertAtPath(parent.children, rest, node))
  return out
}

export function updateLayer(tree: readonly Layer[], id: LayerId, patch: LayerPatch): Layer[] {
  return mapLayer(tree, id, l => ({ ...l, ...patch } as Layer))
}

export function mapLayer(tree: readonly Layer[], id: LayerId, fn: (l: Layer) => Layer): Layer[] {
  let changed = false
  const rec = (list: readonly Layer[]): Layer[] => list.map(n => {
    if (n.id === id) { changed = true; return fn(n) }
    if (isContainer(n)) {
      const kids = rec(n.children)
      return kids === n.children ? n : withChildren(n, kids)
    }
    return n
  })
  const out = rec(tree)
  return changed ? out : [...tree]
}

export function removeLayer(tree: readonly Layer[], id: LayerId): { tree: Layer[]; removed: Layer | null } {
  const p = findPath(tree, id)
  if (!p) return { tree: [...tree], removed: null }
  return removeAtPath(tree, p)
}

// ── Clipping runs ────────────────────────────────────────────────────────────

export interface ClippingRun {
  base: Layer
  /** Clipped members, bottom to top. */
  clipped: Layer[]
}

/**
 * Groups one sibling list into clipping runs, bottom to top.
 *
 * A layer with `clipping === false` opens a run and is its BASE; every layer
 * immediately above it with `clipping === true` joins that run. The run ends at
 * the next unclipped layer.
 *
 * The whole run composites as ONE unit: the aggregate is clipped to the base's
 * alpha and then blended with the BASE's blend mode and opacity. Blending each
 * clipped layer individually — what the current editor does — gives a different
 * result as soon as the base is not in Normal (gap E11).
 */
export function clippingRuns(siblings: readonly Layer[]): ClippingRun[] {
  const runs: ClippingRun[] = []
  // Walk bottom (last index) to top (index 0).
  for (let i = siblings.length - 1; i >= 0; i--) {
    const n = siblings[i]
    if (!n.clipping || runs.length === 0) runs.push({ base: n, clipped: [] })
    else runs[runs.length - 1].clipped.push(n)
  }
  return runs
}

/** The run a layer belongs to, or null when it is not in this list. */
export function clippingRunOf(siblings: readonly Layer[], id: LayerId): ClippingRun | null {
  for (const run of clippingRuns(siblings)) {
    if (run.base.id === id || run.clipped.some(c => c.id === id)) return run
  }
  return null
}

// ── Geometry ─────────────────────────────────────────────────────────────────

export function transformRect(r: RectI, m: Mat2x3): RectI {
  const pts: [number, number][] = [
    [r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h],
  ]
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const [x, y] of pts) {
    const tx = m[0] * x + m[2] * y + m[4]
    const ty = m[1] * x + m[3] * y + m[5]
    if (tx < minX) minX = tx
    if (ty < minY) minY = ty
    if (tx > maxX) maxX = tx
    if (ty > maxY) maxY = ty
  }
  return { x: Math.round(minX), y: Math.round(minY), w: Math.round(maxX - minX), h: Math.round(maxY - minY) }
}

function pathBounds(l: Layer): RectI | null {
  if (l.kind !== 'shape') return null
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const sp of l.path.subpaths) {
    for (const n of sp.nodes) {
      for (const [x, y] of [[n.x, n.y], [n.inX, n.inY], [n.outX, n.outY]] as [number, number][]) {
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }
    }
  }
  if (!Number.isFinite(minX)) return null
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/**
 * Bounding box of the layer's own content, in document space, masks NOT applied
 * and styles NOT included. This is the reference box for align/distribute; the
 * caller adds mask/style contributions when it needs them.
 */
export function contentBounds(l: Layer, docBounds: RectI): RectI {
  switch (l.kind) {
    case 'raster':
      return transformRect(l.surface.bounds, l.transform)
    case 'group':
    case 'artboard': {
      let acc: RectI = { x: 0, y: 0, w: 0, h: 0 }
      for (const c of l.children) acc = rectUnion(acc, contentBounds(c, docBounds))
      if (l.kind === 'artboard') return l.frame
      return acc.w > 0 && acc.h > 0 ? acc : { ...docBounds }
    }
    case 'text':
      return transformRect(l.text.box ?? l.raster?.bounds ?? docBounds, l.transform)
    case 'shape':
      return transformRect(l.raster?.bounds ?? pathBounds(l) ?? docBounds, l.transform)
    case 'smartObject':
      return transformRect({ x: 0, y: 0, w: l.sourceSize.w, h: l.sourceSize.h }, l.transform)
    case 'fill':
    case 'adjustment':
    default:
      // Procedural sources cover the whole canvas; the masks restrict them.
      return { ...docBounds }
  }
}

// ── Naming ───────────────────────────────────────────────────────────────────

/**
 * Default layer names are stored in a canonical, language-independent form
 * ("Fond", "Calque 3") and translated at display time. Keep that: the stored
 * value must not depend on the UI language.
 */
export const DEFAULT_LAYER_PREFIX = 'Calque'
export const DEFAULT_GROUP_PREFIX = 'Groupe'
export const BACKGROUND_NAME = 'Fond'

/** Next free `<prefix> N` across the WHOLE document, as Photoshop does. */
export function nextDefaultName(tree: readonly Layer[], prefix: string): string {
  let max = 0
  const re = new RegExp(`^${prefix} (\\d+)$`)
  walk(tree, l => {
    const m = re.exec(l.name)
    if (m) max = Math.max(max, Number(m[1]))
  })
  return `${prefix} ${max + 1}`
}

/** `"<name> copie"`, then `"<name> copie 2"`, ... — never colliding. */
export function copyName(tree: readonly Layer[], name: string): string {
  const taken = new Set<string>()
  walk(tree, l => { taken.add(l.name) })
  const base = `${name} copie`
  if (!taken.has(base)) return base
  for (let i = 2; ; i++) {
    const c = `${base} ${i}`
    if (!taken.has(c)) return c
  }
}
