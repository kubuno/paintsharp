/*
 * Additional-layer-information blocks: the structural / property keys (spec §5.2).
 *
 * Derived from the GIMP PSD plug-in (file-psd), Copyright 2007 John Marshall,
 * licensed under the GNU General Public License v3 or later —
 * `load_layer_resource()` and the matching `load_resource_*()` helpers in
 * psd-layer-res-load.c, plus `psd_to_gimp_layer_color_tag()` /
 * `gimp_to_psd_layer_color_tag()` in psd-util.c for the `lclr` mapping — and
 * from Adobe's public "Photoshop File Formats Specification".
 *
 * This is an independent TypeScript re-implementation; no GIMP source code was
 * copied. Kubuno is AGPLv3, compatible with the GPLv3 (GPLv3 §13).
 */
import { ByteReader } from '../binary/ByteReader.ts'
import { readUnicodeString } from '../binary/strings.ts'
import { PROTECTION_FLAG } from '../constants.ts'
import { readDescriptor } from '../descriptor/read.ts'
import type { Descriptor } from '../descriptor/types.ts'
import type { PsdLayerKind, PsdRawBlock, WarningSink } from '../types.ts'

/** `lsct` / `lsdk` section types. */
export const SECTION_TYPE = {
  NORMAL: 0,
  OPEN_FOLDER: 1,
  CLOSED_FOLDER: 2,
  DIVIDER: 3,
} as const

/** Adjustment-layer keys handled by the descriptor format (spec §5.5a). */
const DESCRIPTOR_ADJUSTMENTS: ReadonlySet<string> = new Set([
  'brit', 'hue2', 'blnc', 'selc', 'vibA', 'expA', 'blwh', 'grdm', 'phfl',
  'mixr', 'clrL', 'CgEd',
])

/** Adjustment-layer keys stored as legacy binary blobs (spec §5.5b). */
const LEGACY_ADJUSTMENTS: ReadonlySet<string> = new Set([
  'levl', 'curv', 'hue ', 'nvrt', 'thrs', 'post',
])

/** Fill-layer keys (spec §5.4). */
const FILL_KEYS: ReadonlySet<string> = new Set(['SoCo', 'GdFl', 'PtFl'])

/** Smart-object keys (spec §5.7). */
const SMART_OBJECT_KEYS: ReadonlySet<string> = new Set(['SoLd', 'SoLE', 'PlLd'])

export interface ParsedBlocks {
  /** From `lsct`/`lsdk`; undefined when the layer carries neither. */
  sectionType?: number
  /** Blend key stored inside `lsct` (usually `pass` for folders). */
  sectionBlendMode?: string
  /** `luni` — authoritative layer name. */
  unicodeName?: string
  /** `lyid`. */
  layerId?: number
  /** `lclr`, 0..7. */
  colorTag?: number
  /** `lspf`. */
  protection?: number
  /** `iOpa`, 0..255. */
  fillOpacity?: number
  /** `lfx2` object-based effects descriptor. */
  effects?: Descriptor
  /** True when a legacy `lrFX` block was present (not decoded, only flagged). */
  legacyEffects?: boolean
  adjustment?: { key: string; descriptor: Descriptor | null; legacy: Uint8Array | null }
  text?: { transform: number[]; descriptor: Descriptor | null }
  /** True when `vmsk`/`vsms` was present: the mask channel is a rasterised vector. */
  hasVectorMask?: boolean
  smartObjectKey?: string
  fillKey?: string
}

/**
 * Decodes the blocks we understand. Every individual block is parsed inside a
 * try/catch: a corrupt style must never cost us the layer.
 */
export function parseBlocks(blocks: readonly PsdRawBlock[], sink: WarningSink): ParsedBlocks {
  const out: ParsedBlocks = {}
  for (const b of blocks) {
    try {
      parseOne(b, out, sink)
    } catch {
      sink.warn('malformed-block-skipped', { key: b.key })
    }
  }
  return out
}

function parseOne(b: PsdRawBlock, out: ParsedBlocks, sink: WarningSink): void {
  const r = new ByteReader(b.data)
  switch (b.key) {
    case 'lsct':
    case 'lsdk': {
      // `lsdk` is the CS5 "nested section divider" variant and wins when both
      // are present, which is why it is parsed last in file order.
      const type = r.u32()
      if (b.key === 'lsdk' || out.sectionType === undefined) out.sectionType = type
      if (b.data.length >= 12) {
        r.ascii(4) // '8BIM'
        const key = r.ascii(4)
        out.sectionBlendMode = key
      }
      break
    }
    case 'luni':
      out.unicodeName = readUnicodeString(r)
      break
    case 'lyid':
      out.layerId = r.u32()
      break
    case 'lclr': {
      // Four uint16 but only the first carries the tag; the rest is filler.
      const tag = r.u16()
      out.colorTag = tag >= 0 && tag <= 7 ? tag : 0
      break
    }
    case 'lspf':
      out.protection = r.u32()
      break
    case 'iOpa':
      out.fillOpacity = r.u8()
      break
    case 'lfx2': {
      r.u32() // objectEffectsVersion (0)
      r.u32() // descriptorVersion (16)
      out.effects = readDescriptor(r)
      break
    }
    case 'lrFX':
      // Legacy Photoshop 5 binary effects. Kubuno never writes them back; the
      // raw block is preserved so nothing is lost on a round trip.
      out.legacyEffects = true
      sink.warn('layer-effects-rasterized', { format: 'lrFX' }, 'info')
      break
    case 'TySh': {
      r.i16() // version
      const transform: number[] = []
      for (let i = 0; i < 6; i++) transform.push(r.f64())
      r.i16() // text descriptor version (50)
      r.i32() // descriptor version (16)
      let descriptor: Descriptor | null = null
      try {
        descriptor = readDescriptor(r)
      } catch {
        sink.warn('malformed-block-skipped', { key: 'TySh' })
      }
      out.text = { transform, descriptor }
      break
    }
    case 'tySh':
      // Photoshop 5 binary text: preserved raw, not decoded (spec §5.6, P2).
      out.text = out.text ?? { transform: [1, 0, 0, 1, 0, 0], descriptor: null }
      break
    case 'vmsk':
    case 'vsms':
      out.hasVectorMask = true
      break
    default:
      if (DESCRIPTOR_ADJUSTMENTS.has(b.key)) {
        r.u32() // descriptorVersion (16)
        out.adjustment = { key: b.key, descriptor: readDescriptor(r), legacy: null }
      } else if (LEGACY_ADJUSTMENTS.has(b.key)) {
        out.adjustment = { key: b.key, descriptor: null, legacy: b.data }
      } else if (FILL_KEYS.has(b.key)) {
        out.fillKey = b.key
      } else if (SMART_OBJECT_KEYS.has(b.key)) {
        out.smartObjectKey = b.key
      }
      break
  }
}

/** Derives the layer kind from the blocks that were found. */
export function layerKindFrom(p: ParsedBlocks): PsdLayerKind {
  const t = p.sectionType ?? SECTION_TYPE.NORMAL
  if (t === SECTION_TYPE.OPEN_FOLDER || t === SECTION_TYPE.CLOSED_FOLDER) return 'group'
  if (p.adjustment) return 'adjustment'
  if (p.fillKey) return 'fill'
  if (p.smartObjectKey) return 'smart-object'
  if (p.text) return 'text'
  return 'raster'
}

export function locksFrom(
  protection: number | undefined,
  flags: number,
): { all: boolean; alpha: boolean; composite: boolean; position: boolean } {
  const p = protection ?? 0
  return {
    all: (p & PROTECTION_FLAG.ALL) !== 0,
    // The record flag and `lspf` agree in practice; take the union.
    alpha: (p & PROTECTION_FLAG.TRANSPARENCY) !== 0 || (flags & 0x01) !== 0,
    composite: (p & PROTECTION_FLAG.COMPOSITE) !== 0,
    position: (p & PROTECTION_FLAG.POSITION) !== 0,
  }
}
