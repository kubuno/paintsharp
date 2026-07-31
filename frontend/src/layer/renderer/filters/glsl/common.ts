// Shared GLSL prelude for every filter program.
//
// The working space is RGBA16F, LINEAR light, PREMULTIPLIED alpha (spec §4.3,
// §4.4). Filters therefore start from premultiplied linear samples and must end
// there too. Two helpers make the round trip explicit: `unpremul` (→ straight
// linear) and `premul` (→ back). Filters that are DEFINED on perceptual values
// (levels, curves, posterize, threshold, the whole legacy catalogue) wrap their
// body in `linearToSrgb` / `srgbToLinear`; each filter states which space it
// works in, because getting that wrong is the classic source of "why is my
// contrast curve wrong in the shadows".
//
// Colour-space transfer functions follow IEC 61966-2-1 exactly (no pow(c,2.2)
// approximation: the error on the near-black linear segment is several 8-bit
// codes and is visible in shadows).

/** GLSL ES 3.00 header + varyings + the uniforms every pass receives. */
export const GLSL_HEADER = `#version 300 es
precision highp float;
precision highp int;
in vec2 vUv;
layout(location = 0) out vec4 fragColor;
uniform sampler2D uSrc;
uniform vec2 uSize;    // target size in pixels
uniform vec2 uTexel;   // 1.0 / uSize
uniform float uSeed;   // deterministic seed for hashed noise
`

/** sRGB transfer functions, premultiply helpers, luminance. */
export const GLSL_COLORSPACE = `
vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow(max(c + 0.055, vec3(0.0)) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
vec3 linearToSrgb(vec3 c) {
  c = max(c, vec3(0.0));
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
/** Premultiplied -> straight. Guarded: alpha 0 carries no colour information. */
vec3 unpremul(vec4 p) { return p.a > 0.0 ? p.rgb / p.a : vec3(0.0); }
vec4 premul(vec3 c, float a) { return vec4(c * a, a); }
/** Rec.709 luminance — the correct weights for LINEAR light. */
float luminance709(vec3 lin) { return dot(lin, vec3(0.2126, 0.7152, 0.0722)); }
/** NTSC luma — only correct on NON-LINEAR (encoded) values. Legacy parity. */
float luma601(vec3 enc) { return dot(enc, vec3(0.299, 0.587, 0.114)); }
float maxc(vec3 c) { return max(c.r, max(c.g, c.b)); }
float minc(vec3 c) { return min(c.r, min(c.g, c.b)); }
`

/**
 * Oklab / OkLCh (Björn Ottosson, public domain reference implementation).
 * Used for hue and saturation instead of HSL: HSL applied to encoded values
 * drifts the lightness badly on saturated reds and blues (spec §9.2).
 * Input/output RGB is LINEAR.
 */
export const GLSL_OKLAB = `
vec3 linearToOklab(vec3 c) {
  float l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
  float m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
  float s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b;
  float l_ = sign(l) * pow(abs(l), 1.0 / 3.0);
  float m_ = sign(m) * pow(abs(m), 1.0 / 3.0);
  float s_ = sign(s) * pow(abs(s), 1.0 / 3.0);
  return vec3(
    0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_);
}
vec3 oklabToLinear(vec3 lab) {
  float l_ = lab.x + 0.3963377774 * lab.y + 0.2158037573 * lab.z;
  float m_ = lab.x - 0.1055613458 * lab.y - 0.0638541728 * lab.z;
  float s_ = lab.x - 0.0894841775 * lab.y - 1.2914855480 * lab.z;
  float l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
  return vec3(
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
}
`

/**
 * Integer hash noise. Deterministic and reproducible from (pixel, seed) alone —
 * unlike `Math.random()` in the legacy CPU path, which makes undo replay
 * impossible. Based on the PCG output permutation (Melissa O'Neill, Apache-2.0
 * idea, integer-only reimplementation).
 */
export const GLSL_HASH = `
uint pcgHash(uint v) {
  uint state = v * 747796405u + 2891336453u;
  uint word  = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}
uint hash2(ivec2 p, uint seed) {
  return pcgHash(uint(p.x) * 73856093u ^ uint(p.y) * 19349663u ^ seed);
}
/** Uniform [0,1). */
float rand2(ivec2 p, uint seed) { return float(hash2(p, seed)) * (1.0 / 4294967296.0); }
/** Two independent uniforms. */
vec2 rand22(ivec2 p, uint seed) { return vec2(rand2(p, seed), rand2(p, seed ^ 0x9e3779b9u)); }
/** Approximately normal(0,1) via Box-Muller on two uniforms. */
float randn(ivec2 p, uint seed) {
  vec2 u = max(rand22(p, seed), vec2(1e-7));
  return sqrt(-2.0 * log(u.x)) * cos(6.2831853071 * u.y);
}
/** Smooth value noise on a lattice of 'cell' pixels. */
float valueNoise(vec2 pos, float cell, uint seed) {
  vec2 g = pos / cell;
  ivec2 i0 = ivec2(floor(g));
  vec2 t = fract(g);
  vec2 s = t * t * (3.0 - 2.0 * t);
  float v00 = rand2(i0,                 seed);
  float v10 = rand2(i0 + ivec2(1, 0),   seed);
  float v01 = rand2(i0 + ivec2(0, 1),   seed);
  float v11 = rand2(i0 + ivec2(1, 1),   seed);
  return mix(mix(v00, v10, s.x), mix(v01, v11, s.x), s.y);
}
`

/**
 * Edge-clamped sampling.
 *
 * TEXEL-CENTRE RULE — the single most common source of "my port is one pixel
 * blurry": a fragment covering output pixel x has `vUv * uSize == x + 0.5`.
 * A filter ported from a CPU loop indexes INTEGER pixels, so it must start from
 * `pixelCoord()` (the floor) and fetch at `px + 0.5` texels. Feeding `vUv*uSize`
 * straight into `fetchPixel` shifts every tap by half a texel, and with LINEAR
 * filtering that silently averages two neighbours instead of reading one.
 */
export const GLSL_SAMPLING = `
vec4 fetchClamped(vec2 uv) { return texture(uSrc, clamp(uv, uTexel * 0.5, 1.0 - uTexel * 0.5)); }
/** Integer pixel index of the fragment being shaded. */
vec2 pixelCoord() { return floor(vUv * uSize); }
/** Fetch by INTEGER pixel index, sampled at the texel centre, edge-clamped. */
vec4 fetchPixel(vec2 px) { return fetchClamped((px + 0.5) * uTexel); }
`

/** Everything a typical filter needs, in one string. */
export const GLSL_PRELUDE = GLSL_HEADER + GLSL_COLORSPACE + GLSL_SAMPLING

/** Compose a full fragment shader from the prelude, extra chunks and a body. */
export function fragmentShader(body: string, chunks: readonly string[] = []): string {
  return GLSL_PRELUDE + chunks.join('\n') + '\n' + body
}
