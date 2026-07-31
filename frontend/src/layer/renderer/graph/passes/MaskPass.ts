// Mask resolution — fold pixel mask x vector mask x densities into ONE coverage
// texture.
//
// A layer with a single mask never needs this pass: the coverage folds into the
// layer pass for free (it is one `texture()` and one multiply). It exists for
// the case where a layer carries BOTH a pixel mask and a vector mask, where
// pre-resolving saves a sampler in the hot shader and lets the result be
// reused by the layer's styles.
//
// Semantics implemented (spec 08 §3.1):
//   inverted — sampled inversion, the stored pixels are never rewritten;
//   density  — `m' = 1 - (1 - m)*density`. Density attenuates how much a mask
//              can HIDE, never how much it reveals, so density 0 disables the
//              mask instead of blanking the layer;
//   the two masks MULTIPLY (intersection), which is Photoshop's rule.
//
// `feather` is deliberately absent: it is a blur of the mask surface, produced
// upstream as a derived surface and cached by (surfaceVersion, feather). Doing
// it per fragment here would re-blur on every frame.

import { FRAG_MASK_RESOLVE, VERT_QUAD } from '../shaders.ts'
import { beginDraw } from './types.ts'
import type { Pass, PassContext } from './types.ts'
import type { MaskResolveOp } from '../types.ts'

export const maskResolvePass: Pass<'mask-resolve'> = {
  kind: 'mask-resolve',
  execute(op: MaskResolveOp, ctx: PassContext): void {
    const prog = ctx.device.program('graph/mask-resolve', VERT_QUAD, FRAG_MASK_RESOLVE)
    if (!prog) return

    const dst = ctx.regs.current(op.target)
    const mask = op.maskId ? ctx.source.maskTileAt(op.maskId, ctx.key) : null
    const vmask = op.vectorMaskId ? ctx.source.maskTileAt(op.vectorMaskId, ctx.key) : null

    beginDraw(ctx, dst)
    ctx.device.setBlend(null)
    // No mask tile at all means "fully revealed" here; clearing to white is the
    // identity for a coverage texture.
    ctx.device.clear(1, 1, 1, 1)
    if (!mask && !vmask) return

    prog.use()
    const fallback = (mask ?? vmask) as WebGLTexture
    prog.setTexture('uMask', 0, mask ?? fallback)
    prog.setInt('uHasMask', mask ? 1 : 0)
    prog.setInt('uMaskInverted', op.maskInverted ? 1 : 0)
    prog.setFloat('uMaskDensity', op.maskDensity)
    prog.setTexture('uVecMask', 1, vmask ?? fallback)
    prog.setInt('uHasVecMask', vmask ? 1 : 0)
    prog.setInt('uVecMaskInverted', op.vectorMaskInverted ? 1 : 0)
    prog.setFloat('uVecMaskDensity', op.vectorMaskDensity)
    prog.setTexture('uClip', 2, fallback)
    prog.setInt('uHasClip', 0)
    ctx.device.drawQuad()
    ctx.stats.drawCalls++
  },
}
