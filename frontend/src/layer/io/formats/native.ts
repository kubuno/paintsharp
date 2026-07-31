// Browser-native decode and encode paths (spec 05 §2, §3.2).
//
// WHAT THE NATIVE PATH COSTS — measured on Chrome 150, and the reason every use of it
// below is gated by a header pre-scan:
//
//   * Bit depth > 8 is LOST. The 2D canvas is strictly 8 bits per channel:
//     `getImageData(..., { pixelFormat: 'float16' })` throws, and `getContext('2d',
//     { pixelFormat: 'float16' })` is a FALSE POSITIVE (the unknown option is ignored and
//     a plain 8-bit context comes back). PNG 16, TIFF 16/32, AVIF 10/12 all truncate.
//   * ICC profiles are LOST. The browser converts to sRGB silently, or ignores the
//     profile; either way it is gone and cannot be re-embedded. Hence
//     `colorSpaceConversion: 'none'` everywhere, with our own profile parsing beside it.
//   * EXIF orientation is APPLIED for JPEG by default and we cannot tell whether it was:
//     hence `imageOrientation: 'none'` everywhere, and the rotation baked in by
//     `metadata/orientation.ts` instead.
//   * Pages/sub-images are LOST (TIFF IFDs, ICO sizes, DDS mips): the browser picks one
//     by an undocumented heuristic.
//   * Channels beyond RGBA are LOST, palettes are flattened, CMYK/Lab are non-deterministic.
//   * Premultiplication loses precision on low alphas, hence `premultiplyAlpha: 'none'`.
//
// ENCODING — only PNG, JPEG and WebP are honoured. Any other MIME silently returns a PNG,
// with no error at all, so every encode here verifies `blob.type` and refuses a mismatch.

import { EMPTY_METADATA } from '../metadata/types'
import { IoUnsupportedError, type RasterImage } from './types'

export interface NativeDecodeResult {
  readonly width: number
  readonly height: number
  /** Straight (non-premultiplied) RGBA8. */
  readonly rgba: Uint8Array
}

function hasOffscreenCanvas(): boolean {
  return typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap !== 'undefined'
}

/**
 * Decodes with the platform codec and reads the pixels back as straight RGBA8.
 *
 * Every lossy default is switched off: no colour conversion, no premultiplication, no
 * EXIF rotation. What the browser still cannot preserve is listed at the top of this file
 * and must be checked by a header pre-scan BEFORE calling this.
 */
export async function nativeDecode(blob: Blob): Promise<NativeDecodeResult> {
  if (!hasOffscreenCanvas()) {
    throw new IoUnsupportedError('native decoding needs OffscreenCanvas', 'io.no-offscreen-canvas')
  }
  const bitmap = await createImageBitmap(blob, {
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
    imageOrientation: 'none',
  })
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new IoUnsupportedError('2D context unavailable', 'io.no-2d-context')
    ctx.drawImage(bitmap, 0, 0)
    const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height)
    return {
      width: bitmap.width,
      height: bitmap.height,
      rgba: new Uint8Array(data.data.buffer.slice(0)),
    }
  } finally {
    bitmap.close()
  }
}

/** Wraps a native decode as a `RasterImage`, so it plugs into the same pipeline. */
export async function nativeDecodeToRaster(blob: Blob, formatId: string): Promise<RasterImage> {
  const { width, height, rgba } = await nativeDecode(blob)
  void formatId
  return {
    width,
    height,
    colorModel: 'rgb',
    sampleType: 'u8',
    colorChannels: 3,
    alpha: 'unassociated',
    data: rgba,
    // The browser was told not to convert, so the samples are still in the file's space.
    // Whoever read the ICC profile alongside must override this.
    colorSpace: { kind: 'srgb' },
    metadata: EMPTY_METADATA,
    orientation: 1,
    sourceBitDepth: 8,
  }
}

/**
 * Encodes through the platform, but never lies about the result: a canvas that does not
 * support `type` silently returns PNG, so the type is verified and a mismatch is an
 * explicit failure the caller must handle by falling back to an in-house encoder.
 */
export async function nativeEncode(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  type: string,
  quality?: number,
): Promise<Blob> {
  if (!hasOffscreenCanvas()) {
    throw new IoUnsupportedError('native encoding needs OffscreenCanvas', 'io.no-offscreen-canvas')
  }
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new IoUnsupportedError('2D context unavailable', 'io.no-2d-context')
  // `ImageData` requires a Uint8ClampedArray backed by a plain ArrayBuffer (never a
  // SharedArrayBuffer), so the samples are copied into a fresh one.
  const clamped = new Uint8ClampedArray(width * height * 4)
  clamped.set(rgba.subarray(0, clamped.length))
  ctx.putImageData(new ImageData(clamped, width, height), 0, 0)
  const blob = await canvas.convertToBlob({ type, quality })
  if (blob.type !== type) {
    throw new IoUnsupportedError(
      `this browser cannot encode ${type} (it returned ${blob.type})`,
      'io.native-encode-unsupported',
    )
  }
  return blob
}

/**
 * Runtime capability probe for the export dialog: entries whose encoder is unavailable
 * are hidden rather than producing a mislabelled file. Cheap (a 1×1 canvas per type).
 */
export async function probeNativeEncoders(
  types: readonly string[] = ['image/png', 'image/jpeg', 'image/webp', 'image/avif'],
): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {}
  if (!hasOffscreenCanvas()) {
    for (const t of types) out[t] = false
    return out
  }
  const canvas = new OffscreenCanvas(1, 1)
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    for (const t of types) out[t] = false
    return out
  }
  ctx.fillRect(0, 0, 1, 1)
  for (const type of types) {
    try {
      const blob = await canvas.convertToBlob({ type })
      out[type] = blob.type === type
    } catch {
      out[type] = false
    }
  }
  return out
}

/**
 * JPEG decoder for TIFF compression 7, injected into the TIFF decoder so that file stays
 * DOM-free and unit-testable.
 */
export function createJpegBlockDecoder(): (
  jpeg: Uint8Array,
) => Promise<{ width: number; height: number; rgba: Uint8Array }> {
  return async (jpeg: Uint8Array) => {
    const blob = new Blob([jpeg.slice().buffer as ArrayBuffer], { type: 'image/jpeg' })
    return nativeDecode(blob)
  }
}

/**
 * Quality semantics the export dialog must reflect (measured, spec 05 §2.2):
 *   * JPEG: 4:2:0 at every quality below 1.0; exactly 1.0 switches to 4:4:4. There is no
 *     way to ask for 4:2:2, progressive, custom quantisation tables or restart intervals.
 *   * WebP: exactly 1.0 is LOSSLESS (VP8L) and is often SMALLER than 0.99 on synthetic
 *     content — counter-intuitive, and worth surfacing in the UI.
 *   * PNG: `quality` is ignored outright; the compression level is not reachable.
 */
export const NATIVE_QUALITY_NOTES = {
  jpeg444Requires: 1.0,
  webpLosslessRequires: 1.0,
  pngIgnoresQuality: true,
} as const
