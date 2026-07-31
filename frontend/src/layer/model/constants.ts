// Small shared constant tables for the Layer editor.
// Extracted verbatim from LayerEditorPage during the layer/ refactor.

/** Colour tags for organising the layers panel (label dot uses the same colour). */
export const LAYER_COLORS: { value: string; key: string; dot: string }[] = [
  { value: '#ef4444', key: 'layer_color_red',    dot: '🔴' },
  { value: '#f59e0b', key: 'layer_color_orange', dot: '🟠' },
  { value: '#eab308', key: 'layer_color_yellow', dot: '🟡' },
  { value: '#22c55e', key: 'layer_color_green',  dot: '🟢' },
  { value: '#3b82f6', key: 'layer_color_blue',   dot: '🔵' },
  { value: '#a855f7', key: 'layer_color_purple', dot: '🟣' },
]

/** Web-safe font families offered by the text tool. */
export const FONT_FAMILIES = [
  'Arial', 'Helvetica', 'Times New Roman', 'Georgia', 'Courier New',
  'Verdana', 'Trebuchet MS', 'Tahoma', 'Impact', 'Comic Sans MS',
]

/** Zoom presets offered by the status-bar zoom menu (fractions of 100%). */
export const ZOOM_PRESETS = [0.0625, 0.125, 0.25, 0.5, 0.66, 1, 1.5, 2, 3, 4, 8]
