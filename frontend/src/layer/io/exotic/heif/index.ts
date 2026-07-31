// SPDX-License-Identifier: AGPL-3.0-or-later
//
// HEIC/HEIF import — native paths only.
//
// Scope, stated plainly: no HEVC decoder is bundled. On Apple platforms — which is where
// HEIC files are produced — the system decoder handles them and the import is lossless
// in practice. Everywhere else the user gets a clear, actionable message rather than a
// crash or a blank canvas. Adding libheif in WebAssembly would settle the copyright
// question and leave the HEVC patent question open; that trade is not ours to make
// silently.

import { bitmapToRgba, singleLayerDocument, stripExtension } from '../bitmap'
import { ImportError, throwIfAborted, toImportError } from '../errors'
import { ImportWarningSink, importWarn, type DecodeOptions, type ImportedDocument } from '../types'
import { detectHeifPath, type HeifPath } from './capability'
import { readHeifInfo, type HeifInfo } from './container'

export { detectHeifPath, resetHeifCapabilityCache } from './capability'
export { readHeifInfo } from './container'
export type { HeifPath, HeifInfo }

interface ImageDecoderCtor {
  new (init: { data: Uint8Array; type: string }): {
    decode(): Promise<{ image: { close(): void; codedWidth: number; codedHeight: number } }>
    close(): void
  }
}

export async function decodeHeif(
  bytes: Uint8Array,
  opts: DecodeOptions = {},
): Promise<ImportedDocument> {
  try {
    const warn = new ImportWarningSink()
    throwIfAborted(opts.signal)

    // The container is read on every path: the browser decodes the pixels but tells us
    // nothing about rotation, tiling, HDR or how many images the file holds.
    const info = readHeifInfo(bytes)
    const path = await detectHeifPath(bytes)
    throwIfAborted(opts.signal)

    if (path === 'none') {
      throw new ImportError(
        'capability-missing',
        'layer.io.err.heif_capability_missing',
        { format: info.isAvif ? 'AVIF' : 'HEIC' },
        `no native HEIF decoder; brands=${info.brands.join(',')}`,
      )
    }

    const source = await decodeNatively(bytes, path)
    opts.onProgress?.(0.8)

    // The platform pipeline already honours `irot`/`imir`, so applying them again would
    // rotate the picture twice. Only the WebCodecs path hands back the coded frame.
    const orientation = path === 'imagedecoder' ? exifOrientationFor(info) : 1
    let image
    try {
      image = bitmapToRgba(source, orientation)
    } finally {
      source.close()
    }
    opts.onProgress?.(1)

    describe(info, warn)

    return singleLayerDocument(image, {
      title: stripExtension(opts.name, 'HEIF'),
      layerName: 'Image',
      warnings: warn.list(),
      iccProfile: info.iccProfile,
      provenance:
        `${info.isAvif ? 'AVIF' : 'HEIC'}` +
        (info.grid ? ` · grid ${info.grid.columns}×${info.grid.rows}` : '') +
        ` · ${path} path` +
        (info.rotation ? ` · rot ${info.rotation}°` : '') +
        (isHdr(info) ? ` · HDR ${transferName(info.transferCharacteristics)} → SDR` : ''),
    })
  } catch (e) {
    throw toImportError(e, 'heif')
  }
}

async function decodeNatively(bytes: Uint8Array, path: HeifPath): Promise<ImageBitmap> {
  const blob = new Blob([bytes.slice()], { type: 'image/heic' })
  if (path === 'imagedecoder') {
    const Ctor = (globalThis as { ImageDecoder?: ImageDecoderCtor }).ImageDecoder
    if (Ctor) {
      const decoder = new Ctor({ data: bytes, type: 'image/heic' })
      try {
        const { image } = await decoder.decode()
        try {
          // A VideoFrame is an acceptable `createImageBitmap` source, and going through
          // it normalises NV12/P010 into RGBA without a manual colour conversion.
          return await createImageBitmap(image as unknown as ImageBitmapSource)
        } finally {
          image.close()
        }
      } finally {
        decoder.close()
      }
    }
  }
  return createImageBitmap(blob)
}

/** `irot`/`imir` expressed as the equivalent EXIF orientation, for the WebCodecs path. */
function exifOrientationFor(info: HeifInfo): number {
  const rot = ((info.rotation % 360) + 360) % 360
  if (info.mirror === undefined) {
    return rot === 90 ? 8 : rot === 180 ? 3 : rot === 270 ? 6 : 1
  }
  // Mirrored variants: 2 = flip-x, 4 = flip-y, 5/7 = flip + quarter turn.
  if (rot === 0) return info.mirror === 0 ? 2 : 4
  if (rot === 180) return info.mirror === 0 ? 4 : 2
  return rot === 90 ? 7 : 5
}

function isHdr(info: HeifInfo): boolean {
  return info.transferCharacteristics === 16 || info.transferCharacteristics === 18
}

function transferName(tc: number | undefined): string {
  return tc === 16 ? 'PQ' : tc === 18 ? 'HLG' : 'SDR'
}

function describe(info: HeifInfo, warn: ImportWarningSink): void {
  if (info.imageCount > 1) {
    warn.warn(importWarn('heif.collection-first-image-only', { count: info.imageCount }))
  }
  if (isHdr(info)) {
    // The platform decoder already tone-maps to the display space; we say so rather than
    // doing it twice, but the user must know the file carried more range than Layer's
    // 8-bit sRGB pipeline can hold.
    warn.warn(importWarn('heif.hdr-converted-to-sdr', { transfer: transferName(info.transferCharacteristics) }))
  }
  if (info.iccProfile) warn.warn(importWarn('heif.icc-not-applied'))
}
