// Public surface of the layer operations.
//
// Dependency rule (spec 12.3): `model/` imports nothing but the blend-mode
// vocabulary. No React, no WebGL, no renderer, no `LayerEditorPage`. Everything
// here runs unchanged under plain Node, which is what makes it testable and
// what will allow a server-side PSD export later.

export { newLayerId, asLayerId, isLayerId, hashId } from './ids.ts'

export {
  newSurfaceId, rgba, BLACK, WHITE,
  defaultLocks, defaultContour, defaultGradient, defaultFillContent,
  emptySurface, defaultLayerMask, defaultVectorMask, emptyPath,
  defaultStyleStack, defaultSmartFilterStack, defaultAdjustment,
  defaultTextData, layerBase,
  createRasterLayer, createGroup, createAdjustmentLayer, createFillLayer,
  createTextLayer, createShapeLayer, createSmartObjectLayer, createArtboard,
} from './defaults.ts'
export type { BaseInit } from './defaults.ts'

export {
  flatten, walk, findLayer, findPath, getAtPath, listAtPath, parentOf,
  siblingsOf, isDescendant, subtreeNodes, visibleLayers,
  replaceAtPath, removeAtPath, insertAtPath, updateLayer, mapLayer, removeLayer,
  clippingRuns, clippingRunOf,
  transformRect, contentBounds,
  nextDefaultName, copyName,
  DEFAULT_LAYER_PREFIX, DEFAULT_GROUP_PREFIX, BACKGROUND_NAME,
} from './tree.ts'
export type { FlatEntry, Siblings, ClippingRun } from './tree.ts'

export {
  selectionOf, singleSelection, topmostSelection, normalizeSelection,
  toggleSelection, selectRange,
} from './selection.ts'

export { effectiveLocks, can, allowed } from './locks.ts'
export type { LockCapability } from './locks.ts'

export {
  opNew, opDuplicate, opDelete, opGroup, opUngroup,
  opMergeDown, opMergeVisible, opFlatten,
  opConvertToSmartObject, opRasterize, opReorder, opAlign, opDistribute,
} from './layerOps.ts'
export type {
  LayerOpContext, LayerOpResult, NewLayerSpec, RasterizeFn, RasterizeRequest,
  RasterizeWhat, DropTarget, AlignMode, DistributeMode, AlignTarget,
} from './layerOps.ts'

export {
  HistoryStack, Transaction, makeCommand, commandCost, applyCommandToTree,
  isStructural, coalesce, coalesceWindowFor,
  HISTORY_BUDGET, COALESCE_WINDOW_MS, CHECKPOINT_EVERY,
} from './history.ts'
export type {
  Command, CommandPayload, CommandType, Direction, TileRef, TileChange,
  TilesPayload, HistoryHost, HistoryStats, HistoryBudget, Checkpoint,
} from './history.ts'
