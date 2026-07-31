// Sparse per-layer pixel storage: a layer only owns tiles where it actually has
// pixels. This is the answer to G4 and to the PSD sizing problem.
//
// Today `createTex` allocates w*h*4 for every layer, empty or not, and uploads a
// JS Uint8Array of that size. On the reference document (4000x4000, 30 layers)
// that is 1 920 MiB of VRAM; a 40-layer 6000x4000 PSD would ask for 3.8 GiB
// before a single pixel is drawn.
//
// With sparse storage:
//   - an empty layer costs 0 byte and is skipped entirely by the compositor;
//   - a partial layer costs only the tiles it covers;
//   - painting outside the allocated area grows the layer one tile at a time;
//   - a tile that becomes fully transparent again is released.
//
// The class never inspects pixels: deciding that a tile is transparent requires
// reading it back, which belongs to stage 3/4. Callers report it through
// `setTileTransparent()` (or `writeRect(..., { transparent: true })`), and
// `collectGarbage()` does the freeing. Keeping the policy here and the pixel
// knowledge outside is what keeps this file testable with no WebGL.

import {
  MAX_TILE_INDEX,
  TILE_SIZE,
  type Rect,
  type TileId,
  type TileKey,
  keyId,
  rectIntersect,
  rectIsEmpty,
  rectUnion,
  tileDocRect,
  tileKeyOf,
  tileRangeForRect,
} from './geometry'
import type { DeviceTexture, GLDeviceLike } from './GLDeviceLike'

export interface LayerTile {
  readonly key: TileKey
  readonly id: TileId
  texture: DeviceTexture
  readonly bytes: number
  /** True once the caller has established the tile holds only transparent texels. */
  transparent: boolean
}

export interface SparseLayerOptions {
  tileSize?: number
  bytesPerTexel?: number
  /** Clear a newly allocated tile to transparent (one device call). Default true. */
  clearOnAllocate?: boolean
}

export interface WriteOptions {
  /**
   * The caller knows the written pixels are fully transparent (eraser clearing a
   * region, cleared selection…). Tiles fully covered by the rect become
   * candidates for release at the next collectGarbage().
   */
  transparent?: boolean
}

export interface SparseLayerStats {
  layerId: string
  tiles: number
  emptyTiles: number
  residentBytes: number
  /** What a document-sized texture would cost — the number we are beating. */
  denseBytes: number
  /** residentBytes / denseBytes. */
  ratio: number
  allocations: number
  releases: number
}

export class SparseLayer {
  readonly layerId: string
  readonly docWidth: number
  readonly docHeight: number
  readonly tileSize: number
  readonly bytesPerTile: number

  private readonly device: GLDeviceLike
  private readonly clearOnAllocate: boolean
  private readonly tilesById = new Map<TileId, LayerTile>()
  /** Tiles known to be fully transparent: never allocated, never composited. */
  private readonly emptyIds = new Set<TileId>()
  private bboxCache: Rect | null = null
  private allocations = 0
  private releases = 0

  constructor(
    layerId: string,
    docWidth: number,
    docHeight: number,
    device: GLDeviceLike,
    opts: SparseLayerOptions = {},
  ) {
    this.layerId = layerId
    this.docWidth = Math.max(0, Math.floor(docWidth))
    this.docHeight = Math.max(0, Math.floor(docHeight))
    this.device = device
    this.tileSize = opts.tileSize ?? TILE_SIZE
    const bpt = opts.bytesPerTexel ?? device.bytesPerTexel
    this.bytesPerTile = this.tileSize * this.tileSize * bpt
    this.clearOnAllocate = opts.clearOnAllocate ?? true
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  /** Tile-aligned bounding box of the non-empty tiles; null when the layer is empty. */
  get bbox(): Rect | null {
    return this.bboxCache ? { ...this.bboxCache } : null
  }

  get tileCount(): number {
    return this.tilesById.size
  }

  get emptyTileCount(): number {
    return this.emptyIds.size
  }

  get residentBytes(): number {
    return this.tilesById.size * this.bytesPerTile
  }

  /** VRAM a document-sized texture would take — the baseline sparsity beats. */
  get denseBytes(): number {
    const bpt = this.bytesPerTile / (this.tileSize * this.tileSize)
    return this.docWidth * this.docHeight * bpt
  }

  hasTile(tx: number, ty: number): boolean {
    return this.tilesById.has(keyId({ level: 0, tx, ty }))
  }

  getTile(tx: number, ty: number): LayerTile | undefined {
    return this.tilesById.get(keyId({ level: 0, tx, ty }))
  }

  /** True when the tile is known transparent and therefore holds no texture. */
  isKnownEmpty(tx: number, ty: number): boolean {
    return this.emptyIds.has(keyId({ level: 0, tx, ty }))
  }

  /** Cheap reject used by the compositor: does this layer contribute to `rect`? */
  intersects(rect: Rect | null): boolean {
    if (!this.bboxCache || rectIsEmpty(rect)) return false
    if (!rectIntersect(this.bboxCache, rect)) return false
    const range = tileRangeForRect(rect, 0)
    if (!range) return false
    for (let ty = range.ty0; ty < range.ty1; ty++) {
      for (let tx = range.tx0; tx < range.tx1; tx++) {
        if (this.tilesById.has(keyId({ level: 0, tx, ty }))) return true
      }
    }
    return false
  }

  tilesIntersecting(rect: Rect | null): LayerTile[] {
    const out: LayerTile[] = []
    const range = tileRangeForRect(rectIntersect(this.bboxCache, rect), 0)
    if (!range) return out
    for (let ty = range.ty0; ty < range.ty1; ty++) {
      for (let tx = range.tx0; tx < range.tx1; tx++) {
        const t = this.tilesById.get(keyId({ level: 0, tx, ty }))
        if (t) out.push(t)
      }
    }
    return out
  }

  tiles(): IterableIterator<LayerTile> {
    return this.tilesById.values()
  }

  stats(): SparseLayerStats {
    const dense = this.denseBytes
    return {
      layerId: this.layerId,
      tiles: this.tilesById.size,
      emptyTiles: this.emptyIds.size,
      residentBytes: this.residentBytes,
      denseBytes: dense,
      ratio: dense > 0 ? this.residentBytes / dense : 0,
      allocations: this.allocations,
      releases: this.releases,
    }
  }

  // ── Growth ────────────────────────────────────────────────────────────────

  /**
   * Allocate the tile at (tx,ty) if needed — this is the automatic extension
   * path: painting outside the currently allocated area simply creates tiles.
   * Indices are clamped to the packed-id range (14 bits per axis).
   */
  ensureTile(tx: number, ty: number): LayerTile {
    if (tx < 0 || ty < 0 || tx > MAX_TILE_INDEX || ty > MAX_TILE_INDEX) {
      throw new RangeError(`SparseLayer: tile index out of range (${tx},${ty})`)
    }
    const key: TileKey = { level: 0, tx, ty }
    const id = keyId(key)
    const existing = this.tilesById.get(id)
    if (existing) {
      existing.transparent = false
      this.emptyIds.delete(id)
      return existing
    }
    const texture = this.device.createTexture({
      width: this.tileSize,
      height: this.tileSize,
      label: `${this.layerId} tile ${tx},${ty}`,
    })
    if (this.clearOnAllocate) {
      this.device.writeTextureRect(
        texture,
        { x0: 0, y0: 0, x1: this.tileSize, y1: this.tileSize },
        null,
      )
    }
    const tile: LayerTile = { key, id, texture, bytes: this.bytesPerTile, transparent: false }
    this.tilesById.set(id, tile)
    this.emptyIds.delete(id)
    this.allocations++
    this.bboxCache = rectUnion(this.bboxCache, this.clampToDoc(tileDocRect(key)))
    return tile
  }

  /** Allocate every tile covering `rect`, without writing anything. */
  ensureRect(rect: Rect | null): LayerTile[] {
    const out: LayerTile[] = []
    const range = tileRangeForRect(rect, 0)
    if (!range) return out
    for (let ty = range.ty0; ty < range.ty1; ty++) {
      for (let tx = range.tx0; tx < range.tx1; tx++) out.push(this.ensureTile(tx, ty))
    }
    return out
  }

  /**
   * Write `pixels` into `rect` (document space), splitting the upload per tile.
   * `pixels === null` uploads nothing and only allocates — used when the pixels
   * will be produced on the GPU by a later pass.
   *
   * When `opts.transparent` is set, tiles fully covered by `rect` are flagged as
   * transparent and become release candidates; partially covered tiles cannot be
   * concluded transparent and are left alone.
   */
  writeRect(rect: Rect | null, pixels: ArrayBufferView | null, opts: WriteOptions = {}): LayerTile[] {
    if (rectIsEmpty(rect)) return []
    const r = rect as Rect
    const touched: LayerTile[] = []
    const range = tileRangeForRect(r, 0)
    if (!range) return touched
    for (let ty = range.ty0; ty < range.ty1; ty++) {
      for (let tx = range.tx0; tx < range.tx1; tx++) {
        const key: TileKey = { level: 0, tx, ty }
        const tileRect = tileDocRect(key)
        const local = rectIntersect(r, tileRect)
        if (!local) continue
        const fullyCovered =
          local.x0 === tileRect.x0 &&
          local.y0 === tileRect.y0 &&
          local.x1 === tileRect.x1 &&
          local.y1 === tileRect.y1

        if (opts.transparent) {
          // Erasing: do not allocate a tile that does not exist yet.
          const existing = this.tilesById.get(keyId(key))
          if (!existing) {
            if (fullyCovered) this.emptyIds.add(keyId(key))
            continue
          }
          if (pixels) this.uploadInto(existing, local, tileRect, pixels)
          if (fullyCovered) existing.transparent = true
          touched.push(existing)
          continue
        }

        const tile = this.ensureTile(tx, ty)
        if (pixels) this.uploadInto(tile, local, tileRect, pixels)
        touched.push(tile)
      }
    }
    return touched
  }

  /** Erase `rect`: shorthand for writeRect(rect, null, { transparent: true }). */
  eraseRect(rect: Rect | null): LayerTile[] {
    return this.writeRect(rect, null, { transparent: true })
  }

  // ── Shrinking ─────────────────────────────────────────────────────────────

  /** Record whether a tile is now fully transparent (result of a GPU alpha scan). */
  setTileTransparent(tx: number, ty: number, transparent: boolean): void {
    const tile = this.tilesById.get(keyId({ level: 0, tx, ty }))
    if (!tile) return
    tile.transparent = transparent
  }

  /**
   * Release every tile flagged transparent. Returns the bytes freed.
   * This is the shrink half of the sparse contract: without it a layer would
   * only ever grow, and an erased area would keep costing VRAM forever.
   */
  collectGarbage(): number {
    let freed = 0
    for (const [id, tile] of [...this.tilesById]) {
      if (!tile.transparent) continue
      this.tilesById.delete(id)
      this.emptyIds.add(id)
      this.device.deleteTexture(tile.texture)
      this.releases++
      freed += tile.bytes
    }
    if (freed > 0) this.recomputeBbox()
    return freed
  }

  /** Drop every tile; the layer becomes empty and costs nothing. */
  clear(): void {
    for (const tile of this.tilesById.values()) {
      this.device.deleteTexture(tile.texture)
      this.releases++
    }
    this.tilesById.clear()
    this.emptyIds.clear()
    this.bboxCache = null
  }

  dispose(): void {
    this.clear()
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private uploadInto(tile: LayerTile, local: Rect, tileRect: Rect, pixels: ArrayBufferView): void {
    // Texture-local coordinates: the caller's rect is in document space.
    const dst: Rect = {
      x0: local.x0 - tileRect.x0,
      y0: local.y0 - tileRect.y0,
      x1: local.x1 - tileRect.x0,
      y1: local.y1 - tileRect.y0,
    }
    this.device.writeTextureRect(tile.texture, dst, pixels)
  }

  private clampToDoc(r: Rect): Rect | null {
    return rectIntersect(r, { x0: 0, y0: 0, x1: this.docWidth, y1: this.docHeight })
  }

  private recomputeBbox(): void {
    let box: Rect | null = null
    for (const id of this.tilesById.keys()) {
      box = rectUnion(box, this.clampToDoc(tileDocRect(tileKeyOf(id))))
    }
    this.bboxCache = box
  }
}
