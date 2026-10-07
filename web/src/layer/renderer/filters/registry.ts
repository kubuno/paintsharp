// The filter catalogue, AS DATA.
//
// One record per entry of the legacy `src/layerFilters.ts` FILTER_GROUPS, with
// the same ids, the same i18n keys and the same slider ranges, so the UI can be
// pointed at this registry without touching a single label. What changes is the
// body: instead of a CPU closure, each record carries the pass list that runs it
// on the GPU — or declares that it cannot run there, and why.
//
// Routing (spec §9.1):
//   'gpu'     point op, bounded kernel, or arbitrary gather  → fragment passes
//   'worker'  needs a per-pixel SORT, a per-pixel HISTOGRAM, or has a
//             SEQUENTIAL dependency along a scanline               → worker/WASM
//   'hybrid'  a GPU chain with exactly one worker link (always a median)
//
// See `inventory.md` in this folder for the full table and the justification of
// every 'worker' verdict.

import { averagePasses, blurPasses, motionPasses, radialPasses } from './blur'
import {
  basReliefPasses, chalkPasses, notePaperPasses, photocopyPasses, posterEdgesPasses, stampPasses,
} from './chains'
import {
  convolve3Passes, EMBOSS_KERNEL, findEdgesPasses, morphologyPasses, posterizePasses,
  solarizePasses, thresholdPasses, traceContourPasses,
} from './convolve'
import { distortPasses, offsetPasses } from './geometric'
import { diffusePasses, noisePasses } from './noise'
import { fragmentPasses, halftonePasses, mosaicPasses } from './pixelate'
import { cloudsPasses, fibersPasses, lensFlarePasses } from './render'
import { highPassPasses, unsharpPasses } from './sharpen'
import { param } from './types'
import type { GpuFilterDef } from './types'

const P = param

/** Reasons a filter cannot be a fragment program. Kept short and checkable. */
const WHY = {
  sort: 'per-pixel sort of the neighbourhood (rank filter); a GPU sorting network is only viable up to radius 2',
  histogram: 'per-pixel histogram with 20 bins; radius 8 means 289 samples and 20 registers per pixel',
  sequential: 'sequential dependency along the scanline: pixel x depends on the already-written pixel x-1',
  voronoi: 'Voronoi cell assignment; a GPU port needs jump flooding (2·log2(n) passes) and a second colour-gather pass',
  median: 'the chain contains a median link (see median)',
} as const

export const GPU_FILTERS: readonly GpuFilterDef[] = [
  // ── blur ───────────────────────────────────────────────────────────────────
  {
    id: 'gaussian', group: 'blur', nameKey: 'filt_gaussian', backend: 'gpu', space: 'linear',
    params: [P('radius', 'filt_p_radius', 1, 120, 1, 6)],
    passes: v => blurPasses(v.radius, 'gaussian'),
  },
  {
    id: 'box', group: 'blur', nameKey: 'filt_box_blur', backend: 'gpu', space: 'linear',
    params: [P('radius', 'filt_p_radius', 1, 120, 1, 6)],
    // A TRUE single-iteration box. The legacy entry ran the 3-iteration
    // Gaussian approximation and was therefore identical to "gaussian".
    passes: v => blurPasses(v.radius, 'box'),
  },
  {
    id: 'motion', group: 'blur', nameKey: 'filt_motion_blur', backend: 'gpu', space: 'linear',
    params: [P('angle', 'filt_p_angle', 0, 360, 1, 0), P('distance', 'filt_p_distance', 1, 120, 1, 14)],
    passes: v => motionPasses(v.angle, v.distance, 0),
  },
  {
    id: 'radial_spin', group: 'blur', nameKey: 'filt_radial_spin', backend: 'gpu', space: 'linear',
    params: [P('amount', 'filt_p_amount', 1, 100, 1, 24)],
    passes: v => radialPasses(v.amount, true),
  },
  {
    id: 'radial_zoom', group: 'blur', nameKey: 'filt_radial_zoom', backend: 'gpu', space: 'linear',
    params: [P('amount', 'filt_p_amount', 1, 100, 1, 24)],
    passes: v => radialPasses(v.amount, false),
  },
  {
    id: 'average', group: 'blur', nameKey: 'filt_average', backend: 'gpu', space: 'linear',
    params: [],
    passes: (_v, w, h) => averagePasses(w, h),
  },

  // ── sharpen ────────────────────────────────────────────────────────────────
  {
    id: 'sharpen', group: 'sharpen', nameKey: 'filt_sharpen', backend: 'gpu', space: 'perceptual',
    params: [],
    passes: () => unsharpPasses({ amount: 0.8, radius: 1.5 }),
  },
  {
    id: 'sharpen_more', group: 'sharpen', nameKey: 'filt_sharpen_more', backend: 'gpu', space: 'perceptual',
    params: [],
    passes: () => unsharpPasses({ amount: 1.6, radius: 1.5 }),
  },
  {
    id: 'unsharp', group: 'sharpen', nameKey: 'filt_unsharp', backend: 'gpu', space: 'perceptual',
    params: [
      P('amount', 'filt_p_amount_pct', 0, 500, 5, 100),
      P('radius', 'filt_p_radius', 0.5, 20, 0.5, 2),
      P('threshold', 'filt_p_threshold', 0, 255, 1, 0),   // new: Photoshop has it
    ],
    passes: v => unsharpPasses({ amount: v.amount / 100, radius: v.radius, threshold: (v.threshold ?? 0) / 255 }),
  },
  {
    id: 'highpass', group: 'sharpen', nameKey: 'filt_high_pass', backend: 'gpu', space: 'perceptual',
    params: [P('radius', 'filt_p_radius', 0.5, 50, 0.5, 3)],
    passes: v => highPassPasses(v.radius),
  },

  // ── noise ──────────────────────────────────────────────────────────────────
  {
    id: 'add_noise', group: 'noise', nameKey: 'filt_add_noise', backend: 'gpu', space: 'perceptual',
    params: [P('amount', 'filt_p_amount', 1, 200, 1, 40)],
    passes: v => noisePasses({ amount: v.amount, monochromatic: false }),
  },
  {
    id: 'add_noise_m', group: 'noise', nameKey: 'filt_add_noise_mono', backend: 'gpu', space: 'perceptual',
    params: [P('amount', 'filt_p_amount', 1, 200, 1, 40)],
    passes: v => noisePasses({ amount: v.amount, monochromatic: true }),
  },
  {
    id: 'median', group: 'noise', nameKey: 'filt_median', backend: 'worker', space: 'perceptual',
    params: [P('radius', 'filt_p_radius', 1, 10, 1, 2)], reason: WHY.sort,
  },
  {
    id: 'despeckle', group: 'noise', nameKey: 'filt_despeckle', backend: 'worker', space: 'perceptual',
    params: [], reason: WHY.sort + '; radius 1 (9 elements) IS portable as a sorting network — candidate for a GPU fast path',
  },
  {
    id: 'dust', group: 'noise', nameKey: 'filt_dust', backend: 'worker', space: 'perceptual',
    params: [], reason: WHY.median,
  },

  // ── distort ────────────────────────────────────────────────────────────────
  {
    id: 'pinch', group: 'distort', nameKey: 'filt_pinch', backend: 'gpu', space: 'linear',
    params: [P('amount', 'filt_p_amount_pct', 10, 300, 5, 60)],
    passes: v => distortPasses('pinch', v.amount / 100),
  },
  {
    id: 'spherize', group: 'distort', nameKey: 'filt_spherize', backend: 'gpu', space: 'linear',
    params: [P('amount', 'filt_p_amount_pct', -100, 100, 5, 60)],
    passes: v => distortPasses('spherize', v.amount / 100),
  },
  {
    id: 'twirl', group: 'distort', nameKey: 'filt_twirl', backend: 'gpu', space: 'linear',
    params: [P('angle', 'filt_p_angle', -720, 720, 5, 120)],
    passes: v => distortPasses('twirl', v.angle),
  },
  {
    id: 'ripple', group: 'distort', nameKey: 'filt_ripple', backend: 'gpu', space: 'linear',
    params: [P('amount', 'filt_p_amount', 1, 40, 1, 6), P('size', 'filt_p_size', 4, 80, 1, 18)],
    passes: v => distortPasses('ripple', v.amount, v.size),
  },
  {
    id: 'wave', group: 'distort', nameKey: 'filt_wave', backend: 'gpu', space: 'linear',
    params: [P('amplitude', 'filt_p_amplitude', 1, 60, 1, 12), P('wavelength', 'filt_p_wavelength', 10, 300, 5, 90)],
    passes: v => distortPasses('wave', v.amplitude, v.wavelength),
  },
  {
    id: 'zigzag', group: 'distort', nameKey: 'filt_zigzag', backend: 'gpu', space: 'linear',
    params: [P('amount', 'filt_p_amount', 1, 40, 1, 8)],
    passes: v => distortPasses('zigzag', v.amount),
  },
  {
    id: 'polar', group: 'distort', nameKey: 'filt_polar', backend: 'gpu', space: 'linear',
    params: [], passes: () => distortPasses('polar', 0),
  },

  // ── pixelate ───────────────────────────────────────────────────────────────
  {
    id: 'mosaic', group: 'pixelate', nameKey: 'filt_mosaic', backend: 'gpu', space: 'linear',
    params: [P('cell', 'filt_p_cell', 2, 100, 1, 12)],
    passes: v => mosaicPasses(v.cell),
  },
  {
    id: 'crystallize', group: 'pixelate', nameKey: 'filt_crystallize', backend: 'worker', space: 'perceptual',
    params: [P('cell', 'filt_p_cell', 4, 120, 1, 16)], reason: WHY.voronoi,
  },
  {
    id: 'pointillize', group: 'pixelate', nameKey: 'filt_pointillize', backend: 'worker', space: 'perceptual',
    params: [P('cell', 'filt_p_cell', 4, 80, 1, 12)], reason: WHY.voronoi,
  },
  {
    id: 'halftone', group: 'pixelate', nameKey: 'filt_color_halftone', backend: 'gpu', space: 'perceptual',
    params: [P('dot', 'filt_p_dot', 3, 40, 1, 8)],
    passes: v => halftonePasses(v.dot, 'color'),
  },
  {
    id: 'fragment', group: 'pixelate', nameKey: 'filt_fragment', backend: 'gpu', space: 'linear',
    params: [], passes: () => fragmentPasses(4),
  },

  // ── stylize ────────────────────────────────────────────────────────────────
  {
    id: 'emboss', group: 'stylize', nameKey: 'filt_emboss', backend: 'gpu', space: 'perceptual',
    params: [], passes: () => convolve3Passes(EMBOSS_KERNEL, 1, 128 / 255, false),
  },
  {
    id: 'find_edges', group: 'stylize', nameKey: 'filt_find_edges', backend: 'gpu', space: 'perceptual',
    params: [], passes: () => findEdgesPasses(false),
  },
  {
    id: 'solarize', group: 'stylize', nameKey: 'filt_solarize', backend: 'gpu', space: 'perceptual',
    params: [], passes: () => solarizePasses(),
  },
  {
    id: 'trace', group: 'stylize', nameKey: 'filt_trace_contour', backend: 'gpu', space: 'perceptual',
    params: [P('level', 'filt_p_level', 1, 254, 1, 128)],
    passes: v => traceContourPasses(v.level / 255),
  },
  {
    id: 'wind', group: 'stylize', nameKey: 'filt_wind', backend: 'worker', space: 'perceptual',
    params: [], reason: WHY.sequential,
  },
  {
    id: 'diffuse', group: 'stylize', nameKey: 'filt_diffuse', backend: 'gpu', space: 'linear',
    params: [], passes: () => diffusePasses(3),
  },
  {
    id: 'oil', group: 'stylize', nameKey: 'filt_oil_paint', backend: 'worker', space: 'perceptual',
    params: [P('radius', 'filt_p_radius', 1, 8, 1, 4)], reason: WHY.histogram,
  },

  // ── render ─────────────────────────────────────────────────────────────────
  {
    id: 'clouds', group: 'render', nameKey: 'filt_clouds', backend: 'gpu', space: 'perceptual',
    params: [], passes: () => cloudsPasses([1, 1, 1], [40 / 255, 90 / 255, 160 / 255], false),
  },
  {
    id: 'diff_clouds', group: 'render', nameKey: 'filt_diff_clouds', backend: 'gpu', space: 'perceptual',
    params: [], passes: () => cloudsPasses([1, 1, 1], [0, 0, 0], true),
  },
  {
    id: 'fibers', group: 'render', nameKey: 'filt_fibers', backend: 'gpu', space: 'perceptual',
    params: [], passes: () => fibersPasses(),
  },
  {
    id: 'lens_flare', group: 'render', nameKey: 'filt_lens_flare', backend: 'gpu', space: 'perceptual',
    params: [], passes: () => lensFlarePasses(),
  },

  // ── artistic ───────────────────────────────────────────────────────────────
  {
    id: 'poster_edges', group: 'artistic', nameKey: 'filt_poster_edges', backend: 'gpu', space: 'perceptual',
    params: [], passes: () => posterEdgesPasses(6),
  },
  {
    id: 'cutout', group: 'artistic', nameKey: 'filt_cutout', backend: 'hybrid', space: 'perceptual',
    params: [P('levels', 'filt_p_levels', 2, 12, 1, 5)], reason: WHY.median,
  },
  {
    id: 'watercolor', group: 'artistic', nameKey: 'filt_watercolor', backend: 'hybrid', space: 'perceptual',
    params: [], reason: WHY.median,
  },
  {
    id: 'sponge', group: 'artistic', nameKey: 'filt_sponge', backend: 'hybrid', space: 'perceptual',
    params: [], reason: WHY.median,
  },
  {
    id: 'dry_brush', group: 'artistic', nameKey: 'filt_dry_brush', backend: 'hybrid', space: 'perceptual',
    params: [], reason: WHY.median,
  },
  {
    id: 'film_grain', group: 'artistic', nameKey: 'filt_film_grain', backend: 'gpu', space: 'perceptual',
    params: [P('amount', 'filt_p_amount', 1, 100, 1, 28)],
    passes: v => noisePasses({ amount: v.amount, monochromatic: true, grain: 1 }),
  },

  // ── sketch ─────────────────────────────────────────────────────────────────
  {
    id: 'photocopy', group: 'sketch', nameKey: 'filt_photocopy', backend: 'gpu', space: 'perceptual',
    params: [], passes: () => photocopyPasses(3),
  },
  {
    id: 'stamp', group: 'sketch', nameKey: 'filt_stamp', backend: 'gpu', space: 'perceptual',
    params: [P('level', 'filt_p_level', 1, 254, 1, 128)],
    passes: v => stampPasses(v.level / 255, 2),
  },
  {
    id: 'bas_relief', group: 'sketch', nameKey: 'filt_bas_relief', backend: 'gpu', space: 'perceptual',
    params: [], passes: () => basReliefPasses(),
  },
  {
    id: 'chalk', group: 'sketch', nameKey: 'filt_chalk_charcoal', backend: 'gpu', space: 'perceptual',
    params: [], passes: () => chalkPasses(),
  },
  {
    id: 'halftone_pat', group: 'sketch', nameKey: 'filt_halftone_pattern', backend: 'gpu', space: 'perceptual',
    params: [P('dot', 'filt_p_dot', 3, 40, 1, 6)],
    passes: v => halftonePasses(v.dot, 'pattern'),
  },
  {
    id: 'note_paper', group: 'sketch', nameKey: 'filt_note_paper', backend: 'gpu', space: 'perceptual',
    params: [], passes: () => notePaperPasses(),
  },

  // ── other ──────────────────────────────────────────────────────────────────
  {
    id: 'posterize', group: 'other', nameKey: 'filt_posterize', backend: 'gpu', space: 'perceptual',
    params: [P('levels', 'filt_p_levels', 2, 32, 1, 6)],
    passes: v => posterizePasses(v.levels),
  },
  {
    id: 'threshold', group: 'other', nameKey: 'filt_threshold', backend: 'gpu', space: 'perceptual',
    params: [P('level', 'filt_p_level', 1, 254, 1, 128)],
    passes: v => thresholdPasses(v.level / 255),
  },
  {
    id: 'maximum', group: 'other', nameKey: 'filt_maximum', backend: 'gpu', space: 'perceptual',
    params: [P('radius', 'filt_p_radius', 1, 10, 1, 2)],
    passes: v => morphologyPasses(v.radius, 'max'),
  },
  {
    id: 'minimum', group: 'other', nameKey: 'filt_minimum', backend: 'gpu', space: 'perceptual',
    params: [P('radius', 'filt_p_radius', 1, 10, 1, 2)],
    passes: v => morphologyPasses(v.radius, 'min'),
  },
  {
    id: 'offset', group: 'other', nameKey: 'filt_offset', backend: 'gpu', space: 'linear',
    params: [P('x', 'filt_p_x', -500, 500, 1, 40), P('y', 'filt_p_y', -500, 500, 1, 40)],
    passes: v => offsetPasses(v.x, v.y),
  },
]

const BY_ID = new Map(GPU_FILTERS.map(f => [f.id, f]))

export function findGpuFilter(id: string): GpuFilterDef | undefined { return BY_ID.get(id) }

export function filtersByBackend(backend: GpuFilterDef['backend']): readonly GpuFilterDef[] {
  return GPU_FILTERS.filter(f => f.backend === backend)
}

/** Filters the worker pool must implement, with the reason each is not portable. */
export function nonPortableFilters(): readonly { id: string; backend: 'worker' | 'hybrid'; reason: string }[] {
  return GPU_FILTERS
    .filter(f => f.backend !== 'gpu')
    .map(f => ({ id: f.id, backend: f.backend as 'worker' | 'hybrid', reason: f.reason ?? 'unspecified' }))
}

/** Coverage counters — used by `inventory.md` and by the diagnostics panel. */
export function filterCoverage(): { total: number; gpu: number; worker: number; hybrid: number } {
  return {
    total: GPU_FILTERS.length,
    gpu: GPU_FILTERS.filter(f => f.backend === 'gpu').length,
    worker: GPU_FILTERS.filter(f => f.backend === 'worker').length,
    hybrid: GPU_FILTERS.filter(f => f.backend === 'hybrid').length,
  }
}
