/*
 * PSD/PSB channel compression dispatch (spec §3).
 *
 * Derived from the GIMP PSD plug-in (file-psd), Copyright 2007 John Marshall,
 * GPLv3+ — `read_channel_data()` in psd-load.c — and from Adobe's public
 * "Photoshop File Formats Specification". Independent TypeScript
 * re-implementation; no GIMP source was copied. Kubuno is AGPLv3.
 */
import { PsdError, allocBytes } from '../errors.ts'
import { COMPRESSION } from '../constants.ts'
import type { PsdDepth, WarningSink } from '../types.ts'
import { decodePackBits, encodePackBits, packBitsWorstCase } from './packbits.ts'
import { undoPredictor } from './predictor.ts'
import { inflateZlib } from './zip.ts'

/** Bytes per row for one channel at the given geometry. */
export function rowBytesFor(width: number, depth: PsdDepth): number {
  return depth === 1 ? Math.ceil(width / 8) : width * (depth >> 3)
}

/**
 * Decodes one layer channel.
 *
 * `payload` is the channel's data INCLUDING the leading `uint16 compression`,
 * exactly as `ChannelInfo.dataLength` describes it.
 *
 * Never throws for recoverable problems: a short or corrupt payload yields a
 * zero-filled buffer of the right size plus a warning, so one bad channel can
 * never abort an import.
 */
export async function decodeChannel(
  payload: Uint8Array,
  width: number,
  height: number,
  depth: PsdDepth,
  isPsb: boolean,
  sink: WarningSink,
): Promise<Uint8Array> {
  const rowBytes = rowBytesFor(width, depth)
  const need = rowBytes * height
  if (need <= 0) return allocBytes(0)
  if (payload.length < 2) {
    // dataLength === 0 or 2 means "no pixels": legal for section dividers and
    // adjustment layers.
    return allocBytes(need)
  }
  const compression = (payload[0] << 8) | payload[1]
  const body = payload.subarray(2)

  switch (compression) {
    case COMPRESSION.RAW:
      return fromRaw(body, need, sink)
    case COMPRESSION.RLE:
      return fromRle(body, rowBytes, height, isPsb, sink)
    case COMPRESSION.ZIP:
      return fromZip(body, need, sink)
    case COMPRESSION.ZIP_PREDICTED: {
      const flat = await fromZip(body, need, sink)
      return undoPredictor(flat, depth, height, width)
    }
    default:
      throw new PsdError('UNSUPPORTED_COMPRESSION', { compression })
  }
}

function fromRaw(body: Uint8Array, need: number, sink: WarningSink): Uint8Array {
  const out = allocBytes(need)
  const take = Math.min(need, body.length)
  out.set(body.subarray(0, take))
  if (take < need) sink.warn('truncated-file', { missing: need - take })
  return out
}

/**
 * RLE: `height` row lengths (uint16 in PSD, uint32 in PSB) followed by the
 * packed rows. Each row is an independent PackBits stream, which is also what
 * makes partial/banded decoding possible later on.
 */
function fromRle(
  body: Uint8Array,
  rowBytes: number,
  height: number,
  isPsb: boolean,
  sink: WarningSink,
): Uint8Array {
  const out = allocBytes(rowBytes * height)
  const lenSize = isPsb ? 4 : 2
  const tableBytes = height * lenSize
  if (body.length < tableBytes) {
    sink.warn('truncated-file', { section: 'rle-table' })
    return out
  }
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
  let src = tableBytes
  let short = false
  for (let y = 0; y < height; y++) {
    const packed = isPsb ? view.getUint32(y * 4, false) : view.getUint16(y * 2, false)
    if (src >= body.length) {
      short = true
      break
    }
    const avail = Math.min(packed, body.length - src)
    if (avail < packed) short = true
    decodePackBits(body, src, avail, out, y * rowBytes, rowBytes)
    src += packed
  }
  if (short) sink.warn('truncated-file', { section: 'rle-rows' })
  return out
}

async function fromZip(body: Uint8Array, need: number, sink: WarningSink): Promise<Uint8Array> {
  try {
    return await inflateZlib(body, need)
  } catch (e) {
    sink.warn('malformed-block-skipped', {
      section: 'zip',
      reason: e instanceof Error ? e.message : String(e),
    })
    return allocBytes(need)
  }
}

/**
 * Decodes the Image Data section, where a SINGLE row-length table covers every
 * channel (`height * channelCount` entries) before any packed data.
 *
 * Returns one buffer per channel, each `rowBytes * height` long.
 */
export async function decodeImageData(
  payload: Uint8Array,
  width: number,
  height: number,
  channelCount: number,
  depth: PsdDepth,
  isPsb: boolean,
  sink: WarningSink,
): Promise<Uint8Array[]> {
  const rowBytes = rowBytesFor(width, depth)
  const perChannel = rowBytes * height
  const planes: Uint8Array[] = []
  if (payload.length < 2 || perChannel <= 0 || channelCount <= 0) {
    for (let c = 0; c < channelCount; c++) planes.push(allocBytes(Math.max(0, perChannel)))
    return planes
  }
  const compression = (payload[0] << 8) | payload[1]
  const body = payload.subarray(2)

  if (compression === COMPRESSION.RLE) {
    const lenSize = isPsb ? 4 : 2
    const rowCount = height * channelCount
    const tableBytes = rowCount * lenSize
    if (body.length < tableBytes) {
      sink.warn('truncated-file', { section: 'image-data-rle-table' })
      for (let c = 0; c < channelCount; c++) planes.push(allocBytes(perChannel))
      return planes
    }
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
    let src = tableBytes
    let row = 0
    for (let c = 0; c < channelCount; c++) {
      const out = allocBytes(perChannel)
      for (let y = 0; y < height; y++, row++) {
        const packed = isPsb ? view.getUint32(row * 4, false) : view.getUint16(row * 2, false)
        if (src >= body.length) break
        const avail = Math.min(packed, body.length - src)
        decodePackBits(body, src, avail, out, y * rowBytes, rowBytes)
        src += packed
      }
      planes.push(out)
    }
    return planes
  }

  // Raw / ZIP: the channels are simply concatenated.
  let flat: Uint8Array
  if (compression === COMPRESSION.RAW) {
    flat = body
  } else if (compression === COMPRESSION.ZIP || compression === COMPRESSION.ZIP_PREDICTED) {
    flat = await fromZip(body, perChannel * channelCount, sink)
    if (compression === COMPRESSION.ZIP_PREDICTED) {
      flat = undoPredictor(flat, depth, height * channelCount, width)
    }
  } else {
    throw new PsdError('UNSUPPORTED_COMPRESSION', { compression })
  }
  for (let c = 0; c < channelCount; c++) {
    const out = allocBytes(perChannel)
    const from = c * perChannel
    const take = Math.max(0, Math.min(perChannel, flat.length - from))
    if (take > 0) out.set(flat.subarray(from, from + take))
    if (take < perChannel) sink.warn('truncated-file', { section: 'image-data' })
    planes.push(out)
  }
  return planes
}

/**
 * RLE-encodes one channel, producing the complete payload (compression header,
 * row-length table, packed rows). This is what Kubuno always writes for 8-bit
 * data: universally readable, and flat areas cost ~2 bytes per row.
 */
export function encodeChannelRle(
  samples: Uint8Array,
  width: number,
  height: number,
  depth: PsdDepth,
  isPsb: boolean,
): Uint8Array {
  const rowBytes = rowBytesFor(width, depth)
  const lenSize = isPsb ? 4 : 2
  const scratch = allocBytes(packBitsWorstCase(rowBytes))
  const rows: Uint8Array[] = []
  const lengths = new Array<number>(height)
  let packedTotal = 0
  for (let y = 0; y < height; y++) {
    const row = samples.subarray(y * rowBytes, (y + 1) * rowBytes)
    const n = encodePackBits(row, scratch, 0)
    lengths[y] = n
    const copy = allocBytes(n)
    copy.set(scratch.subarray(0, n))
    rows.push(copy)
    packedTotal += n
  }
  const out = allocBytes(2 + height * lenSize + packedTotal)
  const view = new DataView(out.buffer)
  view.setUint16(0, COMPRESSION.RLE, false)
  let at = 2
  for (let y = 0; y < height; y++) {
    if (isPsb) view.setUint32(at, lengths[y], false)
    else view.setUint16(at, lengths[y], false)
    at += lenSize
  }
  for (const r of rows) {
    out.set(r, at)
    at += r.length
  }
  return out
}
