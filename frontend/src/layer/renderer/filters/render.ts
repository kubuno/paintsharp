// Render family — procedural generators (clouds, fibers, lens flare).
//
// These filters SYNTHESISE pixels, so there is no CPU reference to match bit
// for bit: the legacy versions seed a JS LCG and fill a lattice in raster
// order, which no parallel implementation can reproduce. What is preserved is
// the STRUCTURE (six octaves, the same lattice sizes, the same amplitude decay)
// and, more importantly, determinism: the same seed always yields the same
// image, on GPU and in a worker, which the legacy `Math.random()` path could
// not guarantee.
//
// Space: the noise field is generated in PERCEPTUAL space (the colours the user
// picks are encoded values) and converted to linear on output.

import { fragmentShader, GLSL_HASH } from './glsl/common'
import type { GpuPass } from './types'

/** Fractal value noise, 6 octaves, lattice 64→2 px, amplitude halved. */
const FBM = `
float fbm6(vec2 pos, uint seed) {
  float amp = 1.0, total = 0.0, acc = 0.0;
  for (int oct = 0; oct < 6; oct++) {
    float cell = float(1 << (6 - oct));
    acc   += valueNoise(pos, cell, seed + uint(oct) * 9973u) * amp;
    total += amp;
    amp   *= 0.5;
  }
  return acc / total;
}
`

/** Clouds: interpolate two colours through the fractal field. */
export const CLOUDS_FRAG = fragmentShader(`
uniform vec3 uFg;
uniform vec3 uBg;
uniform int  uDifference;   // 1 = |src - clouds| (Difference Clouds)
void main() {
  vec4 s = texture(uSrc, vUv);
  float t = fbm6(vUv * uSize, uint(uSeed));
  vec3 cloud = mix(uBg, uFg, t);
  if (uDifference == 1) {
    if (s.a <= 0.0) { fragColor = s; return; }
    vec3 c = abs(linearToSrgb(unpremul(s)) - cloud);
    fragColor = premul(srgbToLinear(c), s.a);
  } else {
    fragColor = premul(srgbToLinear(cloud), 1.0);
  }
}
`, [GLSL_HASH, FBM])

/** Fibers: a per-column random phase modulated along y. */
export const FIBERS_FRAG = fragmentShader(`
void main() {
  vec2 px = pixelCoord();
  float col = rand2(ivec2(int(px.x), 0), uint(uSeed));
  float v = 0.5 + 0.5 * sin(col * 30.0 + px.y * 0.05 + sin(px.y * 0.3) * col * 4.0);
  fragColor = premul(srgbToLinear(vec3(v)), 1.0);
}
`, [GLSL_HASH])

/**
 * Lens flare: a main glow plus ghosts along the axis through the layer centre.
 * Deterministic geometry, so this one IS a faithful port of the CPU version
 * (same 0.7/0.3 flare position, same 2.2 falloff, same four ghost positions).
 */
export const LENS_FLARE_FRAG = fragmentShader(`
uniform vec2 uFlare;     // flare centre in pixels
void main() {
  vec4 s = texture(uSrc, vUv);
  if (s.a <= 0.0) { fragColor = s; return; }
  vec2 px = pixelCoord();
  vec2 c = uSize * 0.5;
  float R = min(uSize.x, uSize.y) * 0.5;
  vec3 col = linearToSrgb(unpremul(s));

  float d = distance(px, uFlare);
  if (d < R) {
    float g = pow(1.0 - d / R, 2.2);
    col += vec3(g, g * 0.95, g * 0.8);
  }
  float ts[4] = float[4](0.2, 0.45, 0.65, 1.3);
  for (int i = 0; i < 4; i++) {
    vec2 gc = c + (uFlare - c) * (1.0 - ts[i]) * 2.0;
    float gr = R * 0.12;
    float gd = distance(px, gc);
    if (gd <= gr) col += vec3((1.0 - gd / gr) * (60.0 / 255.0));
  }
  fragColor = premul(srgbToLinear(clamp(col, 0.0, 1.0)), s.a);
}
`)

export function cloudsPasses(fg: readonly [number, number, number], bg: readonly [number, number, number], difference = false): GpuPass[] {
  return [{
    name: 'clouds',
    key: 'render/clouds',
    glsl: CLOUDS_FRAG,
    uniforms: () => ({ uFg: [...fg], uBg: [...bg], uDifference: difference ? 1 : 0 }),
  }]
}

export function fibersPasses(): GpuPass[] {
  return [{ name: 'fibers', key: 'render/fibers', glsl: FIBERS_FRAG }]
}

export function lensFlarePasses(): GpuPass[] {
  return [{
    name: 'flare',
    key: 'render/lensFlare',
    glsl: LENS_FLARE_FRAG,
    uniforms: ctx => ({ uFlare: [ctx.width * 0.7, ctx.height * 0.3] }),
  }]
}
