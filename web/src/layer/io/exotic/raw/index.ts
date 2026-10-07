// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Camera RAW import — orchestration.
//
// Scope is the embedded JPEG preview and nothing else (see `preview.ts` for why). The
// user is told so with a warning rather than a dialog: "camera preview — the raw sensor
// data is not developed".

import { bitmapToRgba, decodeBlobToBitmap, singleLayerDocument, stripExtension } from '../bitmap'
import { ImportError, throwIfAborted, toImportError } from '../errors'
import { ImportWarningSink, importWarn, type DecodeOptions, type ImportedDocument } from '../types'
import { findLargestPreview, type RawFormatId } from './preview'
import type { UnsupportedRawId } from './perFormat'

export type { RawFormatId }

/** Human names used in the "unsupported family" message. */
const UNSUPPORTED_LABEL: Readonly<Record<UnsupportedRawId, string>> = {
  'raw-crw': 'Canon CRW',
  'raw-x3f': 'Sigma X3F (Foveon)',
  'raw-mrw': 'Minolta MRW',
}

const FORMAT_LABEL: Readonly<Record<RawFormatId, string>> = {
  'raw-cr2': 'Canon CR2',
  'raw-cr3': 'Canon CR3',
  'raw-nef': 'Nikon NEF',
  'raw-arw': 'Sony ARW',
  'raw-dng': 'Adobe DNG',
  'raw-orf': 'Olympus ORF',
  'raw-raf': 'Fujifilm RAF',
  'raw-rw2': 'Panasonic RW2',
  'raw-tiff-generic': 'Camera RAW',
}

/** Explicit refusal for the families we will never read; no byte scan, no false hope. */
export function rejectUnsupportedRaw(id: UnsupportedRawId): never {
  throw new ImportError(
    'unsupported-format',
    'layer.io.err.raw_unsupported_family',
    { family: UNSUPPORTED_LABEL[id] },
  )
}

export async function decodeRaw(
  bytes: Uint8Array,
  format: RawFormatId,
  opts: DecodeOptions = {},
): Promise<ImportedDocument> {
  try {
    const warn = new ImportWarningSink()
    throwIfAborted(opts.signal)

    const preview = await findLargestPreview(bytes, format, warn, async (payload) => {
      const bitmap = await decodeBlobToBitmap(payload, 'image/jpeg')
      bitmap.close()
      return true
    })
    if (!preview) {
      throw new ImportError('unsupported-format', 'layer.io.err.raw_no_preview', {
        family: FORMAT_LABEL[format],
      })
    }
    opts.onProgress?.(0.6)
    throwIfAborted(opts.signal)

    const bitmap = await decodeBlobToBitmap(preview.bytes, 'image/jpeg')
    let image
    try {
      image = bitmapToRgba(bitmap, preview.orientation)
    } finally {
      bitmap.close()
    }
    opts.onProgress?.(1)

    warn.warn(importWarn('raw.embedded-preview-only', { family: FORMAT_LABEL[format] }))

    const dims = preview.width && preview.height ? `${preview.width}×${preview.height}` : `${image.width}×${image.height}`
    return singleLayerDocument(image, {
      title: stripExtension(opts.name, FORMAT_LABEL[format]),
      layerName: 'Preview',
      warnings: warn.list(),
      provenance:
        `${FORMAT_LABEL[format]} · embedded preview ${preview.source} ${dims}` +
        (preview.orientation !== 1 ? ` · orientation ${preview.orientation}` : ''),
    })
  } catch (e) {
    throw toImportError(e, 'raw')
  }
}
