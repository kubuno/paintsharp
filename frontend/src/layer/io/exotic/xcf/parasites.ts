// SPDX-License-Identifier: AGPL-3.0-or-later
//
// XCF parasites, derived from the GIMP source code (app/xcf/xcf-load.c
// `xcf_load_parasite`), Copyright (C) 1995 Spencer Kimball and Peter Mattis and the GIMP
// contributors, licensed GPL-3.0-or-later. Reimplemented in TypeScript for Kubuno
// (AGPL-3.0-or-later).
//
// A parasite is GIMP's generic "attach arbitrary data to an item" mechanism. Only a
// handful of well-known names matter to an importer; the rest is carried untouched.

import { XcfReader } from './reader'

export interface XcfParasite {
  readonly name: string
  readonly flags: number
  readonly data: Uint8Array
}

/** Guards against a crafted PROP_PARASITES claiming millions of entries. */
const MAX_PARASITES = 512

/**
 * Reads the parasite sequence packed inside one `PROP_PARASITES` payload.
 *
 * A nameless parasite means the block is corrupt: the list stops there, silently, which
 * is what GIMP does — losing metadata must never lose the image.
 */
export function readParasites(r: XcfReader, at: number, size: number): XcfParasite[] {
  const end = at + size
  const out: XcfParasite[] = []
  r.pos = at
  while (r.pos < end && out.length < MAX_PARASITES) {
    let name: string
    let flags: number
    let dataSize: number
    try {
      name = r.string()
      flags = r.u32()
      dataSize = r.u32()
    } catch {
      break
    }
    if (name === '') break
    if (!Number.isSafeInteger(dataSize) || dataSize < 0 || r.pos + dataSize > end) break
    let data: Uint8Array
    try {
      data = r.read(dataSize).slice()
    } catch {
      break
    }
    out.push({ name, flags, data })
  }
  return out
}

export interface KnownParasites {
  /** `icc-profile` — carried into `ImportedDocument.iccProfile`, never applied in v1. */
  readonly iccProfile?: Uint8Array
  /** `gimp-comment`. */
  readonly comment?: string
  /** True when a `gimp-text-layer` parasite is present: the layer was a text layer. */
  readonly isTextLayer: boolean
}

export function classifyParasites(list: readonly XcfParasite[]): KnownParasites {
  let iccProfile: Uint8Array | undefined
  let comment: string | undefined
  let isTextLayer = false
  for (const p of list) {
    switch (p.name) {
      case 'icc-profile':
        iccProfile = p.data
        break
      case 'gimp-comment':
        comment = new TextDecoder('utf-8', { fatal: false }).decode(p.data).replace(/\0+$/, '')
        break
      case 'gimp-text-layer':
        isTextLayer = true
        break
      default:
        break
    }
  }
  return { iccProfile, comment, isTextLayer }
}
