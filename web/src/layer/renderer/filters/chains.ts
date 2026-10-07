// Multi-stage filters built by chaining passes that already exist.
//
// The legacy catalogue implemented these by calling one CPU filter on the
// output of another — each stage allocating a full RGBA copy of the layer.
// Here they are pass lists: the intermediates stay on the GPU, in the texture
// pool, and never cross the bus.
//
// Space: PERCEPTUAL, like every filter they are made of.

import { blurPasses } from './blur'
import { convolve3Passes, EMBOSS_KERNEL, findEdgesPasses, grayscalePasses, posterizePasses, thresholdPasses } from './convolve'
import { fragmentShader } from './glsl/common'
import { noisePasses } from './noise'
import type { GpuPass } from './types'

/**
 * Photocopy: the ratio between a pixel and its local mean, hard-limited.
 * Ports the CPU chain grayscale → blur(3) → ratio → clip.
 */
export const PHOTOCOPY_FRAG = fragmentShader(`
uniform sampler2D uBlur;
void main() {
  vec4 s = texture(uSrc, vUv);
  if (s.a <= 0.0) { fragColor = s; return; }
  float v = linearToSrgb(unpremul(s)).r;
  float b = linearToSrgb(unpremul(texture(uBlur, vUv))).r;
  float r = b <= 0.0 ? 1.0 : min(1.0, v / b);
  float o = r > (200.0 / 255.0) ? 1.0 : (r < (90.0 / 255.0) ? 0.0 : r);
  fragColor = premul(srgbToLinear(vec3(o)), s.a);
}
`)

/** Multiply a posterised image by an edge mask (Poster Edges). */
export const POSTER_EDGES_FRAG = fragmentShader(`
uniform sampler2D uPost;
uniform sampler2D uEdges;
uniform float uFloor;      // 0 = pure multiply, 0.35 = watercolor-style lift
void main() {
  vec4 s = texture(uSrc, vUv);
  if (s.a <= 0.0) { fragColor = s; return; }
  vec3 post = linearToSrgb(unpremul(texture(uPost, vUv)));
  vec3 edge = linearToSrgb(unpremul(texture(uEdges, vUv)));
  float e = luma601(edge);
  vec3 c = clamp(post * (uFloor + (1.0 - uFloor) * e), 0.0, 1.0);
  fragColor = premul(srgbToLinear(c), s.a);
}
`)

export function photocopyPasses(radius = 3): GpuPass[] {
  const gray = grayscalePasses().map(p => ({ ...p, name: 'gray', inputs: { uSrc: 'source' as const } }))
  const blur = blurPasses(radius, 'gaussian')
  return [
    ...gray,
    ...blur,
    {
      name: 'photocopy',
      key: 'chains/photocopy',
      glsl: PHOTOCOPY_FRAG,
      inputs: { uSrc: { pass: 'gray' }, uBlur: 'previous' },
    },
  ]
}

/** Stamp: threshold of a blurred grayscale. */
export function stampPasses(level: number, radius = 2): GpuPass[] {
  return [
    ...grayscalePasses().map(p => ({ ...p, inputs: { uSrc: 'source' as const } })),
    ...blurPasses(radius, 'gaussian'),
    ...thresholdPasses(level),
  ]
}

/** Bas relief: emboss on a grayscale, in one convolution pass. */
export function basReliefPasses(): GpuPass[] {
  return convolve3Passes(EMBOSS_KERNEL, 1, 0.5, true)
}

/** Chalk & charcoal: edges of a grayscale, then monochrome grain. */
export function chalkPasses(): GpuPass[] {
  return [...findEdgesPasses(true), ...noisePasses({ amount: 18, monochromatic: true })]
}

/** Note paper: emboss of a grayscale, then monochrome grain. */
export function notePaperPasses(): GpuPass[] {
  return [...convolve3Passes(EMBOSS_KERNEL, 1, 0.5, true), ...noisePasses({ amount: 20, monochromatic: true })]
}

/** Poster edges: posterize × edge mask. */
export function posterEdgesPasses(levels = 6): GpuPass[] {
  return [
    ...posterizePasses(levels).map(p => ({ ...p, name: 'post', inputs: { uSrc: 'source' as const } })),
    ...findEdgesPasses(false).map(p => ({ ...p, name: 'edges', inputs: { uSrc: 'source' as const } })),
    {
      name: 'combine',
      key: 'chains/posterEdges',
      glsl: POSTER_EDGES_FRAG,
      inputs: { uSrc: 'source', uPost: { pass: 'post' }, uEdges: { pass: 'edges' } },
      uniforms: () => ({ uFloor: 0 }),
    },
  ]
}
