// Composite one source onto a register — ORDER steps 4 through 9.
//
// This is the pass that runs for the vast majority of ops, so everything that
// can be decided at compile time already has been. What is left at run time:
//
//   * pick the shader-vs-hardware-blend regime;
//   * bind at most five textures;
//   * one `drawArrays`.
//
// Two regimes, and the choice is not a heuristic:
//
//   HARDWARE — the mode has an exact fixed-function equivalent (see
//              `hardwareBlend.ts`) AND the coverage is a plain scalar the
//              shader can pre-multiply into the source. The accumulator is
//              written in place: no ping-pong, no backdrop read, half the
//              bandwidth. This is the path `normal` takes.
//   SHADER   — everything else. Read `current(reg)`, write `scratch(reg)`,
//              swap. On a 256x256 tile that costs 512 KiB of traffic, not the
//              64 MiB the current full-document ping-pong costs.

import { BLEND_UMODE, COMPOSITE_OP_INT } from '../../../blend/index.ts'
import { FILL_NEUTRAL_COLOR } from '../types.ts'
import type { CoverageSpec, FusedLayersOp, LayerOp, StrokeOp } from '../types.ts'
import { compositeFragment, compositeShaderKey, fusedFragment, fusedShaderKey, VERT_QUAD } from '../shaders.ts'
import type { ProgramLike, RenderTargetLike } from '../deps.ts'
import { hardwareBlendFor } from './hardwareBlend.ts'
import { beginDraw } from './types.ts'
import type { Pass, PassContext } from './types.ts'

const UNIT_BASE = 0
const UNIT_SRC = 1
const UNIT_MASK = 2
const UNIT_VMASK = 3
const UNIT_CLIP = 4

/**
 * Bind the coverage samplers. Unused samplers get a valid texture bound anyway:
 * their `uHas*` flag is 0 so they are never sampled, but leaving a sampler
 * pointing at an incomplete texture makes some drivers refuse to draw.
 */
function bindCoverage(
  prog: ProgramLike,
  ctx: PassContext,
  c: CoverageSpec,
  fallback: WebGLTexture,
): void {
  const mask = c.maskId ? ctx.source.maskTileAt(c.maskId, ctx.key) : null
  const vmask = c.vectorMaskId ? ctx.source.maskTileAt(c.vectorMaskId, ctx.key) : null
  const clip = c.clipReg !== null ? ctx.regs.current(c.clipReg).texture : null

  prog.setTexture('uMask', UNIT_MASK, mask ?? fallback)
  prog.setInt('uHasMask', mask ? 1 : 0)
  prog.setInt('uMaskInverted', c.maskInverted ? 1 : 0)
  prog.setFloat('uMaskDensity', c.maskDensity)

  prog.setTexture('uVecMask', UNIT_VMASK, vmask ?? fallback)
  prog.setInt('uHasVecMask', vmask ? 1 : 0)
  prog.setInt('uVecMaskInverted', c.vectorMaskInverted ? 1 : 0)
  prog.setFloat('uVecMaskDensity', c.vectorMaskDensity)

  prog.setTexture('uClip', UNIT_CLIP, clip ?? fallback)
  prog.setInt('uHasClip', clip ? 1 : 0)
}

/** True when the coverage is entirely absent, i.e. a plain scalar of 1. */
const coverageIsTrivial = (c: CoverageSpec): boolean =>
  c.maskId === null && c.vectorMaskId === null && c.clipReg === null

interface DrawSpec {
  sourceId: string
  opacity: number
  fill: number
  mode: LayerOp['mode']
  op: LayerOp['op']
  coverage: CoverageSpec
  target: number
  dissolveSeed: number
}

function draw(spec: DrawSpec, ctx: PassContext): void {
  const { device } = ctx
  const src = ctx.source.tileAt(spec.sourceId, ctx.key)
  if (!src) {
    // A sparse layer owns no tile here: it is transparent, and `source-over`
    // with a transparent source is the identity. Nothing to draw at all.
    ctx.stats.skipped++
    return
  }

  const uMode = BLEND_UMODE[spec.mode]
  const neutral = FILL_NEUTRAL_COLOR[spec.mode]
  const fillIsNeutralMix = neutral !== undefined && spec.fill < 1

  // The hardware path requires: an exact fixed-function mode, `union`
  // composition, no coverage texture, and no colour-space trickery from `fill`.
  const hw =
    ctx.allowHardwareBlend &&
    spec.op === 'union' &&
    coverageIsTrivial(spec.coverage) &&
    !fillIsNeutralMix &&
    spec.mode !== 'dissolve'
      ? hardwareBlendFor(device.gl, spec.mode)
      : null

  const prog = device.program(
    compositeShaderKey({ dither: ctx.dither, space: ctx.blendSpace }),
    VERT_QUAD,
    compositeFragment({ dither: ctx.dither, space: ctx.blendSpace }),
  )
  if (!prog) return

  let dst: RenderTargetLike
  if (hw) {
    // In place: the accumulator is both the backdrop and the destination, and
    // the fixed-function blender does the compositing.
    dst = ctx.regs.current(spec.target)
    beginDraw(ctx, dst)
    device.setBlend(hw)
    prog.use()
    // The shader emits the scaled source; GL does the composition. `uBase` is
    // never sampled in this branch but still needs a complete texture bound.
    prog.setTexture('uBase', UNIT_BASE, src)
    prog.setInt('uEmitSourceOnly', 1)
    prog.setInt('uUseReferenceComposite', 0)
    // `uMode` still matters: `dissolve` is excluded from this path, but keeping
    // the real mode makes the uniform state consistent between the two paths.
    prog.setInt('uMode', uMode)
    prog.setInt('uCompOp', COMPOSITE_OP_INT.union)
    ctx.stats.hardwareBlends++
  } else {
    dst = ctx.regs.scratch(spec.target)
    beginDraw(ctx, dst)
    device.setBlend(null)
    prog.use()
    prog.setTexture('uBase', UNIT_BASE, ctx.regs.current(spec.target).texture)
    prog.setInt('uEmitSourceOnly', 0)
    prog.setInt('uUseReferenceComposite', 0)
    prog.setInt('uMode', uMode)
    prog.setInt('uCompOp', COMPOSITE_OP_INT[spec.op])
  }

  prog.setTexture('uSrc', UNIT_SRC, src)
  prog.setFloat('uOpacity', spec.opacity)
  prog.setFloat('uFill', spec.fill)
  prog.setInt('uFillMode', fillIsNeutralMix ? 1 : 0)
  prog.setFloat('uFillNeutral', neutral ?? 0)
  prog.setVec2('uTileOrigin', ctx.tileRect.x0, ctx.tileRect.y0)
  prog.setVec2('uTileSpan', ctx.tileRect.x1 - ctx.tileRect.x0, ctx.tileRect.y1 - ctx.tileRect.y0)
  prog.setUint('uSeed', spec.dissolveSeed)
  bindCoverage(prog, ctx, spec.coverage, src)

  device.drawQuad()
  ctx.stats.drawCalls++

  if (!hw) {
    ctx.regs.swap(spec.target)
    ctx.stats.registerSwaps++
  }
  device.setBlend(null)
}

export const layerPass: Pass<'layer'> = {
  kind: 'layer',
  execute(op: LayerOp, ctx: PassContext): void {
    draw(
      {
        sourceId: op.sourceId,
        opacity: op.opacity,
        fill: op.fill,
        mode: op.mode,
        op: op.op,
        coverage: op.coverage,
        target: op.target,
        dissolveSeed: op.dissolveSeed,
      },
      ctx,
    )
  },
}

/**
 * The live brush stroke. It is not a special case in the graph: the paint stage
 * publishes the stroke tiles under a reserved id and the compositor treats it
 * as any other source. Only the eraser differs, and only in its alpha algebra.
 */
export const strokePass: Pass<'stroke'> = {
  kind: 'stroke',
  execute(op: StrokeOp, ctx: PassContext): void {
    if (op.erase) {
      const src = ctx.source.tileAt(op.sourceId, ctx.key)
      if (!src) {
        ctx.stats.skipped++
        return
      }
      // Erasing is `destination-out` on premultiplied values: the stroke's
      // alpha is subtracted from the accumulator, colour scales with it.
      const dst = ctx.regs.current(op.target)
      beginDraw(ctx, dst)
      const gl = ctx.device.gl
      ctx.device.setBlend({
        srcRGB: gl.ZERO,
        dstRGB: gl.ONE_MINUS_SRC_ALPHA,
        srcAlpha: gl.ZERO,
        dstAlpha: gl.ONE_MINUS_SRC_ALPHA,
        equationRGB: gl.FUNC_ADD,
        equationAlpha: gl.FUNC_ADD,
      })
      const prog = ctx.device.program(
        compositeShaderKey({ dither: ctx.dither, space: ctx.blendSpace }),
        VERT_QUAD,
        compositeFragment({ dither: ctx.dither, space: ctx.blendSpace }),
      )
      if (!prog) return
      prog.use()
      prog.setInt('uUseReferenceComposite', 0)
      prog.setTexture('uBase', UNIT_BASE, src)
      prog.setTexture('uSrc', UNIT_SRC, src)
      prog.setFloat('uOpacity', op.opacity)
      prog.setFloat('uFill', 1)
      prog.setInt('uFillMode', 0)
      prog.setFloat('uFillNeutral', 0)
      prog.setInt('uEmitSourceOnly', 1)
      prog.setInt('uMode', BLEND_UMODE.normal)
      prog.setInt('uCompOp', COMPOSITE_OP_INT.union)
      prog.setVec2('uTileOrigin', ctx.tileRect.x0, ctx.tileRect.y0)
      prog.setVec2('uTileSpan', ctx.tileRect.x1 - ctx.tileRect.x0, ctx.tileRect.y1 - ctx.tileRect.y0)
      prog.setUint('uSeed', 0)
      bindCoverage(prog, ctx, op.coverage, src)
      ctx.device.drawQuad()
      ctx.stats.drawCalls++
      ctx.device.setBlend(null)
      return
    }

    draw(
      {
        sourceId: op.sourceId,
        opacity: op.opacity,
        fill: 1,
        mode: op.mode,
        op: 'union',
        coverage: op.coverage,
        target: op.target,
        dissolveSeed: 0,
      },
      ctx,
    )
  },
}

/**
 * Fused run of N plain `normal` layers, one draw call.
 *
 * Worth stating why this is exact and not a shortcut: `source-over` is
 * associative, so `((base ⊕ a) ⊕ b) ⊕ c` equals `base ⊕ (a ⊕ b ⊕ c)`, and the
 * compiler only ever fuses ops that are unmasked, unclipped and at opacity 1.
 */
export const fusedLayersPass: Pass<'layers'> = {
  kind: 'layers',
  execute(op: FusedLayersOp, ctx: PassContext): void {
    const textures: WebGLTexture[] = []
    for (const id of op.sourceIds) {
      const t = ctx.source.tileAt(id, ctx.key)
      if (t) textures.push(t)
    }
    if (textures.length === 0) {
      ctx.stats.skipped++
      return
    }

    const n = textures.length
    const prog = ctx.device.program(
      fusedShaderKey(n, ctx.dither),
      VERT_QUAD,
      fusedFragment(n, ctx.dither),
    )
    if (!prog) return

    const dst = ctx.regs.scratch(op.target)
    beginDraw(ctx, dst)
    ctx.device.setBlend(null)
    prog.use()
    prog.setTexture('uBase', 0, ctx.regs.current(op.target).texture)
    for (let i = 0; i < n; i++) prog.setTexture(`uSrc${i}`, i + 1, textures[i])
    ctx.device.drawQuad()
    ctx.stats.drawCalls++
    ctx.regs.swap(op.target)
    ctx.stats.registerSwaps++
  },
}
