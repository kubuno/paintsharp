// EXIF orientation (spec 05 §6.3) — the fix for the single most visible photo bug:
// phone pictures arriving on their side.
//
// Policy, applied without exception:
//   1. On import the decoder RECORDS the tag and `createImageBitmap` is called with
//      `imageOrientation: 'none'` (otherwise Chrome applies it too and the rotation is
//      counted twice). The transform is then baked into the pixels here and the value is
//      reset to 1 in the document metadata — a hidden rotation is a permanent bug source.
//   2. On export `Orientation = 1` is written. The pixels are already upright; writing
//      anything else would rotate the picture a second time at the recipient's end.
//
// Everything below works on typed arrays, never on a canvas: a 16-bit or CMYK image must
// survive the rotation, and the 2D canvas is strictly 8 bits (spec 05 §2.4).

import type { RasterImage, SampleArray } from '../formats/types'
import { EXIF_TAG } from './exif'
import type { ExifData, ExifIfd, ExifTagValue, ImageMetadata } from './types'
import { ExifType } from './types'

/** EXIF orientation, 1..8. Values >= 5 swap width and height. */
export type Orientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8

export function isOrientation(v: number | undefined): v is Orientation {
  return v !== undefined && Number.isInteger(v) && v >= 1 && v <= 8
}

/** True for the four orientations that transpose the axes. */
export function orientationSwapsAxes(o: number): boolean {
  return o >= 5 && o <= 8
}

/** Human-readable description, for diagnostics. */
export function orientationLabel(o: number): string {
  switch (o) {
    case 1:
      return 'none'
    case 2:
      return 'mirror horizontal'
    case 3:
      return 'rotate 180'
    case 4:
      return 'mirror vertical'
    case 5:
      return 'transpose'
    case 6:
      return 'rotate 90 CW'
    case 7:
      return 'transverse'
    case 8:
      return 'rotate 270 CW'
    default:
      return `invalid(${o})`
  }
}

/**
 * Maps an output pixel back to its source coordinates. Written as a lookup rather than a
 * matrix so each case can be read against the specification table.
 */
function sourceOf(
  orientation: number,
  x: number,
  y: number,
  srcWidth: number,
  srcHeight: number,
): [number, number] {
  switch (orientation) {
    case 2:
      return [srcWidth - 1 - x, y]
    case 3:
      return [srcWidth - 1 - x, srcHeight - 1 - y]
    case 4:
      return [x, srcHeight - 1 - y]
    case 5:
      return [y, x]
    case 6:
      return [y, srcHeight - 1 - x]
    case 7:
      return [srcWidth - 1 - y, srcHeight - 1 - x]
    case 8:
      return [srcWidth - 1 - y, x]
    default:
      return [x, y]
  }
}

/** Allocates the same concrete typed-array kind as the source. */
function likeArray(src: SampleArray, length: number): SampleArray {
  if (src instanceof Uint8Array) return new Uint8Array(length)
  if (src instanceof Uint16Array) return new Uint16Array(length)
  if (src instanceof Uint32Array) return new Uint32Array(length)
  return new Float32Array(length)
}

/**
 * Rotates/mirrors interleaved samples. Works for any sample type and any channel count,
 * which is why the rotation happens here and not through a canvas.
 */
export function transformSamples(
  data: SampleArray,
  width: number,
  height: number,
  channels: number,
  orientation: number,
): { data: SampleArray; width: number; height: number } {
  if (orientation === 1 || !isOrientation(orientation)) return { data, width, height }
  const swap = orientationSwapsAxes(orientation)
  const outWidth = swap ? height : width
  const outHeight = swap ? width : height
  const out = likeArray(data, outWidth * outHeight * channels)
  for (let y = 0; y < outHeight; y++) {
    for (let x = 0; x < outWidth; x++) {
      const [sx, sy] = sourceOf(orientation, x, y, width, height)
      if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue
      const s = (sy * width + sx) * channels
      const d = (y * outWidth + x) * channels
      for (let c = 0; c < channels; c++) out[d + c] = data[s + c]
    }
  }
  return { data: out, width: outWidth, height: outHeight }
}

/**
 * Bakes `image.orientation` into the pixels and resets the recorded value to 1 — both in
 * the `RasterImage` and in the EXIF block, so a later export cannot rotate twice.
 */
export function applyOrientation(image: RasterImage, orientation = image.orientation ?? 1): RasterImage {
  if (!isOrientation(orientation) || orientation === 1) {
    return image.orientation === 1 ? image : { ...image, orientation: 1 }
  }
  const channels = image.data.length / (image.width * image.height)
  if (!Number.isInteger(channels) || channels <= 0) return image
  const t = transformSamples(image.data, image.width, image.height, channels, orientation)
  return {
    ...image,
    width: t.width,
    height: t.height,
    data: t.data,
    orientation: 1,
    metadata: resetOrientationTag(image.metadata),
  }
}

/** Rewrites `Orientation` to 1 inside the EXIF block, leaving every other tag alone. */
export function resetOrientationTag(metadata: ImageMetadata): ImageMetadata {
  if (!metadata.exif) return metadata
  const current = metadata.exif.ifd0.tags.get(EXIF_TAG.Orientation)
  if (!current) return metadata
  const tags = new Map<number, ExifTagValue>(metadata.exif.ifd0.tags)
  tags.set(EXIF_TAG.Orientation, {
    tag: EXIF_TAG.Orientation,
    type: ExifType.Short,
    count: 1,
    value: [1],
  })
  const ifd0: ExifIfd = { tags }
  const exif: ExifData = { ...metadata.exif, ifd0 }
  return { ...metadata, exif }
}

/**
 * Equivalent transform for RGBA8 buffers, for the native decode path where the pixels
 * already come back as RGBA from `createImageBitmap`.
 */
export function transformRgba(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  orientation: number,
): { data: Uint8ClampedArray; width: number; height: number } {
  const asU8 = new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength)
  const t = transformSamples(asU8, width, height, 4, orientation)
  const out = t.data as Uint8Array
  return {
    data: new Uint8ClampedArray(out.buffer, out.byteOffset, out.byteLength),
    width: t.width,
    height: t.height,
  }
}
