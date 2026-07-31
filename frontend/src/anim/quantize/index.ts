// Palette construction facade.

import type { Palette, QuantizerKind, RgbaImage } from '../types.ts'
import { buildHistogram, exactColors, DEFAULT_SAMPLE_BUDGET } from './histogram.ts'
import { medianCutPalette } from './medianCut.ts'
import { octreePalette } from './octree.ts'
import { ExactMapper, NearestCache, type ColorMapper } from './nearest.ts'

export { buildHistogram, exactColors, DEFAULT_SAMPLE_BUDGET } from './histogram.ts'
export { medianCutPalette, sortPalette, LLOYD_PASSES } from './medianCut.ts'
export { octreePalette } from './octree.ts'
export { NearestCache, ExactMapper, paletteError, type ColorMapper } from './nearest.ts'
export { ditherToIndices, BAYER8, type DitherOptions } from './dither.ts'

export interface PaletteBuildOptions {
  /** Requested colour count, 2..256 (transparency is accounted for on top). */
  colors: number
  quantizer: QuantizerKind
  /** Reserve one slot for the binary transparent index (GIF, indexed APNG). */
  needsTransparency: boolean
  sampleBudget?: number
}

export interface BuiltPalette {
  palette: Palette
  mapper: ColorMapper
  /** True when every source colour is represented exactly (no loss, no dither). */
  exact: boolean
}

/**
 * Build the palette shared by every frame.
 *
 * The exact fast path is tried first and is not an optimisation detail: it is
 * what guarantees that opening a GIF, moving a frame and re-exporting does not
 * change a single colour.
 */
export function buildPalette(frames: readonly RgbaImage[], opts: PaletteBuildOptions): BuiltPalette {
  const requested = Math.max(2, Math.min(256, Math.floor(opts.colors)))
  const budget = opts.needsTransparency ? Math.min(255, requested) : requested

  if (opts.quantizer !== 'octree') {
    const exact = exactColors(frames, budget)
    if (exact) return finish(fromExact(exact), opts.needsTransparency, true)
  }

  const hist = buildHistogram(frames, opts.sampleBudget ?? DEFAULT_SAMPLE_BUDGET)
  const built = opts.quantizer === 'octree' ? octreePalette(hist, budget) : medianCutPalette(hist, budget)
  return finish(built, opts.needsTransparency, false)
}

function fromExact(colors: Uint32Array): { rgb: Uint8Array; size: number } {
  const rgb = new Uint8Array(Math.max(1, colors.length) * 3)
  for (let i = 0; i < colors.length; i++) {
    rgb[i * 3] = (colors[i] >> 16) & 0xff
    rgb[i * 3 + 1] = (colors[i] >> 8) & 0xff
    rgb[i * 3 + 2] = colors[i] & 0xff
  }
  return { rgb, size: Math.max(1, colors.length) }
}

function finish(built: { rgb: Uint8Array; size: number }, needsTransparency: boolean, exact: boolean): BuiltPalette {
  let { rgb, size } = built
  let transparentIndex = -1
  if (needsTransparency) {
    // The transparent entry is appended last so that the opaque indices keep the
    // order the quantiser produced (and so an exact palette stays recognisable).
    const grown = new Uint8Array((size + 1) * 3)
    grown.set(rgb.subarray(0, size * 3))
    rgb = grown
    transparentIndex = size
    size += 1
  }
  const palette: Palette = { rgb, size, transparentIndex }
  return { palette, mapper: exact ? new ExactMapper(palette) : new NearestCache(palette), exact }
}
