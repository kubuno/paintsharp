// Chunk-aligned dirty-region tracker.
//
// Mirrors GIMP's GimpTileHandlerValidate, which keeps a cairo_region_t of the
// areas that still need validating (app/gegl/gimptilehandlervalidate.h), and
// GimpProjection, which aligns every invalidation on a 32px grid before queuing
// it (GIMP_PROJECTION_UPDATE_CHUNK_WIDTH/HEIGHT, app/core/gimpprojection.c).
// GIMP is GPLv3; this is a reimplementation of the published design, not a copy.
//
// We use a fixed-pitch bitset instead of an exact region algebra. Rationale:
//   - `cairo_region_t` does exact rectangle union/subtraction, at the price of
//     allocations and of a cost that depends on how fragmented the region got.
//     Inside a frame budget, an unpredictable cost is worse than a slightly
//     imprecise one.
//   - Here the grid pitch is fixed and known, so union is a `|=` over a
//     Uint32Array: zero allocation, constant and predictable cost, and the
//     precision loss is bounded by CHUNK_SIZE (32px).
//   - Memory is negligible: a 4000x4000 document is 125x125 chunks = 1.9 KiB.
//
// Everything here is pure arithmetic — no WebGL, no DOM, no React.

import {
  CHUNK_SIZE,
  type Rect,
  type TileKey,
  rectIntersect,
  rectIsEmpty,
  tileDocRect,
  tileRangeForRect,
} from './geometry'

/** Bits [0,n) set. */
const lowMask = (n: number): number => (n >= 32 ? 0xffffffff : (((1 << n) >>> 0) - 1)) >>> 0
/** Bits [a,b) set. */
const rangeMask = (a: number, b: number): number => ((lowMask(b) & ~lowMask(a)) >>> 0)

function popcount32(v: number): number {
  let x = v - ((v >>> 1) & 0x55555555)
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333)
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24
}

export interface DirtyRegionStats {
  /** Chunks currently marked dirty. */
  dirtyChunks: number
  /** Total chunks in the grid. */
  totalChunks: number
  /** Exact number of document pixels covered by the dirty chunks (edges clamped). */
  dirtyPixels: number
  /** dirtyChunks / totalChunks. */
  coverage: number
}

export class DirtyRegion {
  readonly width: number
  readonly height: number
  readonly chunkSize: number
  readonly chunksX: number
  readonly chunksY: number

  private readonly bits: Uint32Array
  private setCount = 0
  private bboxCache: Rect | null = null
  private bboxValid = true

  constructor(width: number, height: number, chunkSize: number = CHUNK_SIZE) {
    this.width = Math.max(0, Math.floor(width))
    this.height = Math.max(0, Math.floor(height))
    this.chunkSize = chunkSize
    this.chunksX = Math.max(0, Math.ceil(this.width / chunkSize))
    this.chunksY = Math.max(0, Math.ceil(this.height / chunkSize))
    this.bits = new Uint32Array(Math.ceil((this.chunksX * this.chunksY) / 32) || 1)
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  isDirty(): boolean {
    return this.setCount > 0
  }

  dirtyChunkCount(): number {
    return this.setCount
  }

  totalChunkCount(): number {
    return this.chunksX * this.chunksY
  }

  isChunkDirty(cx: number, cy: number): boolean {
    if (cx < 0 || cy < 0 || cx >= this.chunksX || cy >= this.chunksY) return false
    const bit = cy * this.chunksX + cx
    return (this.bits[bit >>> 5] & (1 << (bit & 31))) !== 0
  }

  /** Chunk-aligned bounding box of everything dirty, clamped to the document. */
  bounds(): Rect | null {
    if (this.setCount === 0) return null
    if (!this.bboxValid) this.recomputeBounds()
    return this.bboxCache ? { ...this.bboxCache } : null
  }

  /**
   * Exact pixel area covered by the dirty chunks (partial edge chunks counted
   * at their real size). This is the number the tiling gain is measured with.
   */
  dirtyPixelArea(): number {
    if (this.setCount === 0) return 0
    let total = 0
    const cs = this.chunkSize
    for (let cy = 0; cy < this.chunksY; cy++) {
      const h = Math.min(cs, this.height - cy * cs)
      const base = cy * this.chunksX
      for (let cx = 0; cx < this.chunksX; cx++) {
        const bit = base + cx
        if ((this.bits[bit >>> 5] & (1 << (bit & 31))) === 0) continue
        total += Math.min(cs, this.width - cx * cs) * h
      }
    }
    return total
  }

  stats(): DirtyRegionStats {
    const total = this.totalChunkCount()
    return {
      dirtyChunks: this.setCount,
      totalChunks: total,
      dirtyPixels: this.dirtyPixelArea(),
      coverage: total > 0 ? this.setCount / total : 0,
    }
  }

  // ── Mutation ──────────────────────────────────────────────────────────────

  /** Mark `r` dirty. Rect is snapped outwards to the chunk grid. O(chunks touched). */
  invalidate(r: Rect | null): void {
    const c = this.chunkRange(r)
    if (!c) return
    for (let cy = c.cy0; cy < c.cy1; cy++) {
      const base = cy * this.chunksX
      this.orRange(base + c.cx0, base + c.cx1)
    }
    // The bbox only ever grows here, so it can be updated without a rescan.
    if (this.bboxValid) {
      const added: Rect = {
        x0: c.cx0 * this.chunkSize,
        y0: c.cy0 * this.chunkSize,
        x1: Math.min(this.width, c.cx1 * this.chunkSize),
        y1: Math.min(this.height, c.cy1 * this.chunkSize),
      }
      this.bboxCache = this.bboxCache
        ? {
            x0: Math.min(this.bboxCache.x0, added.x0),
            y0: Math.min(this.bboxCache.y0, added.y0),
            x1: Math.max(this.bboxCache.x1, added.x1),
            y1: Math.max(this.bboxCache.y1, added.y1),
          }
        : added
    }
  }

  invalidateAll(): void {
    this.invalidate({ x0: 0, y0: 0, x1: this.width, y1: this.height })
  }

  /** Clear `r` (or everything when omitted). Rect is snapped INWARDS: a chunk is
   *  only cleared when it is fully covered, so a partial clear never drops work. */
  clear(r?: Rect | null): void {
    if (r === undefined) return this.clearAll()
    if (!r) return
    const c = this.chunkRangeInner(r)
    if (!c) return
    for (let cy = c.cy0; cy < c.cy1; cy++) {
      const base = cy * this.chunksX
      this.andNotRange(base + c.cx0, base + c.cx1)
    }
    this.bboxValid = false
  }

  clearAll(): void {
    if (this.setCount === 0) return
    this.bits.fill(0)
    this.setCount = 0
    this.bboxCache = null
    this.bboxValid = true
  }

  /** Clear exactly the chunks of one tile — the normal "tile rebuilt" path. */
  clearTile(key: TileKey): void {
    this.clear(tileDocRect(key))
  }

  /** In-place union with another region of the same geometry. */
  union(other: DirtyRegion): void {
    if (other.chunksX !== this.chunksX || other.chunksY !== this.chunksY) {
      throw new Error('DirtyRegion.union: mismatched geometry')
    }
    for (let w = 0; w < this.bits.length; w++) this.orWord(w, other.bits[w])
    this.bboxValid = false
  }

  /** a \ b, in place. */
  subtract(other: DirtyRegion): void {
    if (other.chunksX !== this.chunksX || other.chunksY !== this.chunksY) {
      throw new Error('DirtyRegion.subtract: mismatched geometry')
    }
    for (let w = 0; w < this.bits.length; w++) this.andNotWord(w, other.bits[w])
    this.bboxValid = false
  }

  clone(): DirtyRegion {
    const c = new DirtyRegion(this.width, this.height, this.chunkSize)
    c.bits.set(this.bits)
    c.setCount = this.setCount
    c.bboxValid = false
    return c
  }

  // ── Tile-oriented queries ─────────────────────────────────────────────────

  /**
   * Chunk-aligned dirty rect inside `r`, in document pixels, or null when clean.
   * This is what a tile rebuild scissors to — the whole point of the fine grid.
   */
  dirtyInRect(r: Rect | null): Rect | null {
    const c = this.chunkRange(r)
    if (!c || this.setCount === 0) return null
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (let cy = c.cy0; cy < c.cy1; cy++) {
      const base = cy * this.chunksX
      let rowHit = false
      for (let cx = c.cx0; cx < c.cx1; cx++) {
        const bit = base + cx
        if ((this.bits[bit >>> 5] & (1 << (bit & 31))) === 0) continue
        if (cx < x0) x0 = cx
        if (cx + 1 > x1) x1 = cx + 1
        rowHit = true
      }
      if (rowHit) {
        if (cy < y0) y0 = cy
        if (cy + 1 > y1) y1 = cy + 1
      }
    }
    if (x1 < 0) return null
    const out: Rect = {
      x0: x0 * this.chunkSize,
      y0: y0 * this.chunkSize,
      x1: Math.min(this.width, x1 * this.chunkSize),
      y1: Math.min(this.height, y1 * this.chunkSize),
    }
    // Never report dirt outside the requested rect.
    return rectIntersect(out, r)
  }

  /** Chunk-aligned dirty rect restricted to one tile, in document pixels. */
  dirtyInTile(key: TileKey): Rect | null {
    return this.dirtyInRect(tileDocRect(key))
  }

  hasDirtyIn(r: Rect | null): boolean {
    const c = this.chunkRange(r)
    if (!c || this.setCount === 0) return false
    for (let cy = c.cy0; cy < c.cy1; cy++) {
      const base = cy * this.chunksX
      for (let cx = c.cx0; cx < c.cx1; cx++) {
        const bit = base + cx
        if ((this.bits[bit >>> 5] & (1 << (bit & 31))) !== 0) return true
      }
    }
    return false
  }

  /**
   * Tiles touched by the dirty region, at `level`. Tile indices are computed in
   * document space, so this works for every LOD level with one code path.
   * `order` is an optional comparator (the scheduler passes a viewport-centred one).
   */
  dirtyTiles(level = 0, order?: (a: TileKey, b: TileKey) => number, within?: Rect | null): TileKey[] {
    const out: TileKey[] = []
    if (this.setCount === 0) return out
    const scope = within
      ? rectIntersect(this.bounds(), within)
      : this.bounds()
    const range = tileRangeForRect(scope, level)
    if (!range) return out
    for (let ty = range.ty0; ty < range.ty1; ty++) {
      for (let tx = range.tx0; tx < range.tx1; tx++) {
        const key: TileKey = { level, tx, ty }
        if (this.hasDirtyIn(tileDocRect(key))) out.push(key)
      }
    }
    if (order) out.sort(order)
    return out
  }

  /**
   * Coalesced dirty rectangles, in document pixels.
   *
   * Rows of set chunks are merged into horizontal runs, then vertically adjacent
   * runs with identical extents are merged into one rect. Without this, a long
   * diagonal stroke would produce one rect per chunk and the caller would issue
   * hundreds of tiny scissored draws — the fragmentation this method exists to
   * avoid.
   */
  dirtyRects(): Rect[] {
    const out: Rect[] = []
    if (this.setCount === 0) return out
    const cs = this.chunkSize
    // Runs still open from the previous row, keyed by their horizontal extent.
    let open: Rect[] = []
    for (let cy = 0; cy < this.chunksY; cy++) {
      const runs = this.rowRuns(cy)
      const next: Rect[] = []
      let oi = 0
      for (const run of runs) {
        // Advance over open runs that ended before this one starts.
        while (oi < open.length && open[oi].x1 < run.x0) {
          out.push(open[oi])
          oi++
        }
        const cand = oi < open.length ? open[oi] : null
        if (cand && cand.x0 === run.x0 && cand.x1 === run.x1) {
          cand.y1 = (cy + 1) * cs
          next.push(cand)
          oi++
        } else {
          next.push({ x0: run.x0, y0: cy * cs, x1: run.x1, y1: (cy + 1) * cs })
        }
      }
      for (; oi < open.length; oi++) out.push(open[oi])
      open = next
    }
    for (const r of open) out.push(r)
    // Clamp the last column/row of chunks to the real document size.
    for (const r of out) {
      if (r.x1 > this.width) r.x1 = this.width
      if (r.y1 > this.height) r.y1 = this.height
    }
    return out.filter(r => !rectIsEmpty(r))
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /** Horizontal runs of set chunks in row `cy`, expressed in document pixels. */
  private rowRuns(cy: number): { x0: number; x1: number }[] {
    const runs: { x0: number; x1: number }[] = []
    const base = cy * this.chunksX
    let start = -1
    for (let cx = 0; cx < this.chunksX; cx++) {
      const bit = base + cx
      const on = (this.bits[bit >>> 5] & (1 << (bit & 31))) !== 0
      if (on && start < 0) start = cx
      else if (!on && start >= 0) {
        runs.push({ x0: start * this.chunkSize, x1: cx * this.chunkSize })
        start = -1
      }
    }
    if (start >= 0) runs.push({ x0: start * this.chunkSize, x1: this.chunksX * this.chunkSize })
    return runs
  }

  /** Chunk range covering `r`, snapped outwards and clamped to the grid. */
  private chunkRange(r: Rect | null): { cx0: number; cy0: number; cx1: number; cy1: number } | null {
    if (rectIsEmpty(r) || this.chunksX === 0 || this.chunksY === 0) return null
    const q = r as Rect
    const cs = this.chunkSize
    const cx0 = Math.max(0, Math.floor(q.x0 / cs))
    const cy0 = Math.max(0, Math.floor(q.y0 / cs))
    const cx1 = Math.min(this.chunksX, Math.ceil(q.x1 / cs))
    const cy1 = Math.min(this.chunksY, Math.ceil(q.y1 / cs))
    if (cx1 <= cx0 || cy1 <= cy0) return null
    return { cx0, cy0, cx1, cy1 }
  }

  /** Chunk range fully inside `r`, snapped inwards. */
  private chunkRangeInner(r: Rect): { cx0: number; cy0: number; cx1: number; cy1: number } | null {
    if (rectIsEmpty(r) || this.chunksX === 0 || this.chunksY === 0) return null
    const cs = this.chunkSize
    // A chunk on the right/bottom edge is fully covered as soon as the rect
    // reaches the document edge, even if it stops short of the chunk boundary.
    const cx0 = Math.max(0, Math.ceil(r.x0 / cs))
    const cy0 = Math.max(0, Math.ceil(r.y0 / cs))
    const cx1 = Math.min(this.chunksX, r.x1 >= this.width ? this.chunksX : Math.floor(r.x1 / cs))
    const cy1 = Math.min(this.chunksY, r.y1 >= this.height ? this.chunksY : Math.floor(r.y1 / cs))
    if (cx1 <= cx0 || cy1 <= cy0) return null
    return { cx0, cy0, cx1, cy1 }
  }

  private orRange(from: number, to: number): void {
    if (to <= from) return
    const w0 = from >>> 5
    const w1 = (to - 1) >>> 5
    if (w0 === w1) {
      this.orWord(w0, rangeMask(from & 31, ((to - 1) & 31) + 1))
      return
    }
    this.orWord(w0, rangeMask(from & 31, 32))
    for (let w = w0 + 1; w < w1; w++) this.orWord(w, 0xffffffff)
    this.orWord(w1, rangeMask(0, ((to - 1) & 31) + 1))
  }

  private andNotRange(from: number, to: number): void {
    if (to <= from) return
    const w0 = from >>> 5
    const w1 = (to - 1) >>> 5
    if (w0 === w1) {
      this.andNotWord(w0, rangeMask(from & 31, ((to - 1) & 31) + 1))
      return
    }
    this.andNotWord(w0, rangeMask(from & 31, 32))
    for (let w = w0 + 1; w < w1; w++) this.andNotWord(w, 0xffffffff)
    this.andNotWord(w1, rangeMask(0, ((to - 1) & 31) + 1))
  }

  private orWord(w: number, mask: number): void {
    const old = this.bits[w]
    const next = (old | mask) >>> 0
    if (next === old) return
    this.setCount += popcount32((next & ~old) >>> 0)
    this.bits[w] = next
  }

  private andNotWord(w: number, mask: number): void {
    const old = this.bits[w]
    const next = (old & ~mask) >>> 0
    if (next === old) return
    this.setCount -= popcount32((old & ~next) >>> 0)
    this.bits[w] = next
  }

  private recomputeBounds(): void {
    this.bboxValid = true
    if (this.setCount === 0) {
      this.bboxCache = null
      return
    }
    let cx0 = this.chunksX
    let cy0 = this.chunksY
    let cx1 = 0
    let cy1 = 0
    for (let cy = 0; cy < this.chunksY; cy++) {
      const base = cy * this.chunksX
      let rowHit = false
      for (let cx = 0; cx < this.chunksX; cx++) {
        const bit = base + cx
        if ((this.bits[bit >>> 5] & (1 << (bit & 31))) === 0) continue
        if (cx < cx0) cx0 = cx
        if (cx + 1 > cx1) cx1 = cx + 1
        rowHit = true
      }
      if (rowHit) {
        if (cy < cy0) cy0 = cy
        if (cy + 1 > cy1) cy1 = cy + 1
      }
    }
    this.bboxCache = {
      x0: cx0 * this.chunkSize,
      y0: cy0 * this.chunkSize,
      x1: Math.min(this.width, cx1 * this.chunkSize),
      y1: Math.min(this.height, cy1 * this.chunkSize),
    }
  }
}
