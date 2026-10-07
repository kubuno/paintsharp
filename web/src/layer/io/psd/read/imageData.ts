/*
 * PSD/PSB Image Data section — the flattened composite preview (spec §1.8).
 *
 * Derived from the GIMP PSD plug-in (file-psd), Copyright 2007 John Marshall,
 * GPLv3+ (psd-load.c, merged-image handling) and from Adobe's public
 * "Photoshop File Formats Specification". Independent TypeScript
 * re-implementation; no GIMP source was copied. Kubuno is AGPLv3.
 */
import type { ByteReader } from '../binary/ByteReader.ts'
import { decodeImageData } from '../compression/index.ts'
import { colorChannelCount, RESOURCE_ID } from '../constants.ts'
import { channelsToRgba8 } from '../color/convert.ts'
import type {
  PsdColorMode,
  PsdDepth,
  PsdImage,
  PsdImageResource,
  WarningSink,
} from '../types.ts'

/**
 * Decodes the composite. Channels are planar and follow the colour model order
 * (RGB: R, G, B, [A], [extra alphas]).
 *
 * Returns null when the section is missing or unusable — never throws: a
 * document without a preview is still perfectly importable.
 */
export async function readImageData(
  r: ByteReader,
  width: number,
  height: number,
  channelCount: number,
  depth: PsdDepth,
  colorMode: PsdColorMode,
  isPsb: boolean,
  colorModeData: Uint8Array | null,
  resources: readonly PsdImageResource[],
  sink: WarningSink,
): Promise<PsdImage | null> {
  if (r.remaining < 2 || width <= 0 || height <= 0) return null
  const payload = r.peekBytes(r.remaining)
  const colorChannels = colorChannelCount(colorMode)
  // Extra channels beyond colour + alpha are spot channels: skipped, warned.
  const usable = Math.min(channelCount, colorChannels + 1)
  if (channelCount > usable) {
    sink.warn('channels-dropped', { dropped: channelCount - usable }, 'info')
  }

  let planes: Uint8Array[]
  try {
    planes = await decodeImageData(payload, width, height, channelCount, depth, isPsb, sink)
  } catch {
    sink.warn('malformed-block-skipped', { section: 'image-data' })
    return null
  }

  const raw: { id: number; data: Uint8Array }[] = []
  for (let i = 0; i < usable; i++) {
    raw.push({ id: i < colorChannels ? i : -1, data: planes[i] })
  }

  const transparentIndexRes = resources.find(x => x.id === RESOURCE_ID.TRANSPARENT_INDEX)
  const transparentIndex =
    transparentIndexRes && transparentIndexRes.data.length >= 2
      ? (transparentIndexRes.data[0] << 8) | transparentIndexRes.data[1]
      : null

  const data = channelsToRgba8(raw, width, height, depth, colorMode, sink, {
    palette: colorModeData,
    transparentIndex,
    opaque: usable <= colorChannels,
  })
  return { width, height, data }
}
