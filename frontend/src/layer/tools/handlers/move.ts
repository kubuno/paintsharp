// Move tool.
//
// Modelled on GIMP's `app/tools/gimpmovetool.c`, which is considerably richer
// than "drag the current layer": the tool has THREE targets, switched by
// modifiers, and it refuses politely when the target is locked.
//
//   • default   → move the active LAYER's pixels (and its mask along with them)
//   • Alt       → move the SELECTION outline, leaving the pixels where they are
//                 (GIMP_TRANSFORM_TYPE_SELECTION)
//   • Ctrl/⌘    → move the active PATH (GIMP_TRANSFORM_TYPE_PATH)
//
// Plus, from the same file:
//   • pick-a-layer: Alt is taken, so picking is on the secondary button — the
//     topmost layer with a non-transparent pixel under the cursor becomes active
//     (GIMP's `move_current = FALSE` / Photoshop's auto-select).
//   • Shift during the drag constrains to the horizontal or vertical axis.
//   • Position and content locks are honoured, with a message rather than a
//     silent no-op (GIMP blinks the lock box; we surface it via `setStatus`).
//
// Derived from GIMP (GPLv3). Kubuno is AGPLv3, which is compatible.
import { registerTool } from './registry'
import type { SelectMode, ToolContext, ToolHandler, ToolPointer } from './types'
import { getPaths, setPaths } from './pen'
import type { Path } from './pen'

type Target = 'layer' | 'selection' | 'path'

interface DragState {
  target: Target
  /** Document-space origin of the gesture. */
  ox: number
  oy: number
  /** Applied offset, updated on every move. */
  dx: number
  dy: number
  layerId: string | null
  /** Pixels captured before the move; also the undo snapshot. */
  snapshot: Uint8Array | null
  maskSnapshot: Uint8Array | null
  selectionSnapshot: Uint8Array | null
  pathsSnapshot: Path[] | null
  /** Ghost of the moving pixels, drawn during the drag. */
  ghost: HTMLCanvasElement | null
  moved: boolean
}

let drag: DragState | null = null

/** GIMP picks the target from the modifier state; so do we. */
function targetFor(p: ToolPointer): Target {
  if (p.altKey) return 'selection'
  if (p.ctrlKey || p.metaKey) return 'path'
  return 'layer'
}

/** Shift locks the movement to whichever axis has travelled further. */
function constrain(dx: number, dy: number, on: boolean): [number, number] {
  if (!on) return [dx, dy]
  return Math.abs(dx) >= Math.abs(dy) ? [dx, 0] : [0, dy]
}

/** Shifts a full-document RGBA buffer, leaving the vacated area transparent. */
function shiftRgba(src: Uint8Array, w: number, h: number, dx: number, dy: number): Uint8Array {
  const out = new Uint8Array(src.length)
  const ix = Math.round(dx), iy = Math.round(dy)
  for (let y = 0; y < h; y++) {
    const sy = y - iy
    if (sy < 0 || sy >= h) continue
    const x0 = Math.max(0, ix), x1 = Math.min(w, w + ix)
    if (x1 <= x0) continue
    const srcRow = (sy * w + (x0 - ix)) * 4
    const dstRow = (y * w + x0) * 4
    out.set(src.subarray(srcRow, srcRow + (x1 - x0) * 4), dstRow)
  }
  return out
}

/** Same, for a one-byte-per-pixel mask. */
function shiftMask(src: Uint8Array, w: number, h: number, dx: number, dy: number): Uint8Array {
  const out = new Uint8Array(src.length)
  const ix = Math.round(dx), iy = Math.round(dy)
  for (let y = 0; y < h; y++) {
    const sy = y - iy
    if (sy < 0 || sy >= h) continue
    const x0 = Math.max(0, ix), x1 = Math.min(w, w + ix)
    if (x1 <= x0) continue
    out.set(src.subarray(sy * w + (x0 - ix), sy * w + (x1 - ix)), y * w + x0)
  }
  return out
}

/** Bounding box of the non-transparent pixels, or null when the layer is empty. */
function alphaBounds(px: Uint8Array, w: number, h: number): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = w, y0 = h, x1 = -1, y1 = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (px[(y * w + x) * 4 + 3] === 0) continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  return x1 < x0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 }
}

/** Topmost leaf whose pixel under (x, y) is not fully transparent. */
function pickLayer(ctx: ToolContext, x: number, y: number): string | null {
  const ix = Math.floor(x), iy = Math.floor(y)
  if (ix < 0 || iy < 0 || ix >= ctx.docW || iy >= ctx.docH) return null
  const walk = (nodes: readonly { id: string; visible: boolean; children?: unknown[] }[]): string | null => {
    for (const n of nodes) {
      if (!n.visible) continue
      if (n.children) {
        const hit = walk(n.children as typeof nodes)
        if (hit) return hit
        continue
      }
      const px = ctx.readTex(n.id)
      if (px && px[(iy * ctx.docW + ix) * 4 + 3] > 0) return n.id
    }
    return null
  }
  return walk(ctx.layers as unknown as Parameters<typeof walk>[0])
}

/** Builds the translucent ghost shown while dragging pixels. */
function makeGhost(px: Uint8Array, w: number, h: number): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null
  const c = document.createElement('canvas')
  c.width = w; c.height = h
  const g = c.getContext('2d')
  if (!g) return null
  g.putImageData(new ImageData(new Uint8ClampedArray(px), w, h), 0, 0)
  return c
}

/**
 * Derives the document→screen affine from three probes, so the ghost tracks
 * zoom, pan AND view rotation without the tool knowing about any of them.
 */
function docAffine(ctx: ToolContext) {
  const [x0, y0] = ctx.docToScreen(0, 0)
  const [x1, y1] = ctx.docToScreen(1, 0)
  const [x2, y2] = ctx.docToScreen(0, 1)
  return { a: x1 - x0, b: y1 - y0, c: x2 - x0, d: y2 - y0, e: x0, f: y0 }
}

function statusFor(target: Target, dx: number, dy: number): string {
  const label = target === 'layer' ? 'L' : target === 'selection' ? 'S' : 'P'
  return `${label}  Δ ${Math.round(dx)}, ${Math.round(dy)}`
}

const handler: ToolHandler = {
  onDown(ctx, p) {
    // Secondary button picks the topmost layer under the cursor and does not
    // start a drag — GIMP's "pick a layer" mode, Photoshop's auto-select.
    if (p.button === 2) {
      const hit = pickLayer(ctx, p.x, p.y)
      ctx.setStatus(hit ? `⌖ ${ctx.layerById(hit)?.name ?? hit}` : null)
      return
    }

    const target = targetFor(p)
    const st: DragState = {
      target, ox: p.x, oy: p.y, dx: 0, dy: 0,
      layerId: null, snapshot: null, maskSnapshot: null,
      selectionSnapshot: null, pathsSnapshot: null, ghost: null, moved: false,
    }

    if (target === 'selection') {
      if (!ctx.selection) { ctx.setStatus('∅'); return }
      st.selectionSnapshot = ctx.selection.slice()
    } else if (target === 'path') {
      const paths = getPaths()
      if (!paths.length) { ctx.setStatus('∅'); return }
      st.pathsSnapshot = paths.map(pa => ({ closed: pa.closed, anchors: pa.anchors.map(a => ({ ...a })) })) as Path[]
    } else {
      const id = ctx.activeId
      const layer = id ? ctx.layerById(id) : null
      if (!id || !layer) { ctx.setStatus('∅'); return }
      // GIMP refuses on a locked target and says why rather than doing nothing.
      if (layer.locked) { ctx.setStatus('🔒'); return }
      if (layer.lockPosition) { ctx.setStatus('🔒 ⇄'); return }
      if (layer.children) { ctx.setStatus('∅'); return }
      const px = ctx.readTex(id)
      if (!px) { ctx.setStatus('∅'); return }
      st.layerId = id
      st.snapshot = px
      st.ghost = makeGhost(px, ctx.docW, ctx.docH)
      // The layer mask travels with the layer, as it does in GIMP.
      if (layer.mask?.enabled) st.maskSnapshot = ctx.readTex(`${id}::mask`) ?? null
    }

    drag = st
    ctx.setStatus(statusFor(target, 0, 0))
  },

  onMove(ctx, p) {
    if (!drag) return
    const [dx, dy] = constrain(p.x - drag.ox, p.y - drag.oy, p.shiftKey)
    drag.dx = dx; drag.dy = dy
    if (dx !== 0 || dy !== 0) drag.moved = true
    ctx.setStatus(statusFor(drag.target, dx, dy))

    const st = drag
    if (st.target === 'layer' && st.ghost && st.snapshot) {
      const bounds = alphaBounds(st.snapshot, ctx.docW, ctx.docH)
      ctx.setPreview(c => {
        const m = docAffine(ctx)
        c.save()
        c.setTransform(m.a, m.b, m.c, m.d, m.e, m.f)
        c.globalAlpha = 0.65
        c.drawImage(st.ghost!, Math.round(st.dx), Math.round(st.dy))
        c.globalAlpha = 1
        if (bounds) {
          // Outline the moving content so the gesture stays readable even when
          // the pixels themselves are faint.
          c.strokeStyle = 'rgba(0,0,0,0.75)'
          c.lineWidth = 3 / Math.max(1e-6, Math.hypot(m.a, m.b))
          c.strokeRect(bounds.x0 + st.dx, bounds.y0 + st.dy, bounds.x1 - bounds.x0, bounds.y1 - bounds.y0)
          c.strokeStyle = 'rgba(255,255,255,0.95)'
          c.lineWidth = 1 / Math.max(1e-6, Math.hypot(m.a, m.b))
          c.strokeRect(bounds.x0 + st.dx, bounds.y0 + st.dy, bounds.x1 - bounds.x0, bounds.y1 - bounds.y0)
        }
        c.restore()
      })
    } else if (st.target === 'selection' && st.selectionSnapshot) {
      ctx.setSelection(shiftMask(st.selectionSnapshot, ctx.docW, ctx.docH, dx, dy))
    } else if (st.target === 'path' && st.pathsSnapshot) {
      setPaths(st.pathsSnapshot.map(pa => ({
        closed: pa.closed,
        anchors: pa.anchors.map(a => ({
          ...a,
          x: a.x + dx, y: a.y + dy,
          ix: a.ix + dx, iy: a.iy + dy,
          ox: a.ox + dx, oy: a.oy + dy,
        })),
      })) as Path[])
      ctx.repaintOverlay()
    }
  },

  onUp(ctx) {
    const st = drag
    drag = null
    ctx.setPreview(null)
    if (!st) return
    ctx.setStatus(null)
    if (!st.moved) return

    if (st.target === 'layer' && st.layerId && st.snapshot) {
      // Undo BEFORE the write, over the union of the vacated and the occupied
      // area — a move dirties both.
      const b = alphaBounds(st.snapshot, ctx.docW, ctx.docH)
      const idx = Math.round(st.dx), idy = Math.round(st.dy)
      if (b) {
        ctx.pushUndoRect(st.layerId, st.snapshot, {
          x0: Math.max(0, Math.min(b.x0, b.x0 + idx)),
          y0: Math.max(0, Math.min(b.y0, b.y0 + idy)),
          x1: Math.min(ctx.docW, Math.max(b.x1, b.x1 + idx)),
          y1: Math.min(ctx.docH, Math.max(b.y1, b.y1 + idy)),
        })
      } else {
        ctx.pushUndo(st.layerId)
      }
      ctx.writeTex(st.layerId, shiftRgba(st.snapshot, ctx.docW, ctx.docH, st.dx, st.dy))
      if (st.maskSnapshot) {
        ctx.writeTex(`${st.layerId}::mask`, shiftRgba(st.maskSnapshot, ctx.docW, ctx.docH, st.dx, st.dy))
      }
      ctx.invalidate()
    }
    // Selection and path moves are already applied live and are not pixel edits.
  },

  onCancel(ctx) {
    const st = drag
    drag = null
    ctx.setPreview(null)
    ctx.setStatus(null)
    if (!st) return
    if (st.target === 'selection' && st.selectionSnapshot) ctx.setSelection(st.selectionSnapshot)
    if (st.target === 'path' && st.pathsSnapshot) setPaths(st.pathsSnapshot)
    ctx.repaintOverlay()
  },
}

registerTool('move', handler)

/** Exposed for the keyboard nudge and for tests. */
export function nudge(ctx: ToolContext, dx: number, dy: number, target: Target = 'layer'): boolean {
  if (target === 'selection') {
    if (!ctx.selection) return false
    ctx.setSelection(shiftMask(ctx.selection, ctx.docW, ctx.docH, dx, dy))
    return true
  }
  const id = ctx.activeId
  const layer = id ? ctx.layerById(id) : null
  if (!id || !layer || layer.locked || layer.lockPosition || layer.children) return false
  const px = ctx.readTex(id)
  if (!px) return false
  ctx.pushUndo(id)
  ctx.writeTex(id, shiftRgba(px, ctx.docW, ctx.docH, dx, dy))
  ctx.invalidate()
  return true
}

export { shiftRgba, shiftMask, alphaBounds, pickLayer, constrain, targetFor }
export type { Target as MoveTarget }

/** Combination mode helper kept for symmetry with the selection tools. */
export const moveSelectMode = (p: ToolPointer): SelectMode => (p.shiftKey ? 'add' : 'replace')
