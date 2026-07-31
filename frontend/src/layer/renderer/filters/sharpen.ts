// Sharpen family — ONE parameterised unsharp mask, reused by every entry.
//
// The legacy code had three copies of the same maths: `unsharpMask`, the two
// frozen instances `sharpen`/`sharpenMore`, and a third copy inside
// `imaging/filters.applyFilters`. Here `sharpen`, `sharpen more`, `unsharp mask`
// and `high pass` are four parameter sets over the same two-stage chain:
//   1. the separable Gaussian of `blur.ts` (linear, premultiplied),
//   2. a combine pass.
//
// Space: the BLUR runs in linear light (that is what makes it physically
// correct), the COMBINE runs on sRGB-ENCODED values. That is deliberate:
// `src + amount·(src − blur)` in linear light produces halos whose brightness
// tracks scene luminance rather than perceived lightness, and it does not match
// the legacy result on any midtone. Photoshop's USM is likewise an encoded-value
// operation.
//
// New vs the legacy version: a THRESHOLD parameter (Photoshop has one, the
// legacy filter did not), so flat areas and film grain are left alone.
// Reference for the threshold semantics: GEGL `unsharp-mask` / GIMP's
// "Sharpen (Unsharp Mask)" (GPLv3) — reimplemented in GLSL here.

import { blurPasses } from './blur'
import { fragmentShader } from './glsl/common'
import type { GpuPass } from './types'

/**
 * out = src + amount · (src − blur), applied per channel on encoded values,
 * gated by a per-pixel threshold on the largest channel difference.
 * `uMode` 0 = unsharp, 1 = high pass (0.5 + (src − blur)).
 */
export const UNSHARP_COMBINE_FRAG = fragmentShader(`
uniform sampler2D uBlur;
uniform float uAmount;
uniform float uThreshold;   // 0..1 on encoded values
uniform int   uMode;        // 0 unsharp, 1 high pass

void main() {
  vec4 s = texture(uSrc, vUv);
  vec4 b = texture(uBlur, vUv);
  if (s.a <= 0.0) { fragColor = s; return; }
  vec3 se = linearToSrgb(unpremul(s));
  vec3 be = linearToSrgb(unpremul(b));
  vec3 d  = se - be;
  vec3 outEnc;
  if (uMode == 1) {
    outEnc = vec3(0.5) + d;
  } else {
    float m = step(uThreshold, maxc(abs(d)));
    outEnc = se + uAmount * d * m;
  }
  fragColor = premul(srgbToLinear(clamp(outEnc, 0.0, 1.0)), s.a);
}
`)

export interface UnsharpParams {
  /** 1.0 = 100 %. */
  amount: number
  /** Blur radius in pixels. */
  radius: number
  /** 0..1 on encoded values; differences below this are not amplified. */
  threshold?: number
}

export function unsharpPasses(p: UnsharpParams): GpuPass[] {
  const blur = blurPasses(p.radius, 'gaussian')
  const lastBlur = blur[blur.length - 1].name
  return [
    ...blur,
    {
      name: 'combine',
      key: 'sharpen/combine',
      glsl: UNSHARP_COMBINE_FRAG,
      inputs: { uSrc: 'source', uBlur: { pass: lastBlur } },
      uniforms: () => ({ uAmount: p.amount, uThreshold: p.threshold ?? 0, uMode: 0 }),
    },
  ]
}

export function highPassPasses(radius: number): GpuPass[] {
  const blur = blurPasses(radius, 'gaussian')
  const lastBlur = blur[blur.length - 1].name
  return [
    ...blur,
    {
      name: 'combine',
      key: 'sharpen/combine',
      glsl: UNSHARP_COMBINE_FRAG,
      inputs: { uSrc: 'source', uBlur: { pass: lastBlur } },
      uniforms: () => ({ uAmount: 1, uThreshold: 0, uMode: 1 }),
    },
  ]
}
