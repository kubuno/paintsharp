// The single animation compositor, shared by GIF, APNG and animated WebP.
//
// Why one compositor and not three: the behaviour browsers actually apply to a
// GIF *is* the behaviour APNG specifies, and WebP's ANMF flags are a subset of
// it. Writing three of these is how decoders end up subtly disagreeing.
//
// The eight classic mistakes, each handled explicitly below:
//
//  1. Disposal is applied AFTER the frame is displayed, never before. Clearing
//     "before drawing" produces a flicker and a one-frame lag.
//  2. Disposal only ever touches the frame's OWN rectangle, not the canvas.
//  3. 'background' clears to TRANSPARENT, not to the background colour. GIF89a
//     says background colour; no browser does that, and following the spec here
//     makes transparent GIFs render on a colour slab in our app only.
//  4. GIF disposal 0 ("unspecified") behaves exactly like 1 ("do not dispose").
//     Reading it as "restore to background" is a very common bug.
//  5. Every emitted frame must be a COPY of the canvas. Emitting the canvas
//     itself makes all frames alias one buffer — the single most frequent bug
//     in home-grown decoders, and it looks correct until you keep two frames.
//  6. The 'previous' snapshot is taken before EACH frame, never cached across
//     frames: two consecutive 'previous' frames must each restore their own
//     state, not the state from before the first of them.
//  7. A transparent index outside the palette is still transparent (browser
//     behaviour), not an error.
//  8. A frame rectangle may overrun the logical screen in malformed files: clip
//     it, never grow the canvas. And emitted frames are always logical-screen
//     sized — the offset is absorbed by compositing, never leaked to callers.
//
// Plus the rule the APNG spec states and GIF leaves implicit: 'previous' on the
// very first frame behaves as 'background'. Identical outcome here anyway,
// since the initial canvas is fully transparent.

import type { AnimDoc, AnimFrame, Rect, RgbaImage } from './types.ts'

export function createCanvas(width: number, height: number): RgbaImage {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) }
}

export function cloneImage(src: RgbaImage): RgbaImage {
  return { width: src.width, height: src.height, data: new Uint8ClampedArray(src.data) }
}

/** Intersection of `r` with the [0,w)×[0,h) screen. May come back empty. */
export function clipRect(r: Rect, w: number, h: number): Rect {
  const x0 = Math.max(0, Math.min(w, Math.trunc(r.x)))
  const y0 = Math.max(0, Math.min(h, Math.trunc(r.y)))
  const x1 = Math.max(x0, Math.min(w, Math.trunc(r.x) + Math.trunc(r.w)))
  const y1 = Math.max(y0, Math.min(h, Math.trunc(r.y) + Math.trunc(r.h)))
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

export function copyRect(src: RgbaImage, r: Rect): Uint8ClampedArray {
  const out = new Uint8ClampedArray(r.w * r.h * 4)
  for (let y = 0; y < r.h; y++) {
    const s = ((r.y + y) * src.width + r.x) * 4
    out.set(src.data.subarray(s, s + r.w * 4), y * r.w * 4)
  }
  return out
}

export function putRect(dst: RgbaImage, px: Uint8ClampedArray, r: Rect): void {
  for (let y = 0; y < r.h; y++) {
    const d = ((r.y + y) * dst.width + r.x) * 4
    dst.data.set(px.subarray(y * r.w * 4, (y + 1) * r.w * 4), d)
  }
}

export function clearRectToTransparent(dst: RgbaImage, r: Rect): void {
  for (let y = 0; y < r.h; y++) {
    const d = ((r.y + y) * dst.width + r.x) * 4
    dst.data.fill(0, d, d + r.w * 4)
  }
}

/**
 * Draw one frame onto the canvas. `rect` must already be clipped to the canvas;
 * `pixels` is indexed with the frame's ORIGINAL rectangle so a clipped frame
 * still reads the right source pixels.
 */
export function drawFrame(canvas: RgbaImage, frame: AnimFrame, clipped: Rect): void {
  const { rect, pixels, blend } = frame
  const dx = clipped.x - rect.x
  const dy = clipped.y - rect.y
  const dst = canvas.data
  for (let y = 0; y < clipped.h; y++) {
    let s = ((dy + y) * rect.w + dx) * 4
    let d = ((clipped.y + y) * canvas.width + clipped.x) * 4
    for (let x = 0; x < clipped.w; x++, s += 4, d += 4) {
      const sa = pixels[s + 3]
      if (blend === 'source') {
        // Full RGBA replacement, alpha included. This is the only way a format
        // can express "make this area transparent again".
        dst[d] = pixels[s]
        dst[d + 1] = pixels[s + 1]
        dst[d + 2] = pixels[s + 2]
        dst[d + 3] = sa
        continue
      }
      // 'over': a fully transparent source pixel writes NOTHING. That is what
      // makes the inter-frame diff optimisation possible in the first place.
      if (sa === 0) continue
      if (sa === 255) {
        dst[d] = pixels[s]
        dst[d + 1] = pixels[s + 1]
        dst[d + 2] = pixels[s + 2]
        dst[d + 3] = 255
        continue
      }
      // Standard non-premultiplied source-over.
      const da = dst[d + 3]
      const a = sa / 255
      const outA = a + (da / 255) * (1 - a)
      if (outA <= 0) {
        dst[d] = 0
        dst[d + 1] = 0
        dst[d + 2] = 0
        dst[d + 3] = 0
        continue
      }
      const k = (da / 255) * (1 - a)
      dst[d] = (pixels[s] * a + dst[d] * k) / outA
      dst[d + 1] = (pixels[s + 1] * a + dst[d + 1] * k) / outA
      dst[d + 2] = (pixels[s + 2] * a + dst[d + 2] * k) / outA
      dst[d + 3] = outA * 255
    }
  }
}

/**
 * Streaming compositor. Yields one full-canvas RGBA image per frame; only three
 * full-size buffers are ever live (canvas, snapshot, emitted copy), so a
 * 200-frame 1080p animation costs ~25 MB here instead of 1.66 GB.
 *
 * The caller decides what to keep — that decision does not belong to a codec.
 */
export function* compositeIter(doc: AnimDoc): Generator<RgbaImage, void, undefined> {
  const w = Math.max(1, doc.width | 0)
  const h = Math.max(1, doc.height | 0)
  const canvas = createCanvas(w, h)
  let snapshot: Uint8ClampedArray | null = null
  let snapshotRect: Rect | null = null

  for (let i = 0; i < doc.frames.length; i++) {
    const f = doc.frames[i]
    const clipped = clipRect(f.rect, w, h)

    // Mistake 6: snapshot taken before EVERY 'previous' frame, never cached.
    // Mistake and rule: 'previous' on frame 0 == 'background' (same result, the
    // initial canvas being transparent), so no special case is needed.
    if (f.disposal === 'previous' && clipped.w > 0 && clipped.h > 0) {
      snapshot = copyRect(canvas, clipped)
      snapshotRect = clipped
    } else {
      snapshot = null
      snapshotRect = null
    }

    if (clipped.w > 0 && clipped.h > 0) drawFrame(canvas, f, clipped)

    // Mistake 5: hand out a COPY. Never the working canvas.
    yield cloneImage(canvas)

    // Mistake 1: dispose AFTER display. Mistake 2: only the frame's rectangle.
    if (clipped.w > 0 && clipped.h > 0) {
      if (f.disposal === 'background') {
        // Mistake 3: transparent, not the background colour.
        clearRectToTransparent(canvas, clipped)
      } else if (f.disposal === 'previous' && snapshot && snapshotRect) {
        putRect(canvas, snapshot, snapshotRect)
      }
      // 'none' (and GIF's "unspecified", mistake 4) leaves the canvas as is.
    }
  }
}

/** Convenience wrapper. Materialises every frame — mind the memory (§6.5). */
export function composite(doc: AnimDoc): RgbaImage[] {
  return [...compositeIter(doc)]
}

/**
 * Rebuild an AnimDoc whose frames are full-canvas and independent of each other
 * ('none' disposal, 'source' blend). Used when a target format cannot express
 * the document's disposal (WebP has no 'previous') and as the canonical input
 * of every encoder.
 */
export function flatten(doc: AnimDoc): AnimDoc {
  const frames: AnimFrame[] = []
  let i = 0
  for (const img of compositeIter(doc)) {
    frames.push({
      rect: { x: 0, y: 0, w: doc.width, h: doc.height },
      pixels: img.data,
      delayMs: doc.frames[i].delayMs,
      disposal: 'none',
      blend: 'source',
    })
    i++
  }
  return { width: doc.width, height: doc.height, loop: doc.loop, frames, source: doc.source }
}
