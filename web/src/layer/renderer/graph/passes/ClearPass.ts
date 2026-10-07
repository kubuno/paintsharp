// Clear a register to fully transparent premultiplied black.
//
// `vec4(0)` is the correct identity in a premultiplied pipeline: it is both the
// transparent colour and the neutral element of `source-over`. In straight
// alpha it would not be — the colour of a fully transparent texel is undefined
// there, which is one of the reasons the working space is premultiplied.

import { beginDraw } from './types.ts'
import type { Pass, PassContext } from './types.ts'
import type { ClearOp } from '../types.ts'

export const clearPass: Pass<'clear'> = {
  kind: 'clear',
  execute(op: ClearOp, ctx: PassContext): void {
    beginDraw(ctx, ctx.regs.current(op.target))
    ctx.device.setBlend(null)
    ctx.device.clear(0, 0, 0, 0)
  },
}
