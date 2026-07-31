/*
 * PSD/PSB Image Resources section (spec §1.4).
 *
 * Derived from the GIMP PSD plug-in (file-psd), Copyright 2007 John Marshall,
 * licensed under the GNU General Public License v3 or later —
 * `get_image_resource_header()` / `load_image_resource()` in
 * psd-image-res-load.c — and from Adobe's public "Photoshop File Formats
 * Specification". Independent TypeScript re-implementation; no GIMP source code
 * was copied. Kubuno is AGPLv3.
 */
import { ByteReader } from '../binary/ByteReader.ts'
import { readPascalString } from '../binary/strings.ts'
import { LIMITS, RESOURCE_ID, RESOURCE_SIGNATURES } from '../constants.ts'
import type { PsdImageResource, PsdResolution, WarningSink } from '../types.ts'

/**
 * Reads every resource block. Unknown ids are kept verbatim so the export can
 * re-emit them unchanged — that is what makes a round trip non-destructive.
 *
 * A block with an unrecognised signature ends the section cleanly instead of
 * failing the import.
 */
export function readImageResources(r: ByteReader, sink: WarningSink): PsdImageResource[] {
  const out: PsdImageResource[] = []
  let guard = 0
  while (r.remaining > 6) {
    const before = r.pos
    if (guard++ > LIMITS.MAX_IMAGE_RESOURCES) {
      sink.warn('malformed-block-skipped', { section: 'image-resources', reason: 'too-many' })
      break
    }
    let signature: string
    try {
      signature = r.ascii(4)
    } catch {
      break
    }
    if (!RESOURCE_SIGNATURES.has(signature)) {
      sink.warn('malformed-block-skipped', { section: 'image-resources', signature })
      break
    }
    try {
      const id = r.u16()
      const name = readPascalString(r, 2)
      const length = r.u32()
      if (length > r.remaining) {
        sink.warn('truncated-file', { section: 'image-resources', id })
        out.push({ id, name, signature, data: r.bytes(r.remaining) })
        break
      }
      const data = r.bytes(length)
      // The pad byte is NOT counted in `length`.
      if (length % 2 === 1) r.skip(1)
      out.push({ id, name, signature, data })
    } catch {
      sink.warn('malformed-block-skipped', { section: 'image-resources' })
      break
    }
    if (r.pos <= before) break // strict progress guard against infinite loops
  }
  return out
}

const DEFAULT_RESOLUTION: PsdResolution = { hDpi: 72, vDpi: 72 }

/**
 * Decodes resource 1005 (`ResolutionInfo`): two 16.16 fixed-point densities and
 * their units (1 = pixels/inch, 2 = pixels/cm).
 */
export function readResolution(resources: readonly PsdImageResource[]): PsdResolution {
  const res = resources.find(x => x.id === RESOURCE_ID.RESOLUTION_INFO)
  if (!res || res.data.length < 16) return DEFAULT_RESOLUTION
  const r = new ByteReader(res.data)
  try {
    const hRes = r.fixed32()
    const hUnit = r.i16()
    r.i16() // width unit
    const vRes = r.fixed32()
    const vUnit = r.i16()
    const toDpi = (v: number, unit: number): number => (unit === 2 ? v * 2.54 : v)
    const hDpi = toDpi(hRes, hUnit)
    const vDpi = toDpi(vRes, vUnit)
    if (!(hDpi > 0) || !(vDpi > 0)) return DEFAULT_RESOLUTION
    return { hDpi, vDpi }
  } catch {
    return DEFAULT_RESOLUTION
  }
}

/** Resource 1024: index of the active layer, counted from the bottom. */
export function readActiveLayerIndex(resources: readonly PsdImageResource[]): number | null {
  const res = resources.find(x => x.id === RESOURCE_ID.LAYER_STATE)
  if (!res || res.data.length < 2) return null
  return (res.data[0] << 8) | res.data[1]
}

/** Builds the 16-byte payload of resource 1005 for the writer (spec §8.8). */
export function buildResolutionInfo(hDpi: number, vDpi: number): Uint8Array {
  const out = new Uint8Array(16)
  const view = new DataView(out.buffer)
  view.setInt32(0, Math.round(hDpi * 65536), false)
  view.setInt16(4, 1, false) // pixels per inch
  view.setInt16(6, 1, false) // width unit: inches
  view.setInt32(8, Math.round(vDpi * 65536), false)
  view.setInt16(12, 1, false)
  view.setInt16(14, 1, false)
  return out
}
