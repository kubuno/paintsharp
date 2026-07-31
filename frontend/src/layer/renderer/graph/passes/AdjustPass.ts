// Adjustment layer — a colour operator on the accumulator.
//
// Two invariants, both violated by the current implementation:
//
//   1. NON-DESTRUCTIVE. The adjustment reads the accumulator and writes the
//      accumulator; it never touches a layer's stored pixels. The current
//      preview path writes back into the layer texture, which both destroys the
//      original and clips it to 8 bits on every parameter tweak.
//   2. ALPHA IS PRESERVED EXACTLY (`clip-to-backdrop`, `ar = ab`). An
//      adjustment can change colour where colour already exists, and nothing
//      else — so it is a strict no-op over empty canvas rather than a grey
//      rectangle.
//
// Scope follows the tree, not the pass: an adjustment inside an ISOLATED group
// only sees that group's register, and inside a `pass-through` group it sees
// the parent's. That falls out of `compilePlan` choosing the target register;
// nothing here needs to know.
//
// The LUT itself is produced by the `filters/` stage. This pass only samples it.

import { FRAG_ADJUST, VERT_QUAD } from '../shaders.ts'
import { beginDraw } from './types.ts'
import type { Pass, PassContext } from './types.ts'
import type { AdjustOp } from '../types.ts'

export const adjustPass: Pass<'adjust'> = {
  kind: 'adjust',
  execute(op: AdjustOp, ctx: PassContext): void {
    const lut = ctx.source.tileAt(op.lutId, ctx.key)
    if (!lut) {
      // No LUT uploaded yet: the correct behaviour is identity, not black.
      ctx.stats.skipped++
      return
    }
    const prog = ctx.device.program('graph/adjust', VERT_QUAD, FRAG_ADJUST)
    if (!prog) return

    const dst = ctx.regs.scratch(op.target)
    beginDraw(ctx, dst)
    ctx.device.setBlend(null)
    prog.use()
    prog.setTexture('uBase', 0, ctx.regs.current(op.target).texture)
    prog.setTexture('uLut', 1, lut)
    prog.setInt('uLut3D', 0)
    prog.setFloat('uLutSize', 0)
    prog.setFloat('uOpacity', op.opacity)

    const c = op.coverage
    const mask = c.maskId ? ctx.source.maskTileAt(c.maskId, ctx.key) : null
    const vmask = c.vectorMaskId ? ctx.source.maskTileAt(c.vectorMaskId, ctx.key) : null
    const clip = c.clipReg !== null ? ctx.regs.current(c.clipReg).texture : null
    prog.setTexture('uMask', 2, mask ?? lut)
    prog.setInt('uHasMask', mask ? 1 : 0)
    prog.setInt('uMaskInverted', c.maskInverted ? 1 : 0)
    prog.setFloat('uMaskDensity', c.maskDensity)
    prog.setTexture('uVecMask', 3, vmask ?? lut)
    prog.setInt('uHasVecMask', vmask ? 1 : 0)
    prog.setInt('uVecMaskInverted', c.vectorMaskInverted ? 1 : 0)
    prog.setFloat('uVecMaskDensity', c.vectorMaskDensity)
    prog.setTexture('uClip', 4, clip ?? lut)
    prog.setInt('uHasClip', clip ? 1 : 0)

    ctx.device.drawQuad()
    ctx.stats.drawCalls++
    ctx.regs.swap(op.target)
    ctx.stats.registerSwaps++
  },
}
