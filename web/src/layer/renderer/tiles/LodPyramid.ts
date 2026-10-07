// Level-of-detail pyramid for the composited image.
//
// Level 0 is full resolution; level L stores one texel per 2^L document pixels.
// A level-L tile is built by a 2x2 alpha-weighted (premultiplied) reduction of
// the four level-(L-1) tiles below it, in LINEAR space — reducing in encoded
// sRGB is what makes naive downscales look too dark.
//
// The point of this class is what it does NOT do. The current renderer calls
// `generateMipmap` on a document-sized target, which regenerates the whole mip
// chain on every write; the audit puts that among the main costs while drawing.
// Here:
//   - invalidation is recorded per level in a chunk bitset (cheap, no work done);
//   - regeneration is LAZY: a coarse tile is rebuilt only when something asks
//     for it, and only the tiles that are both dirty and needed;
//   - regeneration is PARTIAL: `dirtyRectInTile()` returns the chunk-aligned
//     sub-rect to rebuild, so a 40px dab does not rebuild a whole 256^2 tile.
//
// Pure arithmetic: no WebGL, no DOM, no React.

import {
  MAX_TILE_LEVEL,
  TILE_SIZE,
  type Rect,
  type TileKey,
  levelSize,
  rectIntersect,
  rectIsEmpty,
  rectScaleDown,
  rectScaleUp,
  tileDocRect,
  tileLevelRect,
  tilesAcross,
} from './geometry'
import { DirtyRegion } from './DirtyRegion'

/**
 * Level selection: how many document pixels one device pixel covers.
 * Level 0 while magnifying or at 1:1, then one level per power-of-two reduction.
 */
export function levelForScale(zoom: number, dpr: number): number {
  const s = zoom * dpr
  if (!(s > 0)) return 0
  const texelsPerDevicePixel = 1 / s
  return Math.max(0, Math.floor(Math.log2(Math.max(1, texelsPerDevicePixel))))
}

/** Deepest useful level: the one where the whole document fits in a single tile. */
export function maxLevelFor(docWidth: number, docHeight: number, tileSize = TILE_SIZE): number {
  let level = 0
  while (
    level < MAX_TILE_LEVEL &&
    (Math.ceil(docWidth / (1 << level)) > tileSize || Math.ceil(docHeight / (1 << level)) > tileSize)
  ) {
    level++
  }
  return level
}

export interface LodPyramidOptions {
  /** Cap the pyramid depth; defaults to maxLevelFor(docWidth, docHeight). */
  maxLevel?: number
  tileSize?: number
}

export interface LodPyramidStats {
  levelCount: number
  /** Dirty chunks per level, index = level. */
  dirtyChunks: number[]
  /** Total dirty chunks across the pyramid. */
  totalDirtyChunks: number
  /** Levels currently holding dirt. */
  dirtyLevels: number[]
}

export class LodPyramid {
  readonly docWidth: number
  readonly docHeight: number
  readonly tileSize: number
  readonly maxLevel: number

  private readonly regions: DirtyRegion[] = []

  constructor(docWidth: number, docHeight: number, opts: LodPyramidOptions = {}) {
    this.docWidth = Math.max(1, Math.floor(docWidth))
    this.docHeight = Math.max(1, Math.floor(docHeight))
    this.tileSize = opts.tileSize ?? TILE_SIZE
    const natural = maxLevelFor(this.docWidth, this.docHeight, this.tileSize)
    this.maxLevel = Math.min(MAX_TILE_LEVEL, Math.max(0, opts.maxLevel ?? natural))
    for (let l = 0; l <= this.maxLevel; l++) {
      this.regions.push(new DirtyRegion(this.levelWidth(l), this.levelHeight(l)))
    }
  }

  get levelCount(): number {
    return this.maxLevel + 1
  }

  levelWidth(level: number): number {
    return levelSize(this.docWidth, level)
  }

  levelHeight(level: number): number {
    return levelSize(this.docHeight, level)
  }

  tilesAcrossAt(level: number): number {
    return tilesAcross(this.docWidth, level)
  }

  tilesDownAt(level: number): number {
    return tilesAcross(this.docHeight, level)
  }

  /** Total tiles at `level` — bounded by the document, unlike the visible count. */
  tileCountAt(level: number): number {
    return this.tilesAcrossAt(level) * this.tilesDownAt(level)
  }

  /** Level the display pass should sample, clamped to the pyramid depth. */
  chooseLevel(zoom: number, dpr: number): number {
    return Math.min(this.maxLevel, levelForScale(zoom, dpr))
  }

  // ── Invalidation ──────────────────────────────────────────────────────────

  /**
   * Cascade a document-space rect through every level. Cost is geometric:
   * level L touches a quarter of the chunks of level L-1, so the whole cascade
   * costs about 1.33x a single level-0 invalidation. Nothing is rebuilt here.
   */
  invalidate(rect: Rect | null): void {
    if (rectIsEmpty(rect)) return
    const r = rect as Rect
    for (let l = 0; l <= this.maxLevel; l++) {
      this.regions[l].invalidate(l === 0 ? r : rectScaleDown(r, l))
    }
  }

  invalidateAll(): void {
    for (const region of this.regions) region.invalidateAll()
  }

  /** Region of one level, in level-L pixel coordinates. Exposed for diagnostics. */
  region(level: number): DirtyRegion {
    return this.regions[Math.min(this.maxLevel, Math.max(0, level))]
  }

  isLevelDirty(level: number): boolean {
    if (level < 0 || level > this.maxLevel) return false
    return this.regions[level].isDirty()
  }

  isDirty(): boolean {
    for (const region of this.regions) if (region.isDirty()) return true
    return false
  }

  isTileDirty(key: TileKey): boolean {
    if (key.level < 0 || key.level > this.maxLevel) return false
    return this.regions[key.level].hasDirtyIn(tileLevelRect(key))
  }

  /**
   * Chunk-aligned sub-rect of `key` that still needs rebuilding, in LEVEL-L
   * pixel coordinates (that is what a tile-local scissor wants). Null = clean.
   */
  dirtyRectInTile(key: TileKey): Rect | null {
    if (key.level < 0 || key.level > this.maxLevel) return null
    return this.regions[key.level].dirtyInRect(tileLevelRect(key))
  }

  /** Same rect, expressed in document pixels — handy for logging and tests. */
  dirtyDocRectInTile(key: TileKey): Rect | null {
    const local = this.dirtyRectInTile(key)
    if (!local) return null
    return rectIntersect(rectScaleUp(local, key.level), tileDocRect(key))
  }

  /** A tile has been rebuilt: clear its chunks at that level only. */
  markTileBuilt(key: TileKey): void {
    if (key.level < 0 || key.level > this.maxLevel) return
    this.regions[key.level].clear(tileLevelRect(key))
  }

  /** Clear an arbitrary level-L rect (partial rebuild of a tile). */
  markBuilt(level: number, levelRect: Rect): void {
    if (level < 0 || level > this.maxLevel) return
    this.regions[level].clear(levelRect)
  }

  // ── Scheduling surface (consumed by TileScheduler) ────────────────────────

  /**
   * Dirty tiles at `level`, optionally restricted to a document-space rect.
   * Restricting to the visible rect is what keeps the work bounded by the
   * viewport instead of by the document.
   */
  dirtyTilesAt(level: number, withinDocRect?: Rect | null): TileKey[] {
    if (level < 0 || level > this.maxLevel) return []
    const region = this.regions[level]
    if (!region.isDirty()) return []
    const scope = withinDocRect ? rectScaleDown(withinDocRect, level) : null
    const keys = region.dirtyTiles(0, undefined, scope)
    // dirtyTiles() addresses tiles in the region's own pixel space, which is
    // level-L space here, so the indices are already the level-L tile indices.
    const out: TileKey[] = []
    const maxTx = this.tilesAcrossAt(level)
    const maxTy = this.tilesDownAt(level)
    for (const k of keys) {
      if (k.tx >= maxTx || k.ty >= maxTy) continue
      out.push({ level, tx: k.tx, ty: k.ty })
    }
    return out
  }

  /** The four level-(L-1) tiles that feed `key`. Empty at level 0. */
  sourceKeys(key: TileKey): TileKey[] {
    if (key.level <= 0) return []
    const l = key.level - 1
    const bx = key.tx * 2
    const by = key.ty * 2
    const maxTx = this.tilesAcrossAt(l)
    const maxTy = this.tilesDownAt(l)
    const out: TileKey[] = []
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const tx = bx + dx
        const ty = by + dy
        if (tx >= maxTx || ty >= maxTy) continue
        out.push({ level: l, tx, ty })
      }
    }
    return out
  }

  /**
   * The tile covering the same document area at `level + n`, for n >= 1.
   * Used to find an instant coarse stand-in while the fine tile rebuilds.
   */
  ancestor(key: TileKey, levelsUp = 1): TileKey | null {
    const level = key.level + levelsUp
    if (level > this.maxLevel) return null
    return { level, tx: key.tx >> levelsUp, ty: key.ty >> levelsUp }
  }

  /**
   * Walk up the pyramid until `isValid` accepts a tile. Returns null when no
   * ancestor is usable — the caller then draws the checkerboard, never nothing.
   */
  bestAvailable(key: TileKey, isValid: (k: TileKey) => boolean): TileKey | null {
    if (isValid(key)) return key
    for (let up = 1; key.level + up <= this.maxLevel; up++) {
      const a = this.ancestor(key, up)
      if (a && isValid(a)) return a
    }
    return null
  }

  stats(): LodPyramidStats {
    const dirtyChunks: number[] = []
    const dirtyLevels: number[] = []
    let total = 0
    for (let l = 0; l <= this.maxLevel; l++) {
      const n = this.regions[l].dirtyChunkCount()
      dirtyChunks.push(n)
      total += n
      if (n > 0) dirtyLevels.push(l)
    }
    return { levelCount: this.levelCount, dirtyChunks, totalDirtyChunks: total, dirtyLevels }
  }
}
