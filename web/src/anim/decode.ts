// Decoding facade: sniff the container, dispatch, normalise.
//
// THE ARCHITECTURAL RULE, applied without exception:
//
//   pixels MAY come from `ImageDecoder`; METADATA ALWAYS comes from our own
//   container parser.
//
// `ImageDecoder` returns pixels and a duration, and nothing else: no disposal,
// no blend mode, no frame rectangle, no palette, no transparent index, and no
// reliable loop count. Those are exactly what is needed to re-export a file
// faithfully, to show the frame properties in a timeline, and to re-optimise on
// export. The container parser is needed anyway and decodes no pixels, so
// making it optional would save nothing and create a second mode to test.

import { decodeApng, isPng, probeApng } from './apng/index.ts'
import { decodeGif, isGif, probeGif } from './gif/index.ts'
import { canDecodeNatively } from './caps.ts'
import { decodeWebp, isWebp, parseWebpContainer, probeWebp, domStillDecoder, type StillDecoder } from './webp/index.ts'
import type { AnimDoc, AnimInfo, AnimSource, DecodeOptions } from './types.ts'

export type SniffedFormat = AnimSource | 'unknown'

/** Identify a container from its magic bytes alone. */
export function sniffFormat(bytes: Uint8Array): SniffedFormat {
  if (isGif(bytes)) return 'gif'
  if (isPng(bytes)) return hasActl(bytes) ? 'apng' : 'png'
  if (isWebp(bytes)) return 'webp'
  if (isAvif(bytes)) return 'avif'
  return 'unknown'
}

function hasActl(bytes: Uint8Array): boolean {
  // Cheap scan: `acTL` must precede the first IDAT, so we stop there.
  let p = 8
  while (p + 8 <= bytes.length) {
    const len = ((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]) >>> 0
    const type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7])
    if (type === 'acTL') return true
    if (type === 'IDAT' || type === 'IEND') return false
    const next = p + 12 + len
    if (next <= p || next > bytes.length) return false
    p = next
  }
  return false
}

function isAvif(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false
  const brand = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7])
  if (brand !== 'ftyp') return false
  const major = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11])
  return major === 'avif' || major === 'avis'
}

export async function toBytes(input: Blob | ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  if (input instanceof Uint8Array) return input
  if (input instanceof ArrayBuffer) return new Uint8Array(input)
  return new Uint8Array(await input.arrayBuffer())
}

export interface DecodeDeps {
  /** Still-WebP decoder, injected so this module needs no DOM in tests. */
  webpStill?: StillDecoder
}

/**
 * Decode any supported animated (or still) image into an AnimDoc.
 *
 * GIF and APNG always take our own decoders: they are needed for encoding
 * anyway and they are the only way to obtain true per-frame rectangles.
 * WebP goes through the ANMF re-wrap path; AVIF, which we never encode, is
 * read through `ImageDecoder` only, and reported as unavailable without it.
 */
export async function decodeAnimation(
  input: Blob | ArrayBuffer | Uint8Array,
  opts: DecodeOptions = {},
  deps: DecodeDeps = {},
): Promise<AnimDoc> {
  const bytes = await toBytes(input)
  opts.signal?.throwIfAborted()
  switch (sniffFormat(bytes)) {
    case 'gif':
      return decodeGif(bytes)
    case 'apng':
    case 'png':
      return decodeApng(bytes)
    case 'webp':
      return decodeWebp(bytes, deps.webpStill ?? domStillStrict())
    case 'avif':
      return decodeAvif(bytes)
    default:
      throw new Error('Unrecognised image container')
  }
}

function domStillStrict(): StillDecoder {
  if (typeof createImageBitmap !== 'function') {
    throw new Error('WebP decoding needs createImageBitmap in this runtime')
  }
  return domStillDecoder
}

/**
 * AVIF is read-only and depends entirely on `ImageDecoder`; we never write it.
 * Frames come back already composited, so they are reported as full-canvas,
 * 'none'/'source' — the honest description of what the platform gave us.
 */
async function decodeAvif(bytes: Uint8Array): Promise<AnimDoc> {
  if (!(await canDecodeNatively('image/avif'))) {
    throw new Error('This runtime cannot decode AVIF')
  }
  const ID = (globalThis as { ImageDecoder?: typeof ImageDecoder }).ImageDecoder
  if (!ID) throw new Error('This runtime cannot decode AVIF')
  const dec = new ID({ data: bytes.slice().buffer as ArrayBuffer, type: 'image/avif' })
  try {
    await dec.completed
    const track = dec.tracks.selectedTrack
    const count = track?.frameCount ?? 1
    const frames: AnimDoc['frames'] = []
    let width = 0
    let height = 0
    for (let i = 0; i < count; i++) {
      const { image } = await dec.decode({ frameIndex: i })
      try {
        width = image.displayWidth
        height = image.displayHeight
        const buf = new Uint8ClampedArray(width * height * 4)
        await image.copyTo(buf)
        frames.push({
          rect: { x: 0, y: 0, w: width, h: height },
          pixels: buf,
          // VideoFrame.duration is in MICROseconds.
          delayMs: (image.duration ?? 0) / 1000,
          disposal: 'none',
          blend: 'source',
        })
      } finally {
        // VideoFrame is not garbage-collected: forgetting close() exhausts the
        // decoder's frame pool and wedges ImageDecoder within seconds.
        image.close()
      }
    }
    return {
      width: width || 1,
      height: height || 1,
      loop: track?.repetitionCount ?? 0,
      frames,
      source: 'avif',
    }
  } finally {
    dec.close()
  }
}

/** Container metadata only — no pixels decoded. Cheap; used for import budgeting. */
export async function probeAnimation(input: Blob | ArrayBuffer | Uint8Array): Promise<AnimInfo> {
  const bytes = await toBytes(input)
  const format = sniffFormat(bytes)
  let width = 0
  let height = 0
  let frameCount = 1
  let loop = 0
  let animated = false

  switch (format) {
    case 'gif': {
      const g = probeGif(bytes)
      width = g.width
      height = g.height
      frameCount = Math.max(1, g.frameCount)
      loop = g.loop
      animated = frameCount > 1
      break
    }
    case 'apng':
    case 'png': {
      const a = probeApng(bytes)
      width = a.width
      height = a.height
      frameCount = a.frameCount
      loop = a.loop
      animated = a.animated && frameCount > 1
      break
    }
    case 'webp': {
      const w = probeWebp(bytes)
      width = w.width
      height = w.height
      frameCount = w.frameCount
      loop = w.loop
      animated = w.animated && frameCount > 1
      break
    }
    case 'avif':
      // The AVIF box structure would need a full parser for a number we only
      // use as a budget hint; report one frame and let the decode correct it.
      animated = true
      break
    default:
      throw new Error('Unrecognised image container')
  }

  return {
    // 'unknown' already threw in the switch above.
    format,
    width,
    height,
    frameCount,
    loop,
    estimatedBytes: width * height * 4 * frameCount,
    animated,
  }
}

export { parseWebpContainer }
