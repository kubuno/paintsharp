// Which blend modes the fixed-function blender can do EXACTLY, and why the
// others cannot.
//
// Spec 09 §7.3 lists `normal`, `add`, `subtract`, `multiply`, `screen`,
// `darken` and `lighten` as hardware-blendable. That list is too generous, and
// getting it wrong reintroduces exactly the class of error this rewrite exists
// to fix — a composition that is "close enough" everywhere except over
// transparency. The derivations below are done in the premultiplied form
//
//     cr = (1 - as)*cb + (1 - ab)*cs + ab*as*B(Cb, Cs)          [PDF 1.7 §11.3.6]
//     ar = as + ab*(1 - as)
//
// with cb = ab*Cb and cs = as*Cs. GL computes `src*Fs + dst*Fd` where Fs and Fd
// are chosen from a fixed menu, so a mode is hardware-blendable if and only if
// its `cr` can be written in that shape.
//
//
// EXACT — implemented
// -------------------
// normal        B = Cs
//               ab*as*Cs = ab*cs, so cr = (1-as)*cb + (1-ab)*cs + ab*cs
//                                     = (1-as)*cb + cs
//               => Fs = ONE, Fd = ONE_MINUS_SRC_ALPHA.
//
// linear-dodge  B = Cb + Cs
//               ab*as*(Cb + Cs) = as*cb + ab*cs
//               cr = (1-as)*cb + (1-ab)*cs + as*cb + ab*cs = cb + cs
//               => Fs = ONE, Fd = ONE.  (Alpha needs a separate pair.)
//
// screen        B = Cb + Cs - Cb*Cs
//               ab*as*B = as*cb + ab*cs - cb*cs
//               cr = (1-as)*cb + (1-ab)*cs + as*cb + ab*cs - cb*cs
//                  = cb + cs - cb*cs = cb + cs*(1 - cb)
//               => Fs = ONE_MINUS_DST_COLOR, Fd = ONE.
//
//
// NOT EXACT — deliberately excluded
// ---------------------------------
// multiply      B = Cb*Cs, and ab*as*Cb*Cs = cb*cs, so
//               cr = (1-as)*cb + (1-ab)*cs + cb*cs.
//               The middle term needs Fs = (1 - dst.a) while the last needs
//               Fs = dst.rgb; GL offers one source factor, not their sum. The
//               usual `glBlendFunc(DST_COLOR, ONE_MINUS_SRC_ALPHA)` silently
//               DROPS `(1-ab)*cs` — which is precisely the missing term that
//               makes a Multiply layer render black over empty canvas. Using it
//               would re-create the bug in fixed-function form.
//
// darken        ab*as*min(Cb,Cs) = min(as*cb, ab*cs); GL's MIN equation ignores
// lighten       the factors, so it only coincides when ab = as = 1.
//
// subtract      cr = cb + cs - 2*ab*cs; the factor 2*ab is not in the menu.
//
// Everything else reads the backdrop non-linearly and needs the shader path.
//
// Net effect on real documents: `normal` is the overwhelming majority of layers
// and it is exact, so the ping-pong disappears for them — which is where the
// bandwidth saving of §7.3 actually comes from. The other four modes gain
// nothing from being wrong.

import type { BlendMode } from '../../../blend/index.ts'
import type { BlendState } from '../deps.ts'

/** Modes with an exact fixed-function equivalent in premultiplied space. */
export const HARDWARE_BLENDABLE: readonly BlendMode[] = ['normal', 'linear-dodge', 'screen']

/**
 * @returns the blend state, or null when the mode needs the shader path.
 *          `null` is also returned as soon as coverage is anything other than a
 *          plain scalar the caller already folded into the source.
 */
export function hardwareBlendFor(gl: WebGL2RenderingContext, mode: BlendMode): BlendState | null {
  const common = {
    srcAlpha: gl.ONE,
    dstAlpha: gl.ONE_MINUS_SRC_ALPHA,
    equationRGB: gl.FUNC_ADD,
    equationAlpha: gl.FUNC_ADD,
  }
  switch (mode) {
    case 'normal':
      return { srcRGB: gl.ONE, dstRGB: gl.ONE_MINUS_SRC_ALPHA, ...common }
    case 'linear-dodge':
      return { srcRGB: gl.ONE, dstRGB: gl.ONE, ...common }
    case 'screen':
      return { srcRGB: gl.ONE_MINUS_DST_COLOR, dstRGB: gl.ONE, ...common }
    default:
      return null
  }
}

/** Plain premultiplied `source-over` — used by blits and group resolution. */
export function sourceOver(gl: WebGL2RenderingContext): BlendState {
  return {
    srcRGB: gl.ONE,
    dstRGB: gl.ONE_MINUS_SRC_ALPHA,
    srcAlpha: gl.ONE,
    dstAlpha: gl.ONE_MINUS_SRC_ALPHA,
    equationRGB: gl.FUNC_ADD,
    equationAlpha: gl.FUNC_ADD,
  }
}
