// Inter-frame optimisation, shared by GIF, APNG and WebP.
//
// This is the highest-yield lever of the whole pipeline: factor 3 to 10 on
// screen-capture-like or fixed-background 2D content, 1.3 to 2 on full-frame
// video. It has three stages and one arbitration:
//
//  1. COALESCE identical frames: a frame that is pixel-for-pixel the composited
//     canvas of its predecessor is dropped and its delay carried over. Free,
//     and frequent (held poses, fixed-cadence exports).
//  2. MINIMAL DIFFERENCE RECTANGLE: bounding box of the pixels that differ from
//     the previous composited canvas, found by four directional sweeps with
//     early exit rather than a full min/max scan.
//  3. TRANSPARENCY ON UNCHANGED PIXELS inside that rectangle, with the frame
//     drawn 'over'. Long runs of one index make LZW (or deflate) build long
//     strings very quickly — the win far exceeds the mere area reduction.
//
//  4. ARBITRATION when transparency is not enough. "Keep what was there" and
//     "be transparent" are the same encoding, so a format with only binary
//     transparency (GIF) cannot say "this opaque pixel must BECOME
//     transparent". Two ways out:
//       - formats with a real alpha channel switch the frame to blend
//         'source', which overwrites alpha: APNG and WebP never need more;
//       - GIF marks the PREVIOUS frame 'restore to background' over a
//         rectangle covering the erasure, then redraws.
//     The GIF path is implemented with a one-frame look-back: the previous
//     plan's rectangle and pixels are recomputed before anything is compressed.

import { cloneImage, createCanvas } from './compositor.ts'
import type { Blend, Disposal, FormatCaps, Rect, RgbaImage } from './types.ts'

export interface FramePlan {
  rect: Rect
  /** RGBA for `rect`. With `blend: 'over'`, alpha 0 means "keep what is below". */
  pixels: Uint8ClampedArray
  delayMs: number
  disposal: Disposal
  blend: Blend
}

export interface OptimizeOptions {
  caps: FormatCaps
  /** When false, every frame is emitted full-canvas with no diffing. */
  optimize: boolean
}

export function planFrames(
  frames: readonly RgbaImage[],
  delays: readonly number[],
  opts: OptimizeOptions,
): FramePlan[] {
  const plans: FramePlan[] = []
  if (frames.length === 0) return plans
  const w = frames[0].width
  const h = frames[0].height

  if (!opts.optimize) {
    for (let i = 0; i < frames.length; i++) {
      plans.push({
        rect: { x: 0, y: 0, w, h },
        pixels: new Uint8ClampedArray(frames[i].data),
        delayMs: delays[i] ?? 0,
        // Making every frame independent takes more than a full rectangle: a
        // format without 'source' blend (GIF) draws transparent pixels as
        // "keep what is below", so the canvas must be wiped after each frame.
        disposal: opts.caps.sourceBlend ? 'none' : 'background',
        blend: opts.caps.sourceBlend ? 'source' : 'over',
      })
    }
    return plans
  }

  // Decoder state before the frame currently being planned.
  let state = createCanvas(w, h)
  // ...and the state before the last plan we pushed, needed by the GIF erasure
  // look-back, which rebuilds that plan.
  let stateBeforeLast: RgbaImage | null = null
  let lastSource = -1

  for (let i = 0; i < frames.length; i++) {
    const cur = frames[i]
    const delay = delays[i] ?? 0

    // Set when the previous plan was turned into a 'restore to background':
    // the canvas then changes at the END of that frame, so the current frame
    // must be emitted even if it draws nothing, otherwise coalescing it would
    // move the erasure earlier in time.
    let justErased = false

    if (!opts.caps.sourceBlend) {
      const erase = erasureBox(state, cur, w, h)
      const last = plans[plans.length - 1]
      if (erase && last && stateBeforeLast && lastSource >= 0) {
        const merged = alignRect(unionRect(last.rect, erase), w, h, opts.caps.offsetGranularity)
        last.rect = merged
        last.pixels = buildRect(merged, frames[lastSource], stateBeforeLast, true)
        last.disposal = 'background'
        state = cloneImage(frames[lastSource])
        clearRect(state, merged)
        justErased = true
      }
    }

    const diff = diffRect(state, cur, w, h)
    if (!diff) {
      // Stage 1: identical frame. Carry the delay over and drop it.
      if (plans.length > 0 && !justErased) {
        plans[plans.length - 1].delayMs += delay
        continue
      }
      // Either the very first frame equals an empty canvas, or the previous
      // frame just gained a 'background' disposal: emit a minimal legal frame
      // that draws nothing, so the timing stays exact.
      plans.push({
        rect: { x: 0, y: 0, w: 1, h: 1 },
        pixels: new Uint8ClampedArray(4),
        delayMs: delay,
        disposal: 'none',
        blend: 'over',
      })
      stateBeforeLast = cloneImage(state)
      lastSource = i
      state = cloneImage(cur)
      continue
    }

    const rect = alignRect(diff, w, h, opts.caps.offsetGranularity)
    const over = opts.caps.sourceBlend ? canUseOver(rect, cur, state) : true
    const blend: Blend = over ? 'over' : 'source'
    plans.push({
      rect,
      pixels: buildRect(rect, cur, state, over),
      delayMs: delay,
      disposal: 'none',
      blend,
    })
    stateBeforeLast = state
    lastSource = i
    state = cloneImage(cur)
  }

  return plans
}

/**
 * Build the pixels a frame carries for `rect`.
 * With `diffTransparency`, a pixel identical to the current state is written as
 * fully transparent so the decoder simply leaves it alone.
 */
function buildRect(rect: Rect, target: RgbaImage, state: RgbaImage, diffTransparency: boolean): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rect.w * rect.h * 4)
  const t = target.data
  const s = state.data
  for (let y = 0; y < rect.h; y++) {
    let src = ((rect.y + y) * target.width + rect.x) * 4
    let dst = y * rect.w * 4
    for (let x = 0; x < rect.w; x++, src += 4, dst += 4) {
      if (
        diffTransparency &&
        t[src] === s[src] &&
        t[src + 1] === s[src + 1] &&
        t[src + 2] === s[src + 2] &&
        t[src + 3] === s[src + 3]
      ) {
        continue // stays 0,0,0,0 — "keep what is below"
      }
      out[dst] = t[src]
      out[dst + 1] = t[src + 1]
      out[dst + 2] = t[src + 2]
      out[dst + 3] = t[src + 3]
    }
  }
  return out
}

/**
 * 'over' can reproduce the target only if every pixel of the rectangle is
 * either unchanged (written as alpha 0) or fully opaque. A partially
 * transparent pixel over existing content would blend instead of replacing.
 */
function canUseOver(rect: Rect, target: RgbaImage, state: RgbaImage): boolean {
  const t = target.data
  const s = state.data
  for (let y = 0; y < rect.h; y++) {
    let o = ((rect.y + y) * target.width + rect.x) * 4
    for (let x = 0; x < rect.w; x++, o += 4) {
      if (t[o + 3] === 255) continue
      if (t[o] === s[o] && t[o + 1] === s[o + 1] && t[o + 2] === s[o + 2] && t[o + 3] === s[o + 3]) continue
      return false
    }
  }
  return true
}

/** Bounding box of differing pixels, or null when the frames are identical. */
export function diffRect(a: RgbaImage, b: RgbaImage, w: number, h: number): Rect | null {
  const pa = a.data
  const pb = b.data
  let top = -1
  for (let y = 0; y < h && top < 0; y++) if (rowDiffers(pa, pb, y, w)) top = y
  if (top < 0) return null
  let bottom = top
  for (let y = h - 1; y >= top; y--) {
    if (rowDiffers(pa, pb, y, w)) {
      bottom = y
      break
    }
  }
  let left = 0
  for (let x = 0; x < w; x++) {
    if (colDiffers(pa, pb, x, w, top, bottom)) {
      left = x
      break
    }
  }
  let right = left
  for (let x = w - 1; x >= left; x--) {
    if (colDiffers(pa, pb, x, w, top, bottom)) {
      right = x
      break
    }
  }
  return { x: left, y: top, w: right - left + 1, h: bottom - top + 1 }
}

/** Bounding box of pixels that must LOSE opacity — the case 'over' cannot express. */
function erasureBox(state: RgbaImage, target: RgbaImage, w: number, h: number): Rect | null {
  const s = state.data
  const t = target.data
  let minX = w
  let minY = h
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < h; y++) {
    let o = y * w * 4
    for (let x = 0; x < w; x++, o += 4) {
      if (t[o + 3] < s[o + 3]) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return null
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
}

function rowDiffers(a: Uint8ClampedArray, b: Uint8ClampedArray, y: number, w: number): boolean {
  const start = y * w * 4
  const end = start + w * 4
  for (let i = start; i < end; i++) if (a[i] !== b[i]) return true
  return false
}

function colDiffers(
  a: Uint8ClampedArray,
  b: Uint8ClampedArray,
  x: number,
  w: number,
  top: number,
  bottom: number,
): boolean {
  for (let y = top; y <= bottom; y++) {
    const o = (y * w + x) * 4
    if (a[o] !== b[o] || a[o + 1] !== b[o + 1] || a[o + 2] !== b[o + 2] || a[o + 3] !== b[o + 3]) return true
  }
  return false
}

export function unionRect(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  const x2 = Math.max(a.x + a.w, b.x + b.w)
  const y2 = Math.max(a.y + a.h, b.y + b.h)
  return { x, y, w: x2 - x, h: y2 - y }
}

/**
 * Snap a rectangle to the container's offset granularity.
 * WebP stores ANMF x/y in units of TWO pixels, so odd offsets are simply not
 * representable: round the origin down and grow the size to compensate.
 */
export function alignRect(r: Rect, w: number, h: number, granularity: number): Rect {
  let { x, y } = r
  let x2 = r.x + r.w
  let y2 = r.y + r.h
  if (granularity > 1) {
    x -= x % granularity
    y -= y % granularity
  }
  x = Math.max(0, x)
  y = Math.max(0, y)
  x2 = Math.min(w, Math.max(x + 1, x2))
  y2 = Math.min(h, Math.max(y + 1, y2))
  return { x, y, w: x2 - x, h: y2 - y }
}

function clearRect(img: RgbaImage, r: Rect): void {
  for (let y = 0; y < r.h; y++) {
    const o = ((r.y + y) * img.width + r.x) * 4
    img.data.fill(0, o, o + r.w * 4)
  }
}
