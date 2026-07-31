// GLSL ES 3.00 twin of `./formulas.ts`, as composable string fragments ready to
// be injected into a compositing fragment shader.
//
// Attribution: same as `./formulas.ts` — algorithms derived from GIMP
// `app/operations/layer-modes/*` (GPLv3+), cross-checked against PDF 1.7
// §11.3.5 for the cases where Photoshop diverges. Kubuno is AGPLv3.
//
// PRECISION PITFALLS — read before wiring this into a shader
// ----------------------------------------------------------
//  1. `precision highp float;` is MANDATORY. In mediump (10-bit mantissa)
//     `safeDiv(1 - Cb, Cs)` with Cs ≈ 0.002 loses all precision and color-burn
//     bands visibly. On GPUs without highp in the fragment stage, check
//     `GL_FRAGMENT_PRECISION_HIGH` and fall back to a CPU path.
//  2. NaN is contagious: one NaN pixel survives `generateMipmap`, blur passes
//     and PNG encoding. Every division goes through `safeDiv` or a
//     `max(x, EPS)` guard. `isnan()` is unreliable across drivers — prefer a
//     final `clamp(cr, -64.0, 64.0)`, which also flushes NaN on most drivers.
//  3. Un-premultiplying near zero: `cb / ab` with ab = 1/65504 explodes. The
//     quotient is clamped to [0, UNPREMUL_MAX = 64].
//  4. Values outside [0,1] are intentional: linear-dodge/burn/light, subtract
//     and divide leave the range by construction. Do NOT clamp inside B; clamp
//     at the 8-bit write-out. With an RGBA8 fallback the result differs — that
//     is a documented limitation of the fallback.
//  5. `step()` and exact equality: `step(0.5, s)` includes s == 0.5, while
//     GIMP tests `s > 0.5`. At s == 0.5 both branches coincide for hard-light,
//     pin-light, vivid-light and linear-light, and at Cb == 0.5 both overlay
//     branches give Cs. `step` is therefore safe everywhere here.
//  6. `uMode` is a uniform, so the dispatch below is warp-uniform and costs no
//     divergence. It does lengthen compilation: prefer compiling one variant
//     per mode via `blendModeDefine()` + `GLSL_BLEND_BODY_SINGLE`.
//  7. Never call a derivative function (`dFdx`/`dFdy`) after a `discard` or in
//     non-uniform control flow.

import { BLEND_MODES, BLEND_MODE_TABLE, COMPOSITE_OP_INT, ERASER_MODE_INT } from './modes.ts'
import type { BlendMode } from './modes.ts'

/** Shared constants and the safe division primitive. */
export const GLSL_PRELUDE = `
const float BLEND_EPS = 1e-6;
const float BLEND_SAFE_DIV_MAX = 1e6;
const float BLEND_UNPREMUL_MAX = 64.0;

// GIMP safe_div: a/b clamped to +/-SAFE_DIV_MAX, exactly 0 when |a| <= EPS.
float safeDiv(float a, float b) {
  return abs(a) <= BLEND_EPS ? 0.0 : clamp(a / b, -BLEND_SAFE_DIV_MAX, BLEND_SAFE_DIV_MAX);
}
vec3 safeDiv(vec3 a, vec3 b) {
  return vec3(safeDiv(a.r, b.r), safeDiv(a.g, b.g), safeDiv(a.b, b.b));
}
`

/** Separable blend functions. Scope: `vec3 b` (backdrop), `vec3 s` (source). */
export const GLSL_SEPARABLE = `
vec3 bNormal      (vec3 b, vec3 s) { return s; }
vec3 bDarken      (vec3 b, vec3 s) { return min(b, s); }
vec3 bLighten     (vec3 b, vec3 s) { return max(b, s); }
vec3 bMultiply    (vec3 b, vec3 s) { return b * s; }
vec3 bScreen      (vec3 b, vec3 s) { return b + s - b * s; }
vec3 bColorBurn   (vec3 b, vec3 s) { return 1.0 - safeDiv(1.0 - b, s); }
vec3 bColorDodge  (vec3 b, vec3 s) { return safeDiv(b, 1.0 - s); }
vec3 bLinearBurn  (vec3 b, vec3 s) { return b + s - 1.0; }
vec3 bLinearDodge (vec3 b, vec3 s) { return b + s; }
// Single branch: GIMP's two cases are algebraically identical.
vec3 bLinearLight (vec3 b, vec3 s) { return b + 2.0 * s - 1.0; }
vec3 bDifference  (vec3 b, vec3 s) { return abs(b - s); }
vec3 bExclusion   (vec3 b, vec3 s) { return b + s - 2.0 * b * s; }
vec3 bSubtract    (vec3 b, vec3 s) { return b - s; }
vec3 bDivide      (vec3 b, vec3 s) { return safeDiv(b, s); }
// step(1.0, x) is 1 at x == 1 exactly, matching "Cb + Cs < 1 ? 0 : 1".
vec3 bHardMix     (vec3 b, vec3 s) { return step(1.0, b + s); }

vec3 bOverlay(vec3 b, vec3 s) {
  return mix(2.0 * b * s, 1.0 - 2.0 * (1.0 - b) * (1.0 - s), step(0.5, b));
}
vec3 bHardLight(vec3 b, vec3 s) { return bOverlay(s, b); }

// PDF 1.7 section 11.3.5.2 auxiliary D(Cb). sqrt() alone is wrong below 0.25.
vec3 softLightD(vec3 b) {
  return mix(sqrt(b), ((16.0 * b - 12.0) * b + 4.0) * b, step(b, vec3(0.25)));
}
vec3 bSoftLight(vec3 b, vec3 s) {
  vec3 lo = 2.0 * b * s + b * b * (1.0 - 2.0 * s);
  vec3 hi = 2.0 * b * (1.0 - s) + softLightD(b) * (2.0 * s - 1.0);
  // step(0.5, s) picks "hi" at s == 0.5; there lo = b and hi = b as well, so
  // the inclusive boundary is harmless.
  return mix(lo, hi, step(0.5, s));
}
vec3 bVividLight(vec3 b, vec3 s) {
  vec3 lo = max(1.0 - safeDiv(1.0 - b, 2.0 * s), vec3(0.0));
  vec3 hi = min(safeDiv(b, 2.0 * (1.0 - s)), vec3(1.0));
  return mix(lo, hi, step(0.5, s));
}
vec3 bPinLight(vec3 b, vec3 s) {
  return mix(min(b, 2.0 * s), max(b, 2.0 * s - 1.0), step(0.5, s));
}
`

/**
 * Non-separable (HSY) primitives. LUMA is BT.601 on sRGB-encoded values, per
 * PDF 1.7 §11.3.5.3 and Photoshop — NOT the BT.709 linear-light coefficients
 * GIMP pulls from babl.
 */
export const GLSL_NON_SEPARABLE = `
const vec3 BLEND_LUMA = vec3(0.30, 0.59, 0.11);
float bLum(vec3 c) { return dot(c, BLEND_LUMA); }
float bSat(vec3 c) { return max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b); }

vec3 clipColor(vec3 c) {
  float l = bLum(c);
  float n = min(min(c.r, c.g), c.b);
  float x = max(max(c.r, c.g), c.b);
  // Denominators are provably > 0 inside their guard, but are floored at EPS
  // anyway so a degenerate input can never produce NaN.
  if (n < 0.0) c = l + (c - l) * l / max(l - n, BLEND_EPS);
  if (x > 1.0) c = l + (c - l) * (1.0 - l) / max(x - l, BLEND_EPS);
  return c;
}
vec3 setLum(vec3 c, float l) { return clipColor(c + (l - bLum(c))); }
// Guarded division: a neutral grey has range 0 and would otherwise be NaN.
vec3 setSat(vec3 c, float s) {
  float mn = min(min(c.r, c.g), c.b);
  float mx = max(max(c.r, c.g), c.b);
  float rg = mx - mn;
  return rg > 0.0 ? (c - mn) / rg * s : vec3(0.0);
}

vec3 bHue        (vec3 b, vec3 s) { return setLum(setSat(s, bSat(b)), bLum(b)); }
vec3 bSaturation (vec3 b, vec3 s) { return setLum(setSat(b, bSat(s)), bLum(b)); }
vec3 bColor      (vec3 b, vec3 s) { return setLum(s, bLum(b)); }
vec3 bLuminosity (vec3 b, vec3 s) { return setLum(b, bLum(s)); }
vec3 bDarkerColor (vec3 b, vec3 s) { return bLum(b) <= bLum(s) ? b : s; }
vec3 bLighterColor(vec3 b, vec3 s) { return bLum(b) >= bLum(s) ? b : s; }
`

/**
 * Dissolve. The draw MUST be done in document coordinates, not screen
 * coordinates, or the pattern sticks to the viewport while panning.
 */
export const GLSL_DISSOLVE = `
uint blendHash3(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v.x;
}
float dissolveRand(ivec2 docPx, uint seed) {
  return float(blendHash3(uvec3(uvec2(docPx), seed)) & 0xFFFFFFu) / float(0xFFFFFF);
}
`

/**
 * The GLSL expression of every mode, in scope `vec3 b, vec3 s`.
 * Same table the reference implementation is keyed on, so the two cannot drift
 * without the equivalence test noticing.
 */
export const BLEND_GLSL_EXPR: Record<BlendMode, string> = {
  normal: 'bNormal(b, s)',
  // Dissolve acts on alpha, not colour; the colour path is `normal`.
  dissolve: 'bNormal(b, s)',
  // Pass-through is resolved by the compositor, never by a shader.
  'pass-through': 'bNormal(b, s)',

  darken: 'bDarken(b, s)',
  multiply: 'bMultiply(b, s)',
  'color-burn': 'bColorBurn(b, s)',
  'linear-burn': 'bLinearBurn(b, s)',
  'darker-color': 'bDarkerColor(b, s)',

  lighten: 'bLighten(b, s)',
  screen: 'bScreen(b, s)',
  'color-dodge': 'bColorDodge(b, s)',
  'linear-dodge': 'bLinearDodge(b, s)',
  'lighter-color': 'bLighterColor(b, s)',

  overlay: 'bOverlay(b, s)',
  'soft-light': 'bSoftLight(b, s)',
  'hard-light': 'bHardLight(b, s)',
  'vivid-light': 'bVividLight(b, s)',
  'linear-light': 'bLinearLight(b, s)',
  'pin-light': 'bPinLight(b, s)',
  'hard-mix': 'bHardMix(b, s)',

  difference: 'bDifference(b, s)',
  exclusion: 'bExclusion(b, s)',
  subtract: 'bSubtract(b, s)',
  divide: 'bDivide(b, s)',

  hue: 'bHue(b, s)',
  saturation: 'bSaturation(b, s)',
  color: 'bColor(b, s)',
  luminosity: 'bLuminosity(b, s)',
}

/** `#define M_COLOR_BURN 8` … generated from the mode table. */
export function glslModeDefines(): string {
  const lines = BLEND_MODES.map((id) => {
    const name = `M_${id.replace(/-/g, '_').toUpperCase()}`
    return `#define ${name} ${BLEND_MODE_TABLE[id].uMode}`
  })
  lines.push(`#define M_ERASER ${ERASER_MODE_INT}`)
  for (const [op, value] of Object.entries(COMPOSITE_OP_INT)) {
    lines.push(`#define COMP_${op.replace(/-/g, '_').toUpperCase()} ${value}`)
  }
  return lines.join('\n')
}

/**
 * Runtime dispatch over `uMode`. Generated, so adding a mode to the table adds
 * it to the shader. Cheap at run time (uniform control flow) but slow to
 * compile — see `blendModeChunk()` for the one-variant-per-mode alternative.
 */
export function glslBlendDispatch(fnName = 'blendMode'): string {
  const body = BLEND_MODES
    .filter((id) => id !== 'normal' && id !== 'dissolve' && id !== 'pass-through')
    .map((id) => `  if (m == ${BLEND_MODE_TABLE[id].uMode}) return ${BLEND_GLSL_EXPR[id]};`)
    .join('\n')
  return `vec3 ${fnName}(int m, vec3 b, vec3 s) {\n${body}\n  return s; // normal / dissolve / pass-through\n}\n`
}

/** Single-mode specialisation: no branch at all, for a per-mode shader variant. */
export function glslBlendSingle(mode: BlendMode, fnName = 'blendMode'): string {
  return `vec3 ${fnName}(vec3 b, vec3 s) { return ${BLEND_GLSL_EXPR[mode]}; }\n`
}

/**
 * Premultiplied composition (spec §4.6.2):
 *
 *   ar = as + ab·(1 - as)
 *   cr = (1 - as)·cb + (1 - ab)·cs + ab·as·B(Cb, Cs)
 *
 * `cb`/`cs` are premultiplied; `B` needs straight colours, hence the guarded
 * un-premultiplication. `normal`/`dissolve` skip `B` entirely: the three terms
 * collapse to `cs + (1 - as)·cb`.
 */
export const GLSL_COMPOSITE = `
struct BlendPixel { vec3 rgb; float a; };

vec3 blendUnpremul(vec3 c, float a) {
  return a > 0.0 ? clamp(c / a, 0.0, BLEND_UNPREMUL_MAX) : vec3(0.0);
}

// cbP/csP premultiplied. compOp is one of the COMP_* defines.
BlendPixel blendComposite(int mode, int compOp, vec3 cbP, float ab, vec3 csP, float as) {
  vec3 Cb = blendUnpremul(cbP, ab);
  vec3 Cs = blendUnpremul(csP, as);
  vec3 B  = (mode == M_NORMAL || mode == M_DISSOLVE || mode == M_PASS_THROUGH)
          ? Cs : blendMode(mode, Cb, Cs);

  BlendPixel o;
  if (compOp == COMP_CLIP_TO_BACKDROP) {
    o.a   = ab;
    o.rgb = mix(cbP, B * ab, as);
  } else if (compOp == COMP_CLIP_TO_LAYER) {
    o.a   = as;
    o.rgb = (1.0 - ab) * csP + (ab * as) * B;
  } else if (compOp == COMP_INTERSECTION) {
    o.a   = ab * as;
    o.rgb = (ab * as) * B;
  } else {
    o.a   = as + ab * (1.0 - as);
    o.rgb = (1.0 - as) * cbP + (1.0 - ab) * csP + (ab * as) * B;
  }
  return o;
}
`

/**
 * Everything a compositing shader needs, minus the `#version`/`precision`
 * header and the `main()` — concatenate in this order.
 *
 * @param mode when given, emits a branch-free single-mode `blendMode()`.
 */
export function blendModeChunk(mode?: BlendMode): string {
  return [
    glslModeDefines(),
    GLSL_PRELUDE,
    GLSL_SEPARABLE,
    GLSL_NON_SEPARABLE,
    GLSL_DISSOLVE,
    mode ? glslBlendSingle(mode) + `vec3 blendMode(int m, vec3 b, vec3 s) { return blendMode(b, s); }\n` : glslBlendDispatch(),
    GLSL_COMPOSITE,
  ].join('\n')
}
