// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Tile bytes -> full-document RGBA8. Derived from the pixel-format handling of the GIMP
// source code (app/xcf/xcf-load.c, app/gegl/gimp-babl.c), Copyright (C) 1995 Spencer
// Kimball and Peter Mattis and the GIMP contributors, licensed GPL-3.0-or-later.
// Reimplemented in TypeScript for Kubuno (AGPL-3.0-or-later).
//
// Two deliberate decisions, both from spec 07 §3.3:
//   * every layer is composed into a canvas the size of the DOCUMENT, at its
//     `PROP_OFFSETS` position, because Layer allocates one W×H texture per layer;
//   * alpha stays unassociated, which is what XCF stores (GIMP's R'G'B'A babl formats
//     are not premultiplied) and what `ImageData` expects.

import type { ComponentReader } from './precision'
import type { TileSink } from './hierarchy'

export interface PixelConfig {
  readonly base: 'rgb' | 'gray' | 'indexed'
  readonly hasAlpha: boolean
  /** Components per pixel as stored (1..4). */
  readonly components: number
  readonly reader: ComponentReader
  /** File component order: big-endian from XCF v12, writer-native (i.e. LE) before. */
  readonly componentsBigEndian: boolean
  /** 256 RGB triplets; required for `base === 'indexed'`. */
  readonly palette?: Uint8Array
}

export function bytesPerPixel(cfg: PixelConfig): number {
  return cfg.components * cfg.reader.bytes
}

/**
 * Builds a tile sink writing straight into a document-sized RGBA8 buffer.
 *
 * `offX`/`offY` are the layer's `PROP_OFFSETS`; they may be negative, in which case the
 * out-of-canvas part is simply clipped away.
 */
export function rgbaTileSink(
  dest: Uint8ClampedArray,
  destW: number,
  destH: number,
  offX: number,
  offY: number,
  cfg: PixelConfig,
): TileSink {
  const bpp = bytesPerPixel(cfg)
  const cb = cfg.reader.bytes
  const le = !cfg.componentsBigEndian
  const readColor = cfg.reader.color
  const readAlpha = cfg.reader.alpha
  const palette = cfg.palette

  return (tileData, tw, th, tx, ty) => {
    const dv = new DataView(tileData.buffer, tileData.byteOffset, tileData.byteLength)
    for (let row = 0; row < th; row++) {
      const dy = offY + ty + row
      if (dy < 0 || dy >= destH) continue
      let src = row * tw * bpp
      let dst = (dy * destW + offX + tx) * 4
      const xStart = offX + tx
      for (let col = 0; col < tw; col++, src += bpp, dst += 4) {
        const dx = xStart + col
        if (dx < 0 || dx >= destW) continue

        let r = 0
        let g = 0
        let b = 0
        let a = 255
        switch (cfg.base) {
          case 'rgb':
            r = readColor(dv, src, le)
            g = readColor(dv, src + cb, le)
            b = readColor(dv, src + 2 * cb, le)
            if (cfg.hasAlpha) a = readAlpha(dv, src + 3 * cb, le)
            break
          case 'gray': {
            const v = readColor(dv, src, le)
            r = v
            g = v
            b = v
            if (cfg.hasAlpha) a = readAlpha(dv, src + cb, le)
            break
          }
          case 'indexed': {
            // The palette is already 8-bit sRGB: no transfer curve is applied to it,
            // even when the image declares a linear TRC.
            const idx = tileData[src]
            if (palette) {
              r = palette[idx * 3]
              g = palette[idx * 3 + 1]
              b = palette[idx * 3 + 2]
            }
            if (cfg.hasAlpha) a = readAlpha(dv, src + cb, le)
            break
          }
        }
        dest[dst] = r
        dest[dst + 1] = g
        dest[dst + 2] = b
        dest[dst + 3] = a
      }
    }
  }
}

/**
 * Same, for a layer mask: one grey component, no alpha, written into a document-sized
 * 1-byte-per-pixel buffer. The caller pre-fills it with 0 (fully masked) so that the
 * area a mask does not cover behaves the way GIMP shows it.
 */
export function maskTileSink(
  dest: Uint8ClampedArray,
  destW: number,
  destH: number,
  offX: number,
  offY: number,
  reader: ComponentReader,
  componentsBigEndian: boolean,
): TileSink {
  const cb = reader.bytes
  const le = !componentsBigEndian
  return (tileData, tw, th, tx, ty) => {
    const dv = new DataView(tileData.buffer, tileData.byteOffset, tileData.byteLength)
    for (let row = 0; row < th; row++) {
      const dy = offY + ty + row
      if (dy < 0 || dy >= destH) continue
      let src = row * tw * cb
      const xStart = offX + tx
      for (let col = 0; col < tw; col++, src += cb) {
        const dx = xStart + col
        if (dx < 0 || dx >= destW) continue
        dest[dy * destW + dx] = reader.color(dv, src, le)
      }
    }
  }
}
