// AnimDoc -> GIF89a.

import { planFrames, type FramePlan } from '../optimize.ts'
import { resolveForTarget } from '../resolve.ts'
import { buildPalette, ditherToIndices, type ColorMapper } from '../quantize/index.ts'
import { GIF_CAPS, type AnimDoc, type DitherKind, type GifEncodeOptions, type Palette, type RgbaImage } from '../types.ts'
import {
  ByteWriter,
  EXT_APPLICATION,
  EXT_GRAPHIC_CONTROL,
  GIF_EXTENSION,
  GIF_IMAGE_DESCRIPTOR,
  GIF_TRAILER,
  writeSubBlocks,
} from './format.ts'
import { lzwEncode, minCodeSizeFor } from './lzwEncode.ts'

const DEFAULTS = {
  colors: 256,
  quantizer: 'medianCut' as const,
  palette: 'global' as const,
  ditherStrength: 75,
  alphaThreshold: 128,
  matte: [255, 255, 255] as [number, number, number],
}

export function encodeGif(doc: AnimDoc, options: GifEncodeOptions = {}): Uint8Array {
  const optimize = options.optimize !== false
  const resolved = resolveForTarget(doc, GIF_CAPS, options)
  const width = Math.max(1, resolved.width)
  const height = Math.max(1, resolved.height)

  const threshold = clampInt(options.alphaThreshold ?? DEFAULTS.alphaThreshold, 0, 255)
  const matte = options.matte ?? DEFAULTS.matte
  const frames: RgbaImage[] = resolved.frames.map((f) => ({
    width,
    height,
    data: mattedBinaryAlpha(f.pixels, matte, threshold),
  }))
  const delays = resolved.frames.map((f) => f.delayMs)
  options.onProgress?.(0, frames.length, 'palette')

  // Transparency is needed as soon as the source has any, and unconditionally
  // when optimising, since unchanged pixels are encoded as the transparent
  // index. GIF then has a 255-colour budget, not 256.
  const needsTransparency = optimize || frames.some(hasTransparent)
  const local = options.palette === 'local'

  const built = buildPalette(local ? frames.slice(0, 1) : frames, {
    colors: clampInt(options.colors ?? DEFAULTS.colors, 2, 256),
    quantizer: options.quantizer ?? DEFAULTS.quantizer,
    needsTransparency,
  })

  const plans = planFrames(frames, delays, { caps: GIF_CAPS, optimize })

  // Bayer by default on animations (temporally stable, keeps the diff clean),
  // Floyd-Steinberg on a single still frame where no such constraint exists.
  // An exact palette never needs dithering at all.
  const dither: DitherKind = built.exact
    ? 'none'
    : (options.dither ?? (plans.length > 1 ? 'bayer' : 'floydSteinberg'))
  const strength = clampInt(options.ditherStrength ?? DEFAULTS.ditherStrength, 0, 100)

  const w = new ByteWriter(1 << 18)
  w.ascii('GIF89a')
  w.u16(width)
  w.u16(height)
  const globalSize = paddedSize(built.palette.size)
  w.u8(0x80 | 0x70 | (bitsFor(globalSize) - 1))
  w.u8(0) // background colour index
  w.u8(0) // pixel aspect ratio: none
  writeColorTable(w, built.palette, globalSize)

  const loop = resolved.loop
  if (loop !== 1) {
    w.u8(GIF_EXTENSION)
    w.u8(EXT_APPLICATION)
    w.u8(11)
    w.ascii('NETSCAPE2.0')
    w.u8(3)
    w.u8(1)
    w.u16(loop === 0 ? 0 : Math.max(0, Math.min(0xffff, loop)))
    w.u8(0)
  }

  for (let i = 0; i < plans.length; i++) {
    options.signal?.throwIfAborted()
    writeFrame(w, plans[i], built.palette, built.mapper, dither, strength, options)
    options.onProgress?.(i + 1, plans.length, 'encode')
  }

  w.u8(GIF_TRAILER)
  return w.finish()
}

function writeFrame(
  w: ByteWriter,
  plan: FramePlan,
  globalPalette: Palette,
  globalMapper: ColorMapper,
  dither: DitherKind,
  strength: number,
  options: GifEncodeOptions,
): void {
  const { rect } = plan
  const n = rect.w * rect.h
  const mask = new Uint8Array(n)
  for (let i = 0; i < n; i++) mask[i] = plan.pixels[i * 4 + 3] === 0 ? 1 : 0

  const mode = options.palette ?? DEFAULTS.palette
  let palette = globalPalette
  let mapper = globalMapper
  let localTable: Palette | null = null

  if (mode === 'local') {
    // Forced local palette: quantise this rectangle on its own. The shared
    // nearest-colour cache is lost, so this is markedly slower.
    const built = buildPalette([{ width: rect.w, height: rect.h, data: plan.pixels }], {
      colors: clampInt(options.colors ?? DEFAULTS.colors, 2, 256),
      quantizer: options.quantizer ?? DEFAULTS.quantizer,
      needsTransparency: true,
    })
    palette = built.palette
    mapper = built.mapper
    localTable = built.palette
  }

  let indices = ditherToIndices({
    src: plan.pixels,
    w: rect.w,
    h: rect.h,
    // Absolute coordinates: a Bayer pattern indexed on rectangle-relative
    // coordinates would shift with the diff rectangle and start crawling again.
    originX: rect.x,
    originY: rect.y,
    palette,
    mapper,
    kind: dither,
    strength,
    transparentMask: mask,
  })

  // Opportunistic local colour table: a rectangle reduced by the diff often
  // uses only a handful of colours. A 4- or 8-entry LCT costs 12 or 24 bytes
  // and drops minCodeSize to 2 or 3, shortening EVERY code of the frame.
  if (mode === 'auto') {
    const compact = tryLocalTable(indices, palette)
    if (compact) {
      const next = new Uint8Array(indices.length)
      for (let i = 0; i < indices.length; i++) next[i] = compact.remap[indices[i]]
      indices = next
      palette = compact
      localTable = compact
    }
  }

  const tableSize = paddedSize((localTable ?? globalPalette).size)
  const minCodeSize = minCodeSizeFor(tableSize)

  // Graphic Control Extension — describes what to do AFTER this frame.
  w.u8(GIF_EXTENSION)
  w.u8(EXT_GRAPHIC_CONTROL)
  w.u8(4)
  const disposalBits = plan.disposal === 'background' ? 2 : plan.disposal === 'previous' ? 3 : 1
  const transparent = palette.transparentIndex >= 0
  w.u8((disposalBits << 2) | (transparent ? 1 : 0))
  w.u16(Math.max(0, Math.min(0xffff, Math.round(plan.delayMs / 10))))
  w.u8(transparent ? palette.transparentIndex : 0)
  w.u8(0)

  w.u8(GIF_IMAGE_DESCRIPTOR)
  w.u16(rect.x)
  w.u16(rect.y)
  w.u16(rect.w)
  w.u16(rect.h)
  if (localTable) {
    // Interlacing is never written: it is a relic of slow links, it buys
    // nothing today and it hurts LZW (neighbouring rows no longer follow).
    w.u8(0x80 | (bitsFor(tableSize) - 1))
    writeColorTable(w, localTable, tableSize)
  } else {
    w.u8(0)
  }
  w.u8(minCodeSize)
  writeSubBlocks(w, lzwEncode(indices, minCodeSize))
}

/**
 * Build a compact colour table when the frame uses few distinct indices.
 * Returns null when it would not shrink the code size.
 */
function tryLocalTable(indices: Uint8Array, palette: Palette): (Palette & { remap: Uint8Array }) | null {
  const seen = new Uint8Array(256)
  let count = 0
  for (let i = 0; i < indices.length; i++) {
    if (!seen[indices[i]]) {
      seen[indices[i]] = 1
      count++
      if (count > 128) return null
    }
  }
  const globalBits = minCodeSizeFor(paddedSize(palette.size))
  const localBits = minCodeSizeFor(paddedSize(count))
  if (localBits >= globalBits) return null

  const remap = new Uint8Array(256)
  const rgb = new Uint8Array(count * 3)
  let transparentIndex = -1
  let next = 0
  for (let i = 0; i < 256; i++) {
    if (!seen[i]) continue
    remap[i] = next
    if (i === palette.transparentIndex) transparentIndex = next
    rgb[next * 3] = palette.rgb[i * 3] ?? 0
    rgb[next * 3 + 1] = palette.rgb[i * 3 + 1] ?? 0
    rgb[next * 3 + 2] = palette.rgb[i * 3 + 2] ?? 0
    next++
  }
  return { rgb, size: count, transparentIndex, remap }
}

function writeColorTable(w: ByteWriter, palette: Palette, padded: number): void {
  const table = new Uint8Array(padded * 3)
  table.set(palette.rgb.subarray(0, Math.min(palette.rgb.length, padded * 3)))
  w.bytes(table)
}

/**
 * Matte semi-transparent pixels against `matte` and threshold alpha to binary.
 * Alpha is never dithered: doing so peppers every antialiased edge with
 * isolated pixels. Fully transparent pixels are zeroed so that comparisons
 * between frames stay exact.
 */
export function mattedBinaryAlpha(
  src: Uint8ClampedArray,
  matte: [number, number, number],
  threshold: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src.length)
  for (let o = 0; o < src.length; o += 4) {
    const a = src[o + 3]
    if (a === 0) continue
    if (a === 255) {
      out[o] = src[o]
      out[o + 1] = src[o + 1]
      out[o + 2] = src[o + 2]
      out[o + 3] = 255
      continue
    }
    if (a < threshold) continue
    const k = a / 255
    out[o] = src[o] * k + matte[0] * (1 - k)
    out[o + 1] = src[o + 1] * k + matte[1] * (1 - k)
    out[o + 2] = src[o + 2] * k + matte[2] * (1 - k)
    out[o + 3] = 255
  }
  return out
}

function hasTransparent(img: RgbaImage): boolean {
  for (let o = 3; o < img.data.length; o += 4) if (img.data[o] === 0) return true
  return false
}

function paddedSize(size: number): number {
  let n = 2
  while (n < size) n *= 2
  return Math.min(256, n)
}

function bitsFor(paddedSize: number): number {
  let bits = 1
  while (1 << bits < paddedSize) bits++
  return bits
}

function clampInt(v: number, lo: number, hi: number): number {
  const n = Math.round(Number.isFinite(v) ? v : lo)
  return n < lo ? lo : n > hi ? hi : n
}
