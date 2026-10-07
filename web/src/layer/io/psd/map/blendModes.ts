/*
 * PSD 4-character blend keys <-> Kubuno canonical blend names (spec §7.4).
 *
 * The PSD key table was derived from the GIMP PSD plug-in (file-psd),
 * Copyright 2007 John Marshall, licensed under the GNU General Public License
 * v3 or later — `layer_mode_map[]` and `descriptor_mode_map[]` in psd-util.c —
 * and from Adobe's public "Photoshop File Formats Specification".
 *
 * This is an independent TypeScript re-implementation; no GIMP source code was
 * copied. Kubuno is AGPLv3, compatible with the GPLv3 (GPLv3 §13).
 *
 * ⚠️ Classic mistakes this table does NOT make:
 *   - `smud` is Exclusion, not "Smudge".
 *   - `div ` is Color Dodge; `fdiv` is Divide. Two different modes.
 *   - `idiv` is Color Burn; `lbrn` is Linear Burn.
 *   - `Cdge` / `Cbrn` / `linR` do not exist. The lookalikes are `CDdg` / `CBrn`,
 *     which belong to the DESCRIPTOR enumeration set, not to Layer Records.
 */

export const PSD_TO_KUBUNO: Readonly<Record<string, string>> = {
  norm: 'normal',
  diss: 'dissolve',
  dark: 'darken',
  'mul ': 'multiply',
  idiv: 'color-burn',
  lbrn: 'linear-burn',
  dkCl: 'darker-color',
  lite: 'lighten',
  scrn: 'screen',
  'div ': 'color-dodge',
  lddg: 'linear-dodge',
  lgCl: 'lighter-color',
  over: 'overlay',
  sLit: 'soft-light',
  hLit: 'hard-light',
  vLit: 'vivid-light',
  lLit: 'linear-light',
  pLit: 'pin-light',
  hMix: 'hard-mix',
  diff: 'difference',
  smud: 'exclusion',
  fsub: 'subtract',
  fdiv: 'divide',
  'hue ': 'hue',
  'sat ': 'saturation',
  colr: 'color',
  'lum ': 'luminosity',
  pass: 'pass-through', // folders only
}

export const KUBUNO_TO_PSD: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(PSD_TO_KUBUNO).map(([k, v]) => [v, k]),
)

/**
 * Modes the Kubuno compositor cannot render yet (extension E4). They are mapped
 * to the nearest supported mode and reported so the import dialog can say so.
 */
const APPROXIMATIONS: Readonly<Record<string, string>> = {
  dissolve: 'normal',
  'darker-color': 'darken',
  'lighter-color': 'lighten',
  'hard-mix': 'hard-light',
  'pass-through': 'normal',
}

export interface BlendMapping {
  readonly mode: string
  /** Set when the mode had to be approximated or is unknown. */
  readonly warning: 'blend-mode-approximated' | 'blend-mode-unsupported' | null
  /** The original 4-character key, kept so an untouched layer round-trips. */
  readonly psdKey: string
}

/** Maps a PSD key to a Kubuno mode, degrading gracefully. */
export function psdBlendToKubuno(key: string): BlendMapping {
  const canonical = PSD_TO_KUBUNO[key]
  if (!canonical) return { mode: 'normal', warning: 'blend-mode-unsupported', psdKey: key }
  const approx = APPROXIMATIONS[canonical]
  if (approx) return { mode: approx, warning: 'blend-mode-approximated', psdKey: key }
  return { mode: canonical, warning: null, psdKey: key }
}

/**
 * Maps a Kubuno mode back to a PSD key. Every Kubuno mode has an exact PSD
 * equivalent, so this direction is lossless.
 */
export function kubunoBlendToPsd(mode: string): string {
  return KUBUNO_TO_PSD[mode] ?? 'norm'
}

/**
 * Blend enums used INSIDE descriptors (layer styles), which are a different
 * vocabulary from the 4-character record keys (spec §4.4.1).
 * `Lghn` is missing from GIMP's own table; it is added here.
 */
export const DESCRIPTOR_BLEND_TO_KUBUNO: Readonly<Record<string, string>> = {
  Nrml: 'normal',
  Dslv: 'dissolve',
  Bhnd: 'behind',
  Clar: 'clear',
  Mltp: 'multiply',
  Scrn: 'screen',
  Ovrl: 'overlay',
  SftL: 'soft-light',
  HrdL: 'hard-light',
  Drkn: 'darken',
  Lghn: 'lighten',
  Dfrn: 'difference',
  Xclu: 'exclusion',
  CDdg: 'color-dodge',
  CBrn: 'color-burn',
  'H   ': 'hue',
  Strt: 'saturation',
  'Clr ': 'color',
  Lmns: 'luminosity',
}
