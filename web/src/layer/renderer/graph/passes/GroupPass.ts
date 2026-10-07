// Group isolation — open and resolve a nested accumulator.
//
// Isolation is the difference between "the children see what is under the
// group" and "the children only see each other". Photoshop's default for a new
// group is `pass-through` (they see through), but the moment the group gets a
// blend mode, an opacity below 100 %, a mask or a style, it is FORCED into
// isolation — otherwise the semantics are undefined (spec 08 §2.3).
//
// `compilePlan` makes that decision once, so this pass never has to:
//
//   * a free pass-through group emits no op at all, its children are spliced
//     into the parent's list;
//   * anything else emits `group-begin` / `group-end` around its children.
//
// `seed: 'backdrop'` implements the PDF non-isolated group whose contribution
// is still scaled — children composite against a COPY of the backdrop, and the
// resolution is a mix rather than an `over`. The compiler never emits it today
// because Photoshop forces isolation instead; the pass exists because the model
// allows it and getting it wrong later would be expensive.
//
// Knockout (`shallow` / `deep`) is carried in the plan but NOT executed. It is
// a subtractive alpha operator against the parent group or the document, and
// implementing it half-way would be worse than not implementing it — the plan
// records it and `compilePlan` emits a diagnostic.

import { BLEND_UMODE, COMPOSITE_OP_INT } from '../../../blend/index.ts'
import { compositeFragment, compositeShaderKey, FRAG_BLIT, FRAG_GROUP_LERP, VERT_QUAD } from '../shaders.ts'
import { beginDraw } from './types.ts'
import type { Pass, PassContext } from './types.ts'
import type { GroupBeginOp, GroupEndOp } from '../types.ts'

export const groupBeginPass: Pass<'group-begin'> = {
  kind: 'group-begin',
  execute(op: GroupBeginOp, ctx: PassContext): void {
    const dst = ctx.regs.current(op.target)
    beginDraw(ctx, dst)
    ctx.device.setBlend(null)

    if (op.seed === 'transparent' || op.backdropReg === null) {
      ctx.device.clear(0, 0, 0, 0)
      return
    }

    const prog = ctx.device.program('graph/blit', VERT_QUAD, FRAG_BLIT)
    if (!prog) return
    prog.use()
    prog.setTexture('uSrc', 0, ctx.regs.current(op.backdropReg).texture)
    ctx.device.drawQuad()
    ctx.stats.drawCalls++
  },
}

export const groupEndPass: Pass<'group-end'> = {
  kind: 'group-end',
  execute(op: GroupEndOp, ctx: PassContext): void {
    const src = ctx.regs.current(op.source).texture

    if (op.combine === 'lerp') {
      // Non-isolated group: the children already composited against a copy of
      // the backdrop, so scaling its contribution is a MIX, not an `over`.
      const prog = ctx.device.program('graph/group-lerp', VERT_QUAD, FRAG_GROUP_LERP)
      if (!prog) return
      const dst = ctx.regs.scratch(op.target)
      beginDraw(ctx, dst)
      ctx.device.setBlend(null)
      prog.use()
      prog.setTexture('uBase', 0, ctx.regs.current(op.target).texture)
      prog.setTexture('uSrc', 1, src)
      prog.setFloat('uOpacity', op.opacity)
      bindGroupCoverage(prog, ctx, op, src)
      ctx.device.drawQuad()
      ctx.stats.drawCalls++
      ctx.regs.swap(op.target)
      ctx.stats.registerSwaps++
      return
    }

    // Isolated group: composite the result as if it were a single layer — same
    // shader, same three-term PDF formula, same coverage collapse. That is the
    // whole point of isolation: a group behaves exactly like a layer.
    const prog = ctx.device.program(
      compositeShaderKey({ dither: ctx.dither, space: ctx.blendSpace }),
      VERT_QUAD,
      compositeFragment({ dither: ctx.dither, space: ctx.blendSpace }),
    )
    if (!prog) return

    const dst = ctx.regs.scratch(op.target)
    beginDraw(ctx, dst)
    ctx.device.setBlend(null)
    prog.use()
    prog.setTexture('uBase', 0, ctx.regs.current(op.target).texture)
    prog.setTexture('uSrc', 1, src)
    prog.setInt('uEmitSourceOnly', 0)
    prog.setInt('uUseReferenceComposite', 0)
    prog.setInt('uMode', BLEND_UMODE[op.mode])
    prog.setInt('uCompOp', COMPOSITE_OP_INT[op.op])
    prog.setFloat('uOpacity', op.opacity)
    prog.setFloat('uFill', 1)
    prog.setInt('uFillMode', 0)
    prog.setFloat('uFillNeutral', 0)
    prog.setVec2('uTileOrigin', ctx.tileRect.x0, ctx.tileRect.y0)
    prog.setVec2('uTileSpan', ctx.tileRect.x1 - ctx.tileRect.x0, ctx.tileRect.y1 - ctx.tileRect.y0)
    prog.setUint('uSeed', 0)
    bindGroupCoverage(prog, ctx, op, src)
    ctx.device.drawQuad()
    ctx.stats.drawCalls++
    ctx.regs.swap(op.target)
    ctx.stats.registerSwaps++
  },
}

function bindGroupCoverage(
  prog: { setTexture(n: string, u: number, t: WebGLTexture | null): void; setInt(n: string, v: number): void; setFloat(n: string, v: number): void },
  ctx: PassContext,
  op: GroupEndOp,
  fallback: WebGLTexture,
): void {
  const c = op.coverage
  const mask = c.maskId ? ctx.source.maskTileAt(c.maskId, ctx.key) : null
  const vmask = c.vectorMaskId ? ctx.source.maskTileAt(c.vectorMaskId, ctx.key) : null
  const clip = c.clipReg !== null ? ctx.regs.current(c.clipReg).texture : null

  prog.setTexture('uMask', 2, mask ?? fallback)
  prog.setInt('uHasMask', mask ? 1 : 0)
  prog.setInt('uMaskInverted', c.maskInverted ? 1 : 0)
  prog.setFloat('uMaskDensity', c.maskDensity)
  prog.setTexture('uVecMask', 3, vmask ?? fallback)
  prog.setInt('uHasVecMask', vmask ? 1 : 0)
  prog.setInt('uVecMaskInverted', c.vectorMaskInverted ? 1 : 0)
  prog.setFloat('uVecMaskDensity', c.vectorMaskDensity)
  prog.setTexture('uClip', 4, clip ?? fallback)
  prog.setInt('uHasClip', clip ? 1 : 0)
}
