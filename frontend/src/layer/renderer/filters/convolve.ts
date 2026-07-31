// Stylize family: 3×3 convolutions, point operators, and separable morphology.
//
// Space: PERCEPTUAL for all of them. These filters are defined on encoded
// values in the legacy catalogue (kernels tuned around a 128 bias, thresholds
// expressed in 8-bit codes) and running them in linear light would change every
// result. The conversion is explicit at the top and bottom of each shader.
//
// Note on alpha: the CPU versions skipped fully transparent pixels and left
// their colour untouched. The shaders do the same with an early return, which
// also keeps the premultiplied invariant.

import { fragmentShader } from './glsl/common'
import type { GpuPass } from './types'

/** Encoded straight colour of a neighbour, edge-clamped. */
const NEIGHBOUR = `
vec3 encAt(vec2 px) {
  vec4 s = fetchPixel(clamp(px, vec2(0.0), uSize - 1.0));
  return linearToSrgb(unpremul(s));
}
`

/** Generic 3×3 convolution: kernel, divisor, bias (emboss, bas relief). */
export const CONVOLVE3_FRAG = fragmentShader(`
uniform float uKernel[9];
uniform float uDiv;
uniform float uBias;
uniform int   uGray;      // 1 = desaturate first (bas relief, note paper)
void main() {
  vec4 s = texture(uSrc, vUv);
  if (s.a <= 0.0) { fragColor = s; return; }
  vec2 px = pixelCoord();
  vec3 acc = vec3(0.0);
  int k = 0;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      vec3 n = encAt(px + vec2(float(dx), float(dy)));
      if (uGray == 1) n = vec3(luma601(n));
      acc += n * uKernel[k];
      k++;
    }
  }
  vec3 c = clamp(acc / uDiv + uBias, 0.0, 1.0);
  fragColor = premul(srgbToLinear(c), s.a);
}
`, [NEIGHBOUR])

/** Sobel magnitude per channel, inverted — Photoshop's "Find Edges". */
export const FIND_EDGES_FRAG = fragmentShader(`
uniform int uGray;
void main() {
  vec4 s = texture(uSrc, vUv);
  if (s.a <= 0.0) { fragColor = s; return; }
  vec2 px = pixelCoord();
  vec3 gx = vec3(0.0), gy = vec3(0.0);
  float kx[9] = float[9](-1.0, 0.0, 1.0, -2.0, 0.0, 2.0, -1.0, 0.0, 1.0);
  float ky[9] = float[9](-1.0, -2.0, -1.0, 0.0, 0.0, 0.0, 1.0, 2.0, 1.0);
  int k = 0;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      vec3 n = encAt(px + vec2(float(dx), float(dy)));
      if (uGray == 1) n = vec3(luma601(n));
      gx += n * kx[k];
      gy += n * ky[k];
      k++;
    }
  }
  vec3 mag = sqrt(gx * gx + gy * gy);
  fragColor = premul(srgbToLinear(clamp(vec3(1.0) - mag, 0.0, 1.0)), s.a);
}
`, [NEIGHBOUR])

/** Solarize: v < 0.5 ? v : 1 - v, on encoded values. */
export const SOLARIZE_FRAG = fragmentShader(`
void main() {
  vec4 s = texture(uSrc, vUv);
  if (s.a <= 0.0) { fragColor = s; return; }
  vec3 c = linearToSrgb(unpremul(s));
  c = mix(c, vec3(1.0) - c, step(vec3(0.5), c));
  fragColor = premul(srgbToLinear(c), s.a);
}
`)

/**
 * Trace Contour: mark, per channel, the pixels where the level is crossed
 * between this pixel and its right / lower neighbour. Ports the CPU version
 * including its transparent-pixel behaviour (white).
 */
export const TRACE_CONTOUR_FRAG = fragmentShader(`
uniform float uLevel;
void main() {
  vec4 s = texture(uSrc, vUv);
  if (s.a <= 0.0) { fragColor = premul(vec3(1.0), s.a); return; }
  vec2 px = pixelCoord();
  vec3 v  = encAt(px);
  vec3 r  = encAt(px + vec2(1.0, 0.0));
  vec3 d  = encAt(px + vec2(0.0, 1.0));
  bvec3 lv = lessThan(v, vec3(uLevel));
  bvec3 lr = lessThan(r, vec3(uLevel));
  bvec3 ld = lessThan(d, vec3(uLevel));
  vec3 cross = vec3(
    (lv.x != lr.x || lv.x != ld.x) ? 0.0 : 1.0,
    (lv.y != lr.y || lv.y != ld.y) ? 0.0 : 1.0,
    (lv.z != lr.z || lv.z != ld.z) ? 0.0 : 1.0);
  fragColor = premul(srgbToLinear(cross), s.a);
}
`, [NEIGHBOUR])

/**
 * Separable morphology (Maximum / Minimum). A Chebyshev (square) structuring
 * element is separable: a horizontal pass followed by a vertical one gives the
 * same result as the 2-D window, at O(2r) instead of O(r²). The legacy
 * implementation went through `rankFilter`, i.e. a full sort per pixel.
 */
export const MORPHOLOGY_FRAG = fragmentShader(`
uniform vec2  uDir;      // (1,0) or (0,1), in pixels
uniform int   uRadius;
uniform int   uMax;      // 1 = dilate, 0 = erode
void main() {
  vec4 s = texture(uSrc, vUv);
  vec2 px = pixelCoord();
  vec3 best = linearToSrgb(unpremul(s));
  for (int i = 1; i <= 32; i++) {
    if (i > uRadius) break;
    vec3 a = encAt(px + uDir * float(i));
    vec3 b = encAt(px - uDir * float(i));
    best = uMax == 1 ? max(best, max(a, b)) : min(best, min(a, b));
  }
  fragColor = premul(srgbToLinear(best), s.a);
}
`, [NEIGHBOUR])

export const EMBOSS_KERNEL = [-2, -1, 0, -1, 1, 1, 0, 1, 2]

export function convolve3Passes(kernel: readonly number[], div = 1, bias = 0, gray = false): GpuPass[] {
  return [{
    name: 'convolve',
    key: 'convolve/3x3',
    glsl: CONVOLVE3_FRAG,
    uniforms: () => ({ uKernel: [...kernel], uDiv: div, uBias: bias, uGray: gray ? 1 : 0 }),
  }]
}

export function findEdgesPasses(gray = false): GpuPass[] {
  return [{ name: 'edges', key: 'convolve/findEdges', glsl: FIND_EDGES_FRAG, uniforms: () => ({ uGray: gray ? 1 : 0 }) }]
}

export function solarizePasses(): GpuPass[] {
  return [{ name: 'solarize', key: 'convolve/solarize', glsl: SOLARIZE_FRAG }]
}

export function traceContourPasses(level: number): GpuPass[] {
  return [{ name: 'trace', key: 'convolve/trace', glsl: TRACE_CONTOUR_FRAG, uniforms: () => ({ uLevel: level }) }]
}

export function morphologyPasses(radius: number, kind: 'max' | 'min'): GpuPass[] {
  const r = Math.min(32, Math.max(1, Math.round(radius)))
  const common = { key: 'convolve/morphology', glsl: MORPHOLOGY_FRAG }
  return [
    { name: 'morphX', ...common, uniforms: () => ({ uDir: [1, 0], uRadius: r, uMax: kind === 'max' ? 1 : 0 }) },
    { name: 'morphY', ...common, uniforms: () => ({ uDir: [0, 1], uRadius: r, uMax: kind === 'max' ? 1 : 0 }) },
  ]
}

/** Desaturate to NTSC luma on encoded values — the legacy `grayscaleOf`. */
export const GRAYSCALE_FRAG = fragmentShader(`
void main() {
  vec4 s = texture(uSrc, vUv);
  if (s.a <= 0.0) { fragColor = s; return; }
  vec3 c = linearToSrgb(unpremul(s));
  fragColor = premul(srgbToLinear(vec3(luma601(c))), s.a);
}
`)

export function grayscalePasses(): GpuPass[] {
  return [{ name: 'gray', key: 'convolve/gray', glsl: GRAYSCALE_FRAG }]
}

/** Threshold on encoded NTSC luma — the legacy `threshold` filter. */
export const THRESHOLD_FRAG = fragmentShader(`
uniform float uLevel;
void main() {
  vec4 s = texture(uSrc, vUv);
  if (s.a <= 0.0) { fragColor = s; return; }
  vec3 c = linearToSrgb(unpremul(s));
  fragColor = premul(srgbToLinear(vec3(step(uLevel, luma601(c)))), s.a);
}
`)

/** Posterize on encoded values — the legacy `posterize` filter. */
export const POSTERIZE_FRAG = fragmentShader(`
uniform float uLevels;
void main() {
  vec4 s = texture(uSrc, vUv);
  if (s.a <= 0.0) { fragColor = s; return; }
  vec3 c = linearToSrgb(unpremul(s));
  float n = max(uLevels - 1.0, 1.0);
  // The legacy CPU filter quantises 8-bit codes: round(round(v/step)*step).
  c = floor(clamp(c, 0.0, 1.0) * n + 0.5) / n;
  fragColor = premul(srgbToLinear(c), s.a);
}
`)

export function thresholdPasses(level: number): GpuPass[] {
  return [{ name: 'threshold', key: 'convolve/threshold', glsl: THRESHOLD_FRAG, uniforms: () => ({ uLevel: level }) }]
}

export function posterizePasses(levels: number): GpuPass[] {
  return [{ name: 'posterize', key: 'convolve/posterize', glsl: POSTERIZE_FRAG, uniforms: () => ({ uLevels: levels }) }]
}
