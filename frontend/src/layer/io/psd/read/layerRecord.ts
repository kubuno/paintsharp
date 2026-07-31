/*
 * PSD/PSB Layer Record, layer mask block and additional-block loop
 * (spec §4.1, §4.6, §4.7, §4.8, §5.1).
 *
 * Derived from the GIMP PSD plug-in (file-psd), Copyright 2007 John Marshall,
 * licensed under the GNU General Public License v3 or later — `read_layer_info()`
 * in psd-load.c and `get_layer_resource_header()` in psd-layer-res-load.c — and
 * from Adobe's public "Photoshop File Formats Specification".
 *
 * This is an independent TypeScript re-implementation; no GIMP source code was
 * copied. Kubuno is AGPLv3, compatible with the GPLv3 (GPLv3 §13).
 */
import type { ByteReader } from '../binary/ByteReader.ts'
import { readPascalString } from '../binary/strings.ts'
import { PsdError } from '../errors.ts'
import { BLOCK_SIGNATURES, LIMITS, MASK_FLAG, PSB_64BIT_KEYS } from '../constants.ts'
import type { PsdMask, PsdRawBlock, PsdRect, ReadCtx } from '../types.ts'

export interface ChannelInfo {
  readonly id: number
  readonly dataLength: number
  /** Filled in by the ChannelImageData traversal (pass 1). */
  offset: number
}

export interface LayerRecordRaw {
  rect: PsdRect
  channels: ChannelInfo[]
  blendMode: string
  opacity: number
  clipping: boolean
  flags: number
  mask: PsdMask | null
  blendingRanges: Uint8Array | null
  /** Legacy Pascal name; `luni` overrides it when present. */
  legacyName: string
  blocks: PsdRawBlock[]
}

export function readLayerRecord(r: ByteReader, ctx: ReadCtx): LayerRecordRaw {
  const top = r.i32()
  const left = r.i32()
  const bottom = r.i32()
  const right = r.i32()
  const rect = normaliseRect({ top, left, bottom, right }, ctx)

  const channelCount = r.u16()
  if (channelCount > ctx.limits.MAX_CHANNELS_PER_LAYER) {
    throw new PsdError('BAD_CHANNEL_COUNT', { channelCount })
  }
  const channels: ChannelInfo[] = []
  for (let i = 0; i < channelCount; i++) {
    const id = r.i16()
    const dataLength = ctx.isPsb ? r.u64AsNumber() : r.u32()
    channels.push({ id, dataLength, offset: -1 })
  }

  const blendSig = r.ascii(4)
  if (blendSig !== '8BIM') {
    ctx.warn('malformed-block-skipped', { field: 'blendModeSignature', value: blendSig })
  }
  const blendMode = r.ascii(4)
  const opacity = r.u8()
  const clipping = r.u8() !== 0
  const flags = r.u8()
  r.u8() // filler, must be 0

  const extraLength = r.u32()
  const extraStart = r.pos
  const er = r.sub(extraLength)

  let mask: PsdMask | null = null
  let blendingRanges: Uint8Array | null = null
  let legacyName = ''
  let blocks: PsdRawBlock[] = []

  try {
    mask = readLayerMask(er, ctx)
    const brLength = er.u32()
    blendingRanges = brLength > 0 ? er.bytes(Math.min(brLength, er.remaining)) : null
    legacyName = readPascalString(er, 4)
    blocks = readAdditionalBlocks(er, ctx, false)
  } catch {
    ctx.warn('malformed-block-skipped', { section: 'layer-extra-data' })
  }

  // Always reposition on the DECLARED end: `extraDataLength` is authoritative,
  // the cursor is not (spec §4.6).
  r.seekTo(extraStart + extraLength)

  return {
    rect,
    channels,
    blendMode,
    opacity,
    clipping,
    flags,
    mask,
    blendingRanges,
    legacyName,
    blocks,
  }
}

function normaliseRect(rect: PsdRect, ctx: ReadCtx): PsdRect {
  if (rect.bottom < rect.top || rect.right < rect.left) {
    ctx.warn('malformed-block-skipped', { field: 'layer-rect' })
    return {
      top: Math.min(rect.top, rect.bottom),
      left: Math.min(rect.left, rect.right),
      bottom: Math.max(rect.top, rect.bottom),
      right: Math.max(rect.left, rect.right),
    }
  }
  return rect
}

/**
 * Layer mask / adjustment data.
 *
 * We do NOT branch on `length === 20 / 36`: like GIMP we subtract progressively,
 * which survives the non-conformant files that exist in the wild. The `rem >= 18`
 * test for the "real mask" block is a documented heuristic — with every
 * parameter flag set, the parameter block would also exceed 18 bytes.
 */
export function readLayerMask(r: ByteReader, ctx: ReadCtx): PsdMask | null {
  const length = r.u32()
  if (length === 0) return null
  const start = r.pos
  const mr = r.sub(length)
  r.seekTo(Math.min(r.end, start + length))

  let rem = length
  if (rem < 18) {
    ctx.warn('malformed-block-skipped', { section: 'layer-mask', length })
    return null
  }
  const rect = readRect(mr)
  const defaultColor = mr.u8()
  const flags = mr.u8()
  rem -= 18

  let real: PsdMask['real'] = null
  if (rem >= 18) {
    // Order matters: realFlags comes BEFORE realDefaultColor (psd.h:563-564).
    const realFlags = mr.u8()
    const realDefaultColor = mr.u8()
    real = { rect: readRect(mr), defaultColor: realDefaultColor, flags: realFlags }
    rem -= 18
  }

  let density: number | null = null
  let feather: number | null = null
  if (rem > 2 && (flags & MASK_FLAG.HAS_PARAMETERS) !== 0) {
    const p = mr.u8()
    rem -= 1
    if (p & 0x01) {
      density = mr.u8()
      rem -= 1
    }
    if (p & 0x02) {
      feather = mr.f64()
      rem -= 8
    }
    if (p & 0x04) {
      mr.u8() // vector mask density
      rem -= 1
    }
    if (p & 0x08) {
      mr.f64() // vector mask feather
      rem -= 8
    }
  }
  if (rem > 3) ctx.warn('malformed-block-skipped', { section: 'layer-mask', trailing: rem })

  return {
    rect,
    defaultColor,
    flags,
    disabled: (flags & MASK_FLAG.DISABLED) !== 0,
    relative: (flags & MASK_FLAG.RELATIVE_TO_LAYER) !== 0,
    fromRender: (flags & MASK_FLAG.FROM_RENDER) !== 0,
    real,
    density,
    feather,
  }
}

function readRect(r: ByteReader): PsdRect {
  const top = r.i32()
  const left = r.i32()
  const bottom = r.i32()
  const right = r.i32()
  // `0,0,0,-1` is legitimate for rendered masks, so no normalisation here.
  return { top, left, bottom, right }
}

/**
 * The `8BIM` / `8B64` block loop.
 *
 * `documentLevel` selects the alignment rule (spec §5.1): layer blocks are NOT
 * padded (an odd length is a known Photoshop bug, GNOME #771558) while
 * document-level blocks are aligned to 4.
 */
export function readAdditionalBlocks(
  r: ByteReader,
  ctx: ReadCtx,
  documentLevel: boolean,
): PsdRawBlock[] {
  const blocks: PsdRawBlock[] = []
  let guard = 0
  while (r.remaining > 7) {
    const before = r.pos
    if (guard++ > 4096) {
      ctx.warn('malformed-block-skipped', { reason: 'too-many-blocks' })
      break
    }
    let signature: string
    let key: string
    try {
      signature = r.ascii(4)
      key = r.ascii(4)
    } catch {
      break
    }
    if (!BLOCK_SIGNATURES.has(signature)) {
      ctx.warn('malformed-block-skipped', { signature })
      break
    }
    // Only the file version plus membership in PSB_64BIT_KEYS widen the length
    // field; the `8B64` signature by itself does not (observed GIMP behaviour).
    const is64 = ctx.isPsb && PSB_64BIT_KEYS.has(key)
    let length: number
    try {
      length = is64 ? r.u64AsNumber() : r.u32()
    } catch {
      break
    }
    if (length < 0 || !Number.isSafeInteger(length)) {
      ctx.warn('malformed-block-skipped', { key, length })
      break
    }
    if (length > r.remaining) {
      ctx.warn('truncated-file', { key, length, available: r.remaining })
      length = r.remaining
    }
    const dataStart = r.pos
    if (length > LIMITS.MAX_ADDITIONAL_BLOCK) {
      ctx.warn('unknown-blocks-preserved', { key, length, dropped: 1 })
      blocks.push({ signature, key, data: new Uint8Array(0) })
    } else {
      blocks.push({ signature, key, data: r.bytes(length) })
    }
    const end = documentLevel ? dataStart + Math.ceil(length / 4) * 4 : dataStart + length
    r.seekTo(end)
    if (r.pos <= before) break // strict progress guard
  }
  return blocks
}
