// Stage 1 (GPU abstraction) — colour space: sRGB transfer functions, the linear
// premultiplied working space, and the real browser output-colour-space API.
//
// Working space, non negotiable (spec §4): LINEAR light, PREMULTIPLIED alpha,
// RGBA16F. Compositing `a·x + (1-a)·y` on sRGB-encoded values is mathematically
// wrong — the classic symptoms are mid-grey gradients that read too dark, dark
// haloes on antialiased edges, and downscales that darken.
//
// This mirrors GIMP's modern layer modes, which declare
// `composite_space = GIMP_LAYER_COLOR_SPACE_RGB_LINEAR`
// (app/operations/layer-modes/gimp-layer-modes.c); its *_LEGACY modes keep the
// non-linear space only for backwards compatibility with old XCF files.
// GIMP is GPLv3 — this is a reimplementation from the documented behaviour,
// not a copy of its code.
//
// ⚠️ Correction to a widespread claim, verified on Chrome 150 (2026-07-27):
// `canvas.getContext('webgl2', { colorSpace: 'display-p3' })` does NOT exist.
// The attribute is silently ignored and getContextAttributes() never echoes it,
// so the failure is invisible. The real knobs are the CONTEXT PROPERTIES
// `gl.drawingBufferColorSpace` and `gl.unpackColorSpace`, both verified present
// and assignable. `colorSpace` is a Canvas **2D** creation attribute only.

/** The engine's working transfer characteristic. Constant in P0. */
export const WORKING_TRC = 'linear' as const

// ── Scalar transfer functions (IEC 61966-2-1) ──────────────────────────────
// The `pow(c, 2.2)` approximation is deliberately NOT used: it is off by several
// 8-bit codes on the linear segment near black, which is visible in shadows.

/** sRGB EOTF: encoded [0,1] → linear light [0,1]. */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

/** sRGB OETF: linear light [0,1] → encoded [0,1]. */
export function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055
}

/**
 * 256-entry lookup table, encoded 8-bit → linear float. Built once; used for
 * CPU-side conversions of UI colours and of small 8-bit buffers where a GPU
 * pass would cost more than the conversion itself.
 */
let srgbLut: Float32Array | null = null
export function srgbToLinearLut(): Float32Array {
  if (!srgbLut) {
    const t = new Float32Array(256)
    for (let i = 0; i < 256; i++) t[i] = srgbToLinear(i / 255)
    srgbLut = t
  }
  return srgbLut
}

/** Linear float → nearest encoded 8-bit code. */
export function linearToSrgbU8(c: number): number {
  const e = linearToSrgb(c <= 0 ? 0 : c >= 1 ? 1 : c)
  return Math.max(0, Math.min(255, Math.round(e * 255)))
}

// ── UI colours ─────────────────────────────────────────────────────────────

/**
 * `#rgb` / `#rrggbb` / `#rrggbbaa` → linear premultiplied RGBA, i.e. exactly
 * what the working space stores. This is entry point ① of spec §4.2 for
 * interface colours: converted once, on the CPU, at colour-pick time.
 */
export function hexToLinearPremultiplied(hex: string, alpha = 1): Float32Array {
  const s = hex.replace('#', '')
  const expand = s.length === 3 || s.length === 4
  const at = (i: number): number => {
    const v = expand ? s[i]! + s[i]! : s.slice(i * 2, i * 2 + 2)
    return parseInt(v, 16) / 255
  }
  const a = (s.length === 4 || s.length === 8 ? at(3) : 1) * alpha
  return new Float32Array([
    srgbToLinear(at(0)) * a,
    srgbToLinear(at(1)) * a,
    srgbToLinear(at(2)) * a,
    a,
  ])
}

// ── Straight ↔ premultiplied ───────────────────────────────────────────────
// Conversions live at the boundaries only (upload, export, readback). Inside the
// working space everything is premultiplied, so `source-over` is a plain
// `c = src + dst·(1-src.a)`: no division, no `a < eps` branch, and bilinear
// filtering / 2×2 LOD reduction become correct by construction.

/** In-place straight → premultiplied on an interleaved RGBA float buffer. */
export function premultiplyInPlace(rgba: Float32Array): Float32Array {
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3]!
    rgba[i] = rgba[i]! * a
    rgba[i + 1] = rgba[i + 1]! * a
    rgba[i + 2] = rgba[i + 2]! * a
  }
  return rgba
}

/** In-place premultiplied → straight on an interleaved RGBA float buffer. */
export function unpremultiplyInPlace(rgba: Float32Array): Float32Array {
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3]!
    if (a > 0) {
      rgba[i] = rgba[i]! / a
      rgba[i + 1] = rgba[i + 1]! / a
      rgba[i + 2] = rgba[i + 2]! / a
    } else {
      rgba[i] = 0; rgba[i + 1] = 0; rgba[i + 2] = 0
    }
  }
  return rgba
}

/**
 * 8-bit sRGB straight RGBA → float linear premultiplied RGBA.
 * The reference CPU implementation of pipeline entry ① (spec §4.2); the GPU
 * path in the upload shader must agree with it bit-for-bit within 1e-5.
 */
export function srgbU8ToLinearPremultiplied(src: Uint8Array | Uint8ClampedArray): Float32Array {
  const lut = srgbToLinearLut()
  const out = new Float32Array(src.length)
  for (let i = 0; i < src.length; i += 4) {
    const a = src[i + 3]! / 255
    out[i] = lut[src[i]!]! * a
    out[i + 1] = lut[src[i + 1]!]! * a
    out[i + 2] = lut[src[i + 2]!]! * a
    out[i + 3] = a
  }
  return out
}

/** Float linear premultiplied RGBA → 8-bit sRGB straight RGBA (pipeline exit ②). */
export function linearPremultipliedToSrgbU8(src: Float32Array): Uint8Array {
  const out = new Uint8Array(src.length)
  for (let i = 0; i < src.length; i += 4) {
    const a = src[i + 3]!
    const inv = a > 0 ? 1 / a : 0
    out[i] = linearToSrgbU8(src[i]! * inv)
    out[i + 1] = linearToSrgbU8(src[i + 1]! * inv)
    out[i + 2] = linearToSrgbU8(src[i + 2]! * inv)
    out[i + 3] = Math.max(0, Math.min(255, Math.round(a * 255)))
  }
  return out
}

// ── Browser output colour space ────────────────────────────────────────────

/** Structural view of the two context properties that actually exist. */
interface ColorSpaceCapable {
  drawingBufferColorSpace: PredefinedColorSpace
  unpackColorSpace: PredefinedColorSpace
}

export interface OutputColorSpaceResult {
  /** Colour space the drawing buffer ended up in (read back, not assumed). */
  readonly drawingBuffer: PredefinedColorSpace
  /** true when the browser exposes drawingBufferColorSpace at all. */
  readonly supported: boolean
}

/**
 * Configure the output colour space. P0 stays on sRGB; `wide` is the P1 hook.
 *
 * NOTE: there is no `colorSpace` WebGL context attribute — see the file header.
 * The assignment is also read back, because an unsupported value is allowed to
 * be ignored rather than to throw.
 */
export function configureOutputColorSpace(
  gl: WebGL2RenderingContext,
  wide = false,
): OutputColorSpaceResult {
  if (!('drawingBufferColorSpace' in gl)) {
    return { drawingBuffer: 'srgb', supported: false }
  }
  const c = gl as unknown as ColorSpaceCapable
  try {
    c.drawingBufferColorSpace = wide ? 'display-p3' : 'srgb'
  } catch {
    /* unsupported value → the browser keeps sRGB */
  }
  if ('unpackColorSpace' in gl) {
    // We linearise ourselves in the upload shader; the browser must not also
    // convert uploaded images behind our back.
    try { c.unpackColorSpace = 'srgb' } catch { /* ignore */ }
  }
  return { drawingBuffer: c.drawingBufferColorSpace, supported: true }
}

/**
 * Whether the display covers the P3 gamut. This is the only reliable screen
 * information available to a web page: no browser API exposes the monitor's ICC
 * profile, so an exact colorimetric conversion to the screen is impossible.
 */
export function displayIsWideGamut(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(color-gamut: p3)').matches
}

// ── GLSL chunks ────────────────────────────────────────────────────────────
// Shared source, injected by GLDevice into every program so that stage 2/3/4
// shaders never re-derive these formulas (the current engine has three
// divergent copies of the sRGB curve).

/** sRGB EOTF/OETF + premultiplied helpers. Prefix `kb`, to avoid collisions. */
export const GLSL_COLOR_SPACE = `
// sRGB EOTF (encoded -> linear). IEC 61966-2-1. The mix/step form keeps the
// linear segment near black, which pow(c,2.2) gets wrong by several 8-bit codes.
vec3 kbSrgbToLinear(vec3 c) {
  return mix(c / 12.92,
             pow((c + 0.055) / 1.055, vec3(2.4)),
             step(vec3(0.04045), c));
}
// sRGB OETF (linear -> encoded).
vec3 kbLinearToSrgb(vec3 c) {
  return mix(c * 12.92,
             1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055,
             step(vec3(0.0031308), c));
}
// Straight sRGB RGBA -> linear premultiplied RGBA. Pipeline entry (1).
vec4 kbToWorking(vec4 c) {
  return vec4(kbSrgbToLinear(c.rgb) * c.a, c.a);
}
// Linear premultiplied RGBA -> straight sRGB RGBA. Pipeline exit (2).
vec4 kbFromWorking(vec4 c) {
  float a = c.a;
  vec3 straight = a > 0.0 ? c.rgb / a : vec3(0.0);
  return vec4(kbLinearToSrgb(straight), a);
}
`

/**
 * Ordered dithering for the RGBA8 fallback working format (spec §4.5).
 * Applied AT STORE TIME, never at display time: the fallback stores LINEAR
 * values in 8 bits, where the shadows would otherwise band badly.
 * Amplitude is exactly one 8-bit code.
 */
export const GLSL_DITHER = `
const float KB_BAYER8[64] = float[64](
   0.0, 32.0,  8.0, 40.0,  2.0, 34.0, 10.0, 42.0,
  48.0, 16.0, 56.0, 24.0, 50.0, 18.0, 58.0, 26.0,
  12.0, 44.0,  4.0, 36.0, 14.0, 46.0,  6.0, 38.0,
  60.0, 28.0, 52.0, 20.0, 62.0, 30.0, 54.0, 22.0,
   3.0, 35.0, 11.0, 43.0,  1.0, 33.0,  9.0, 41.0,
  51.0, 19.0, 59.0, 27.0, 49.0, 17.0, 57.0, 25.0,
  15.0, 47.0,  7.0, 39.0, 13.0, 45.0,  5.0, 37.0,
  63.0, 31.0, 55.0, 23.0, 61.0, 29.0, 53.0, 21.0);

// Signed dither offset in [-0.5, 0.5) codes, from the screen-space position.
float kbBayer(vec2 p) {
  ivec2 i = ivec2(mod(p, 8.0));
  return (KB_BAYER8[i.y * 8 + i.x] + 0.5) / 64.0 - 0.5;
}
// No-op when the working format has float precision; the device #defines
// KB_DITHER only on the RGBA8 fallback path.
vec4 kbDitherStore(vec4 c, vec2 fragCoord) {
#ifdef KB_DITHER
  return c + kbBayer(fragCoord) * (1.0 / 255.0);
#else
  return c;
#endif
}
`
