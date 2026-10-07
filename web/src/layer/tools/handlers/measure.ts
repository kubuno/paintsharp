// Measurement, sampling, annotation and slicing tools.
//
// Six handlers share this file because they share one thing the rest of the
// editor does not own: a set of NON-DESTRUCTIVE overlays — sampler points, a
// compass, notes, slice rectangles — that outlive a single gesture and must be
// redrawn on every overlay repaint. They live in module state and are painted
// through `ToolContext.setPreview`, which is re-run by the editor on each
// repaint; nothing here reaches into the editor.
//
// Only `crop-perspective` writes pixels, and it pushes its undo entry BEFORE
// doing so. The five other tools never touch a texture, so they never create a
// history entry either.
//
// ── Attribution ─────────────────────────────────────────────────────────────
// The perspective rectification is a TypeScript re-implementation of GIMP's
// `gimp_transform_matrix_perspective()` (app/core/gimp-transform-utils.c), and
// the compass/angle maths follows `gimp_tool_compass_update_angle()`
// (app/display/gimptoolcompass.c) used by GIMP's measure tool
// (app/tools/gimpmeasuretool.c).
// GIMP is Copyright (C) 1995 Spencer Kimball, Peter Mattis and the GIMP
// developers, released under the GNU General Public License version 3 or later.
// Kubuno is licensed under the GNU Affero General Public License version 3,
// which is compatible with reusing GPLv3 work. The closed-form unit-square →
// quadrilateral solution below is derived from that source; the resampling
// loop, the degeneracy guards and everything else are original.
import { registerTool } from './registry'
import type { ToolContext, ToolHandler, ToolPointer } from './types'

// ── Shared geometry ─────────────────────────────────────────────────────────

interface Pt { x: number; y: number }

/** Points closer than this (document units) count as coincident. */
const EPS = 1e-9

const DEG = 180 / Math.PI

/** Two decimals, the precision Photoshop's info panel uses for measurements. */
const f2 = (n: number): string => n.toFixed(2)

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

/** Pointer position clamped to the document — a measurement outside it is meaningless. */
function docPoint(ctx: ToolContext, p: ToolPointer): Pt {
  return { x: clamp(p.x, 0, ctx.docW), y: clamp(p.y, 0, ctx.docH) }
}

/**
 * Signed angle of a vector in degrees, positive counter-clockwise as seen on
 * screen. Document space has y growing downwards, hence the negated y.
 */
const vecAngleDeg = (dx: number, dy: number): number => -Math.atan2(dy, dx) * DEG

/**
 * Angle from `a` to `b`, signed, in degrees — `atan2(cross, dot)`, the form
 * GIMP's compass uses because it stays well conditioned near 0° and 180°.
 */
function angleBetweenDeg(a: Pt, b: Pt): number {
  const cross = a.x * b.y - a.y * b.x
  const dot = a.x * b.x + a.y * b.y
  return -Math.atan2(cross, dot) * DEG
}

/** Snap a vector to the nearest multiple of `step` degrees, keeping its length. */
function snapAngle(from: Pt, to: Pt, stepDeg: number): Pt {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const len = Math.hypot(dx, dy)
  if (len < EPS) return { ...to }
  const step = stepDeg / DEG
  const a = Math.round(Math.atan2(dy, dx) / step) * step
  return { x: from.x + Math.cos(a) * len, y: from.y + Math.sin(a) * len }
}

// ── Shared painting ─────────────────────────────────────────────────────────
//
// Everything is stroked twice — a dark halo, then a light core — so overlays
// stay readable over white paper as well as over a dark photograph. That is the
// convention the editor's own cursors already follow.

const HALO = 'rgba(0,0,0,0.78)'
const CORE = 'rgba(255,255,255,0.96)'
const ACCENT = 'rgba(120,190,255,0.98)'
const FONT = '11px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif'

/** Odd-width strokes land on the half-pixel grid, else a 1px line renders as two grey ones. */
const snap = (v: number): number => Math.round(v) + 0.5

function twoPass(
  c: CanvasRenderingContext2D,
  path: () => void,
  core: string = CORE,
  coreWidth = 1,
  haloWidth = 3,
): void {
  c.lineJoin = 'round'
  c.lineCap = 'round'
  c.setLineDash([])
  c.strokeStyle = HALO
  c.lineWidth = haloWidth
  path()
  c.stroke()
  c.strokeStyle = core
  c.lineWidth = coreWidth
  path()
  c.stroke()
}

/** Same two-pass treatment for text: a dark outline under a light glyph. */
function label(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  text: string,
  core: string = CORE,
  align: CanvasTextAlign = 'left',
  baseline: CanvasTextBaseline = 'alphabetic',
): void {
  c.font = FONT
  c.textAlign = align
  c.textBaseline = baseline
  c.lineJoin = 'round'
  c.lineWidth = 3
  c.strokeStyle = HALO
  c.strokeText(text, x, y)
  c.fillStyle = core
  c.fillText(text, x, y)
}

/** A small filled disc with a numbered core — sampler points, notes, slices. */
function badge(c: CanvasRenderingContext2D, x: number, y: number, n: number, tint: string): void {
  c.beginPath()
  c.arc(x, y, 8, 0, Math.PI * 2)
  c.fillStyle = HALO
  c.fill()
  c.lineWidth = 1
  c.strokeStyle = tint
  c.stroke()
  label(c, x, y + 0.5, String(n), CORE, 'center', 'middle')
}

// ── Preview ownership ───────────────────────────────────────────────────────
//
// `setPreview` holds a single callback for the whole editor, so the last tool to
// install one wins. Each tool here installs its painter once and then only asks
// for a repaint: the painter reads live module state, so a repaint is enough to
// show a change. `previewOwner` avoids re-installing (and re-repainting) on
// every hover event.

type Painter = (c: CanvasRenderingContext2D) => void
type OwnerId = 'color-sampler' | 'ruler' | 'note' | 'crop-perspective' | 'slices'

let previewOwner: OwnerId | null = null

function refresh(ctx: ToolContext, owner: OwnerId, paint: Painter): void {
  if (previewOwner !== owner) {
    previewOwner = owner
    ctx.setPreview(paint)   // already triggers a repaint
    return
  }
  ctx.repaintOverlay()
}

/** Distance in SCREEN pixels between a document point and the pointer. */
function screenDist(ctx: ToolContext, p: ToolPointer, at: Pt): number {
  const [sx, sy] = ctx.docToScreen(at.x, at.y)
  return Math.hypot(sx - p.sx, sy - p.sy)
}

/** Index of the nearest item within `tol` SCREEN pixels, or -1. Zoom-independent. */
function pickNear(ctx: ToolContext, p: ToolPointer, pts: readonly Pt[], tol = 9): number {
  let best = -1
  let bestD = tol
  for (let i = 0; i < pts.length; i++) {
    const d = screenDist(ctx, p, pts[i])
    if (d <= bestD) { bestD = d; best = i }
  }
  return best
}

// ── Pixel probing (read only) ───────────────────────────────────────────────

/**
 * The layer a sample should be read from: the active one when it has pixels,
 * else the topmost visible layer that has some.
 *
 * LIMITATION: `ToolContext` exposes per-layer textures only, never the
 * composite, so the "sample all layers" option of the toolbox cannot be honoured
 * here. Wiring it means adding a composite read to the context.
 */
function sampleLayerId(ctx: ToolContext): string | null {
  const probe = (id: string): boolean => ctx.readTexRect(id, 0, 0, 1, 1) !== null
  if (ctx.activeId && probe(ctx.activeId)) return ctx.activeId
  const walk = (items: readonly { id: string; visible: boolean; children?: unknown }[]): string | null => {
    for (const it of items) {
      const kids = (it as { children?: readonly { id: string; visible: boolean }[] }).children
      if (kids && kids.length) {
        const found = walk(kids)
        if (found) return found
      }
      if (it.visible && probe(it.id)) return it.id
    }
    return null
  }
  return walk(ctx.layers)
}

interface Rgba { r: number; g: number; b: number; a: number }

/** Straight RGBA under a document point, or null when there is nothing to read. */
function readPixel(ctx: ToolContext, at: Pt): Rgba | null {
  const x = Math.floor(at.x)
  const y = Math.floor(at.y)
  if (x < 0 || y < 0 || x >= ctx.docW || y >= ctx.docH) return null
  const id = sampleLayerId(ctx)
  if (!id) return null
  const px = ctx.readTexRect(id, x, y, 1, 1)
  if (!px || px.length < 4) return null
  return { r: px[0], g: px[1], b: px[2], a: px[3] }
}

// ════════════════════════════════════════════════════════════════════════════
// 1. Colour sampler — up to four persistent probes
// ════════════════════════════════════════════════════════════════════════════

interface SamplerPoint extends Pt { rgba: Rgba | null }

const MAX_SAMPLERS = 4
const samplers: SamplerPoint[] = []
let samplerDrag: number | null = null

/** Re-read every probe; values are live, a probe never caches a stale colour. */
function resampleAll(ctx: ToolContext): void {
  for (const s of samplers) s.rgba = readPixel(ctx, s)
}

function samplerStatus(ctx: ToolContext): void {
  if (samplers.length === 0) { ctx.setStatus(null); return }
  const parts = samplers.map((s, i) => {
    const c = s.rgba
    return c ? `#${i + 1} ${c.r},${c.g},${c.b}` : `#${i + 1} —`
  })
  ctx.setStatus(`${parts.join('  ·  ')}  (${samplers.length}/${MAX_SAMPLERS})`)
}

const paintSamplers: Painter = c => {
  for (let i = 0; i < samplers.length; i++) {
    const s = samplers[i]
    const [px, py] = samplerScreen(s)
    const x = snap(px)
    const y = snap(py)
    // Target: a ring plus a gapped cross, so the sampled pixel stays visible.
    twoPass(c, () => {
      c.beginPath()
      c.arc(x, y, 6, 0, Math.PI * 2)
      c.moveTo(x - 11, y); c.lineTo(x - 3, y)
      c.moveTo(x + 3, y);  c.lineTo(x + 11, y)
      c.moveTo(x, y - 11); c.lineTo(x, y - 3)
      c.moveTo(x, y + 3);  c.lineTo(x, y + 11)
    }, i === samplerDrag ? ACCENT : CORE)
    badge(c, x - 14, y - 14, i + 1, i === samplerDrag ? ACCENT : CORE)
    const v = s.rgba
    const text = v
      ? (v.a < 255 ? `${v.r} ${v.g} ${v.b} / ${v.a}` : `${v.r} ${v.g} ${v.b}`)
      : '—'
    // A colour chip makes the readout legible without decoding the digits.
    if (v) {
      c.fillStyle = `rgb(${v.r},${v.g},${v.b})`
      c.fillRect(x + 13, y - 4, 9, 9)
      c.lineWidth = 1
      c.strokeStyle = HALO
      c.strokeRect(x + 12.5, y - 4.5, 10, 10)
    }
    label(c, x + 26, y + 4, text)
  }
}

/**
 * Screen position of a probe. Kept as a function of the LAST context so the
 * painter — which receives only a canvas — can still project. Refreshed on every
 * pointer event, and on install, which is enough: the overlay is repainted after
 * any view change anyway.
 */
let projector: (x: number, y: number) => [number, number] = (x, y) => [x, y]
const samplerScreen = (s: Pt): [number, number] => projector(s.x, s.y)

/** Every tool refreshes the projector before touching its painter. */
function useProjector(ctx: ToolContext): void {
  projector = (x, y) => ctx.docToScreen(x, y)
}

/**
 * Probe list for the toolbox: `sampler-clear` and the `sampler-count` readout of
 * `toolDefs.ts` map straight onto it. Clearing does not repaint by itself — the
 * caller owns `repaintOverlay()`.
 */
export const samplerApi = {
  list(): readonly { x: number; y: number; rgba: Rgba | null }[] {
    return samplers.map(s => ({ x: s.x, y: s.y, rgba: s.rgba ? { ...s.rgba } : null }))
  },
  count(): number { return samplers.length },
  max(): number { return MAX_SAMPLERS },
  clear(): void { samplers.length = 0; samplerDrag = null },
}

const colorSampler: ToolHandler = {
  cursor: 'crosshair',

  onDown(ctx, p) {
    useProjector(ctx)
    const at = docPoint(ctx, p)
    const hit = pickNear(ctx, p, samplers, 11)

    if (hit >= 0 && p.altKey) {
      samplers.splice(hit, 1)          // Alt+click removes a probe
      samplerDrag = null
    } else if (hit >= 0) {
      samplerDrag = hit                // click an existing probe to move it
    } else if (samplers.length < MAX_SAMPLERS) {
      samplers.push({ ...at, rgba: null })
      samplerDrag = samplers.length - 1
    } else {
      samplerDrag = null               // four is the ceiling, like Photoshop
    }
    if (samplerDrag !== null) { samplers[samplerDrag].x = at.x; samplers[samplerDrag].y = at.y }
    resampleAll(ctx)
    samplerStatus(ctx)
    refresh(ctx, 'color-sampler', paintSamplers)
  },

  onMove(ctx, p) {
    useProjector(ctx)
    if (samplerDrag === null) {
      // Hover: nothing changes, but make sure the probes are on screen.
      if (previewOwner !== 'color-sampler') refresh(ctx, 'color-sampler', paintSamplers)
      return
    }
    const at = docPoint(ctx, p)
    samplers[samplerDrag].x = at.x
    samplers[samplerDrag].y = at.y
    resampleAll(ctx)
    samplerStatus(ctx)
    refresh(ctx, 'color-sampler', paintSamplers)
  },

  onUp(ctx) {
    useProjector(ctx)
    samplerDrag = null
    resampleAll(ctx)
    samplerStatus(ctx)
    refresh(ctx, 'color-sampler', paintSamplers)
  },

  onCancel(ctx) {
    samplerDrag = null
    refresh(ctx, 'color-sampler', paintSamplers)
  },
}

// ════════════════════════════════════════════════════════════════════════════
// 2. Ruler — distance, angle, and the angle between two lines
// ════════════════════════════════════════════════════════════════════════════
//
// Follows GIMP's compass: point 0 is the VERTEX, point 1 the end of the first
// arm, and an optional point 2 the end of a second arm. With two points the
// angle is measured against the horizontal; with three it is the angle between
// the arms, `atan2(cross, dot)` of the two radii.

let rulerPts: Pt[] = []
let rulerDrag: number | null = null
/** Shift constrains the arm to multiples of this angle. */
const RULER_SNAP_DEG = 45

/** Anchor a dragged point rotates about, for the Shift constraint. */
function rulerAnchor(index: number): Pt | null {
  if (rulerPts.length < 2) return null
  if (index === 0) return rulerPts[1]
  return rulerPts[0]
}

function rulerMeasurement(): {
  d1: number; a1: number; dx: number; dy: number; d2: number | null; a2: number | null
} | null {
  if (rulerPts.length < 2) return null
  const v1 = { x: rulerPts[1].x - rulerPts[0].x, y: rulerPts[1].y - rulerPts[0].y }
  const d1 = Math.hypot(v1.x, v1.y)
  const a1 = vecAngleDeg(v1.x, v1.y)
  if (rulerPts.length < 3) return { d1, a1, dx: v1.x, dy: v1.y, d2: null, a2: null }
  const v2 = { x: rulerPts[2].x - rulerPts[0].x, y: rulerPts[2].y - rulerPts[0].y }
  return { d1, a1, dx: v1.x, dy: v1.y, d2: Math.hypot(v2.x, v2.y), a2: angleBetweenDeg(v1, v2) }
}

function rulerStatus(ctx: ToolContext): void {
  const m = rulerMeasurement()
  if (!m) { ctx.setStatus(null); return }
  // Symbolic labels on purpose: the status line is not translated, and D/A/W/H
  // are the notations Photoshop's info panel already uses.
  let s = `D ${f2(m.d1)} px · A ${f2(m.a1)}° · W ${f2(m.dx)} · H ${f2(m.dy)}`
  if (m.d2 !== null && m.a2 !== null) s += ` · D2 ${f2(m.d2)} px · A2 ${f2(m.a2)}°`
  ctx.setStatus(s)
}

const paintRuler: Painter = c => {
  if (rulerPts.length === 0) return
  const s = rulerPts.map(p => projector(p.x, p.y))

  if (s.length >= 2) {
    twoPass(c, () => {
      c.beginPath()
      c.moveTo(snap(s[0][0]), snap(s[0][1]))
      c.lineTo(snap(s[1][0]), snap(s[1][1]))
    })
  }
  if (s.length >= 3) {
    twoPass(c, () => {
      c.beginPath()
      c.moveTo(snap(s[0][0]), snap(s[0][1]))
      c.lineTo(snap(s[2][0]), snap(s[2][1]))
    }, ACCENT)
    // Arc between the arms, drawn in screen space at a fixed radius.
    const r = Math.min(34, Math.max(16,
      Math.min(Math.hypot(s[1][0] - s[0][0], s[1][1] - s[0][1]),
               Math.hypot(s[2][0] - s[0][0], s[2][1] - s[0][1])) * 0.4))
    const a1 = Math.atan2(s[1][1] - s[0][1], s[1][0] - s[0][0])
    const a2 = Math.atan2(s[2][1] - s[0][1], s[2][0] - s[0][0])
    let sweep = a2 - a1
    while (sweep > Math.PI) sweep -= 2 * Math.PI
    while (sweep < -Math.PI) sweep += 2 * Math.PI
    twoPass(c, () => {
      c.beginPath()
      c.arc(s[0][0], s[0][1], r, a1, a1 + sweep, sweep < 0)
    })
  }

  // End handles: a square on the vertex, discs on the arms.
  for (let i = 0; i < s.length; i++) {
    const x = snap(s[i][0])
    const y = snap(s[i][1])
    twoPass(c, () => {
      c.beginPath()
      if (i === 0) c.rect(x - 4, y - 4, 8, 8)
      else c.arc(x, y, 4, 0, Math.PI * 2)
    }, i === rulerDrag ? ACCENT : CORE)
  }

  const m = rulerMeasurement()
  if (m && s.length >= 2) {
    const mx = (s[0][0] + s[1][0]) / 2
    const my = (s[0][1] + s[1][1]) / 2
    label(c, mx + 10, my - 8, `${f2(m.d1)} px  ${f2(m.a1)}°`)
    if (m.a2 !== null) label(c, s[0][0] + 12, s[0][1] + 18, `∠ ${f2(m.a2)}°`)
  }
}

export interface RulerMeasurement {
  /** Length of the first arm, in document pixels. */
  d1: number
  /** Angle of the first arm against the horizontal, degrees, CCW positive. */
  a1: number
  dx: number
  dy: number
  /** Second arm, present only once three points are placed. */
  d2: number | null
  /** Angle BETWEEN the two arms, degrees. */
  a2: number | null
}

/**
 * Ruler state for the toolbox: the `ruler-measure` readout and the `ruler-clear`
 * action of `toolDefs.ts`. `angle()` is also what a future `ruler-straighten`
 * would rotate the document by.
 */
export const rulerApi = {
  points(): readonly Pt[] { return rulerPts.map(p => ({ ...p })) },
  measurement(): RulerMeasurement | null { return rulerMeasurement() },
  angle(): number | null { return rulerMeasurement()?.a1 ?? null },
  clear(): void { rulerPts = []; rulerDrag = null },
}

const ruler: ToolHandler = {
  cursor: 'crosshair',

  onDown(ctx, p) {
    useProjector(ctx)
    const at = docPoint(ctx, p)
    const hit = pickNear(ctx, p, rulerPts, 11)

    if (p.altKey && rulerPts.length >= 2 && hit >= 0 && hit <= 1) {
      // Alt from an end point starts the SECOND arm; the grabbed end becomes the
      // vertex, exactly like GIMP's compass, so the angle is measured there.
      rulerPts = [rulerPts[hit], rulerPts[1 - hit], at]
      rulerDrag = 2
    } else if (p.altKey && rulerPts.length >= 2) {
      rulerPts = [rulerPts[0], rulerPts[1], at]
      rulerDrag = 2
    } else if (hit >= 0) {
      rulerDrag = hit
      rulerPts[hit] = at
    } else {
      rulerPts = [at, { ...at }]
      rulerDrag = 1
    }
    rulerStatus(ctx)
    refresh(ctx, 'ruler', paintRuler)
  },

  onMove(ctx, p) {
    useProjector(ctx)
    if (rulerDrag === null) {
      if (previewOwner !== 'ruler') refresh(ctx, 'ruler', paintRuler)
      return
    }
    let at = docPoint(ctx, p)
    if (p.shiftKey) {
      const anchor = rulerAnchor(rulerDrag)
      if (anchor) at = snapAngle(anchor, at, RULER_SNAP_DEG)
    }
    rulerPts[rulerDrag] = at
    rulerStatus(ctx)
    refresh(ctx, 'ruler', paintRuler)
  },

  onUp(ctx) {
    useProjector(ctx)
    rulerDrag = null
    rulerStatus(ctx)
    refresh(ctx, 'ruler', paintRuler)
  },

  onCancel(ctx) {
    rulerPts = []
    rulerDrag = null
    ctx.setStatus(null)
    refresh(ctx, 'ruler', paintRuler)
  },
}

// ════════════════════════════════════════════════════════════════════════════
// 3. Note — numbered annotation pins
// ════════════════════════════════════════════════════════════════════════════

export interface NoteRecord {
  readonly id: number
  readonly x: number
  readonly y: number
  readonly text: string
  readonly author: string
}

interface NoteItem extends Pt { id: number; text: string; author: string }

const notes: NoteItem[] = []
let noteSeq = 0
let selectedNote: number | null = null
let noteDrag: number | null = null
const noteListeners = new Set<() => void>()

const notifyNotes = (): void => { for (const fn of noteListeners) fn() }

const noteIndex = (id: number): number => notes.findIndex(n => n.id === id)

/**
 * Editing surface for a future note panel.
 *
 * LIMITATION — the editor has no text field for notes yet, so a pin created here
 * carries an EMPTY text: the tool stores it and paints the pin plus its number,
 * nothing more. When a panel lands (a `PromptDialog`, or a docked inspector) it
 * only has to import this object: `list()` to render, `selectedId()` to know
 * which pin the user last clicked, `setText()`/`setAuthor()` to fill it in, and
 * `subscribe()` to re-render. Calling `setText` marks the pin dirty; the caller
 * repaints the overlay through its own `repaintOverlay()`.
 */
export const noteApi = {
  list(): NoteRecord[] {
    return notes.map(n => ({ id: n.id, x: n.x, y: n.y, text: n.text, author: n.author }))
  },
  selectedId(): number | null { return selectedNote },
  select(id: number | null): void { selectedNote = id; notifyNotes() },
  setText(id: number, text: string): boolean {
    const i = noteIndex(id)
    if (i < 0) return false
    notes[i].text = text
    notifyNotes()
    return true
  },
  setAuthor(id: number, author: string): boolean {
    const i = noteIndex(id)
    if (i < 0) return false
    notes[i].author = author
    notifyNotes()
    return true
  },
  remove(id: number): boolean {
    const i = noteIndex(id)
    if (i < 0) return false
    notes.splice(i, 1)
    if (selectedNote === id) selectedNote = null
    notifyNotes()
    return true
  },
  clear(): void { notes.length = 0; selectedNote = null; notifyNotes() },
  subscribe(fn: () => void): () => void {
    noteListeners.add(fn)
    return () => { noteListeners.delete(fn) }
  },
}

const paintNotes: Painter = c => {
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i]
    const [px, py] = projector(n.x, n.y)
    const x = snap(px)
    const y = snap(py)
    const active = n.id === selectedNote
    // A pin: a small stem so the anchor pixel is unambiguous, then the badge.
    twoPass(c, () => {
      c.beginPath()
      c.moveTo(x, y)
      c.lineTo(x + 10, y - 12)
    }, active ? ACCENT : CORE)
    badge(c, x + 14, y - 16, i + 1, active ? ACCENT : CORE)
    if (active && n.text) label(c, x + 26, y - 12, n.text.split('\n')[0].slice(0, 48))
  }
}

function noteStatus(ctx: ToolContext): void {
  if (selectedNote === null) { ctx.setStatus(notes.length ? `${notes.length} ✎` : null); return }
  const i = noteIndex(selectedNote)
  if (i < 0) { ctx.setStatus(null); return }
  const n = notes[i]
  ctx.setStatus(`✎ ${i + 1}/${notes.length}${n.text ? ` — ${n.text.split('\n')[0].slice(0, 64)}` : ''}`)
}

const note: ToolHandler = {
  cursor: 'crosshair',

  onDown(ctx, p) {
    useProjector(ctx)
    const at = docPoint(ctx, p)
    // Pins are picked at their badge, which sits up and to the right of the anchor.
    const hit = pickNear(ctx, p, notes.map(n => {
      const [sx, sy] = ctx.docToScreen(n.x, n.y)
      const [bx, by] = ctx.screenToDoc(sx + 14, sy - 16)
      return { x: bx, y: by }
    }), 12)
    const direct = hit >= 0 ? hit : pickNear(ctx, p, notes, 10)

    if (direct >= 0 && p.altKey) {
      const [removed] = notes.splice(direct, 1)
      if (selectedNote === removed.id) selectedNote = null
      noteDrag = null
      notifyNotes()
    } else if (direct >= 0) {
      selectedNote = notes[direct].id
      noteDrag = direct
      notifyNotes()
    } else {
      notes.push({ ...at, id: ++noteSeq, text: '', author: '' })
      selectedNote = noteSeq
      noteDrag = notes.length - 1
      notifyNotes()
    }
    noteStatus(ctx)
    refresh(ctx, 'note', paintNotes)
  },

  onMove(ctx, p) {
    useProjector(ctx)
    if (noteDrag === null) {
      if (previewOwner !== 'note') refresh(ctx, 'note', paintNotes)
      return
    }
    const at = docPoint(ctx, p)
    notes[noteDrag].x = at.x
    notes[noteDrag].y = at.y
    refresh(ctx, 'note', paintNotes)
  },

  onUp(ctx) {
    useProjector(ctx)
    if (noteDrag !== null) notifyNotes()
    noteDrag = null
    noteStatus(ctx)
    refresh(ctx, 'note', paintNotes)
  },

  onCancel(ctx) {
    noteDrag = null
    selectedNote = null
    ctx.setStatus(null)
    refresh(ctx, 'note', paintNotes)
  },
}

// ════════════════════════════════════════════════════════════════════════════
// 4. Perspective crop — projective rectification of a quadrilateral
// ════════════════════════════════════════════════════════════════════════════

/** Row-major 3×3: [a b c, d e f, g h 1]. */
type Mat3 = readonly [number, number, number, number, number, number, number, number, number]

/**
 * Homography mapping the UNIT SQUARE onto a quadrilateral:
 *   (0,0) → p1   (1,0) → p2   (0,1) → p3   (1,1) → p4
 *
 * Closed form taken from GIMP's `gimp_transform_matrix_perspective()`
 * (app/core/gimp-transform-utils.c, GPLv3+). Where GIMP substitutes 1.0 for a
 * singular determinant we refuse instead: an editor that silently rectifies a
 * degenerate quad into garbage is worse than one that declines.
 */
export function perspectiveFromUnitSquare(p1: Pt, p2: Pt, p3: Pt, p4: Pt): Mat3 | null {
  const dx1 = p2.x - p4.x
  const dx2 = p3.x - p4.x
  const dx3 = p1.x - p2.x + p4.x - p3.x
  const dy1 = p2.y - p4.y
  const dy2 = p3.y - p4.y
  const dy3 = p1.y - p2.y + p4.y - p3.y

  // Affine case: the two "diagonal defects" vanish, so the quad is a parallelogram.
  if (Math.abs(dx3) < EPS && Math.abs(dy3) < EPS) {
    return [
      p2.x - p1.x, p4.x - p2.x, p1.x,
      p2.y - p1.y, p4.y - p2.y, p1.y,
      0, 0, 1,
    ]
  }

  const det2 = dx1 * dy2 - dy1 * dx2
  if (!Number.isFinite(det2) || Math.abs(det2) < EPS) return null

  const g = (dx3 * dy2 - dy3 * dx2) / det2
  const h = (dx1 * dy3 - dy1 * dx3) / det2

  const m: Mat3 = [
    p2.x - p1.x + g * p2.x, p3.x - p1.x + h * p3.x, p1.x,
    p2.y - p1.y + g * p2.y, p3.y - p1.y + h * p3.y, p1.y,
    g, h, 1,
  ]
  for (const v of m) if (!Number.isFinite(v)) return null
  return m
}

/** Apply a homography to a point in unit-square coordinates; null when it hits the vanishing line. */
function project(m: Mat3, u: number, v: number): Pt | null {
  const den = m[6] * u + m[7] * v + m[8]
  if (!Number.isFinite(den) || Math.abs(den) < 1e-12) return null
  const x = (m[0] * u + m[1] * v + m[2]) / den
  const y = (m[3] * u + m[4] * v + m[5]) / den
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null
}

/** Shoelace area, positive for the screen-space clockwise ring TL,TR,BR,BL. */
function ringArea(ring: readonly Pt[]): number {
  let a = 0
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]
    const q = ring[(i + 1) % ring.length]
    a += p.x * q.y - q.x * p.y
  }
  return a / 2
}

/**
 * Sorts four freely placed corners into the ring TL, TR, BR, BL. Sorting by the
 * angle around the centroid untangles a bow-tie click order; the rotation then
 * puts the top-left-most corner first.
 */
export function orderQuad(pts: readonly Pt[]): [Pt, Pt, Pt, Pt] | null {
  if (pts.length !== 4) return null
  const cx = (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4
  const cy = (pts[0].y + pts[1].y + pts[2].y + pts[3].y) / 4
  const sorted = [...pts].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx))
  let first = 0
  let bestScore = Infinity
  for (let i = 0; i < 4; i++) {
    const s = sorted[i].x + sorted[i].y
    if (s < bestScore) { bestScore = s; first = i }
  }
  const ring = [0, 1, 2, 3].map(i => sorted[(first + i) % 4])
  // Screen space has y downwards: a TL,TR,BR,BL ring has POSITIVE shoelace area.
  const out = ringArea(ring) < 0 ? [ring[0], ring[3], ring[2], ring[1]] : ring
  return [out[0], out[1], out[2], out[3]]
}

export interface QuadRectifyPlan {
  /** Output size in pixels, from the averaged opposite edge lengths. */
  outW: number
  outH: number
  /** Unit square → source quad. */
  matrix: Mat3
  ring: [Pt, Pt, Pt, Pt]
}

/** Why a quadrilateral cannot be rectified, or null when it can. */
export type QuadRejection = 'not-four' | 'coincident' | 'degenerate' | 'non-convex' | 'singular' | 'too-small'

/**
 * Validates a quadrilateral and derives everything the resampler needs.
 * Every guard here exists to keep a division by zero out of the sampling loop.
 */
export function planRectify(pts: readonly Pt[], maxSide = 16384): QuadRectifyPlan | QuadRejection {
  const ring = orderQuad(pts)
  if (!ring) return 'not-four'

  // 1. No two corners may coincide.
  for (let i = 0; i < 4; i++) {
    for (let j = i + 1; j < 4; j++) {
      if (Math.hypot(ring[i].x - ring[j].x, ring[i].y - ring[j].y) < 1e-6) return 'coincident'
    }
  }
  // 2. A flat quad (all four corners collinear) has no area.
  const area = Math.abs(ringArea(ring))
  if (!Number.isFinite(area) || area < 1e-6) return 'degenerate'

  // 3. Convexity: every turn of the ring must have the same sign. A folded quad
  //    maps two output regions onto one source region — nonsense to resample.
  let sign = 0
  for (let i = 0; i < 4; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % 4]
    const c = ring[(i + 2) % 4]
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
    if (Math.abs(cross) < 1e-9) return 'degenerate'
    const s = cross > 0 ? 1 : -1
    if (sign === 0) sign = s
    else if (s !== sign) return 'non-convex'
  }

  const [tl, tr, br, bl] = ring
  const top = Math.hypot(tr.x - tl.x, tr.y - tl.y)
  const bottom = Math.hypot(br.x - bl.x, br.y - bl.y)
  const left = Math.hypot(bl.x - tl.x, bl.y - tl.y)
  const right = Math.hypot(br.x - tr.x, br.y - tr.y)
  const outW = Math.round((top + bottom) / 2)
  const outH = Math.round((left + right) / 2)
  if (outW < 1 || outH < 1) return 'too-small'
  if (outW > maxSide || outH > maxSide) return 'too-small'

  // GIMP's corner naming: p1=(0,0), p2=(1,0), p3=(0,1), p4=(1,1).
  const matrix = perspectiveFromUnitSquare(tl, tr, bl, br)
  if (!matrix) return 'singular'

  // 4. The vanishing line must not cross the unit square, else the denominator
  //    changes sign somewhere inside and the sampling explodes.
  const dens = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, v]) => matrix[6] * u + matrix[7] * v + matrix[8])
  const positive = dens.every(d => d > 1e-6)
  const negative = dens.every(d => d < -1e-6)
  if (!positive && !negative) return 'singular'

  return { outW, outH, matrix, ring }
}

/**
 * Bilinear tap on straight RGBA. Interpolation runs on PREMULTIPLIED values —
 * blending straight colours across a transparent edge drags that edge's
 * arbitrary RGB into the result — and is un-premultiplied on the way out.
 * Samples outside the source contribute nothing, so the border fades to
 * transparent instead of smearing.
 */
function bilinear(src: Uint8Array, w: number, h: number, x: number, y: number, out: Uint8Array, o: number): void {
  const fx = x - 0.5
  const fy = y - 0.5
  const x0 = Math.floor(fx)
  const y0 = Math.floor(fy)
  const tx = fx - x0
  const ty = fy - y0
  let ar = 0
  let ag = 0
  let ab = 0
  let aa = 0
  for (let j = 0; j < 2; j++) {
    const yy = y0 + j
    if (yy < 0 || yy >= h) continue
    const wy = j === 0 ? 1 - ty : ty
    if (wy <= 0) continue
    for (let i = 0; i < 2; i++) {
      const xx = x0 + i
      if (xx < 0 || xx >= w) continue
      const wgt = (i === 0 ? 1 - tx : tx) * wy
      if (wgt <= 0) continue
      const s = (yy * w + xx) * 4
      const a = src[s + 3] / 255
      ar += wgt * src[s] * a
      ag += wgt * src[s + 1] * a
      ab += wgt * src[s + 2] * a
      aa += wgt * a
    }
  }
  if (aa <= 0) { out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 0; return }
  out[o] = Math.round(clamp(ar / aa, 0, 255))
  out[o + 1] = Math.round(clamp(ag / aa, 0, 255))
  out[o + 2] = Math.round(clamp(ab / aa, 0, 255))
  out[o + 3] = Math.round(clamp(aa * 255, 0, 255))
}

/**
 * Rectifies `plan`'s quadrilateral out of `src` into a fresh `outW × outH`
 * buffer. Pure: exposed so the geometry can be tested without a canvas.
 */
export function rectify(src: Uint8Array, srcW: number, srcH: number, plan: QuadRectifyPlan): Uint8Array {
  const { outW, outH, matrix } = plan
  const out = new Uint8Array(outW * outH * 4)
  for (let oy = 0; oy < outH; oy++) {
    const v = (oy + 0.5) / outH
    for (let ox = 0; ox < outW; ox++) {
      const u = (ox + 0.5) / outW
      const at = project(matrix, u, v)
      const o = (oy * outW + ox) * 4
      if (!at) continue                     // vanishing line: leave transparent
      bilinear(src, srcW, srcH, at.x, at.y, out, o)
    }
  }
  return out
}

// ── Perspective crop tool ───────────────────────────────────────────────────

const cropQuad: Pt[] = []
let cropDrag: number | null = null

const paintCropQuad: Painter = c => {
  if (cropQuad.length === 0) return
  const s = cropQuad.map(p => projector(p.x, p.y))
  const ordered = cropQuad.length === 4 ? orderQuad(cropQuad) : null

  if (ordered) {
    const r = ordered.map(p => projector(p.x, p.y))
    twoPass(c, () => {
      c.beginPath()
      c.moveTo(r[0][0], r[0][1])
      for (let i = 1; i < 4; i++) c.lineTo(r[i][0], r[i][1])
      c.closePath()
    })
    // Thirds grid, interpolated along the edges so it follows the perspective.
    for (let k = 1; k <= 2; k++) {
      const t = k / 3
      const lerp = (a: number[], b: number[]): [number, number] =>
        [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
      const top = lerp(r[0], r[1])
      const bottom = lerp(r[3], r[2])
      const left = lerp(r[0], r[3])
      const right = lerp(r[1], r[2])
      twoPass(c, () => {
        c.beginPath()
        c.moveTo(top[0], top[1]); c.lineTo(bottom[0], bottom[1])
        c.moveTo(left[0], left[1]); c.lineTo(right[0], right[1])
      }, 'rgba(255,255,255,0.55)', 1, 2)
    }
  } else if (s.length >= 2) {
    twoPass(c, () => {
      c.beginPath()
      c.moveTo(s[0][0], s[0][1])
      for (let i = 1; i < s.length; i++) c.lineTo(s[i][0], s[i][1])
    })
  }

  for (let i = 0; i < s.length; i++) {
    const x = snap(s[i][0])
    const y = snap(s[i][1])
    twoPass(c, () => { c.beginPath(); c.rect(x - 4, y - 4, 8, 8) }, i === cropDrag ? ACCENT : CORE)
  }
  if (ordered) {
    const plan = planRectify(cropQuad)
    if (typeof plan !== 'string') {
      const [cx, cy] = projector(
        (cropQuad[0].x + cropQuad[1].x + cropQuad[2].x + cropQuad[3].x) / 4,
        (cropQuad[0].y + cropQuad[1].y + cropQuad[2].y + cropQuad[3].y) / 4,
      )
      label(c, cx, cy, `${plan.outW} × ${plan.outH}`, CORE, 'center', 'middle')
    }
  }
}

function cropStatus(ctx: ToolContext): void {
  if (cropQuad.length < 4) { ctx.setStatus(`${cropQuad.length}/4`); return }
  const plan = planRectify(cropQuad)
  ctx.setStatus(typeof plan === 'string' ? `4/4 · ⚠ ${plan}` : `4/4 · ${plan.outW} × ${plan.outH} px · ⏎`)
}

/**
 * Applies the rectification to the active layer.
 *
 * LIMITATION — `ToolContext` cannot resize the document, so the rectified image
 * is written at the origin of the ACTIVE layer and anything past the document
 * border is dropped; the other layers are untouched. A true perspective crop
 * (resize the canvas, transform every layer) needs a document-level operation
 * the context does not expose.
 */
function applyCrop(ctx: ToolContext): boolean {
  if (cropQuad.length < 4) { ctx.setStatus(`${cropQuad.length}/4`); return false }
  const plan = planRectify(cropQuad)
  if (typeof plan === 'string') { ctx.setStatus(`⚠ ${plan}`); return false }

  const id = ctx.activeId
  if (!id) { ctx.setStatus('⚠ no-layer'); return false }
  const src = ctx.readTex(id)
  if (!src || src.length < ctx.docW * ctx.docH * 4) { ctx.setStatus('⚠ no-pixels'); return false }

  const warped = rectify(src, ctx.docW, ctx.docH, plan)

  // History FIRST: the snapshot must hold the pixels as they are now.
  ctx.pushUndo(id)

  const outW = Math.min(plan.outW, ctx.docW)
  const outH = Math.min(plan.outH, ctx.docH)
  const dst = new Uint8Array(ctx.docW * ctx.docH * 4)   // zero = transparent
  for (let y = 0; y < outH; y++) {
    const srcRow = y * plan.outW * 4
    const dstRow = y * ctx.docW * 4
    dst.set(warped.subarray(srcRow, srcRow + outW * 4), dstRow)
  }
  ctx.writeTex(id, dst)
  ctx.invalidate()

  cropQuad.length = 0
  cropDrag = null
  ctx.setStatus(`✓ ${outW} × ${outH} px`)
  refresh(ctx, 'crop-perspective', paintCropQuad)
  return true
}

/**
 * Corner state for the toolbox: `crop-apply` / `crop-cancel` of `toolDefs.ts`
 * map onto `apply()` / `clear()`. `apply` needs the context because it writes.
 */
export const perspectiveCropApi = {
  corners(): readonly Pt[] { return cropQuad.map(p => ({ ...p })) },
  plan(): QuadRectifyPlan | QuadRejection | null { return cropQuad.length === 4 ? planRectify(cropQuad) : null },
  apply(ctx: ToolContext): boolean { useProjector(ctx); return applyCrop(ctx) },
  clear(): void { cropQuad.length = 0; cropDrag = null },
}

const cropPerspective: ToolHandler = {
  cursor: 'crosshair',

  onDown(ctx, p) {
    useProjector(ctx)
    const at = docPoint(ctx, p)
    const hit = pickNear(ctx, p, cropQuad, 11)
    if (hit >= 0 && p.altKey && cropQuad.length === 4) {
      cropQuad.splice(hit, 1)          // Alt+click drops a corner to re-place it
      cropDrag = null
    } else if (hit >= 0) {
      cropDrag = hit
      cropQuad[hit] = at
    } else if (cropQuad.length < 4) {
      cropQuad.push(at)
      cropDrag = cropQuad.length - 1
    } else {
      cropDrag = null
    }
    cropStatus(ctx)
    refresh(ctx, 'crop-perspective', paintCropQuad)
  },

  onMove(ctx, p) {
    useProjector(ctx)
    if (cropDrag === null) {
      if (previewOwner !== 'crop-perspective') refresh(ctx, 'crop-perspective', paintCropQuad)
      return
    }
    cropQuad[cropDrag] = docPoint(ctx, p)
    cropStatus(ctx)
    refresh(ctx, 'crop-perspective', paintCropQuad)
  },

  onUp(ctx) {
    useProjector(ctx)
    cropDrag = null
    cropStatus(ctx)
    refresh(ctx, 'crop-perspective', paintCropQuad)
  },

  onDoubleClick(ctx) {
    useProjector(ctx)
    applyCrop(ctx)
  },

  onCommit(ctx) {
    useProjector(ctx)
    applyCrop(ctx)
  },

  onCancel(ctx) {
    cropQuad.length = 0
    cropDrag = null
    ctx.setStatus(null)
    refresh(ctx, 'crop-perspective', paintCropQuad)
  },
}

// ════════════════════════════════════════════════════════════════════════════
// 5 & 6. Slices — draw them, then select / move / resize / delete them
// ════════════════════════════════════════════════════════════════════════════

interface SliceRect { id: number; x: number; y: number; w: number; h: number }

const slices: SliceRect[] = []
let sliceSeq = 0
let selectedSlice: number | null = null
/** In-progress rectangle of the `slice` tool. */
let sliceDraw: { anchor: Pt; rect: SliceRect } | null = null

type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
const HANDLES: HandleId[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

/** Anchor point of a handle in document space. */
function handlePoint(r: SliceRect, h: HandleId): Pt {
  const mx = r.x + r.w / 2
  const my = r.y + r.h / 2
  switch (h) {
    case 'nw': return { x: r.x, y: r.y }
    case 'n':  return { x: mx, y: r.y }
    case 'ne': return { x: r.x + r.w, y: r.y }
    case 'e':  return { x: r.x + r.w, y: my }
    case 'se': return { x: r.x + r.w, y: r.y + r.h }
    case 's':  return { x: mx, y: r.y + r.h }
    case 'sw': return { x: r.x, y: r.y + r.h }
    case 'w':  return { x: r.x, y: my }
  }
}

const normalise = (r: SliceRect): SliceRect => ({
  id: r.id,
  x: Math.min(r.x, r.x + r.w),
  y: Math.min(r.y, r.y + r.h),
  w: Math.abs(r.w),
  h: Math.abs(r.h),
})

const sliceIndex = (id: number): number => slices.findIndex(s => s.id === id)

/** Topmost slice under a document point — later slices sit on top. */
function sliceAt(at: Pt): number {
  for (let i = slices.length - 1; i >= 0; i--) {
    const s = slices[i]
    if (at.x >= s.x && at.x <= s.x + s.w && at.y >= s.y && at.y <= s.y + s.h) return i
  }
  return -1
}

const paintSlices: Painter = c => {
  const live = sliceDraw ? [...slices, normalise(sliceDraw.rect)] : slices
  for (let i = 0; i < live.length; i++) {
    const s = live[i]
    const [x0, y0] = projector(s.x, s.y)
    const [x1, y1] = projector(s.x + s.w, s.y + s.h)
    const active = s.id === selectedSlice
    const left = snap(Math.min(x0, x1))
    const top = snap(Math.min(y0, y1))
    const w = Math.abs(x1 - x0)
    const h = Math.abs(y1 - y0)
    twoPass(c, () => { c.beginPath(); c.rect(left, top, w, h) }, active ? ACCENT : CORE)
    badge(c, left + 11, top + 11, i + 1, active ? ACCENT : CORE)
    label(c, left + 24, top + 15, `${Math.round(s.w)} × ${Math.round(s.h)}`)

    if (active) {
      for (const hid of HANDLES) {
        const hp = handlePoint(s, hid)
        const [hx, hy] = projector(hp.x, hp.y)
        const sx = snap(hx)
        const sy = snap(hy)
        c.fillStyle = CORE
        c.fillRect(sx - 3, sy - 3, 6, 6)
        c.lineWidth = 1
        c.strokeStyle = HALO
        c.strokeRect(sx - 3.5, sy - 3.5, 7, 7)
      }
    }
  }
}

function sliceStatus(ctx: ToolContext): void {
  if (sliceDraw) {
    const r = normalise(sliceDraw.rect)
    ctx.setStatus(`W ${Math.round(r.w)} · H ${Math.round(r.h)}`)
    return
  }
  if (selectedSlice !== null) {
    const i = sliceIndex(selectedSlice)
    if (i >= 0) {
      const s = slices[i]
      ctx.setStatus(`#${i + 1}/${slices.length} · X ${Math.round(s.x)} · Y ${Math.round(s.y)} · W ${Math.round(s.w)} · H ${Math.round(s.h)}`)
      return
    }
  }
  ctx.setStatus(slices.length ? `${slices.length} ▦` : null)
}

/** Slice list for a future export panel; the toolbox actions can drive it too. */
export const sliceApi = {
  list(): readonly SliceRect[] { return slices.map(s => ({ ...s })) },
  add(x: number, y: number, w: number, h: number): number {
    const s = normalise({ id: ++sliceSeq, x, y, w, h })
    slices.push(s)
    return s.id
  },
  remove(id: number): boolean {
    const i = sliceIndex(id)
    if (i < 0) return false
    slices.splice(i, 1)
    if (selectedSlice === id) selectedSlice = null
    return true
  },
  clear(): void { slices.length = 0; selectedSlice = null },
  selectedId(): number | null { return selectedSlice },
}

const MIN_SLICE = 2

const sliceTool: ToolHandler = {
  cursor: 'crosshair',

  onDown(ctx, p) {
    useProjector(ctx)
    const at = docPoint(ctx, p)
    sliceDraw = { anchor: at, rect: { id: ++sliceSeq, x: at.x, y: at.y, w: 0, h: 0 } }
    selectedSlice = null
    sliceStatus(ctx)
    refresh(ctx, 'slices', paintSlices)
  },

  onMove(ctx, p) {
    useProjector(ctx)
    if (!sliceDraw) {
      if (previewOwner !== 'slices') refresh(ctx, 'slices', paintSlices)
      return
    }
    const at = docPoint(ctx, p)
    let w = at.x - sliceDraw.anchor.x
    let h = at.y - sliceDraw.anchor.y
    if (p.shiftKey) {                       // Shift keeps the slice square
      const side = Math.min(Math.abs(w), Math.abs(h))
      w = Math.sign(w) * side
      h = Math.sign(h) * side
    }
    sliceDraw.rect.w = w
    sliceDraw.rect.h = h
    sliceStatus(ctx)
    refresh(ctx, 'slices', paintSlices)
  },

  onUp(ctx) {
    useProjector(ctx)
    if (sliceDraw) {
      const r = normalise(sliceDraw.rect)
      sliceDraw = null
      if (r.w >= MIN_SLICE && r.h >= MIN_SLICE) {
        slices.push(r)
        selectedSlice = r.id
      }
    }
    sliceStatus(ctx)
    refresh(ctx, 'slices', paintSlices)
  },

  onCancel(ctx) {
    sliceDraw = null
    ctx.setStatus(null)
    refresh(ctx, 'slices', paintSlices)
  },
}

type SliceGesture =
  | { kind: 'move'; id: number; grab: Pt; start: SliceRect }
  | { kind: 'resize'; id: number; handle: HandleId; start: SliceRect }

let sliceGesture: SliceGesture | null = null

const sliceSelect: ToolHandler = {
  cursor: 'default',

  onDown(ctx, p) {
    useProjector(ctx)
    const at = docPoint(ctx, p)

    // A handle of the selected slice wins over the slice under the pointer.
    if (selectedSlice !== null) {
      const i = sliceIndex(selectedSlice)
      if (i >= 0) {
        const s = slices[i]
        for (const hid of HANDLES) {
          if (screenDist(ctx, p, handlePoint(s, hid)) <= 7) {
            sliceGesture = { kind: 'resize', id: s.id, handle: hid, start: { ...s } }
            sliceStatus(ctx)
            refresh(ctx, 'slices', paintSlices)
            return
          }
        }
      }
    }

    const hit = sliceAt(at)
    if (hit < 0) {
      selectedSlice = null
      sliceGesture = null
    } else if (p.altKey) {
      const [gone] = slices.splice(hit, 1)   // Alt+click deletes
      if (selectedSlice === gone.id) selectedSlice = null
      sliceGesture = null
    } else {
      selectedSlice = slices[hit].id
      sliceGesture = { kind: 'move', id: slices[hit].id, grab: at, start: { ...slices[hit] } }
    }
    sliceStatus(ctx)
    refresh(ctx, 'slices', paintSlices)
  },

  onMove(ctx, p) {
    useProjector(ctx)
    if (!sliceGesture) {
      if (previewOwner !== 'slices') refresh(ctx, 'slices', paintSlices)
      return
    }
    const i = sliceIndex(sliceGesture.id)
    if (i < 0) { sliceGesture = null; return }
    const at = docPoint(ctx, p)
    const st = sliceGesture.start

    if (sliceGesture.kind === 'move') {
      const dx = at.x - sliceGesture.grab.x
      const dy = at.y - sliceGesture.grab.y
      slices[i].x = clamp(st.x + dx, 0, Math.max(0, ctx.docW - st.w))
      slices[i].y = clamp(st.y + dy, 0, Math.max(0, ctx.docH - st.h))
    } else {
      let { x, y, w, h } = st
      const h_ = sliceGesture.handle
      if (h_.includes('w')) { const nx = clamp(at.x, 0, x + w - MIN_SLICE); w += x - nx; x = nx }
      if (h_.includes('e')) { w = clamp(at.x, x + MIN_SLICE, ctx.docW) - x }
      if (h_.includes('n')) { const ny = clamp(at.y, 0, y + h - MIN_SLICE); h += y - ny; y = ny }
      if (h_.includes('s')) { h = clamp(at.y, y + MIN_SLICE, ctx.docH) - y }
      slices[i].x = x
      slices[i].y = y
      slices[i].w = w
      slices[i].h = h
    }
    sliceStatus(ctx)
    refresh(ctx, 'slices', paintSlices)
  },

  onUp(ctx) {
    useProjector(ctx)
    if (sliceGesture) {
      const i = sliceIndex(sliceGesture.id)
      if (i >= 0) slices[i] = normalise(slices[i])
    }
    sliceGesture = null
    sliceStatus(ctx)
    refresh(ctx, 'slices', paintSlices)
  },

  onCancel(ctx) {
    // Escape rolls a live move/resize back, then drops the selection.
    if (sliceGesture) {
      const i = sliceIndex(sliceGesture.id)
      if (i >= 0) slices[i] = { ...sliceGesture.start }
      sliceGesture = null
    }
    selectedSlice = null
    ctx.setStatus(null)
    refresh(ctx, 'slices', paintSlices)
  },
}

// ── Registration ────────────────────────────────────────────────────────────

registerTool('color-sampler', colorSampler)
registerTool('ruler', ruler)
registerTool('note', note)
registerTool('crop-perspective', cropPerspective)
registerTool('slice', sliceTool)
registerTool('slice-select', sliceSelect)
