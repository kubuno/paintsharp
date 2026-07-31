// AnimDoc -> APNG.
//
// APNG is a plain PNG plus three ancillary chunks (`acTL`, `fcTL`, `fdAT`);
// their lowercase first letter means a PNG decoder that does not know them
// ignores them and shows the IDAT — i.e. the first frame — with no error at
// all. That fallback is APNG's whole point, so we always write the variant
// where the first `fcTL` precedes the IDAT and the IDAT IS frame 0.
//
// Three traps, all handled below:
//  1. The sequence number is ONE counter shared by fcTL and fdAT, starting at 0
//     and incremented for each chunk of either kind, in file order. It is not a
//     frame index and it is not two counters. Firefox and Chrome reject the
//     whole file when it is wrong, with no usable message — so it is produced
//     by a single writeSeq(), never recomputed.
//  2. Whether the IDAT belongs to the animation depends on where the first fcTL
//     sits. Ours always precedes it, which imposes width/height equal to IHDR's
//     and zero offsets on that first fcTL.
//  3. Every frame is an INDEPENDENT zlib stream. Slightly bigger than a shared
//     dictionary would be, but it makes per-frame parallel encoding possible.
//
// Inter-frame optimisation is strictly more powerful here than in GIF: with a
// real alpha channel, unchanged pixels get alpha 0 under blend OVER without any
// clash with genuine transparency, and an erasure is expressed by switching the
// frame to blend SOURCE. GIF's costly arbitration simply does not exist.

import { planFrames, type FramePlan } from '../optimize.ts'
import { resolveForTarget } from '../resolve.ts'
import { APNG_CAPS, type AnimDoc, type ApngEncodeOptions, type RgbaImage } from '../types.ts'
import { crc32Concat } from './crc32.ts'
import { filterScanlines } from './filter.ts'
import { deflate } from './zlib.ts'

const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)

export async function encodeApng(doc: AnimDoc, options: ApngEncodeOptions = {}): Promise<Uint8Array> {
  const optimize = options.optimize !== false
  const resolved = resolveForTarget(doc, APNG_CAPS, options)
  const width = Math.max(1, resolved.width)
  const height = Math.max(1, resolved.height)
  const frames: RgbaImage[] = resolved.frames.map((f) => ({ width, height, data: f.pixels }))
  const delays = resolved.frames.map((f) => f.delayMs)

  const plans = planFrames(frames, delays, { caps: APNG_CAPS, optimize })
  if (plans.length === 0) throw new Error('Cannot encode an empty animation')

  // Trap 2: the first fcTL sits before the IDAT, so it must describe the whole
  // canvas at offset (0, 0). Re-issue frame 0 full size if the optimiser shrank it.
  if (plans[0].rect.w !== width || plans[0].rect.h !== height || plans[0].rect.x !== 0 || plans[0].rect.y !== 0) {
    plans[0] = {
      rect: { x: 0, y: 0, w: width, h: height },
      pixels: new Uint8ClampedArray(frames[0].data),
      delayMs: plans[0].delayMs,
      disposal: plans[0].disposal,
      blend: 'source',
    }
  }

  const style = pickColorType(plans, options.indexed ?? 'auto')
  options.onProgress?.(0, plans.length, 'encode')

  const parts: Uint8Array[] = [SIGNATURE]
  parts.push(chunk('IHDR', ihdr(width, height, style.colorType)))
  if (style.palette) {
    parts.push(chunk('PLTE', style.palette.plte))
    if (style.palette.trns.length > 0) parts.push(chunk('tRNS', style.palette.trns))
  }
  parts.push(chunk('acTL', actl(plans.length, resolved.loop)))

  let seq = 0
  const nextSeq = (): number => seq++

  for (let i = 0; i < plans.length; i++) {
    options.signal?.throwIfAborted()
    const plan = plans[i]
    parts.push(chunk('fcTL', fctl(nextSeq(), plan)))
    const raster = rasterise(plan, style)
    const compressed = await deflate(raster)
    if (i === 0) {
      parts.push(chunk('IDAT', compressed))
    } else {
      const body = new Uint8Array(4 + compressed.length)
      writeU32(body, 0, nextSeq())
      body.set(compressed, 4)
      parts.push(chunk('fdAT', body))
    }
    options.onProgress?.(i + 1, plans.length, 'encode')
  }

  parts.push(chunk('IEND', new Uint8Array(0)))
  return concat(parts)
}

interface Style {
  colorType: 2 | 3 | 6
  palette: { plte: Uint8Array; trns: Uint8Array; index: Map<number, number> } | null
}

/**
 * Pick the smallest colour type the content allows:
 *   no pixel with a < 255            -> type 2 (RGB), 25 % less raw data
 *   <= 256 distinct RGBA values      -> type 3 (palette + tRNS), often dramatic
 *   otherwise                        -> type 6 (RGBA)
 * The census runs on the PLANNED pixels, which already carry the alpha-0 diff
 * markers, not on the source frames.
 */
function pickColorType(plans: readonly FramePlan[], indexed: boolean | 'auto'): Style {
  const distinct = new Map<number, number>()
  let hasAlpha = false
  let overflow = false
  for (const p of plans) {
    const px = p.pixels
    for (let o = 0; o < px.length; o += 4) {
      if (px[o + 3] !== 255) hasAlpha = true
      if (overflow) continue
      const key = ((px[o] << 24) | (px[o + 1] << 16) | (px[o + 2] << 8) | px[o + 3]) >>> 0
      if (!distinct.has(key)) {
        distinct.set(key, 0)
        if (distinct.size > 256) overflow = true
      }
    }
  }

  const canIndex = !overflow && distinct.size <= 256
  const wantIndex = indexed === true ? canIndex : indexed === 'auto' ? canIndex : false
  if (wantIndex) {
    // Deterministic order: transparent entries first (so tRNS stays short),
    // then by RGB value.
    const keys = [...distinct.keys()].sort((a, b) => {
      const aa = a & 0xff
      const ba = b & 0xff
      return aa - ba || (a >>> 8) - (b >>> 8)
    })
    const plte = new Uint8Array(keys.length * 3)
    const alphas = new Uint8Array(keys.length)
    const index = new Map<number, number>()
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i]
      plte[i * 3] = (k >>> 24) & 0xff
      plte[i * 3 + 1] = (k >>> 16) & 0xff
      plte[i * 3 + 2] = (k >>> 8) & 0xff
      alphas[i] = k & 0xff
      index.set(k, i)
    }
    let trnsLen = alphas.length
    while (trnsLen > 0 && alphas[trnsLen - 1] === 255) trnsLen--
    return { colorType: 3, palette: { plte, trns: alphas.subarray(0, trnsLen), index } }
  }
  return { colorType: hasAlpha ? 6 : 2, palette: null }
}

function rasterise(plan: FramePlan, style: Style): Uint8Array {
  const { rect, pixels } = plan
  const n = rect.w * rect.h
  if (style.colorType === 3 && style.palette) {
    const raw = new Uint8Array(n)
    for (let i = 0; i < n; i++) {
      const o = i * 4
      const key = ((pixels[o] << 24) | (pixels[o + 1] << 16) | (pixels[o + 2] << 8) | pixels[o + 3]) >>> 0
      raw[i] = style.palette.index.get(key) ?? 0
    }
    return filterScanlines(raw, rect.w, rect.h, 1)
  }
  if (style.colorType === 2) {
    const raw = new Uint8Array(n * 3)
    for (let i = 0; i < n; i++) {
      raw[i * 3] = pixels[i * 4]
      raw[i * 3 + 1] = pixels[i * 4 + 1]
      raw[i * 3 + 2] = pixels[i * 4 + 2]
    }
    return filterScanlines(raw, rect.w * 3, rect.h, 3)
  }
  return filterScanlines(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.length), rect.w * 4, rect.h, 4)
}

function ihdr(width: number, height: number, colorType: number): Uint8Array {
  const b = new Uint8Array(13)
  writeU32(b, 0, width)
  writeU32(b, 4, height)
  b[8] = 8 // bit depth
  b[9] = colorType
  b[10] = 0 // compression: deflate
  b[11] = 0 // filter method: adaptive
  b[12] = 0 // interlace: none
  return b
}

function actl(frameCount: number, loop: number): Uint8Array {
  const b = new Uint8Array(8)
  writeU32(b, 0, frameCount)
  writeU32(b, 4, loop)
  return b
}

function fctl(sequence: number, plan: FramePlan): Uint8Array {
  const b = new Uint8Array(26)
  writeU32(b, 0, sequence)
  writeU32(b, 4, plan.rect.w)
  writeU32(b, 8, plan.rect.h)
  writeU32(b, 12, plan.rect.x)
  writeU32(b, 16, plan.rect.y)
  // A fraction, so 1/30 s or 1/60 s are exact — impossible in GIF. We use
  // den = 1000 and num = milliseconds: exact for our model and readable in a
  // hex dump. This is also why GIF -> APNG is faithful while the reverse rounds.
  const ms = Math.max(0, Math.min(0xffff, Math.round(plan.delayMs)))
  b[20] = (ms >> 8) & 0xff
  b[21] = ms & 0xff
  b[22] = 0x03
  b[23] = 0xe8 // 1000
  b[24] = plan.disposal === 'background' ? 1 : plan.disposal === 'previous' ? 2 : 0
  b[25] = plan.blend === 'over' ? 1 : 0
  return b
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  writeU32(out, 0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  // The CRC covers the TYPE and the DATA, never the length field.
  writeU32(out, 8 + data.length, crc32Concat([out.subarray(4, 8), data]))
  return out
}

function writeU32(b: Uint8Array, p: number, v: number): void {
  b[p] = (v >>> 24) & 0xff
  b[p + 1] = (v >>> 16) & 0xff
  b[p + 2] = (v >>> 8) & 0xff
  b[p + 3] = v & 0xff
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
