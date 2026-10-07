// SPDX-License-Identifier: AGPL-3.0-or-later
//
// XCF decoding logic derived from the GIMP source code (app/xcf/xcf-load.c
// `xcf_load_magic_version`, app/xcf/xcf-private.h, app/xcf/xcf.c), Copyright (C) 1995
// Spencer Kimball and Peter Mattis and the GIMP contributors, licensed GPL-3.0-or-later.
// Reimplemented in TypeScript for Kubuno (AGPL-3.0-or-later).

import { ImportError } from '../errors'
import { decodePrecision, type XcfPrecision } from './precision'
import { XcfReader } from './reader'

/** `"gimp xcf "` — the 9 bytes shared by every version, old and new. */
export const XCF_MAGIC = 'gimp xcf '

/** Tiles are always 64×64 (XCF_TILE_WIDTH / XCF_TILE_HEIGHT). */
export const XCF_TILE_SIZE = 64

/** Highest version GIMP master currently writes. Newer files are attempted, not refused. */
export const XCF_MAX_KNOWN_VERSION = 25

export type XcfBaseType = 'rgb' | 'gray' | 'indexed'

export interface XcfHeader {
  readonly version: number
  readonly width: number
  readonly height: number
  readonly baseType: XcfBaseType
  readonly precision: XcfPrecision
  /** Whether the `precision` value was recognised for this version. */
  readonly precisionKnown: boolean
  /** 4 up to version 10, 8 from version 11 — this conditions EVERY pointer in the file. */
  readonly bytesPerOffset: 4 | 8
  /**
   * From version 12 on, multi-byte tile components are explicitly big-endian. Before
   * that, they carry the native order of the machine that wrote the file, which in
   * practice means little-endian (§4.7).
   */
  readonly componentsBigEndian: boolean
  /** Newer than anything we know about: decode anyway, but say so. */
  readonly future: boolean
}

/**
 * Parses the 26-byte (or 30-byte, version >= 4) header and leaves the reader positioned
 * on the image property list.
 */
export function readHeader(r: XcfReader): XcfHeader {
  if (r.size < 26) {
    throw new ImportError('truncated', 'layer.io.err.truncated', undefined, `file is ${r.size} bytes`)
  }
  const id = r.latin1(0, 14)
  if (!id.startsWith(XCF_MAGIC)) {
    throw new ImportError('unknown-format', 'layer.io.err.unknown_format', undefined, 'missing "gimp xcf " magic')
  }

  // `"gimp xcf file\0"` is version 0; `"gimp xcf v%03d\0"` is version >= 1.
  const tail = id.slice(9)
  let version: number
  if (tail === 'file') {
    version = 0
  } else if (tail.length === 4 && tail[0] === 'v' && /^[0-9]{3}$/.test(tail.slice(1))) {
    version = Number.parseInt(tail.slice(1), 10)
  } else {
    throw new ImportError('corrupt', 'layer.io.err.corrupt', undefined, `unreadable version tag "${tail}"`)
  }
  if (!Number.isFinite(version) || version < 0) {
    throw new ImportError('corrupt', 'layer.io.err.corrupt', undefined, `bad version ${version}`)
  }

  r.pos = 14
  const width = r.u32()
  const height = r.u32()
  const baseRaw = r.u32()
  const baseType: XcfBaseType = baseRaw === 1 ? 'gray' : baseRaw === 2 ? 'indexed' : 'rgb'
  if (baseRaw > 2) {
    throw new ImportError('corrupt', 'layer.io.err.corrupt', undefined, `unknown base type ${baseRaw}`)
  }

  let precisionRaw = 0
  if (version >= 4) precisionRaw = r.u32()
  const { precision, known } = decodePrecision(precisionRaw, version)

  const bytesPerOffset: 4 | 8 = version >= 11 ? 8 : 4
  r.bytesPerOffset = bytesPerOffset

  // Indexed images are forced to 8 bits per component by GIMP (`gimp_babl_is_valid`),
  // whatever the header claims.
  const effective: XcfPrecision =
    baseType === 'indexed' && precision.bytesPerComponent !== 1
      ? { bytesPerComponent: 1, kind: 'uint', trc: precision.trc, label: 'u8 (indexed)' }
      : precision

  return {
    version,
    width,
    height,
    baseType,
    precision: effective,
    precisionKnown: known,
    bytesPerOffset,
    componentsBigEndian: version >= 12,
    future: version > XCF_MAX_KNOWN_VERSION,
  }
}

/** `GimpImageType` of a layer -> channel layout (`xcf-load.c` layer type switch). */
export interface XcfLayerType {
  readonly base: XcfBaseType
  readonly hasAlpha: boolean
  readonly components: number
}

export function layerType(type: number): XcfLayerType | null {
  switch (type) {
    case 0:
      return { base: 'rgb', hasAlpha: false, components: 3 }
    case 1:
      return { base: 'rgb', hasAlpha: true, components: 4 }
    case 2:
      return { base: 'gray', hasAlpha: false, components: 1 }
    case 3:
      return { base: 'gray', hasAlpha: true, components: 2 }
    case 4:
      return { base: 'indexed', hasAlpha: false, components: 1 }
    case 5:
      return { base: 'indexed', hasAlpha: true, components: 2 }
    default:
      return null
  }
}
