// Catalogue of adjustment (and fill) layers, mirroring the menu Photoshop opens
// from the half-circle button at the bottom of the Layers panel.
//
// One table drives three things at once: the menu entries and their grouping,
// the default parameters a freshly created layer gets, and the uniforms the
// `FRAG_ADJUST` pass needs. Adding an adjustment means adding one row here.

/** Discriminator stored on the layer node, and the `uKind` the shader switches on. */
export type AdjustmentKind =
  | 'solid' | 'gradient' | 'pattern'
  | 'brightness-contrast' | 'levels' | 'curves' | 'exposure'
  | 'vibrance' | 'hue-saturation' | 'color-balance' | 'black-white'
  | 'photo-filter' | 'channel-mixer' | 'color-lookup'
  | 'invert' | 'posterize' | 'threshold' | 'gradient-map' | 'selective-color'

/** Parameters carried by an adjustment layer; only the relevant ones are used. */
export interface AdjustmentParams {
  /** Maps to the shader's `uP` vec4. */
  p: [number, number, number, number]
  /** Maps to the shader's `uColor` vec3, 0..1. */
  color: [number, number, number]
}

export interface AdjustmentDef {
  kind: AdjustmentKind
  /** i18n key of the menu entry. */
  labelKey: string
  /** `uKind` in FRAG_ADJUST. 0 = not rendered by the shader (not implemented). */
  uKind: number
  defaults: AdjustmentParams
  /** Menu group, in Photoshop's order; separators are drawn between groups. */
  group: 'fill' | 'tonal' | 'color' | 'mono'
  /** False while the editor cannot render it — the entry shows but stays disabled. */
  implemented: boolean
}

const P = (p: [number, number, number, number], color: [number, number, number] = [1, 1, 1]): AdjustmentParams =>
  ({ p, color })

export const ADJUSTMENT_DEFS: AdjustmentDef[] = [
  // ── Fill layers ───────────────────────────────────────────────────────────
  { kind: 'solid',    labelKey: 'layer_adj_solid',    uKind: 0, group: 'fill', implemented: false, defaults: P([0, 0, 0, 0], [0, 0, 0]) },
  { kind: 'gradient', labelKey: 'layer_adj_gradient', uKind: 0, group: 'fill', implemented: false, defaults: P([0, 0, 0, 0]) },
  { kind: 'pattern',  labelKey: 'layer_adj_pattern',  uKind: 0, group: 'fill', implemented: false, defaults: P([0, 0, 0, 0]) },

  // ── Tonal ─────────────────────────────────────────────────────────────────
  { kind: 'brightness-contrast', labelKey: 'layer_adj_brightness', uKind: 1,  group: 'tonal', implemented: true,  defaults: P([0, 0, 0, 0]) },
  { kind: 'levels',              labelKey: 'layer_adj_levels',     uKind: 10, group: 'tonal', implemented: true,  defaults: P([0, 1, 1, 0]) },
  { kind: 'curves',              labelKey: 'layer_adj_curves',     uKind: 0,  group: 'tonal', implemented: false, defaults: P([0, 0, 0, 0]) },
  { kind: 'exposure',            labelKey: 'layer_adj_exposure',   uKind: 2,  group: 'tonal', implemented: true,  defaults: P([0, 0, 0, 0]) },

  // ── Colour ────────────────────────────────────────────────────────────────
  { kind: 'vibrance',       labelKey: 'layer_adj_vibrance',       uKind: 4,  group: 'color', implemented: true,  defaults: P([0, 0, 0, 0]) },
  { kind: 'hue-saturation', labelKey: 'layer_adj_hue_sat',        uKind: 3,  group: 'color', implemented: true,  defaults: P([0, 0, 0, 0]) },
  { kind: 'color-balance',  labelKey: 'layer_adj_color_balance',  uKind: 11, group: 'color', implemented: true,  defaults: P([0, 0, 0, 0], [0, 0, 0]) },
  { kind: 'black-white',    labelKey: 'layer_adj_black_white',    uKind: 5,  group: 'color', implemented: true,  defaults: P([0, 0, 0, 0], [0.2126, 0.7152, 0.0722]) },
  { kind: 'photo-filter',   labelKey: 'layer_adj_photo_filter',   uKind: 9,  group: 'color', implemented: true,  defaults: P([0.25, 0, 0, 0], [0.92, 0.60, 0.16]) },
  { kind: 'channel-mixer',  labelKey: 'layer_adj_channel_mixer',  uKind: 0,  group: 'color', implemented: false, defaults: P([0, 0, 0, 0]) },
  { kind: 'color-lookup',   labelKey: 'layer_adj_color_lookup',   uKind: 0,  group: 'color', implemented: false, defaults: P([0, 0, 0, 0]) },

  // ── Monochrome / mapping ──────────────────────────────────────────────────
  { kind: 'invert',          labelKey: 'layer_adj_invert',          uKind: 6, group: 'mono', implemented: true,  defaults: P([0, 0, 0, 0]) },
  { kind: 'posterize',       labelKey: 'layer_adj_posterize',       uKind: 7, group: 'mono', implemented: true,  defaults: P([4, 0, 0, 0]) },
  { kind: 'threshold',       labelKey: 'layer_adj_threshold',       uKind: 8, group: 'mono', implemented: true,  defaults: P([0.5, 0, 0, 0]) },
  { kind: 'gradient-map',    labelKey: 'layer_adj_gradient_map',    uKind: 0, group: 'mono', implemented: false, defaults: P([0, 0, 0, 0]) },
  { kind: 'selective-color', labelKey: 'layer_adj_selective_color', uKind: 0, group: 'mono', implemented: false, defaults: P([0, 0, 0, 0]) },
]

export const ADJ_BY_KIND: Record<string, AdjustmentDef> =
  Object.fromEntries(ADJUSTMENT_DEFS.map(d => [d.kind, d]))

/** Shape stored in `LayerStructureItem.adjustment`. */
export interface AdjustmentValue extends AdjustmentParams {
  kind: AdjustmentKind
}

export const defaultAdjustment = (kind: AdjustmentKind): AdjustmentValue => {
  const def = ADJ_BY_KIND[kind]
  return { kind, p: [...def.defaults.p] as AdjustmentParams['p'], color: [...def.defaults.color] as AdjustmentParams['color'] }
}

/** Reads a node's adjustment value defensively — documents may predate this. */
export function readAdjustment(raw: unknown): AdjustmentValue | null {
  if (!raw || typeof raw !== 'object') return null
  const v = raw as Partial<AdjustmentValue>
  if (!v.kind || !ADJ_BY_KIND[v.kind]) return null
  const base = defaultAdjustment(v.kind)
  return {
    kind: v.kind,
    p: Array.isArray(v.p) && v.p.length === 4 ? v.p as AdjustmentParams['p'] : base.p,
    color: Array.isArray(v.color) && v.color.length === 3 ? v.color as AdjustmentParams['color'] : base.color,
  }
}
