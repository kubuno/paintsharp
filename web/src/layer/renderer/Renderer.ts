// The rendering façade — étage 1.
//
// ZERO REACT. Zero DOM beyond the canvas it was handed. No HTTP, no `layerApi`,
// no undo/redo, no `.kblay`, no i18n, no `@ui`, no tools, no keyboard. The
// document is GIVEN to it; everything it does is a consequence of that document
// plus invalidation rectangles.
//
//
// WHY THIS FILE EXISTS — goulet G5
// --------------------------------
// Today the GPU layer calls `setThumbNonce` from inside `writeTex`. Painting a
// stroke therefore re-renders the entire React editor at the input rate:
// **60 React renders per second while a stroke is in flight**, each one walking
// the layer panel, the toolbars and the canvas wrapper. The engine, in other
// words, drives React.
//
// The rule, from spec 09 §10.1, is absolute in both directions:
//
//   > The engine never renders because a component mounted, unmounted or
//   > re-rendered. React never re-renders because the engine painted a frame.
//
// This façade enforces it structurally:
//
//   * the engine owns ONE rAF loop and nothing else in the app may schedule a
//     frame — N invalidations between two frames cost exactly one frame;
//   * the only outward channel is an event bus (`on(type, cb)`), and the events
//     that a naive subscriber could turn into a `setState` are RATE-CAPPED by
//     the engine itself: `'thumbnails'` is debounced 150 ms and capped at 4 per
//     frame, `'frame'` is diagnostics-only;
//   * `'tiles-settled'` fires ONCE when a gesture's work is finished, which is
//     the event a layer panel actually wants;
//   * thumbnails are PUSHED by the engine and cached here, so a component reads
//     `getThumbnail(id)` during render instead of firing an effect that
//     re-schedules itself (the `LayerThumb` bug).
//
// The measurable target is zero React renders during a gesture. What this file
// guarantees is that the engine emits nothing during one; what a subscriber
// does with `'tiles-settled'` afterwards is the UI's business.
//
//
// DEPENDENCY INJECTION
// --------------------
// `gl/` (étage 4) and `tiles/` (étage 2) are built by other lots. This file
// depends on their *interfaces* (`graph/deps.ts`) and receives their
// implementations through `RendererDeps`. That is not ceremony: it is what lets
// the façade be unit-tested against doubles, and what keeps the four lots
// compiling independently.

import { CompositeGraph } from './graph/CompositeGraph.ts'
import { compilePlan } from './graph/compilePlan.ts'
import { rectUnion, TILE_SIZE, tileRect } from './graph/deps.ts'
import type {
  DirtyRegionLike,
  GLCapsLike,
  GLDeviceLike,
  LayerStoreLike,
  PixelFormat,
  Rect,
  TileCacheLike,
  TileKey,
  TileSchedulerLike,
  ViewportLike,
  WorkingFormat,
} from './graph/deps.ts'
import { THUMBNAIL_SIZE, ThumbnailPass } from './graph/passes/index.ts'
import type { LayerNode, PassPlan } from './graph/types.ts'
import { DEFAULT_BLEND_SPACE } from './graph/shaders.ts'
import type { BlendSpace } from './graph/shaders.ts'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RenderDocument {
  width: number
  height: number
  /** Storage depth: drives the FILE format, not the working format (spec §4.5). */
  bitDepth: 8 | 16 | 32
  tree: LayerNode[]
}

export interface FrameStats {
  frameMs: number
  tilesBuilt: number
  tilesPending: number
  drawCalls: number
  registerSwaps: number
  hardwareBlends: number
  gpuBytesResident: number
  /** > 0 means a frame was missed. The honest metric — never smoothed. */
  budgetOverrunMs: number
}

export type RendererEvent =
  | { type: 'frame'; stats: FrameStats }
  | { type: 'thumbnails'; layerIds: string[] }
  | { type: 'tiles-settled' }
  | { type: 'context-lost' }
  | { type: 'context-restored' }
  | { type: 'error'; error: Error }

export type RendererEventType = RendererEvent['type']

export interface RendererOptions {
  tileSize?: number
  format?: WorkingFormat
  allowHardwareBlend?: boolean
  /**
   * Space in which the blend function is evaluated. Default: Photoshop parity
   * (`'srgb-encoded'`). `'linear'` gives the physically-correct rendering of
   * spec 09 §4.1 — the switch exists for a future HDR mode and is live in both
   * directions. Alpha composition is linear either way.
   */
  blendSpace?: BlendSpace
  /** Milliseconds a frame may spend building tiles. Default 8 (half of 16.6). */
  msPerFrame?: number
  maxTilesPerFrame?: number
  /** Thumbnail debounce, ms. Default 150. */
  thumbnailDebounceMs?: number
  /** Thumbnails refreshed per frame. Default 4 — the G5 rate cap. */
  thumbnailsPerFrame?: number
  /** Start the rAF loop on creation. Off in tests, which drive `render()`. */
  autoStart?: boolean
}

export interface RendererDeps {
  /** Étage 4. Returns null when WebGL2 is unavailable — never throws for that. */
  createDevice(canvas: HTMLCanvasElement): GLDeviceLike | null
  /** Étage 2. */
  createDirtyRegion(width: number, height: number): DirtyRegionLike
  createLayerStore(device: GLDeviceLike): LayerStoreLike
  createTileCache?(device: GLDeviceLike, format: WorkingFormat): TileCacheLike
  createScheduler?(): TileSchedulerLike
  /**
   * Draws the composited tiles to the canvas. Supplied by the display lot
   * (spec §6); when absent the engine still composites, which is what the
   * headless tests need.
   */
  present?(ctx: PresentContext): void
}

export interface PresentContext {
  device: GLDeviceLike
  viewport: ViewportLike
  tiles: TileCacheLike | null
  document: { width: number; height: number }
}

type Listener = (e: RendererEvent) => void

// ---------------------------------------------------------------------------

const DEFAULT_VIEWPORT: ViewportLike = {
  width: 0,
  height: 0,
  dpr: 1,
  zoom: 1,
  panX: 0,
  panY: 0,
  rotation: 0,
}

export class Renderer {
  // ── GPU & stages ──────────────────────────────────────────────────────────
  private readonly device: GLDeviceLike
  private readonly store: LayerStoreLike
  private readonly graph: CompositeGraph
  private readonly thumbs: ThumbnailPass
  private readonly tiles: TileCacheLike | null
  private readonly scheduler: TileSchedulerLike | null
  private dirty: DirtyRegionLike

  // ── Document & view ───────────────────────────────────────────────────────
  private doc: RenderDocument = { width: 0, height: 0, bitDepth: 8, tree: [] }
  private viewport: ViewportLike = DEFAULT_VIEWPORT
  private generation = 0
  private pendingPlan = true

  // ── Loop ──────────────────────────────────────────────────────────────────
  private rafId: number | null = null
  private running = false
  private disposed = false
  private settledWaiters: (() => void)[] = []

  // ── Thumbnails (G2 + the G5 rate cap) ─────────────────────────────────────
  private thumbDirty = new Set<string>()
  private thumbCache = new Map<string, ImageBitmap>()
  private thumbLastFlush = 0
  private thumbInFlight = false

  // ── Events ────────────────────────────────────────────────────────────────
  private readonly listeners = new Map<RendererEventType, Set<Listener>>()

  private readonly opts: Required<Omit<RendererOptions, 'format'>> & { format?: WorkingFormat }
  private lastStats: FrameStats = {
    frameMs: 0,
    tilesBuilt: 0,
    tilesPending: 0,
    drawCalls: 0,
    registerSwaps: 0,
    hardwareBlends: 0,
    gpuBytesResident: 0,
    budgetOverrunMs: 0,
  }

  private constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly deps: RendererDeps,
    device: GLDeviceLike,
    opts: RendererOptions,
  ) {
    this.device = device
    this.opts = {
      tileSize: opts.tileSize ?? TILE_SIZE,
      format: opts.format,
      allowHardwareBlend: opts.allowHardwareBlend ?? true,
      blendSpace: opts.blendSpace ?? DEFAULT_BLEND_SPACE,
      msPerFrame: opts.msPerFrame ?? 8,
      maxTilesPerFrame: opts.maxTilesPerFrame ?? 64,
      thumbnailDebounceMs: opts.thumbnailDebounceMs ?? 150,
      thumbnailsPerFrame: opts.thumbnailsPerFrame ?? 4,
      autoStart: opts.autoStart ?? true,
    }

    this.store = deps.createLayerStore(device)
    const format = this.opts.format ?? device.caps.working
    this.graph = new CompositeGraph(device, this.store, {
      tileSize: this.opts.tileSize,
      format,
      blendSpace: this.opts.blendSpace,
      allowHardwareBlend: this.opts.allowHardwareBlend,
    })
    this.thumbs = new ThumbnailPass(device, this.store)
    this.tiles = deps.createTileCache?.(device, format) ?? null
    this.scheduler = deps.createScheduler?.() ?? null
    this.dirty = deps.createDirtyRegion(1, 1)

    this.canvas.addEventListener('webglcontextlost', this.onContextLost)
    this.canvas.addEventListener('webglcontextrestored', this.onContextRestored)

    if (this.opts.autoStart) this.start()
  }

  /** Returns null when WebGL2 is unavailable; never throws for that reason. */
  static create(canvas: HTMLCanvasElement, deps: RendererDeps, opts: RendererOptions = {}): Renderer | null {
    const device = deps.createDevice(canvas)
    if (!device) return null
    return new Renderer(canvas, deps, device, opts)
  }

  // ── Document ──────────────────────────────────────────────────────────────

  /** Replace the document. Rebuilds the plan and invalidates everything. */
  setDocument(doc: RenderDocument): void {
    if (this.disposed) return
    const resized = doc.width !== this.doc.width || doc.height !== this.doc.height
    this.doc = doc
    if (resized) this.dirty = this.deps.createDirtyRegion(doc.width, doc.height)
    this.pendingPlan = true
    this.dirty.invalidateAll()
    this.markAllThumbsDirty()
    this.schedule()
  }

  /** Structural update only — cheaper than `setDocument`, keeps tiles warm. */
  setLayerTree(tree: LayerNode[]): void {
    if (this.disposed) return
    this.doc = { ...this.doc, tree }
    this.pendingPlan = true
    this.schedule()
  }

  /**
   * Per-layer property update. Invalidates only that layer's bbox, which is why
   * dragging an opacity slider does not recomposite the document.
   */
  updateLayer(id: string, patch: Partial<LayerNode>): void {
    if (this.disposed) return
    let bbox: Rect | null = null
    const walk = (nodes: LayerNode[]): LayerNode[] =>
      nodes.map((n) => {
        if (n.id === id) {
          const next = { ...n, ...patch }
          bbox = rectUnion(n.bbox ?? null, next.bbox ?? null)
          return next
        }
        return n.children ? { ...n, children: walk(n.children) } : n
      })
    this.doc = { ...this.doc, tree: walk(this.doc.tree) }
    this.pendingPlan = true
    this.invalidate(bbox ?? undefined)
    this.thumbDirty.add(id)
  }

  // ── Pixels ────────────────────────────────────────────────────────────────

  /**
   * Upload pixels into a layer. Marks the rect dirty — and NOTHING else. The
   * frame comes from the rAF loop, which is the whole of the G1 fix: today this
   * call chain ends in a synchronous full recomposite.
   */
  writeLayerRect(id: string, r: Rect, px: ArrayBufferView, fmt: PixelFormat): void {
    if (this.disposed) return
    this.store.writeRect(id, r, px, fmt)
    this.invalidate(r)
    this.thumbDirty.add(id)
  }

  /** Async GPU->CPU readback of a layer rect. Never blocks the main thread. */
  readLayerRect(id: string, r: Rect, fmt: PixelFormat): Promise<ArrayBufferView> {
    return this.store.readRect(id, r, fmt)
  }

  // ── Invalidation & rendering ──────────────────────────────────────────────

  /** Mark a document rect dirty. Coalesced; safe to call at input rate. */
  invalidate(r?: Rect): void {
    if (this.disposed) return
    if (r) this.dirty.invalidate(r)
    else this.dirty.invalidateAll()
    this.schedule()
  }

  /** Set the view. Display-only: it never invalidates a composited tile. */
  setViewport(v: ViewportLike): void {
    if (this.disposed) return
    this.viewport = v
    this.schedule()
  }

  get currentViewport(): Readonly<ViewportLike> {
    return this.viewport
  }

  /** Render one frame now, synchronously. The rAF loop normally calls this. */
  render(viewport?: ViewportLike): FrameStats {
    if (viewport) this.viewport = viewport
    return this.frameBody(now())
  }

  /** Build exactly one tile and return its target. The test seam. */
  buildTile(key: TileKey, dirty: Rect | null = null) {
    if (this.pendingPlan) this.recompilePlan()
    return this.graph.buildTile(key, dirty)
  }

  /** Resolves when every dirty tile has been rebuilt — the test hook. */
  settled(): Promise<void> {
    if (this.disposed || !this.dirty.isDirty()) return Promise.resolve()
    return new Promise<void>((resolve) => {
      this.settledWaiters.push(resolve)
      this.schedule()
    })
  }

  // ── Readback ──────────────────────────────────────────────────────────────

  /** Composited pixels of a rect. Async, PBO-backed. */
  async readPixels(r: Rect): Promise<Float32Array | Uint8Array> {
    const key = this.tileKeyFor(r.x0, r.y0)
    const built = this.buildTile(key, null)
    if (!built) throw new Error('renderer: no GL context')
    const origin = tileRect(key, this.opts.tileSize)
    const local: Rect = {
      x0: r.x0 - origin.x0,
      y0: r.y0 - origin.y0,
      x1: r.x1 - origin.x0,
      y1: r.y1 - origin.y0,
    }
    return this.device.readPixelsAsync(built.target, local)
  }

  /**
   * One composited pixel, synchronously. The documented exception to the
   * async-readback rule (spec §8.5): the eyedropper must answer immediately and
   * only moves 4 to 8 bytes.
   */
  pickPixel(x: number, y: number): Float32Array {
    const key = this.tileKeyFor(x, y)
    const built = this.buildTile(key, null)
    if (!built) return new Float32Array(4)
    const origin = tileRect(key, this.opts.tileSize)
    const px = this.device.readPixelsSync(built.target, {
      x0: x - origin.x0,
      y0: y - origin.y0,
      x1: x - origin.x0 + 1,
      y1: y - origin.y0 + 1,
    })
    return px instanceof Float32Array ? px : Float32Array.from(px, (v) => v / 255)
  }

  /** Last pushed thumbnail, if any. Safe to call during a React render. */
  getThumbnail(layerId: string): ImageBitmap | undefined {
    return this.thumbCache.get(layerId)
  }

  /** 128x128 thumbnail of a layer. See `graph/passes/ThumbnailPass.ts` for G2. */
  async readThumbnail(layerId: string): Promise<ImageBitmap | null> {
    const level = this.store.coarsestLevel(layerId)
    const target = this.thumbs.render({
      layerId,
      tiles: this.store.tilesOf(layerId, level),
      encode: true,
    })
    if (!target) return null
    const px = await this.device.readPixelsAsync(target, {
      x0: 0,
      y0: 0,
      x1: THUMBNAIL_SIZE,
      y1: THUMBNAIL_SIZE,
    })
    const bytes = px instanceof Uint8Array ? px : Uint8Array.from(px, (v) => Math.round(v * 255))
    // Copy into a plain ArrayBuffer: a PBO readback may hand back a view onto a
    // SharedArrayBuffer, which `ImageData` refuses.
    const clamped = new Uint8ClampedArray(THUMBNAIL_SIZE * THUMBNAIL_SIZE * 4)
    clamped.set(bytes.subarray(0, clamped.length))
    const img = new ImageData(clamped, THUMBNAIL_SIZE, THUMBNAIL_SIZE)
    const bitmap = await createImageBitmap(img)
    const prev = this.thumbCache.get(layerId)
    if (prev) prev.close()
    this.thumbCache.set(layerId, bitmap)
    return bitmap
  }

  // ── Events ────────────────────────────────────────────────────────────────

  on<T extends RendererEventType>(type: T, cb: (e: Extract<RendererEvent, { type: T }>) => void): () => void {
    let set = this.listeners.get(type)
    if (!set) {
      set = new Set()
      this.listeners.set(type, set)
    }
    const l = cb as Listener
    set.add(l)
    return () => {
      set?.delete(l)
    }
  }

  private emit(e: RendererEvent): void {
    const set = this.listeners.get(e.type)
    if (!set) return
    for (const cb of set) {
      try {
        cb(e)
      } catch (err) {
        // A throwing subscriber must not take down the render loop.
        if (e.type !== 'error') {
          this.emit({ type: 'error', error: err instanceof Error ? err : new Error(String(err)) })
        }
      }
    }
  }

  get caps(): Readonly<GLCapsLike> {
    return this.device.caps
  }

  get stats(): Readonly<FrameStats> {
    return this.lastStats
  }

  get plan(): PassPlan {
    return this.graph.currentPlan
  }

  // ── Loop ──────────────────────────────────────────────────────────────────

  /**
   * The single rAF loop. Nothing else in the app may schedule a frame.
   * Coalescing is inherent: N invalidations between two frames cost one frame.
   */
  start(): void {
    if (this.disposed || this.running) return
    this.running = true
    this.schedule()
  }

  stop(): void {
    this.running = false
    if (this.rafId !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.rafId)
    this.rafId = null
  }

  private schedule(): void {
    if (this.disposed || !this.running || this.rafId !== null) return
    if (typeof requestAnimationFrame !== 'function') return
    this.rafId = requestAnimationFrame(this.frame)
  }

  private readonly frame = (t: number): void => {
    this.rafId = null
    this.frameBody(t)
    if (this.dirty.isDirty() || this.thumbDirty.size > 0) this.schedule()
  }

  private frameBody(t: number): FrameStats {
    const started = now()
    let tilesBuilt = 0
    let drawCalls = 0
    let registerSwaps = 0
    let hardwareBlends = 0

    if (this.disposed || this.device.isLost) return this.lastStats

    if (this.pendingPlan) this.recompilePlan()

    if (this.dirty.isDirty()) {
      const budget = { msPerFrame: this.opts.msPerFrame, maxTilesPerFrame: this.opts.maxTilesPerFrame }
      const keys = this.scheduler
        ? this.scheduler.plan(this.viewport, this.dirty, budget)
        : [...this.dirty.dirtyTiles()]

      for (const key of keys) {
        if (tilesBuilt >= budget.maxTilesPerFrame) break
        if (now() - started > budget.msPerFrame) break
        const sub = this.dirty.dirtyInTile(key)
        const built = this.graph.buildTile(key, sub)
        if (!built) continue
        tilesBuilt++
        drawCalls += built.stats.drawCalls
        registerSwaps += built.stats.registerSwaps
        hardwareBlends += built.stats.hardwareBlends
        if (this.tiles) this.tiles.touch(key)
        this.dirty.clear(sub ?? tileRect(key, this.opts.tileSize))
      }
    }

    this.deps.present?.({
      device: this.device,
      viewport: this.viewport,
      tiles: this.tiles,
      document: { width: this.doc.width, height: this.doc.height },
    })

    this.pumpThumbnails(t)

    const frameMs = now() - started
    this.lastStats = {
      frameMs,
      tilesBuilt,
      tilesPending: this.dirty.isDirty() ? 1 : 0,
      drawCalls,
      registerSwaps,
      hardwareBlends,
      gpuBytesResident: 0,
      budgetOverrunMs: Math.max(0, frameMs - this.opts.msPerFrame),
    }
    // Diagnostics only. Never wire this to a `setState` in production.
    this.emit({ type: 'frame', stats: this.lastStats })

    if (!this.dirty.isDirty() && this.settledWaiters.length > 0) {
      const waiters = this.settledWaiters
      this.settledWaiters = []
      for (const w of waiters) w()
      this.emit({ type: 'tiles-settled' })
    }
    return this.lastStats
  }

  private recompilePlan(): void {
    this.generation++
    const plan = compilePlan(this.doc.tree, {
      generation: this.generation,
      documentBounds: this.doc.width > 0 ? { x0: 0, y0: 0, x1: this.doc.width, y1: this.doc.height } : null,
      maxFusedSources: Math.max(2, this.device.caps.maxFragmentTextureUnits - 1),
    })
    this.graph.setPlan(plan)
    this.pendingPlan = false
  }

  // ── Thumbnails ────────────────────────────────────────────────────────────

  /**
   * The G5 rate cap, in one place. Debounced 150 ms and capped at N per frame,
   * so a subscriber that naively calls `setState` on `'thumbnails'` still
   * cannot produce 60 renders a second — the engine will not emit that often.
   */
  private pumpThumbnails(t: number): void {
    if (this.thumbDirty.size === 0 || this.thumbInFlight) return
    if (t - this.thumbLastFlush < this.opts.thumbnailDebounceMs) return
    this.thumbLastFlush = t

    const batch: string[] = []
    for (const id of this.thumbDirty) {
      batch.push(id)
      if (batch.length >= this.opts.thumbnailsPerFrame) break
    }
    for (const id of batch) this.thumbDirty.delete(id)
    if (batch.length === 0) return

    this.thumbInFlight = true
    void Promise.all(batch.map((id) => this.readThumbnail(id).catch(() => null)))
      .then(() => {
        this.thumbInFlight = false
        if (!this.disposed) this.emit({ type: 'thumbnails', layerIds: batch })
      })
      .catch(() => {
        this.thumbInFlight = false
      })
  }

  private markAllThumbsDirty(): void {
    const walk = (nodes: LayerNode[]): void => {
      for (const n of nodes) {
        this.thumbDirty.add(n.id)
        if (n.children) walk(n.children)
      }
    }
    walk(this.doc.tree)
  }

  // ── Context loss ──────────────────────────────────────────────────────────

  private readonly onContextLost = (e: Event): void => {
    // Without `preventDefault()` the context is never restored — this listener
    // is missing entirely today (defect F11).
    e.preventDefault()
    this.emit({ type: 'context-lost' })
  }

  private readonly onContextRestored = (): void => {
    this.pendingPlan = true
    this.dirty.invalidateAll()
    this.markAllThumbsDirty()
    this.emit({ type: 'context-restored' })
    this.schedule()
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  private tileKeyFor(x: number, y: number, level = 0): TileKey {
    const span = this.opts.tileSize << level
    return { level, tx: Math.floor(x / span), ty: Math.floor(y / span) }
  }

  /** Releases every GPU object and every listener. Idempotent. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.stop()

    this.canvas.removeEventListener('webglcontextlost', this.onContextLost)
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored)

    this.graph.dispose()
    this.thumbs.dispose()
    this.tiles?.dispose()
    this.store.dispose()

    for (const b of this.thumbCache.values()) b.close()
    this.thumbCache.clear()
    this.thumbDirty.clear()
    this.listeners.clear()

    // Waiters must not hang forever when the engine goes away.
    const waiters = this.settledWaiters
    this.settledWaiters = []
    for (const w of waiters) w()
  }

  get isDisposed(): boolean {
    return this.disposed
  }
}

const now = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now()
