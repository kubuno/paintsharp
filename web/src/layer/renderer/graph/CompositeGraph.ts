// Étage 3 — the composition graph.
//
// It owns exactly two things: a compiled `PassPlan`, and the register file that
// executes it for one tile. It knows nothing about tiling policy (which tiles,
// in what order, at what LOD — that is étage 2) and nothing about React.
//
// The scale change against the current implementation is here. Today
// `compositeInto` allocates a ping-pong pair of DOCUMENT-SIZED framebuffers per
// group level: 64 MiB each in 4K, 384 MiB at a group depth of 3. Here the
// registers are 256x256 tiles: 512 KiB each in RGBA16F, 3 MiB at depth 3. That
// is a factor of 128, and it is what makes the composition independent of the
// document's size.
//
// Plan specialisation is cached per tile-coverage signature rather than per
// tile, because most tiles drop the same set of ops (all the layers whose bbox
// misses them), and recompiling the specialisation 4 050 times per frame would
// hand back the cost the compilation was meant to remove.

import { compilePlan, specialisePlan } from './compilePlan.ts'
import type { CompileOptions } from './compilePlan.ts'
import { tileRect, TILE_SIZE } from './deps.ts'
import type {
  GLDeviceLike,
  LayerSourceLike,
  Rect,
  RenderTargetLike,
  TileKey,
  WorkingFormat,
} from './deps.ts'
import type { LayerNode, PassOp, PassPlan } from './types.ts'
import { DEFAULT_BLEND_SPACE } from './shaders.ts'
import type { BlendSpace } from './shaders.ts'
import { EMPTY_PLAN } from './types.ts'
import {
  adjustPass,
  clearPass,
  clipSnapshotPass,
  fusedLayersPass,
  groupBeginPass,
  groupEndPass,
  layerPass,
  maskResolvePass,
  newPassStats,
  RegisterFile,
  strokePass,
} from './passes/index.ts'
import type { PassContext, PassStats } from './passes/index.ts'

export interface CompositeGraphOptions {
  tileSize?: number
  /** Overrides the device's probed working format. Tests use `rgba32f`. */
  format?: WorkingFormat
  /** Disable the exact fixed-function fast path (tests compare pass by pass). */
  allowHardwareBlend?: boolean
  /**
   * Space in which B(Cb, Cs) is evaluated. Default: Photoshop parity
   * (sRGB-encoded). Composition is linear in both cases — see the arbitration
   * note at the top of `graph/shaders.ts`.
   */
  blendSpace?: BlendSpace
  /** Number of specialised plans to keep. Default 64. */
  planCacheSize?: number
}

export interface BuildResult {
  /** The register holding the finished tile — always register 0. */
  target: RenderTargetLike
  stats: PassStats
  /** Ops actually executed for this tile, after specialisation. */
  opsExecuted: number
}

export class CompositeGraph {
  private plan: PassPlan = EMPTY_PLAN
  private regs: RegisterFile | null = null
  private readonly tileSize: number
  private readonly format: WorkingFormat
  private readonly allowHardwareBlend: boolean
  private readonly blendSpace: BlendSpace
  private readonly planCacheSize: number
  private readonly planCache = new Map<string, PassPlan>()
  private disposed = false

  constructor(
    private readonly device: GLDeviceLike,
    private readonly source: LayerSourceLike,
    opts: CompositeGraphOptions = {},
  ) {
    this.tileSize = opts.tileSize ?? TILE_SIZE
    this.format = opts.format ?? device.caps.working
    this.allowHardwareBlend = opts.allowHardwareBlend ?? true
    this.blendSpace = opts.blendSpace ?? DEFAULT_BLEND_SPACE
    this.planCacheSize = opts.planCacheSize ?? 64
  }

  get currentPlan(): PassPlan {
    return this.plan
  }

  get generation(): number {
    return this.plan.generation
  }

  /** Recompile from a layer tree. Cheap enough to call on every edit. */
  compile(tree: LayerNode[], opts: CompileOptions): PassPlan {
    const maxFused = Math.max(2, Math.min(opts.maxFusedSources ?? 7, this.device.caps.maxFragmentTextureUnits - 1))
    this.plan = compilePlan(tree, { ...opts, maxFusedSources: maxFused })
    this.planCache.clear()
    this.releaseRegisters()
    return this.plan
  }

  /** Install an already-compiled plan (the Renderer compiles off the hot path). */
  setPlan(plan: PassPlan): void {
    this.plan = plan
    this.planCache.clear()
    this.releaseRegisters()
  }

  /**
   * Build one tile.
   *
   * `dirty` scissors the work to the chunk-aligned sub-rect that actually
   * changed, so a brush dab of radius 20 does not force a full 256x256
   * recomposite of every pass.
   */
  buildTile(key: TileKey, dirty: Rect | null = null): BuildResult | null {
    if (this.disposed || this.device.isLost) return null

    const rect = tileRect(key, this.tileSize)
    const plan = this.planForTile(rect)
    const regs = this.registers()

    const ctx: PassContext = {
      device: this.device,
      source: this.source,
      regs,
      key,
      tileRect: rect,
      dirty,
      tileSize: this.tileSize,
      dither: this.format === 'rgba8',
      blendSpace: this.blendSpace,
      allowHardwareBlend: this.allowHardwareBlend,
      stats: newPassStats(),
    }

    for (const op of plan.ops) this.execute(op, ctx)

    this.device.setScissor(null)
    this.device.setBlend(null)
    this.device.bindTarget(null)

    return { target: regs.current(0), stats: ctx.stats, opsExecuted: plan.ops.length }
  }

  /** The specialised op list for a tile, memoised on its coverage signature. */
  planForTile(rect: Rect): PassPlan {
    const sig = this.signature(rect)
    const hit = this.planCache.get(sig)
    if (hit) return hit
    const specialised = specialisePlan(this.plan, rect)
    if (this.planCache.size >= this.planCacheSize) {
      // Plain FIFO eviction: the access pattern is a raster sweep, so recency
      // buys nothing an insertion-order drop does not already give.
      const first = this.planCache.keys().next()
      if (!first.done) this.planCache.delete(first.value)
    }
    this.planCache.set(sig, specialised)
    return specialised
  }

  /**
   * Two tiles that keep the same set of ops share a specialised plan. The
   * signature is the bitmask of surviving ops, built from bbox intersections
   * only — no GL, no allocation beyond the string.
   */
  private signature(rect: Rect): string {
    let s = ''
    for (const op of this.plan.ops) {
      const bbox = 'bbox' in op ? op.bbox : null
      if (!bbox) {
        s += '1'
        continue
      }
      s += bbox.x0 < rect.x1 && rect.x0 < bbox.x1 && bbox.y0 < rect.y1 && rect.y0 < bbox.y1 ? '1' : '0'
    }
    return s
  }

  private registers(): RegisterFile {
    if (!this.regs) {
      this.regs = new RegisterFile(this.device, this.tileSize, this.plan.scratchDepth, this.format)
    }
    return this.regs
  }

  private releaseRegisters(): void {
    this.regs?.dispose()
    this.regs = null
  }

  private execute(op: PassOp, ctx: PassContext): void {
    switch (op.kind) {
      case 'clear':
        clearPass.execute(op, ctx)
        break
      case 'layer':
        layerPass.execute(op, ctx)
        break
      case 'layers':
        fusedLayersPass.execute(op, ctx)
        break
      case 'stroke':
        strokePass.execute(op, ctx)
        break
      case 'snapshot-alpha':
        clipSnapshotPass.execute(op, ctx)
        break
      case 'mask-resolve':
        maskResolvePass.execute(op, ctx)
        break
      case 'group-begin':
        groupBeginPass.execute(op, ctx)
        break
      case 'group-end':
        groupEndPass.execute(op, ctx)
        break
      case 'adjust':
        adjustPass.execute(op, ctx)
        break
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.releaseRegisters()
    this.planCache.clear()
    this.plan = EMPTY_PLAN
  }
}
