// Shared Paintsharp editor theme.
// The colour-space conversions used to live here; they were promoted to the core
// UI layer (`@ui/color`) so every module can reuse them and the ColorPicker. We
// re-export them here unchanged so all existing Paintsharp imports keep working.

// ── Palette (Photoshop-style neutral grays, dense & professional) ───────────────
export const C = {
  bg:      '#1e1e1e',  // app / canvas backdrop
  panel:   '#323232',  // panel body — Photoshop "medium gray"
  toolbar: '#393939',  // tool dock, panel headers, tab strips
  header:  '#2b2b2b',  // top bar / options bar / status bar
  active:  '#454545',  // active tab / hover
  border:  '#212121',  // separators (dark)
  accent:  '#5a9bdc',  // restrained selection/active blue
  text:    '#d6d6d6',
  textDim: '#8e8e8e',
}

// ── Colour conversions — promoted to @ui, re-exported for Paintsharp back-compat ──────
export {
  hexToRgb, rgbToHex, rgbToHsl, hslToRgb, rgbToHsv, hsvToRgb, rgbToCmyk, cmykToRgb,
} from '@ui'
