// Structural interfaces the composition stage (étage 3) needs from the stages
// below it (étage 4 `gl/`, étage 2 `tiles/`).
//
// WHY THIS FILE EXISTS
// --------------------
// Spec 09-rendu §2.1 states the golden rule: dependencies never point upwards.
// `GLDevice` knows nothing about layers, `CompositeGraph` knows nothing about
// tiling. §11.4 then splits the engine into lots that are built in parallel, on
// the sole condition that the interfaces are frozen first.
//
// The composition stage therefore depends on *structural types declared here*,
// never on a concrete class from `gl/` or `tiles/`. Two consequences:
//
//   1. This folder compiles and is fully unit-testable on its own, against test
//      doubles (see `graph-tests/`), before `gl/` and `tiles/` exist.
//   2. When the real `GLDevice` / `TileCache` land, they satisfy these
//      interfaces structurally — TypeScript checks the fit at the wiring point
//      (`Renderer.create`), not here.
//
// Everything below is deliberately minimal: only what the graph actually calls.

// ---------------------------------------------------------------------------
// Geometry — a local mirror of `tiles/geometry.ts` (spec §3.2)
// ---------------------------------------------------------------------------

/** Half-open rectangle in document pixels: [x0,x1) x [y0,y1). */
export interface Rect {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** Render / cache granularity (spec §3.1). */
export const TILE_SIZE = 256
/** Invalidation granularity — 8x8 chunks per tile (spec §3.1). */
export const CHUNK_SIZE = 32

/** Tile address: level 0 = full resolution, level L = 2^L doc pixels per texel. */
export interface TileKey {
  level: number
  tx: number
  ty: number
}

export const rect = (x0: number, y0: number, x1: number, y1: number): Rect => ({ x0, y0, x1, y1 })

export const rectIsEmpty = (r: Rect | null): boolean => !r || r.x1 <= r.x0 || r.y1 <= r.y0

export function rectIntersects(a: Rect | null, b: Rect | null): boolean {
  if (!a || !b) return false
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1
}

export function rectUnion(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b ? { ...b } : null
  if (!b) return { ...a }
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  }
}

export function rectIntersection(a: Rect | null, b: Rect | null): Rect | null {
  if (!a || !b) return null
  const r = {
    x0: Math.max(a.x0, b.x0),
    y0: Math.max(a.y0, b.y0),
    x1: Math.min(a.x1, b.x1),
    y1: Math.min(a.y1, b.y1),
  }
  return rectIsEmpty(r) ? null : r
}

/** Document-space rect covered by a tile at `key`. */
export function tileRect(key: TileKey, tileSize = TILE_SIZE): Rect {
  const span = tileSize << key.level
  const x0 = key.tx * span
  const y0 = key.ty * span
  return { x0, y0, x1: x0 + span, y1: y0 + span }
}

// ---------------------------------------------------------------------------
// Étage 4 — GPU abstraction (`gl/`, spec §11.2)
// ---------------------------------------------------------------------------

/** Spec §4.5. Working space is linear premultiplied; `rgba8` is the fallback. */
export type WorkingFormat = 'rgba16f' | 'rgba32f' | 'rgba8'

/** Bytes per texel, used for VRAM accounting of the register file. */
export const BYTES_PER_TEXEL: Record<WorkingFormat, number> = {
  rgba16f: 8,
  rgba32f: 16,
  rgba8: 4,
}

export interface GLCapsLike {
  /** Format actually probed as renderable — never assumed (spec §4.5). */
  readonly working: WorkingFormat
  /** `EXT_float_blend`: hardware blending onto a float render target. */
  readonly floatBlend: boolean
  readonly maxTextureSize: number
  /**
   * Texture units a single fragment shader may sample. Caps how many layers a
   * fused "run of normals" pass may swallow (spec §7.1, "jusqu'à 8").
   */
  readonly maxFragmentTextureUnits: number
}

/** A linked program with a uniform-location cache (port of the current l.213-218). */
export interface ProgramLike {
  use(): void
  setInt(name: string, v: number): void
  setUint(name: string, v: number): void
  setFloat(name: string, v: number): void
  setVec2(name: string, x: number, y: number): void
  setVec4(name: string, x: number, y: number, z: number, w: number): void
  /** Bind `tex` to texture unit `unit` and point sampler `name` at that unit. */
  setTexture(name: string, unit: number, tex: WebGLTexture | null): void
}

/** A colour-renderable texture plus its cached framebuffer. */
export interface RenderTargetLike {
  readonly texture: WebGLTexture
  readonly framebuffer: WebGLFramebuffer
  readonly width: number
  readonly height: number
  readonly format: WorkingFormat
}

/**
 * Fixed-function blend state, premultiplied convention.
 * `null` passed to `setBlend` disables blending entirely (replace).
 */
export interface BlendState {
  srcRGB: number
  dstRGB: number
  srcAlpha: number
  dstAlpha: number
  equationRGB: number
  equationAlpha: number
}

/**
 * The slice of `GLDevice` the composition stage uses. Intentionally small: any
 * method added here becomes an obligation for the `gl/` lot.
 */
export interface GLDeviceLike {
  readonly gl: WebGL2RenderingContext
  readonly caps: GLCapsLike
  /** True between `webglcontextlost` and `webglcontextrestored` (spec §10.5). */
  readonly isLost: boolean

  /**
   * Compile+link once per `key`, then return the cached program. `key` must
   * fully determine the source, so callers hash their `#define` permutation
   * into it. Returns null on compile failure — the graph then skips the pass
   * rather than throwing inside a frame.
   */
  program(key: string, vertex: string, fragment: string): ProgramLike | null

  /** Recycled tile-sized render target. Contents are undefined on acquire. */
  acquireTarget(width: number, height: number, format?: WorkingFormat): RenderTargetLike
  releaseTarget(t: RenderTargetLike): void

  /** `null` binds the default framebuffer (the canvas). */
  bindTarget(t: RenderTargetLike | null): void
  setViewport(x: number, y: number, width: number, height: number): void
  /** Rect is in target-local pixels, y-up as GL expects; `null` disables scissor. */
  setScissor(r: Rect | null): void
  setBlend(b: BlendState | null): void
  clear(r: number, g: number, b: number, a: number): void
  /** Draws the single shared fullscreen-quad VAO (spec §11.2 `gl/quad.ts`). */
  drawQuad(): void

  /** PBO + fenceSync readback (spec §8.5). Never blocks the main thread. */
  readPixelsAsync(t: RenderTargetLike, r: Rect): Promise<Float32Array | Uint8Array>
  /**
   * Synchronous readback. Allowed for the eyedropper only (1 texel, spec §8.5
   * "exception assumée") and for tests.
   */
  readPixelsSync(t: RenderTargetLike, r: Rect): Float32Array | Uint8Array
}

// ---------------------------------------------------------------------------
// Étage 2 — tiling (`tiles/`, spec §3)
// ---------------------------------------------------------------------------

export interface DirtyRegionLike {
  invalidate(r: Rect): void
  invalidateAll(): void
  isDirty(): boolean
  clear(r: Rect): void
  /** Chunk-aligned dirty rect restricted to one tile, in doc pixels, or null. */
  dirtyInTile(key: TileKey): Rect | null
  dirtyTiles(order?: (a: TileKey, b: TileKey) => number): Iterable<TileKey>
}

export interface CompositedTileLike {
  key: TileKey
  texture: WebGLTexture
  generation: number
  dirty: Rect | null
  lastUsed: number
  pending: boolean
}

export interface TileCacheLike {
  get(key: TileKey): CompositedTileLike | undefined
  acquire(key: TileKey): CompositedTileLike
  touch(key: TileKey): void
  trim(): void
  invalidate(r: Rect): void
  dispose(): void
}

/**
 * Read-only view of per-layer pixel storage (`tiles/LayerTileStore.ts`).
 * The graph only ever *reads* layer pixels; writes go through the Renderer
 * façade, which owns the stores.
 */
export interface LayerSourceLike {
  /** Layer tile at `key`, or null when the layer is transparent there. */
  tileAt(layerId: string, key: TileKey): WebGLTexture | null
  /** Mask tile (single channel in `.r`), or null when absent/empty. */
  maskTileAt(maskLayerId: string, key: TileKey): WebGLTexture | null
  /** Non-empty bounding box in document pixels, or null for an empty layer. */
  bboxOf(layerId: string): Rect | null
  /** Coarsest LOD level built for a layer — the thumbnail pass starts there. */
  coarsestLevel(layerId: string): number
}

export type PixelFormat = 'rgba8-srgb' | 'rgba8-linear' | 'rgba16f-linear' | 'rgba32f-linear'

/**
 * Write side of layer storage. The graph never uses it — only the Renderer
 * façade does, to satisfy `writeLayerRect` / `readLayerRect`.
 */
export interface LayerStoreLike extends LayerSourceLike {
  writeRect(layerId: string, r: Rect, px: ArrayBufferView, fmt: PixelFormat): void
  readRect(layerId: string, r: Rect, fmt: PixelFormat): Promise<ArrayBufferView>
  /** Tiles this layer owns, coarsest level first — the thumbnail source. */
  tilesOf(layerId: string, level: number): TileKey[]
  dispose(): void
}

export interface RenderBudget {
  msPerFrame: number
  maxTilesPerFrame: number
}

export interface ViewportLike {
  width: number
  height: number
  dpr: number
  zoom: number
  panX: number
  panY: number
  rotation: number
}

export interface TileSchedulerLike {
  plan(viewport: ViewportLike, dirty: DirtyRegionLike, budget: RenderBudget): TileKey[]
}
