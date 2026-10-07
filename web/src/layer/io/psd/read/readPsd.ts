/*
 * PSD/PSB reader orchestration — pass 1 (structure) and pass 2 (pixels).
 *
 * Derived from the GIMP PSD plug-in (file-psd), Copyright 2007 John Marshall,
 * licensed under the GNU General Public License v3 or later (psd-load.c), and
 * from Adobe's public "Photoshop File Formats Specification". Independent
 * TypeScript re-implementation; no GIMP source code was copied. Kubuno is
 * AGPLv3, compatible with the GPLv3 (GPLv3 §13).
 */
import { ByteReader } from '../binary/ByteReader.ts'
import { PsdError } from '../errors.ts'
import { LIMITS } from '../constants.ts'
import type {
  PsdDocument,
  PsdLayer,
  PsdWarning,
  PsdWarningCode,
  ReadCtx,
  ReadOptions,
} from '../types.ts'
import { readHeader } from './header.ts'
import { readColorModeData } from './colorModeData.ts'
import { readImageResources, readResolution } from './imageResources.ts'
import { readLayerAndMask } from './layerAndMask.ts'
import { buildLayerTree, walkLayers } from './tree.ts'
import { readImageData } from './imageData.ts'

/** Where the Image Data section starts, kept so pass 2 can revisit it. */
interface StructureResult {
  readonly doc: PsdDocument
  readonly source: Uint8Array
  readonly imageDataOffset: number
  readonly ctx: ReadCtx
  readonly warnings: PsdWarning[]
}

/**
 * Parses everything except the pixels: header, resources, the full layer tree,
 * names, blend modes and bounds. Cheap enough for the main thread and enough to
 * populate the layers panel instantly (spec §9.2, §10.2).
 *
 * Channel pixels remain lazy: `PsdChannel.decode()` is what touches them.
 */
export function readPsdStructure(source: ArrayBuffer, options: ReadOptions = {}): PsdDocument {
  return parseStructure(source, options).doc
}

function parseStructure(source: ArrayBuffer, options: ReadOptions): StructureResult {
  const limits = { ...LIMITS, ...options.limits }
  if (source.byteLength > limits.MAX_FILE_BYTES) {
    throw new PsdError('TOO_LARGE', { bytes: source.byteLength, max: limits.MAX_FILE_BYTES })
  }
  const bytes = new Uint8Array(source)
  const warnings: PsdWarning[] = []
  const sink = {
    warn(
      code: PsdWarningCode,
      detail?: Record<string, string | number>,
      severity: 'info' | 'warning' = 'warning',
    ): void {
      // Deduplicate: a truncated file would otherwise emit one warning per row.
      const key = code + JSON.stringify(detail ?? {})
      if (warnings.some(w => w.code + JSON.stringify(w.detail ?? {}) === key)) return
      if (warnings.length > 256) return
      warnings.push({ code, detail, severity })
    },
  }

  const r = new ByteReader(bytes)
  const header = readHeader(r, sink)
  options.onProgress?.(0.05, 'header')

  const ctx: ReadCtx = {
    isPsb: header.version === 2,
    depth: header.depth,
    colorMode: header.colorMode,
    limits,
    budget: { remaining: limits.MAX_TOTAL_LAYER_BYTES },
    warn: sink.warn,
  }

  const colorModeData = readColorModeData(r, sink)

  // Image Resources run on a sub-reader bounded to the declared section length,
  // then we reposition on that declared end rather than trusting the cursor.
  const resourcesLength = r.remaining >= 4 ? Math.min(r.u32(), r.remaining) : 0
  const resourcesStart = r.pos
  const resources = readImageResources(r.sub(resourcesLength), sink)
  r.seekTo(resourcesStart + resourcesLength)
  options.onProgress?.(0.15, 'resources')

  const lm = readLayerAndMask(r, ctx)
  const layers: PsdLayer[] = buildLayerTree(lm.layers, sink)
  options.onProgress?.(0.5, 'layers')

  let layerCount = 0
  walkLayers(layers, () => {
    layerCount++
  })
  if (layerCount > limits.MAX_LAYERS) {
    throw new PsdError('TOO_LARGE', { layers: layerCount, max: limits.MAX_LAYERS })
  }

  const doc: PsdDocument = {
    version: header.version,
    width: header.width,
    height: header.height,
    channels: header.channels,
    depth: header.depth,
    colorMode: header.colorMode,
    colorModeData,
    resources,
    layers,
    globalMask: lm.globalMask,
    documentBlocks: lm.documentBlocks,
    composite: null,
    resolution: readResolution(resources),
    warnings,
    compositeHasAlpha: lm.compositeHasAlpha,
  }

  return { doc, source: bytes, imageDataOffset: r.pos, ctx, warnings }
}

/**
 * Parses a PSD or PSB file.
 *
 * Recoverable problems are reported through `PsdDocument.warnings`; `PsdError`
 * is thrown only when the file cannot be interpreted at all.
 */
export async function readPsd(source: ArrayBuffer, options: ReadOptions = {}): Promise<PsdDocument> {
  const st = parseStructure(source, options)
  const { doc, ctx } = st

  let composite = null
  if (options.composite !== false) {
    const r = new ByteReader(st.source, st.imageDataOffset, st.source.length)
    composite = await readImageData(
      r,
      doc.width,
      doc.height,
      doc.channels,
      doc.depth,
      doc.colorMode,
      ctx.isPsb,
      doc.colorModeData,
      doc.resources,
      ctx,
    )
    options.onProgress?.(0.75, 'composite')
  }

  if (options.eager) {
    const all: PsdLayer[] = []
    walkLayers(doc.layers, l => all.push(l))
    for (let i = 0; i < all.length; i++) {
      for (const ch of all[i].channels) {
        // Sequential on purpose: decoding one channel at a time keeps the peak
        // allocation flat instead of multiplying it by the layer count (§9.3-4).
        await ch.decode()
      }
      options.onProgress?.(0.75 + (0.25 * (i + 1)) / Math.max(1, all.length), 'channels')
    }
  }

  options.onProgress?.(1, 'channels')
  return { ...doc, composite }
}
