/*
 * PSD/PSB Image Resources writer (spec §8.8).
 *
 * Derived from the GIMP PSD plug-in (file-psd), Copyright 2007 John Marshall,
 * GPLv3+ — `save_resources()` in psd-export.c — and from Adobe's public
 * "Photoshop File Formats Specification". Independent TypeScript
 * re-implementation; no GIMP source was copied. Kubuno is AGPLv3.
 */
import type { ByteWriter } from '../binary/ByteWriter.ts'
import { writePascalString } from '../binary/strings.ts'
import { RESOURCE_ID } from '../constants.ts'
import { buildResolutionInfo } from '../read/imageResources.ts'
import type { PsdImageResource } from '../types.ts'

/** Resources we always recompute; the imported ones are dropped for these ids. */
const RECOMPUTED: ReadonlySet<number> = new Set([
  RESOURCE_ID.RESOLUTION_INFO,
  RESOURCE_ID.LAYER_STATE,
  RESOURCE_ID.THUMBNAIL_RGB,
  RESOURCE_ID.THUMBNAIL_BGR,
])

export function writeImageResources(
  w: ByteWriter,
  imported: readonly PsdImageResource[],
  hDpi: number,
  vDpi: number,
  activeLayerIndex: number,
): void {
  const lengthAt = w.placeholderU32()
  const start = w.length

  writeOne(w, RESOURCE_ID.RESOLUTION_INFO, '', buildResolutionInfo(hDpi, vDpi))

  const state = new Uint8Array(2)
  state[0] = (activeLayerIndex >> 8) & 0xff
  state[1] = activeLayerIndex & 0xff
  writeOne(w, RESOURCE_ID.LAYER_STATE, '', state)

  // Everything else is copied through untouched, in the original file order:
  // that is what makes ICC profiles, XMP, EXIF and paths survive a round trip.
  for (const res of imported) {
    if (RECOMPUTED.has(res.id)) continue
    writeOne(w, res.id, res.name, res.data)
  }

  w.patchU32(lengthAt, w.length - start)
}

function writeOne(w: ByteWriter, id: number, name: string, data: Uint8Array): void {
  w.ascii('8BIM', 4)
  w.u16(id)
  writePascalString(w, name, 2)
  w.u32(data.length)
  w.bytes(data)
  // The pad byte is NOT counted in the declared length.
  if (data.length % 2 === 1) w.u8(0)
}
