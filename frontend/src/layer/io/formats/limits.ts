// Safety limits. Every decoder validates dimensions and lengths BEFORE allocating:
// a malformed file must fail with a typed error, never with an out-of-memory crash,
// an infinite loop, or a multi-gigabyte allocation.

import { IoLimitError } from './types'

/** No real picture is wider or taller than this; TIFF/BMP happily declare 2^31. */
export const MAX_DIMENSION = 100_000

/** ~400 Mpx: a 20000×20000 image. Above this the browser dies anyway. */
export const MAX_PIXELS = 400_000_000

/** Hard ceiling on a single sample buffer (1 GiB). */
export const MAX_BUFFER_BYTES = 1 << 30

/** Samples per pixel: TIFF allows 2^16, but past this it is corruption. */
export const MAX_SAMPLES_PER_PIXEL = 64

/** TIFF IFD chains, ICO entries, DDS mip levels… A classic DoS vector. */
export const MAX_PAGES = 4096

/** Entries in a single IFD. */
export const MAX_IFD_ENTRIES = 4096

/** Strips or tiles in a single page. */
export const MAX_BLOCKS = 1_000_000

/** Value array length of one IFD entry (StripOffsets on a huge file stays under this). */
export const MAX_TAG_COUNT = 4_000_000

export function checkDimensions(width: number, height: number, what = 'image'): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new IoLimitError(`${what}: invalid dimensions ${width}×${height}`)
  }
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw new IoLimitError(`${what}: dimensions ${width}×${height} exceed ${MAX_DIMENSION}`)
  }
  if (width * height > MAX_PIXELS) {
    throw new IoLimitError(`${what}: ${width}×${height} exceeds ${MAX_PIXELS} pixels`)
  }
}

export function checkSampleCount(count: number, bytesPerSample: number, what = 'buffer'): void {
  if (!Number.isFinite(count) || count < 0) {
    throw new IoLimitError(`${what}: invalid sample count ${count}`)
  }
  const bytes = count * bytesPerSample
  if (bytes > MAX_BUFFER_BYTES) {
    throw new IoLimitError(
      `${what}: ${Math.round(bytes / (1 << 20))} MiB requested, limit is ${MAX_BUFFER_BYTES >> 20} MiB`,
    )
  }
}

/** Allocates after checking, so an absurd header can never book gigabytes. */
export function allocU8(count: number, what = 'buffer'): Uint8Array {
  checkSampleCount(count, 1, what)
  return new Uint8Array(count)
}

export function allocU16(count: number, what = 'buffer'): Uint16Array {
  checkSampleCount(count, 2, what)
  return new Uint16Array(count)
}

export function allocU32(count: number, what = 'buffer'): Uint32Array {
  checkSampleCount(count, 4, what)
  return new Uint32Array(count)
}

export function allocF32(count: number, what = 'buffer'): Float32Array {
  checkSampleCount(count, 4, what)
  return new Float32Array(count)
}
