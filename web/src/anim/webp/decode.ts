// Animated WebP reader.
//
// Decoding VP8 in TypeScript is as unrealistic as encoding it, so we use the
// mirror image of the encoding trick (see ./encode.ts): the body of an `ANMF`
// chunk IS the image content of a STILL WebP. Re-wrap it in a minimal still
// container, hand it to the platform, and composite the result ourselves using
// the `B` / `D` flags we parsed. That works in any browser able to display a
// WebP at all — which is the entire installed base — so no mandatory path of
// this library depends on WebCodecs.
//
// `parseWebpContainer()` is pure TypeScript and needs no DOM: it is the
// metadata source (`ImageDecoder` would give none of it) and it is what
// `probeWebp()` uses for import budgeting.

import type { AnimDoc, AnimFrame, Blend, Disposal, RgbaImage } from '../types.ts'
import {
  chunk,
  isRiffWebp,
  readU24,
  readU32,
  riffChunks,
  riffWebp,
  VP8X_ALPHA,
  VP8X_ANIMATION,
  vp8x,
} from './riff.ts'

export interface WebpFrameInfo {
  rect: { x: number; y: number; w: number; h: number }
  delayMs: number
  disposal: Disposal
  blend: Blend
  /** The frame's image chunks, ready to be re-wrapped as a still WebP. */
  payload: Uint8Array
  hasAlpha: boolean
  lossless: boolean
}

export interface WebpContainer {
  width: number
  height: number
  loop: number
  animated: boolean
  frames: WebpFrameInfo[]
  truncated: boolean
}

export function isWebp(bytes: Uint8Array): boolean {
  return isRiffWebp(bytes)
}

export function parseWebpContainer(bytes: Uint8Array): WebpContainer {
  if (!isRiffWebp(bytes)) throw new Error('Not a WebP file')
  let width = 0
  let height = 0
  let loop = 0
  let animated = false
  let truncated = false
  const frames: WebpFrameInfo[] = []
  let stillPayload: Uint8Array | null = null
  let stillAlpha = false
  let stillLossless = false

  for (const c of riffChunks(bytes, 12)) {
    switch (c.fourCC) {
      case 'VP8X': {
        if (c.end - c.start < 10) break
        animated = (bytes[c.start] & VP8X_ANIMATION) !== 0
        width = readU24(bytes, c.start + 4) + 1
        height = readU24(bytes, c.start + 7) + 1
        break
      }
      case 'ANIM': {
        if (c.end - c.start < 6) break
        // Background colour (BGRA) is deliberately ignored: like GIF's, no
        // renderer honours it, and honouring it would put a colour slab under
        // transparent animations only in our app.
        loop = bytes[c.start + 4] | (bytes[c.start + 5] << 8)
        break
      }
      case 'ANMF': {
        const f = readAnmf(bytes, c.start, c.end)
        if (f) frames.push(f)
        else truncated = true
        break
      }
      case 'VP8 ':
      case 'VP8L':
      case 'ALPH': {
        // A still image: keep the chunks so a one-frame document can be built.
        const part = bytes.subarray(c.start - 8, c.end + (((c.end - c.start) & 1) ? 1 : 0))
        stillPayload = stillPayload ? concat([stillPayload, part]) : part.slice()
        if (c.fourCC === 'ALPH') stillAlpha = true
        if (c.fourCC === 'VP8L') stillLossless = true
        if (width === 0 || height === 0) {
          const size = c.fourCC === 'VP8L' ? losslessSize(bytes, c.start) : lossySize(bytes, c.start)
          if (size) {
            width = size.w
            height = size.h
          }
        }
        break
      }
      default:
        break
    }
  }

  if (!animated && frames.length === 0 && stillPayload) {
    frames.push({
      rect: { x: 0, y: 0, w: width, h: height },
      delayMs: 0,
      disposal: 'none',
      blend: 'source',
      payload: stillPayload,
      hasAlpha: stillAlpha || stillLossless,
      lossless: stillLossless,
    })
  }

  return { width, height, loop, animated, frames, truncated }
}

function readAnmf(bytes: Uint8Array, start: number, end: number): WebpFrameInfo | null {
  if (end - start < 16) return null
  // The X and Y offsets are stored in units of TWO pixels, which is why the
  // difference-rectangle optimiser has to snap them to even coordinates.
  const x = readU24(bytes, start) * 2
  const y = readU24(bytes, start + 3) * 2
  const w = readU24(bytes, start + 6) + 1
  const h = readU24(bytes, start + 9) + 1
  const duration = readU24(bytes, start + 12)
  const flags = bytes[start + 15]
  let hasAlpha = false
  let lossless = false
  const parts: Uint8Array[] = []
  for (const c of riffChunks(bytes, start + 16, end)) {
    if (c.fourCC === 'ALPH') hasAlpha = true
    if (c.fourCC === 'VP8L') lossless = true
    if (c.fourCC === 'ALPH' || c.fourCC === 'VP8 ' || c.fourCC === 'VP8L') {
      parts.push(bytes.subarray(c.start - 8, c.end + ((c.end - c.start) & 1)))
    }
  }
  if (parts.length === 0) return null
  return {
    rect: { x, y, w, h },
    delayMs: duration,
    // WebP has only two disposal values; there is no 'previous' at all.
    disposal: (flags & 0x01) !== 0 ? 'background' : 'none',
    // B = 0 -> alpha blend (OVER), B = 1 -> do not blend (SOURCE).
    blend: (flags & 0x02) !== 0 ? 'source' : 'over',
    payload: concat(parts),
    hasAlpha,
    lossless,
  }
}

/** Re-wrap an ANMF body as a standalone still WebP the platform can decode. */
export function wrapStill(frame: WebpFrameInfo): Uint8Array {
  if (frame.hasAlpha && !frame.lossless) {
    // Lossy + alpha needs the extended format so the ALPH chunk is legal.
    return riffWebp([chunk('VP8X', vp8x(VP8X_ALPHA, frame.rect.w, frame.rect.h)), frame.payload])
  }
  return riffWebp([frame.payload])
}

/** Injected still-image decoder, so this module needs no DOM of its own. */
export type StillDecoder = (webp: Uint8Array) => Promise<RgbaImage>

export const domStillDecoder: StillDecoder = async (webp) => {
  const blob = new Blob([webp.slice().buffer as ArrayBuffer], { type: 'image/webp' })
  const bitmap = await createImageBitmap(blob)
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2D context unavailable')
    ctx.drawImage(bitmap, 0, 0)
    const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height)
    return { width: data.width, height: data.height, data: data.data }
  } finally {
    // ImageBitmap is not garbage-collected on a timer; leaking these starves
    // the decoder pool within seconds.
    bitmap.close()
  }
}

export async function decodeWebp(bytes: Uint8Array, still: StillDecoder = domStillDecoder): Promise<AnimDoc> {
  const container = parseWebpContainer(bytes)
  const frames: AnimFrame[] = []
  let truncated = container.truncated
  for (const f of container.frames) {
    let img: RgbaImage
    try {
      img = await still(wrapStill(f))
    } catch {
      truncated = true
      continue
    }
    frames.push({
      rect: { x: f.rect.x, y: f.rect.y, w: img.width, h: img.height },
      pixels: img.data,
      delayMs: f.delayMs,
      disposal: f.disposal,
      blend: f.blend,
    })
  }
  return {
    width: container.width || frames[0]?.rect.w || 1,
    height: container.height || frames[0]?.rect.h || 1,
    loop: container.loop,
    frames,
    source: 'webp',
    truncated: truncated || undefined,
  }
}

export function probeWebp(bytes: Uint8Array): { width: number; height: number; frameCount: number; loop: number; animated: boolean } {
  const c = parseWebpContainer(bytes)
  return {
    width: c.width,
    height: c.height,
    frameCount: Math.max(1, c.frames.length),
    loop: c.loop,
    animated: c.animated,
  }
}

/** Dimensions from a lossy VP8 key-frame header. */
function lossySize(b: Uint8Array, p: number): { w: number; h: number } | null {
  if (p + 10 > b.length) return null
  if (b[p + 3] !== 0x9d || b[p + 4] !== 0x01 || b[p + 5] !== 0x2a) return null
  return { w: (b[p + 6] | (b[p + 7] << 8)) & 0x3fff, h: (b[p + 8] | (b[p + 9] << 8)) & 0x3fff }
}

/** Dimensions from a VP8L header (14-bit width and height, minus one). */
function losslessSize(b: Uint8Array, p: number): { w: number; h: number } | null {
  if (p + 5 > b.length || b[p] !== 0x2f) return null
  const bits = readU32(b, p + 1)
  return { w: (bits & 0x3fff) + 1, h: ((bits >>> 14) & 0x3fff) + 1 }
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}
