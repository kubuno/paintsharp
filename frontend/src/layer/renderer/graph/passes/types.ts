// Shared vocabulary of the elementary passes.
//
// A pass does ONE thing to ONE register, for ONE tile. It never allocates a
// document-sized surface, never reads back synchronously, and never looks at
// the layer tree — it only sees the op it was handed.

import type {
  GLDeviceLike,
  LayerSourceLike,
  Rect,
  RenderTargetLike,
  TileKey,
  WorkingFormat,
} from '../deps.ts'
import type { PassOp, Reg } from '../types.ts'
import type { BlendSpace } from '../shaders.ts'

export interface PassStats {
  drawCalls: number
  registerSwaps: number
  hardwareBlends: number
  skipped: number
}

export const newPassStats = (): PassStats => ({
  drawCalls: 0,
  registerSwaps: 0,
  hardwareBlends: 0,
  skipped: 0,
})

/**
 * The register file: `scratchDepth` ping-pong PAIRS of tile-sized targets.
 *
 * The pair is what makes non-separable blend modes possible in WebGL2: there is
 * no `EXT_shader_framebuffer_fetch`, so a mode that must READ the backdrop has
 * to read one texture and write another. The point of the tiling stage is that
 * this ping-pong now costs 256x256 instead of a full document — 512 KiB instead
 * of 64 MiB in 4K, per level of group nesting.
 *
 * The second half of a pair is allocated lazily: a register that only ever sees
 * hardware-blendable modes never pays for it.
 */
export class RegisterFile {
  private readonly front: (RenderTargetLike | null)[]
  private readonly back: (RenderTargetLike | null)[]

  constructor(
    private readonly device: GLDeviceLike,
    private readonly size: number,
    readonly depth: number,
    private readonly format: WorkingFormat,
  ) {
    this.front = new Array<RenderTargetLike | null>(depth).fill(null)
    this.back = new Array<RenderTargetLike | null>(depth).fill(null)
  }

  /** The register's current contents. Allocated (contents undefined) on demand. */
  current(i: Reg): RenderTargetLike {
    const t = this.front[i] ?? this.device.acquireTarget(this.size, this.size, this.format)
    this.front[i] = t
    return t
  }

  /** The ping-pong partner. Write here, then call `swap`. */
  scratch(i: Reg): RenderTargetLike {
    const t = this.back[i] ?? this.device.acquireTarget(this.size, this.size, this.format)
    this.back[i] = t
    return t
  }

  /** Promote the scratch half to current. O(1) — it is a pointer swap. */
  swap(i: Reg): void {
    const f = this.front[i]
    this.front[i] = this.back[i]
    this.back[i] = f
  }

  dispose(): void {
    for (let i = 0; i < this.depth; i++) {
      if (this.front[i]) this.device.releaseTarget(this.front[i]!)
      if (this.back[i]) this.device.releaseTarget(this.back[i]!)
      this.front[i] = null
      this.back[i] = null
    }
  }
}

export interface PassContext {
  device: GLDeviceLike
  source: LayerSourceLike
  regs: RegisterFile
  /** Tile currently being rebuilt. */
  key: TileKey
  /** Document-space rect covered by the tile. */
  tileRect: Rect
  /**
   * Document-space dirty sub-rect inside the tile, or null for "all of it".
   * Passes scissor to it: a brush dab must not force a full 256x256 recomposite.
   */
  dirty: Rect | null
  tileSize: number
  /** RGBA8 fallback: dither at store time (spec 09 §4.5). */
  dither: boolean
  /**
   * Space in which B(Cb, Cs) is evaluated. Composition stays linear either way
   * — see the arbitration note at the top of `graph/shaders.ts`.
   */
  blendSpace: BlendSpace
  /**
   * Use fixed-function blending where it is provably EXACT (see
   * `hardwareBlend.ts`). Off in tests that compare against the TS oracle
   * pass-by-pass.
   */
  allowHardwareBlend: boolean
  stats: PassStats
}

export interface Pass<K extends PassOp['kind']> {
  readonly kind: K
  execute(op: Extract<PassOp, { kind: K }>, ctx: PassContext): void
}

/**
 * Scissor rect in TARGET-LOCAL pixels, y-up as GL wants it.
 *
 * The renderer keeps the current convention of "no flip during composition, one
 * flip at display" (it is what makes `readPixels` directly compatible with
 * `putImageData`), so a document rect maps to the target with y unchanged.
 */
export function scissorForTile(ctx: PassContext): Rect | null {
  if (!ctx.dirty) return null
  const scale = 1 / (1 << ctx.key.level)
  const x0 = Math.max(0, Math.floor((ctx.dirty.x0 - ctx.tileRect.x0) * scale))
  const y0 = Math.max(0, Math.floor((ctx.dirty.y0 - ctx.tileRect.y0) * scale))
  const x1 = Math.min(ctx.tileSize, Math.ceil((ctx.dirty.x1 - ctx.tileRect.x0) * scale))
  const y1 = Math.min(ctx.tileSize, Math.ceil((ctx.dirty.y1 - ctx.tileRect.y0) * scale))
  if (x1 <= x0 || y1 <= y0) return null
  return { x0, y0, x1, y1 }
}

/** Bind a target, set the viewport and the scissor, in one place. */
export function beginDraw(ctx: PassContext, target: RenderTargetLike): void {
  ctx.device.bindTarget(target)
  ctx.device.setViewport(0, 0, target.width, target.height)
  ctx.device.setScissor(scissorForTile(ctx))
}
