// Blend-mode registry — the single source of truth for the Layer sub-module.
//
// Attribution
// -----------
// The blend formulas this table indexes are reimplemented in TypeScript from
// GIMP's `app/operations/layer-modes/gimpoperationlayermode-blend.c`,
// `gimpoperationlayermode-composite.c` and `gimpoperationdissolve.c`
// (Copyright (C) GIMP developers, GPLv3+). Kubuno is AGPLv3, which is
// compatible. Where GIMP deliberately diverges from Photoshop (`soft-light`,
// the luma coefficients of the component modes), the normative reference is the
// public PDF 1.7 specification §11.3.5 / the public PSD file-format
// documentation, because PSD parity is a hard requirement of this module.
//
// This file carries *metadata only* (identifiers, PSD keys, i18n keys, menu
// category, separability, shader integer). The reference math lives in
// `./formulas.ts`, the GLSL in `./glsl.ts`; both key off the identifiers below.

/**
 * Stable blend-mode identifiers. 27 layer modes + `pass-through`, which is a
 * 28th entry reserved for *groups* (it is not a per-pixel blend function).
 *
 * The order is the Photoshop menu order; the UI inserts separators between
 * consecutive entries of different `category`.
 */
export const BLEND_MODES = [
  // Normal
  'normal', 'dissolve',
  // Darken
  'darken', 'multiply', 'color-burn', 'linear-burn', 'darker-color',
  // Lighten
  'lighten', 'screen', 'color-dodge', 'linear-dodge', 'lighter-color',
  // Contrast
  'overlay', 'soft-light', 'hard-light', 'vivid-light', 'linear-light',
  'pin-light', 'hard-mix',
  // Comparative
  'difference', 'exclusion', 'subtract', 'divide',
  // Component (non-separable)
  'hue', 'saturation', 'color', 'luminosity',
  // Groups only
  'pass-through',
] as const

export type BlendMode = (typeof BLEND_MODES)[number]

/** Menu families, in Photoshop's order. `special` holds group-only entries. */
export type BlendCategory =
  | 'normal'
  | 'darken'
  | 'lighten'
  | 'contrast'
  | 'comparative'
  | 'component'
  | 'special'

export const BLEND_CATEGORY_ORDER: readonly BlendCategory[] = [
  'special', 'normal', 'darken', 'lighten', 'contrast', 'comparative', 'component',
]

/** Alpha-composition operator (GIMP `gimpoperationlayermode-composite.c`). */
export type CompositeOp =
  /** `ar = as + ab(1 - as)` — the only operator Photoshop exposes. */
  | 'union'
  /** `ar = ab` — adjustment layers and clipping: cannot add nor remove opacity. */
  | 'clip-to-backdrop'
  /** `ar = as` — rarely used; inverted layer masks. */
  | 'clip-to-layer'
  /** `ar = ab * as` — reserved. */
  | 'intersection'

/** Integer the composite fragment shader switches on (`uMode`). */
export const COMPOSITE_OP_INT: Record<CompositeOp, number> = {
  union: 0,
  'clip-to-backdrop': 1,
  'clip-to-layer': 2,
  intersection: 3,
}

export interface BlendModeInfo {
  /** Stable identifier, persisted in documents. */
  readonly id: BlendMode
  /**
   * PSD four-character blend key (`'mul '`, `'lddg'`, …). Always 4 bytes,
   * trailing spaces included, exactly as written in the layer record.
   */
  readonly psdKey: string
  /** i18next key; matches the existing `layer_blend_*` namespace. */
  readonly i18nKey: string
  /** Menu family, used to place separators. */
  readonly category: BlendCategory
  /**
   * `false` when the blend function needs the whole RGB triple (the four
   * component modes plus `darker-color` / `lighter-color`).
   */
  readonly separable: boolean
  /** Integer passed to the shader as `uMode`. */
  readonly uMode: number
  /** `true` for `dissolve`: the mode acts on alpha, not on colour. */
  readonly stochastic?: boolean
  /** `true` for `pass-through`: selectable on groups only, never rendered. */
  readonly groupsOnly?: boolean
}

/**
 * `uMode` 10 is permanently reserved for the eraser-stroke composite path that
 * already exists in `layer/renderer/shaders.ts`. Never reuse it.
 */
export const ERASER_MODE_INT = 10

/**
 * Shader integers. Values 0..23 are inherited verbatim from
 * `layer/model/blend.ts` (`BLEND_INT`) and MUST NOT change — they are baked
 * into existing shader sources. New modes extend the range from 24 upwards.
 */
const U_MODE: Record<BlendMode, number> = {
  normal: 0,
  multiply: 1,
  screen: 2,
  overlay: 3,
  darken: 4,
  lighten: 5,
  difference: 6,
  'color-dodge': 7,
  'color-burn': 8,
  'soft-light': 9,
  // 10 = eraser (ERASER_MODE_INT)
  'hard-light': 11,
  'linear-dodge': 12,
  'linear-burn': 13,
  'vivid-light': 14,
  'linear-light': 15,
  'pin-light': 16,
  exclusion: 17,
  subtract: 18,
  divide: 19,
  hue: 20,
  saturation: 21,
  color: 22,
  luminosity: 23,
  // --- new in this module ---
  dissolve: 24,
  'darker-color': 25,
  'lighter-color': 26,
  'hard-mix': 27,
  'pass-through': 28,
}

interface RawDef {
  psdKey: string
  category: BlendCategory
  separable?: boolean
  stochastic?: boolean
  groupsOnly?: boolean
}

// PSD keys per the public "Photoshop File Formats" specification, section
// "Blend mode key" of the layer record.
const RAW: Record<BlendMode, RawDef> = {
  normal: { psdKey: 'norm', category: 'normal' },
  dissolve: { psdKey: 'diss', category: 'normal', stochastic: true },

  darken: { psdKey: 'dark', category: 'darken' },
  multiply: { psdKey: 'mul ', category: 'darken' },
  'color-burn': { psdKey: 'idiv', category: 'darken' },
  'linear-burn': { psdKey: 'lbrn', category: 'darken' },
  'darker-color': { psdKey: 'dkCl', category: 'darken', separable: false },

  lighten: { psdKey: 'lite', category: 'lighten' },
  screen: { psdKey: 'scrn', category: 'lighten' },
  'color-dodge': { psdKey: 'div ', category: 'lighten' },
  'linear-dodge': { psdKey: 'lddg', category: 'lighten' },
  'lighter-color': { psdKey: 'lgCl', category: 'lighten', separable: false },

  overlay: { psdKey: 'over', category: 'contrast' },
  'soft-light': { psdKey: 'sLit', category: 'contrast' },
  'hard-light': { psdKey: 'hLit', category: 'contrast' },
  'vivid-light': { psdKey: 'vLit', category: 'contrast' },
  'linear-light': { psdKey: 'lLit', category: 'contrast' },
  'pin-light': { psdKey: 'pLit', category: 'contrast' },
  'hard-mix': { psdKey: 'hMix', category: 'contrast' },

  difference: { psdKey: 'diff', category: 'comparative' },
  // Not a typo: Photoshop writes Exclusion as 'smud'.
  exclusion: { psdKey: 'smud', category: 'comparative' },
  subtract: { psdKey: 'fsub', category: 'comparative' },
  divide: { psdKey: 'fdiv', category: 'comparative' },

  hue: { psdKey: 'hue ', category: 'component', separable: false },
  saturation: { psdKey: 'sat ', category: 'component', separable: false },
  color: { psdKey: 'colr', category: 'component', separable: false },
  luminosity: { psdKey: 'lum ', category: 'component', separable: false },

  'pass-through': { psdKey: 'pass', category: 'special', groupsOnly: true },
}

/** i18n key for a mode id: `color-burn` → `layer_blend_color_burn`. */
const i18nKeyFor = (id: BlendMode): string => `layer_blend_${id.replace(/-/g, '_')}`

export const BLEND_MODE_TABLE: Record<BlendMode, BlendModeInfo> = Object.fromEntries(
  BLEND_MODES.map((id) => {
    const raw = RAW[id]
    const info: BlendModeInfo = {
      id,
      psdKey: raw.psdKey,
      i18nKey: i18nKeyFor(id),
      category: raw.category,
      separable: raw.separable !== false,
      uMode: U_MODE[id],
      ...(raw.stochastic ? { stochastic: true } : {}),
      ...(raw.groupsOnly ? { groupsOnly: true } : {}),
    }
    return [id, info]
  }),
) as Record<BlendMode, BlendModeInfo>

/** Menu order (Photoshop), `pass-through` first as in the groups menu. */
export const BLEND_MODE_LIST: readonly BlendModeInfo[] = BLEND_MODES.map(
  (id) => BLEND_MODE_TABLE[id],
)

/** Modes selectable on a non-group layer. */
export const LAYER_BLEND_MODES: readonly BlendMode[] = BLEND_MODES.filter(
  (id) => !BLEND_MODE_TABLE[id].groupsOnly,
)

export const BLEND_UMODE: Record<BlendMode, number> = U_MODE

const BY_UMODE = new Map<number, BlendMode>(
  BLEND_MODES.map((id) => [U_MODE[id], id]),
)
const BY_PSD_KEY = new Map<string, BlendMode>(
  BLEND_MODES.map((id) => [RAW[id].psdKey, id]),
)

const isBlendMode = (v: string): v is BlendMode =>
  Object.prototype.hasOwnProperty.call(RAW, v)

/** Narrowing helper for values read back from documents / the network. */
export function asBlendMode(v: string | null | undefined, fallback: BlendMode = 'normal'): BlendMode {
  return typeof v === 'string' && isBlendMode(v) ? v : fallback
}

/** PSD import. The key is padded/truncated to 4 chars, as PSD mandates. */
export function blendModeFromPsdKey(key: string): BlendMode | null {
  return BY_PSD_KEY.get(key.padEnd(4, ' ').slice(0, 4)) ?? null
}

/** PSD export. */
export function psdKeyOf(mode: BlendMode): string {
  return BLEND_MODE_TABLE[mode].psdKey
}

export function blendModeFromUMode(uMode: number): BlendMode | null {
  return BY_UMODE.get(uMode) ?? null
}

export function isSeparable(mode: BlendMode): boolean {
  return BLEND_MODE_TABLE[mode].separable
}

/** Groups modes by menu family, preserving `BLEND_MODES` order inside a family. */
export function blendModesByCategory(
  includeGroupsOnly = false,
): { category: BlendCategory; modes: BlendModeInfo[] }[] {
  const out: { category: BlendCategory; modes: BlendModeInfo[] }[] = []
  for (const category of BLEND_CATEGORY_ORDER) {
    const modes = BLEND_MODE_LIST.filter(
      (m) => m.category === category && (includeGroupsOnly || !m.groupsOnly),
    )
    if (modes.length > 0) out.push({ category, modes })
  }
  return out
}
