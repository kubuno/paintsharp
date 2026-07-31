/*
 * PSD/PSB channel-data writer helpers (spec §8.5).
 *
 * Derived from the GIMP PSD plug-in (file-psd), Copyright 2007 John Marshall,
 * GPLv3+ — `save_layer_and_mask()` / `save_data()` in psd-export.c — and from
 * Adobe's public "Photoshop File Formats Specification". Independent TypeScript
 * re-implementation; no GIMP source was copied. Kubuno is AGPLv3.
 */
import { encodeChannelRle } from '../compression/index.ts'
import { CHANNEL_ID } from '../constants.ts'
import { channelsToRgba8 } from '../color/convert.ts'
import { expandTo8 } from '../color/depth.ts'
import { splitRgba } from './bounds.ts'
import type { PsdColorMode, PsdDepth, PsdLayer, WarningSink } from '../types.ts'
import { rectHeight, rectWidth } from '../types.ts'

/** The four 8-bit planes a raster layer is written from. */
export interface LayerPlanes {
  readonly width: number
  readonly height: number
  readonly r: Uint8Array
  readonly g: Uint8Array
  readonly b: Uint8Array
  readonly a: Uint8Array
}

/**
 * Decodes a layer's channels and normalises them to 8-bit RGBA planes at the
 * layer's OWN rectangle. Never expands to the document size.
 *
 * Returns null when the layer has no pixels (group markers, adjustment layers,
 * empty rectangles) — such a layer is written with empty channels.
 */
export async function layerPlanes(
  layer: PsdLayer,
  depth: PsdDepth,
  colorMode: PsdColorMode,
  sink: WarningSink,
): Promise<LayerPlanes | null> {
  const width = rectWidth(layer.rect)
  const height = rectHeight(layer.rect)
  if (width <= 0 || height <= 0) return null

  const raw: { id: number; data: Uint8Array }[] = []
  for (const ch of layer.channels) {
    if (ch.id === CHANNEL_ID.USER_MASK || ch.id === CHANNEL_ID.REAL_MASK) continue
    raw.push({ id: ch.id, data: await ch.decode() })
  }
  if (raw.length === 0) return null

  const rgba = channelsToRgba8(raw, width, height, depth, colorMode, sink)
  const { r, g, b, a } = splitRgba(rgba, width * height)
  return { width, height, r, g, b, a }
}

/**
 * The mask channel a layer should be written with, at the mask's own rectangle.
 * Channel -3 (rasterised vector mask) wins over -2 when both exist.
 */
export async function layerMaskPlane(
  layer: PsdLayer,
  depth: PsdDepth,
): Promise<Uint8Array | null> {
  if (!layer.mask) return null
  const real = layer.channels.find(c => c.id === CHANNEL_ID.REAL_MASK)
  const user = layer.channels.find(c => c.id === CHANNEL_ID.USER_MASK)
  const chosen = real ?? user
  if (!chosen) return null
  const rect = chosen === real ? layer.mask.real?.rect ?? layer.mask.rect : layer.mask.rect
  const w = rectWidth(rect)
  const h = rectHeight(rect)
  if (w <= 0 || h <= 0) return null
  const data = await chosen.decode()
  if (depth === 8) return data
  return expandTo8(data, depth, w, h)
}

/** An empty channel: just the `uint16 compression` header (dataLength === 2). */
export function emptyChannelPayload(): Uint8Array {
  return new Uint8Array([0, 0])
}

/**
 * Encodes one 8-bit plane. RLE is used unconditionally for 8-bit data: it is
 * universally readable and a flat area costs ~2 bytes per row (spec §3.6).
 */
export function encodePlane(
  samples: Uint8Array,
  width: number,
  height: number,
  isPsb: boolean,
): Uint8Array {
  if (width <= 0 || height <= 0) return emptyChannelPayload()
  return encodeChannelRle(samples, width, height, 8, isPsb)
}
