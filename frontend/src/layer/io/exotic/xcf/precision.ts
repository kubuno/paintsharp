// SPDX-License-Identifier: AGPL-3.0-or-later
//
// XCF decoding logic derived from the GIMP source code (app/xcf/xcf-load.c
// `xcf_load_magic_version` precision switch, and pdb/enums.pl `GimpPrecision`),
// Copyright (C) 1995 Spencer Kimball and Peter Mattis and the GIMP contributors,
// licensed GPL-3.0-or-later. Reimplemented in TypeScript for Kubuno (AGPL-3.0-or-later).
//
// The `precision` header field has THREE incompatible encodings depending on the file
// version (spec 07 §4.8). The classic third-party bug is to use one table for all of
// them: 400/450 mean "half" in v5/v6 but nothing in v>=7, where 500/550 mean "half" —
// and 500/550 meant "float" in v5/v6. A single table silently mislabels every 16-bit
// float file ever written by GIMP 2.9.

export type XcfSampleKind = 'uint' | 'float'
export type XcfTrc = 'linear' | 'non-linear' | 'perceptual'

export interface XcfPrecision {
  readonly bytesPerComponent: 1 | 2 | 4 | 8
  readonly kind: XcfSampleKind
  readonly trc: XcfTrc
  /** Short label for `ImportedDocument.provenance`. */
  readonly label: string
}

const U8_GAMMA: XcfPrecision = { bytesPerComponent: 1, kind: 'uint', trc: 'non-linear', label: 'u8 non-linear' }

function mk(bytes: 1 | 2 | 4 | 8, kind: XcfSampleKind, trc: XcfTrc): XcfPrecision {
  const name = kind === 'float' ? (bytes === 2 ? 'half' : bytes === 4 ? 'float' : 'double') : `u${bytes * 8}`
  return { bytesPerComponent: bytes, kind, trc, label: `${name} ${trc}` }
}

/** Version 4 only: a short 0..4 scale that exists nowhere else. */
const V4_SCALE: Readonly<Record<number, XcfPrecision>> = {
  0: mk(1, 'uint', 'non-linear'),
  1: mk(2, 'uint', 'non-linear'),
  2: mk(4, 'uint', 'linear'),
  3: mk(2, 'float', 'linear'),
  4: mk(4, 'float', 'linear'),
}

/** Versions 5 and 6: the historical 100..550 scale, which is NOT today's GimpPrecision. */
const V5_V6_SCALE: Readonly<Record<number, XcfPrecision>> = {
  100: mk(1, 'uint', 'linear'),
  150: mk(1, 'uint', 'non-linear'),
  200: mk(2, 'uint', 'linear'),
  250: mk(2, 'uint', 'non-linear'),
  300: mk(4, 'uint', 'linear'),
  350: mk(4, 'uint', 'non-linear'),
  400: mk(2, 'float', 'linear'),
  450: mk(2, 'float', 'non-linear'),
  500: mk(4, 'float', 'linear'),
  550: mk(4, 'float', 'non-linear'),
}

/** Versions >= 7: the raw value of today's `GimpPrecision` enum. */
const CURRENT_SCALE: Readonly<Record<number, XcfPrecision>> = {
  100: mk(1, 'uint', 'linear'),
  150: mk(1, 'uint', 'non-linear'),
  175: mk(1, 'uint', 'perceptual'),
  200: mk(2, 'uint', 'linear'),
  250: mk(2, 'uint', 'non-linear'),
  275: mk(2, 'uint', 'perceptual'),
  300: mk(4, 'uint', 'linear'),
  350: mk(4, 'uint', 'non-linear'),
  375: mk(4, 'uint', 'perceptual'),
  500: mk(2, 'float', 'linear'),
  550: mk(2, 'float', 'non-linear'),
  575: mk(2, 'float', 'perceptual'),
  600: mk(4, 'float', 'linear'),
  650: mk(4, 'float', 'non-linear'),
  675: mk(4, 'float', 'perceptual'),
  700: mk(8, 'float', 'linear'),
  750: mk(8, 'float', 'non-linear'),
  775: mk(8, 'float', 'perceptual'),
}

/**
 * Decodes the header `precision` field. Files before version 4 carry no such field and
 * are always 8-bit gamma-encoded; an unknown value falls back to the same, because a
 * wrong bytes-per-component would misread every tile whereas a wrong TRC only shifts
 * the tone curve.
 */
export function decodePrecision(raw: number, version: number): { precision: XcfPrecision; known: boolean } {
  if (version < 4) return { precision: U8_GAMMA, known: true }
  const table = version === 4 ? V4_SCALE : version <= 6 ? V5_V6_SCALE : CURRENT_SCALE
  const hit = table[raw]
  if (hit) return { precision: hit, known: true }
  return { precision: U8_GAMMA, known: false }
}

// ---------------------------------------------------------------------------
// Normalisation to sRGB-encoded 8 bits
// ---------------------------------------------------------------------------

/** sRGB OETF (IEC 61966-2-1), applied to linear sources before quantisation (§4.8). */
export function encodeSrgb(v: number): number {
  if (v <= 0.0031308) return 12.92 * v
  return 1.055 * Math.pow(v, 1 / 2.4) - 0.055
}

/**
 * 256-entry lookup for the linear -> sRGB conversion of 8-bit sources. Built once;
 * the per-pixel `Math.pow` of `encodeSrgb` is far too costly for a 24 Mpx layer.
 */
const LINEAR_U8_TO_SRGB: Uint8ClampedArray = (() => {
  const t = new Uint8ClampedArray(256)
  for (let i = 0; i < 256; i++) t[i] = Math.round(encodeSrgb(i / 255) * 255)
  return t
})()

/** Same idea for 16-bit linear sources: 4096 entries is visually indistinguishable. */
const LINEAR_U16_TO_SRGB: Uint8ClampedArray = (() => {
  const t = new Uint8ClampedArray(4096)
  for (let i = 0; i < 4096; i++) t[i] = Math.round(encodeSrgb(i / 4095) * 255)
  return t
})()

/**
 * Manual IEEE-754 binary16 read, for engines without `DataView#getFloat16` (ES2025,
 * Chrome 135+/Safari 26+ only). Always used: the branch would cost more than the maths.
 */
export function readHalf(dv: DataView, off: number, littleEndian: boolean): number {
  const h = dv.getUint16(off, littleEndian)
  const s = h & 0x8000 ? -1 : 1
  const e = (h >> 10) & 0x1f
  const m = h & 0x3ff
  if (e === 0) return s * m * 2 ** -24
  if (e === 31) return m ? NaN : s * Infinity
  return s * (m + 1024) * 2 ** (e - 25)
}

/**
 * Builds the per-component reader that turns a raw sample into an 8-bit sRGB value.
 *
 * `outOfRange` is set when a floating-point source carries values outside [0,1] (an XCF
 * imported from EXR): the caller turns that into a single "out-of-gamut values clipped"
 * warning instead of one per pixel.
 */
export interface ComponentReader {
  /** Colour component -> 0..255, sRGB-encoded. */
  readonly color: (dv: DataView, off: number, littleEndian: boolean) => number
  /** Alpha -> 0..255. Never gets a transfer curve, only a clamp. */
  readonly alpha: (dv: DataView, off: number, littleEndian: boolean) => number
  readonly bytes: 1 | 2 | 4 | 8
  /** Mutable flag; set by the readers when a float sample fell outside [0,1]. */
  readonly state: { outOfRange: boolean }
}

export function componentReader(p: XcfPrecision): ComponentReader {
  const state = { outOfRange: false }
  const linear = p.trc === 'linear'

  const clamp01 = (v: number): number => {
    if (Number.isNaN(v)) return 0
    if (v < 0) {
      state.outOfRange = true
      return 0
    }
    if (v > 1) {
      state.outOfRange = true
      return 1
    }
    return v
  }

  const toByte = (v01: number): number => Math.round((linear ? encodeSrgb(v01) : v01) * 255)

  if (p.kind === 'uint') {
    switch (p.bytesPerComponent) {
      case 1:
        return {
          bytes: 1,
          state,
          color: linear ? (dv, off) => LINEAR_U8_TO_SRGB[dv.getUint8(off)] : (dv, off) => dv.getUint8(off),
          alpha: (dv, off) => dv.getUint8(off),
        }
      case 2:
        return {
          bytes: 2,
          state,
          color: linear
            ? (dv, off, le) => LINEAR_U16_TO_SRGB[dv.getUint16(off, le) >> 4]
            : (dv, off, le) => (dv.getUint16(off, le) * 255) / 65535 + 0.5,
          alpha: (dv, off, le) => (dv.getUint16(off, le) * 255) / 65535 + 0.5,
        }
      default:
        // u32 (and the impossible u64 uint, which GimpPrecision does not define).
        return {
          bytes: 4,
          state,
          color: (dv, off, le) => toByte(dv.getUint32(off, le) / 4294967295),
          alpha: (dv, off, le) => (dv.getUint32(off, le) * 255) / 4294967295 + 0.5,
        }
    }
  }

  switch (p.bytesPerComponent) {
    case 2:
      return {
        bytes: 2,
        state,
        color: (dv, off, le) => toByte(clamp01(readHalf(dv, off, le))),
        alpha: (dv, off, le) => clamp01(readHalf(dv, off, le)) * 255,
      }
    case 8:
      return {
        bytes: 8,
        state,
        color: (dv, off, le) => toByte(clamp01(dv.getFloat64(off, le))),
        alpha: (dv, off, le) => clamp01(dv.getFloat64(off, le)) * 255,
      }
    default:
      return {
        bytes: 4,
        state,
        color: (dv, off, le) => toByte(clamp01(dv.getFloat32(off, le))),
        alpha: (dv, off, le) => clamp01(dv.getFloat32(off, le)) * 255,
      }
  }
}
