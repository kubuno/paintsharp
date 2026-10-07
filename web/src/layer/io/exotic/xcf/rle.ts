// SPDX-License-Identifier: AGPL-3.0-or-later
//
// RLE tile decoding, derived from GIMP's `xcf_load_tile_rle` (app/xcf/xcf-load.c),
// Copyright (C) 1995 Spencer Kimball and Peter Mattis and the GIMP contributors,
// licensed GPL-3.0-or-later. Reimplemented in TypeScript for Kubuno (AGPL-3.0-or-later).
//
// The point third-party implementations most often miss: XCF's RLE runs over BYTE
// PLANES, not over pixels and not over components. For `bpp` bytes per pixel there are
// `bpp` successive planes; plane i fills tileData[i], tileData[i+bpp], … That is exactly
// why the scheme compresses 16-bit images well — the high byte of a component and its
// low byte end up in different planes, and the high byte is nearly constant.

/** Raised when a run description walks past the end of the compressed tile. */
export class XcfBogusRleError extends Error {
  constructor(message = 'bogus RLE data') {
    super(message)
    this.name = 'XcfBogusRleError'
  }
}

/**
 * Expands one RLE-compressed tile into `tileData`, which must be exactly
 * `pixelCount * bpp` bytes.
 *
 * Extended run lengths are big-endian u16. Every read and every write is bounds-checked
 * before it happens: a corrupt tile raises `XcfBogusRleError`, which the caller turns
 * into one transparent tile plus a counter, never into a failed document.
 */
export function decodeTileRle(
  src: Uint8Array,
  tileData: Uint8Array,
  bpp: number,
  pixelCount: number,
): void {
  if (tileData.length < pixelCount * bpp) {
    throw new XcfBogusRleError('destination smaller than the tile it must hold')
  }
  let p = 0
  for (let plane = 0; plane < bpp; plane++) {
    let dst = plane
    let remaining = pixelCount
    while (remaining > 0) {
      if (p >= src.length) throw new XcfBogusRleError()
      const val = src[p++]
      if (val >= 128) {
        // Literal run: `256 - val` bytes copied verbatim.
        let length = 256 - val
        if (length === 128) {
          // val === 128 escapes to a 16-bit length.
          if (p + 1 >= src.length) throw new XcfBogusRleError()
          length = (src[p] << 8) | src[p + 1]
          p += 2
        }
        remaining -= length
        if (remaining < 0 || p + length > src.length) throw new XcfBogusRleError()
        for (let k = 0; k < length; k++) {
          tileData[dst] = src[p++]
          dst += bpp
        }
      } else {
        // Repeated run: one byte, `val + 1` times.
        let length = val + 1
        if (length === 128) {
          // val === 127 escapes to a 16-bit length.
          if (p + 1 >= src.length) throw new XcfBogusRleError()
          length = (src[p] << 8) | src[p + 1]
          p += 2
        }
        remaining -= length
        if (remaining < 0 || p >= src.length) throw new XcfBogusRleError()
        const v = src[p++]
        for (let k = 0; k < length; k++) {
          tileData[dst] = v
          dst += bpp
        }
      }
    }
  }
}
