/*
 * PSD/PSB bit-depth normalisation to 8 bits (spec §2.4).
 *
 * Derived from the GIMP PSD plug-in (file-psd), Copyright 2007 John Marshall,
 * GPLv3+ — `convert_1_bit()` in psd-load.c — plus the public sRGB transfer
 * function. Independent TypeScript re-implementation; no GIMP source was
 * copied. Kubuno is AGPLv3.
 */
import { allocBytes } from '../errors.ts'
import type { PsdDepth } from '../types.ts'

/**
 * Expands one channel's file-layout samples into one byte per sample.
 *
 * - depth 1: MSB-first packed rows; a set bit means BLACK (0), which is the
 *   inversion Photoshop uses for Bitmap mode.
 * - depth 16: big-endian, rounded to nearest rather than shifted (a plain
 *   `>> 8` biases every value downwards).
 * - depth 32: big-endian linear float; tone-mapped when the channel carries HDR.
 */
export function expandTo8(
  src: Uint8Array,
  depth: PsdDepth,
  width: number,
  height: number,
): Uint8Array {
  const count = width * height
  if (count <= 0) return allocBytes(0)
  const out = allocBytes(count)

  switch (depth) {
    case 8: {
      out.set(src.subarray(0, Math.min(count, src.length)))
      return out
    }
    case 1: {
      const rowBytes = Math.ceil(width / 8)
      for (let y = 0; y < height; y++) {
        const row = y * rowBytes
        for (let x = 0; x < width; x++) {
          const byte = src[row + (x >> 3)] ?? 0
          const bit = (byte >> (7 - (x & 7))) & 1
          out[y * width + x] = bit ? 0 : 255
        }
      }
      return out
    }
    case 16: {
      const n = Math.min(count, src.length >> 1)
      for (let i = 0; i < n; i++) {
        const v = (src[i * 2] << 8) | src[i * 2 + 1]
        out[i] = ((v * 255 + 32767) / 65535) | 0
      }
      return out
    }
    case 32: {
      const n = Math.min(count, src.length >> 2)
      const view = new DataView(src.buffer, src.byteOffset, src.byteLength)
      // Find the peak first: values above 1 mean HDR and need a tone map.
      let peak = 0
      for (let i = 0; i < n; i++) {
        const v = view.getFloat32(i * 4, false)
        if (Number.isFinite(v) && v > peak) peak = v
      }
      const toneMap = peak > 1
      for (let i = 0; i < n; i++) {
        let v = view.getFloat32(i * 4, false)
        if (!Number.isFinite(v)) v = 0
        if (toneMap) v = v / (1 + v) // Reinhard
        v = v < 0 ? 0 : v > 1 ? 1 : v
        out[i] = Math.round(linearToSrgb(v) * 255)
      }
      return out
    }
  }
}

/** True when a 32-bit channel carries values above 1 (i.e. real HDR). */
export function isHdr(src: Uint8Array, depth: PsdDepth): boolean {
  if (depth !== 32 || src.length < 4) return false
  const view = new DataView(src.buffer, src.byteOffset, src.byteLength)
  const n = src.length >> 2
  for (let i = 0; i < n; i++) {
    const v = view.getFloat32(i * 4, false)
    if (Number.isFinite(v) && v > 1) return true
  }
  return false
}

export function linearToSrgb(v: number): number {
  return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055
}

export function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}
