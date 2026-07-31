/*
 * PSD/PSB Layer & Mask Information writer (spec §8.3, §8.4, §8.5, §8.7).
 *
 * The placeholder/patch mechanics and the group-marker layout were derived from
 * the GIMP PSD plug-in (file-psd), Copyright 2007 John Marshall, licensed under
 * the GNU General Public License v3 or later — `save_layer_and_mask()` in
 * psd-export.c — and from Adobe's public "Photoshop File Formats
 * Specification".
 *
 * This is an independent TypeScript re-implementation; no GIMP source code was
 * copied. Kubuno is AGPLv3, compatible with the GPLv3 (GPLv3 §13).
 */
import type { ByteWriter } from '../binary/ByteWriter.ts'
import { writePascalString } from '../binary/strings.ts'
import {
  CHANNEL_ID,
  LAYER_FLAG,
  MASK_FLAG,
  PROTECTION_FLAG,
  SECTION_DIVIDER_NAME,
  SELF_EMITTED_BLOCKS,
} from '../constants.ts'
import { SECTION_TYPE } from '../additional/common.ts'
import type { PsdColorMode, PsdDepth, PsdLayer, PsdRect, WarningSink } from '../types.ts'
import { rectHeight, rectWidth } from '../types.ts'
import {
  emptyChannelPayload,
  encodePlane,
  layerMaskPlane,
  layerPlanes,
} from './channelData.ts'

/** What a single PSD layer record stands for. */
type RecordKind = 'layer' | 'group-open' | 'group-close'

interface WriteRecord {
  readonly kind: RecordKind
  readonly layer: PsdLayer
  readonly depth: number
}

/**
 * Flattens the tree into the bottom-up record order Photoshop expects.
 *
 * A Kubuno group becomes TWO records: a bounding section divider (`lsct = 3`)
 * below its content and an opening marker (`lsct = 1|2`) above it.
 */
export function flattenForWrite(layers: readonly PsdLayer[], depth = 0): WriteRecord[] {
  const out: WriteRecord[] = []
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i]
    if (l.kind === 'group') {
      out.push({ kind: 'group-close', layer: l, depth })
      out.push(...flattenForWrite(l.children, depth + 1))
      out.push({ kind: 'group-open', layer: l, depth })
    } else {
      out.push({ kind: 'layer', layer: l, depth })
    }
  }
  return out
}

interface ChannelPlan {
  readonly id: number
  readonly width: number
  readonly height: number
  /** null for a group marker / empty layer: only the compression header. */
  readonly samples: Uint8Array | null
}

interface RecordPlan {
  readonly record: WriteRecord
  readonly rect: PsdRect
  readonly maskRect: PsdRect | null
  readonly channels: ChannelPlan[]
}

/**
 * Decodes and normalises every layer up-front.
 *
 * Doing it before any byte is written keeps the writer itself synchronous and
 * lets a single failing layer degrade to "empty channels" instead of aborting
 * the export (spec §8.9).
 */
export async function planLayers(
  layers: readonly PsdLayer[],
  depth: PsdDepth,
  colorMode: PsdColorMode,
  sink: WarningSink,
): Promise<RecordPlan[]> {
  const records = flattenForWrite(layers)
  const plans: RecordPlan[] = []
  for (const rec of records) {
    if (rec.kind !== 'layer') {
      plans.push({ record: rec, rect: EMPTY, maskRect: null, channels: markerChannels() })
      continue
    }
    let planes = null
    try {
      planes = await layerPlanes(rec.layer, depth, colorMode, sink)
    } catch {
      sink.warn('malformed-block-skipped', { layer: rec.layer.name })
    }
    if (!planes) {
      plans.push({ record: rec, rect: EMPTY, maskRect: null, channels: markerChannels() })
      continue
    }

    const channels: ChannelPlan[] = []
    let maskRect: PsdRect | null = null
    if (rec.layer.mask) {
      try {
        const mask = await layerMaskPlane(rec.layer, depth)
        if (mask) {
          const real = rec.layer.channels.some(c => c.id === CHANNEL_ID.REAL_MASK)
          const mr = real ? rec.layer.mask.real?.rect ?? rec.layer.mask.rect : rec.layer.mask.rect
          const mw = rectWidth(mr)
          const mh = rectHeight(mr)
          if (mw > 0 && mh > 0) {
            maskRect = mr
            // Photoshop puts the mask channel FIRST, before the alpha.
            channels.push({ id: CHANNEL_ID.USER_MASK, width: mw, height: mh, samples: mask })
          }
        }
      } catch {
        sink.warn('malformed-block-skipped', { layer: rec.layer.name, part: 'mask' })
      }
    }
    const { width, height } = planes
    channels.push({ id: CHANNEL_ID.TRANSPARENCY, width, height, samples: planes.a })
    channels.push({ id: 0, width, height, samples: planes.r })
    channels.push({ id: 1, width, height, samples: planes.g })
    channels.push({ id: 2, width, height, samples: planes.b })
    plans.push({ record: rec, rect: rec.layer.rect, maskRect, channels })
  }
  return plans
}

const EMPTY: PsdRect = { top: 0, left: 0, bottom: 0, right: 0 }

/** Group markers carry four EMPTY channels (ids -1, 0, 1, 2). */
function markerChannels(): ChannelPlan[] {
  return [
    { id: CHANNEL_ID.TRANSPARENCY, width: 0, height: 0, samples: null },
    { id: 0, width: 0, height: 0, samples: null },
    { id: 1, width: 0, height: 0, samples: null },
    { id: 2, width: 0, height: 0, samples: null },
  ]
}

/**
 * Writes the whole Layer & Mask Information section, from its length field to
 * the document-level additional blocks.
 */
export function writeLayerAndMask(
  w: ByteWriter,
  plans: readonly RecordPlan[],
  isPsb: boolean,
  compositeHasAlpha: boolean,
  documentBlocks: readonly { signature: string; key: string; data: Uint8Array }[],
): void {
  const sectionAt = w.placeholderLength(isPsb)
  const sectionStart = w.length

  if (plans.length === 0) {
    // The `layerInfoLength` field is POSITIONAL: skipping it would make a reader
    // take the Global Layer Mask length for it and desynchronise everything that
    // follows. A flattened document therefore still writes an explicit 0.
    w.length64(isPsb, 0)
  } else {
    const infoAt = w.placeholderLength(isPsb)
    const infoStart = w.length

    // A negative count tells readers that the composite's first alpha channel
    // carries the merged transparency.
    w.i16(compositeHasAlpha ? -plans.length : plans.length)

    const channelLengthOffsets: number[][] = []
    let nextLayerId = 1
    for (const plan of plans) {
      channelLengthOffsets.push(writeRecord(w, plan, isPsb, () => nextLayerId++))
    }
    for (let i = 0; i < plans.length; i++) {
      const offsets = channelLengthOffsets[i]
      const channels = plans[i].channels
      for (let c = 0; c < channels.length; c++) {
        const start = w.length
        const ch = channels[c]
        if (ch.samples && ch.width > 0 && ch.height > 0) {
          w.bytes(encodePlane(ch.samples, ch.width, ch.height, isPsb))
        } else {
          w.bytes(emptyChannelPayload())
        }
        // The declared length INCLUDES the 2-byte compression header.
        w.patchLength(isPsb, offsets[c], w.length - start)
      }
    }

    w.patchLength(isPsb, infoAt, w.length - infoStart)
    // The padding comes AFTER the patched length: it is not part of it.
    w.align(2)
  }

  w.u32(0) // Global Layer Mask Info: empty but present (GIMP omits it entirely)

  for (const b of documentBlocks) {
    // `8B64` is never emitted: `8BIM` is understood everywhere (spec §1.9).
    w.ascii('8BIM', 4)
    w.ascii(b.key, 4)
    w.u32(b.data.length)
    w.bytes(b.data)
    w.align(4) // document-level blocks are 4-aligned, padding not counted
  }

  w.patchLength(isPsb, sectionAt, w.length - sectionStart)
}

/** @returns the offset of each channel-length placeholder, in channel order. */
function writeRecord(
  w: ByteWriter,
  plan: RecordPlan,
  isPsb: boolean,
  nextLayerId: () => number,
): number[] {
  const { record, rect, maskRect, channels } = plan
  const layer = record.layer
  const isMarker = record.kind !== 'layer'
  const sectionType =
    record.kind === 'group-open'
      ? layer.expanded
        ? SECTION_TYPE.OPEN_FOLDER
        : SECTION_TYPE.CLOSED_FOLDER
      : record.kind === 'group-close'
        ? SECTION_TYPE.DIVIDER
        : SECTION_TYPE.NORMAL

  // ⚠️ Rectangle order is top, left, bottom, right — not left, top.
  w.i32(rect.top)
  w.i32(rect.left)
  w.i32(rect.bottom)
  w.i32(rect.right)

  w.u16(channels.length)
  const lengthOffsets: number[] = []
  for (const ch of channels) {
    w.i16(ch.id)
    lengthOffsets.push(w.placeholderLength(isPsb))
  }

  w.ascii('8BIM', 4)
  // `pass` is only legal on a folder; on a raster Photoshop ignores it, so we
  // never emit it there.
  let blendKey = record.kind === 'group-close' ? 'norm' : normaliseBlendKey(layer.blendMode)
  if (blendKey === 'pass' && record.kind === 'layer') blendKey = 'norm'
  w.ascii(blendKey, 4)

  w.u8(clamp255(layer.opacity))
  w.u8(layer.clipping ? 1 : 0)
  w.u8(recordFlags(layer, isMarker))
  w.u8(0) // filler

  const extraAt = w.placeholderU32()
  const extraStart = w.length

  // --- layer mask block (spec §8.7) ---
  if (maskRect) {
    w.u32(20)
    w.i32(maskRect.top)
    w.i32(maskRect.left)
    w.i32(maskRect.bottom)
    w.i32(maskRect.right)
    w.u8(layer.mask?.defaultColor ?? 0)
    w.u8(layer.mask?.disabled ? MASK_FLAG.DISABLED : 0)
    w.u16(0) // padding
  } else {
    w.u32(0)
  }

  // --- blending ranges: preserved verbatim, or empty for a fresh layer ---
  if (layer.blendingRanges && layer.blendingRanges.length > 0 && !isMarker) {
    w.u32(layer.blendingRanges.length)
    w.bytes(layer.blendingRanges)
  } else {
    w.u32(0)
  }

  // --- legacy Pascal name, padded to a multiple of 4 ---
  const name = record.kind === 'group-close' ? SECTION_DIVIDER_NAME : layer.name
  writePascalString(w, name, 4)

  writeAdditionalBlocks(w, layer, name, sectionType, record, blendKey, nextLayerId)

  w.patchU32(extraAt, w.length - extraStart)
  return lengthOffsets
}

function writeAdditionalBlocks(
  w: ByteWriter,
  layer: PsdLayer,
  name: string,
  sectionType: number,
  record: WriteRecord,
  blendKey: string,
  nextLayerId: () => number,
): void {
  // luni — the authoritative name, capped at 255 UTF-16 units like Photoshop.
  const uni = name.slice(0, 255)
  block(w, 'luni', () => {
    w.u32(uni.length)
    for (let i = 0; i < uni.length; i++) w.u16(uni.charCodeAt(i))
    if (uni.length % 2 === 1) w.u16(0) // pad to an even byte count
  })

  block(w, 'lyid', () => w.u32(layer.id ?? nextLayerId()))

  block(w, 'lclr', () => {
    w.u16(layer.colorTag & 0x7)
    w.u16(0)
    w.u16(0)
    w.u16(0)
  })

  const lspf = protectionFlags(layer)
  if (lspf !== 0) block(w, 'lspf', () => w.u32(lspf))

  if (layer.fillOpacity !== 255 && record.kind === 'layer') {
    block(w, 'iOpa', () => {
      w.u8(clamp255(layer.fillOpacity))
      w.zeros(3)
    })
  }

  if (sectionType !== SECTION_TYPE.NORMAL) {
    // GIMP switches to `lsdk` for end markers nested deeper than 5, because old
    // Photoshop versions stop understanding `lsct` there (psd-export.c).
    const key = sectionType < 3 || record.depth <= 5 ? 'lsct' : 'lsdk'
    block(w, key, () => {
      w.u32(sectionType)
      w.ascii('8BIM', 4)
      w.ascii(blendKey, 4)
    })
  }

  // Everything we did not model is re-emitted byte for byte. This is what makes
  // a Kubuno round trip non-destructive for Photoshop features we do not
  // understand (effects, smart objects, text engines…).
  if (record.kind === 'layer') {
    for (const b of layer.blocks) {
      if (SELF_EMITTED_BLOCKS.has(b.key)) continue
      if (b.data.length === 0) continue
      w.ascii('8BIM', 4)
      w.ascii(b.key, 4)
      w.u32(b.data.length)
      w.bytes(b.data)
    }
  }
}

function block(w: ByteWriter, key: string, body: () => void): void {
  w.ascii('8BIM', 4)
  w.ascii(key, 4)
  const at = w.placeholderU32()
  const start = w.length
  body()
  w.patchU32(at, w.length - start)
}

function recordFlags(layer: PsdLayer, isMarker: boolean): number {
  let flags = 0
  if (layer.locks.alpha) flags |= LAYER_FLAG.TRANSPARENCY_PROTECTED
  // ⚠️ Bit 1 is INVERTED: set means HIDDEN.
  if (!layer.visible) flags |= LAYER_FLAG.HIDDEN
  if (isMarker || layer.kind === 'adjustment') {
    // Bit 4 only means anything when bit 3 accompanies it.
    flags |= LAYER_FLAG.BIT4_MEANINGFUL | LAYER_FLAG.PIXEL_DATA_IRRELEVANT
  }
  return flags
}

function protectionFlags(layer: PsdLayer): number {
  let f = 0
  if (layer.locks.alpha) f |= PROTECTION_FLAG.TRANSPARENCY
  if (layer.locks.composite) f |= PROTECTION_FLAG.COMPOSITE
  if (layer.locks.position) f |= PROTECTION_FLAG.POSITION
  if (layer.locks.all) f |= PROTECTION_FLAG.ALL
  return f >>> 0
}

/** Pads a short key with spaces and falls back to `norm` for garbage. */
function normaliseBlendKey(key: string): string {
  if (!key) return 'norm'
  const k = key.length >= 4 ? key.slice(0, 4) : key.padEnd(4, ' ')
  for (let i = 0; i < 4; i++) {
    const c = k.charCodeAt(i)
    if (c < 0x20 || c > 0x7e) return 'norm'
  }
  return k
}

function clamp255(v: number): number {
  const i = Math.round(v)
  return i < 0 ? 0 : i > 255 ? 255 : i
}
