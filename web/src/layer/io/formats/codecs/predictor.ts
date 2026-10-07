// SPDX-License-Identifier: AGPL-3.0-or-later
//
// TIFF `Predictor` (tag 317), applied AFTER decompression, per row, per channel.
// Predictor 3 (floating point) is byte-plane de-interleaving plus byte differencing —
// exactly the mechanism OpenEXR's ZIP compression uses, so this file is shared between
// the TIFF and EXR decoders (spec 05 §4.4).
//
// Algorithms from the TIFF 6.0 specification and its Technical Note 3; behaviour
// cross-checked against libtiff as used by GIMP's TIFF plug-in (GPL-3.0-or-later).

/**
 * Predictor 2 — horizontal differencing, undone in increasing order. Additions wrap in
 * the sample width, which is exactly what the encoder relied on.
 *
 * @param data   one decompressed block, `rows` rows of `width * channels` samples
 * @param width  pixels per row
 * @param channels samples per pixel *in this block* (1 when PlanarConfiguration = 2)
 * @param rows   rows in the block
 * @param bitsPerSample 8, 16 or 32
 * @param littleEndian byte order of 16/32-bit samples inside `data`
 */
export function undoHorizontalPredictor(
  data: Uint8Array,
  width: number,
  channels: number,
  rows: number,
  bitsPerSample: number,
  littleEndian: boolean,
): void {
  if (width <= 1) return
  const stride = width * channels

  if (bitsPerSample === 8) {
    const rowBytes = stride
    for (let r = 0; r < rows; r++) {
      const base = r * rowBytes
      if (base + rowBytes > data.length) break
      for (let i = channels; i < rowBytes; i++) {
        data[base + i] = (data[base + i] + data[base + i - channels]) & 0xff
      }
    }
    return
  }

  if (bitsPerSample === 16) {
    const rowBytes = stride * 2
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    for (let r = 0; r < rows; r++) {
      const base = r * rowBytes
      if (base + rowBytes > data.length) break
      for (let i = channels; i < stride; i++) {
        const cur = view.getUint16(base + i * 2, littleEndian)
        const prev = view.getUint16(base + (i - channels) * 2, littleEndian)
        view.setUint16(base + i * 2, (cur + prev) & 0xffff, littleEndian)
      }
    }
    return
  }

  if (bitsPerSample === 32) {
    const rowBytes = stride * 4
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    for (let r = 0; r < rows; r++) {
      const base = r * rowBytes
      if (base + rowBytes > data.length) break
      for (let i = channels; i < stride; i++) {
        const cur = view.getUint32(base + i * 4, littleEndian)
        const prev = view.getUint32(base + (i - channels) * 4, littleEndian)
        view.setUint32(base + i * 4, (cur + prev) >>> 0, littleEndian)
      }
    }
  }
  // Other depths (1/2/4 bits) are not predictable per the specification.
}

/**
 * Predictor 3 — floating point. The encoder split every sample into byte planes (all the
 * high-order bytes of a row first, then the next, …) and byte-differenced the result. So
 * the decoder accumulates the byte differences, then re-interleaves the planes back into
 * floats.
 *
 * The re-interleave always produces BIG-ENDIAN samples per the Technical Note, whatever
 * the file's byte order; the caller converts.
 */
export function undoFloatingPredictor(
  data: Uint8Array,
  width: number,
  channels: number,
  rows: number,
  bytesPerSample: number,
): void {
  const stride = width * channels
  const rowBytes = stride * bytesPerSample
  if (rowBytes === 0) return
  const tmp = new Uint8Array(rowBytes)
  for (let r = 0; r < rows; r++) {
    const base = r * rowBytes
    if (base + rowBytes > data.length) break
    // 1. Undo the byte differencing across the whole row.
    for (let i = 1; i < rowBytes; i++) {
      data[base + i] = (data[base + i] + data[base + i - 1]) & 0xff
    }
    // 2. Re-interleave the byte planes: plane p holds byte p of every sample.
    for (let s = 0; s < stride; s++) {
      for (let b = 0; b < bytesPerSample; b++) {
        tmp[s * bytesPerSample + b] = data[base + b * stride + s]
      }
    }
    data.set(tmp, base)
  }
}

/** Encoder counterpart of predictor 2, used by the TIFF writer. */
export function applyHorizontalPredictor(
  data: Uint8Array,
  width: number,
  channels: number,
  rows: number,
  bitsPerSample: number,
  littleEndian: boolean,
): void {
  if (width <= 1) return
  const stride = width * channels
  if (bitsPerSample === 8) {
    for (let r = 0; r < rows; r++) {
      const base = r * stride
      if (base + stride > data.length) break
      for (let i = stride - 1; i >= channels; i--) {
        data[base + i] = (data[base + i] - data[base + i - channels]) & 0xff
      }
    }
    return
  }
  if (bitsPerSample === 16) {
    const rowBytes = stride * 2
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    for (let r = 0; r < rows; r++) {
      const base = r * rowBytes
      if (base + rowBytes > data.length) break
      for (let i = stride - 1; i >= channels; i--) {
        const cur = view.getUint16(base + i * 2, littleEndian)
        const prev = view.getUint16(base + (i - channels) * 2, littleEndian)
        view.setUint16(base + i * 2, (cur - prev) & 0xffff, littleEndian)
      }
    }
  }
}
