// The elementary passes of the composition stage.
//
// Each one does a single thing to a single register for a single tile. None of
// them allocates a document-sized surface, reads back synchronously, or looks
// at the layer tree.

export { clearPass } from './ClearPass.ts'
export { layerPass, strokePass, fusedLayersPass } from './LayerPass.ts'
export { maskResolvePass } from './MaskPass.ts'
export { clipSnapshotPass } from './ClipPass.ts'
export { groupBeginPass, groupEndPass } from './GroupPass.ts'
export { adjustPass } from './AdjustPass.ts'
export { ThumbnailPass, THUMBNAIL_SIZE } from './ThumbnailPass.ts'
export type { ThumbnailRequest } from './ThumbnailPass.ts'
export { HARDWARE_BLENDABLE, hardwareBlendFor, sourceOver } from './hardwareBlend.ts'
export { RegisterFile, beginDraw, newPassStats, scissorForTile } from './types.ts'
export type { Pass, PassContext, PassStats } from './types.ts'
