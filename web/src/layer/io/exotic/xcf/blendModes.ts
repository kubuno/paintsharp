// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `GimpLayerMode` -> Layer blend vocabulary. Derived from GIMP's pdb/enums.pl and
// app/xcf/xcf-load.c (the OVERLAY_LEGACY remap), Copyright (C) 1995 Spencer Kimball and
// Peter Mattis and the GIMP contributors, licensed GPL-3.0-or-later. Reimplemented in
// TypeScript for Kubuno (AGPL-3.0-or-later).
//
// Layer's own vocabulary lives in `layer/blend/modes.ts` (28 entries) and its reference
// maths in `layer/blend/formulas.ts` — themselves reimplemented from the same GIMP
// sources. Most GIMP modes therefore map one-to-one; the ones that do not are flagged
// `approximated`, which the importer aggregates into a single warning.

import type { BlendMode } from '../types'

interface ModeMapping {
  readonly mode: BlendMode
  /** True when Layer's mode is visually close but not the same formula. */
  readonly approximated: boolean
  /** GIMP's own identifier, for the warning message and for provenance. */
  readonly gimpName: string
}

function exact(mode: BlendMode, gimpName: string): ModeMapping {
  return { mode, approximated: false, gimpName }
}

function approx(mode: BlendMode, gimpName: string): ModeMapping {
  return { mode, approximated: true, gimpName }
}

/**
 * The 64 `GimpLayerMode` values, indexed by their integer.
 *
 * Modes 0..22 are the `*_LEGACY` family of GIMP <= 2.8 (non-alpha-associated formulas
 * evaluated in non-linear sRGB); 23..63 are the GIMP 2.10+ modes. Since Layer composites
 * in sRGB-encoded space too (see the colour-space contract of `blend/formulas.ts`), the
 * legacy family is actually the *closer* match of the two.
 */
const MODES: readonly ModeMapping[] = [
  /* 0  */ exact('normal', 'NORMAL_LEGACY'),
  /* 1  */ exact('dissolve', 'DISSOLVE'),
  /* 2  */ approx('normal', 'BEHIND_LEGACY'),
  /* 3  */ exact('multiply', 'MULTIPLY_LEGACY'),
  /* 4  */ exact('screen', 'SCREEN_LEGACY'),
  // GIMP itself rewrites OVERLAY_LEGACY to SOFTLIGHT_LEGACY when loading: the legacy
  // "overlay" was a long-standing bug. Reproducing the remap is what makes the file look
  // the way GIMP shows it.
  /* 5  */ exact('soft-light', 'OVERLAY_LEGACY→SOFTLIGHT_LEGACY'),
  /* 6  */ exact('difference', 'DIFFERENCE_LEGACY'),
  /* 7  */ exact('linear-dodge', 'ADDITION_LEGACY'),
  /* 8  */ exact('subtract', 'SUBTRACT_LEGACY'),
  /* 9  */ exact('darken', 'DARKEN_ONLY_LEGACY'),
  /* 10 */ exact('lighten', 'LIGHTEN_ONLY_LEGACY'),
  /* 11 */ approx('hue', 'HSV_HUE_LEGACY'),
  /* 12 */ approx('saturation', 'HSV_SATURATION_LEGACY'),
  /* 13 */ approx('color', 'HSL_COLOR_LEGACY'),
  /* 14 */ approx('luminosity', 'HSV_VALUE_LEGACY'),
  /* 15 */ exact('divide', 'DIVIDE_LEGACY'),
  /* 16 */ exact('color-dodge', 'DODGE_LEGACY'),
  /* 17 */ exact('color-burn', 'BURN_LEGACY'),
  /* 18 */ exact('hard-light', 'HARDLIGHT_LEGACY'),
  /* 19 */ exact('soft-light', 'SOFTLIGHT_LEGACY'),
  // Grain extract is `cb - cs + 0.5`, grain merge `cb + cs - 0.5`: Layer has neither, so
  // they degrade to the same formula without the 0.5 pedestal.
  /* 20 */ approx('subtract', 'GRAIN_EXTRACT_LEGACY'),
  /* 21 */ approx('linear-dodge', 'GRAIN_MERGE_LEGACY'),
  /* 22 */ approx('normal', 'COLOR_ERASE_LEGACY'),
  /* 23 */ exact('overlay', 'OVERLAY'),
  /* 24 */ approx('hue', 'LCH_HUE'),
  /* 25 */ approx('saturation', 'LCH_CHROMA'),
  /* 26 */ approx('color', 'LCH_COLOR'),
  /* 27 */ approx('luminosity', 'LCH_LIGHTNESS'),
  /* 28 */ exact('normal', 'NORMAL'),
  /* 29 */ approx('normal', 'BEHIND'),
  /* 30 */ exact('multiply', 'MULTIPLY'),
  /* 31 */ exact('screen', 'SCREEN'),
  /* 32 */ exact('difference', 'DIFFERENCE'),
  /* 33 */ exact('linear-dodge', 'ADDITION'),
  /* 34 */ exact('subtract', 'SUBTRACT'),
  /* 35 */ exact('darken', 'DARKEN_ONLY'),
  /* 36 */ exact('lighten', 'LIGHTEN_ONLY'),
  /* 37 */ approx('hue', 'HSV_HUE'),
  /* 38 */ approx('saturation', 'HSV_SATURATION'),
  /* 39 */ approx('color', 'HSL_COLOR'),
  /* 40 */ approx('luminosity', 'HSV_VALUE'),
  /* 41 */ exact('divide', 'DIVIDE'),
  /* 42 */ exact('color-dodge', 'DODGE'),
  /* 43 */ exact('color-burn', 'BURN'),
  /* 44 */ exact('hard-light', 'HARDLIGHT'),
  /* 45 */ exact('soft-light', 'SOFTLIGHT'),
  /* 46 */ approx('subtract', 'GRAIN_EXTRACT'),
  /* 47 */ approx('linear-dodge', 'GRAIN_MERGE'),
  /* 48 */ exact('vivid-light', 'VIVID_LIGHT'),
  /* 49 */ exact('pin-light', 'PIN_LIGHT'),
  /* 50 */ exact('linear-light', 'LINEAR_LIGHT'),
  /* 51 */ exact('hard-mix', 'HARD_MIX'),
  /* 52 */ exact('exclusion', 'EXCLUSION'),
  /* 53 */ exact('linear-burn', 'LINEAR_BURN'),
  // GIMP's luma variants pick the whole pixel by luminance, which is what Photoshop's
  // darker/lighter colour does — but on BT.709 linear luma rather than BT.601 encoded.
  /* 54 */ approx('darker-color', 'LUMA_DARKEN_ONLY'),
  /* 55 */ approx('lighter-color', 'LUMA_LIGHTEN_ONLY'),
  /* 56 */ approx('luminosity', 'LUMINANCE'),
  /* 57 */ approx('normal', 'COLOR_ERASE'),
  /* 58 */ approx('normal', 'ERASE'),
  /* 59 */ approx('normal', 'MERGE'),
  /* 60 */ approx('normal', 'SPLIT'),
  /* 61 */ exact('pass-through', 'PASS_THROUGH'),
  /* 62 */ approx('normal', 'REPLACE'),
  /* 63 */ approx('normal', 'OVERWRITE'),
]

/** `GimpLayerMode` 61. Only meaningful on a group. */
export const GIMP_MODE_PASS_THROUGH = 61

export function mapBlendMode(gimpMode: number): ModeMapping {
  const hit = MODES[gimpMode]
  if (hit) return hit
  return { mode: 'normal', approximated: true, gimpName: `unknown(${gimpMode})` }
}

/**
 * `PROP_COMPOSITE_SPACE` / `PROP_BLEND_SPACE`: a negative value means "this was AUTO,
 * and here is what AUTO resolved to at write time" (`xcf-load.c`). Only the magnitude
 * matters to us, and only to detect a linear-light blend that our sRGB compositor will
 * render differently.
 */
export const GIMP_SPACE_RGB_LINEAR = 1

export function isLinearSpace(raw: number): boolean {
  return Math.abs(raw) === GIMP_SPACE_RGB_LINEAR
}
