/*
 * PSD/PSB ZIP-prediction (delta) decoding.
 *
 * The algorithms implemented here were derived from the GIMP PSD plug-in
 * (file-psd), Copyright 2007 John Marshall, licensed under the GNU General
 * Public License v3 or later — the `PSD_COMP_ZIP_PRED` branch of psd-load.c
 * (~l. 5344-5400) and `decode_32_bit_predictor()` (~l. 5430-5472) — and from
 * Adobe's public "Photoshop File Formats Specification" plus TIFF Technical
 * Note 3 for the byte-planar 32-bit scheme.
 *
 * This is an independent TypeScript re-implementation; no GIMP source code was
 * copied. Kubuno is AGPLv3, compatible with the GPLv3 (GPLv3 §13).
 */
import { allocBytes } from '../errors.ts'

/**
 * 8-bit predictor: horizontal byte delta, per row, wrapping modulo 256.
 * Operates in place and returns `data` for convenience.
 */
export function undoPredictor8(data: Uint8Array, rows: number, columns: number): Uint8Array {
  if (columns < 2) return data
  for (let y = 0; y < rows; y++) {
    const off = y * columns
    if (off + columns > data.length) break
    for (let x = 1; x < columns; x++) {
      data[off + x] = (data[off + x] + data[off + x - 1]) & 0xff
    }
  }
  return data
}

/**
 * 16-bit predictor: horizontal delta on the 16-bit VALUES, per row.
 *
 * GIMP byte-swaps big-endian to host order first and then undeltas; we keep the
 * buffer big-endian throughout (our channel contract is "file byte order"), so
 * the arithmetic is done on values read/written as BE pairs. The result is
 * identical.
 */
export function undoPredictor16(data: Uint8Array, rows: number, columns: number): Uint8Array {
  if (columns < 2) return data
  const rowBytes = columns * 2
  for (let y = 0; y < rows; y++) {
    const off = y * rowBytes
    if (off + rowBytes > data.length) break
    let prev = (data[off] << 8) | data[off + 1]
    for (let x = 1; x < columns; x++) {
      const p = off + x * 2
      const cur = (((data[p] << 8) | data[p + 1]) + prev) & 0xffff
      data[p] = cur >>> 8
      data[p + 1] = cur & 0xff
      prev = cur
    }
  }
  return data
}

/**
 * 32-bit predictor: a completely different scheme. Each row is stored as byte
 * PLANES (all high bytes, then all second bytes…) and the delta is applied to
 * the bytes of the whole row, not to the float values.
 *
 * Returns a fresh buffer holding big-endian float32 samples in normal order.
 */
export function undoPredictor32(src: Uint8Array, rows: number, columns: number): Uint8Array {
  const rowSize = columns * 4
  const total = rows * rowSize
  if (total === 0) return allocBytes(0)

  // 1. Byte-wise delta across each full row.
  for (let row = 0; row < rows; row++) {
    const off = row * rowSize
    if (off + rowSize > src.length) break
    for (let j = 0; j < rowSize - 1; j++) {
      src[off + j + 1] = (src[off + j + 1] + src[off + j]) & 0xff
    }
  }

  // 2. De-interleave the byte planes back into big-endian float32 order.
  const dst = allocBytes(total)
  let d = 0
  for (let row = 0; row + rowSize <= total && row + rowSize <= src.length; row += rowSize) {
    for (let offset = row; offset < row + columns; offset++) {
      for (let x = offset; x < offset + rowSize; x += columns) dst[d++] = src[x]
    }
  }
  return dst
}

/** Dispatches on depth. Depth 1 never uses ZIP, so it is returned untouched. */
export function undoPredictor(
  data: Uint8Array,
  depth: number,
  rows: number,
  columns: number,
): Uint8Array {
  switch (depth) {
    case 8:
      return undoPredictor8(data, rows, columns)
    case 16:
      return undoPredictor16(data, rows, columns)
    case 32:
      return undoPredictor32(data, rows, columns)
    default:
      return data
  }
}

/* ------------------------------------------------------------------ *
 * Encoders — used only by the tests today: Kubuno never writes
 * `compression = 3` (spec §3.5). They exist so `predictor-roundtrip`
 * can validate the decoders against a known-good inverse.
 * ------------------------------------------------------------------ */

export function applyPredictor8(data: Uint8Array, rows: number, columns: number): Uint8Array {
  if (columns < 2) return data
  for (let y = 0; y < rows; y++) {
    const off = y * columns
    if (off + columns > data.length) break
    for (let x = columns - 1; x >= 1; x--) {
      data[off + x] = (data[off + x] - data[off + x - 1]) & 0xff
    }
  }
  return data
}

export function applyPredictor16(data: Uint8Array, rows: number, columns: number): Uint8Array {
  if (columns < 2) return data
  const rowBytes = columns * 2
  for (let y = 0; y < rows; y++) {
    const off = y * rowBytes
    if (off + rowBytes > data.length) break
    for (let x = columns - 1; x >= 1; x--) {
      const p = off + x * 2
      const cur = (data[p] << 8) | data[p + 1]
      const prev = (data[p - 2] << 8) | data[p - 1]
      const v = (cur - prev) & 0xffff
      data[p] = v >>> 8
      data[p + 1] = v & 0xff
    }
  }
  return data
}

export function applyPredictor32(src: Uint8Array, rows: number, columns: number): Uint8Array {
  const rowSize = columns * 4
  const total = rows * rowSize
  const planar = allocBytes(total)
  // Interleave into byte planes, the exact inverse of step 2 above.
  let s = 0
  for (let row = 0; row + rowSize <= total; row += rowSize) {
    for (let offset = row; offset < row + columns; offset++) {
      for (let x = offset; x < offset + rowSize; x += columns) planar[x] = src[s++]
    }
  }
  // Byte-wise delta, applied from the end of each row backwards.
  for (let row = 0; row < rows; row++) {
    const off = row * rowSize
    for (let j = rowSize - 2; j >= 0; j--) {
      planar[off + j + 1] = (planar[off + j + 1] - planar[off + j]) & 0xff
    }
  }
  return planar
}
