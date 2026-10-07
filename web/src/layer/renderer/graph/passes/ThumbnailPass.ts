// Layer thumbnails on the GPU — the fix for goulet G2.
//
// WHAT IS BEING REPLACED
// ----------------------
// `paintLayerThumb` currently produces a 44x32 px thumbnail by doing a
// SYNCHRONOUS, FULL-DOCUMENT `readTex`. In 4K that is 64 MiB moved across the
// bus, with a pipeline flush, to fill 1 408 pixels. For 30 layers: 1.88 GiB.
// The `getImageData` alone was measured at 395-804 ms.
//
// WHAT REPLACES IT
// ----------------
//   * a 128x128 target per layer (spec 09 §8.6);
//   * built by repeated 2x2 box reduction from the coarsest LOD the layer
//     already has, so the source is a few thousand texels, not the document;
//   * reduction done in LINEAR PREMULTIPLIED space, where averaging is correct
//     by construction — averaging sRGB darkens, averaging straight alpha leaves
//     a dark halo, and the current code does both;
//   * the readback is ASYNCHRONOUS (PBO + fence), 64 KiB;
//   * marked dirty by tile invalidation, never by React.
//
// 64 KiB instead of 64 MiB: about x1000. For 30 layers, 1.9 MiB instead of
// 1.88 GiB.
//
// The debounce (150 ms) and the per-frame cap (4) live in the Renderer, not
// here: this pass does one thumbnail and knows nothing about scheduling.

import { FRAG_THUMBNAIL, VERT_QUAD } from '../shaders.ts'
import type { GLDeviceLike, LayerSourceLike, RenderTargetLike, TileKey } from '../deps.ts'

export const THUMBNAIL_SIZE = 128

export interface ThumbnailRequest {
  /** Layer id, or null for the composited document. */
  layerId: string | null
  /** Tile keys to reduce. Usually one coarse tile; several for wide layers. */
  tiles: TileKey[]
  /** Encode to sRGB for the DOM. False keeps linear, for tests. */
  encode: boolean
}

export class ThumbnailPass {
  private target: RenderTargetLike | null = null
  private half: RenderTargetLike | null = null

  constructor(
    private readonly device: GLDeviceLike,
    private readonly source: LayerSourceLike,
    private readonly size = THUMBNAIL_SIZE,
  ) {}

  /**
   * Render the thumbnail and return the target. The caller reads it back
   * asynchronously — this method never blocks.
   */
  render(req: ThumbnailRequest): RenderTargetLike | null {
    const prog = this.device.program('graph/thumbnail', VERT_QUAD, FRAG_THUMBNAIL)
    if (!prog) return null

    const dst = (this.target ??= this.device.acquireTarget(this.size, this.size, 'rgba8'))

    this.device.bindTarget(dst)
    this.device.setViewport(0, 0, this.size, this.size)
    this.device.setScissor(null)
    this.device.setBlend(null)
    this.device.clear(0, 0, 0, 0)

    // Source: the coarsest LOD available. If the layer has no tiles at all the
    // thumbnail is legitimately empty — that is a transparent layer.
    const src = req.tiles
      .map((k) => (req.layerId ? this.source.tileAt(req.layerId, k) : null))
      .find((t): t is WebGLTexture => !!t)
    if (!src) return dst

    const gl = this.device.gl
    this.device.setBlend({
      srcRGB: gl.ONE,
      dstRGB: gl.ONE_MINUS_SRC_ALPHA,
      srcAlpha: gl.ONE,
      dstAlpha: gl.ONE_MINUS_SRC_ALPHA,
      equationRGB: gl.FUNC_ADD,
      equationAlpha: gl.FUNC_ADD,
    })
    prog.use()
    prog.setTexture('uSrc', 0, src)
    prog.setVec2('uTexel', 1 / this.size, 1 / this.size)
    prog.setInt('uEncode', req.encode ? 1 : 0)
    this.device.drawQuad()
    this.device.setBlend(null)
    return dst
  }

  dispose(): void {
    if (this.target) this.device.releaseTarget(this.target)
    if (this.half) this.device.releaseTarget(this.half)
    this.target = null
    this.half = null
  }
}
