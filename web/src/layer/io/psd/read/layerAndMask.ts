/*
 * PSD/PSB Layer & Mask Information section (spec §1.5, §4.3, §5.1).
 *
 * Derived from the GIMP PSD plug-in (file-psd), Copyright 2007 John Marshall,
 * licensed under the GNU General Public License v3 or later — `read_layer_block()`
 * and `read_layer_info()` in psd-load.c, plus the `ibm_pc_format` handling of
 * psd.h — and from Adobe's public "Photoshop File Formats Specification".
 *
 * This is an independent TypeScript re-implementation; no GIMP source code was
 * copied. Kubuno is AGPLv3, compatible with the GPLv3 (GPLv3 §13).
 */
import { ByteReader } from '../binary/ByteReader.ts'
import { PsdError, allocBytes } from '../errors.ts'
import { CHANNEL_ID, SECTION_DIVIDER_NAME } from '../constants.ts'
import { decodeChannel, rowBytesFor } from '../compression/index.ts'
import { layerKindFrom, locksFrom, parseBlocks, SECTION_TYPE } from '../additional/common.ts'
import type {
  PsdChannel,
  PsdDepth,
  PsdGlobalMask,
  PsdLayer,
  PsdRawBlock,
  PsdRect,
  ReadCtx,
} from '../types.ts'
import { rectHeight, rectWidth } from '../types.ts'
import { readAdditionalBlocks, readLayerRecord, type ChannelInfo, type LayerRecordRaw } from './layerRecord.ts'

/** One layer as read from the file, before the group tree is rebuilt. */
export interface ParsedLayer {
  readonly base: Omit<PsdLayer, 'children'>
  readonly sectionType: number
}

export interface LayerAndMaskResult {
  /** Bottom-up, exactly as stored in the file (dividers included). */
  readonly layers: ParsedLayer[]
  readonly globalMask: PsdGlobalMask | null
  readonly documentBlocks: PsdRawBlock[]
  readonly compositeHasAlpha: boolean
}

const EMPTY_RESULT: LayerAndMaskResult = {
  layers: [],
  globalMask: null,
  documentBlocks: [],
  compositeHasAlpha: false,
}

/**
 * Reads the whole section. `r` must sit on the section length field; on return
 * it is repositioned just after the section, ready for the Image Data.
 */
export function readLayerAndMask(r: ByteReader, ctx: ReadCtx): LayerAndMaskResult {
  let sectionLength: number
  try {
    sectionLength = r.length(ctx.isPsb)
  } catch {
    ctx.warn('truncated-file', { section: 'layer-and-mask' })
    return EMPTY_RESULT
  }
  if (sectionLength <= 0) return EMPTY_RESULT

  const sectionStart = r.pos
  const sr = r.sub(sectionLength)
  r.seekTo(sectionStart + sectionLength)

  let layers: ParsedLayer[] = []
  let compositeHasAlpha = false
  let globalMask: PsdGlobalMask | null = null
  let documentBlocks: PsdRawBlock[] = []

  try {
    const layerInfoLength = sr.length(ctx.isPsb)
    if (layerInfoLength > 0) {
      const infoStart = sr.pos
      const lir = sr.sub(layerInfoLength)
      const res = readLayerInfo(lir, ctx)
      layers = res.layers
      compositeHasAlpha = res.compositeHasAlpha
      // The section is padded to an even length, and the declared length is
      // authoritative — never the cursor (spec §1.5).
      sr.seekTo(infoStart + layerInfoLength + (layerInfoLength % 2))
    }
  } catch (e) {
    if (e instanceof PsdError && e.code === 'TOO_LARGE') throw e
    ctx.warn('malformed-block-skipped', { section: 'layer-info' })
  }

  try {
    globalMask = readGlobalLayerMask(sr, ctx)
  } catch {
    ctx.warn('malformed-block-skipped', { section: 'global-layer-mask' })
  }

  try {
    documentBlocks = readAdditionalBlocks(sr, ctx, true)
  } catch {
    ctx.warn('malformed-block-skipped', { section: 'document-blocks' })
  }

  // 16- and 32-bit documents keep their real layer list in `Lr16` / `Lr32`,
  // with `layerCount = 0` in the legacy slot (spec §1.5).
  if (layers.length === 0 && (ctx.depth === 16 || ctx.depth === 32)) {
    const key = ctx.depth === 16 ? 'Lr16' : 'Lr32'
    const block = documentBlocks.find(b => b.key === key)
    if (block && block.data.length > 2) {
      try {
        const res = readLayerInfo(new ByteReader(block.data), ctx)
        layers = res.layers
        compositeHasAlpha = res.compositeHasAlpha
      } catch {
        ctx.warn('malformed-block-skipped', { section: key })
      }
    }
  }

  return { layers, globalMask, documentBlocks, compositeHasAlpha }
}

/**
 * `layerCount` + Layer Records + ChannelImageData.
 *
 * Pass 1 only TRAVERSES the channel data, accumulating absolute offsets: that
 * is what lets a 500 MB file yield its full layer tree in milliseconds.
 */
function readLayerInfo(
  r: ByteReader,
  ctx: ReadCtx,
): { layers: ParsedLayer[]; compositeHasAlpha: boolean } {
  detectEndianness(r, ctx)

  const rawCount = r.i16()
  const compositeHasAlpha = rawCount < 0
  const count = Math.abs(rawCount)
  if (count > ctx.limits.MAX_LAYERS) {
    throw new PsdError('TOO_LARGE', { layers: count, max: ctx.limits.MAX_LAYERS })
  }

  const records: LayerRecordRaw[] = []
  for (let i = 0; i < count; i++) {
    const before = r.pos
    try {
      records.push(readLayerRecord(r, ctx))
    } catch {
      // A broken record desynchronises everything that follows: stop here and
      // keep the layers already read (spec §9.4, "layer" recovery level).
      ctx.warn('truncated-file', { section: 'layer-records', read: records.length })
      break
    }
    if (r.pos <= before) break
  }

  // Memory budget. Every layer keeps its OWN rectangle — we never expand a
  // layer to the document size — but a hostile file could still declare
  // thousands of full-canvas layers, so the cumulative cost is checked here,
  // BEFORE anything is allocated.
  let budget = 0
  for (const rec of records) {
    for (const ch of rec.channels) {
      const geom = channelGeometry(rec, ch.id)
      budget += rowBytesFor(geom.width, ctx.depth) * geom.height
    }
  }
  if (budget > ctx.limits.MAX_TOTAL_LAYER_BYTES) {
    throw new PsdError('TOO_LARGE', { decodedBytes: budget, max: ctx.limits.MAX_TOTAL_LAYER_BYTES })
  }
  ctx.budget.remaining = Math.min(ctx.budget.remaining, ctx.limits.MAX_TOTAL_LAYER_BYTES)

  // ChannelImageData: no separator, no padding — advance by dataLength exactly.
  for (const rec of records) {
    for (const ch of rec.channels) {
      ch.offset = r.pos
      if (ch.dataLength > r.remaining) {
        ctx.warn('truncated-file', { section: 'channel-data' })
        r.seekTo(r.end)
      } else {
        r.skip(ch.dataLength)
      }
    }
  }

  const layers = records.map(rec => toParsedLayer(rec, r.data, ctx))
  return { layers, compositeHasAlpha }
}

/**
 * `ibm_pc_format` heuristic (spec §1.7): a handful of third-party writers emit
 * the Layer & Mask section little-endian.
 *
 * Looking at `layerCount` alone is not enough — a little-endian count of 3 reads
 * as 768 big-endian, which is not "aberrant". So we PROBE: read the count plus
 * the first Layer Record header both ways and check that the rectangle is
 * ordered and bounded, that the channel count is sane, and that the blend-mode
 * signature really is `8BIM`. We only flip when big-endian fails that probe AND
 * little-endian passes it, so a normal file can never be mis-detected.
 */
function detectEndianness(r: ByteReader, ctx: ReadCtx): void {
  if (r.remaining < 2) return
  if (probeLayerInfo(r, false, ctx)) return
  if (!probeLayerInfo(r, true, ctx)) return
  r.littleEndian = true
  ctx.warn('unknown-blocks-preserved', { endianness: 'little' }, 'info')
}

/** Non-destructive plausibility probe of `layerCount` + the first record. */
function probeLayerInfo(r: ByteReader, littleEndian: boolean, ctx: ReadCtx): boolean {
  const savedPos = r.pos
  const savedEndian = r.littleEndian
  r.littleEndian = littleEndian
  try {
    const count = Math.abs(r.i16())
    if (count > ctx.limits.MAX_LAYERS) return false
    if (count === 0) return true // nothing to corroborate against
    const top = r.i32()
    const left = r.i32()
    const bottom = r.i32()
    const right = r.i32()
    if (bottom < top || right < left) return false
    const BOUND = 1 << 24
    for (const v of [top, left, bottom, right]) if (v < -BOUND || v > BOUND) return false
    const channels = r.u16()
    if (channels < 1 || channels > ctx.limits.MAX_CHANNELS_PER_LAYER) return false
    r.skip(channels * (ctx.isPsb ? 10 : 6))
    return r.ascii(4) === '8BIM'
  } catch {
    return false
  } finally {
    r.pos = savedPos
    r.littleEndian = savedEndian
  }
}

/** Channel `-2`/`-3` use the MASK rectangle, not the layer's (spec §4.2). */
function channelGeometry(rec: LayerRecordRaw, channelId: number): { width: number; height: number } {
  let rect: PsdRect = rec.rect
  if (channelId === CHANNEL_ID.USER_MASK && rec.mask) rect = rec.mask.rect
  else if (channelId === CHANNEL_ID.REAL_MASK && rec.mask) rect = rec.mask.real?.rect ?? rec.mask.rect
  return { width: rectWidth(rect), height: rectHeight(rect) }
}

function toParsedLayer(rec: LayerRecordRaw, source: Uint8Array, ctx: ReadCtx): ParsedLayer {
  const parsed = parseBlocks(rec.blocks, ctx)
  const sectionType = parsed.sectionType ?? SECTION_TYPE.NORMAL
  const name = parsed.unicodeName ?? rec.legacyName ?? ''
  const channels: PsdChannel[] = rec.channels.map(info => {
    const geom = channelGeometry(rec, info.id)
    return makeChannel(source, info, geom.width, geom.height, ctx)
  })

  if (parsed.text) ctx.warn('text-rasterized', { layer: name }, 'warning')
  if (parsed.smartObjectKey) ctx.warn('smart-object-rasterized', { layer: name }, 'warning')
  if (parsed.hasVectorMask) ctx.warn('vector-mask-rasterized', { layer: name }, 'info')
  if (parsed.effects) ctx.warn('layer-effects-rasterized', { layer: name }, 'warning')

  const base: Omit<PsdLayer, 'children'> = {
    kind: sectionType === SECTION_TYPE.DIVIDER ? 'group' : layerKindFrom(parsed),
    name: name || (sectionType === SECTION_TYPE.DIVIDER ? SECTION_DIVIDER_NAME : ''),
    id: parsed.layerId ?? null,
    rect: rec.rect,
    opacity: rec.opacity,
    fillOpacity: parsed.fillOpacity ?? 255,
    blendMode: rec.blendMode,
    // ⚠️ Bit 1 is INVERTED: set means hidden.
    visible: (rec.flags & 0x02) === 0,
    clipping: rec.clipping,
    locks: locksFrom(parsed.protection, rec.flags),
    colorTag: parsed.colorTag ?? 0,
    expanded: sectionType === SECTION_TYPE.OPEN_FOLDER,
    channels,
    mask: rec.mask,
    effects: parsed.effects ?? null,
    adjustment: parsed.adjustment ?? null,
    text: parsed.text ?? null,
    blocks: rec.blocks,
    blendingRanges: rec.blendingRanges,
    flags: rec.flags,
  }
  return { base, sectionType }
}

function makeChannel(
  source: Uint8Array,
  info: ChannelInfo,
  width: number,
  height: number,
  ctx: ReadCtx,
): PsdChannel {
  const depth: PsdDepth = ctx.depth
  let cache: Uint8Array | null = null
  let pending: Promise<Uint8Array> | null = null

  const run = async (): Promise<Uint8Array> => {
    const need = rowBytesFor(width, depth) * height
    if (need <= 0) return allocBytes(0)
    if (need > ctx.budget.remaining) {
      ctx.warn('channels-dropped', { reason: 'memory-budget', bytes: need })
      return allocBytes(0)
    }
    const start = info.offset
    const end = Math.min(source.length, start + info.dataLength)
    const payload =
      start >= 0 && start < source.length ? source.subarray(start, end) : new Uint8Array(0)
    try {
      const out = await decodeChannel(payload, width, height, depth, ctx.isPsb, ctx)
      ctx.budget.remaining -= out.length
      cache = out
      return out
    } catch {
      ctx.warn('malformed-block-skipped', { section: 'channel', id: info.id })
      cache = allocBytes(need)
      return cache
    }
  }

  return {
    id: info.id,
    dataLength: info.dataLength,
    offset: info.offset,
    decode(): Promise<Uint8Array> {
      if (cache) return Promise.resolve(cache)
      if (!pending) pending = run()
      return pending
    },
  }
}

function readGlobalLayerMask(r: ByteReader, ctx: ReadCtx): PsdGlobalMask | null {
  if (r.remaining < 4) return null
  const length = r.u32()
  if (length === 0) return null
  if (length > r.remaining) {
    ctx.warn('truncated-file', { section: 'global-layer-mask' })
    r.seekTo(r.end)
    return null
  }
  const start = r.pos
  const gr = r.sub(length)
  r.seekTo(start + length)
  if (length < 13) return { overlayColorSpace: 0, colorComponents: [], opacity: 0, kind: 128, data: gr.bytes(Math.min(length, gr.remaining)) }
  const overlayColorSpace = gr.u16()
  const colorComponents = [gr.u16(), gr.u16(), gr.u16(), gr.u16()]
  const opacity = gr.u16()
  const kind = gr.u8()
  return {
    overlayColorSpace,
    colorComponents,
    opacity,
    kind,
    data: gr.bytes(gr.remaining),
  }
}
