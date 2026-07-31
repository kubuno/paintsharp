// The layer operations of spec 9, as PURE tree-to-tree functions.
//
// Design rule that makes them trustworthy: an operation never builds its result
// tree directly. It emits a list of primitive command payloads and the result is
// obtained by APPLYING them. The tree returned and the tree the history replays
// are therefore the same object by construction — undo cannot drift from redo.
//
// Nothing here touches pixels. When an operation needs a raster (merge, flatten,
// rasterise), it calls the injected `rasterize` callback, which the editor wires
// to the real compositor — the same one that draws the screen, so that "what I
// see is what gets merged". Tests inject a fake.

import {
  BACKGROUND_NAME,
  DEFAULT_GROUP_PREFIX,
  DEFAULT_LAYER_PREFIX,
  contentBounds,
  copyName,
  findLayer,
  findPath,
  flatten,
  getAtPath,
  isDescendant,
  listAtPath,
  nextDefaultName,
  siblingsOf,
  subtreeNodes,
} from './tree.ts'
import {
  applyCommandToTree,
  makeCommand,
  type Command,
  type CommandPayload,
} from './history.ts'
import { can } from './locks.ts'
import { normalizeSelection, singleSelection, topmostSelection } from './selection.ts'
import { newLayerId } from './ids.ts'
import {
  createGroup,
  createRasterLayer,
  createSmartObjectLayer,
  defaultAdjustment,
  defaultFillContent,
  emptySurface,
  newSurfaceId,
} from './defaults.ts'
import {
  isContainer,
  rectUnion,
  type AdjustmentKind,
  type FillContent,
  type GroupLayer,
  type Layer,
  type LayerId,
  type LayerPatch,
  type LayerPath,
  type LayerSelection,
  type Mat2x3,
  type RasterSurfaceRef,
  type RectI,
} from '../types.ts'

// ── Context and result ───────────────────────────────────────────────────────

export interface RasterizeRequest {
  /** Layers to composite, in tree order (index 0 = top of the stack). */
  layers: readonly Layer[]
  bounds: RectI
  /** What the caller is doing, so the compositor can pick a fast path. */
  purpose: 'mergeDown' | 'mergeVisible' | 'flatten' | 'rasterizeLayer' | 'stamp'
}

/** Off-screen render. Returns the surface holding the result. */
export type RasterizeFn = (req: RasterizeRequest) => RasterSurfaceRef

export interface LayerOpContext {
  tree: readonly Layer[]
  selection: LayerSelection
  doc: { width: number; height: number }
  /** Defaults to allocating an EMPTY surface: structure-only mode, used by the
   *  tests and by any consumer that only cares about the tree. */
  rasterize?: RasterizeFn
}

export interface LayerOpResult {
  ok: boolean
  tree: Layer[]
  selection: LayerSelection
  commands: Command[]
  /** Machine-readable refusal code; the UI translates it. */
  reason?: string
  warnings?: string[]
}

function docBoundsOf(ctx: LayerOpContext): RectI {
  return { x: 0, y: 0, w: ctx.doc.width, h: ctx.doc.height }
}

function rasterizeWith(ctx: LayerOpContext, req: RasterizeRequest): RasterSurfaceRef {
  return ctx.rasterize ? ctx.rasterize(req) : emptySurface(req.bounds, newSurfaceId())
}

// ── Builder ──────────────────────────────────────────────────────────────────

/**
 * Accumulates primitive payloads while keeping a live view of the resulting
 * tree, so an operation can address nodes by id at any point without tracking
 * index shifts by hand — the classic source of off-by-one bugs in reordering.
 */
class OpBuilder {
  readonly payloads: CommandPayload[] = []
  private current: Layer[]
  readonly warnings: string[] = []

  constructor(tree: readonly Layer[]) { this.current = [...tree] }

  get tree(): Layer[] { return this.current }

  private apply(p: CommandPayload): void {
    this.payloads.push(p)
    this.current = applyCommandToTree(this.current, makeCommand(p, { labelKey: '' }), 'do')
  }

  insertAt(path: LayerPath, node: Layer): void {
    this.apply({ k: 'insertLayer', path, node })
  }

  removeById(id: LayerId): Layer | null {
    const path = findPath(this.current, id)
    if (!path) return null
    const node = getAtPath(this.current, path)
    if (!node) return null
    this.apply({ k: 'removeLayer', path, node })
    return node
  }

  replaceById(id: LayerId, after: Layer): void {
    const path = findPath(this.current, id)
    if (!path) return
    const before = getAtPath(this.current, path)
    if (!before) return
    this.apply({ k: 'replaceNode', path, before, after })
  }

  setProps(id: LayerId, after: LayerPatch): void {
    const node = findLayer(this.current, id)
    if (!node) return
    const before: Record<string, unknown> = {}
    for (const k of Object.keys(after)) before[k] = (node as unknown as Record<string, unknown>)[k]
    this.apply({ k: 'setProps', id, before: before as LayerPatch, after })
  }

  warn(code: string): void { this.warnings.push(code) }
}

function finish(
  b: OpBuilder, selection: LayerSelection, labelKey: string,
  labelParams?: Record<string, string | number>,
): LayerOpResult {
  const commands = b.payloads.length === 0
    ? []
    : [makeCommand(
        b.payloads.length === 1
          ? b.payloads[0]
          : { k: 'batch', children: b.payloads.map(p => makeCommand(p, { labelKey })) },
        { labelKey, labelParams },
      )]
  return {
    ok: true,
    tree: b.tree,
    selection: normalizeSelection(selection, b.tree),
    commands,
    warnings: b.warnings.length ? b.warnings : undefined,
  }
}

function refuse(ctx: LayerOpContext, reason: string): LayerOpResult {
  return { ok: false, tree: [...ctx.tree], selection: ctx.selection, commands: [], reason }
}

// ── Shared helpers ───────────────────────────────────────────────────────────

/** Deep copy of a subtree with brand-new ids; also remaps `linkGroup`. */
function deepCopy(node: Layer, linkMap: Map<string, string>, allCopiedLinks: Set<string>): Layer {
  const copy: Layer = { ...node, id: newLayerId() } as Layer
  if (node.linkGroup !== null) {
    if (allCopiedLinks.has(node.linkGroup)) {
      let mapped = linkMap.get(node.linkGroup)
      if (!mapped) { mapped = `lk_${newLayerId()}`; linkMap.set(node.linkGroup, mapped) }
      copy.linkGroup = mapped
    } else {
      // Keeping the original group would silently link the copy to the source.
      copy.linkGroup = null
    }
  }
  if (isContainer(node)) {
    ;(copy as GroupLayer).children = node.children.map(c => deepCopy(c, linkMap, allCopiedLinks))
  }
  return copy
}

/**
 * Clears `clipping` on layers that were clipped onto `baseId` inside `list`.
 * Called whenever a clipping base leaves its sibling list: those layers would
 * otherwise become clipped onto an arbitrary neighbour.
 */
function releaseClippedOnto(b: OpBuilder, list: readonly Layer[], baseIndex: number): void {
  for (let i = baseIndex - 1; i >= 0; i--) {
    const n = list[i]
    if (!n.clipping) break
    b.setProps(n.id, { clipping: false })
  }
}

/** Insertion path for a new sibling placed directly above `id`. */
function pathAbove(tree: readonly Layer[], id: LayerId): LayerPath | null {
  return findPath(tree, id)
}

/** Where a new layer goes, given the primary selection (spec 9.1). */
function insertionPath(tree: readonly Layer[], selection: LayerSelection): LayerPath {
  const primary = selection.primaryId ? findLayer(tree, selection.primaryId) : null
  if (!primary) return [0]
  // An expanded group receives the new layer as its top child.
  if (primary.kind === 'group' && primary.expanded) {
    const p = findPath(tree, primary.id)
    return p ? [...p, 0] : [0]
  }
  return pathAbove(tree, primary.id) ?? [0]
}

/** Climbs to the first ancestor that accepts a child, honouring locks. */
function acceptableInsertPath(tree: readonly Layer[], path: LayerPath): LayerPath {
  let p = path
  while (p.length > 1) {
    const parent = getAtPath(tree, p.slice(0, -1))
    if (!parent) break
    if (can(tree, parent.id, 'reparent')) return p
    p = p.slice(0, -1)
  }
  return p
}

// ── 9.1 New ──────────────────────────────────────────────────────────────────

export interface NewLayerSpec {
  kind: Layer['kind']
  name?: string
  adjustment?: AdjustmentKind
  fill?: FillContent
}

export function opNew(ctx: LayerOpContext, spec: NewLayerSpec): LayerOpResult {
  const b = new OpBuilder(ctx.tree)
  const bounds = docBoundsOf(ctx)
  const path = acceptableInsertPath(b.tree, insertionPath(b.tree, ctx.selection))

  const name = spec.name ?? nextDefaultName(
    b.tree, spec.kind === 'group' ? DEFAULT_GROUP_PREFIX : DEFAULT_LAYER_PREFIX,
  )

  let node: Layer
  switch (spec.kind) {
    case 'group':
      node = createGroup([], { name })
      break
    case 'adjustment': {
      const base = createRasterLayer(bounds, { name })
      node = {
        ...base, kind: 'adjustment',
        adjustment: defaultAdjustment(spec.adjustment ?? 'curves'),
      } as Layer
      break
    }
    case 'fill': {
      const base = createRasterLayer(bounds, { name })
      node = { ...base, kind: 'fill', fill: spec.fill ?? defaultFillContent() } as Layer
      break
    }
    default:
      node = createRasterLayer(bounds, { name })
  }
  b.insertAt(path, node)
  return finish(b, singleSelection(node.id), 'layer_hist_new', { name })
}

// ── 9.2 Duplicate ────────────────────────────────────────────────────────────

export function opDuplicate(ctx: LayerOpContext): LayerOpResult {
  const targets = topmostSelection(ctx.selection, ctx.tree)
  if (targets.length === 0) return refuse(ctx, 'noSelection')
  const b = new OpBuilder(ctx.tree)

  // A link group survives duplication only when ALL its members are duplicated
  // together; otherwise the copy would be silently linked to the original.
  const copiedIds = new Set<string>()
  for (const id of targets) {
    const n = findLayer(ctx.tree, id)
    if (n) for (const s of subtreeNodes(n)) copiedIds.add(s.id)
  }
  const linkCounts = new Map<string, number>()
  const linkCopied = new Map<string, number>()
  for (const e of flatten(ctx.tree)) {
    const lg = e.layer.linkGroup
    if (lg === null) continue
    linkCounts.set(lg, (linkCounts.get(lg) ?? 0) + 1)
    if (copiedIds.has(e.layer.id)) linkCopied.set(lg, (linkCopied.get(lg) ?? 0) + 1)
  }
  const fullyCopiedLinks = new Set<string>()
  for (const [lg, total] of linkCounts) {
    if ((linkCopied.get(lg) ?? 0) === total) fullyCopiedLinks.add(lg)
  }

  const linkMap = new Map<string, string>()
  const newIds: LayerId[] = []
  // Bottom-most first: inserting above a node does not shift the nodes below it.
  for (const id of [...targets].reverse()) {
    const node = findLayer(b.tree, id)
    const path = findPath(b.tree, id)
    if (!node || !path) continue
    const copy = deepCopy(node, linkMap, fullyCopiedLinks)
    copy.name = copyName(b.tree, node.name)
    if (copy.kind === 'raster') copy.isBackground = false
    b.insertAt(path, copy)     // inserting AT the original's index puts it above
    newIds.push(copy.id)
  }
  if (newIds.length === 0) return refuse(ctx, 'noSelection')
  return finish(b, { ids: newIds.reverse(), primaryId: newIds[0], anchorId: newIds[0] }, 'layer_hist_duplicate')
}

// ── 9.3 Delete ───────────────────────────────────────────────────────────────

export function opDelete(ctx: LayerOpContext): LayerOpResult {
  const targets = topmostSelection(ctx.selection, ctx.tree).filter(id => can(ctx.tree, id, 'delete'))
  if (targets.length === 0) return refuse(ctx, 'locked')

  // Photoshop parity: a document always keeps at least one layer.
  const rootIds = new Set(ctx.tree.map(l => l.id))
  const removingWholeRoot = ctx.tree.every(l => targets.includes(l.id)) && rootIds.size === targets.length
  if (removingWholeRoot) return refuse(ctx, 'lastLayer')

  const b = new OpBuilder(ctx.tree)
  for (const id of targets) {
    const sib = siblingsOf(b.tree, id)
    if (sib) {
      const node = sib.list[sib.index]
      // Removing a clipping BASE would leave its clipped layers stranded.
      if (node && !node.clipping) releaseClippedOnto(b, sib.list, sib.index)
    }
    b.removeById(id)
  }
  const remaining = flatten(b.tree)
  const next = remaining.length > 0 ? singleSelection(remaining[0].layer.id) : singleSelection(null)
  return finish(b, next, 'layer_hist_delete')
}

// ── 9.4 Group / Ungroup ──────────────────────────────────────────────────────

export function opGroup(ctx: LayerOpContext): LayerOpResult {
  const targets = topmostSelection(ctx.selection, ctx.tree)
  if (targets.length === 0) return refuse(ctx, 'noSelection')

  const b = new OpBuilder(ctx.tree)
  const anchorSib = siblingsOf(b.tree, targets[0])
  if (!anchorSib) return refuse(ctx, 'notFound')
  const parentPath = anchorSib.path.slice(0, -1)

  // The layer that will sit directly BELOW the new group, if any: it anchors the
  // insertion once the targets have been pulled out.
  const targetSet = new Set(targets)
  let belowId: LayerId | null = null
  for (let i = anchorSib.index + 1; i < anchorSib.list.length; i++) {
    if (!targetSet.has(anchorSib.list[i].id)) { belowId = anchorSib.list[i].id; break }
  }

  // Bottom-most target loses its clipping: its base stays outside the group.
  const bottomTarget = targets[targets.length - 1]
  const bt = findLayer(b.tree, bottomTarget)
  if (bt?.clipping) b.setProps(bottomTarget, { clipping: false })

  // A base moving into the group strands the layers clipped onto it.
  for (const id of targets) {
    const sib = siblingsOf(b.tree, id)
    if (!sib) continue
    const node = sib.list[sib.index]
    if (node.clipping) continue
    for (let i = sib.index - 1; i >= 0; i--) {
      const above = sib.list[i]
      if (!above.clipping) break
      if (!targetSet.has(above.id)) b.setProps(above.id, { clipping: false })
    }
  }

  const moved: Layer[] = []
  for (const id of targets) {
    const node = b.removeById(id)
    if (node) moved.push(node)
  }
  if (moved.length === 0) return refuse(ctx, 'notFound')

  const group = createGroup(moved, { name: nextDefaultName(b.tree, DEFAULT_GROUP_PREFIX) })

  let insertPath: LayerPath
  if (belowId) {
    insertPath = findPath(b.tree, belowId) ?? [...parentPath, 0]
  } else {
    const list = parentPath.length === 0 ? b.tree : (getAtPath(b.tree, parentPath) as GroupLayer | null)?.children ?? []
    insertPath = [...parentPath, list.length]
  }
  b.insertAt(insertPath, group)
  return finish(b, singleSelection(group.id), 'layer_hist_group')
}

export function opUngroup(ctx: LayerOpContext): LayerOpResult {
  const targets = topmostSelection(ctx.selection, ctx.tree)
    .filter(id => findLayer(ctx.tree, id)?.kind === 'group')
  if (targets.length === 0) return refuse(ctx, 'notAGroup')

  const b = new OpBuilder(ctx.tree)
  const released: LayerId[] = []

  for (const id of targets) {
    const g = findLayer(b.tree, id) as GroupLayer | null
    const path = findPath(b.tree, id)
    if (!g || !path) continue

    // Properties that cannot be pushed down faithfully. The caller is expected
    // to have offered "flatten the group instead" through ConfirmDialog — never
    // a browser `confirm()`.
    const lossy = g.blendMode !== 'pass-through' && g.blendMode !== 'normal'
    if (lossy || g.styles !== null) b.warn('ungroup.lossy')

    b.removeById(id)
    const parentPath = path.slice(0, -1)
    const at = path[path.length - 1]
    // Children keep their order; the first child lands where the group was.
    for (let i = g.children.length - 1; i >= 0; i--) {
      const child = g.children[i]
      let merged = child
      if (g.opacity !== 255) {
        merged = { ...merged, opacity: Math.round(merged.opacity * g.opacity / 255) } as Layer
      }
      if (g.fillOpacity !== 255) {
        merged = { ...merged, fillOpacity: Math.round(merged.fillOpacity * g.fillOpacity / 255) } as Layer
      }
      if (g.layerMask) {
        if (merged.layerMask === null) merged = { ...merged, layerMask: g.layerMask } as Layer
        else b.warn('ungroup.maskLost')
      }
      // The bottom-most released child cannot stay clipped: its base is gone.
      if (i === g.children.length - 1 && merged.clipping) {
        merged = { ...merged, clipping: false } as Layer
      }
      b.insertAt([...parentPath, at], merged)
      released.push(merged.id)
    }
  }
  if (released.length === 0) return refuse(ctx, 'notAGroup')
  return finish(b, { ids: released, primaryId: released[0], anchorId: released[0] }, 'layer_hist_ungroup')
}

// ── 9.5 Merge down ───────────────────────────────────────────────────────────

export function opMergeDown(ctx: LayerOpContext): LayerOpResult {
  const primary = ctx.selection.primaryId
  if (!primary) return refuse(ctx, 'noSelection')
  const sib = siblingsOf(ctx.tree, primary)
  if (!sib) return refuse(ctx, 'notFound')
  const top = sib.list[sib.index]
  const below = sib.list[sib.index + 1]
  if (!below) return refuse(ctx, 'mergeDown.noTarget')
  if (below.kind === 'adjustment') return refuse(ctx, 'mergeDown.adjustmentBelow')

  const b = new OpBuilder(ctx.tree)

  // The layer below is a GROUP: the top layer simply moves inside it, on top.
  // (Photoshop parity — it is NOT a rasterising merge.)
  if (below.kind === 'group' || below.kind === 'artboard') {
    const node = b.removeById(top.id)
    if (!node) return refuse(ctx, 'notFound')
    const groupPath = findPath(b.tree, below.id)
    if (!groupPath) return refuse(ctx, 'notFound')
    const moved = node.clipping ? ({ ...node, clipping: false } as Layer) : node
    b.insertAt([...groupPath, 0], moved)
    return finish(b, singleSelection(moved.id), 'layer_hist_merge_down')
  }

  // Other layers clipped onto `below` would change appearance after the merge.
  for (let i = sib.index - 1; i >= 0; i--) {
    const n = sib.list[i]
    if (!n.clipping) break
    if (n.id !== top.id) return refuse(ctx, 'mergeDown.otherClipped')
  }

  const bounds = rectUnion(contentBounds(top, docBoundsOf(ctx)), contentBounds(below, docBoundsOf(ctx)))
  const surface = rasterizeWith(ctx, { layers: [top, below], bounds, purpose: 'mergeDown' })

  // The result keeps the BOTTOM layer's identity: name, blend mode, opacity,
  // masks, styles and Background flag.
  const merged: Layer = {
    ...below,
    kind: 'raster',
    surface,
    isBackground: below.kind === 'raster' ? below.isBackground : false,
  } as Layer

  b.removeById(top.id)
  b.replaceById(below.id, merged)
  return finish(b, singleSelection(merged.id), 'layer_hist_merge_down')
}

// ── 9.6 Merge visible / stamp ────────────────────────────────────────────────

export function opMergeVisible(ctx: LayerOpContext, opts: { stamp?: boolean } = {}): LayerOpResult {
  const visibleRoots = ctx.tree.filter(l => l.visible)
  if (visibleRoots.length === 0) return refuse(ctx, 'mergeVisible.none')

  const b = new OpBuilder(ctx.tree)
  const docBounds = docBoundsOf(ctx)
  let bounds: RectI = { x: 0, y: 0, w: 0, h: 0 }
  for (const l of visibleRoots) bounds = rectUnion(bounds, contentBounds(l, docBounds))
  if (bounds.w <= 0 || bounds.h <= 0) bounds = docBounds

  const surface = rasterizeWith(ctx, {
    layers: visibleRoots, bounds, purpose: opts.stamp ? 'stamp' : 'mergeVisible',
  })

  // Position: where the LOWEST visible layer was.
  const lowest = visibleRoots[visibleRoots.length - 1]
  const lowestIndex = ctx.tree.findIndex(l => l.id === lowest.id)
  const wasBackground = lowest.kind === 'raster' && lowest.isBackground

  const result = createRasterLayer(bounds, {
    name: opts.stamp ? nextDefaultName(ctx.tree, DEFAULT_LAYER_PREFIX) : lowest.name,
    isBackground: !opts.stamp && wasBackground,
  })
  result.surface = surface

  if (opts.stamp) {
    b.insertAt([0], result)
    return finish(b, singleSelection(result.id), 'layer_hist_stamp_visible')
  }
  for (const l of visibleRoots) b.removeById(l.id)
  const insertIndex = Math.min(lowestIndex - (visibleRoots.length - 1), b.tree.length)
  b.insertAt([Math.max(0, insertIndex)], result)
  return finish(b, singleSelection(result.id), 'layer_hist_merge_visible')
}

// ── 9.7 Flatten ──────────────────────────────────────────────────────────────

export function opFlatten(ctx: LayerOpContext): LayerOpResult {
  const artboards = ctx.tree.filter(l => l.kind === 'artboard')
  if (artboards.length > 1) return refuse(ctx, 'flatten.multipleArtboards')
  if (ctx.tree.length === 0) return refuse(ctx, 'flatten.empty')

  const b = new OpBuilder(ctx.tree)
  const bounds = artboards.length === 1 ? artboards[0].frame : docBoundsOf(ctx)
  const surface = rasterizeWith(ctx, { layers: ctx.tree, bounds, purpose: 'flatten' })

  const flat = createRasterLayer(bounds, { name: BACKGROUND_NAME, isBackground: true })
  flat.surface = surface
  flat.locks = { ...flat.locks, position: true, transparency: true }

  for (const l of [...ctx.tree]) b.removeById(l.id)
  b.insertAt([0], flat)
  return finish(b, singleSelection(flat.id), 'layer_hist_flatten')
}

// ── 9.8 Convert to smart object ──────────────────────────────────────────────

export function opConvertToSmartObject(ctx: LayerOpContext, contentId = newSurfaceId()): LayerOpResult {
  const targets = topmostSelection(ctx.selection, ctx.tree)
  if (targets.length === 0) return refuse(ctx, 'noSelection')

  const b = new OpBuilder(ctx.tree)
  const anchorPath = findPath(b.tree, targets[0])
  if (!anchorPath) return refuse(ctx, 'notFound')
  const parentPath = anchorPath.slice(0, -1)
  const targetSet = new Set(targets)
  const anchorSib = siblingsOf(b.tree, targets[0])
  let belowId: LayerId | null = null
  if (anchorSib) {
    for (let i = anchorSib.index + 1; i < anchorSib.list.length; i++) {
      if (!targetSet.has(anchorSib.list[i].id)) { belowId = anchorSib.list[i].id; break }
    }
  }

  const single = targets.length === 1 ? findLayer(b.tree, targets[0]) : null
  for (const id of targets) b.removeById(id)

  // The embedded document keeps the CURRENT document's frame of reference, so
  // the conversion stays reversible.
  const so = createSmartObjectLayer(
    { type: 'embedded', contentId },
    { w: ctx.doc.width, h: ctx.doc.height },
    { name: single ? single.name : nextDefaultName(ctx.tree, DEFAULT_LAYER_PREFIX) },
  )
  if (single) {
    // With exactly one source layer, its compositing properties move outward.
    so.blendMode = single.blendMode
    so.opacity = single.opacity
    so.fillOpacity = single.fillOpacity
    so.layerMask = single.layerMask
    so.vectorMask = single.vectorMask
    so.clipping = single.clipping
    so.colorLabel = single.colorLabel
  }

  let insertPath: LayerPath
  if (belowId) insertPath = findPath(b.tree, belowId) ?? [...parentPath, 0]
  else {
    const list = parentPath.length === 0
      ? b.tree
      : (getAtPath(b.tree, parentPath) as GroupLayer | null)?.children ?? []
    insertPath = [...parentPath, list.length]
  }
  b.insertAt(insertPath, so)
  return finish(b, singleSelection(so.id), 'layer_hist_to_smart_object')
}

// ── 9.9 Rasterise ────────────────────────────────────────────────────────────

export type RasterizeWhat = 'layer' | 'style' | 'mask' | 'smartFilters' | 'all'

export function opRasterize(ctx: LayerOpContext, what: RasterizeWhat = 'layer'): LayerOpResult {
  const targets = topmostSelection(ctx.selection, ctx.tree)
  if (targets.length === 0) return refuse(ctx, 'noSelection')
  const b = new OpBuilder(ctx.tree)
  const docBounds = docBoundsOf(ctx)
  let touched = 0

  for (const id of targets) {
    const node = findLayer(b.tree, id)
    if (!node) continue
    // Rasterising an adjustment layer on its own is meaningless (Photoshop
    // greys it out and offers "merge down" instead).
    if (node.kind === 'adjustment' && (what === 'layer' || what === 'all')) {
      b.warn('rasterize.adjustment')
      continue
    }

    let next: Layer = node
    const bakeLayer = what === 'layer' || what === 'all'
    const bakeMask = what === 'mask' || what === 'all'
    const bakeStyle = what === 'style' || what === 'all'
    const bakeFilters = what === 'smartFilters' || what === 'all'

    if (bakeFilters && next.smartFilters) next = { ...next, smartFilters: null } as Layer

    if (bakeLayer && next.kind !== 'raster') {
      const bounds = contentBounds(next, docBounds)
      const surface = rasterizeWith(ctx, { layers: [next], bounds, purpose: 'rasterizeLayer' })
      // Keeps id, name, masks, styles, locks, blend mode and opacity.
      next = { ...next, kind: 'raster', surface, isBackground: false } as Layer
    }
    if (bakeMask && next.layerMask) next = { ...next, layerMask: null, vectorMask: null } as Layer
    if (bakeStyle && next.styles) next = { ...next, styles: null } as Layer

    if (next !== node) { b.replaceById(id, next); touched++ }
  }
  if (touched === 0 && b.payloads.length === 0) return refuse(ctx, 'rasterize.nothingToDo')
  return finish(b, ctx.selection, 'layer_hist_rasterize')
}

// ── 9.10 Reorder ─────────────────────────────────────────────────────────────

export type DropTarget =
  | { kind: 'before'; id: LayerId }
  | { kind: 'after'; id: LayerId }
  | { kind: 'inside'; id: LayerId; index: number }

export function opReorder(ctx: LayerOpContext, target: DropTarget, ids?: readonly LayerId[]): LayerOpResult {
  const moving = (ids ? [...ids] : topmostSelection(ctx.selection, ctx.tree))
    .filter(id => can(ctx.tree, id, 'reorder'))
  if (moving.length === 0) return refuse(ctx, 'locked')

  // 1. No cycle: a group cannot be dropped into itself or into a descendant.
  for (const id of moving) {
    if (id === target.id || isDescendant(ctx.tree, id, target.id)) return refuse(ctx, 'reorder.cycle')
  }
  // 2. The Background layer never moves, and nothing goes below it.
  for (const id of moving) {
    const n = findLayer(ctx.tree, id)
    if (n?.kind === 'raster' && n.isBackground) return refuse(ctx, 'reorder.background')
  }
  const anchor = findLayer(ctx.tree, target.id)
  if (!anchor) return refuse(ctx, 'notFound')
  if (target.kind === 'after' && anchor.kind === 'raster' && anchor.isBackground) {
    return refuse(ctx, 'reorder.background')
  }
  // 3. Reparenting is gated by `nesting`; reordering inside a list is not.
  if (target.kind === 'inside' && !can(ctx.tree, target.id, 'reparent')) {
    return refuse(ctx, 'reorder.lockedParent')
  }

  const b = new OpBuilder(ctx.tree)

  // A clipping BASE takes its clipped layers with it: they form one unit.
  const withClipped: LayerId[] = []
  for (const id of moving) {
    withClipped.push(id)
    const sib = siblingsOf(b.tree, id)
    if (!sib) continue
    const node = sib.list[sib.index]
    if (node.clipping) continue
    for (let i = sib.index - 1; i >= 0; i--) {
      if (!sib.list[i].clipping) break
      if (!withClipped.includes(sib.list[i].id)) withClipped.push(sib.list[i].id)
    }
  }
  // Display order, so the relative order of the moved layers is preserved.
  const order = flatten(ctx.tree).map(e => e.layer.id)
  const ordered = withClipped.slice().sort((a, c) => order.indexOf(a) - order.indexOf(c))

  // Which layer was the clipping base of the bottom-most moved layer?
  const bottomId = ordered[ordered.length - 1]
  let bottomBaseId: LayerId | null = null
  const bottomSib = siblingsOf(b.tree, bottomId)
  if (bottomSib && bottomSib.list[bottomSib.index]?.clipping) {
    for (let i = bottomSib.index + 1; i < bottomSib.list.length; i++) {
      if (!bottomSib.list[i].clipping) { bottomBaseId = bottomSib.list[i].id; break }
    }
  }

  const nodes: Layer[] = []
  for (const id of ordered) {
    const n = b.removeById(id)
    if (n) nodes.push(n)
  }
  if (nodes.length === 0) return refuse(ctx, 'notFound')

  const anchorPath = findPath(b.tree, target.id)
  if (!anchorPath) return refuse(ctx, 'notFound')
  let base: LayerPath
  if (target.kind === 'inside') base = [...anchorPath, Math.max(0, target.index)]
  else if (target.kind === 'before') base = anchorPath
  else base = [...anchorPath.slice(0, -1), anchorPath[anchorPath.length - 1] + 1]

  // Clipping rules. Only the BOTTOM-most moved node is concerned: it is the one
  // whose base may have been left behind (its own base is, by construction, the
  // node below it inside the moved run).
  const parentList = target.kind === 'inside'
    ? ((getAtPath(b.tree, anchorPath) as GroupLayer | null)?.children ?? [])
    : listAtPath(b.tree, anchorPath) ?? []
  const belowIndex = base[base.length - 1]
  const layerBelow: Layer | undefined = parentList[belowIndex]
  const movedSet = new Set(ordered)
  const bottom = nodes[nodes.length - 1]
  // Dropping strictly above a clipped layer means landing INSIDE a run.
  const landsInsideRun = layerBelow !== undefined && layerBelow.clipping
  // Its own base travelled with it? Then the clipping is still meaningful.
  const baseCameAlong = bottomBaseId !== null && movedSet.has(bottomBaseId)

  nodes.forEach((n, i) => {
    let node = n
    if (n.id === bottom.id) {
      if (landsInsideRun && !node.clipping) node = { ...node, clipping: true } as Layer
      else if (node.clipping && !baseCameAlong && !landsInsideRun) {
        node = { ...node, clipping: false } as Layer
      }
    }
    b.insertAt([...base.slice(0, -1), belowIndex + i], node)
  })
  return finish(b, { ids: ordered, primaryId: ordered[0], anchorId: ordered[0] }, 'layer_hist_reorder')
}

// ── 9.11 Align and distribute ────────────────────────────────────────────────

export type AlignMode = 'left' | 'hCenter' | 'right' | 'top' | 'vCenter' | 'bottom'
export type DistributeMode = AlignMode | 'hSpacing' | 'vSpacing'
export type AlignTarget = 'selection' | 'canvas' | 'artboard' | 'keyLayer'

function translated(m: Mat2x3, dx: number, dy: number): Mat2x3 {
  return [m[0], m[1], m[2], m[3], m[4] + dx, m[5] + dy]
}

interface AlignItem { id: LayerId; box: RectI }

function alignItems(ctx: LayerOpContext): AlignItem[] {
  const docBounds = docBoundsOf(ctx)
  const ids = topmostSelection(ctx.selection, ctx.tree)
  const items: AlignItem[] = []
  const linkSeen = new Set<string>()
  for (const id of ids) {
    const n = findLayer(ctx.tree, id)
    if (!n) continue
    // Linked layers move as one object.
    if (n.linkGroup !== null) {
      if (linkSeen.has(n.linkGroup)) continue
      linkSeen.add(n.linkGroup)
    }
    items.push({ id, box: contentBounds(n, docBounds) })
  }
  return items
}

function referenceBox(ctx: LayerOpContext, items: readonly AlignItem[], target: AlignTarget): RectI {
  const docBounds = docBoundsOf(ctx)
  if (target === 'canvas') return docBounds
  if (target === 'artboard') {
    const ab = ctx.tree.find(l => l.kind === 'artboard')
    return ab ? ab.frame : docBounds
  }
  if (target === 'keyLayer' && ctx.selection.primaryId) {
    const key = items.find(i => i.id === ctx.selection.primaryId)
    if (key) return key.box
  }
  let acc: RectI = { x: 0, y: 0, w: 0, h: 0 }
  for (const i of items) acc = rectUnion(acc, i.box)
  return acc
}

function alignDelta(mode: AlignMode, box: RectI, ref: RectI): { dx: number; dy: number } {
  switch (mode) {
    case 'left': return { dx: ref.x - box.x, dy: 0 }
    case 'right': return { dx: (ref.x + ref.w) - (box.x + box.w), dy: 0 }
    case 'hCenter': return { dx: (ref.x + ref.w / 2) - (box.x + box.w / 2), dy: 0 }
    case 'top': return { dx: 0, dy: ref.y - box.y }
    case 'bottom': return { dx: 0, dy: (ref.y + ref.h) - (box.y + box.h) }
    case 'vCenter': return { dx: 0, dy: (ref.y + ref.h / 2) - (box.y + box.h / 2) }
  }
}

export function opAlign(ctx: LayerOpContext, mode: AlignMode, target: AlignTarget = 'selection'): LayerOpResult {
  const items = alignItems(ctx)
  if (items.length === 0) return refuse(ctx, 'noSelection')
  const ref = referenceBox(ctx, items, target)
  const b = new OpBuilder(ctx.tree)
  for (const it of items) {
    // A position-locked layer stays put, but still counts in the reference box.
    if (!can(b.tree, it.id, 'move')) continue
    const { dx, dy } = alignDelta(mode, it.box, ref)
    if (dx === 0 && dy === 0) continue
    const n = findLayer(b.tree, it.id)
    if (!n) continue
    b.setProps(it.id, { transform: translated(n.transform, dx, dy) })
  }
  return finish(b, ctx.selection, 'layer_hist_align', { mode })
}

export function opDistribute(ctx: LayerOpContext, mode: DistributeMode): LayerOpResult {
  const items = alignItems(ctx).filter(i => can(ctx.tree, i.id, 'move'))
  if (items.length < 3) return refuse(ctx, 'distribute.needThree')

  const horizontal = mode === 'left' || mode === 'right' || mode === 'hCenter' || mode === 'hSpacing'
  const key = (b: RectI): number => {
    switch (mode) {
      case 'left': case 'hSpacing': return b.x
      case 'right': return b.x + b.w
      case 'hCenter': return b.x + b.w / 2
      case 'top': case 'vSpacing': return b.y
      case 'bottom': return b.y + b.h
      case 'vCenter': return b.y + b.h / 2
    }
  }
  const sorted = [...items].sort((a, c) => key(a.box) - key(c.box))
  const b = new OpBuilder(ctx.tree)

  if (mode === 'hSpacing' || mode === 'vSpacing') {
    // Equalise the GAPS; the two extremes never move.
    const first = sorted[0].box
    const last = sorted[sorted.length - 1].box
    const span = horizontal
      ? (last.x + last.w) - first.x
      : (last.y + last.h) - first.y
    let occupied = 0
    for (const it of sorted) occupied += horizontal ? it.box.w : it.box.h
    const gap = (span - occupied) / (sorted.length - 1)
    let cursor = horizontal ? first.x : first.y
    for (const it of sorted) {
      const cur = horizontal ? it.box.x : it.box.y
      const d = cursor - cur
      if (d !== 0) {
        const n = findLayer(b.tree, it.id)
        if (n) b.setProps(it.id, { transform: translated(n.transform, horizontal ? d : 0, horizontal ? 0 : d) })
      }
      cursor += (horizontal ? it.box.w : it.box.h) + gap
    }
    return finish(b, ctx.selection, 'layer_hist_distribute', { mode })
  }

  // Equalise the reference edges/centres.
  const start = key(sorted[0].box)
  const end = key(sorted[sorted.length - 1].box)
  const step = (end - start) / (sorted.length - 1)
  sorted.forEach((it, i) => {
    const want = start + step * i
    const d = want - key(it.box)
    if (d === 0) return
    const n = findLayer(b.tree, it.id)
    if (n) b.setProps(it.id, { transform: translated(n.transform, horizontal ? d : 0, horizontal ? 0 : d) })
  })
  return finish(b, ctx.selection, 'layer_hist_distribute', { mode })
}
