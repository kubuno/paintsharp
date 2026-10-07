// Contract every tool implementation codes against.
//
// A tool is a plain object with optional pointer callbacks. It never imports the
// editor: everything it may touch arrives through `ToolContext`, which is what
// lets tools live in separate files and be written independently of each other
// and of `LayerEditorPage`.
import type { LayerStructureItem } from '../../../api'
import type { ToolId } from '../types'

/** Axis-aligned rectangle in document space. */
export interface Rect { x: number; y: number; w: number; h: number }

/** How a selection gesture combines with the existing selection. */
export type SelectMode = 'replace' | 'add' | 'sub' | 'intersect'

/** Pointer sample handed to a tool, already resolved into both spaces. */
export interface ToolPointer {
  /** Position in canvas/screen pixels, relative to the canvas box. */
  sx: number
  sy: number
  /** Position in document pixels. */
  x: number
  y: number
  /** 0..1 — 0.5 for devices without pressure. */
  pressure: number
  altKey: boolean
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  button: number
  pointerType: string
}

/**
 * Everything a tool is allowed to do. Deliberately narrow: no React, no GL, no
 * direct access to the editor's refs — so a tool stays testable and cannot break
 * invariants it does not know about.
 */
export interface ToolContext {
  // ── Document ──────────────────────────────────────────────────────────────
  readonly docW: number
  readonly docH: number
  /** Layer tree, top layer first. Read-only: mutate through the helpers below. */
  readonly layers: readonly LayerStructureItem[]
  readonly activeId: string | null
  layerById(id: string): LayerStructureItem | null

  // ── Pixels ────────────────────────────────────────────────────────────────
  /** Full-document straight RGBA of a layer, or null when it has no texture. */
  readTex(id: string): Uint8Array | null
  readTexRect(id: string, x: number, y: number, w: number, h: number): Uint8Array | null
  writeTex(id: string, px: Uint8Array): void
  writeTexRect(id: string, x: number, y: number, w: number, h: number, px: Uint8Array): void

  // ── History ───────────────────────────────────────────────────────────────
  /** Snapshot a whole layer before a destructive change. */
  pushUndo(layerId?: string): void
  /**
   * Cheaper: snapshot only the rectangle a gesture touched.
   *
   * `snapshot` is a FULL-DOCUMENT buffer captured before the change; the editor
   * crops `bbox` out of it. Bounds are half-open — `x1`/`y1` are EXCLUSIVE, so
   * the rectangle is `w = x1 - x0` wide. They are clamped to the document.
   */
  pushUndoRect(layerId: string, snapshot: Uint8Array, bbox: { x0: number; y0: number; x1: number; y1: number }): void

  // ── Selection ─────────────────────────────────────────────────────────────
  /** Current selection mask (one byte per document pixel), or null. */
  readonly selection: Uint8Array | null
  setSelection(mask: Uint8Array | null): void
  /** Combines `mask` with the current selection following `mode`. */
  combineSelection(mask: Uint8Array, mode: SelectMode): void
  /** Mode implied by the modifier keys, Photoshop-style. */
  selectModeFor(p: ToolPointer): SelectMode

  // ── Colour & brush ────────────────────────────────────────────────────────
  readonly foreground: string
  readonly background: string
  setForeground(hex: string): void
  readonly brushSize: number
  readonly brushHardness: number
  readonly brushOpacity: number
  readonly brushFlow: number

  // ── View ──────────────────────────────────────────────────────────────────
  readonly zoom: number
  screenToDoc(sx: number, sy: number): [number, number]
  docToScreen(x: number, y: number): [number, number]

  // ── Feedback ──────────────────────────────────────────────────────────────
  /** Recomposite and repaint. Call once a gesture has changed pixels. */
  invalidate(): void
  /** Repaint the overlay only (previews, guides). */
  repaintOverlay(): void
  /**
   * Draw a live preview on the overlay. The callback receives a context already
   * scaled to CSS pixels; it runs on every overlay repaint until cleared.
   */
  setPreview(draw: ((ctx: CanvasRenderingContext2D) => void) | null): void
  /** Transient status message (hint, measured distance…). */
  setStatus(text: string | null): void
}

export interface ToolHandler {
  /** CSS cursor while this tool is active; the crosshair overlay is used when omitted. */
  cursor?: string
  onDown?(ctx: ToolContext, p: ToolPointer): void
  onMove?(ctx: ToolContext, p: ToolPointer): void
  onUp?(ctx: ToolContext, p: ToolPointer): void
  /** Escape or a tool switch aborted the gesture — drop any transient state. */
  onCancel?(ctx: ToolContext): void
  /** Enter committed the gesture (polygonal lasso, pen path…). */
  onCommit?(ctx: ToolContext): void
  /** Double click, used by the polygonal lasso and the pen to close a path. */
  onDoubleClick?(ctx: ToolContext, p: ToolPointer): void
}

export type ToolHandlerMap = Partial<Record<ToolId, ToolHandler>>
