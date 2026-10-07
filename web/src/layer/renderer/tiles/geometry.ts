// Tile geometry primitives for the Layer renderer (stage 2 — tiling).
//
// Two grids, deliberately different sizes:
//   - CHUNK_SIZE (32) is the *invalidation* grid. A brush dab only ever dirties a
//     handful of 32x32 chunks, so a stroke never invalidates a whole tile.
//   - TILE_SIZE (256) is the *render / cache / LOD* grid. It is the unit of
//     texture allocation, of eviction and of pyramid reduction.
//
// This split follows GIMP, which aligns invalidation regions on a fine grid
// (GIMP_PROJECTION_UPDATE_CHUNK_WIDTH/HEIGHT = 32, app/core/gimpprojection.c)
// while letting the actual render chunks be much coarser
// (MAX_CHUNK_WIDTH/HEIGHT, app/core/gimpchunkiterator.c). GIMP is GPLv3; this is
// a reimplementation of the published design, not a copy of its code.
//
// This module is pure arithmetic: no WebGL, no DOM, no React.

/** Half-open rectangle in pixels: [x0,x1) x [y0,y1). */
export interface Rect {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** Render / cache / LOD granularity, in texels. */
export const TILE_SIZE = 256
/** Invalidation granularity, in pixels. */
export const CHUNK_SIZE = 32
/** Number of invalidation chunks along one tile axis (8). */
export const CHUNKS_PER_TILE_AXIS = TILE_SIZE / CHUNK_SIZE
/** Number of invalidation chunks inside one tile (64). */
export const CHUNKS_PER_TILE = CHUNKS_PER_TILE_AXIS * CHUNKS_PER_TILE_AXIS

/** Highest LOD level addressable by a packed TileId (4 bits). */
export const MAX_TILE_LEVEL = 15
/** Highest tile index addressable by a packed TileId (14 bits). */
export const MAX_TILE_INDEX = 0x3fff

// ── Rect algebra ────────────────────────────────────────────────────────────

export const makeRect = (x0: number, y0: number, x1: number, y1: number): Rect => ({ x0, y0, x1, y1 })

export const rectFromSize = (x: number, y: number, w: number, h: number): Rect =>
  ({ x0: x, y0: y, x1: x + w, y1: y + h })

export const rectIsEmpty = (r: Rect | null | undefined): boolean =>
  !r || r.x1 <= r.x0 || r.y1 <= r.y0

export const rectWidth = (r: Rect): number => Math.max(0, r.x1 - r.x0)
export const rectHeight = (r: Rect): number => Math.max(0, r.y1 - r.y0)
export const rectArea = (r: Rect | null): number => (r ? rectWidth(r) * rectHeight(r) : 0)

export const rectClone = (r: Rect): Rect => ({ x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1 })

export const rectEquals = (a: Rect | null, b: Rect | null): boolean => {
  if (a === b) return true
  if (!a || !b) return false
  return a.x0 === b.x0 && a.y0 === b.y0 && a.x1 === b.x1 && a.y1 === b.y1
}

/** Union of two rects; null operands are treated as "nothing". */
export function rectUnion(a: Rect | null, b: Rect | null): Rect | null {
  if (rectIsEmpty(a)) return b && !rectIsEmpty(b) ? rectClone(b) : null
  if (rectIsEmpty(b)) return rectClone(a as Rect)
  const x = a as Rect
  const y = b as Rect
  return {
    x0: Math.min(x.x0, y.x0),
    y0: Math.min(x.y0, y.y0),
    x1: Math.max(x.x1, y.x1),
    y1: Math.max(x.y1, y.y1),
  }
}

/** Intersection, or null when the rects do not overlap. */
export function rectIntersect(a: Rect | null, b: Rect | null): Rect | null {
  if (rectIsEmpty(a) || rectIsEmpty(b)) return null
  const x = a as Rect
  const y = b as Rect
  const r: Rect = {
    x0: Math.max(x.x0, y.x0),
    y0: Math.max(x.y0, y.y0),
    x1: Math.min(x.x1, y.x1),
    y1: Math.min(x.y1, y.y1),
  }
  return rectIsEmpty(r) ? null : r
}

export const rectIntersects = (a: Rect | null, b: Rect | null): boolean =>
  rectIntersect(a, b) !== null

/** True when `outer` fully covers `inner` (an empty `inner` is always covered). */
export function rectContains(outer: Rect | null, inner: Rect | null): boolean {
  if (rectIsEmpty(inner)) return true
  if (rectIsEmpty(outer)) return false
  const o = outer as Rect
  const i = inner as Rect
  return i.x0 >= o.x0 && i.y0 >= o.y0 && i.x1 <= o.x1 && i.y1 <= o.y1
}

export function rectContainsPoint(r: Rect | null, x: number, y: number): boolean {
  if (rectIsEmpty(r)) return false
  const q = r as Rect
  return x >= q.x0 && x < q.x1 && y >= q.y0 && y < q.y1
}

/** Grow (margin > 0) or shrink (margin < 0) a rect on every side. */
export function rectInflate(r: Rect, margin: number): Rect {
  return { x0: r.x0 - margin, y0: r.y0 - margin, x1: r.x1 + margin, y1: r.y1 + margin }
}

/** Snap outwards to a multiple of `grid`. Used to align dirty rects on chunks. */
export function rectAlignOut(r: Rect, grid: number): Rect {
  return {
    x0: Math.floor(r.x0 / grid) * grid,
    y0: Math.floor(r.y0 / grid) * grid,
    x1: Math.ceil(r.x1 / grid) * grid,
    y1: Math.ceil(r.y1 / grid) * grid,
  }
}

/** Snap inwards to a multiple of `grid`; null when nothing survives. */
export function rectAlignIn(r: Rect, grid: number): Rect | null {
  const out: Rect = {
    x0: Math.ceil(r.x0 / grid) * grid,
    y0: Math.ceil(r.y0 / grid) * grid,
    x1: Math.floor(r.x1 / grid) * grid,
    y1: Math.floor(r.y1 / grid) * grid,
  }
  return rectIsEmpty(out) ? null : out
}

export function rectRound(r: Rect): Rect {
  return {
    x0: Math.floor(r.x0),
    y0: Math.floor(r.y0),
    x1: Math.ceil(r.x1),
    y1: Math.ceil(r.y1),
  }
}

/**
 * a \ b, expressed as at most four disjoint rects (top, bottom, left, right).
 * Returning a small rect list instead of a general region keeps subtraction
 * allocation-bounded, which matters inside a frame budget.
 */
export function rectSubtract(a: Rect, b: Rect | null): Rect[] {
  const i = rectIntersect(a, b)
  if (!i) return rectIsEmpty(a) ? [] : [rectClone(a)]
  const out: Rect[] = []
  if (i.y0 > a.y0) out.push({ x0: a.x0, y0: a.y0, x1: a.x1, y1: i.y0 })
  if (i.y1 < a.y1) out.push({ x0: a.x0, y0: i.y1, x1: a.x1, y1: a.y1 })
  if (i.x0 > a.x0) out.push({ x0: a.x0, y0: i.y0, x1: i.x0, y1: i.y1 })
  if (i.x1 < a.x1) out.push({ x0: i.x1, y0: i.y0, x1: a.x1, y1: i.y1 })
  return out
}

/** Level 0 rect -> level L rect, rounded OUTWARDS (never loses a dirty pixel). */
export function rectScaleDown(r: Rect, level: number): Rect {
  if (level <= 0) return rectClone(r)
  const s = 1 << level
  return {
    x0: Math.floor(r.x0 / s),
    y0: Math.floor(r.y0 / s),
    x1: Math.ceil(r.x1 / s),
    y1: Math.ceil(r.y1 / s),
  }
}

/** Level L rect -> level 0 rect. */
export function rectScaleUp(r: Rect, level: number): Rect {
  if (level <= 0) return rectClone(r)
  const s = 1 << level
  return { x0: r.x0 * s, y0: r.y0 * s, x1: r.x1 * s, y1: r.y1 * s }
}

// ── Tile addressing ─────────────────────────────────────────────────────────

/** Tile address: level 0 = full resolution, level L = 2^L document pixels per texel. */
export interface TileKey {
  level: number
  tx: number
  ty: number
}

/**
 * Packed tile key: level (4 bits) | ty (14 bits) | tx (14 bits).
 *
 * A packed number avoids one string allocation per Map lookup. At ~4000 tile
 * lookups per composited viewport, a `${level}:${tx}:${ty}` key would allocate
 * 4000 strings per frame, which is exactly the kind of steady garbage that
 * shows up as GC pauses under a CPU-throttled profile.
 */
export type TileId = number

export const tileId = (level: number, tx: number, ty: number): TileId =>
  ((((level & 0xf) << 28) | ((ty & MAX_TILE_INDEX) << 14) | (tx & MAX_TILE_INDEX)) >>> 0)

export const keyId = (k: TileKey): TileId => tileId(k.level, k.tx, k.ty)
export const tileIdLevel = (id: TileId): number => (id >>> 28) & 0xf
export const tileIdTy = (id: TileId): number => (id >>> 14) & MAX_TILE_INDEX
export const tileIdTx = (id: TileId): number => id & MAX_TILE_INDEX
export const tileKeyOf = (id: TileId): TileKey =>
  ({ level: tileIdLevel(id), tx: tileIdTx(id), ty: tileIdTy(id) })

export const tileKeyEquals = (a: TileKey, b: TileKey): boolean =>
  a.level === b.level && a.tx === b.tx && a.ty === b.ty

/** Document pixels covered by one texel at `level`. */
export const texelSpan = (level: number): number => 1 << level
/** Document pixels covered by one tile axis at `level`. */
export const tileSpan = (level: number): number => TILE_SIZE << level

/** Document-space rect covered by a tile (unclamped by the document size). */
export function tileDocRect(k: TileKey): Rect {
  const span = tileSpan(k.level)
  return { x0: k.tx * span, y0: k.ty * span, x1: (k.tx + 1) * span, y1: (k.ty + 1) * span }
}

/** Rect covered by a tile expressed in level-L pixel coordinates. */
export function tileLevelRect(k: TileKey): Rect {
  return {
    x0: k.tx * TILE_SIZE,
    y0: k.ty * TILE_SIZE,
    x1: (k.tx + 1) * TILE_SIZE,
    y1: (k.ty + 1) * TILE_SIZE,
  }
}

/** Half-open range of tile indices. */
export interface TileRange {
  tx0: number
  ty0: number
  tx1: number
  ty1: number
}

/** Tile indices covering a document-space rect at `level`; null when empty. */
export function tileRangeForRect(r: Rect | null, level: number): TileRange | null {
  if (rectIsEmpty(r)) return null
  const q = r as Rect
  const span = tileSpan(level)
  const range: TileRange = {
    tx0: Math.max(0, Math.floor(q.x0 / span)),
    ty0: Math.max(0, Math.floor(q.y0 / span)),
    tx1: Math.min(MAX_TILE_INDEX + 1, Math.ceil(q.x1 / span)),
    ty1: Math.min(MAX_TILE_INDEX + 1, Math.ceil(q.y1 / span)),
  }
  if (range.tx1 <= range.tx0 || range.ty1 <= range.ty0) return null
  return range
}

export function tileRangeCount(range: TileRange | null): number {
  if (!range) return 0
  return (range.tx1 - range.tx0) * (range.ty1 - range.ty0)
}

/** Number of tiles covering a document rect at `level`. */
export const tileCountForRect = (r: Rect | null, level: number): number =>
  tileRangeCount(tileRangeForRect(r, level))

export function* tileKeysForRect(r: Rect | null, level: number): Generator<TileKey> {
  const range = tileRangeForRect(r, level)
  if (!range) return
  for (let ty = range.ty0; ty < range.ty1; ty++) {
    for (let tx = range.tx0; tx < range.tx1; tx++) yield { level, tx, ty }
  }
}

/** Tiles needed to cover a document axis of `docSize` pixels at `level`. */
export const tilesAcross = (docSize: number, level: number): number =>
  Math.max(1, Math.ceil(docSize / tileSpan(level)))

/** Size of one axis of the document at `level`, in level-L pixels. */
export const levelSize = (docSize: number, level: number): number =>
  Math.max(1, Math.ceil(docSize / texelSpan(level)))
