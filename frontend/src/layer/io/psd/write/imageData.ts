/*
 * PSD/PSB Image Data writer — the flattened composite (spec §8.6).
 *
 * Derived from the GIMP PSD plug-in (file-psd), Copyright 2007 John Marshall,
 * GPLv3+ — `save_data()` in psd-export.c — and from Adobe's public "Photoshop
 * File Formats Specification". Independent TypeScript re-implementation; no
 * GIMP source was copied. Kubuno is AGPLv3.
 */
import type { ByteWriter } from '../binary/ByteWriter.ts'
import { COMPRESSION } from '../constants.ts'
import { encodePackBits, packBitsWorstCase } from '../compression/packbits.ts'
import { allocBytes } from '../errors.ts'
import type { PsdDocument, PsdImage, PsdLayer, WarningSink } from '../types.ts'
import { rectHeight, rectWidth } from '../types.ts'
import { layerPlanes } from './channelData.ts'

/**
 * Writes the composite as RLE.
 *
 * ⚠️ This is THE section that decides whether other software shows anything at
 * all: a PSD without valid Image Data opens black, or not at all, in viewers,
 * file browsers and every tool that ignores layers.
 *
 * Unlike layer channels, the alpha comes LAST here (R, G, B, A) and a SINGLE
 * row-length table covers every channel.
 */
export function writeImageData(
  w: ByteWriter,
  pixels: Uint8Array,
  width: number,
  height: number,
  channelCount: 3 | 4,
): void {
  w.u16(COMPRESSION.RLE)
  const rowCount = height * channelCount
  const tableAt = w.length
  w.zeros(rowCount * 2)

  const scratch = allocBytes(packBitsWorstCase(width))
  const row = allocBytes(width)
  let entry = 0
  for (let c = 0; c < channelCount; c++) {
    for (let y = 0; y < height; y++) {
      const base = y * width * 4 + c
      for (let x = 0; x < width; x++) row[x] = pixels[base + x * 4]
      const n = encodePackBits(row, scratch, 0)
      w.patchU16(tableAt + entry * 2, n)
      w.bytes(scratch.subarray(0, n))
      entry++
    }
  }
}

/** True when every pixel of the composite is fully opaque. */
export function isFullyOpaque(pixels: Uint8Array, width: number, height: number): boolean {
  const n = width * height
  for (let i = 0; i < n; i++) if (pixels[i * 4 + 3] !== 255) return false
  return true
}

/**
 * CPU fallback composite.
 *
 * Used only when the caller supplies none — the editor normally hands over the
 * WebGL composite, which already honours the 24 blend modes, fill opacity,
 * masks and clipping. This fallback is deliberately simple: bottom-up
 * source-over with layer opacity, ignoring blend modes and clipping. It exists
 * so that "never write an empty Image Data" (spec §8.9) always holds.
 */
export async function cpuComposite(doc: PsdDocument, sink: WarningSink): Promise<PsdImage> {
  const { width, height } = doc
  const out = allocBytes(width * height * 4)
  const stack: PsdLayer[] = []
  collectRaster(doc.layers, stack, true)

  // `collectRaster` walks top-down; compositing needs bottom-up.
  for (let i = stack.length - 1; i >= 0; i--) {
    const layer = stack[i]
    const lw = rectWidth(layer.rect)
    const lh = rectHeight(layer.rect)
    if (lw <= 0 || lh <= 0) continue
    let planes
    try {
      planes = await layerPlanes(layer, doc.depth, doc.colorMode, sink)
    } catch {
      continue
    }
    if (!planes) continue
    const alpha = layer.opacity / 255
    for (let y = 0; y < lh; y++) {
      const dy = layer.rect.top + y
      if (dy < 0 || dy >= height) continue
      for (let x = 0; x < lw; x++) {
        const dx = layer.rect.left + x
        if (dx < 0 || dx >= width) continue
        const s = y * lw + x
        const sa = (planes.a[s] / 255) * alpha
        if (sa <= 0) continue
        const d = (dy * width + dx) * 4
        const da = out[d + 3] / 255
        const oa = sa + da * (1 - sa)
        if (oa <= 0) continue
        out[d] = Math.round((planes.r[s] * sa + out[d] * da * (1 - sa)) / oa)
        out[d + 1] = Math.round((planes.g[s] * sa + out[d + 1] * da * (1 - sa)) / oa)
        out[d + 2] = Math.round((planes.b[s] * sa + out[d + 2] * da * (1 - sa)) / oa)
        out[d + 3] = Math.round(oa * 255)
      }
    }
  }
  sink.warn('unknown-blocks-preserved', { composite: 'cpu-fallback' }, 'info')
  return { width, height, data: out }
}

function collectRaster(layers: readonly PsdLayer[], into: PsdLayer[], visible: boolean): void {
  for (const l of layers) {
    const vis = visible && l.visible
    if (l.kind === 'group') collectRaster(l.children, into, vis)
    else if (vis) into.push(l)
  }
}
