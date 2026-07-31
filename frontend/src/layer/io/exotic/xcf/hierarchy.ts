// SPDX-License-Identifier: AGPL-3.0-or-later
//
// XCF decoding logic derived from the GIMP source code (app/xcf/xcf-load.c
// `xcf_load_buffer` / `xcf_load_level` / `xcf_load_tile*`), Copyright (C) 1995 Spencer
// Kimball and Peter Mattis and the GIMP contributors, licensed GPL-3.0-or-later.
// Reimplemented in TypeScript for Kubuno (AGPL-3.0-or-later).

import { ImportError } from '../errors'
import { ImportWarningSink, importWarn } from '../types'
import { XCF_TILE_SIZE } from './header'
import { COMPRESS } from './props'
import { XcfReader } from './reader'
import { decodeTileRle } from './rle'
import { inflateZlib } from './zlib'

/** `XCF_TILE_MAX_DATA_LENGTH_FACTOR`: RLE can expand incompressible noise by up to 1.5×. */
const MAX_DATA_LENGTH_FACTOR = 1.5

/** No sane layer has more tiles than this; the cap stops a crafted level header cold. */
const MAX_TILES = 1_000_000

/** Receives one decoded tile, in file coordinates relative to the buffer's origin. */
export type TileSink = (tileData: Uint8Array, tw: number, th: number, x: number, y: number) => void

export interface HierarchyResult {
  readonly width: number
  readonly height: number
  readonly bpp: number
  /** Tiles that could not be decompressed; they were left transparent. */
  readonly lostTiles: number
  /** True when the level had no tiles at all: the buffer is entirely empty. */
  readonly empty: boolean
}

/**
 * Reads a "hierarchy" (GIMP's name for a buffer) and pushes every tile of its level 0
 * into `sink`.
 *
 * GIMP explicitly discards the levels below the first (they are a leftover mipmap
 * pyramid); so do we.
 */
export async function decodeHierarchy(
  r: XcfReader,
  hierarchyOffset: number,
  compression: number,
  expectedBpp: number,
  warn: ImportWarningSink,
  sink: TileSink,
): Promise<HierarchyResult> {
  r.pos = hierarchyOffset
  const width = r.u32()
  const height = r.u32()
  const bpp = r.u32()

  if (bpp !== expectedBpp) {
    throw new ImportError(
      'corrupt',
      'layer.io.err.corrupt',
      undefined,
      `hierarchy declares ${bpp} bytes/pixel, layer type implies ${expectedBpp}`,
    )
  }
  if (width <= 0 || height <= 0 || width > 1_000_000 || height > 1_000_000) {
    throw new ImportError('corrupt', 'layer.io.err.corrupt', undefined, `hierarchy ${width}×${height}`)
  }

  // Level pointers, terminated by 0. Only the first is used.
  const levelOffset = r.offset()
  if (levelOffset === 0) {
    return { width, height, bpp, lostTiles: 0, empty: true }
  }
  if (!r.validOffset(levelOffset, r.pos)) {
    throw new ImportError('corrupt', 'layer.io.err.corrupt', undefined, `bad level offset ${levelOffset}`)
  }

  const lost = await decodeLevel(r, levelOffset, compression, bpp, width, warn, sink)
  return { width, height, bpp, lostTiles: lost.lostTiles, empty: lost.empty }
}

async function decodeLevel(
  r: XcfReader,
  levelOffset: number,
  compression: number,
  bpp: number,
  bufferWidth: number,
  warn: ImportWarningSink,
  sink: TileSink,
): Promise<{ lostTiles: number; empty: boolean }> {
  r.pos = levelOffset
  const width = r.u32()
  const height = r.u32()
  if (width <= 0 || height <= 0) return { lostTiles: 0, empty: true }

  const nCols = Math.ceil(width / XCF_TILE_SIZE)
  const nRows = Math.ceil(height / XCF_TILE_SIZE)
  const nTiles = nCols * nRows
  if (nTiles > MAX_TILES) {
    throw new ImportError('too-large', 'layer.io.err.too_large', undefined, `${nTiles} tiles`)
  }

  // Tile pointer table, terminated by 0. One extra slot is read so the LAST tile's
  // length can be derived from its successor, exactly as GIMP does.
  const offsets: number[] = []
  for (let i = 0; i <= nTiles; i++) {
    const off = r.offset()
    offsets.push(off)
    if (off === 0) break
  }
  if (offsets.length === 0 || offsets[0] === 0) {
    // `tile_offset[0] === 0` means an empty level: fully transparent layer, not an error.
    return { lostTiles: 0, empty: true }
  }

  const maxDataLength = XCF_TILE_SIZE * XCF_TILE_SIZE * bpp * MAX_DATA_LENGTH_FACTOR
  const tileData = new Uint8Array(XCF_TILE_SIZE * XCF_TILE_SIZE * bpp)
  let lostTiles = 0

  const usable = Math.min(nTiles, offsets.length)
  for (let i = 0; i < usable; i++) {
    const offset = offsets[i]
    if (offset === 0) break

    const col = i % nCols
    const row = (i / nCols) | 0
    const x = col * XCF_TILE_SIZE
    const y = row * XCF_TILE_SIZE
    // Edge tiles are SMALLER than 64×64 — the single most common third-party bug.
    const tw = Math.min(XCF_TILE_SIZE, width - x)
    const th = Math.min(XCF_TILE_SIZE, height - y)
    if (tw <= 0 || th <= 0) continue
    const tileSize = tw * th * bpp

    const next = offsets[i + 1] ?? 0
    let dataLength = next > 0 ? next - offset : maxDataLength
    if (next > 0 && (next < offset || next - offset > maxDataLength)) {
      warn.warn(importWarn('xcf.bad-tile-extent'))
      lostTiles += 1
      continue
    }
    if (compression === COMPRESS.NONE) dataLength = tileSize
    dataLength = Math.min(dataLength, r.size - offset)
    if (dataLength <= 0) {
      // GIMP returns success without writing anything here (workaround for bug #357809).
      continue
    }

    tileData.fill(0, 0, tileSize)
    let ok = true
    try {
      const src = r.subarray(offset, dataLength)
      switch (compression) {
        case COMPRESS.NONE:
          tileData.set(src.subarray(0, tileSize))
          break
        case COMPRESS.RLE:
          decodeTileRle(src, tileData, bpp, tw * th)
          break
        case COMPRESS.ZLIB: {
          const out = await inflateZlib(src)
          tileData.set(out.subarray(0, Math.min(out.length, tileSize)))
          break
        }
        default:
          throw new ImportError(
            'unsupported-format',
            'layer.io.err.xcf_unsupported_compression',
            { compression },
          )
      }
    } catch (e) {
      if (e instanceof ImportError && e.code === 'unsupported-format') throw e
      // A single bad tile costs a tile, never the document (spec 07 §4.7).
      ok = false
    }

    if (!ok) {
      lostTiles += 1
      continue
    }
    sink(tileData, tw, th, x, y)
  }

  if (lostTiles > 0) warn.warn(importWarn('xcf.lost-tiles', { count: lostTiles }))
  void bufferWidth
  return { lostTiles, empty: false }
}
