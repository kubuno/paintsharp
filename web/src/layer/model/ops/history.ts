// Undo / redo: an INCREMENTAL journal of typed commands.
//
// Why this file exists (gap E4 of the audit)
// ------------------------------------------
// The current editor's history is `UndoEntry = { id, x, y, w, h, px }` — pixel
// rectangles and nothing else. Creating, deleting, reordering, renaming or
// grouping a layer is therefore NOT undoable at all. Worse, `pushUndoFull()`
// allocates `w * h * 4` in one block (96 MiB on an 8000x3000 document) through a
// SYNCHRONOUS `readPixels`. That is exactly the thread-freeze already suffered
// in the Office module, and it is a hard "never again".
//
// The model here
// --------------
//   * A command is a PURE, INVERTIBLE description carrying both sides
//     (`before` and `after`). Deriving the inverse at undo time is where subtle
//     bugs (and occasionally infinite loops) come from; storing both costs a few
//     hundred bytes for structural commands and ZERO pixel copies for tile
//     commands, which hold immutable tile handles that already exist.
//   * Pixel edits are TILE-GRANULAR. Undoing a brush stroke costs
//     O(touched tiles), never O(document). No snapshot, ever.
//   * Structural edits are tiny JSON diffs and are first-class citizens.
//   * A memory budget in BYTES (not a fixed depth) evicts the oldest commands.
//
// Nothing here references a live object: no WebGL texture, no canvas, no React
// node. A command is serialisable, which is the precondition for persisting the
// history (the `.kblay` `command_history` field, reserved) and for future
// collaboration.

import { uid } from '../../../uid.ts'
import type { Layer, LayerId, LayerPatch, LayerPath, RectI } from '../types.ts'
import { insertAtPath, removeAtPath, replaceAtPath, updateLayer } from './tree.ts'

export type Direction = 'do' | 'undo'

/**
 * Opaque handle on an immutable tile held by the TileStore. History stores
 * handles, never pixels: a tile touched by 200 pointer events during one stroke
 * still yields a single `before` / `after` pair.
 */
export interface TileRef {
  /** Content-addressed identity (the store dedups identical tiles). */
  readonly id: string
  /** Payload size, for the memory budget. */
  readonly bytes: number
}

export interface TileChange {
  tx: number
  ty: number
  before: TileRef | null
  after: TileRef | null
}

export interface TilesPayload {
  k: 'tiles'
  surfaceId: string
  changes: TileChange[]
  /** A stroke can grow a sparse layer, so bounds are part of the diff. */
  boundsBefore: RectI
  boundsAfter: RectI
}

export type CommandPayload =
  | TilesPayload
  | { k: 'insertLayer'; path: LayerPath; node: Layer }
  | { k: 'removeLayer'; path: LayerPath; node: Layer }
  | { k: 'moveLayer'; from: LayerPath; to: LayerPath }
  | { k: 'setProps'; id: LayerId; before: LayerPatch; after: LayerPatch }
  | { k: 'replaceNode'; path: LayerPath; before: Layer; after: Layer }
  | { k: 'batch'; children: Command[] }

export type CommandType = CommandPayload['k']

export interface Command {
  readonly id: string
  readonly type: CommandType
  /** i18n key shown in the history panel. */
  readonly labelKey: string
  readonly labelParams?: Record<string, string | number>
  /** Wall clock, for coalescing windows and for the panel. */
  readonly at: number
  /** Bytes this command holds alive. */
  readonly cost: number
  /** Commands sharing a key, close enough in time, fold into one entry. */
  readonly coalesceKey?: string
  readonly payload: CommandPayload
}

// ── Cost accounting ──────────────────────────────────────────────────────────

/** Rough, allocation-free size of a structural payload. Never stringifies. */
function estimateNodeBytes(node: Layer): number {
  let n = 512 + node.name.length * 2
  if (node.kind === 'group' || node.kind === 'artboard') {
    for (const c of node.children) n += estimateNodeBytes(c)
  }
  if (node.kind === 'text') n += node.text.content.length * 2 + node.text.runs.length * 128
  if (node.kind === 'shape') {
    for (const sp of node.path.subpaths) n += 64 + sp.nodes.length * 48
  }
  return n
}

export function commandCost(p: CommandPayload): number {
  switch (p.k) {
    case 'tiles': {
      // Distinct tiles the command keeps alive. Shared and deduplicated tiles
      // are counted once, which is the whole point of the tile store.
      const seen = new Set<string>()
      let bytes = 0
      for (const c of p.changes) {
        for (const t of [c.before, c.after]) {
          if (!t || seen.has(t.id)) continue
          seen.add(t.id)
          bytes += t.bytes
        }
      }
      return bytes + 64 * p.changes.length
    }
    case 'insertLayer':
    case 'removeLayer':
      return estimateNodeBytes(p.node)
    case 'replaceNode':
      return estimateNodeBytes(p.before) + estimateNodeBytes(p.after)
    case 'moveLayer':
      return 128
    case 'setProps':
      return 256
    case 'batch':
      return p.children.reduce((s, c) => s + c.cost, 0)
  }
}

export interface MakeCommandInit {
  labelKey: string
  labelParams?: Record<string, string | number>
  coalesceKey?: string
  at?: number
}

export function makeCommand(payload: CommandPayload, init: MakeCommandInit): Command {
  const cmd: Command = {
    id: uid(),
    type: payload.k,
    labelKey: init.labelKey,
    at: init.at ?? Date.now(),
    cost: commandCost(payload),
    payload,
  }
  return init.labelParams !== undefined || init.coalesceKey !== undefined
    ? { ...cmd, labelParams: init.labelParams, coalesceKey: init.coalesceKey }
    : cmd
}

// ── Applying a command to a tree ─────────────────────────────────────────────

/**
 * Pure: `(tree, command, direction) -> tree`. Tile payloads are delegated to the
 * host, because pixels do not live in the tree.
 */
export function applyCommandToTree(tree: readonly Layer[], cmd: Command, dir: Direction): Layer[] {
  return applyPayloadToTree(tree, cmd.payload, dir)
}

function applyPayloadToTree(tree: readonly Layer[], p: CommandPayload, dir: Direction): Layer[] {
  switch (p.k) {
    case 'tiles':
      return [...tree]
    case 'insertLayer':
      return dir === 'do'
        ? insertAtPath(tree, p.path, p.node)
        : removeAtPath(tree, p.path).tree
    case 'removeLayer':
      return dir === 'do'
        ? removeAtPath(tree, p.path).tree
        : insertAtPath(tree, p.path, p.node)
    case 'moveLayer': {
      const [from, to] = dir === 'do' ? [p.from, p.to] : [p.to, p.from]
      const r = removeAtPath(tree, from)
      return r.removed ? insertAtPath(r.tree, to, r.removed) : r.tree
    }
    case 'setProps':
      return updateLayer(tree, p.id, dir === 'do' ? p.after : p.before)
    case 'replaceNode':
      return replaceAtPath(tree, p.path, dir === 'do' ? p.after : p.before)
    case 'batch': {
      // Undo runs the children backwards: the inverse of a composition is the
      // composition of the inverses, in reverse order.
      const list = dir === 'do' ? p.children : [...p.children].reverse()
      let out: Layer[] = [...tree]
      for (const c of list) out = applyPayloadToTree(out, c.payload, dir)
      return out
    }
  }
}

/** True when the command changes the tree structure (never coalesced). */
export function isStructural(p: CommandPayload): boolean {
  if (p.k === 'tiles') return false
  if (p.k === 'setProps') return false
  if (p.k === 'batch') return p.children.some(c => isStructural(c.payload))
  return true
}

// ── Coalescing ───────────────────────────────────────────────────────────────

/**
 * A history entry must match ONE mental action of the user, not one input
 * event. Windows are per action family; see the table in spec 10.4.
 */
export const COALESCE_WINDOW_MS: Readonly<Record<string, number>> = {
  stroke: Number.POSITIVE_INFINITY,  // bounded by the explicit transaction instead
  opacity: 500,
  text: 800,
  nudge: 400,
  adjust: 500,
}

export function coalesceWindowFor(key: string | undefined, fallback = 500): number {
  if (!key) return 0
  const family = key.split(':', 1)[0]
  return COALESCE_WINDOW_MS[family] ?? fallback
}

/**
 * Merges `next` into `prev` when they belong to the same mental action.
 * Returns `null` when they must stay separate.
 *
 * Tile payloads keep the OLDEST `before` and the NEWEST `after` per tile: that
 * is what makes a 200-event brush stroke cost one tile pair.
 */
export function coalesce(prev: Command, next: Command, windowMs: number): Command | null {
  if (!prev.coalesceKey || prev.coalesceKey !== next.coalesceKey) return null
  if (isStructural(prev.payload) || isStructural(next.payload)) return null
  if (next.at - prev.at > windowMs) return null

  if (prev.payload.k === 'tiles' && next.payload.k === 'tiles') {
    if (prev.payload.surfaceId !== next.payload.surfaceId) return null
    const byKey = new Map<string, TileChange>()
    for (const c of prev.payload.changes) byKey.set(`${c.tx}:${c.ty}`, { ...c })
    for (const c of next.payload.changes) {
      const k = `${c.tx}:${c.ty}`
      const old = byKey.get(k)
      if (old) old.after = c.after            // oldest before, newest after
      else byKey.set(k, { ...c })
    }
    const payload: TilesPayload = {
      k: 'tiles',
      surfaceId: prev.payload.surfaceId,
      changes: [...byKey.values()],
      boundsBefore: prev.payload.boundsBefore,
      boundsAfter: next.payload.boundsAfter,
    }
    return { ...prev, at: next.at, cost: commandCost(payload), payload }
  }

  if (prev.payload.k === 'setProps' && next.payload.k === 'setProps') {
    if (prev.payload.id !== next.payload.id) return null
    const payload: CommandPayload = {
      k: 'setProps',
      id: prev.payload.id,
      before: prev.payload.before,
      after: { ...prev.payload.after, ...next.payload.after },
    }
    return { ...prev, at: next.at, cost: commandCost(payload), payload }
  }

  return null
}

// ── Budget ───────────────────────────────────────────────────────────────────

export const HISTORY_BUDGET = {
  /** Hard cap on the bytes history keeps alive. Taken from UNDO_MAX_BYTES. */
  maxBytes: 384 * 1024 * 1024,
  /** Never drop below this depth, even over budget: an undo depth of 2 is worse
   *  than swapping. */
  minEntries: 20,
  /** Never keep more than this, whatever the size. */
  maxEntries: 200,
  /** Above this fraction of `maxBytes`, warn in the status bar. */
  warnAt: 0.85,
} as const

export type HistoryBudget = typeof HISTORY_BUDGET

/** Pinned every `CHECKPOINT_EVERY` commands: a list of KEYS, not pixels. */
export const CHECKPOINT_EVERY = 50

export interface Checkpoint {
  /** Number of applied commands when the checkpoint was taken. */
  index: number
  at: number
  /** Tile identities alive at that point, supplied by the host. A few KiB. */
  tileIds: readonly string[]
}

// ── The stack ────────────────────────────────────────────────────────────────

export interface HistoryHost {
  getTree(): Layer[]
  setTree(tree: Layer[]): void
  /** Rebinds tiles in the store. Absent for a structure-only host. */
  applyTiles?(payload: TilesPayload, dir: Direction): void
  /** Tile identities of the current state, for checkpoints. Optional. */
  snapshotTileIds?(): readonly string[]
  /** Called when a command is dropped, so the store can release its tiles. */
  releaseCommand?(cmd: Command): void
}

export interface HistoryStats {
  undoDepth: number
  redoDepth: number
  bytes: number
  /** `bytes / maxBytes`. */
  pressure: number
  overWarn: boolean
  dirty: boolean
}

export class HistoryStack {
  private undoStack: Command[] = []
  private redoStack: Command[] = []
  private bytesHeld = 0
  private savedAt = 0
  private checkpoints: Checkpoint[] = []
  private txn: Transaction | null = null
  /** Set by `breakCoalescing()`; the next push starts a fresh entry. */
  private coalesceBroken = false
  private readonly host: HistoryHost
  private readonly budget: HistoryBudget

  // Explicit field assignment, not TypeScript parameter properties: the model
  // must run under Node's type-stripping loader, which rejects that syntax.
  constructor(host: HistoryHost, budget: HistoryBudget = HISTORY_BUDGET) {
    this.host = host
    this.budget = budget
  }

  // ── Recording ──────────────────────────────────────────────────────────────

  /** Records an ALREADY-APPLIED change. */
  push(cmd: Command): void {
    if (this.txn) { this.txn.add(cmd); return }
    this.redoStack.length = 0

    const prev = this.undoStack[this.undoStack.length - 1]
    if (prev && !this.coalesceBroken) {
      const merged = coalesce(prev, cmd, coalesceWindowFor(cmd.coalesceKey))
      if (merged) {
        this.bytesHeld += merged.cost - prev.cost
        this.undoStack[this.undoStack.length - 1] = merged
        this.enforceBudget()
        return
      }
    }
    this.coalesceBroken = false
    this.undoStack.push(cmd)
    this.bytesHeld += cmd.cost
    this.maybeCheckpoint()
    this.enforceBudget()
  }

  /** Applies the command, then records it. The normal entry point. */
  applyAndPush(cmd: Command): void {
    this.applyOne(cmd, 'do')
    this.push(cmd)
  }

  /**
   * Opens a coalescing transaction. Every push until `commit()` folds into a
   * single entry — one brush stroke, one drag, one panel session.
   */
  begin(labelKey: string, coalesceKey?: string): Transaction {
    if (this.txn) return this.txn
    this.txn = new Transaction(this, labelKey, coalesceKey)
    return this.txn
  }

  /** @internal — called by `Transaction`. */
  endTransaction(cmd: Command | null): void {
    this.txn = null
    if (cmd) this.push(cmd)
  }

  /**
   * Closes the current coalescing window. MUST be called on selection change,
   * active-layer change, tool change, save and window blur — otherwise a single
   * undo can swallow twenty minutes of work.
   */
  breakCoalescing(): void { this.coalesceBroken = true }

  // ── Playback ───────────────────────────────────────────────────────────────

  canUndo(): boolean { return this.undoStack.length > 0 }
  canRedo(): boolean { return this.redoStack.length > 0 }

  /** Synchronous and bounded: never `await`, never O(document). */
  undo(): Command | null {
    const cmd = this.undoStack.pop()
    if (!cmd) return null
    this.applyOne(cmd, 'undo')
    this.redoStack.push(cmd)
    return cmd
  }

  redo(): Command | null {
    const cmd = this.redoStack.pop()
    if (!cmd) return null
    this.applyOne(cmd, 'do')
    this.undoStack.push(cmd)
    return cmd
  }

  private applyOne(cmd: Command, dir: Direction): void {
    const next = applyCommandToTree(this.host.getTree(), cmd, dir)
    this.host.setTree(next)
    this.applyTilesDeep(cmd.payload, dir)
  }

  private applyTilesDeep(p: CommandPayload, dir: Direction): void {
    if (p.k === 'tiles') { this.host.applyTiles?.(p, dir); return }
    if (p.k !== 'batch') return
    const list = dir === 'do' ? p.children : [...p.children].reverse()
    for (const c of list) this.applyTilesDeep(c.payload, dir)
  }

  // ── Housekeeping ───────────────────────────────────────────────────────────

  private maybeCheckpoint(): void {
    if (this.undoStack.length % CHECKPOINT_EVERY !== 0) return
    this.checkpoints.push({
      index: this.undoStack.length,
      at: Date.now(),
      tileIds: this.host.snapshotTileIds?.() ?? [],
    })
    if (this.checkpoints.length > 8) this.checkpoints.shift()
  }

  /**
   * Eviction, oldest first. A command is dropped WHOLE: a half-undoable entry
   * is a bug, not a saving.
   */
  private enforceBudget(): void {
    while (this.undoStack.length > this.budget.maxEntries) this.evictOldest()
    while (this.bytesHeld > this.budget.maxBytes && this.undoStack.length > this.budget.minEntries) {
      this.evictOldest()
    }
  }

  private evictOldest(): void {
    const dropped = this.undoStack.shift()
    if (!dropped) return
    this.bytesHeld -= dropped.cost
    if (this.bytesHeld < 0) this.bytesHeld = 0
    if (this.savedAt > 0) this.savedAt--
    for (const c of this.checkpoints) c.index--
    this.checkpoints = this.checkpoints.filter(c => c.index > 0)
    this.host.releaseCommand?.(dropped)
  }

  clear(): void {
    for (const c of this.undoStack) this.host.releaseCommand?.(c)
    for (const c of this.redoStack) this.host.releaseCommand?.(c)
    this.undoStack = []
    this.redoStack = []
    this.bytesHeld = 0
    this.savedAt = 0
    this.checkpoints = []
  }

  /** Called on a successful save; drives the dirty flag. */
  markSaved(): void {
    this.savedAt = this.undoStack.length
    this.breakCoalescing()
  }

  get stats(): HistoryStats {
    return {
      undoDepth: this.undoStack.length,
      redoDepth: this.redoStack.length,
      bytes: this.bytesHeld,
      pressure: this.bytesHeld / this.budget.maxBytes,
      overWarn: this.bytesHeld > this.budget.maxBytes * this.budget.warnAt,
      dirty: this.undoStack.length !== this.savedAt,
    }
  }

  /** Read-only views, for the history panel. */
  get entries(): readonly Command[] { return this.undoStack }
  get redoEntries(): readonly Command[] { return this.redoStack }
  get pins(): readonly Checkpoint[] { return this.checkpoints }
}

/**
 * A coalescing transaction. `pointerdown` opens it, `pointerup` commits it: one
 * entry per stroke, whatever its length.
 */
export class Transaction {
  private readonly commands: Command[] = []
  private done = false
  private readonly stack: HistoryStack
  private readonly labelKey: string
  private readonly coalesceKey: string | undefined

  constructor(stack: HistoryStack, labelKey: string, coalesceKey?: string) {
    this.stack = stack
    this.labelKey = labelKey
    this.coalesceKey = coalesceKey
  }

  /** @internal */
  add(cmd: Command): void { if (!this.done) this.commands.push(cmd) }

  commit(): Command | null {
    if (this.done) return null
    this.done = true
    if (this.commands.length === 0) { this.stack.endTransaction(null); return null }
    const merged = mergeTransaction(this.commands)
    const cmd = makeCommand(merged, {
      labelKey: this.labelKey,
      coalesceKey: this.coalesceKey,
      at: this.commands[this.commands.length - 1].at,
    })
    this.stack.endTransaction(cmd)
    return cmd
  }

  abort(): void {
    if (this.done) return
    this.done = true
    this.stack.endTransaction(null)
  }
}

/**
 * Folds a transaction's commands. Consecutive tile payloads on the same surface
 * merge into one; everything else becomes a batch. A stroke that touched the
 * same tile 200 times ends up with a single before/after pair for it.
 */
function mergeTransaction(cmds: readonly Command[]): CommandPayload {
  if (cmds.length === 1) return cmds[0].payload

  const allTiles = cmds.every(c => c.payload.k === 'tiles')
  if (allTiles) {
    const first = cmds[0].payload as TilesPayload
    if (cmds.every(c => (c.payload as TilesPayload).surfaceId === first.surfaceId)) {
      const byKey = new Map<string, TileChange>()
      for (const c of cmds) {
        for (const ch of (c.payload as TilesPayload).changes) {
          const k = `${ch.tx}:${ch.ty}`
          const old = byKey.get(k)
          if (old) old.after = ch.after
          else byKey.set(k, { ...ch })
        }
      }
      return {
        k: 'tiles',
        surfaceId: first.surfaceId,
        changes: [...byKey.values()],
        boundsBefore: first.boundsBefore,
        boundsAfter: (cmds[cmds.length - 1].payload as TilesPayload).boundsAfter,
      }
    }
  }
  return { k: 'batch', children: [...cmds] }
}
