// PNG / APNG decoder.
//
// Written in full rather than delegating to the platform, for two reasons that
// are not negotiable: no browser exposes APNG frames to JavaScript reliably,
// and even one that did would not report `dispose_op`, `blend_op` or the frame
// offsets — precisely the metadata a faithful re-export needs.
//
// A useful side effect: this is also a complete PNG decoder (1/2/4/8/16 bits,
// grey, RGB, palette, grey+alpha, RGBA, Adam7), so callers can learn what a PNG
// really contains instead of getting `createImageBitmap`'s silent 8-bit RGBA.

import type { AnimDoc, AnimFrame, Blend, Disposal } from '../types.ts'
import { adam7Passes, unfilter } from './filter.ts'
import { inflate } from './zlib.ts'

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

export function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false
  for (let i = 0; i < 8; i++) if (bytes[i] !== SIGNATURE[i]) return false
  return true
}

interface Chunk {
  type: string
  start: number
  end: number
}

/** Walk the chunk list. Stops cleanly at the first malformed length. */
function* chunks(bytes: Uint8Array): Generator<Chunk> {
  let p = 8
  while (p + 8 <= bytes.length) {
    const len = readU32(bytes, p)
    const type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7])
    const start = p + 8
    const end = start + len
    // A length that overruns the buffer means the file is truncated; the CRC
    // that follows would be missing too. Stop, do not throw.
    if (end > bytes.length || len < 0) return
    yield { type, start, end }
    p = end + 4
  }
}

interface Ihdr {
  width: number
  height: number
  bitDepth: number
  colorType: number
  interlace: number
}

interface FrameControl {
  sequence: number
  width: number
  height: number
  x: number
  y: number
  delayMs: number
  disposal: Disposal
  blend: Blend
}

export interface ApngDecodeResult extends AnimDoc {
  source: 'apng' | 'png'
  /** True when the IDAT is only a static fallback, outside the animation. */
  separateStill: boolean
  bitDepth: number
  colorType: number
  interlaced: boolean
}

export async function decodeApng(bytes: Uint8Array): Promise<ApngDecodeResult> {
  if (!isPng(bytes)) throw new Error('Not a PNG file')

  let ihdr: Ihdr | null = null
  let plte: Uint8Array | null = null
  let trns: Uint8Array | null = null
  let loop = 0
  let sawActl = false
  let truncated = false

  const idat: Uint8Array[] = []
  let idatFcTL: FrameControl | null = null
  let firstFcTLBeforeIdat = false
  let sawIdat = false

  const animFrames: { fc: FrameControl; parts: Uint8Array[] }[] = []
  let current: { fc: FrameControl; parts: Uint8Array[] } | null = null
  let expectedSeq = 0
  let seqBroken = false

  for (const c of chunks(bytes)) {
    switch (c.type) {
      case 'IHDR': {
        if (c.end - c.start < 13) throw new Error('Malformed IHDR')
        ihdr = {
          width: readU32(bytes, c.start),
          height: readU32(bytes, c.start + 4),
          bitDepth: bytes[c.start + 8],
          colorType: bytes[c.start + 9],
          interlace: bytes[c.start + 12],
        }
        break
      }
      case 'PLTE':
        plte = bytes.slice(c.start, c.end)
        break
      case 'tRNS':
        trns = bytes.slice(c.start, c.end)
        break
      case 'acTL':
        if (c.end - c.start >= 8) {
          sawActl = true
          loop = readU32(bytes, c.start + 4)
        }
        break
      case 'fcTL': {
        if (c.end - c.start < 26) break
        const fc = readFcTL(bytes, c.start)
        // The sequence number is ONE counter shared by fcTL and fdAT, starting
        // at 0 and incremented for each of them in file order. Mismatches are
        // reported, not fatal: rejecting the file outright is what browsers do,
        // but an editor should still let the user recover the frames.
        if (fc.sequence !== expectedSeq) seqBroken = true
        expectedSeq = fc.sequence + 1
        if (!sawIdat) {
          firstFcTLBeforeIdat = true
          idatFcTL = fc
        } else {
          current = { fc, parts: [] }
          animFrames.push(current)
        }
        break
      }
      case 'fdAT': {
        if (c.end - c.start < 4) break
        const seq = readU32(bytes, c.start)
        if (seq !== expectedSeq) seqBroken = true
        expectedSeq = seq + 1
        if (current) current.parts.push(bytes.subarray(c.start + 4, c.end))
        break
      }
      case 'IDAT':
        sawIdat = true
        idat.push(bytes.subarray(c.start, c.end))
        break
      case 'IEND':
        break
      default:
        break
    }
  }

  if (!ihdr) throw new Error('Missing IHDR')
  const { width, height } = ihdr

  const frames: AnimFrame[] = []

  const decodeOne = async (
    parts: Uint8Array[],
    w: number,
    h: number,
  ): Promise<Uint8ClampedArray | null> => {
    if (w <= 0 || h <= 0) return null
    let raw: Uint8Array
    try {
      raw = await inflate(concat(parts))
    } catch {
      truncated = true
      return null
    }
    return expand(raw, w, h, ihdr, plte, trns)
  }

  // Each frame is an INDEPENDENT zlib stream: the fdAT chunks of one frame
  // concatenate into one complete stream, with no dictionary shared with the
  // others. (Multiple IDATs of a static PNG, by contrast, form a single stream.)
  const idatPixels = idat.length > 0 ? await decodeOne(idat, width, height) : null

  if (idatPixels) {
    if (sawActl && firstFcTLBeforeIdat && idatFcTL) {
      frames.push(toFrame(idatFcTL, idatPixels))
    } else if (!sawActl || !firstFcTLBeforeIdat) {
      // Either a plain PNG, or an APNG whose IDAT is only the static fallback.
      if (!sawActl) {
        frames.push({
          rect: { x: 0, y: 0, w: width, h: height },
          pixels: idatPixels,
          delayMs: 0,
          disposal: 'none',
          blend: 'source',
        })
      }
    }
  }

  for (const f of animFrames) {
    const px = await decodeOne(f.parts, f.fc.width, f.fc.height)
    if (!px) {
      truncated = true
      continue
    }
    frames.push(toFrame(f.fc, px))
  }

  if (seqBroken) truncated = true

  return {
    width,
    height,
    loop,
    frames,
    source: sawActl ? 'apng' : 'png',
    truncated: truncated || undefined,
    separateStill: sawActl && !firstFcTLBeforeIdat,
    bitDepth: ihdr.bitDepth,
    colorType: ihdr.colorType,
    interlaced: ihdr.interlace === 1,
  }
}

/** Container metadata only, without inflating anything. */
export function probeApng(bytes: Uint8Array): {
  width: number
  height: number
  frameCount: number
  loop: number
  animated: boolean
} {
  if (!isPng(bytes)) throw new Error('Not a PNG file')
  let width = 0
  let height = 0
  let frameCount = 0
  let loop = 0
  let animated = false
  for (const c of chunks(bytes)) {
    if (c.type === 'IHDR' && c.end - c.start >= 13) {
      width = readU32(bytes, c.start)
      height = readU32(bytes, c.start + 4)
    } else if (c.type === 'acTL' && c.end - c.start >= 8) {
      animated = true
      frameCount = readU32(bytes, c.start)
      loop = readU32(bytes, c.start + 4)
    } else if (c.type === 'IDAT' && !animated) {
      frameCount = 1
    }
  }
  return { width, height, frameCount: Math.max(1, frameCount), loop, animated }
}

function toFrame(fc: FrameControl, pixels: Uint8ClampedArray): AnimFrame {
  return {
    rect: { x: fc.x, y: fc.y, w: fc.width, h: fc.height },
    pixels,
    delayMs: fc.delayMs,
    disposal: fc.disposal,
    blend: fc.blend,
  }
}

function readFcTL(bytes: Uint8Array, p: number): FrameControl {
  const delayNum = (bytes[p + 20] << 8) | bytes[p + 21]
  const delayDen = (bytes[p + 22] << 8) | bytes[p + 23]
  const den = delayDen === 0 ? 100 : delayDen
  const dispose = bytes[p + 24]
  const blend = bytes[p + 25]
  return {
    sequence: readU32(bytes, p),
    width: readU32(bytes, p + 4),
    height: readU32(bytes, p + 8),
    x: readU32(bytes, p + 12),
    y: readU32(bytes, p + 16),
    delayMs: (delayNum / den) * 1000,
    disposal: dispose === 1 ? 'background' : dispose === 2 ? 'previous' : 'none',
    blend: blend === 1 ? 'over' : 'source',
  }
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

/** Defilter and expand a raw PNG raster to RGBA8. */
function expand(
  raw: Uint8Array,
  w: number,
  h: number,
  ihdr: Ihdr,
  plte: Uint8Array | null,
  trns: Uint8Array | null,
): Uint8ClampedArray {
  const channels = CHANNELS[ihdr.colorType] ?? 4
  const bitDepth = ihdr.bitDepth || 8
  const out = new Uint8ClampedArray(w * h * 4)

  if (ihdr.interlace === 1) {
    let off = 0
    for (const pass of adam7Passes(w, h)) {
      if (pass.width === 0 || pass.height === 0) continue
      const bpr = Math.ceil((bitDepth * channels * pass.width) / 8)
      const bpp = Math.max(1, Math.ceil((bitDepth * channels) / 8))
      const need = (bpr + 1) * pass.height
      const slice = raw.subarray(off, off + need)
      off += need
      const flat = unfilter(slice, bpr, pass.height, bpp)
      writePixels(flat, out, w, pass.width, pass.height, bitDepth, channels, ihdr.colorType, plte, trns, pass)
    }
    return out
  }

  const bpr = Math.ceil((bitDepth * channels * w) / 8)
  const bpp = Math.max(1, Math.ceil((bitDepth * channels) / 8))
  const flat = unfilter(raw, bpr, h, bpp)
  writePixels(flat, out, w, w, h, bitDepth, channels, ihdr.colorType, plte, trns, null)
  return out
}

function writePixels(
  flat: Uint8Array,
  out: Uint8ClampedArray,
  imageWidth: number,
  w: number,
  h: number,
  bitDepth: number,
  channels: number,
  colorType: number,
  plte: Uint8Array | null,
  trns: Uint8Array | null,
  pass: { xOffset: number; yOffset: number; xStep: number; yStep: number } | null,
): void {
  const bpr = Math.ceil((bitDepth * channels * w) / 8)
  const max = (1 << bitDepth) - 1
  const sample = (row: number, i: number): number => {
    if (bitDepth === 8) return flat[row * bpr + i]
    // Full 16-bit sample; scale() does the rounded 16 -> 8 reduction. Simply
    // taking the high byte truncates and drifts by one against every other
    // decoder.
    if (bitDepth === 16) return (flat[row * bpr + i * 2] << 8) | flat[row * bpr + i * 2 + 1]
    const bitsPerSample = bitDepth
    const bitPos = i * bitsPerSample
    const byte = flat[row * bpr + (bitPos >> 3)] ?? 0
    const shift = 8 - bitsPerSample - (bitPos & 7)
    return (byte >> shift) & max
  }

  for (let y = 0; y < h; y++) {
    const dy = pass ? pass.yOffset + y * pass.yStep : y
    for (let x = 0; x < w; x++) {
      const dx = pass ? pass.xOffset + x * pass.xStep : x
      const d = (dy * imageWidth + dx) * 4
      const base = x * channels
      let r = 0
      let g = 0
      let b = 0
      let a = 255
      switch (colorType) {
        case 0: {
          const v = scale(sample(y, base), bitDepth)
          r = g = b = v
          if (trns && trns.length >= 2) {
            const key = (trns[0] << 8) | trns[1]
            // tRNS for greyscale holds a 16-bit key whatever the bit depth.
            if (sample(y, base) === (bitDepth === 16 ? key : key & ((1 << bitDepth) - 1))) a = 0
          }
          break
        }
        case 2: {
          r = scale(sample(y, base), bitDepth)
          g = scale(sample(y, base + 1), bitDepth)
          b = scale(sample(y, base + 2), bitDepth)
          break
        }
        case 3: {
          const idx = sample(y, base)
          if (plte) {
            r = plte[idx * 3] ?? 0
            g = plte[idx * 3 + 1] ?? 0
            b = plte[idx * 3 + 2] ?? 0
          }
          a = trns && idx < trns.length ? trns[idx] : 255
          break
        }
        case 4: {
          const v = scale(sample(y, base), bitDepth)
          r = g = b = v
          a = scale(sample(y, base + 1), bitDepth)
          break
        }
        default: {
          r = scale(sample(y, base), bitDepth)
          g = scale(sample(y, base + 1), bitDepth)
          b = scale(sample(y, base + 2), bitDepth)
          a = scale(sample(y, base + 3), bitDepth)
          break
        }
      }
      out[d] = r
      out[d + 1] = g
      out[d + 2] = b
      out[d + 3] = a
    }
  }
}

function scale(v: number, bitDepth: number): number {
  if (bitDepth === 8) return v
  // 16 -> 8 as floor(v / 257). 257 = 65535 / 255, so this is exact for the
  // common case of a 16-bit file derived from 8-bit data, and it matches
  // ImageMagick byte for byte (measured: 0 mismatches over a 16-bit RGBA and a
  // 16-bit greyscale sample, where both `v >> 8` and round(v * 255 / 65535)
  // drift by one on part of the pixels). Agreeing with the tools on the machine
  // matters more here than picking the theoretically unbiased rounding.
  if (bitDepth === 16) return Math.floor(v / 257)
  const max = (1 << bitDepth) - 1
  return Math.round((v * 255) / max)
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

function readU32(b: Uint8Array, p: number): number {
  return ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0
}
