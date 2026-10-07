/*
 * Kubuno layer model -> PsdDocument bridge (spec §7, §8.5).
 *
 * Kubuno stores one DOCUMENT-SIZED texture per layer; PSD stores each layer at
 * its own rectangle. This file performs the re-cropping (tight alpha bounding
 * box) so the exported file stays small and Photoshop-idiomatic.
 *
 * Kubuno is AGPLv3.
 */
import type { LayerStructureItem } from '../../../../api.ts'
import { CHANNEL_ID, COLOR_MODE } from '../constants.ts'
import { kubunoBlendToPsd } from './blendModes.ts'
import { alphaBounds, cropRgba, maskBounds, cropGray, splitRgba } from '../write/bounds.ts'
import type { PsdChannel, PsdDocument, PsdLayer, PsdRect } from '../types.ts'

export interface KubunoExport {
  readonly width: number
  readonly height: number
  readonly dpi: number
  /** Tree, TOP layer first. */
  readonly layers: readonly LayerStructureItem[]
  /** Full-document RGBA8 for a layer, or null when it has no pixels. */
  readonly readPixels: (layerId: string) => Uint8Array | null
  readonly readMask: (layerId: string) => Uint8Array | null
  /** Full-document RGBA8 flattened preview. */
  readonly composite: Uint8Array
  readonly activeLayerId?: string
}

/** Wraps in-memory bytes as a `PsdChannel` (no lazy decoding needed). */
function staticChannel(id: number, samples: Uint8Array): PsdChannel {
  return {
    id,
    dataLength: samples.length,
    offset: -1,
    decode: () => Promise.resolve(samples),
  }
}

const PSD_COLOR_HEX: readonly (string | null)[] = [
  null, '#ef4444', '#f59e0b', '#eab308', '#22c55e', '#3b82f6', '#a855f7',
]

function colorTagOf(hex: string | undefined): number {
  if (!hex) return 0
  const i = PSD_COLOR_HEX.indexOf(hex)
  return i > 0 ? i : 0
}

/**
 * Builds a `PsdDocument` from the Kubuno model. Synchronous: every channel is
 * already in memory, so `writePsd` can run without any further decoding.
 */
export function kubunoToPsd(input: KubunoExport): PsdDocument {
  const layers = input.layers.map(l => convert(l, input))
  return {
    version: 1,
    width: input.width,
    height: input.height,
    channels: 4,
    depth: 8,
    colorMode: COLOR_MODE.RGB,
    colorModeData: null,
    resources: [],
    layers,
    globalMask: null,
    documentBlocks: [],
    composite: { width: input.width, height: input.height, data: input.composite },
    resolution: { hDpi: input.dpi, vDpi: input.dpi },
    warnings: [],
    compositeHasAlpha: true,
  }
}

const EMPTY_RECT: PsdRect = { top: 0, left: 0, bottom: 0, right: 0 }

function convert(item: LayerStructureItem, input: KubunoExport): PsdLayer {
  const base = {
    name: item.name,
    id: null,
    opacity: Math.round((item.opacity / 100) * 255),
    fillOpacity: Math.round(((item.fill ?? 100) / 100) * 255),
    // `pass-through` is only legal on a folder; the writer guards it too.
    blendMode: kubunoBlendToPsd(item.blendMode),
    visible: item.visible,
    clipping: item.clipping === true,
    locks: {
      all: item.locked === true,
      alpha: item.lockAlpha === true,
      composite: false,
      position: item.lockPosition === true,
    },
    colorTag: colorTagOf(item.colorLabel),
    mask: null,
    effects: null,
    adjustment: null,
    text: null,
    blocks: [],
    blendingRanges: null,
    flags: 0,
  }

  if (item.type === 'group') {
    return {
      ...base,
      kind: 'group',
      rect: EMPTY_RECT,
      expanded: item.expanded !== false,
      channels: [],
      children: (item.children ?? []).map(c => convert(c, input)),
    }
  }

  const px = input.readPixels(item.id)
  const rect = px ? alphaBounds(px, input.width, input.height) : null
  const channels: PsdChannel[] = []
  let maskInfo: PsdLayer['mask'] = null

  if (item.mask) {
    const maskPx = input.readMask(item.mask.layerId)
    if (maskPx) {
      // The Kubuno mask is RGBA at document size; only one channel matters.
      const gray = new Uint8Array(input.width * input.height)
      for (let i = 0; i < gray.length; i++) gray[i] = maskPx[i * 4 + 3]
      const defaultColor = pickDefaultColor(gray, input.width, input.height)
      const mrect = maskBounds(gray, input.width, input.height, defaultColor)
      if (mrect) {
        maskInfo = {
          rect: mrect,
          defaultColor,
          flags: item.mask.enabled ? 0 : 0x02,
          disabled: !item.mask.enabled,
          relative: false,
          fromRender: false,
          real: null,
          density: null,
          feather: null,
        }
        channels.push(staticChannel(CHANNEL_ID.USER_MASK, cropGray(gray, input.width, mrect)))
      }
    }
  }

  if (px && rect) {
    const w = rect.right - rect.left
    const h = rect.bottom - rect.top
    const cropped = cropRgba(px, input.width, rect)
    const { r, g, b, a } = splitRgba(cropped, w * h)
    // ⚠️ The alpha channel comes FIRST in a layer's channel list.
    channels.push(staticChannel(CHANNEL_ID.TRANSPARENCY, a))
    channels.push(staticChannel(0, r))
    channels.push(staticChannel(1, g))
    channels.push(staticChannel(2, b))
  }

  return {
    ...base,
    kind: item.type === 'adjustment' ? 'adjustment' : 'raster',
    rect: rect ?? EMPTY_RECT,
    expanded: false,
    channels,
    mask: maskInfo,
    children: [],
  }
}

/** The mask value that dominates the border, used outside the mask rectangle. */
function pickDefaultColor(gray: Uint8Array, w: number, h: number): number {
  if (w <= 0 || h <= 0) return 255
  let white = 0
  let total = 0
  const sample = (i: number): void => {
    if (gray[i] > 127) white++
    total++
  }
  for (let x = 0; x < w; x++) {
    sample(x)
    sample((h - 1) * w + x)
  }
  for (let y = 0; y < h; y++) {
    sample(y * w)
    sample(y * w + w - 1)
  }
  return total > 0 && white * 2 >= total ? 255 : 0
}
