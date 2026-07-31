// Non-destructive per-layer adjustments (brightness / contrast / saturation /
// hue / exposure, plus the invert & grayscale toggles).
// Extracted verbatim from LayerEditorPage during the layer/ refactor.
import { rgbToHsl, hslToRgb } from '../../ui'

export type Adjust = {
  brightness: number // -100..100
  contrast:   number // -100..100
  saturation: number // -100..100
  hue:        number // -180..180
  exposure:   number // -100..100
}

export const ADJUST_ZERO: Adjust = { brightness:0, contrast:0, saturation:0, hue:0, exposure:0 }

export function adjustIsZero(a: Adjust): boolean {
  return a.brightness===0 && a.contrast===0 && a.saturation===0 && a.hue===0 && a.exposure===0
}

/** Apply non-destructive adjustments to a fresh copy of src pixels. */
export function applyAdjustments(src: Uint8Array, a: Adjust, invert: boolean, grayscale: boolean): Uint8Array {
  const out = new Uint8Array(src.length)
  out.set(src)
  if (adjustIsZero(a) && !invert && !grayscale) return out

  const bright   = a.brightness * 2.55           // additive
  const contrast = (a.contrast/100) + 1           // multiplier around 0.5
  const expGain  = Math.pow(2, a.exposure/100)    // exposure stops-ish
  const satF     = (a.saturation/100) + 1
  const hueShift = a.hue
  const needHsl  = a.saturation !== 0 || a.hue !== 0

  for (let i = 0; i < out.length; i += 4) {
    if (out[i+3] === 0) continue // skip fully transparent
    let r = out[i], g = out[i+1], b = out[i+2]

    // exposure (multiplicative)
    if (a.exposure !== 0) { r *= expGain; g *= expGain; b *= expGain }
    // brightness (additive)
    if (a.brightness !== 0) { r += bright; g += bright; b += bright }
    // contrast (around mid-gray 128)
    if (a.contrast !== 0) {
      r = (r-128)*contrast + 128
      g = (g-128)*contrast + 128
      b = (b-128)*contrast + 128
    }
    // clamp before HSL
    r = r<0?0:r>255?255:r; g = g<0?0:g>255?255:g; b = b<0?0:b>255?255:b
    // saturation + hue via HSL
    if (needHsl) {
      const hsl = rgbToHsl(r, g, b)
      let h = hsl[0] + hueShift
      const s = Math.max(0, Math.min(1, hsl[1] * satF))
      const rgb = hslToRgb(h, s, hsl[2])
      r = rgb[0]; g = rgb[1]; b = rgb[2]
    }
    if (grayscale) {
      const y = 0.299*r + 0.587*g + 0.114*b
      r = g = b = y
    }
    if (invert) { r = 255-r; g = 255-g; b = 255-b }

    out[i]   = r<0?0:r>255?255:r
    out[i+1] = g<0?0:g>255?255:g
    out[i+2] = b<0?0:b>255?255:b
  }
  return out
}
