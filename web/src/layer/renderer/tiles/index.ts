// Stage 2 of the Layer render pipeline — tiling, invalidation, LOD, scheduling.
//
//   GLDevice (stage 4)  ->  TileCache / Scheduler / DirtyRegion (this stage)
//                       ->  CompositeGraph (stage 3)  ->  Renderer (stage 1)
//
// Nothing in this folder imports React, the DOM or WebGL. The only GPU contact
// is through `GLDeviceLike`, a four-method interface that the real `GLDevice`
// satisfies structurally — which is what let this stage be written and tested
// in parallel with stage 4.

export * from './geometry'
export * from './GLDeviceLike'
export { DirtyRegion, type DirtyRegionStats } from './DirtyRegion'
export {
  TileCache,
  type CompositedTile,
  type TileCacheOptions,
  type TileCacheStats,
} from './TileCache'
export {
  SparseLayer,
  // Name used by the render spec (09-rendu.md, 3.2) for the same structure.
  SparseLayer as LayerTileStore,
  type LayerTile,
  type SparseLayerOptions,
  type SparseLayerStats,
  type WriteOptions,
} from './SparseLayer'
export {
  LodPyramid,
  levelForScale,
  maxLevelFor,
  type LodPyramidOptions,
  type LodPyramidStats,
} from './LodPyramid'
export {
  TileScheduler,
  DEFAULT_FRAME_BUDGET,
  DEFAULT_RENDER_BUDGET,
  budgetForFrameMs,
  visibleDocRect,
  viewportIsEmpty,
  type FrameBudget,
  type PlanRequest,
  type RenderBudget,
  type SchedulerRunResult,
  type SchedulerStats,
  type StopReason,
  type TileBuilder,
  type TileWorkSource,
  type ViewportLike,
} from './Scheduler'
