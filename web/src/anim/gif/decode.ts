// GIF container parser -> AnimDoc.
//
// Metadata always comes from here, never from ImageDecoder: disposal, blend,
// per-frame rectangle, palette and transparent index are exactly what
// ImageDecoder does not expose, and they are exactly what is needed to
// re-export faithfully and to show the frame properties in a timeline.
//
// Robustness rules, applied everywhere below:
//   * a truncated or malformed file yields the frames decoded so far plus
//     `truncated: true`; it never throws, never loops and never over-allocates;
//   * unknown extensions are skipped through the generic sub-block loop, never
//     by a hard-coded length;
//   * a Graphic Control Extension applies to the block that FOLLOWS it; a
//     dangling one at end of file is ignored silently (it exists in the wild).

import type { AnimDoc, AnimFrame, Disposal } from '../types.ts'
import {
  EXT_APPLICATION,
  EXT_COMMENT,
  EXT_GRAPHIC_CONTROL,
  EXT_PLAIN_TEXT,
  GIF_EXTENSION,
  GIF_IMAGE_DESCRIPTOR,
  GIF_TRAILER,
  deinterlaceRow,
  readSubBlocks,
  skipSubBlocks,
} from './format.ts'
import { LzwTables, lzwDecode } from './lzwDecode.ts'

export interface GifFrameMeta {
  rect: { x: number; y: number; w: number; h: number }
  delayMs: number
  disposal: Disposal
  transparentIndex: number
  interlaced: boolean
  localPalette: Uint8Array | null
}

export interface GifDecodeResult extends AnimDoc {
  source: 'gif'
  /** Per-frame container metadata, kept for faithful re-export. */
  meta: GifFrameMeta[]
  globalPalette: Uint8Array | null
  backgroundIndex: number
}

export function isGif(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  )
}

function disposalFromGif(v: number): Disposal {
  // 0 "unspecified" behaves EXACTLY like 1 "do not dispose". Reading it as
  // "restore to background" is a classic and very visible bug.
  if (v === 2) return 'background'
  if (v === 3) return 'previous'
  return 'none'
}

export function decodeGif(bytes: Uint8Array): GifDecodeResult {
  if (!isGif(bytes)) throw new Error('Not a GIF file')

  const width = bytes[6] | (bytes[7] << 8)
  const height = bytes[8] | (bytes[9] << 8)
  const packed = bytes[10]
  const backgroundIndex = bytes[11]
  let p = 13

  let globalPalette: Uint8Array | null = null
  if (packed & 0x80) {
    const n = 1 << ((packed & 0x07) + 1)
    globalPalette = bytes.slice(p, p + n * 3)
    p += n * 3
  }

  const frames: AnimFrame[] = []
  const meta: GifFrameMeta[] = []
  let loop = 1
  let truncated = false
  const tables = new LzwTables()

  // Pending Graphic Control Extension, consumed by the next image descriptor.
  let gceDisposal: Disposal = 'none'
  let gceDelayCs = 0
  let gceTransparent = -1
  const resetGce = (): void => {
    gceDisposal = 'none'
    gceDelayCs = 0
    gceTransparent = -1
  }

  parse: while (p < bytes.length) {
    const block = bytes[p++]
    switch (block) {
      case GIF_TRAILER:
        break parse

      case GIF_EXTENSION: {
        if (p >= bytes.length) {
          truncated = true
          break parse
        }
        const label = bytes[p++]
        if (label === EXT_GRAPHIC_CONTROL) {
          const size = bytes[p] ?? 0
          if (size < 4 || p + 1 + size > bytes.length) {
            truncated = true
            break parse
          }
          const flags = bytes[p + 1]
          gceDisposal = disposalFromGif((flags >> 2) & 0x07)
          gceDelayCs = bytes[p + 2] | (bytes[p + 3] << 8)
          gceTransparent = flags & 0x01 ? bytes[p + 4] : -1
          p = skipSubBlocks(bytes, p)
        } else if (label === EXT_APPLICATION) {
          const size = bytes[p] ?? 0
          const id = String.fromCharCode(...bytes.subarray(p + 1, p + 1 + Math.min(size, 11)))
          const after = p + 1 + size
          if (id === 'NETSCAPE2.0' || id === 'ANIMEXTS1.0') {
            // Sub-block: 0x03 0x01 <loop u16>. 0 means loop forever.
            let q = after
            while (q < bytes.length) {
              const n = bytes[q]
              if (n === 0) {
                q++
                break
              }
              if (n >= 3 && bytes[q + 1] === 0x01) loop = bytes[q + 2] | (bytes[q + 3] << 8)
              q += 1 + n
            }
            p = q
          } else {
            p = skipSubBlocks(bytes, after)
          }
        } else if (label === EXT_PLAIN_TEXT) {
          // 12 fixed bytes of layout, then the text as sub-blocks. Skipped, but
          // skipped CORRECTLY: a GCE may precede it and must not leak onto the
          // next image.
          p = skipSubBlocks(bytes, Math.min(bytes.length, p + 1 + (bytes[p] ?? 0)))
          resetGce()
        } else if (label === EXT_COMMENT) {
          p = skipSubBlocks(bytes, p)
        } else {
          // Unknown extension: generic sub-block skip, never a hard-coded size.
          p = skipSubBlocks(bytes, p)
        }
        break
      }

      case GIF_IMAGE_DESCRIPTOR: {
        if (p + 9 > bytes.length) {
          truncated = true
          break parse
        }
        const fx = bytes[p] | (bytes[p + 1] << 8)
        const fy = bytes[p + 2] | (bytes[p + 3] << 8)
        const fw = bytes[p + 4] | (bytes[p + 5] << 8)
        const fh = bytes[p + 6] | (bytes[p + 7] << 8)
        const fpacked = bytes[p + 8]
        p += 9

        let localPalette: Uint8Array | null = null
        if (fpacked & 0x80) {
          const n = 1 << ((fpacked & 0x07) + 1)
          if (p + n * 3 > bytes.length) {
            truncated = true
            break parse
          }
          localPalette = bytes.slice(p, p + n * 3)
          p += n * 3
        }
        const interlaced = (fpacked & 0x40) !== 0

        if (p >= bytes.length) {
          truncated = true
          break parse
        }
        const minCodeSize = bytes[p++]
        const sub = readSubBlocks(bytes, p)
        p = sub.next
        if (sub.truncated) truncated = true

        const palette = localPalette ?? globalPalette
        const pixelCount = Math.max(0, fw) * Math.max(0, fh)
        if (pixelCount > 0) {
          const fillIndex = gceTransparent >= 0 ? gceTransparent : backgroundIndex
          const dec = lzwDecode(sub.data, minCodeSize, pixelCount, fillIndex, tables)
          if (dec.truncated) truncated = true
          const rgba = indicesToRgba(dec.indices, fw, fh, palette, gceTransparent, interlaced)
          frames.push({
            rect: { x: fx, y: fy, w: fw, h: fh },
            pixels: rgba,
            delayMs: gceDelayCs * 10,
            disposal: gceDisposal,
            // GIF is always source-over with binary alpha; it has no blend axis.
            blend: 'over',
          })
          meta.push({
            rect: { x: fx, y: fy, w: fw, h: fh },
            delayMs: gceDelayCs * 10,
            disposal: gceDisposal,
            transparentIndex: gceTransparent,
            interlaced,
            localPalette,
          })
        }
        resetGce()
        break
      }

      default:
        // Garbage byte between blocks: resynchronise by skipping it rather than
        // giving up on a file whose remaining frames are perfectly readable.
        truncated = true
        break
    }
  }

  return {
    width: width || (frames[0]?.rect.w ?? 1),
    height: height || (frames[0]?.rect.h ?? 1),
    loop,
    frames,
    source: 'gif',
    truncated: truncated || undefined,
    meta,
    globalPalette,
    backgroundIndex,
  }
}

function indicesToRgba(
  indices: Uint8Array,
  w: number,
  h: number,
  palette: Uint8Array | null,
  transparentIndex: number,
  interlaced: boolean,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4)
  const palSize = palette ? (palette.length / 3) | 0 : 0
  for (let j = 0; j < h; j++) {
    const y = interlaced ? deinterlaceRow(j, h) : j
    if (y >= h) continue
    let s = j * w
    let d = y * w * 4
    for (let x = 0; x < w; x++, s++, d += 4) {
      const idx = indices[s]
      // A transparent index outside the palette is still transparent — that is
      // what browsers do, and throwing here would reject valid-looking files.
      if (idx === transparentIndex) continue
      if (idx < palSize && palette) {
        out[d] = palette[idx * 3]
        out[d + 1] = palette[idx * 3 + 1]
        out[d + 2] = palette[idx * 3 + 2]
      }
      out[d + 3] = 255
    }
  }
  return out
}

/** Container metadata only: no LZW, no pixels. Cheap enough for import budgeting. */
export function probeGif(bytes: Uint8Array): { width: number; height: number; frameCount: number; loop: number } {
  if (!isGif(bytes)) throw new Error('Not a GIF file')
  const width = bytes[6] | (bytes[7] << 8)
  const height = bytes[8] | (bytes[9] << 8)
  const packed = bytes[10]
  let p = 13
  if (packed & 0x80) p += (1 << ((packed & 0x07) + 1)) * 3
  let frameCount = 0
  let loop = 1
  while (p < bytes.length) {
    const block = bytes[p++]
    if (block === GIF_TRAILER) break
    if (block === GIF_EXTENSION) {
      const label = bytes[p++]
      if (label === EXT_APPLICATION) {
        const size = bytes[p] ?? 0
        const id = String.fromCharCode(...bytes.subarray(p + 1, p + 1 + Math.min(size, 11)))
        const after = p + 1 + size
        if (id === 'NETSCAPE2.0' || id === 'ANIMEXTS1.0') {
          let q = after
          while (q < bytes.length) {
            const n = bytes[q]
            if (n === 0) {
              q++
              break
            }
            if (n >= 3 && bytes[q + 1] === 0x01) loop = bytes[q + 2] | (bytes[q + 3] << 8)
            q += 1 + n
          }
          p = q
        } else {
          p = skipSubBlocks(bytes, after)
        }
      } else if (label === EXT_PLAIN_TEXT) {
        p = skipSubBlocks(bytes, Math.min(bytes.length, p + 1 + (bytes[p] ?? 0)))
      } else {
        p = skipSubBlocks(bytes, p)
      }
      continue
    }
    if (block === GIF_IMAGE_DESCRIPTOR) {
      if (p + 9 > bytes.length) break
      const fpacked = bytes[p + 8]
      p += 9
      if (fpacked & 0x80) p += (1 << ((fpacked & 0x07) + 1)) * 3
      p++ // LZW minimum code size
      p = skipSubBlocks(bytes, p)
      frameCount++
      continue
    }
    break
  }
  return { width, height, frameCount, loop }
}
