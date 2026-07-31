// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bitmap plumbing shared by the RAW, HEIF, SVG and PDF importers: apply an EXIF
// orientation, read pixels back as RGBA8, and wrap the result in a one-layer
// `ImportedDocument`.
//
// `OffscreenCanvas` and `createImageBitmap` are both available inside a Web Worker, so
// this file keeps the "no DOM, runnable off the main thread" property of `layer/io/**`.
// It still imports neither React nor `@kubuno/*`.

import { ImportError } from './errors'
import type { ImportWarning, ImportedDocument, ImportedRaster } from './types'

/** Width/height after an EXIF orientation is applied (5..8 transpose the image). */
export function orientedSize(
  width: number,
  height: number,
  orientation: number,
): { width: number; height: number } {
  return orientation >= 5 && orientation <= 8
    ? { width: height, height: width }
    : { width, height }
}

/**
 * Canvas transform for EXIF orientations 1..8.
 *
 * Skipping this is not cosmetic: every portrait photograph from every camera arrives
 * lying on its side, because the sensor is always read out in landscape.
 */
function applyOrientation(
  ctx: OffscreenCanvasRenderingContext2D,
  orientation: number,
  w: number,
  h: number,
): void {
  switch (orientation) {
    case 2:
      ctx.transform(-1, 0, 0, 1, w, 0)
      break
    case 3:
      ctx.transform(-1, 0, 0, -1, w, h)
      break
    case 4:
      ctx.transform(1, 0, 0, -1, 0, h)
      break
    case 5:
      ctx.transform(0, 1, 1, 0, 0, 0)
      break
    case 6:
      ctx.transform(0, 1, -1, 0, w, 0)
      break
    case 7:
      ctx.transform(0, -1, -1, 0, w, h)
      break
    case 8:
      ctx.transform(0, -1, 1, 0, 0, h)
      break
    default:
      break
  }
}

export interface RgbaImage {
  readonly data: Uint8ClampedArray
  readonly width: number
  readonly height: number
}

/** Draws a decoded bitmap into an RGBA8 buffer, orientation applied. */
export function bitmapToRgba(
  source: ImageBitmap | OffscreenCanvas,
  orientation = 1,
  background?: string,
): RgbaImage {
  const sw = source.width
  const sh = source.height
  const out = orientedSize(sw, sh, orientation)
  const canvas = new OffscreenCanvas(out.width, out.height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new ImportError('decoder-unavailable', 'layer.io.err.decoder_unavailable')
  if (background) {
    ctx.fillStyle = background
    ctx.fillRect(0, 0, out.width, out.height)
  }
  ctx.save()
  applyOrientation(ctx, orientation, out.width, out.height)
  ctx.drawImage(source, 0, 0)
  ctx.restore()
  const image = ctx.getImageData(0, 0, out.width, out.height)
  return { data: image.data, width: out.width, height: out.height }
}

/** Decodes an encoded image blob through the browser's own codecs. */
export async function decodeBlobToBitmap(bytes: Uint8Array, mime: string): Promise<ImageBitmap> {
  // `slice()` because `bytes` is usually a view into a much larger file buffer.
  const blob = new Blob([bytes.slice()], { type: mime })
  return createImageBitmap(blob)
}

/** Wraps a single RGBA image in the pivot document model. */
export function singleLayerDocument(
  image: RgbaImage,
  args: {
    readonly title: string
    readonly layerName: string
    readonly provenance: string
    readonly warnings: readonly ImportWarning[]
    readonly dpi?: number
    readonly iccProfile?: Uint8Array
  },
): ImportedDocument {
  const layer: ImportedRaster = {
    kind: 'raster',
    name: args.layerName,
    visible: true,
    opacity: 100,
    blendMode: 'normal',
    pixels: { kind: 'rgba8', data: image.data, width: image.width, height: image.height },
  }
  return {
    width: image.width,
    height: image.height,
    title: args.title,
    layers: [layer],
    dpi: args.dpi,
    iccProfile: args.iccProfile,
    warnings: args.warnings,
    provenance: args.provenance,
  }
}

/** File name without its extension, for the document title. */
export function stripExtension(name: string | undefined, fallback: string): string {
  if (!name) return fallback
  const base = name.slice(name.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return (dot > 0 ? base.slice(0, dot) : base) || fallback
}
