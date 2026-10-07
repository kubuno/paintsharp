/*
 * PSD/PSB colour-mode conversion to non-premultiplied 8-bit sRGB RGBA (spec §2.4).
 *
 * The CMYK inversion rule and the Lab component ranges were derived from the
 * GIMP PSD plug-in (file-psd), Copyright 2007 John Marshall, GPLv3+
 * (psd-load.c), and from Adobe's public "Photoshop File Formats Specification";
 * the Lab -> XYZ -> sRGB maths uses published CIE / IEC formulae. Independent
 * TypeScript re-implementation; no GIMP source was copied. Kubuno is AGPLv3.
 */
import { allocBytes } from '../errors.ts'
import { COLOR_MODE } from '../constants.ts'
import type { PsdColorMode, PsdDepth, WarningSink } from '../types.ts'
import { expandTo8, linearToSrgb } from './depth.ts'

/** One decoded plane, already expanded to one byte per sample. */
export interface Plane {
  readonly id: number
  readonly data: Uint8Array
}

export interface ToRgbaOptions {
  readonly width: number
  readonly height: number
  readonly colorMode: PsdColorMode
  /** 768-byte palette for Indexed mode (256 R, then 256 G, then 256 B). */
  readonly palette?: Uint8Array | null
  /** Resource 1047 — the palette index that must become fully transparent. */
  readonly transparentIndex?: number | null
  /** Fills alpha with 255 when the source has no transparency channel. */
  readonly opaque?: boolean
}

/**
 * Assembles colour planes (+ optional alpha) into RGBA8.
 *
 * `planes` must be keyed by PSD channel id: 0..n for colour, -1 for alpha.
 * Missing colour planes are treated as zero, so a truncated file still yields a
 * usable image instead of an exception.
 */
export function planesToRgba8(
  planes: readonly Plane[],
  opts: ToRgbaOptions,
  sink: WarningSink,
): Uint8Array {
  const { width, height, colorMode } = opts
  const count = width * height
  const out = allocBytes(count * 4)
  if (count <= 0) return out

  const byId = new Map<number, Uint8Array>()
  for (const p of planes) byId.set(p.id, p.data)
  const alpha = byId.get(-1) ?? null
  const at = (plane: Uint8Array | undefined, i: number): number =>
    plane && i < plane.length ? plane[i] : 0

  switch (colorMode) {
    case COLOR_MODE.RGB: {
      const r = byId.get(0)
      const g = byId.get(1)
      const b = byId.get(2)
      for (let i = 0; i < count; i++) {
        out[i * 4] = at(r, i)
        out[i * 4 + 1] = at(g, i)
        out[i * 4 + 2] = at(b, i)
        out[i * 4 + 3] = alpha ? at(alpha, i) : 255
      }
      break
    }
    case COLOR_MODE.GRAYSCALE:
    case COLOR_MODE.DUOTONE:
    case COLOR_MODE.BITMAP:
    case COLOR_MODE.MULTICHANNEL: {
      // Duotone pixels are stored exactly like grayscale ones; the ink data in
      // Color Mode Data is preserved but never interpreted (spec §2.4).
      const g = byId.get(0)
      for (let i = 0; i < count; i++) {
        const v = at(g, i)
        out[i * 4] = v
        out[i * 4 + 1] = v
        out[i * 4 + 2] = v
        out[i * 4 + 3] = alpha ? at(alpha, i) : 255
      }
      if (colorMode === COLOR_MODE.DUOTONE) {
        sink.warn('color-mode-converted', { from: 'duotone' }, 'warning')
      } else if (colorMode === COLOR_MODE.MULTICHANNEL) {
        sink.warn('color-mode-converted', { from: 'multichannel' }, 'warning')
      } else if (colorMode === COLOR_MODE.BITMAP) {
        sink.warn('color-mode-converted', { from: 'bitmap' }, 'info')
      }
      break
    }
    case COLOR_MODE.INDEXED: {
      const idx = byId.get(0)
      const pal = opts.palette
      const ti = opts.transparentIndex ?? -1
      for (let i = 0; i < count; i++) {
        const v = at(idx, i)
        if (pal && pal.length >= 768) {
          out[i * 4] = pal[v]
          out[i * 4 + 1] = pal[256 + v]
          out[i * 4 + 2] = pal[512 + v]
        } else {
          out[i * 4] = v
          out[i * 4 + 1] = v
          out[i * 4 + 2] = v
        }
        out[i * 4 + 3] = v === ti ? 0 : alpha ? at(alpha, i) : 255
      }
      sink.warn('color-mode-converted', { from: 'indexed' }, 'info')
      break
    }
    case COLOR_MODE.CMYK: {
      // ⚠️ PSD stores CMYK INVERTED: 0 means full ink, 255 means none.
      const c = byId.get(0)
      const m = byId.get(1)
      const y = byId.get(2)
      const k = byId.get(3)
      for (let i = 0; i < count; i++) {
        const cc = 1 - at(c, i) / 255
        const mm = 1 - at(m, i) / 255
        const yy = 1 - at(y, i) / 255
        const kk = 1 - at(k, i) / 255
        out[i * 4] = clamp255(255 * (1 - cc) * (1 - kk))
        out[i * 4 + 1] = clamp255(255 * (1 - mm) * (1 - kk))
        out[i * 4 + 2] = clamp255(255 * (1 - yy) * (1 - kk))
        out[i * 4 + 3] = alpha ? at(alpha, i) : 255
      }
      sink.warn('color-mode-converted', { from: 'cmyk', profile: 'naive' }, 'warning')
      break
    }
    case COLOR_MODE.LAB: {
      const lp = byId.get(0)
      const ap = byId.get(1)
      const bp = byId.get(2)
      for (let i = 0; i < count; i++) {
        const L = (at(lp, i) * 100) / 255
        const a = at(ap, i) - 128
        const b = at(bp, i) - 128
        const rgb = labToSrgb8(L, a, b)
        out[i * 4] = rgb[0]
        out[i * 4 + 1] = rgb[1]
        out[i * 4 + 2] = rgb[2]
        out[i * 4 + 3] = alpha ? at(alpha, i) : 255
      }
      sink.warn('color-mode-converted', { from: 'lab' }, 'warning')
      break
    }
    default: {
      sink.warn('color-mode-converted', { from: String(colorMode) }, 'warning')
      break
    }
  }

  if (opts.opaque) for (let i = 0; i < count; i++) out[i * 4 + 3] = 255
  return out
}

/**
 * Convenience wrapper: takes raw file-layout channel buffers plus the document
 * depth, expands them to 8 bits and assembles RGBA8.
 */
export function channelsToRgba8(
  raw: readonly { id: number; data: Uint8Array }[],
  width: number,
  height: number,
  depth: PsdDepth,
  colorMode: PsdColorMode,
  sink: WarningSink,
  opts?: Omit<ToRgbaOptions, 'width' | 'height' | 'colorMode'>,
): Uint8Array {
  const planes: Plane[] = raw.map(c => ({
    id: c.id,
    data: depth === 8 ? c.data : expandTo8(c.data, depth, width, height),
  }))
  if (depth === 16 || depth === 32) sink.warn('bit-depth-reduced', { from: depth }, 'info')
  return planesToRgba8(planes, { width, height, colorMode, ...opts }, sink)
}

/** D50 reference white, the illuminant Photoshop stores Lab against. */
const D50 = [0.9642, 1.0, 0.8249] as const

/**
 * Combined Bradford D50->D65 adaptation and XYZ->linear-sRGB matrix.
 *
 * The published coefficients are rounded to 7 digits, which leaves each row's
 * response to the D50 white about 1e-4 off 1. That is enough to turn a neutral
 * Lab colour into 128,128,127 instead of 128,128,128, so each row is normalised
 * at module load: neutrals then stay exactly neutral.
 */
const XYZ_TO_SRGB: number[][] = [
  [3.1338561, -1.6168667, -0.4906146],
  [-0.9787684, 1.9161415, 0.033454],
  [0.0719453, -0.2289914, 1.4052427],
].map(row => {
  const white = row[0] * D50[0] + row[1] * D50[1] + row[2] * D50[2]
  return white > 0 ? row.map(v => v / white) : row
})

/** Lab (D50) -> XYZ -> Bradford-adapted D65 -> sRGB, then the sRGB transfer. */
export function labToSrgb8(L: number, a: number, b: number): [number, number, number] {
  const fy = (L + 16) / 116
  const fx = fy + a / 500
  const fz = fy - b / 200
  const finv = (t: number): number => (t > 6 / 29 ? t * t * t : 3 * (6 / 29) ** 2 * (t - 4 / 29))
  const X = D50[0] * finv(fx)
  const Y = D50[1] * finv(fy)
  const Z = D50[2] * finv(fz)
  const out: number[] = []
  for (const row of XYZ_TO_SRGB) {
    out.push(clamp255(linearToSrgb(clamp01(row[0] * X + row[1] * Y + row[2] * Z)) * 255))
  }
  return [out[0], out[1], out[2]]
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

function clamp255(v: number): number {
  const i = Math.round(v)
  return i < 0 ? 0 : i > 255 ? 255 : i
}

/**
 * Blits a layer-sized RGBA buffer into a document-sized one, clipping to the
 * canvas.
 *
 * ⚠️ This helper exists for consumers that genuinely need document-space
 * pixels (a composite, a preview). The reader itself NEVER does this: keeping
 * every layer at its own rectangle is what keeps a 40-layer 6000x4000 document
 * near 1 GB instead of 3.8 GB (spec §7.3 "E1", §9.3).
 */
export function placeIntoCanvas(
  src: Uint8Array,
  srcW: number,
  srcH: number,
  left: number,
  top: number,
  docW: number,
  docH: number,
): Uint8Array {
  const dst = allocBytes(docW * docH * 4)
  const x0 = Math.max(0, left)
  const y0 = Math.max(0, top)
  const x1 = Math.min(docW, left + srcW)
  const y1 = Math.min(docH, top + srcH)
  for (let y = y0; y < y1; y++) {
    const s = ((y - top) * srcW + (x0 - left)) * 4
    const d = (y * docW + x0) * 4
    dst.set(src.subarray(s, s + (x1 - x0) * 4), d)
  }
  return dst
}
