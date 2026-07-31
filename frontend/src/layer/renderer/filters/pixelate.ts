// Pixelate family — mosaic, colour halftone, halftone pattern, fragment.
//
// The shared machinery is a CELL AVERAGE pass: the layer is rendered into a
// ceil(w/cell) × ceil(h/cell) target where every texel is the alpha-weighted
// mean of its cell. That single reduction pass replaces the CPU's nested block
// loops, and the second pass reads it back with a nearest-neighbour lookup.
//
// Sampling note: the cell average loops at most 16 samples per axis. For a cell
// of 16 px or less (the default is 12) the average is EXACT; above that it is a
// regular 16×16 stratified estimate, which is invisible for a mosaic and keeps
// the shader cost bounded — the CPU version was O(cell²) per cell.

import { fragmentShader } from './glsl/common'
import type { GpuPass, ParamValues } from './types'

/** Alpha-weighted mean of one cell, written to a downscaled target. */
export const CELL_AVERAGE_FRAG = fragmentShader(`
uniform float uCell;
uniform vec2  uSrcSize;
void main() {
  vec2 cellOrigin = floor(vUv * uSize) * uCell;
  float n = min(uCell, 16.0);
  float stepPx = uCell / n;
  vec4 acc = vec4(0.0);
  float cnt = 0.0;
  for (int j = 0; j < 16; j++) {
    if (float(j) >= n) break;
    for (int i = 0; i < 16; i++) {
      if (float(i) >= n) break;
      vec2 p = cellOrigin + (vec2(float(i), float(j)) + 0.5) * stepPx;
      if (p.x >= uSrcSize.x || p.y >= uSrcSize.y) continue;
      acc += texture(uSrc, p / uSrcSize);
      cnt += 1.0;
    }
  }
  fragColor = cnt > 0.0 ? acc / cnt : vec4(0.0);
}
`)

/** Paint each pixel with its cell's mean colour (mosaic). */
export const MOSAIC_APPLY_FRAG = fragmentShader(`
uniform sampler2D uCells;
uniform float uCell;
void main() {
  vec2 cell = floor(pixelCoord() / uCell);
  vec2 cellsSize = vec2(textureSize(uCells, 0));
  fragColor = texture(uCells, (cell + 0.5) / cellsSize);
}
`)

/**
 * Colour halftone: per channel, a dot whose radius grows with the cell mean.
 * Ports `layerFilters.colorHalftone` (single screen angle, same 0.72 factor).
 * Operates on ENCODED values: a halftone dot area is a perceptual quantity.
 */
export const HALFTONE_FRAG = fragmentShader(`
uniform sampler2D uCells;
uniform float uCell;
uniform int   uInvert;      // 1 = halftone pattern (dark dots on white)
uniform int   uGray;        // 1 = single grey screen instead of 3 channels
void main() {
  vec4 s = texture(uSrc, vUv);
  vec2 px = pixelCoord();
  vec2 cell = floor(px / uCell);
  vec2 cellsSize = vec2(textureSize(uCells, 0));
  vec4 m = texture(uCells, (cell + 0.5) / cellsSize);
  vec3 mean = linearToSrgb(unpremul(m));
  vec2 centre = (cell + 0.5) * uCell;
  float d = distance(px + 0.5, centre);
  vec3 c;
  if (uGray == 1) {
    float g = luma601(mean);
    float radius = (uInvert == 1 ? 1.0 - g : g) * (uCell * 0.72);
    c = vec3(d <= radius ? (uInvert == 1 ? 0.0 : 1.0) : (uInvert == 1 ? 1.0 : 0.0));
  } else {
    vec3 radius = mean * (uCell * 0.72);
    c = vec3(step(d, radius.r), step(d, radius.g), step(d, radius.b));
  }
  fragColor = premul(srgbToLinear(c), s.a);
}
`)

/** Fragment: the mean of four diagonally offset copies. */
export const FRAGMENT_FRAG = fragmentShader(`
uniform float uOffset;
void main() {
  vec2 px = pixelCoord();
  float o = uOffset;
  vec4 acc = fetchPixel(px + vec2(-o, -o))
           + fetchPixel(px + vec2( o, -o))
           + fetchPixel(px + vec2(-o,  o))
           + fetchPixel(px + vec2( o,  o));
  fragColor = acc * 0.25;
}
`)

const cellCount = (n: number, cell: number) => Math.max(1, Math.ceil(n / cell))

function cellAveragePass(cell: number): GpuPass {
  return {
    name: 'cells',
    key: 'pixelate/cellAverage',
    glsl: CELL_AVERAGE_FRAG,
    inputs: { uSrc: 'source' },
    size: (_p: ParamValues, w: number, h: number) => [cellCount(w, cell), cellCount(h, cell)],
    uniforms: ctx => ({ uCell: cell, uSrcSize: [ctx.srcWidth, ctx.srcHeight] }),
  }
}

export function mosaicPasses(cell: number): GpuPass[] {
  return [
    cellAveragePass(cell),
    {
      name: 'apply',
      key: 'pixelate/mosaicApply',
      glsl: MOSAIC_APPLY_FRAG,
      inputs: { uSrc: 'source', uCells: { pass: 'cells' } },
      uniforms: () => ({ uCell: cell }),
    },
  ]
}

export function halftonePasses(dot: number, mode: 'color' | 'pattern'): GpuPass[] {
  return [
    cellAveragePass(dot),
    {
      name: 'apply',
      key: 'pixelate/halftone',
      glsl: HALFTONE_FRAG,
      inputs: { uSrc: 'source', uCells: { pass: 'cells' } },
      uniforms: () => ({
        uCell: dot,
        uInvert: mode === 'pattern' ? 1 : 0,
        uGray: mode === 'pattern' ? 1 : 0,
      }),
    },
  ]
}

export function fragmentPasses(offset = 4): GpuPass[] {
  return [{ name: 'fragment', key: 'pixelate/fragment', glsl: FRAGMENT_FRAG, uniforms: () => ({ uOffset: offset }) }]
}
