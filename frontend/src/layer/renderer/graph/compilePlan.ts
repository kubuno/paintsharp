// Compilation of the layer tree into a flat pass plan.
//
// Today the compositor *interprets* the tree on every frame: a recursive walk,
// a closure per layer, a `Map.get` per layer, a branch decision per frame. The
// target (spec 09-rendu §7.1) is to compile the tree ONCE per structural change
// into a flat instruction list, then merely execute it per tile.
//
// What the compiler buys, beyond not re-walking a tree 60 times a second:
//
//   * exact `scratchDepth` — the register pool is sized once and never grows;
//   * trivial per-tile skipping — an op whose bbox misses the tile is removed
//     from that tile's op list, so a typical tile runs 2-3 passes, not 30;
//   * `pass-through` becomes a COMPILE-TIME decision (flatten or isolate)
//     instead of a per-pixel one;
//   * runs of plain `normal` layers fuse into one multi-texture pass.
//
// Three semantics that the current renderer gets wrong and that are decided
// here, once, rather than in a shader branch:
//
//   E11 — a clipping run is composited as a UNIT. The base's blend mode applies
//         to the aggregate base+clipped, not to the base alone. Compositing
//         each clipped layer individually gives a different picture as soon as
//         the base is not in `normal`.
//   §5.2 — `fill` scales the content, `opacity` scales content AND styles. They
//         only collapse into one number when the layer has no styles.
//   §2.3 — a group's opacity < 100 %, a group mask or a group style FORCES
//         isolation, even on a `pass-through` group.
//
// Register discipline
// -------------------
// Register 0 is the destination tile. Isolated groups, style aggregates and
// clipping runs allocate a fresh register; clip bases allocate one to snapshot
// their alpha into. Registers are freed as soon as they die, so `scratchDepth`
// is the high-water mark, not the total count.

import type { BlendMode, CompositeOp } from '../../blend/index.ts'
import type { Rect } from './deps.ts'
import { rectIntersects, rectUnion } from './deps.ts'
import type {
  CoverageSpec,
  LayerNode,
  LayerStyleRef,
  PassOp,
  PassPlan,
  Reg,
  StyleOptions,
} from './types.ts'
import { DEFAULT_STYLE_OPTIONS, fillFoldsIntoOpacity } from './types.ts'

export interface CompileOptions {
  /** Bumped by the caller on every structural change. */
  generation: number
  /**
   * Maximum layer textures a fused pass may sample. The executor reserves one
   * unit for the backdrop, so this is already the net budget. Default 7.
   */
  maxFusedSources?: number
  /** Set false to get one op per layer — used by the fusion tests. */
  enableFusion?: boolean
  /** Document bounds; layers whose bbox is unknown are assumed to cover it. */
  documentBounds?: Rect | null
}

type ResolvedOptions = {
  generation: number
  maxFusedSources: number
  enableFusion: boolean
  documentBounds: Rect | null
}

interface CompileState {
  ops: PassOp[]
  contributing: string[]
  diagnostics: string[]
  coverage: Rect | null
  alloc: RegisterAllocator
  opts: ResolvedOptions
}

/** Free-list register allocator; `high` is the exact pool size needed. */
class RegisterAllocator {
  private next = 0
  private free: Reg[] = []
  high = 0

  alloc(): Reg {
    const r = this.free.pop() ?? this.next++
    if (this.next > this.high) this.high = this.next
    return r
  }

  release(r: Reg): void {
    this.free.push(r)
  }
}

/** Deterministic 32-bit seed from a layer id, so `dissolve` is stable per layer. */
function seedFromId(id: string): number {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

const styleOptionsOf = (n: LayerNode): StyleOptions => n.styleOptions ?? DEFAULT_STYLE_OPTIONS

const enabledStyles = (n: LayerNode): LayerStyleRef[] => n.styles.filter((s) => s.enabled)

const hasMask = (n: LayerNode): boolean => !!n.mask?.enabled || !!n.vectorMask?.enabled

/**
 * Spec 08 §2.3, `needsIsolation()`. A group escapes isolation only when it is a
 * plain, unscaled, unmasked, unstyled `pass-through` — the state a freshly
 * created group is in, which is exactly why the fast path matters.
 */
export function groupNeedsIsolation(g: LayerNode): boolean {
  if (g.isolated) return true
  if (g.blendMode !== 'pass-through') return true
  if (clamp01(g.opacity) < 1) return true
  if (clamp01(g.fill) < 1) return true
  if (hasMask(g)) return true
  if (enabledStyles(g).length > 0) return true
  if (g.clipping) return true
  if (g.knockout && g.knockout !== 'none') return true
  return false
}

function effectiveSourceId(n: LayerNode): string {
  // ORDER step 2 — dynamic filters. The filter stage republishes the layer
  // under the last enabled filter's output id; the compositor just samples it.
  for (let i = n.filters.length - 1; i >= 0; i--) {
    if (n.filters[i].enabled) return n.filters[i].outputId
  }
  return n.id
}

function boundsOf(n: LayerNode, docBounds: Rect | null): Rect | null {
  // `undefined` means "not measured yet": assume it covers the document rather
  // than wrongly skipping it. `null` means "measured, and empty".
  if (n.bbox === undefined) return docBounds
  return n.bbox
}

function subtreeBounds(nodes: LayerNode[], docBounds: Rect | null): Rect | null {
  let r: Rect | null = null
  for (const n of nodes) {
    if (!n.visible) continue
    r = rectUnion(r, n.children ? subtreeBounds(n.children, docBounds) : boundsOf(n, docBounds))
  }
  return r
}

/** Skip nodes that provably contribute nothing, before allocating anything. */
function contributes(n: LayerNode): boolean {
  if (!n.visible) return false
  if (n.opacity <= 0) return false
  // `fill: 0` still shows styles, so it is never a reason to drop a node.
  if (n.kind === 'group') return !!n.children?.some(contributes)
  if (n.kind === 'text') return false // live text has no tiles; it is rasterised upstream
  return true
}

/** A base layer and the layers clipped onto it (spec 08 §3.3). */
interface ClipRun {
  base: LayerNode
  clipped: LayerNode[]
}

/** `bottomUp` is already in draw order (children[0] is the TOP layer). */
function clipRuns(bottomUp: LayerNode[], diagnostics: string[]): ClipRun[] {
  const runs: ClipRun[] = []
  for (const n of bottomUp) {
    if (n.clipping && runs.length > 0) {
      runs[runs.length - 1].clipped.push(n)
    } else {
      if (n.clipping) {
        // The bottom layer of a sibling list cannot be clipped; Photoshop's
        // validator forces `clipping = false` there.
        diagnostics.push(`layer ${n.id}: clipping with no base below — treated as unclipped`)
      }
      runs.push({ base: n, clipped: [] })
    }
  }
  return runs
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

function maskCoverage(n: LayerNode, clipReg: Reg | null, clipFromOp: number | null): CoverageSpec {
  const mask = n.mask?.enabled ? n.mask : null
  const vec = n.vectorMask?.enabled ? n.vectorMask : null
  return {
    // ORDER step 4 — blend (pixel) mask
    maskId: mask ? mask.layerId : null,
    maskInverted: mask ? mask.inverted : false,
    maskDensity: mask ? clamp01(mask.density) : 1,
    // ORDER step 5 — vector mask; the two masks multiply (intersection)
    vectorMaskId: vec ? vec.layerId : null,
    vectorMaskInverted: vec ? vec.inverted : false,
    vectorMaskDensity: vec ? clamp01(vec.density) : 1,
    // ORDER step 7 — clipping
    clipReg,
    clipFromOp,
  }
}

function clipOnly(clipReg: Reg | null, clipFromOp: number | null): CoverageSpec {
  return {
    maskId: null,
    maskInverted: false,
    maskDensity: 1,
    vectorMaskId: null,
    vectorMaskInverted: false,
    vectorMaskDensity: 1,
    clipReg,
    clipFromOp,
  }
}

// ---------------------------------------------------------------------------
// Emission primitives
// ---------------------------------------------------------------------------

/** The layer's own pixels (or its adjustment), with no styles and no blend. */
function emitContent(
  st: CompileState,
  n: LayerNode,
  target: Reg,
  coverage: CoverageSpec,
  opacity: number,
  fill: number,
  mode: BlendMode,
): void {
  const bbox = boundsOf(n, st.opts.documentBounds)

  if (n.kind === 'adjustment' && n.adjustment) {
    st.ops.push({
      kind: 'adjust',
      target,
      layerId: n.id,
      lutId: n.adjustment.lutId,
      scope: n.adjustment.scope,
      // An adjustment has no styles, so the two opacities always collapse.
      opacity: clamp01(opacity) * clamp01(fill),
      mode,
      coverage,
      bbox,
    })
  } else {
    st.ops.push({
      kind: 'layer',
      target,
      layerId: n.id,
      sourceId: effectiveSourceId(n),
      opacity: clamp01(opacity),
      fill: clamp01(fill),
      mode,
      op: 'union',
      coverage,
      bbox,
      dissolveSeed: seedFromId(n.id),
    })
  }
  st.contributing.push(n.id)
  st.coverage = rectUnion(st.coverage, bbox)
}

function emitStyle(
  st: CompileState,
  n: LayerNode,
  style: LayerStyleRef,
  target: Reg,
  selfClipReg: Reg | null,
): void {
  // ORDER step 8 — styles are scaled by `opacity` at the aggregate level, so
  // here they carry only their OWN opacity. They are never scaled by `fill`;
  // that is the entire reason the two fields exist.
  st.ops.push({
    kind: 'layer',
    target,
    layerId: `${n.id}::style::${style.id}`,
    sourceId: style.outputId,
    opacity: clamp01(style.opacity),
    fill: 1,
    mode: style.blendMode,
    op: 'union' as CompositeOp,
    coverage: clipOnly(style.clipToLayer ? selfClipReg : null, null),
    bbox: boundsOf(n, st.opts.documentBounds),
    dissolveSeed: seedFromId(n.id + style.id),
  })
}

/**
 * Emit `body` into a private register, then composite that register onto
 * `target` as one unit. This single primitive covers all three cases that need
 * isolation — a style aggregate, an isolated group, and a clipping run —
 * because they are the same operation with different bodies.
 */
function emitIsolated(
  st: CompileState,
  opts: {
    groupId: string
    target: Reg
    opacity: number
    fill: number
    mode: BlendMode
    op: CompositeOp
    coverage: CoverageSpec
    bbox: Rect | null
    seed?: 'transparent' | 'backdrop'
    knockout?: 'none' | 'shallow' | 'deep'
  },
  body: (reg: Reg) => void,
): void {
  const reg = st.alloc.alloc()
  const seed = opts.seed ?? 'transparent'
  st.ops.push({
    kind: 'group-begin',
    target: reg,
    groupId: opts.groupId,
    seed,
    backdropReg: seed === 'backdrop' ? opts.target : null,
    isolated: seed === 'transparent',
    knockout: opts.knockout ?? 'none',
  })

  body(reg)

  st.ops.push({
    kind: 'group-end',
    source: reg,
    target: opts.target,
    groupId: opts.groupId,
    opacity: clamp01(opts.opacity) * clamp01(opts.fill),
    mode: opts.mode,
    op: opts.op,
    coverage: opts.coverage,
    combine: seed === 'backdrop' ? 'lerp' : 'over',
    bbox: opts.bbox,
  })
  st.alloc.release(reg)
  st.coverage = rectUnion(st.coverage, opts.bbox)
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

/**
 * One leaf, with its styles. `contentInto` lets a clipping run substitute a
 * richer body (base + clipped layers) while keeping the style/opacity wrapper
 * identical — the aggregate is styled and blended the same way either way.
 */
function emitLeaf(
  st: CompileState,
  n: LayerNode,
  target: Reg,
  clipReg: Reg | null,
  clipFromOp: number | null,
  contentInto?: (reg: Reg, contentCoverage: CoverageSpec) => void,
): void {
  const styles = enabledStyles(n)
  const so = styleOptionsOf(n)
  const bbox = boundsOf(n, st.opts.documentBounds)

  if (styles.length === 0 && !contentInto) {
    // Fast path, and the overwhelmingly common one: masks, opacity, fill and
    // clipping all collapse into one coverage multiply inside a single pass.
    const coverage = maskCoverage(n, clipReg, clipFromOp)
    const foldable = fillFoldsIntoOpacity(n.blendMode)
    emitContent(
      st,
      n,
      target,
      coverage,
      foldable ? clamp01(n.opacity) * clamp01(n.fill) : clamp01(n.opacity),
      foldable ? 1 : clamp01(n.fill),
      n.blendMode === 'pass-through' ? 'normal' : n.blendMode,
    )
    return
  }

  // Styled (or aggregate) path: the content lands in a private register, the
  // styles stack around it, and only then is `opacity` applied to the whole.
  //
  // Masks apply to the CONTENT, not to the styles: a drop shadow is computed
  // from the masked silhouette but is free to extend past the mask. Turning on
  // `layerMaskHidesEffects` moves the mask to the aggregate instead.
  const contentCoverage = so.layerMaskHidesEffects
    ? clipOnly(null, null)
    : maskCoverage(n, null, null)
  const aggregateCoverage = so.layerMaskHidesEffects
    ? maskCoverage(n, clipReg, clipFromOp)
    : clipOnly(clipReg, clipFromOp)

  const below = styles.filter((s) => s.placement === 'below')
  const above = styles.filter((s) => s.placement === 'above')
  const needsSelfClip = above.some((s) => s.clipToLayer)

  emitIsolated(
    st,
    {
      groupId: `${n.id}::aggregate`,
      target,
      opacity: n.opacity,
      // `fill` was already consumed by the content; never re-apply it here.
      fill: 1,
      mode: n.blendMode === 'pass-through' ? 'normal' : n.blendMode,
      op: 'union',
      coverage: aggregateCoverage,
      bbox,
    },
    (reg) => {
      for (const s of below) {
        if (s.clipToLayer) {
          st.diagnostics.push(
            `layer ${n.id}: style ${s.id} is below and clipToLayer — the layer alpha does not exist yet, clip ignored`,
          )
        }
        emitStyle(st, n, s, reg, null)
      }

      // Alpha before the content, so the self-clip snapshot can subtract the
      // back styles' contribution exactly.
      let baselineReg: Reg | null = null
      if (needsSelfClip && below.length > 0) {
        baselineReg = st.alloc.alloc()
        st.ops.push({ kind: 'snapshot-alpha', from: reg, to: baselineReg, baselineReg: null })
      }

      if (contentInto) contentInto(reg, contentCoverage)
      else emitContent(st, n, reg, contentCoverage, 1, n.fill, 'normal')

      let selfClipReg: Reg | null = null
      if (needsSelfClip) {
        selfClipReg = st.alloc.alloc()
        st.ops.push({ kind: 'snapshot-alpha', from: reg, to: selfClipReg, baselineReg })
        if (baselineReg !== null) st.alloc.release(baselineReg)
      }
      for (const s of above) emitStyle(st, n, s, reg, selfClipReg)
      if (selfClipReg !== null) st.alloc.release(selfClipReg)
    },
  )
}

function emitGroup(
  st: CompileState,
  n: LayerNode,
  target: Reg,
  clipReg: Reg | null,
  clipFromOp: number | null,
): void {
  const children = n.children ?? []
  const bbox = subtreeBounds(children, st.opts.documentBounds)

  // ORDER step 10 — the parent group. Two regimes, decided here, once.
  if (!groupNeedsIsolation(n) && clipReg === null) {
    // Free pass-through: the children are spliced straight into the parent's op
    // list. No register, no copy, no extra draw call — and a child in `multiply`
    // correctly sees what lies BELOW the group, which is the whole point.
    st.diagnostics.push(`group ${n.id}: pass-through flattened into parent`)
    emitList(st, children, target)
    return
  }

  if (n.knockout && n.knockout !== 'none') {
    st.diagnostics.push(`group ${n.id}: knockout '${n.knockout}' recorded in the plan but not executed in P0`)
  }

  const styles = enabledStyles(n)
  const so = styleOptionsOf(n)

  const emitBody = (reg: Reg): void => emitList(st, children, reg)

  if (styles.length === 0) {
    emitIsolated(
      st,
      {
        groupId: n.id,
        target,
        opacity: n.opacity,
        fill: n.fill,
        mode: n.blendMode === 'pass-through' ? 'normal' : n.blendMode,
        op: 'union',
        coverage: maskCoverage(n, clipReg, clipFromOp),
        bbox,
        knockout: n.knockout,
      },
      emitBody,
    )
    st.contributing.push(n.id)
    return
  }

  // A styled group: the isolated composite of the children is the "content",
  // and `emitLeaf`'s style wrapper handles the rest unchanged.
  emitLeaf(st, n, target, clipReg, clipFromOp, (reg, contentCoverage) => {
    emitIsolated(
      st,
      {
        groupId: n.id,
        target: reg,
        opacity: 1,
        fill: n.fill,
        mode: 'normal',
        op: 'union',
        coverage: contentCoverage,
        bbox,
        knockout: n.knockout,
      },
      emitBody,
    )
  })
  st.contributing.push(n.id)
  void so
}

function emitNode(
  st: CompileState,
  n: LayerNode,
  target: Reg,
  clipReg: Reg | null,
  clipFromOp: number | null,
): void {
  if (n.kind === 'group' && n.children) emitGroup(st, n, target, clipReg, clipFromOp)
  else emitLeaf(st, n, target, clipReg, clipFromOp)
}

/**
 * A clipping run (spec 08 §3.3), composited as ONE unit:
 *
 *   1. render the base alone onto a transparent surface;
 *   2. stack the clipped layers on top of it, in isolation;
 *   3. clip the whole stack to the base's alpha;
 *   4. blend the aggregate with the BASE's mode / opacity / fill / mask.
 *
 * Step 3 is implemented by multiplying each clipped layer's coverage by the
 * base's alpha snapshot rather than by a separate full-surface multiply pass.
 * That is algebraically equivalent — a clipped layer can only ever add alpha
 * where the base has some, and the base is already inside its own alpha — and
 * it saves one pass per clipped layer.
 *
 * Fast path: when the base is `normal`, fully opaque, unmasked, unstyled and
 * not itself clipped, isolating it changes nothing, so the run is composited
 * straight into the parent with an in-place alpha snapshot.
 */
function emitClipRun(st: CompileState, run: ClipRun, target: Reg): void {
  const { base, clipped } = run

  if (clipped.length === 0) {
    emitNode(st, base, target, null, null)
    return
  }

  const baseIsTransparentToIsolation =
    base.blendMode === 'normal' &&
    clamp01(base.opacity) === 1 &&
    clamp01(base.fill) === 1 &&
    !hasMask(base) &&
    enabledStyles(base).length === 0 &&
    base.kind !== 'group'

  if (baseIsTransparentToIsolation) {
    const baselineReg = st.alloc.alloc()
    st.ops.push({ kind: 'snapshot-alpha', from: target, to: baselineReg, baselineReg: null })

    const baseOpIndex = st.ops.length
    emitNode(st, base, target, null, null)

    const clipReg = st.alloc.alloc()
    st.ops.push({ kind: 'snapshot-alpha', from: target, to: clipReg, baselineReg })
    st.alloc.release(baselineReg)

    for (const c of clipped) emitNode(st, c, target, clipReg, baseOpIndex)
    st.alloc.release(clipReg)
    return
  }

  // General case: the aggregate is built in isolation, then blended with the
  // base's own properties. `emitLeaf` supplies the style wrapper for free.
  emitLeaf(st, base, target, null, null, (reg, contentCoverage) => {
    const baseOpIndex = st.ops.length
    if (base.kind === 'group' && base.children) {
      emitIsolated(
        st,
        {
          groupId: base.id,
          target: reg,
          opacity: 1,
          fill: base.fill,
          mode: 'normal',
          op: 'union',
          coverage: contentCoverage,
          bbox: subtreeBounds(base.children, st.opts.documentBounds),
        },
        (inner) => emitList(st, base.children ?? [], inner),
      )
    } else {
      emitContent(st, base, reg, contentCoverage, 1, base.fill, 'normal')
    }

    // The register started transparent, so its alpha IS the base's alpha.
    const clipReg = st.alloc.alloc()
    st.ops.push({ kind: 'snapshot-alpha', from: reg, to: clipReg, baselineReg: null })
    for (const c of clipped) emitNode(st, c, reg, clipReg, baseOpIndex)
    st.alloc.release(clipReg)
  })
}

/** Emit a sibling list, bottom-up, into `target`. */
function emitList(st: CompileState, nodes: LayerNode[], target: Reg): void {
  // `children[0]` is the TOP layer (PSD / Photoshop convention), so the draw
  // order is the reversed list.
  const bottomUp = [...nodes].filter(contributes).reverse()
  for (const run of clipRuns(bottomUp, st.diagnostics)) emitClipRun(st, run, target)
}

// ---------------------------------------------------------------------------
// Fusion (spec 09 §7.1, "fusion d'opérations")
// ---------------------------------------------------------------------------

type PlainLayerOp = Extract<PassOp, { kind: 'layer' }>

function isFusable(op: PassOp): op is PlainLayerOp {
  if (op.kind !== 'layer') return false
  if (op.mode !== 'normal') return false
  if (op.op !== 'union') return false
  if (op.opacity !== 1 || op.fill !== 1) return false
  const c = op.coverage
  return (
    c.maskId === null &&
    c.vectorMaskId === null &&
    c.clipReg === null &&
    c.maskDensity === 1 &&
    c.vectorMaskDensity === 1
  )
}

/**
 * Merge runs of plain `normal` layers into one multi-texture pass.
 *
 * Correctness: `source-over` is associative, so folding N of them into one
 * shader is exact, not an approximation. It is only legal because every fused
 * op is unmasked, unclipped and at full opacity — any of those needs its own
 * coverage uniform and breaks the fold.
 */
function fuse(ops: PassOp[], maxSources: number, diagnostics: string[]): PassOp[] {
  if (maxSources < 2) return ops
  const out: PassOp[] = []
  let i = 0
  while (i < ops.length) {
    const op = ops[i]
    if (!isFusable(op)) {
      out.push(op)
      i++
      continue
    }
    let j = i + 1
    while (j < ops.length && j - i < maxSources) {
      const nxt = ops[j]
      if (!isFusable(nxt) || nxt.target !== op.target) break
      j++
    }
    if (j - i < 2) {
      out.push(op)
      i++
      continue
    }
    const run = ops.slice(i, j) as PlainLayerOp[]
    let bbox: Rect | null = null
    for (const r of run) bbox = rectUnion(bbox, r.bbox)
    out.push({
      kind: 'layers',
      target: op.target,
      layerIds: run.map((r) => r.layerId),
      sourceIds: run.map((r) => r.sourceId),
      bbox,
    })
    diagnostics.push(`fused ${run.length} normal layers into one pass: ${run.map((r) => r.layerId).join(', ')}`)
    i = j
  }
  return out
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function compilePlan(tree: LayerNode[], opts: CompileOptions): PassPlan {
  const st: CompileState = {
    ops: [],
    contributing: [],
    diagnostics: [],
    coverage: null,
    alloc: new RegisterAllocator(),
    opts: {
      generation: opts.generation,
      maxFusedSources: opts.maxFusedSources ?? 7,
      enableFusion: opts.enableFusion ?? true,
      documentBounds: opts.documentBounds ?? null,
    },
  }

  const root = st.alloc.alloc() // always register 0
  st.ops.push({ kind: 'clear', target: root })
  emitList(st, tree, root)

  const ops = st.opts.enableFusion ? fuse(st.ops, st.opts.maxFusedSources, st.diagnostics) : st.ops

  return {
    ops,
    scratchDepth: Math.max(1, st.alloc.high),
    coverage: st.coverage,
    generation: opts.generation,
    contributingLayers: st.contributing,
    diagnostics: st.diagnostics,
  }
}

// ---------------------------------------------------------------------------
// Per-tile specialisation
// ---------------------------------------------------------------------------

/**
 * Drop from the plan everything that provably cannot touch `tile`.
 *
 * Three cascading rules:
 *   1. an op whose bbox misses the tile contributes nothing;
 *   2. if a clip base misses the tile its alpha snapshot is all zeros, so every
 *      layer clipped to it is dead too;
 *   3. a group whose body became empty is dropped along with its begin/end, and
 *      snapshots nobody reads any more go with it.
 *
 * The register count is deliberately NOT recomputed: the pool is sized from the
 * full plan so it never has to grow mid-frame.
 */
export function specialisePlan(plan: PassPlan, tile: Rect): PassPlan {
  const kept: PassOp[] = []

  for (const op of plan.ops) {
    switch (op.kind) {
      case 'clear':
      case 'mask-resolve':
      case 'snapshot-alpha':
      case 'group-begin':
        kept.push(op)
        break
      case 'group-end':
        if (op.bbox && !rectIntersects(op.bbox, tile)) break
        kept.push(op)
        break
      case 'layers':
        if (op.bbox && !rectIntersects(op.bbox, tile)) break
        kept.push(op)
        break
      default:
        if (op.bbox && !rectIntersects(op.bbox, tile)) break
        kept.push(op)
        break
    }
  }

  return { ...plan, ops: prune(kept) }
}

/** Remove empty groups and dead snapshots until a fixed point is reached. */
function prune(ops: PassOp[]): PassOp[] {
  const out = ops.slice()
  let changed = true
  while (changed) {
    changed = false
    for (let i = 0; i < out.length; i++) {
      const op = out[i]
      if (op.kind !== 'group-begin') continue

      let depth = 0
      let end = -1
      for (let j = i + 1; j < out.length; j++) {
        const o = out[j]
        if (o.kind === 'group-begin') depth++
        else if (o.kind === 'group-end') {
          if (depth === 0) {
            if (o.groupId === op.groupId) end = j
            break
          }
          depth--
        }
      }
      if (end === -1) {
        // The matching end was dropped as out-of-tile: the group is dead.
        out.splice(i, 1)
        changed = true
        break
      }
      const draws = out
        .slice(i + 1, end)
        .some((o) => o.kind !== 'snapshot-alpha' && o.kind !== 'mask-resolve' && o.kind !== 'clear')
      if (!draws) {
        out.splice(i, end - i + 1)
        changed = true
        break
      }
    }
  }

  const read = new Set<Reg>()
  for (const o of out) {
    if (o.kind === 'layer' || o.kind === 'adjust' || o.kind === 'group-end' || o.kind === 'stroke') {
      if (o.coverage.clipReg !== null) read.add(o.coverage.clipReg)
    }
    if (o.kind === 'snapshot-alpha' && o.baselineReg !== null) read.add(o.baselineReg)
  }
  return out.filter((o) => o.kind !== 'snapshot-alpha' || read.has(o.to))
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/** Human-readable dump of a plan — the tests assert on this. */
export function planToString(plan: PassPlan): string {
  const lines: string[] = [`plan gen=${plan.generation} regs=${plan.scratchDepth} ops=${plan.ops.length}`]
  let indent = 0
  const cov = (c: CoverageSpec): string =>
    `${c.maskId ? ` mask=${c.maskId}${c.maskInverted ? '(inv)' : ''}` : ''}` +
    `${c.vectorMaskId ? ` vmask=${c.vectorMaskId}${c.vectorMaskInverted ? '(inv)' : ''}` : ''}` +
    `${c.clipReg !== null ? ` clip=r${c.clipReg}` : ''}`

  for (const op of plan.ops) {
    if (op.kind === 'group-end') indent = Math.max(0, indent - 1)
    const pad = '  '.repeat(indent + 1)
    switch (op.kind) {
      case 'clear':
        lines.push(`${pad}clear r${op.target}`)
        break
      case 'layer':
        lines.push(
          `${pad}layer ${op.layerId} -> r${op.target} src=${op.sourceId} o=${op.opacity} f=${op.fill} mode=${op.mode}${cov(op.coverage)}`,
        )
        break
      case 'layers':
        lines.push(`${pad}layers[${op.layerIds.length}] -> r${op.target} (${op.layerIds.join(',')})`)
        break
      case 'snapshot-alpha':
        lines.push(`${pad}snapshot r${op.from} -> r${op.to}${op.baselineReg !== null ? ` base=r${op.baselineReg}` : ''}`)
        break
      case 'mask-resolve':
        lines.push(`${pad}mask-resolve -> r${op.target}`)
        break
      case 'group-begin':
        lines.push(`${pad}group-begin ${op.groupId} -> r${op.target} seed=${op.seed}`)
        indent++
        break
      case 'group-end':
        lines.push(
          `${pad}group-end ${op.groupId} r${op.source} -> r${op.target} o=${op.opacity} mode=${op.mode} ${op.combine}${cov(op.coverage)}`,
        )
        break
      case 'adjust':
        lines.push(`${pad}adjust ${op.layerId} -> r${op.target} lut=${op.lutId} scope=${op.scope}${cov(op.coverage)}`)
        break
      case 'stroke':
        lines.push(`${pad}stroke -> r${op.target} o=${op.opacity}${op.erase ? ' erase' : ''}`)
        break
    }
  }
  return lines.join('\n')
}

/**
 * Modes that must READ the backdrop and therefore force a ping-pong.
 * See `passes/hardwareBlend.ts` for the (short) list that does not.
 */
export function needsBackdropRead(mode: BlendMode): boolean {
  return mode !== 'normal' && mode !== 'linear-dodge' && mode !== 'screen'
}
