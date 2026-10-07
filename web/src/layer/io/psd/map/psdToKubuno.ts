/*
 * PsdDocument -> Kubuno layer model bridge (spec §7).
 *
 * This file contains no format parsing: the pivot `PsdDocument` is faithful to
 * the file, and the degradation to `LayerStructureItem` happens here. Keeping
 * the two apart is what lets the Kubuno model evolve (extensions E1-E11)
 * without touching the parser, and lets the parser be tested on its own.
 *
 * Kubuno is AGPLv3.
 */
import type { LayerStructureItem } from '../../../../api.ts'
import { uid } from '../../../../uid.ts'
import { PSD_COLOR_TAGS } from '../constants.ts'
import { CHANNEL_ID } from '../constants.ts'
import { channelsToRgba8 } from '../color/convert.ts'
import { expandTo8 } from '../color/depth.ts'
import { psdBlendToKubuno } from './blendModes.ts'
import type {
  PsdDocument,
  PsdLayer,
  PsdWarning,
  PsdWarningCode,
  WarningSink,
} from '../types.ts'
import { rectHeight, rectWidth } from '../types.ts'

/** Pixels for one layer, at the LAYER's rectangle — never document-sized. */
export interface PlacedPixels {
  readonly data: Uint8Array
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export interface KubunoImport {
  readonly width: number
  readonly height: number
  readonly dpi: number
  /** Tree, TOP layer first. */
  readonly layers: LayerStructureItem[]
  /**
   * RGBA8, non-premultiplied, keyed by `LayerStructureItem.id`.
   *
   * ⚠️ Deliberately NOT expanded to the document size: the current Kubuno model
   * stores one document-sized texture per layer, which costs 3.8 GB for a
   * 40-layer 6000x4000 document (spec §7.3 "E1", §9.3). Handing over the tight
   * rectangle plus its offset lets the caller decide, and stops this module
   * from making the problem worse.
   */
  readonly pixels: Map<string, PlacedPixels>
  readonly masks: Map<string, PlacedPixels>
  readonly warnings: PsdWarning[]
}

/**
 * Converts a parsed document to the Kubuno layer model.
 *
 * Decodes channels sequentially (never in parallel) so the peak allocation
 * stays flat rather than being multiplied by the layer count.
 */
export async function psdToKubuno(doc: PsdDocument): Promise<KubunoImport> {
  const warnings: PsdWarning[] = [...doc.warnings]
  const sink: WarningSink = {
    warn(code: PsdWarningCode, detail?, severity: 'info' | 'warning' = 'warning'): void {
      if (warnings.length < 512) warnings.push({ code, detail, severity })
    },
  }
  const pixels = new Map<string, PlacedPixels>()
  const masks = new Map<string, PlacedPixels>()

  const layers = await convertAll(doc, doc.layers, pixels, masks, sink)

  return {
    width: doc.width,
    height: doc.height,
    dpi: Math.round(doc.resolution.hDpi) || 72,
    layers,
    pixels,
    masks,
    warnings,
  }
}

async function convertAll(
  doc: PsdDocument,
  layers: readonly PsdLayer[],
  pixels: Map<string, PlacedPixels>,
  masks: Map<string, PlacedPixels>,
  sink: WarningSink,
): Promise<LayerStructureItem[]> {
  const out: LayerStructureItem[] = []
  for (const layer of layers) {
    out.push(await convertOne(doc, layer, pixels, masks, sink))
  }
  return out
}

async function convertOne(
  doc: PsdDocument,
  layer: PsdLayer,
  pixels: Map<string, PlacedPixels>,
  masks: Map<string, PlacedPixels>,
  sink: WarningSink,
): Promise<LayerStructureItem> {
  const id = uid()
  const blend = psdBlendToKubuno(layer.blendMode)
  if (blend.warning) sink.warn(blend.warning, { layer: layer.name, key: layer.blendMode }, 'info')

  const item: LayerStructureItem = {
    id,
    type: kubunoType(layer),
    name: layer.name,
    visible: layer.visible,
    locked: layer.locks.all || layer.locks.composite,
    opacity: Math.round((layer.opacity * 100) / 255),
    fill: Math.round((layer.fillOpacity * 100) / 255),
    blendMode: blend.mode,
    mask: null,
    effects: [],
    lockAlpha: layer.locks.alpha || undefined,
    lockPosition: layer.locks.position || undefined,
    clipping: layer.clipping || undefined,
    colorLabel: PSD_COLOR_TAGS[layer.colorTag] ?? undefined,
  }

  if (layer.kind === 'group') {
    item.expanded = layer.expanded
    item.children = await convertAll(doc, layer.children, pixels, masks, sink)
    return item
  }

  if (layer.adjustment) {
    // Unsupported adjustments become inert layers rather than disappearing: the
    // raw block is still in `PsdLayer.blocks` and is re-emitted on export.
    item.adjustment = { kind: 'unsupported', psdKey: layer.adjustment.key }
    item.visible = false
    sink.warn('adjustment-unsupported', { layer: layer.name, key: layer.adjustment.key })
  }

  const w = rectWidth(layer.rect)
  const h = rectHeight(layer.rect)
  if (w > 0 && h > 0) {
    const raw: { id: number; data: Uint8Array }[] = []
    for (const ch of layer.channels) {
      if (ch.id === CHANNEL_ID.USER_MASK || ch.id === CHANNEL_ID.REAL_MASK) continue
      raw.push({ id: ch.id, data: await ch.decode() })
    }
    if (raw.length > 0) {
      const data = channelsToRgba8(raw, w, h, doc.depth, doc.colorMode, sink)
      pixels.set(id, { data, x: layer.rect.left, y: layer.rect.top, w, h })
    }
  }

  const mask = await extractMask(layer, doc.depth)
  if (mask) {
    const maskId = uid()
    item.mask = { enabled: !(layer.mask?.disabled ?? false), inverted: false, layerId: maskId }
    masks.set(maskId, mask)
    if (layer.mask?.density != null || layer.mask?.feather != null) {
      sink.warn('unknown-blocks-preserved', { layer: layer.name, lost: 'mask-density-feather' })
    }
  }

  return item
}

async function extractMask(
  layer: PsdLayer,
  depth: PsdDocument['depth'],
): Promise<PlacedPixels | null> {
  if (!layer.mask) return null
  // Channel -3 (rasterised vector mask) wins over -2 when both exist.
  const real = layer.channels.find(c => c.id === CHANNEL_ID.REAL_MASK)
  const user = layer.channels.find(c => c.id === CHANNEL_ID.USER_MASK)
  const chosen = real ?? user
  if (!chosen) return null
  const rect = chosen === real ? layer.mask.real?.rect ?? layer.mask.rect : layer.mask.rect
  const w = rectWidth(rect)
  const h = rectHeight(rect)
  if (w <= 0 || h <= 0) return null

  const gray = depth === 8 ? await chosen.decode() : expandTo8(await chosen.decode(), depth, w, h)
  // Kubuno stores a mask as RGBA: the value goes into R, G, B AND A, because
  // the compositing shader reads the alpha channel.
  const data = new Uint8Array(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    const v = gray[i] ?? 0
    data[i * 4] = v
    data[i * 4 + 1] = v
    data[i * 4 + 2] = v
    data[i * 4 + 3] = v
  }
  return { data, x: rect.left, y: rect.top, w, h }
}

function kubunoType(layer: PsdLayer): LayerStructureItem['type'] {
  switch (layer.kind) {
    case 'group':
      return 'group'
    case 'adjustment':
      return 'adjustment'
    case 'text':
      // P0 keeps the pixels Photoshop already rendered: a rasterised text layer
      // looks right, an un-rendered one does not.
      return 'raster'
    default:
      return 'raster'
  }
}
