// Cache of composited tiles: TILE_SIZE x TILE_SIZE textures holding the result
// of running the pass plan over one tile, at one LOD level.
//
// Why this fixes G4 (no tiling, ~2.4 GiB of VRAM on the reference document):
// the ping-pong pair is document-sized today (2 x 64 MiB in 4K, x4 in 8K), so
// memory grows with the document. Here the working set is bounded by the
// viewport instead: ~135 visible tiles + a one-tile ring ~= 195 tiles, i.e.
// 195 * 256^2 * 8 = 102 MiB in RGBA16F *whatever the document size*.
//
// Eviction is strict LRU with two protections, per spec 3.4:
//   (a) tiles pinned for the current frame are never evicted;
//   (b) coarse LOD tiles are expensive to rebuild and cheap to keep, so their
//       effective age is divided by 4^level — they leave the cache last.
//
// No WebGL here: textures come from a `GLDeviceLike`.

import {
  TILE_SIZE,
  type Rect,
  type TileId,
  type TileKey,
  keyId,
  rectAlignOut,
  rectIntersect,
  rectIsEmpty,
  rectUnion,
  tileDocRect,
  tileIdLevel,
  tileKeyOf,
  tileRangeForRect,
  CHUNK_SIZE,
} from './geometry'
import { defaultClock, type Clock, type DeviceTexture, type GLDeviceLike } from './GLDeviceLike'

/** One cached composited tile. */
export interface CompositedTile {
  readonly key: TileKey
  readonly id: TileId
  texture: DeviceTexture
  /** Composite generation this tile was built from; stale when < cache.generation. */
  generation: number
  /** Chunk-aligned dirty rect inside this tile, in document pixels; null = valid. */
  dirty: Rect | null
  /** Clock value of last use — LRU eviction. */
  lastUsed: number
  /** True while an async build is in flight (prevents duplicate scheduling). */
  pending: boolean
  /** True while the tile is visible this frame; pinned tiles are never evicted. */
  pinned: boolean
  /** VRAM footprint of this tile, in bytes. */
  readonly bytes: number
}

export interface TileCacheOptions {
  /** Hard VRAM budget for composited tiles, in bytes. Default 512 MiB. */
  budgetBytes?: number
  /** Overrides the device's bytesPerTexel (RGBA16F = 8, RGBA8 = 4). */
  bytesPerTexel?: number
  /** Tile edge in texels. Kept configurable — spec 15.3 wants 256 confirmed by measurement. */
  tileSize?: number
  /** How many freed textures to keep for recycling before really deleting them. */
  recyclePoolSize?: number
  clock?: Clock
}

export interface TileCacheStats {
  hits: number
  misses: number
  hitRate: number
  allocations: number
  recycled: number
  evictions: number
  /** Live tiles held by the cache. */
  tiles: number
  pending: number
  pinned: number
  /** Bytes held by live tiles. */
  liveBytes: number
  /** Bytes held by the recycle pool (allocated but unused). */
  pooledBytes: number
  /** liveBytes + pooledBytes — what the GPU actually holds. */
  residentBytes: number
  budgetBytes: number
  /** residentBytes / budgetBytes. */
  occupancy: number
  generation: number
}

const DEFAULT_BUDGET = 512 * 1024 * 1024

export class TileCache {
  private readonly device: GLDeviceLike
  private readonly tiles = new Map<TileId, CompositedTile>()
  /** Live tile ids indexed by LOD level — makes cascade invalidation O(touched). */
  private readonly byLevel = new Map<number, Set<TileId>>()
  private readonly pool: DeviceTexture[] = []
  private readonly clock: Clock

  readonly tileSize: number
  readonly bytesPerTile: number
  readonly budgetBytes: number
  private readonly recyclePoolSize: number

  /** Bumped whenever the pass plan is recompiled; older tiles are stale. */
  private currentGeneration = 1

  private hits = 0
  private misses = 0
  private allocations = 0
  private recycledCount = 0
  private evictions = 0
  private liveBytes = 0
  private pinnedCount = 0
  private pendingCount = 0

  constructor(device: GLDeviceLike, opts: TileCacheOptions = {}) {
    this.device = device
    this.clock = opts.clock ?? defaultClock
    this.tileSize = opts.tileSize ?? TILE_SIZE
    const bpt = opts.bytesPerTexel ?? device.bytesPerTexel
    this.bytesPerTile = this.tileSize * this.tileSize * bpt
    this.budgetBytes = opts.budgetBytes ?? DEFAULT_BUDGET
    this.recyclePoolSize = opts.recyclePoolSize ?? 8
  }

  get generation(): number {
    return this.currentGeneration
  }

  get size(): number {
    return this.tiles.size
  }

  // ── Lookup ────────────────────────────────────────────────────────────────

  get(key: TileKey): CompositedTile | undefined {
    return this.getById(keyId(key))
  }

  getById(id: TileId): CompositedTile | undefined {
    const t = this.tiles.get(id)
    if (t) this.hits++
    else this.misses++
    return t
  }

  /** Lookup without touching hit/miss statistics. */
  peek(key: TileKey): CompositedTile | undefined {
    return this.tiles.get(keyId(key))
  }

  /** A tile is usable as-is only when current, clean and not being rebuilt. */
  isValid(tile: CompositedTile | undefined): tile is CompositedTile {
    return (
      tile !== undefined &&
      tile.generation === this.currentGeneration &&
      tile.dirty === null &&
      !tile.pending
    )
  }

  hasValid(key: TileKey): boolean {
    return this.isValid(this.tiles.get(keyId(key)))
  }

  /**
   * Coarsest-first fallback: the level-L tile covering the same document area,
   * used as an instant (slightly blurry) stand-in while the fine tile rebuilds.
   * Returns null when no ancestor is available.
   */
  findCoarseSubstitute(key: TileKey, maxLevel = 15): TileKey | null {
    let level = key.level + 1
    let tx = key.tx >> 1
    let ty = key.ty >> 1
    while (level <= maxLevel) {
      const cand: TileKey = { level, tx, ty }
      if (this.hasValid(cand)) return cand
      level++
      tx >>= 1
      ty >>= 1
    }
    return null
  }

  // ── Allocation ────────────────────────────────────────────────────────────

  /**
   * Get the tile for `key`, allocating (or recycling) a texture when absent.
   * A freshly allocated tile starts fully dirty: nothing has been composited
   * into it yet.
   */
  acquire(key: TileKey): CompositedTile {
    const id = keyId(key)
    const existing = this.tiles.get(id)
    if (existing) {
      existing.lastUsed = this.clock()
      return existing
    }
    let texture = this.pool.pop()
    if (texture) this.recycledCount++
    else {
      texture = this.device.createTexture({
        width: this.tileSize,
        height: this.tileSize,
        label: `tile L${key.level} ${key.tx},${key.ty}`,
      })
      this.allocations++
    }
    const tile: CompositedTile = {
      key: { level: key.level, tx: key.tx, ty: key.ty },
      id,
      texture,
      generation: this.currentGeneration - 1, // stale until built
      dirty: tileDocRect(key),
      lastUsed: this.clock(),
      pending: false,
      pinned: false,
      bytes: this.bytesPerTile,
    }
    this.tiles.set(id, tile)
    this.levelSet(key.level).add(id)
    this.liveBytes += tile.bytes
    return tile
  }

  /** Mark used this frame — protects from eviction until endFrame(). */
  touch(key: TileKey): void {
    const t = this.tiles.get(keyId(key))
    if (t) t.lastUsed = this.clock()
  }

  pin(key: TileKey): void {
    const t = this.tiles.get(keyId(key))
    if (!t || t.pinned) return
    t.pinned = true
    t.lastUsed = this.clock()
    this.pinnedCount++
  }

  /** Start of a frame: nothing is pinned yet. */
  beginFrame(): void {
    if (this.pinnedCount === 0) return
    for (const t of this.tiles.values()) t.pinned = false
    this.pinnedCount = 0
  }

  setPending(key: TileKey, pending: boolean): void {
    const t = this.tiles.get(keyId(key))
    if (!t || t.pending === pending) return
    t.pending = pending
    this.pendingCount += pending ? 1 : -1
  }

  /** A tile has just been composited: it is clean and current. */
  markBuilt(key: TileKey): void {
    const t = this.tiles.get(keyId(key))
    if (!t) return
    t.dirty = null
    t.generation = this.currentGeneration
    t.lastUsed = this.clock()
    if (t.pending) {
      t.pending = false
      this.pendingCount--
    }
  }

  // ── Invalidation ──────────────────────────────────────────────────────────

  /**
   * Mark every cached tile overlapping `rect` (document space) dirty, at every
   * LOD level held by the cache — the cascade of spec 3.6: invalidating at
   * level 0 must also invalidate the ancestors that were reduced from it.
   *
   * Cost is O(tiles actually touched), not O(cache size): tile ranges are
   * computed per level from the rect, then looked up by packed id.
   */
  invalidate(rect: Rect | null, maxLevel?: number): number {
    if (rectIsEmpty(rect)) return 0
    const aligned = rectAlignOut(rect as Rect, CHUNK_SIZE)
    let touched = 0
    for (const [level, ids] of this.byLevel) {
      if (ids.size === 0) continue
      if (maxLevel !== undefined && level > maxLevel) continue
      const range = tileRangeForRect(aligned, level)
      if (!range) continue
      for (let ty = range.ty0; ty < range.ty1; ty++) {
        for (let tx = range.tx0; tx < range.tx1; tx++) {
          const id = keyId({ level, tx, ty })
          const t = this.tiles.get(id)
          if (!t) continue
          const local = rectIntersect(aligned, tileDocRect(t.key))
          if (!local) continue
          t.dirty = rectUnion(t.dirty, local)
          touched++
        }
      }
    }
    return touched
  }

  /** Layer content changed inside `rect`: identical to invalidate(), named for intent. */
  invalidateLayerRect(rect: Rect | null): number {
    return this.invalidate(rect)
  }

  /** Everything is stale (plan recompiled, document resized, context restored). */
  invalidateAll(): void {
    for (const t of this.tiles.values()) t.dirty = tileDocRect(t.key)
  }

  /** Bump the composite generation: every existing tile becomes stale. */
  bumpGeneration(): number {
    this.currentGeneration++
    return this.currentGeneration
  }

  // ── Eviction ──────────────────────────────────────────────────────────────

  /** Drop one tile, recycling its texture when the pool has room. */
  evict(id: TileId): boolean {
    const t = this.tiles.get(id)
    if (!t || t.pinned || t.pending) return false
    this.tiles.delete(id)
    this.levelSet(t.key.level).delete(id)
    this.liveBytes -= t.bytes
    this.evictions++
    if (this.pool.length < this.recyclePoolSize) this.pool.push(t.texture)
    else this.device.deleteTexture(t.texture)
    return true
  }

  /**
   * Evict least-recently-used tiles until resident bytes fit the budget.
   * Returns the number of tiles evicted.
   *
   * Coarse LOD tiles get their age divided by 4^level, so a level-2 tile has to
   * be 16x older than a level-0 tile before it is considered equally stale.
   */
  trim(now = this.clock()): number {
    if (this.residentBytes() <= this.budgetBytes) return 0
    // Drain the recycle pool first: it is allocated VRAM that nobody is using.
    while (this.pool.length > 0 && this.residentBytes() > this.budgetBytes) {
      const tex = this.pool.pop()
      if (tex) this.device.deleteTexture(tex)
    }
    if (this.residentBytes() <= this.budgetBytes) return 0

    const candidates: { id: TileId; score: number }[] = []
    for (const [id, t] of this.tiles) {
      if (t.pinned || t.pending) continue
      const age = Math.max(0, now - t.lastUsed)
      const weight = 1 / Math.pow(4, tileIdLevel(id))
      candidates.push({ id, score: age * weight })
    }
    // Highest weighted age evicted first.
    candidates.sort((a, b) => b.score - a.score)
    let evicted = 0
    for (const c of candidates) {
      if (this.residentBytes() <= this.budgetBytes) break
      if (this.evict(c.id)) {
        evicted++
        // evict() may have pushed the texture back into the pool; drain it so
        // the trim actually frees VRAM instead of moving it around.
        if (this.residentBytes() > this.budgetBytes && this.pool.length > 0) {
          const tex = this.pool.pop()
          if (tex) this.device.deleteTexture(tex)
        }
      }
    }
    return evicted
  }

  // ── Stats & lifecycle ─────────────────────────────────────────────────────

  residentBytes(): number {
    return this.liveBytes + this.pool.length * this.bytesPerTile
  }

  stats(): TileCacheStats {
    const lookups = this.hits + this.misses
    return {
      hits: this.hits,
      misses: this.misses,
      hitRate: lookups > 0 ? this.hits / lookups : 0,
      allocations: this.allocations,
      recycled: this.recycledCount,
      evictions: this.evictions,
      tiles: this.tiles.size,
      pending: this.pendingCount,
      pinned: this.pinnedCount,
      liveBytes: this.liveBytes,
      pooledBytes: this.pool.length * this.bytesPerTile,
      residentBytes: this.residentBytes(),
      budgetBytes: this.budgetBytes,
      occupancy: this.budgetBytes > 0 ? this.residentBytes() / this.budgetBytes : 0,
      generation: this.currentGeneration,
    }
  }

  resetStats(): void {
    this.hits = 0
    this.misses = 0
    this.allocations = 0
    this.recycledCount = 0
    this.evictions = 0
  }

  /** Live tiles, for diagnostics and tests. */
  entries(): IterableIterator<[TileId, CompositedTile]> {
    return this.tiles.entries()
  }

  keysAtLevel(level: number): TileKey[] {
    const ids = this.byLevel.get(level)
    if (!ids) return []
    return [...ids].map(tileKeyOf)
  }

  dispose(): void {
    for (const t of this.tiles.values()) this.device.deleteTexture(t.texture)
    this.tiles.clear()
    this.byLevel.clear()
    while (this.pool.length > 0) {
      const tex = this.pool.pop()
      if (tex) this.device.deleteTexture(tex)
    }
    this.liveBytes = 0
    this.pinnedCount = 0
    this.pendingCount = 0
  }

  private levelSet(level: number): Set<TileId> {
    let s = this.byLevel.get(level)
    if (!s) {
      s = new Set()
      this.byLevel.set(level, s)
    }
    return s
  }
}
