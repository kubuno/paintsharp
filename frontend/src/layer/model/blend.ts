// Blend-mode vocabulary shared by the renderer, the layers panel and the menus.
//
// `BLEND_INT` maps a mode key to the integer the compositing fragment shader
// switches on (`uMode`). Extracted verbatim from LayerEditorPage during the
// layer/ refactor — no behavioural change.
import type { TFunction } from 'i18next'

export const BLEND_INT: Record<string, number> = {
  // 10 is reserved internally for the eraser stroke compositing.
  normal: 0, multiply: 1, screen: 2, overlay: 3,
  darken: 4, lighten: 5, difference: 6, 'color-dodge': 7, 'color-burn': 8, 'soft-light': 9,
  'hard-light': 11, 'linear-dodge': 12, 'linear-burn': 13, 'vivid-light': 14,
  'linear-light': 15, 'pin-light': 16, exclusion: 17, subtract: 18, divide: 19,
  hue: 20, saturation: 21, color: 22, luminosity: 23,
}

// Grouped like Photoshop's blend-mode menu; separators are inserted by the UI.
export const BLEND_KEYS = [
  'normal',
  'darken', 'multiply', 'color-burn', 'linear-burn',
  'lighten', 'screen', 'color-dodge', 'linear-dodge',
  'overlay', 'soft-light', 'hard-light', 'vivid-light', 'linear-light', 'pin-light',
  'difference', 'exclusion', 'subtract', 'divide',
  'hue', 'saturation', 'color', 'luminosity',
] as const

export const blendLabel = (t: TFunction, k: string): string => ({
  normal: t('layer_blend_normal'), multiply: t('layer_blend_multiply'),
  screen: t('layer_blend_screen'), overlay: t('layer_blend_overlay'),
  darken: t('layer_blend_darken'), lighten: t('layer_blend_lighten'),
  difference: t('layer_blend_difference'), 'color-dodge': t('layer_blend_color_dodge'),
  'color-burn': t('layer_blend_color_burn'), 'soft-light': t('layer_blend_soft_light'),
  'hard-light': t('layer_blend_hard_light'), 'linear-dodge': t('layer_blend_linear_dodge'),
  'linear-burn': t('layer_blend_linear_burn'), 'vivid-light': t('layer_blend_vivid_light'),
  'linear-light': t('layer_blend_linear_light'), 'pin-light': t('layer_blend_pin_light'),
  exclusion: t('layer_blend_exclusion'), subtract: t('layer_blend_subtract'),
  divide: t('layer_blend_divide'), hue: t('layer_blend_hue'),
  saturation: t('layer_blend_saturation'), color: t('layer_blend_color'),
  luminosity: t('layer_blend_luminosity'),
}[k] ?? k)
