// Tile scheduling: which tiles get rebuilt, in which order, within which budget.
//
// Priority order mirrors GIMP's gimp_projection_set_priority_rect /
// gimp_chunk_iterator_set_priority_rect (app/core/gimpprojection.c): the area
// the user is looking at is validated first, the rest is idle work. GIMP is
// GPLv3; this is a reimplementation of the published design, not a copy.
//
// Three rules that the audit makes non-negotiable:
//
//  1. THE BUDGET IS NEVER EXCEEDED TO "FINISH". The scheduler stops as soon as
//     the elapsed time passes `budget.msPerFrame` and defers the rest, drawing
//     the coarse LOD stand-ins meanwhile. That is what removes the freezes.
//     Exception: at least one tile per frame, otherwise a pathological budget
//     would starve the queue forever and nothing would ever converge.
//
//  2. WORK IS RESUMABLE. An unfinished queue is kept and continued on the next
//     frame; tiles that stopped being dirty in the meantime are skipped.
//
//  3. THE SCHEDULER NEVER TALKS TO REACT. It has no imports beyond this folder,
//     emits no events during a gesture, and `onSettled` — its only outward
//     notification — is deferred until `endGesture()`. The spec threshold is
//     "0 React render during a stroke"; deferring the single notification the
//     scheduler can produce is how this stage upholds it.

import {
  type Rect,
  type TileId,
  type TileKey,
  keyId,
  rectInflate,
  rectIntersect,
  rectIsEmpty,
  tileDocRect,
  tileSpan,
} from './geometry'
import { defaultClock, type Clock } from './GLDeviceLike'

/** Frame budget split, in milliseconds (spec 8.4). Total is one 60 Hz frame. */
export interface FrameBudget {
  total: number
  input: number
  tiles: number
  display: number
  slack: number
}

export const DEFAULT_FRAME_BUDGET: FrameBudget = {
  total: 16.6,
  input: 3,
  tiles: 8,
  display: 3,
  slack: 2,
}

export interface RenderBudget {
  /** Milliseconds this frame may spend building tiles. */
  msPerFrame: number
  /** Never exceed this many tiles per frame, whatever the clock says. */
  maxTilesPerFrame: number
}

export const DEFAULT_RENDER_BUDGET: RenderBudget = {
  msPerFrame: DEFAULT_FRAME_BUDGET.tiles,
  maxTilesPerFrame: 64,
}

/** Derive the tile slice of a measured frame period (60 Hz vs 120 Hz displays). */
export function budgetForFrameMs(frameMs: number, maxTilesPerFrame = 64): RenderBudget {
  const ratio = DEFAULT_FRAME_BUDGET.tiles / DEFAULT_FRAME_BUDGET.total
  return { msPerFrame: Math.max(1, frameMs * ratio), maxTilesPerFrame }
}

/** What the scheduler needs to know about pending work. LodPyramid satisfies it. */
export interface TileWorkSource {
  readonly levelCount: number
  dirtyTilesAt(level: number, withinDocRect?: Rect | null): TileKey[]
  dirtyRectInTile(key: TileKey): Rect | null
}

export interface PlanRequest {
  /** Axis-aligned document rect currently visible (rotation already expanded). */
  visible: Rect
  /** LOD level the display pass samples. */
  level: number
  source: TileWorkSource
  /** Extra tiles of margin around the viewport, anticipating panning. Default 1. */
  ring?: number
  /** How many coarser levels to schedule as stand-ins. Default 2. */
  coarseLevels?: number
  /** Schedule off-screen dirty tiles too (idle work). Default true. */
  includeOffscreen?: boolean
  /** Hard cap on plan length, so an idle sweep cannot allocate unboundedly. */
  maxPlanLength?: number
}

export type StopReason = 'complete' | 'time' | 'count' | 'cancelled' | 'empty'

export interface SchedulerRunResult {
  built: number
  /** Queued tiles that turned out to be clean already. */
  skipped: number
  /** Tiles left in the queue. */
  remaining: number
  elapsedMs: number
  /** How far past the budget the last tile pushed us — the honest metric. */
  overrunMs: number
  stoppedBy: StopReason
}

export interface SchedulerStats {
  framesRun: number
  tilesBuilt: number
  tilesSkipped: number
  pending: number
  /** Frames that had to stop on the clock. */
  budgetStops: number
  totalOverrunMs: number
  cancellations: number
  gestureActive: boolean
}

/** Builder callback: rebuild `key`, restricted to `dirty` (level-L coordinates). */
export type TileBuilder = (key: TileKey, dirty: Rect) => void

export class TileScheduler {
  private readonly clock: Clock

  private queue: TileKey[] = []
  private cursor = 0
  private signature = ''
  private epoch = 0
  private queueEpoch = -1
  private cancelled = false

  private gestureDepth = 0
  private settledPending = false

  private framesRun = 0
  private tilesBuilt = 0
  private tilesSkipped = 0
  private budgetStops = 0
  private totalOverrunMs = 0
  private cancellations = 0

  /** Fired once when the queue drains. Deferred while a gesture is active. */
  onSettled: (() => void) | null = null

  constructor(opts: { clock?: Clock } = {}) {
    this.clock = opts.clock ?? defaultClock
  }

  get pending(): number {
    return Math.max(0, this.queue.length - this.cursor)
  }

  get gestureActive(): boolean {
    return this.gestureDepth > 0
  }

  /**
   * Build the ordered work list.
   *
   *   class 0 — visible & dirty at the display level: what the user is looking at
   *   class 1 — visible & dirty at coarser levels: cheap stand-ins, drawn blurry
   *   class 2 — the ring around the viewport: anticipates panning
   *   class 3 — everything else: idle-time work
   *
   * Within a class, tiles are ordered by distance to the centre of the viewport,
   * so a stroke in the middle of the screen converges from the middle outwards.
   */
  plan(req: PlanRequest): TileKey[] {
    const seen = new Set<TileId>()
    const out: TileKey[] = []
    const cap = req.maxPlanLength ?? 4096
    const cx = (req.visible.x0 + req.visible.x1) / 2
    const cy = (req.visible.y0 + req.visible.y1) / 2

    const push = (keys: TileKey[]): void => {
      const sorted = keys
        .filter(k => !seen.has(keyId(k)))
        .sort((a, b) => distanceScore(a, cx, cy) - distanceScore(b, cx, cy))
      for (const k of sorted) {
        if (out.length >= cap) return
        seen.add(keyId(k))
        out.push(k)
      }
    }

    // class 0
    push(req.source.dirtyTilesAt(req.level, req.visible))

    // class 1 — coarse stand-ins for the same visible area
    const coarse = req.coarseLevels ?? 2
    for (let l = req.level + 1; l <= Math.min(req.source.levelCount - 1, req.level + coarse); l++) {
      push(req.source.dirtyTilesAt(l, req.visible))
    }

    // class 2 — one-tile ring around the viewport
    const ring = req.ring ?? 1
    if (ring > 0) {
      const margin = ring * tileSpan(req.level)
      push(req.source.dirtyTilesAt(req.level, rectInflate(req.visible, margin)))
    }

    // class 3 — the rest of the document, idle work
    if (req.includeOffscreen !== false && out.length < cap) {
      push(req.source.dirtyTilesAt(req.level))
    }

    return out
  }

  /**
   * Run the plan under `budget`. Resumes the previous queue when the view has
   * not changed, re-plans otherwise. Returns what happened, including whether
   * the budget forced a stop — the number the diagnostics panel reports.
   */
  run(req: PlanRequest, build: TileBuilder, budget: RenderBudget = DEFAULT_RENDER_BUDGET): SchedulerRunResult {
    this.framesRun++
    this.cancelled = false

    const sig = planSignature(req)
    if (this.queue.length === 0 || this.cursor >= this.queue.length || sig !== this.signature || this.epoch !== this.queueEpoch) {
      this.queue = this.plan(req)
      this.cursor = 0
      this.signature = sig
      this.queueEpoch = this.epoch
    }

    const start = this.clock()
    let built = 0
    let skipped = 0
    let stoppedBy: StopReason = 'complete'

    if (this.queue.length === 0) stoppedBy = 'empty'

    while (this.cursor < this.queue.length) {
      if (this.cancelled) {
        stoppedBy = 'cancelled'
        break
      }
      if (built >= budget.maxTilesPerFrame) {
        stoppedBy = 'count'
        break
      }
      // At least one tile per frame guarantees forward progress even at msPerFrame = 0.
      if (built > 0 && this.clock() - start >= budget.msPerFrame) {
        stoppedBy = 'time'
        break
      }
      const key = this.queue[this.cursor++]
      const dirty = req.source.dirtyRectInTile(key)
      if (!dirty) {
        skipped++
        continue
      }
      build(key, dirty)
      built++
    }

    const elapsedMs = this.clock() - start
    const overrunMs = Math.max(0, elapsedMs - budget.msPerFrame)
    if (stoppedBy === 'time') this.budgetStops++
    this.totalOverrunMs += overrunMs
    this.tilesBuilt += built
    this.tilesSkipped += skipped

    if (this.cursor >= this.queue.length) {
      this.queue = []
      this.cursor = 0
      this.signature = ''
      this.notifySettled()
    }

    return {
      built,
      skipped,
      remaining: this.pending,
      elapsedMs,
      overrunMs,
      stoppedBy,
    }
  }

  /**
   * Drop the in-flight queue. Call when the view changes: the tiles that were
   * about to be built may not even be on screen any more, and rebuilding them
   * would spend the budget on invisible pixels.
   */
  cancel(): void {
    this.cancelled = true
    this.cancellations++
    this.queue = []
    this.cursor = 0
    this.signature = ''
    this.epoch++
  }

  /** Signal a viewport change without discarding statistics. */
  invalidatePlan(): void {
    this.epoch++
  }

  // ── Gesture window ────────────────────────────────────────────────────────

  /**
   * A pointer gesture is running. While it is, the scheduler suppresses its
   * `onSettled` notification (the only thing a React adapter could subscribe to),
   * so a 6-second stroke produces zero React renders instead of one per frame.
   */
  beginGesture(): void {
    this.gestureDepth++
  }

  endGesture(): void {
    if (this.gestureDepth === 0) return
    this.gestureDepth--
    if (this.gestureDepth === 0 && this.settledPending) {
      this.settledPending = false
      this.onSettled?.()
    }
  }

  stats(): SchedulerStats {
    return {
      framesRun: this.framesRun,
      tilesBuilt: this.tilesBuilt,
      tilesSkipped: this.tilesSkipped,
      pending: this.pending,
      budgetStops: this.budgetStops,
      totalOverrunMs: this.totalOverrunMs,
      cancellations: this.cancellations,
      gestureActive: this.gestureActive,
    }
  }

  resetStats(): void {
    this.framesRun = 0
    this.tilesBuilt = 0
    this.tilesSkipped = 0
    this.budgetStops = 0
    this.totalOverrunMs = 0
    this.cancellations = 0
  }

  private notifySettled(): void {
    if (!this.onSettled) return
    if (this.gestureDepth > 0) {
      this.settledPending = true
      return
    }
    this.onSettled()
  }
}

/** Squared distance from a tile centre to a document-space point. */
function distanceScore(k: TileKey, cx: number, cy: number): number {
  const r = tileDocRect(k)
  const dx = (r.x0 + r.x1) / 2 - cx
  const dy = (r.y0 + r.y1) / 2 - cy
  return dx * dx + dy * dy
}

function planSignature(req: PlanRequest): string {
  const v = req.visible
  return `${req.level}|${v.x0}|${v.y0}|${v.x1}|${v.y1}|${req.ring ?? 1}|${req.coarseLevels ?? 2}`
}

// ── Viewport helpers ────────────────────────────────────────────────────────

export interface ViewportLike {
  /** CSS pixels of the visible area. */
  width: number
  height: number
  dpr: number
  /** screen = R(rotation) * (doc * zoom) + (panX, panY), in CSS pixels. */
  zoom: number
  panX: number
  panY: number
  rotation?: number
}

/**
 * Axis-aligned document rect covered by the viewport. The four screen corners
 * are mapped back through the inverse transform and their bounding box is
 * taken, which is why a rotated view simply schedules a slightly larger set of
 * tiles rather than needing an oriented traversal.
 */
export function visibleDocRect(v: ViewportLike, docWidth?: number, docHeight?: number): Rect {
  const zoom = v.zoom > 0 ? v.zoom : 1
  const rot = v.rotation ?? 0
  const c = Math.cos(-rot)
  const s = Math.sin(-rot)
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  const corners: [number, number][] = [
    [0, 0],
    [v.width, 0],
    [0, v.height],
    [v.width, v.height],
  ]
  for (const [sx, sy] of corners) {
    const px = sx - v.panX
    const py = sy - v.panY
    const dx = (px * c - py * s) / zoom
    const dy = (px * s + py * c) / zoom
    if (dx < x0) x0 = dx
    if (dy < y0) y0 = dy
    if (dx > x1) x1 = dx
    if (dy > y1) y1 = dy
  }
  const r: Rect = { x0: Math.floor(x0), y0: Math.floor(y0), x1: Math.ceil(x1), y1: Math.ceil(y1) }
  if (docWidth === undefined || docHeight === undefined) return r
  const clamped = rectIntersect(r, { x0: 0, y0: 0, x1: docWidth, y1: docHeight })
  return clamped ?? { x0: 0, y0: 0, x1: 0, y1: 0 }
}

/** True when nothing of the document is on screen. */
export const viewportIsEmpty = (r: Rect | null): boolean => rectIsEmpty(r)
