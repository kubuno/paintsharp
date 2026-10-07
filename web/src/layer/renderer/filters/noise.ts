// Noise family — deterministic, hash-based, one pass.
//
// The legacy CPU noise came in two flavours, both wrong in a different way:
//   - `imaging/filters.applyFilters` used `Math.random()`, so replaying an undo
//     produced DIFFERENT pixels;
//   - `layerFilters.addNoise` used a seeded LCG, but consumed one or three
//     draws per pixel and SKIPPED fully transparent pixels, so the sequence
//     depends on the alpha channel and cannot be reproduced by any parallel
//     implementation (GPU or worker) — it is inherently serial.
//
// The replacement hashes (pixel coordinate, seed) with a PCG output
// permutation: order-independent, so the GPU pass and the future worker/WASM
// path produce bit-identical results from the same seed. This is what makes the
// two backends interchangeable, which the tiling requires.
//
// New parameters over the legacy filter: gaussian vs uniform distribution and
// grain size (noise sampled on a coarser lattice, then interpolated).
//
// Space: PERCEPTUAL. Adding a constant amplitude in linear light would make the
// grain invisible in the shadows and violent in the highlights.

import { fragmentShader, GLSL_HASH } from './glsl/common'
import type { GpuPass } from './types'

export const ADD_NOISE_FRAG = fragmentShader(`
uniform float uAmount;      // 0..1 on encoded values
uniform int   uMono;
uniform int   uGaussian;
uniform float uGrain;       // grain lattice size in pixels, 1 = per pixel

float noiseAt(ivec2 p, uint salt) {
  if (uGaussian == 1) return randn(p, uint(uSeed) ^ salt) * 0.3333;
  return rand2(p, uint(uSeed) ^ salt) * 2.0 - 1.0;
}

float grainAt(vec2 px, uint salt) {
  if (uGrain <= 1.0) return noiseAt(ivec2(px), salt);
  // Smooth value noise on a coarse lattice reproduces film-grain clumping.
  return valueNoise(px, uGrain, uint(uSeed) ^ salt) * 2.0 - 1.0;
}

void main() {
  vec4 s = texture(uSrc, vUv);
  if (s.a <= 0.0) { fragColor = s; return; }
  vec3 c = linearToSrgb(unpremul(s));
  vec2 px = pixelCoord();
  vec3 n;
  if (uMono == 1) { float v = grainAt(px, 0u); n = vec3(v); }
  else n = vec3(grainAt(px, 0u), grainAt(px, 0x9e3779b9u), grainAt(px, 0x85ebca6bu));
  c = clamp(c + n * uAmount, 0.0, 1.0);
  fragColor = premul(srgbToLinear(c), s.a);
}
`, [GLSL_HASH])

export interface NoiseParams {
  /** Amplitude in 8-bit units (the legacy slider range is 1..200). */
  amount: number
  monochromatic: boolean
  gaussian?: boolean
  /** Grain lattice size in pixels; 1 = one draw per pixel. */
  grain?: number
}

export function noisePasses(p: NoiseParams): GpuPass[] {
  return [{
    name: 'noise',
    key: 'noise/add',
    glsl: ADD_NOISE_FRAG,
    uniforms: () => ({
      uAmount: p.amount / 255,
      uMono: p.monochromatic ? 1 : 0,
      uGaussian: p.gaussian ? 1 : 0,
      uGrain: p.grain ?? 1,
    }),
  }]
}

/**
 * Diffuse (Stylize): each pixel is replaced by a neighbour picked at random in
 * a small window. Ports `layerFilters.diffuse` (fixed ±3 px) with the radius
 * exposed and a deterministic hash instead of the serial LCG.
 */
export const DIFFUSE_FRAG = fragmentShader(`
uniform float uRadius;
void main() {
  vec2 px = pixelCoord();
  vec2 r = rand22(ivec2(px), uint(uSeed)) * 2.0 - 1.0;
  vec2 o = floor(r * uRadius + 0.5);
  fragColor = fetchPixel(clamp(px + o, vec2(0.0), uSize - 1.0));
}
`, [GLSL_HASH])

export function diffusePasses(radius: number): GpuPass[] {
  return [{ name: 'diffuse', key: 'noise/diffuse', glsl: DIFFUSE_FRAG, uniforms: () => ({ uRadius: radius }) }]
}
