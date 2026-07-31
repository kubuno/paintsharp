// Distort family — every entry is one gather pass.
//
// All of these are INVERSE mappings: for the output pixel p, compute the source
// position and fetch it. That is exactly what the CPU `distort()` helper did,
// one `sampleBilinear` at a time; on GPU the bilinear fetch is free (texture
// unit) and, because the working space is PREMULTIPLIED, it is also correct at
// transparent edges without the manual premultiply/unpremultiply the CPU
// version had to do per sample.
//
// Geometry is expressed in PIXELS (not UV) so the maths matches the CPU
// reference line for line and is independent of the layer aspect ratio.
//
// Space: none of these touch colour, so they are space-agnostic and run
// directly on the premultiplied linear samples.

import { fragmentShader } from './glsl/common'
import type { GpuPass } from './types'

/**
 * One shader, one branch per mapping: distortions are cheap and switching on a
 * uniform keeps the program count (and the shader-compile stalls) down.
 * Modes: 0 pinch, 1 spherize, 2 twirl, 3 ripple, 4 wave, 5 zigzag, 6 polar.
 */
export const DISTORT_FRAG = fragmentShader(`
uniform int   uMode;
uniform float uA;    // amount / angle / amplitude
uniform float uB;    // size / wavelength

void main() {
  vec2 px = pixelCoord();
  vec2 c = uSize * 0.5;
  float R = min(c.x, c.y);
  vec2 s = px;

  if (uMode == 0) {                       // pinch
    vec2 d = px - c;
    float dist = length(d) / R;
    if (dist < 1.0 && dist > 0.0) {
      float f = pow(dist, 1.0 + uA) / dist;
      s = c + d * f;
    }
  } else if (uMode == 1) {                // spherize
    vec2 d = (px - c) / R;
    float dist = length(d);
    if (dist < 1.0 && dist > 0.0) {
      float z = sqrt(1.0 - dist * dist);
      float f = 1.0 - uA * (1.0 - z);
      s = c + d * R * f;
    }
  } else if (uMode == 2) {                // twirl
    vec2 d = px - c;
    float dist = length(d);
    if (dist < R) {
      float a = radians(uA) * (1.0 - dist / R);
      float cs = cos(a), sn = sin(a);
      s = c + vec2(d.x * cs - d.y * sn, d.x * sn + d.y * cs);
    }
  } else if (uMode == 3) {                // ripple
    s = px + vec2(sin(px.y / uB) * uA, sin(px.x / uB) * uA);
  } else if (uMode == 4) {                // wave
    s = px + vec2(sin(px.y / uB * 6.283185307) * uA, 0.0);
  } else if (uMode == 5) {                // zigzag
    vec2 d = px - c;
    float dist = length(d);
    float off = sin(dist / 12.0) * uA;
    float ang = atan(d.y, d.x);
    s = px + vec2(cos(ang) * off, sin(ang) * off);
  } else {                                // polar coordinates
    float a = (px.x / uSize.x) * 6.283185307 - 3.14159265;
    float r = (1.0 - px.y / uSize.y) * R;
    s = c + vec2(sin(a) * r, -cos(a) * r);
  }

  fragColor = fetchPixel(clamp(s, vec2(0.0), uSize - 1.0));
}
`)

export type DistortMode = 'pinch' | 'spherize' | 'twirl' | 'ripple' | 'wave' | 'zigzag' | 'polar'

const MODE_INDEX: Record<DistortMode, number> =
  { pinch: 0, spherize: 1, twirl: 2, ripple: 3, wave: 4, zigzag: 5, polar: 6 }

export function distortPasses(mode: DistortMode, a: number, b = 1): GpuPass[] {
  return [{
    name: mode,
    key: 'geometric/distort',
    glsl: DISTORT_FRAG,
    uniforms: () => ({ uMode: MODE_INDEX[mode], uA: a, uB: Math.max(1e-3, b) }),
  }]
}

/**
 * Offset with wrap-around. Ports `layerFilters.offset`. `fract` on the UV is
 * enough — the target is sampled with REPEAT wrapping.
 */
export const OFFSET_FRAG = fragmentShader(`
uniform vec2 uDelta;   // in pixels
void main() {
  vec2 px = pixelCoord();
  vec2 s = mod(px - uDelta, uSize);
  fragColor = texture(uSrc, (s + 0.5) * uTexel);
}
`)

export function offsetPasses(dx: number, dy: number): GpuPass[] {
  return [{
    name: 'offset',
    key: 'geometric/offset',
    glsl: OFFSET_FRAG,
    uniforms: () => ({ uDelta: [dx, dy] }),
  }]
}
