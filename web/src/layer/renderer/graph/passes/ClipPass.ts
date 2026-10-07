// Clipping — capture the clip base's own alpha into a register.
//
// The current renderer clips to `clipBase = layerTex`, the RAW texture of the
// layer below (defect F14). Three things break:
//
//   * a group cannot be a clip base, because a group has no single texture;
//   * a base carrying a mask or an opacity clips as if it had neither;
//   * a base drawn onto a non-empty backdrop clips to the wrong silhouette.
//
// What clips is the base's own alpha AS COMPOSITED. Recovering it from the
// accumulator is exact, because `source-over` is invertible in alpha:
//
//     a_after = a_base + a_before*(1 - a_base)
//  => a_base  = (a_after - a_before) / (1 - a_before)
//
// so the snapshot is right even when the base landed on an occupied register,
// and even when back-placed layer styles were drawn before it.
//
// Note the pass writes the alpha into all four channels. The consumers sample
// `.r`, but keeping `.a` in sync means a clip register can be blitted or
// inspected with the ordinary tooling.

import { FRAG_SNAPSHOT_ALPHA, VERT_QUAD } from '../shaders.ts'
import { beginDraw } from './types.ts'
import type { Pass, PassContext } from './types.ts'
import type { SnapshotAlphaOp } from '../types.ts'

export const clipSnapshotPass: Pass<'snapshot-alpha'> = {
  kind: 'snapshot-alpha',
  execute(op: SnapshotAlphaOp, ctx: PassContext): void {
    const prog = ctx.device.program('graph/snapshot-alpha', VERT_QUAD, FRAG_SNAPSHOT_ALPHA)
    if (!prog) return

    const src = ctx.regs.current(op.from)
    const dst = ctx.regs.current(op.to)
    beginDraw(ctx, dst)
    ctx.device.setBlend(null)
    prog.use()
    prog.setTexture('uSrc', 0, src.texture)
    if (op.baselineReg !== null) {
      prog.setTexture('uBaseline', 1, ctx.regs.current(op.baselineReg).texture)
      prog.setInt('uHasBaseline', 1)
    } else {
      prog.setTexture('uBaseline', 1, src.texture)
      prog.setInt('uHasBaseline', 0)
    }
    ctx.device.drawQuad()
    ctx.stats.drawCalls++
  },
}
