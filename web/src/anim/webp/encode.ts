// Animated WebP writer.
//
// The observation that makes this possible without a single byte of WebAssembly:
//
//   the body of an `ANMF` chunk is EXACTLY the image content of a still WebP.
//
// An animated WebP is not another format; it is the same VP8 / VP8L bitstream
// packed inside `ANMF` instead of directly under `RIFF/WEBP`. So each frame is
// rendered to a canvas, handed to `convertToBlob('image/webp')` — the browser's
// own libwebp, in native code — and the resulting chunks are copied byte for
// byte into an `ANMF`. No re-encoding, no extra loss, ~200 lines, and the
// quality of libwebp because it IS libwebp.
//
// What we give up is libwebp's inter-frame prediction (`WebPAnimEncoder`'s
// kmin/kmax key-frame logic). We get most of it back at the CONTAINER level by
// encoding only the sub-rectangle that changes, with B = 0 and D = 0 — which is
// what libwebp does at that level too. On fixed-background content, i.e. nearly
// everything authored in an image editor, the gap is small.
//
// WebP also has NO 'previous' disposal. `resolveForTarget()` flattens the
// document first, so that case is resolved before we get here.

import { planFrames } from '../optimize.ts'
import { resolveForTarget } from '../resolve.ts'
import { WEBP_CAPS, type AnimDoc, type RgbaImage, type WebpEncodeOptions } from '../types.ts'
import {
  chunk,
  isRiffWebp,
  riffChunks,
  riffWebp,
  VP8X_ALPHA,
  VP8X_ANIMATION,
  vp8x,
  writeU24,
  writeU32,
} from './riff.ts'

/**
 * Injected still-image encoder: RGBA in, a complete still WebP file out.
 * Keeping it injectable is what lets this module be exercised without a DOM.
 */
export type StillEncoder = (image: RgbaImage, quality: number | 'lossless') => Promise<Uint8Array>

export const domStillEncoder: StillEncoder = async (image, quality) => {
  const canvas = new OffscreenCanvas(image.width, image.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2D context unavailable')
  const data = new ImageData(new Uint8ClampedArray(image.data), image.width, image.height)
  ctx.putImageData(data, 0, 0)
  // quality === 1 makes Chromium switch to VP8L (lossless). That is a perfectly
  // legal ANMF body, and the parser handles both cases anyway.
  const blob = await canvas.convertToBlob({
    type: 'image/webp',
    quality: quality === 'lossless' ? 1 : Math.max(0.01, Math.min(0.99, quality / 100)),
  })
  const bytes = new Uint8Array(await blob.arrayBuffer())
  // `toBlob`/`convertToBlob` fall back to PNG SILENTLY when the requested type
  // is unsupported, and `blob.type` does not always tell the truth: check the
  // magic bytes, never the MIME string.
  if (!isRiffWebp(bytes)) throw new Error('This browser cannot encode WebP')
  return bytes
}

/** Probe, at runtime, whether the platform can really produce WebP. */
export async function probeWebpEncoding(encoder: StillEncoder = domStillEncoder): Promise<boolean> {
  try {
    const px = new Uint8ClampedArray(2 * 2 * 4)
    for (let i = 0; i < 4; i++) {
      px[i * 4] = 255
      px[i * 4 + 3] = i % 2 === 0 ? 255 : 128
    }
    const out = await encoder({ width: 2, height: 2, data: px }, 80)
    return isRiffWebp(out)
  } catch {
    return false
  }
}

export interface StillChunks {
  payload: Uint8Array
  hasAlpha: boolean
  lossless: boolean
}

/** Extract the image chunks of a still WebP: [ALPH] + VP8, or VP8L. */
export function extractStillChunks(bytes: Uint8Array): StillChunks {
  if (!isRiffWebp(bytes)) throw new Error('Not a WebP file')
  const parts: Uint8Array[] = []
  let hasAlpha = false
  let lossless = false
  for (const c of riffChunks(bytes, 12)) {
    if (c.fourCC !== 'ALPH' && c.fourCC !== 'VP8 ' && c.fourCC !== 'VP8L') continue
    if (c.fourCC === 'ALPH') hasAlpha = true
    if (c.fourCC === 'VP8L') lossless = true
    // Copy the chunk whole — header, payload and odd-size padding.
    parts.push(bytes.subarray(c.start - 8, c.end + ((c.end - c.start) & 1)))
  }
  if (parts.length === 0) throw new Error('WebP carries no image chunk')
  let total = 0
  for (const p of parts) total += p.length
  const payload = new Uint8Array(total)
  let o = 0
  for (const p of parts) {
    payload.set(p, o)
    o += p.length
  }
  return { payload, hasAlpha, lossless }
}

export async function encodeWebpAnim(
  doc: AnimDoc,
  options: WebpEncodeOptions = {},
  encoder: StillEncoder = domStillEncoder,
): Promise<Uint8Array> {
  const optimize = options.optimize !== false
  const resolved = resolveForTarget(doc, WEBP_CAPS, options)
  const width = Math.max(1, resolved.width)
  const height = Math.max(1, resolved.height)
  const frames: RgbaImage[] = resolved.frames.map((f) => ({ width, height, data: f.pixels }))
  const delays = resolved.frames.map((f) => f.delayMs)

  const plans = planFrames(frames, delays, { caps: WEBP_CAPS, optimize })
  if (plans.length === 0) throw new Error('Cannot encode an empty animation')

  const quality = options.quality ?? 80
  const anmf: Uint8Array[] = []
  let anyAlpha = false

  for (let i = 0; i < plans.length; i++) {
    options.signal?.throwIfAborted()
    const plan = plans[i]
    const still = await encoder({ width: plan.rect.w, height: plan.rect.h, data: plan.pixels }, quality)
    const chunks = extractStillChunks(still)
    // The VP8X ALPHA flag must describe the CONTENT, not the chunk layout: a
    // VP8L frame carries alpha inline and may well be fully opaque. Deriving it
    // from the pixels keeps the flag honest (libwebp writes 0 in that case).
    if (!anyAlpha && (chunks.hasAlpha || hasTransparency(plan.pixels))) anyAlpha = true

    const header = new Uint8Array(16)
    // X and Y are in units of TWO pixels; planFrames() already snapped them.
    writeU24(header, 0, plan.rect.x >> 1)
    writeU24(header, 3, plan.rect.y >> 1)
    // Width and height are stored MINUS ONE; the duration is not.
    writeU24(header, 6, plan.rect.w - 1)
    writeU24(header, 9, plan.rect.h - 1)
    writeU24(header, 12, Math.max(0, Math.min(0xffffff, Math.round(plan.delayMs))))
    header[15] =
      (plan.blend === 'source' ? 0x02 : 0) | (plan.disposal === 'background' ? 0x01 : 0)

    const body = new Uint8Array(16 + chunks.payload.length)
    body.set(header, 0)
    body.set(chunks.payload, 16)
    anmf.push(chunk('ANMF', body))
    options.onProgress?.(i + 1, plans.length, 'encode')
  }

  const anim = new Uint8Array(6)
  writeU32(anim, 0, 0) // background colour (B, G, R, A) — left at zero
  const loop = Math.max(0, Math.min(0xffff, resolved.loop))
  anim[4] = loop & 0xff
  anim[5] = (loop >> 8) & 0xff

  options.onProgress?.(plans.length, plans.length, 'assemble')
  return riffWebp([
    chunk('VP8X', vp8x(VP8X_ANIMATION | (anyAlpha ? VP8X_ALPHA : 0), width, height)),
    chunk('ANIM', anim),
    ...anmf,
  ])
}

function hasTransparency(px: Uint8ClampedArray): boolean {
  for (let o = 3; o < px.length; o += 4) if (px[o] !== 255) return true
  return false
}
