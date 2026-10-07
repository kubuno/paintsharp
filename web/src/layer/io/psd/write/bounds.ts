/*
 * Layer bounding-box helpers for the PSD writer (spec §8.5).
 *
 * Independent implementation; the "tight alpha bounds then write only that
 * rectangle" strategy mirrors what the GIMP PSD exporter does (psd-export.c),
 * Copyright 2007 John Marshall, GPLv3+. Kubuno is AGPLv3.
 */
import type { PsdRect } from '../types.ts'

/**
 * Tight bounding box of non-zero alpha in a document-sized RGBA buffer.
 * Returns null when the layer is fully transparent — such a layer is written
 * with `rect = {0,0,0,0}` and empty channels, which is legal and far lighter
 * than a document-sized transparent flat.
 */
export function alphaBounds(px: Uint8Array, w: number, h: number): PsdRect | null {
  let minX = w
  let minY = h
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < h; y++) {
    const row = y * w * 4
    for (let x = 0; x < w; x++) {
      if (px[row + x * 4 + 3] !== 0) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return null
  return { top: minY, left: minX, bottom: maxY + 1, right: maxX + 1 }
}

/**
 * Tight bounding box of the pixels that differ from `defaultColor` in a
 * document-sized single-channel mask.
 */
export function maskBounds(
  mask: Uint8Array,
  w: number,
  h: number,
  defaultColor: number,
): PsdRect | null {
  let minX = w
  let minY = h
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      if (mask[row + x] !== defaultColor) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return null
  return { top: minY, left: minX, bottom: maxY + 1, right: maxX + 1 }
}

/** Crops a document-sized RGBA buffer down to `rect`. */
export function cropRgba(
  px: Uint8Array,
  docW: number,
  rect: PsdRect,
): Uint8Array {
  const w = rect.right - rect.left
  const h = rect.bottom - rect.top
  const out = new Uint8Array(Math.max(0, w * h * 4))
  for (let y = 0; y < h; y++) {
    const s = ((rect.top + y) * docW + rect.left) * 4
    out.set(px.subarray(s, s + w * 4), y * w * 4)
  }
  return out
}

/** Crops a document-sized single-channel buffer down to `rect`. */
export function cropGray(px: Uint8Array, docW: number, rect: PsdRect): Uint8Array {
  const w = rect.right - rect.left
  const h = rect.bottom - rect.top
  const out = new Uint8Array(Math.max(0, w * h))
  for (let y = 0; y < h; y++) {
    const s = (rect.top + y) * docW + rect.left
    out.set(px.subarray(s, s + w), y * w)
  }
  return out
}

/** Splits interleaved RGBA into four planar 8-bit channels. */
export function splitRgba(px: Uint8Array, count: number): {
  r: Uint8Array
  g: Uint8Array
  b: Uint8Array
  a: Uint8Array
} {
  const r = new Uint8Array(count)
  const g = new Uint8Array(count)
  const b = new Uint8Array(count)
  const a = new Uint8Array(count)
  for (let i = 0; i < count; i++) {
    r[i] = px[i * 4]
    g[i] = px[i * 4 + 1]
    b[i] = px[i * 4 + 2]
    a[i] = px[i * 4 + 3]
  }
  return { r, g, b, a }
}
