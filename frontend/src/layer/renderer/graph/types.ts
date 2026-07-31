// The layer tree as the compositor sees it, and the flat pass plan it compiles to.
//
// This is a *render-side* model: it is derived from the wire type
// `LayerStructureItem` (see `fromStructure.ts`) and contains only what affects
// pixels. Names, colour labels, expanded state and locks do not appear here —
// changing them must never invalidate a tile.

import type { BlendMode, CompositeOp } from '../../blend/index.ts'
import type { Rect } from './deps.ts'

// ---------------------------------------------------------------------------
// Input model
// ---------------------------------------------------------------------------

export type LayerKind = 'raster' | 'group' | 'adjustment' | 'text' | 'shape'

/** Pixel mask stored as its own single-channel tile store (spec 08). */
export interface MaskRef {
  /** Id under which the mask tiles are stored. */
  layerId: string
  enabled: boolean
  inverted: boolean
  /** 0..1 — scales the mask's effect without editing it (Photoshop "density"). */
  density: number
}

/**
 * Vector mask. Rasterised to coverage tiles by the shape stage under the same
 * id; from the compositor's point of view it is a second mask multiplied in
 * *after* the pixel mask (see ORDER OF APPLICATION below).
 */
export interface VectorMaskRef {
  layerId: string
  enabled: boolean
  inverted: boolean
  /** 0..1, same meaning as `MaskRef.density`. */
  density: number
}

/**
 * A non-destructive filter attached to a layer ("smart filter"). The pixels the
 * compositor samples are the *filtered* pixels; the filter stage (`filters/`)
 * publishes them under `outputId`, which the compositor then treats exactly
 * like a plain layer texture. That is the whole contract — the compositor never
 * runs a filter itself.
 */
export interface DynamicFilterRef {
  id: string
  /** Tile-store id holding the filtered result for this layer. */
  outputId: string
  enabled: boolean
}

/** A layer style / effect (drop shadow, stroke, glow…). */
export interface LayerStyleRef {
  id: string
  /** Tile-store id holding the rasterised effect. */
  outputId: string
  enabled: boolean
  /** Styles draw either under or over the layer's own pixels. */
  placement: 'below' | 'above'
  blendMode: BlendMode
  opacity: number
  /**
   * Photoshop's "Blend Interior Effects as Group" / knockout interaction. When
   * true the effect is confined to the layer's own alpha.
   */
  clipToLayer: boolean
}

/** Adjustment layer — a colour operator applied to whatever is beneath it. */
export interface AdjustmentRef {
  /** Tile-store id of the 1D/3D LUT texture produced by `filters/`. */
  lutId: string
  /** 'below' = the whole backdrop; 'clipped' = only the clip base. */
  scope: 'below' | 'clipped'
}

export type Knockout = 'none' | 'shallow' | 'deep'

/** Blending options that live with the style stack (spec 08 §7.1, §7.11). */
export interface StyleOptions {
  /**
   * When true the layer/vector mask is applied AFTER the styles, so it cuts the
   * drop shadow too. Default false: the mask shapes the *silhouette* the styles
   * are computed from, and the shadow is then free to extend past the mask.
   */
  layerMaskHidesEffects: boolean
  /** Photoshop "Blend Clipped Layers as Group". Default true. */
  blendClippedAsGroup: boolean
}

export const DEFAULT_STYLE_OPTIONS: StyleOptions = {
  layerMaskHidesEffects: false,
  blendClippedAsGroup: true,
}

export interface LayerNode {
  id: string
  kind: LayerKind
  visible: boolean
  /** 0..1 — scales pixels AND styles. */
  opacity: number
  /** 0..1 — "fill opacity": scales pixels only, never styles. */
  fill: number
  blendMode: BlendMode
  /** Clips to the alpha of the nearest non-clipping sibling below. */
  clipping: boolean
  mask: MaskRef | null
  vectorMask: VectorMaskRef | null
  filters: DynamicFilterRef[]
  styles: LayerStyleRef[]
  styleOptions?: StyleOptions
  adjustment: AdjustmentRef | null

  // Group-only
  children?: LayerNode[]
  /**
   * Forces the group to composite against a transparent backdrop. A group whose
   * blend mode is anything other than `pass-through` is isolated by definition
   * (PDF 1.7 §11.4.5 knockout/isolation, and Photoshop's observable behaviour).
   */
  isolated?: boolean
  knockout?: Knockout

  /** Non-empty pixel bounds, doc space. `null` = empty; `undefined` = unknown. */
  bbox?: Rect | null
}

// ---------------------------------------------------------------------------
// ORDER OF APPLICATION — the normative sequence, implemented by `compilePlan`
// ---------------------------------------------------------------------------
/**
 * For one layer, from its stored pixels to its contribution to its parent:
 *
 *   1. pixels          — the layer's own tiles (premultiplied working space)
 *   2. dynamic filters — smart filters in sequence; the last enabled one's
 *                        output is what the compositor samples (`sourceId`)
 *   3. transform       — an affine sampling matrix on the layer texture; free,
 *                        because it is a uniform, not a resample pass
 *   4. blend mask      — pixel mask, with `inverted`, `density`, `feather`
 *   5. vector mask     — rasterised path coverage, same modifiers
 *   6. opacity         — TWO distinct values:
 *                          `fill`    scales the CONTENT only
 *                          `opacity` scales content AND styles, applied at (8)
 *   7. clipping        — the clipping run is composited as a UNIT: base alone,
 *                        clipped layers stacked over it, the whole multiplied
 *                        by the base's alpha, then blended with the BASE's
 *                        mode/opacity/mask
 *   8. styles          — computed from the alpha of (5), i.e. after masks but
 *                        BEFORE `fill`; stacked back-to-front around the
 *                        content; the aggregate is then scaled by `opacity`
 *   9. blend mode      — B(Cb,Cs) plus the full PDF alpha composition, against
 *                        the sibling backdrop
 *  10. parent group    — that result becomes the parent group's content (1),
 *                        and the group runs (2)..(9) on itself
 *
 * Steps 4-7 all reduce *coverage*, so in a premultiplied pipeline they collapse
 * into one scalar multiplied into `vec4(rgb, a)`. That algebraic collapse is
 * what lets a layer with a mask, a vector mask, an opacity and a clip still
 * cost exactly one pass — the overwhelmingly common case.
 *
 * The two opacities only collapse into one when the layer has no styles; the
 * canonical counter-example is text at `fill = 0` with a stroke and a drop
 * shadow, where the fill vanishes but the effects stay.
 */
export const ORDER_OF_APPLICATION = [
  'pixels',
  'dynamic-filters',
  'transform',
  'blend-mask',
  'vector-mask',
  'opacity',
  'clipping',
  'styles',
  'blend-mode',
  'parent-group',
] as const

export type OrderStage = (typeof ORDER_OF_APPLICATION)[number]

// ---------------------------------------------------------------------------
// Pass plan
// ---------------------------------------------------------------------------

/**
 * Index into the register file. Register 0 is always the destination tile; a
 * group opens a fresh register one level deeper. `PassPlan.scratchDepth` is the
 * exact number of registers the plan needs, so the pool is sized once and never
 * grows (spec §7.1).
 */
export type Reg = number

/** Coverage inputs of one layer pass, resolved at compile time. */
export interface CoverageSpec {
  /** Tile-store id of the pixel mask, or null. */
  maskId: string | null
  maskInverted: boolean
  maskDensity: number
  /** Tile-store id of the vector mask coverage, or null. */
  vectorMaskId: string | null
  vectorMaskInverted: boolean
  vectorMaskDensity: number
  /**
   * Register holding the clip base's alpha snapshot, or null. Note this is a
   * *register*, not a texture: the clip base may be a group, so what clips is
   * the composed alpha, not a raw layer texture (spec §7.1, fix for F14).
   */
  clipReg: Reg | null
  /** Index in `ops` of the op that produced the clip base — for diagnostics. */
  clipFromOp: number | null
}

export const NO_COVERAGE: CoverageSpec = {
  maskId: null,
  maskInverted: false,
  maskDensity: 1,
  vectorMaskId: null,
  vectorMaskInverted: false,
  vectorMaskDensity: 1,
  clipReg: null,
  clipFromOp: null,
}

export interface ClearOp {
  kind: 'clear'
  target: Reg
}

/** Composite one source texture onto `target`. */
export interface LayerOp {
  kind: 'layer'
  target: Reg
  /** Layer identity, for diagnostics and thumbnail bookkeeping. */
  layerId: string
  /**
   * Tile-store id actually sampled — the last enabled dynamic filter's output
   * when the layer has filters, otherwise `layerId` itself (order step 2).
   */
  sourceId: string
  /** Order step 6, "opacity" half. Scales the whole contribution. */
  opacity: number
  /**
   * Order step 6, "fill" half. Kept SEPARATE from `opacity` on purpose: for the
   * modes listed in `FILL_NEUTRAL_COLOR`, Photoshop interpolates the source
   * colour towards the mode's neutral colour instead of scaling alpha, and the
   * two are not interchangeable. When a layer has no styles the compiler is
   * still free to fold `fill` into `opacity` — but only for the other modes.
   */
  fill: number
  mode: BlendMode
  op: CompositeOp
  coverage: CoverageSpec
  /** Layer bbox; tiles that do not intersect it are dropped from the plan. */
  bbox: Rect | null
  /** Stable per-layer seed so `dissolve` does not shimmer between frames. */
  dissolveSeed: number
}

/**
 * Modes where `fill` interpolates the SOURCE COLOUR toward a neutral value
 * rather than scaling alpha (spec 08 §5.3). Reproducing this is what makes
 * "fill 50 % + Color Dodge" match Photoshop.
 */
export const FILL_NEUTRAL_COLOR: Partial<Record<BlendMode, number>> = {
  'color-burn': 1,
  'linear-burn': 1,
  'color-dodge': 0,
  'linear-dodge': 0,
  'vivid-light': 0.5,
  'linear-light': 0.5,
  'hard-mix': 0.5,
  difference: 0,
  exclusion: 0,
  subtract: 0,
  divide: 1,
}

/** True when `fill` may simply be multiplied into `opacity`. */
export const fillFoldsIntoOpacity = (mode: BlendMode): boolean =>
  FILL_NEUTRAL_COLOR[mode] === undefined

/**
 * A run of consecutive `normal`, fully opaque, unmasked, unclipped layers fused
 * into ONE multi-texture pass (spec §7.1, "fusion d'opérations"). Capped by
 * `GLCapsLike.maxFragmentTextureUnits` minus the backdrop sampler.
 */
export interface FusedLayersOp {
  kind: 'layers'
  target: Reg
  layerIds: string[]
  sourceIds: string[]
  bbox: Rect | null
}

/**
 * Capture the clip base's own alpha into `to`.
 *
 * Model note: what clips is the *composited* base, not a raw layer texture —
 * a group, or a base carrying a mask, must be able to serve as a clip base.
 * Reading the raw texture instead is exactly defect F14.
 *
 * When `baselineReg` is given, the base's own alpha is recovered EXACTLY from
 * the accumulator, because `source-over` is invertible in alpha:
 *
 *     a_after = a_base + a_before·(1 - a_base)
 *  =>  a_base = (a_after - a_before) / (1 - a_before)
 *
 * so the snapshot works even when the base was drawn onto a non-empty backdrop,
 * and even when style layers were drawn before it. Without a baseline the whole
 * accumulator alpha is taken, which is only correct on a transparent register.
 */
export interface SnapshotAlphaOp {
  kind: 'snapshot-alpha'
  from: Reg
  to: Reg
  /** Accumulator alpha *before* the base was drawn; null = register was empty. */
  baselineReg: Reg | null
}

/**
 * Resolve pixel mask x vector mask x densities into a single coverage register,
 * so the layer pass samples one texture instead of two. Only emitted when the
 * layer genuinely has both masks — otherwise the coverage folds into the layer
 * pass for free.
 */
export interface MaskResolveOp {
  kind: 'mask-resolve'
  target: Reg
  maskId: string | null
  maskInverted: boolean
  maskDensity: number
  vectorMaskId: string | null
  vectorMaskInverted: boolean
  vectorMaskDensity: number
}

/**
 * Open a group's accumulator.
 *
 * `seed` is the whole isolation question in one field:
 *   'transparent' — isolated group (any blend mode other than `pass-through`,
 *                   or `isolated: true`): children never see the backdrop.
 *   'backdrop'    — non-isolated pass-through group that still needs its own
 *                   register because its contribution is scaled or masked.
 *                   Children see the backdrop, exactly as pass-through demands.
 *
 * A pass-through group at opacity 1 with no mask and no styles emits NO
 * group-begin/group-end at all: its children are flattened into the parent's op
 * list. That is what makes pass-through free.
 */
export interface GroupBeginOp {
  kind: 'group-begin'
  target: Reg
  groupId: string
  seed: 'transparent' | 'backdrop'
  /** Register the backdrop is copied from when `seed === 'backdrop'`. */
  backdropReg: Reg | null
  isolated: boolean
  /**
   * PDF 1.7 §11.4.5 knockout. Carried through the plan for fidelity of the
   * model, but NOT executed in P0 — `GroupPass` logs it once and treats it as
   * 'none'. Flagging it beats silently pretending it works.
   */
  knockout: Knockout
}

export interface GroupEndOp {
  kind: 'group-end'
  source: Reg
  target: Reg
  groupId: string
  opacity: number
  mode: BlendMode
  op: CompositeOp
  coverage: CoverageSpec
  /**
   * 'over'  — composite the isolated result onto the parent (normal case).
   * 'lerp'  — mix parent and result by `opacity`: the correct resolution for a
   *           pass-through group whose opacity is < 1, because its children
   *           already composited against the backdrop.
   */
  combine: 'over' | 'lerp'
  bbox: Rect | null
}

/**
 * Adjustment layer: reads the accumulator and rewrites it through a LUT.
 * Non-destructive by construction — it never touches a layer's stored pixels,
 * which is the fix for the current preview path writing back into the layer
 * texture and clipping to 8 bits.
 *
 * The composite operator is ALWAYS `clip-to-backdrop`: an adjustment can change
 * colour where colour already exists, but can neither add nor remove opacity
 * (`ar = ab`). That invariant is what makes an adjustment layer over empty
 * canvas a no-op instead of a grey rectangle.
 */
export interface AdjustOp {
  kind: 'adjust'
  target: Reg
  layerId: string
  lutId: string
  scope: 'below' | 'clipped'
  /** Already folded: opacity x fill; an adjustment has no styles to protect. */
  opacity: number
  mode: BlendMode
  coverage: CoverageSpec
  bbox: Rect | null
}

/**
 * The live brush stroke. Its texture is supplied by the paint stage through
 * `LayerSourceLike` under a reserved id, so the compositor treats it as any
 * other source — the stroke is not a special case in the graph.
 */
export interface StrokeOp {
  kind: 'stroke'
  target: Reg
  sourceId: string
  opacity: number
  mode: BlendMode
  /** Eraser: the stroke subtracts alpha instead of adding colour. */
  erase: boolean
  coverage: CoverageSpec
  bbox: Rect | null
}

export type PassOp =
  | ClearOp
  | LayerOp
  | FusedLayersOp
  | SnapshotAlphaOp
  | MaskResolveOp
  | GroupBeginOp
  | GroupEndOp
  | AdjustOp
  | StrokeOp

export type PassOpKind = PassOp['kind']

export interface PassPlan {
  ops: PassOp[]
  /** Exact number of registers required — sizes the scratch pool (spec §7.1). */
  scratchDepth: number
  /** Union of all contributing bboxes; tiles outside it are trivially empty. */
  coverage: Rect | null
  /** Bumped on every recompilation; cached tiles carry it to detect staleness. */
  generation: number
  /** Layers that actually contribute, in draw order — used by thumbnails/stats. */
  contributingLayers: string[]
  /** Non-fatal notes: unsupported features, dropped nodes, fusion decisions. */
  diagnostics: string[]
}

export const EMPTY_PLAN: PassPlan = {
  ops: [],
  scratchDepth: 1,
  coverage: null,
  generation: 0,
  contributingLayers: [],
  diagnostics: [],
}
