// Public surface of the composition stage (étage 3).
//
// Dependency rule: this folder depends downwards on structural interfaces only
// (`deps.ts`) and on `layer/blend/` for the formulas. It never imports `gl/`,
// `tiles/`, React, or anything from the editor UI.

export { CompositeGraph } from './CompositeGraph.ts'
export type { CompositeGraphOptions, BuildResult } from './CompositeGraph.ts'

export { compilePlan, specialisePlan, planToString, groupNeedsIsolation, needsBackdropRead } from './compilePlan.ts'
export type { CompileOptions } from './compilePlan.ts'

export {
  ORDER_OF_APPLICATION,
  DEFAULT_STYLE_OPTIONS,
  FILL_NEUTRAL_COLOR,
  EMPTY_PLAN,
  NO_COVERAGE,
  fillFoldsIntoOpacity,
} from './types.ts'
export type {
  AdjustOp,
  AdjustmentRef,
  ClearOp,
  CoverageSpec,
  DynamicFilterRef,
  FusedLayersOp,
  GroupBeginOp,
  GroupEndOp,
  Knockout,
  LayerKind,
  LayerNode,
  LayerOp,
  LayerStyleRef,
  MaskRef,
  MaskResolveOp,
  OrderStage,
  PassOp,
  PassOpKind,
  PassPlan,
  Reg,
  SnapshotAlphaOp,
  StrokeOp,
  StyleOptions,
  VectorMaskRef,
} from './types.ts'

export {
  BYTES_PER_TEXEL,
  CHUNK_SIZE,
  TILE_SIZE,
  rect,
  rectIntersection,
  rectIntersects,
  rectIsEmpty,
  rectUnion,
  tileRect,
} from './deps.ts'
export type {
  BlendState,
  CompositedTileLike,
  DirtyRegionLike,
  GLCapsLike,
  GLDeviceLike,
  LayerSourceLike,
  ProgramLike,
  Rect,
  RenderBudget,
  RenderTargetLike,
  TileCacheLike,
  TileKey,
  TileSchedulerLike,
  ViewportLike,
  WorkingFormat,
} from './deps.ts'

export {
  HARDWARE_BLENDABLE,
  RegisterFile,
  THUMBNAIL_SIZE,
  ThumbnailPass,
  hardwareBlendFor,
  sourceOver,
} from './passes/index.ts'
export type { Pass, PassContext, PassStats, ThumbnailRequest } from './passes/index.ts'

export {
  BLEND_SPACE,
  DEFAULT_BLEND_SPACE,
  FRAG_ADJUST,
  FRAG_BLIT,
  FRAG_GROUP_LERP,
  FRAG_MASK_RESOLVE,
  FRAG_SNAPSHOT_ALPHA,
  FRAG_THUMBNAIL,
  VERT_QUAD,
  compositeFragment,
  compositeShaderKey,
  fusedFragment,
  fusedShaderKey,
} from './shaders.ts'
export type { BlendSpace, CompositeShaderOptions } from './shaders.ts'
