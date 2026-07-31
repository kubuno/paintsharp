// SPDX-License-Identifier: AGPL-3.0-or-later
//
// XCF decoding logic derived from the GIMP source code (app/xcf/xcf-load.c
// `xcf_load_image_props` / `xcf_load_layer_props` / `xcf_load_channel_props`, and the
// PROP_* table of app/xcf/xcf-private.h), Copyright (C) 1995 Spencer Kimball and Peter
// Mattis and the GIMP contributors, licensed GPL-3.0-or-later. Reimplemented in
// TypeScript for Kubuno (AGPL-3.0-or-later).
//
// The property list is what makes XCF forward-compatible: every property announces its
// payload size, so an unknown one is skipped rather than fatal. A decoder that fails on
// an unknown PROP_* will break on the next GIMP release, by construction.

import { ImportWarningSink, importWarn } from '../types'
import { XcfReader } from './reader'

/** The 50 property identifiers of xcf-private.h (spec 07 §4.3). */
export const PROP = {
  END: 0,
  COLORMAP: 1,
  ACTIVE_LAYER: 2,
  ACTIVE_CHANNEL: 3,
  SELECTION: 4,
  FLOATING_SELECTION: 5,
  OPACITY: 6,
  MODE: 7,
  VISIBLE: 8,
  LINKED: 9,
  LOCK_ALPHA: 10,
  APPLY_MASK: 11,
  EDIT_MASK: 12,
  SHOW_MASK: 13,
  SHOW_MASKED: 14,
  OFFSETS: 15,
  COLOR: 16,
  COMPRESSION: 17,
  GUIDES: 18,
  RESOLUTION: 19,
  TATTOO: 20,
  PARASITES: 21,
  UNIT: 22,
  PATHS: 23,
  USER_UNIT: 24,
  VECTORS: 25,
  TEXT_LAYER_FLAGS: 26,
  OLD_SAMPLE_POINTS: 27,
  LOCK_CONTENT: 28,
  GROUP_ITEM: 29,
  ITEM_PATH: 30,
  GROUP_ITEM_FLAGS: 31,
  LOCK_POSITION: 32,
  FLOAT_OPACITY: 33,
  COLOR_TAG: 34,
  COMPOSITE_MODE: 35,
  COMPOSITE_SPACE: 36,
  BLEND_SPACE: 37,
  FLOAT_COLOR: 38,
  SAMPLE_POINTS: 39,
  ITEM_SET: 40,
  ITEM_SET_ITEM: 41,
  LOCK_VISIBILITY: 42,
  SELECTED_PATH: 43,
  FILTER_REGION: 44,
  FILTER_ARGUMENT: 45,
  FILTER_CLIP: 46,
  VECTOR_LAYER: 47,
  LINK_LAYER: 48,
  TRANSFORM: 49,
} as const

/** `PROP_COMPRESSION` payload values (xcf-private.h). */
export const COMPRESS = { NONE: 0, RLE: 1, ZLIB: 2, FRACTAL: 3 } as const

/** `PROP_COLOR_TAG` -> the hex used by Layer's layer panel (§4.9). */
export const COLOR_TAG_HEX: readonly (string | undefined)[] = [
  undefined,
  '#3b82f6',
  '#22c55e',
  '#eab308',
  '#f97316',
  '#92400e',
  '#ef4444',
  '#8b5cf6',
  '#6b7280',
]

export interface XcfProp {
  readonly type: number
  readonly size: number
  /** Absolute file offset of the payload. */
  readonly at: number
}

/** A property list capped well above anything real, as a denial-of-service guard. */
const MAX_PROPS_PER_LIST = 4096

/**
 * Walks one property list up to `PROP_END`, handing each property to `visit`.
 *
 * `visit` may read from the reader freely: the loop always repositions to
 * `at + size` afterwards, so a visitor that reads too much or too little cannot
 * desynchronise the parse.
 *
 * The one documented exception is `PROP_USER_UNIT` (24), whose `prop_size` is wrong in
 * files affected by GIMP issue #16129. GIMP reads its fields rather than trusting the
 * size, and so do we — skipping by a wrong size would land mid-structure.
 */
export function readPropList(
  r: XcfReader,
  warn: ImportWarningSink,
  visit: (p: XcfProp) => void,
): void {
  for (let i = 0; i < MAX_PROPS_PER_LIST; i++) {
    const type = r.u32()
    const size = r.u32()
    if (type === PROP.END) return
    if (!Number.isSafeInteger(size) || size < 0) {
      warn.warn(importWarn('xcf.bad-property-size', { type }))
      return
    }
    const at = r.pos

    if (type === PROP.USER_UNIT) {
      // factor (f32), digits (u32), then 5 strings. Read them; ignore the announced size.
      try {
        r.f32()
        r.u32()
        for (let k = 0; k < 5; k++) r.string()
      } catch {
        warn.warn(importWarn('xcf.bad-user-unit'))
        return
      }
      continue
    }

    if (!r.has(at, size)) {
      warn.warn(importWarn('xcf.property-truncated', { type }))
      return
    }
    try {
      visit({ type, size, at })
    } catch {
      // A visitor must never take the whole document down: the property is dropped.
      warn.warn(importWarn('xcf.property-unreadable', { type }))
    }
    r.pos = at + size
  }
  warn.warn(importWarn('xcf.property-list-too-long'))
}

/** Reads a `u32` boolean payload; anything non-zero is true. */
export function propBool(r: XcfReader, p: XcfProp): boolean {
  if (p.size < 4) return false
  r.pos = p.at
  return r.u32() !== 0
}

export function propU32(r: XcfReader, p: XcfProp): number {
  if (p.size < 4) return 0
  r.pos = p.at
  return r.u32()
}

export function propI32(r: XcfReader, p: XcfProp): number {
  if (p.size < 4) return 0
  r.pos = p.at
  return r.i32()
}

export function propF32(r: XcfReader, p: XcfProp): number {
  if (p.size < 4) return 0
  r.pos = p.at
  return r.f32()
}

/** `PROP_ITEM_PATH`: `prop_size / 4` u32 indices, capped against absurd depths. */
export function propItemPath(r: XcfReader, p: XcfProp): number[] {
  const n = Math.min(Math.floor(p.size / 4), 64)
  r.pos = p.at
  const path: number[] = []
  for (let i = 0; i < n; i++) path.push(r.u32())
  return path
}

/**
 * `PROP_COLORMAP`: u32 count then RGB triplets.
 *
 * Version 0 quirk (`xcf-load.c`): those files never saved the palette correctly. GIMP
 * skips `n` bytes and substitutes a grey ramp; reproducing that is the only way to open
 * such a file the same way GIMP does.
 */
export function propColormap(
  r: XcfReader,
  p: XcfProp,
  version: number,
  warn: ImportWarningSink,
): Uint8Array {
  r.pos = p.at
  const n = Math.min(r.u32(), 256)
  const cmap = new Uint8Array(256 * 3)
  if (version === 0) {
    warn.warn(importWarn('xcf.v0-colormap-substituted'))
    for (let i = 0; i < 256; i++) {
      cmap[i * 3] = i
      cmap[i * 3 + 1] = i
      cmap[i * 3 + 2] = i
    }
    return cmap
  }
  for (let i = 0; i < n; i++) {
    if (!r.has(r.pos, 3)) break
    cmap[i * 3] = r.u8()
    cmap[i * 3 + 1] = r.u8()
    cmap[i * 3 + 2] = r.u8()
  }
  return cmap
}
