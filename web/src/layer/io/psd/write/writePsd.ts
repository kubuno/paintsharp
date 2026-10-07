/*
 * PSD/PSB writer orchestration — section order and length mechanics (spec §8.2).
 *
 * Derived from the GIMP PSD plug-in (file-psd), Copyright 2007 John Marshall,
 * licensed under the GNU General Public License v3 or later — `save_header()`,
 * `save_resources()`, `save_layer_and_mask()`, `save_data()` in psd-export.c —
 * and from Adobe's public "Photoshop File Formats Specification".
 *
 * This is an independent TypeScript re-implementation; no GIMP source code was
 * copied. Kubuno is AGPLv3, compatible with the GPLv3 (GPLv3 §13).
 */
import { ByteWriter } from '../binary/ByteWriter.ts'
import { PsdError } from '../errors.ts'
import { LIMITS, MAX_DIMENSION_PSD, RESOURCE_ID } from '../constants.ts'
import type {
  PsdDocument,
  PsdImage,
  PsdVersion,
  PsdWarning,
  PsdWarningCode,
  WriteOptions,
} from '../types.ts'
import { walkLayers } from '../read/tree.ts'
import { writeHeader } from './header.ts'
import { writeImageResources } from './imageResources.ts'
import { planLayers, writeLayerAndMask } from './layerAndMask.ts'
import { cpuComposite, isFullyOpaque, writeImageData } from './imageData.ts'

/**
 * Serialises a document to PSD or PSB.
 *
 * Always writes RGB / 8 bits: it is what every tool reads, and it matches the
 * Kubuno internal model exactly. Layers keep their own rectangles — the writer
 * never materialises a document-sized buffer per layer.
 */
export async function writePsd(doc: PsdDocument, options: WriteOptions = {}): Promise<ArrayBuffer> {
  const warnings: PsdWarning[] = []
  const sink = {
    warn(
      code: PsdWarningCode,
      detail?: Record<string, string | number>,
      severity: 'info' | 'warning' = 'warning',
    ): void {
      if (warnings.length < 256) warnings.push({ code, detail, severity })
    },
  }

  if (doc.width < 1 || doc.height < 1) {
    throw new PsdError('BAD_DIMENSIONS', { width: doc.width, height: doc.height })
  }
  const version = pickVersion(doc, options)
  const isPsb = version === 2

  let layerCount = 0
  walkLayers(doc.layers, () => {
    layerCount++
  })
  if (layerCount > LIMITS.MAX_LAYERS) {
    throw new PsdError('TOO_LARGE', { layers: layerCount, max: LIMITS.MAX_LAYERS })
  }

  options.onProgress?.(0.05, 'layers')
  const plans = await planLayers(doc.layers, doc.depth, doc.colorMode, sink)
  options.onProgress?.(0.4, 'channels')

  const composite = await resolveComposite(doc, options, sink)
  const channelCount: 3 | 4 = isFullyOpaque(composite.data, doc.width, doc.height) ? 3 : 4
  options.onProgress?.(0.6, 'composite')

  // A rough initial capacity: RLE usually compresses raster content by >= 3.
  const estimate = Math.min(
    LIMITS.MAX_WRITE_BUFFER,
    Math.max(256 * 1024, ((doc.width * doc.height * 4 * (layerCount + 1)) / 3) | 0),
  )
  const w = new ByteWriter(Math.min(estimate, 64 * 1024 * 1024))

  writeHeader(w, version, channelCount, doc.width, doc.height)

  // Color Mode Data: always empty, since we always write RGB (never indexed or
  // duotone). The imported bytes stay in `doc.colorModeData` for callers that
  // want to preserve them by other means.
  w.u32(0)

  writeImageResources(
    w,
    doc.resources,
    doc.resolution.hDpi,
    doc.resolution.vDpi,
    activeLayerIndex(doc),
  )
  options.onProgress?.(0.7, 'resources')

  writeLayerAndMask(w, plans, isPsb, channelCount === 4, doc.documentBlocks)
  options.onProgress?.(0.9, 'layers')

  writeImageData(w, composite.data, doc.width, doc.height, channelCount)
  options.onProgress?.(1, 'composite')

  return w.finish()
}

function pickVersion(doc: PsdDocument, options: WriteOptions): PsdVersion {
  if (options.version === 1 || options.version === 2) return options.version
  const needsPsb = doc.width > MAX_DIMENSION_PSD || doc.height > MAX_DIMENSION_PSD
  return needsPsb ? 2 : 1
}

async function resolveComposite(
  doc: PsdDocument,
  options: WriteOptions,
  sink: { warn: (c: PsdWarningCode, d?: Record<string, string | number>, s?: 'info' | 'warning') => void },
): Promise<PsdImage> {
  const given = options.composite ?? doc.composite
  if (given && given.width === doc.width && given.height === doc.height) return given
  return cpuComposite(doc, sink)
}

/** Resource 1024 stores the active layer as an index counted from the bottom. */
function activeLayerIndex(doc: PsdDocument): number {
  const res = doc.resources.find(x => x.id === RESOURCE_ID.LAYER_STATE)
  if (res && res.data.length >= 2) return (res.data[0] << 8) | res.data[1]
  return 0
}
