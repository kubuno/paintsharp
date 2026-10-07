// F09 "stamp" and F10 "history" tool families: clone stamp, pattern stamp,
// history brush and art history brush.
//
// ATTRIBUTION — the clone stamp's source/offset semantics are modelled on GIMP
// (GNU Image Manipulation Program), `app/paint/gimpclone.c` and
// `app/paint/gimpsourcecore.c`, GPLv3+, © Spencer Kimball, Peter Mattis and the
// GIMP contributors. The dab scattering of the art history brush follows the
// spirit of `app/paint/gimppaintbrush.c`. No GIMP code is copied verbatim: only
// the *behaviour* was studied and reimplemented in TypeScript. Kubuno ships
// under the AGPLv3, which is compatible with that provenance.
//
// The four tools share one small painting engine (`Stroke`), parameterised by a
// pixel *sampler*: "which colour does the pixel (x, y) receive?". That is the
// only thing that separates a clone from a pattern stamp from a history brush,
// so spacing, hardness, opacity/flow, selection, locks, history and preview are
// written once.
//
// PAINTING MODEL — a stroke never writes to the layer while it is in progress:
// dabs accumulate into an off-document "paint" buffer (straight RGBA whose alpha
// is the stroke coverage) that is shown live through `ctx.setPreview`. At
// pointer-up the buffer is composited over the layer in ONE pass, with the
// history entry pushed immediately BEFORE that single write. This is what lets
// the history entry be both exact (the real stroke bounding box, not the whole
// layer) and posted before any pixel is written.
import { registerTool } from './registry'
import type { ToolContext, ToolHandler, ToolPointer } from './types'

// ─────────────────────────────────────────────────────────────────────────────
// Small utilities
// ─────────────────────────────────────────────────────────────────────────────

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

/** 0..100 UI percentage → 0..1 factor. */
const pct01 = (v: number): number => clamp(v, 0, 100) / 100

/** Straight RGB triplet, 0..255. */
export type Rgb = readonly [number, number, number]

const BLACK: Rgb = [0, 0, 0]
const WHITE: Rgb = [255, 255, 255]

/** `#rgb` / `#rrggbb` → RGB triplet. Anything unparseable falls back to `def`. */
function hexToRgb(hex: string, def: Rgb): Rgb {
  const s = hex.trim().replace(/^#/, '')
  if (s.length === 3) {
    const r = parseInt(s[0] + s[0], 16), g = parseInt(s[1] + s[1], 16), b = parseInt(s[2] + s[2], 16)
    if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) return [r, g, b]
    return def
  }
  if (s.length === 6) {
    const r = parseInt(s.slice(0, 2), 16), g = parseInt(s.slice(2, 4), 16), b = parseInt(s.slice(4, 6), 16)
    if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) return [r, g, b]
    return def
  }
  return def
}

/** Deterministic PRNG (Mulberry32) — reproducible strokes make the tool testable. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Positive modulo — JS `%` keeps the sign of the dividend, tiling does not want that. */
const pmod = (v: number, m: number): number => ((v % m) + m) % m

interface BBox { x0: number; y0: number; x1: number; y1: number }

// ─────────────────────────────────────────────────────────────────────────────
// Pattern library
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A tileable pattern. `render` returns a straight-RGBA tile of `width × height`
 * pixels; the two palette colours let procedural patterns follow the current
 * foreground/background instead of being hardcoded.
 *
 * The four built-ins below are placeholders until a real pattern library (loaded
 * from `.pat` files or the document's own pattern set) exists — `registerPattern`
 * is the seam it will plug into, and nothing else in this file knows the list.
 */
export interface PatternDef {
  id: string
  width: number
  height: number
  render(fg: Rgb, bg: Rgb): Uint8Array
}

const PATTERNS = new Map<string, PatternDef>()

/** Rendered tiles, keyed by pattern id + palette, so a stroke renders one tile once. */
const tileCache = new Map<string, { def: PatternDef; px: Uint8Array }>()

/** Adds (or replaces) a pattern. The entry point for a future pattern library. */
export function registerPattern(def: PatternDef): void {
  if (def.width <= 0 || def.height <= 0) return
  PATTERNS.set(def.id, def)
  tileCache.clear()
}

export const listPatterns = (): PatternDef[] => [...PATTERNS.values()]
export const getPattern = (id: string): PatternDef | undefined => PATTERNS.get(id)

/** Writes one straight-RGBA pixel into a tile buffer. */
function put(tile: Uint8Array, i: number, c: Rgb, a: number): void {
  tile[i] = c[0]; tile[i + 1] = c[1]; tile[i + 2] = c[2]; tile[i + 3] = a
}

/** Blend two colours, `t` in 0..1. */
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
]

registerPattern({
  id: 'checker', width: 16, height: 16,
  render(fg, bg) {
    const t = new Uint8Array(16 * 16 * 4)
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const on = (x < 8) !== (y < 8)
        put(t, (y * 16 + x) * 4, on ? fg : bg, 255)
      }
    }
    return t
  },
})

registerPattern({
  id: 'stripes', width: 16, height: 16,
  render(fg, bg) {
    const t = new Uint8Array(16 * 16 * 4)
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        // 45° diagonal bands: the tile stays seamless because 16 % 8 === 0.
        put(t, (y * 16 + x) * 4, pmod(x + y, 16) < 8 ? fg : bg, 255)
      }
    }
    return t
  },
})

registerPattern({
  id: 'dots', width: 16, height: 16,
  render(fg, bg) {
    const t = new Uint8Array(16 * 16 * 4)
    const r = 4.5
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const d = Math.hypot(x + 0.5 - 8, y + 0.5 - 8)
        // One pixel of feathering keeps the dot from looking stair-stepped.
        const cover = clamp(r + 0.5 - d, 0, 1)
        put(t, (y * 16 + x) * 4, mix(bg, fg, cover), 255)
      }
    }
    return t
  },
})

registerPattern({
  id: 'noise', width: 32, height: 32,
  render(fg, bg) {
    const t = new Uint8Array(32 * 32 * 4)
    const rnd = mulberry32(0x9e3779b9)   // fixed seed → the tile is reproducible
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) put(t, (y * 32 + x) * 4, mix(bg, fg, rnd()), 255)
    }
    return t
  },
})

function tileFor(id: string, fg: Rgb, bg: Rgb): { def: PatternDef; px: Uint8Array } | null {
  const def = PATTERNS.get(id) ?? PATTERNS.get('checker')
  if (!def) return null
  const key = `${def.id}|${fg.join(',')}|${bg.join(',')}`
  const hit = tileCache.get(key)
  if (hit) return hit
  const px = def.render(fg, bg)
  if (px.length < def.width * def.height * 4) return null   // malformed pattern → ignore it
  const entry = { def, px }
  if (tileCache.size > 32) tileCache.clear()
  tileCache.set(key, entry)
  return entry
}

// ─────────────────────────────────────────────────────────────────────────────
// Options
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `ToolContext` deliberately exposes no per-tool option values, so the settings
 * of the toolbar live here and the editor pushes them in through
 * `setStampOptions` when a `ToolValues` entry changes. Every field has a sane
 * default, so the tools work as-is if nothing is ever pushed.
 */
export interface StampOptions {
  /** Clone stamp: keep the source↔brush offset across strokes ("aligned"). */
  cloneAligned: boolean
  /** Pattern stamp: tile anchored to the document origin, else to each stroke. */
  patternAligned: boolean
  /** Pattern stamp: id of the pattern to lay down. */
  patternId: string
  /** Art history: the dab-scattering style. */
  artStyle: ArtStyle
  /** Art history: stroke length in document pixels. */
  artLength: number
  /** Art history: 0 = paint everywhere, 100 = only where the layer differs most. */
  artTolerance: number
}

export type ArtStyle =
  | 'tight-short' | 'tight-medium' | 'tight-long'
  | 'loose-medium' | 'loose-long'
  | 'dab' | 'tight-curl' | 'loose-curl'

const options: StampOptions = {
  cloneAligned: true,
  patternAligned: true,
  patternId: 'checker',
  artStyle: 'tight-short',
  artLength: 50,
  artTolerance: 0,
}

/** Applies a partial update; unknown/invalid fields are ignored. */
export function setStampOptions(patch: Partial<StampOptions>): void {
  if (typeof patch.cloneAligned === 'boolean') options.cloneAligned = patch.cloneAligned
  if (typeof patch.patternAligned === 'boolean') options.patternAligned = patch.patternAligned
  if (typeof patch.patternId === 'string' && patch.patternId) options.patternId = patch.patternId
  if (patch.artStyle && ART_STYLES[patch.artStyle]) options.artStyle = patch.artStyle
  if (Number.isFinite(patch.artLength)) options.artLength = clamp(patch.artLength as number, 0, 500)
  if (Number.isFinite(patch.artTolerance)) options.artTolerance = clamp(patch.artTolerance as number, 0, 100)
}

export const getStampOptions = (): Readonly<StampOptions> => options

/**
 * Status hints. Kept here rather than in `i18n.ts` because a tool must not
 * import the module's translation table; the editor can localise them by
 * overwriting the fields once at start-up.
 */
export const STAMP_STRINGS = {
  cloneSetSource: 'Alt+clic : définir la source du tampon',
  cloneNoSource: 'Alt+clic pour définir la source avant de peindre',
  cloneSourceSet: 'Source du tampon définie',
  historyNoSnapshot: 'Instantané indisponible pour ce calque',
}

// ─────────────────────────────────────────────────────────────────────────────
// History snapshots
// ─────────────────────────────────────────────────────────────────────────────

/**
 * LIMITATION — `ToolContext` gives no read access to the undo stack, so the
 * history brushes cannot travel through the document's real history the way
 * Photoshop's history palette does. What they do instead is: the first time a
 * stroke starts on a layer, the layer's pixels are snapshotted, and every later
 * stroke paints FROM that snapshot. It is therefore a "revert to the snapshot"
 * brush, not a time machine: undoing past the snapshot, or editing a layer
 * before the first history-brush stroke, changes what "before" means.
 *
 * The snapshot is refreshed when the document geometry changes (it would no
 * longer line up) and can be re-armed on demand by the editor through
 * `captureHistorySnapshot` / `clearHistorySnapshots` — which is where a real
 * history-state picker would plug in later.
 */
interface Snapshot { px: Uint8Array; w: number; h: number }

const snapshots = new Map<string, Snapshot>()

/** (Re)arms the snapshot of a layer. Returns it, or null when it has no pixels. */
export function captureHistorySnapshot(ctx: ToolContext, layerId: string): Snapshot | null {
  const px = ctx.readTex(layerId)
  if (!px) return null
  const snap: Snapshot = { px, w: ctx.docW, h: ctx.docH }
  snapshots.set(layerId, snap)
  return snap
}

/** Drops one snapshot, or all of them. Called by the editor on document changes. */
export function clearHistorySnapshots(layerId?: string): void {
  if (layerId === undefined) snapshots.clear()
  else snapshots.delete(layerId)
}

/** The snapshot to paint from, capturing one on first use. */
function snapshotFor(ctx: ToolContext, layerId: string): Snapshot | null {
  const cur = snapshots.get(layerId)
  if (cur && cur.w === ctx.docW && cur.h === ctx.docH) return cur
  return captureHistorySnapshot(ctx, layerId)
}

// ─────────────────────────────────────────────────────────────────────────────
// Painting engine
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Answers "what colour lands on the document pixel (x, y)?".
 * Writes r,g,b,a into `out` and returns false when there is nothing to paint
 * there (source outside the document, pattern missing, tolerance rejected…).
 */
type Sampler = (x: number, y: number, out: Uint8Array) => boolean

/** How overlapping dabs combine. */
type PaintMode =
  /** Coverage grows toward the opacity ceiling; the colour is position-fixed. */
  | 'constant'
  /** Each dab composites over the previous ones — used by the art history brush. */
  | 'incremental'

interface StrokeInit {
  layerId: string
  sampler: Sampler
  mode?: PaintMode
  /** Dab spacing as a fraction of the brush diameter. */
  spacing?: number
}

/**
 * One in-progress stroke. Owns the paint buffer, the dab spacing walk, the live
 * preview and the single commit.
 */
class Stroke {
  readonly layerId: string
  private readonly docW: number
  private readonly docH: number
  /** Layer pixels as of pointer-down — the undo payload, and the commit base. */
  readonly orig: Uint8Array
  /** Accumulated paint, straight RGBA; alpha is the stroke coverage. */
  private readonly paint: Uint8Array
  private readonly sel: Uint8Array | null
  private readonly lockAlpha: boolean
  private readonly radius: number
  private readonly hardness: number
  private readonly opacity: number
  private readonly flow: number
  private readonly spacing: number
  private readonly mode: PaintMode
  private sampler: Sampler

  private bbox: BBox | null = null
  private lastX = 0
  private lastY = 0
  private carry = 0
  /** Scratch RGBA handed to the sampler — avoids one allocation per pixel. */
  private readonly rgba = new Uint8Array(4)
  /** Off-document canvas mirroring `paint`, used only for the overlay preview. */
  private previewCanvas: HTMLCanvasElement | null = null
  private previewDirty: BBox | null = null

  private constructor(ctx: ToolContext, init: StrokeInit, orig: Uint8Array, lockAlpha: boolean) {
    this.layerId = init.layerId
    this.docW = ctx.docW
    this.docH = ctx.docH
    this.orig = orig
    this.paint = new Uint8Array(this.docW * this.docH * 4)
    this.sel = ctx.selection && ctx.selection.length >= this.docW * this.docH ? ctx.selection : null
    this.lockAlpha = lockAlpha
    this.radius = Math.max(0.5, ctx.brushSize / 2)
    this.hardness = pct01(ctx.brushHardness)
    this.opacity = pct01(ctx.brushOpacity)
    this.flow = Math.max(0.02, pct01(ctx.brushFlow))
    this.mode = init.mode ?? 'constant'
    this.sampler = init.sampler
    // Spacing must stay well under the radius or a fast drag turns into a dotted
    // line; a floor of 0.75 px keeps a huge brush from stamping thousands of dabs.
    const frac = init.spacing ?? 0.12
    this.spacing = Math.max(0.75, this.radius * 2 * frac)
  }

  /**
   * Opens a stroke on `layerId`, or returns null when the layer cannot be
   * painted (missing, locked, no pixels, empty document).
   */
  static open(ctx: ToolContext, init: StrokeInit): Stroke | null {
    if (ctx.docW <= 0 || ctx.docH <= 0) return null
    const layer = ctx.layerById(init.layerId)
    if (!layer || layer.locked) return null
    const orig = ctx.readTex(init.layerId)
    if (!orig || orig.length < ctx.docW * ctx.docH * 4) return null
    return new Stroke(ctx, init, orig, !!layer.lockAlpha)
  }

  /** Swaps the sampler mid-stroke (the art history brush re-colours each flick). */
  setSampler(s: Sampler): void { this.sampler = s }

  /** True when at least one pixel was painted. */
  get touched(): boolean { return this.bbox !== null }

  // ── Dabs ──────────────────────────────────────────────────────────────────

  /** Coverage of a dab pixel at distance `d` from its centre, 0..1. */
  private falloff(d: number): number {
    const r = this.radius
    if (d >= r) return 0
    const inner = r * this.hardness
    if (d <= inner) return 1
    if (r - inner <= 1e-6) return 1
    const t = 1 - (d - inner) / (r - inner)
    return t * t * (3 - 2 * t)      // smoothstep — softer than a linear ramp
  }

  /** Stamps a single dab centred on (cx, cy). `scale` weights its alpha, 0..1. */
  stampDab(cx: number, cy: number, scale = 1): void {
    if (!(Number.isFinite(cx) && Number.isFinite(cy))) return
    const r = this.radius
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(this.docW - 1, Math.ceil(cx + r))
    const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(this.docH - 1, Math.ceil(cy + r))
    if (x1 < x0 || y1 < y0) return
    const w = clamp(scale, 0, 1)
    if (w <= 0) return

    let hit = false
    for (let y = y0; y <= y1; y++) {
      const dy = y + 0.5 - cy
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx
        const cover = this.falloff(Math.hypot(dx, dy))
        if (cover <= 0) continue
        const p = y * this.docW + x
        const i = p << 2
        // Transparency lock: a pixel that was empty before the stroke stays empty.
        if (this.lockAlpha && this.orig[i + 3] === 0) continue
        let a = cover * w * this.flow
        if (this.sel) {
          const s = this.sel[p]
          if (s === 0) continue
          a *= s / 255
        }
        if (a <= 0) continue
        if (!this.sampler(x, y, this.rgba)) continue
        const srcA = this.rgba[3] / 255
        if (srcA <= 0) continue
        a *= srcA
        if (a <= 0.0005) continue

        const prev = this.paint[i + 3] / 255
        if (this.mode === 'constant') {
          // Coverage converges toward the opacity ceiling: overlapping dabs of one
          // stroke never darken past `opacity`, which is what "opacity vs flow"
          // means in every raster editor.
          const ceil = this.opacity
          if (prev >= ceil) continue
          const na = prev + (ceil - prev) * a
          if (na <= prev) continue
          this.paint[i] = this.rgba[0]
          this.paint[i + 1] = this.rgba[1]
          this.paint[i + 2] = this.rgba[2]
          this.paint[i + 3] = Math.round(clamp(na, 0, 1) * 255)
        } else {
          const sa = a * this.opacity
          const outA = sa + prev * (1 - sa)
          if (outA <= 0.0005) continue
          this.paint[i] = Math.round((this.rgba[0] * sa + this.paint[i] * prev * (1 - sa)) / outA)
          this.paint[i + 1] = Math.round((this.rgba[1] * sa + this.paint[i + 1] * prev * (1 - sa)) / outA)
          this.paint[i + 2] = Math.round((this.rgba[2] * sa + this.paint[i + 2] * prev * (1 - sa)) / outA)
          this.paint[i + 3] = Math.round(clamp(outA, 0, 1) * 255)
        }
        hit = true
      }
    }
    if (hit) this.grow(x0, y0, x1 + 1, y1 + 1)
  }

  private grow(x0: number, y0: number, x1: number, y1: number): void {
    if (!this.bbox) this.bbox = { x0, y0, x1, y1 }
    else {
      const b = this.bbox
      if (x0 < b.x0) b.x0 = x0
      if (y0 < b.y0) b.y0 = y0
      if (x1 > b.x1) b.x1 = x1
      if (y1 > b.y1) b.y1 = y1
    }
    const d = this.previewDirty
    if (!d) this.previewDirty = { x0, y0, x1, y1 }
    else {
      if (x0 < d.x0) d.x0 = x0
      if (y0 < d.y0) d.y0 = y0
      if (x1 > d.x1) d.x1 = x1
      if (y1 > d.y1) d.y1 = y1
    }
  }

  /** Starts the spacing walk at (x, y) and stamps the first dab. */
  begin(x: number, y: number): void {
    this.lastX = x
    this.lastY = y
    this.carry = 0
    this.stampDab(x, y)
  }

  /**
   * Walks from the previous sample to (x, y), stamping dabs every `spacing`
   * document pixels so a continuous drag leaves a continuous stroke. `onDab`
   * lets a tool do its own thing at each step (the art history brush uses it).
   */
  lineTo(x: number, y: number, onDab?: (dx: number, dy: number) => void): void {
    if (!(Number.isFinite(x) && Number.isFinite(y))) return
    const dx = x - this.lastX, dy = y - this.lastY
    const dist = Math.hypot(dx, dy)
    if (dist < 1e-6) return
    const step = this.spacing
    // The walk is bounded: a huge jump (tab-out and back) must not stamp forever.
    const maxDabs = 4096
    let travelled = step - this.carry
    let n = 0
    while (travelled <= dist && n < maxDabs) {
      const t = travelled / dist
      const px = this.lastX + dx * t, py = this.lastY + dy * t
      if (onDab) onDab(px, py)
      else this.stampDab(px, py)
      travelled += step
      n++
    }
    this.carry = n >= maxDabs ? 0 : dist - (travelled - step)
    this.lastX = x
    this.lastY = y
  }

  // ── Preview ───────────────────────────────────────────────────────────────

  /**
   * Mirrors the newly painted region into the preview canvas. Silently does
   * nothing outside a browser (the Node test bench has no `document`).
   */
  private syncPreviewCanvas(): void {
    const d = this.previewDirty
    if (!d) return
    if (typeof document === 'undefined') { this.previewDirty = null; return }
    if (!this.previewCanvas) {
      const c = document.createElement('canvas')
      c.width = this.docW
      c.height = this.docH
      this.previewCanvas = c
    }
    const g = this.previewCanvas.getContext('2d')
    if (!g) { this.previewDirty = null; return }
    const w = d.x1 - d.x0, h = d.y1 - d.y0
    if (w <= 0 || h <= 0) { this.previewDirty = null; return }
    const buf = new Uint8ClampedArray(w * h * 4)
    for (let row = 0; row < h; row++) {
      const so = ((d.y0 + row) * this.docW + d.x0) * 4
      buf.set(this.paint.subarray(so, so + w * 4), row * w * 4)
    }
    g.putImageData(new ImageData(buf, w, h), d.x0, d.y0)
    this.previewDirty = null
  }

  /** The canvas holding the stroke so far, or null when there is nothing to show. */
  previewImage(): HTMLCanvasElement | null {
    this.syncPreviewCanvas()
    return this.previewCanvas
  }

  // ── Commit ────────────────────────────────────────────────────────────────

  /**
   * Composites the stroke onto the layer. The history entry is pushed FIRST,
   * with the exact bounding box, then the single `writeTexRect` lands.
   */
  commit(ctx: ToolContext): boolean {
    const b = this.bbox
    if (!b) return false
    const x0 = Math.max(0, b.x0), y0 = Math.max(0, b.y0)
    const x1 = Math.min(this.docW, b.x1), y1 = Math.min(this.docH, b.y1)
    const w = x1 - x0, h = y1 - y0
    if (w <= 0 || h <= 0) return false

    // History BEFORE any pixel is written — `orig` was read at pointer-down and
    // the layer has not been touched since, so the payload is the pre-stroke state.
    ctx.pushUndoRect(this.layerId, this.orig, { x0, y0, x1, y1 })

    const out = new Uint8Array(w * h * 4)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const si = (y * w + x) << 2
        const di = ((y0 + y) * this.docW + (x0 + x)) << 2
        const sa = this.paint[di + 3] / 255
        const dA = this.orig[di + 3] / 255
        if (sa <= 0) {
          out[si] = this.orig[di]; out[si + 1] = this.orig[di + 1]
          out[si + 2] = this.orig[di + 2]; out[si + 3] = this.orig[di + 3]
          continue
        }
        const outA = sa + dA * (1 - sa)
        if (outA <= 0.0001) { out[si] = 0; out[si + 1] = 0; out[si + 2] = 0; out[si + 3] = 0; continue }
        out[si] = Math.round((this.paint[di] * sa + this.orig[di] * dA * (1 - sa)) / outA)
        out[si + 1] = Math.round((this.paint[di + 1] * sa + this.orig[di + 1] * dA * (1 - sa)) / outA)
        out[si + 2] = Math.round((this.paint[di + 2] * sa + this.orig[di + 2] * dA * (1 - sa)) / outA)
        // Transparency lock keeps the original alpha; the colour still updates.
        out[si + 3] = this.lockAlpha ? this.orig[di + 3] : Math.round(clamp(outA, 0, 1) * 255)
      }
    }
    ctx.writeTexRect(this.layerId, x0, y0, w, h, out)
    ctx.invalidate()
    return true
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared overlay preview
// ─────────────────────────────────────────────────────────────────────────────

/** The doc→screen affine, derived from three probe points. */
function docAffine(ctx: ToolContext): [number, number, number, number, number, number] {
  const [ox, oy] = ctx.docToScreen(0, 0)
  const [xx, xy] = ctx.docToScreen(1, 0)
  const [yx, yy] = ctx.docToScreen(0, 1)
  return [xx - ox, xy - oy, yx - ox, yy - oy, ox, oy]
}

interface PreviewSpec {
  /** Brush centre, in document space. */
  cursor: { x: number; y: number } | null
  /** Clone/pattern source reticle, in document space. */
  source: { x: number; y: number } | null
  radius: number
  stroke?: HTMLCanvasElement | null
}

/**
 * Draws the brush circle, the source reticle and the in-progress stroke. Runs on
 * every overlay repaint, so it stays cheap and never allocates pixels.
 */
function makePreview(ctx: ToolContext, spec: PreviewSpec): (g: CanvasRenderingContext2D) => void {
  return (g: CanvasRenderingContext2D) => {
    const m = docAffine(ctx)
    const scale = Math.hypot(m[0], m[1]) || 1

    if (spec.stroke) {
      g.save()
      g.transform(m[0], m[1], m[2], m[3], m[4], m[5])
      g.imageSmoothingEnabled = scale < 1
      try { g.drawImage(spec.stroke, 0, 0) } catch { /* canvas not ready — skip this frame */ }
      g.restore()
    }

    if (spec.cursor) {
      const [cx, cy] = ctx.docToScreen(spec.cursor.x, spec.cursor.y)
      const r = Math.max(2, spec.radius * scale)
      g.save()
      g.lineWidth = 1
      g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2)
      g.strokeStyle = 'rgba(0,0,0,0.75)'; g.stroke()
      g.beginPath(); g.arc(cx, cy, r + 1, 0, Math.PI * 2)
      g.strokeStyle = 'rgba(255,255,255,0.75)'; g.stroke()
      g.restore()
    }

    if (spec.source) {
      const [sx, sy] = ctx.docToScreen(spec.source.x, spec.source.y)
      const arm = 7
      g.save()
      g.lineWidth = 1
      g.strokeStyle = 'rgba(255,255,255,0.9)'
      g.beginPath()
      g.moveTo(sx - arm - 1, sy); g.lineTo(sx + arm + 1, sy)
      g.moveTo(sx, sy - arm - 1); g.lineTo(sx, sy + arm + 1)
      g.stroke()
      g.strokeStyle = 'rgba(0,0,0,0.9)'
      g.beginPath()
      g.moveTo(sx - arm, sy); g.lineTo(sx + arm, sy)
      g.moveTo(sx, sy - arm); g.lineTo(sx, sy + arm)
      g.arc(sx, sy, arm - 1, 0, Math.PI * 2)
      g.stroke()
      g.restore()
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// F09-1 · Clone stamp
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Source/offset bookkeeping, straight out of GIMP's `GimpSourceCore`:
 *
 *  - Alt+click stores the source anchor and re-arms `firstStroke`.
 *  - ALIGNED (`options.cloneAligned`, the default): the offset is computed at
 *    the FIRST stroke after the anchor was set and then never changes, so every
 *    later stroke keeps cloning the same region — GIMP's `GIMP_SOURCE_ALIGN_YES`.
 *  - NON-ALIGNED: the offset is recomputed at each pointer-down, so every stroke
 *    restarts from the anchor — GIMP's `GIMP_SOURCE_ALIGN_NO` (which restores
 *    `orig_src` at the end of each stroke; recomputing at the start is the same
 *    thing seen from the other side).
 */
interface CloneState {
  /** Anchor set by Alt+click, in document space. */
  anchor: { x: number; y: number } | null
  /** Layer the anchor belongs to. */
  anchorLayer: string | null
  /** Offset applied to a painted pixel to find its source, once fixed. */
  offset: { x: number; y: number } | null
  /** True until the offset has been fixed for the current anchor (aligned mode). */
  firstStroke: boolean
}

const clone: CloneState = { anchor: null, anchorLayer: null, offset: null, firstStroke: true }

/** Exposed for the editor/tests: forgets the clone source. */
export function resetCloneSource(): void {
  clone.anchor = null
  clone.anchorLayer = null
  clone.offset = null
  clone.firstStroke = true
}

interface ActiveStroke {
  stroke: Stroke
  /** Where the source reticle sits right now, for the preview. */
  source: { x: number; y: number } | null
  /** Extra per-tool state; only the art history brush uses it. */
  art?: ArtState
}

let active: ActiveStroke | null = null

/** Ends the current gesture: clears the preview and forgets the stroke. */
function endGesture(ctx: ToolContext): void {
  active = null
  ctx.setPreview(null)
  ctx.setStatus(null)
}

/** Refreshes the overlay for the running stroke. */
function refresh(ctx: ToolContext, cursor: { x: number; y: number } | null): void {
  if (!active) return
  ctx.setPreview(makePreview(ctx, {
    cursor,
    source: active.source,
    radius: Math.max(0.5, ctx.brushSize / 2),
    stroke: active.stroke.previewImage(),
  }))
}

const cloneStamp: ToolHandler = {
  onDown(ctx, p) {
    // Alt+click sets the source and paints nothing — same gate as GIMP's
    // `set_source` branch in `gimp_source_core_paint`.
    if (p.altKey) {
      clone.anchor = { x: Math.floor(p.x), y: Math.floor(p.y) }
      clone.anchorLayer = ctx.activeId
      clone.offset = null
      clone.firstStroke = true
      ctx.setStatus(STAMP_STRINGS.cloneSourceSet)
      ctx.setPreview(makePreview(ctx, {
        cursor: { x: p.x, y: p.y }, source: clone.anchor, radius: Math.max(0.5, ctx.brushSize / 2),
      }))
      return
    }

    const layerId = ctx.activeId
    if (!layerId) return
    if (!clone.anchor) { ctx.setStatus(STAMP_STRINGS.cloneNoSource); return }

    // Offset = anchor − first painted point, fixed once in aligned mode and at
    // every stroke otherwise.
    if (!options.cloneAligned || clone.firstStroke || !clone.offset) {
      clone.offset = { x: clone.anchor.x - Math.floor(p.x), y: clone.anchor.y - Math.floor(p.y) }
      clone.firstStroke = false
    }
    const off = clone.offset

    // The source pixels are read once, before anything is written: cloning from
    // the layer being painted therefore samples the pre-stroke state and cannot
    // feed back on itself (the classic smearing bug).
    const srcLayer = clone.anchorLayer && ctx.layerById(clone.anchorLayer) ? clone.anchorLayer : layerId
    const src = ctx.readTex(srcLayer)
    if (!src || src.length < ctx.docW * ctx.docH * 4) { ctx.setStatus(STAMP_STRINGS.cloneNoSource); return }

    const docW = ctx.docW, docH = ctx.docH
    const sampler: Sampler = (x, y, out) => {
      const sx = x + off.x, sy = y + off.y
      if (sx < 0 || sy < 0 || sx >= docW || sy >= docH) return false   // outside → nothing to paint
      const i = (sy * docW + sx) << 2
      out[0] = src[i]; out[1] = src[i + 1]; out[2] = src[i + 2]; out[3] = src[i + 3]
      return true
    }

    const stroke = Stroke.open(ctx, { layerId, sampler })
    if (!stroke) return
    stroke.begin(p.x, p.y)
    active = { stroke, source: { x: p.x + off.x, y: p.y + off.y } }
    ctx.setStatus(null)
    refresh(ctx, { x: p.x, y: p.y })
  },

  onMove(ctx, p) {
    if (!active) {
      // Hover: show the brush circle, plus the anchor while it exists.
      ctx.setPreview(makePreview(ctx, {
        cursor: { x: p.x, y: p.y }, source: clone.anchor, radius: Math.max(0.5, ctx.brushSize / 2),
      }))
      return
    }
    const off = clone.offset
    active.stroke.lineTo(p.x, p.y)
    active.source = off ? { x: p.x + off.x, y: p.y + off.y } : null
    refresh(ctx, { x: p.x, y: p.y })
  },

  onUp(ctx) {
    if (!active) { ctx.setPreview(null); return }
    active.stroke.commit(ctx)
    endGesture(ctx)
  },

  onCancel(ctx) {
    // Nothing was written yet, so aborting is just dropping the paint buffer.
    endGesture(ctx)
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// F09-2 · Pattern stamp
// ─────────────────────────────────────────────────────────────────────────────

const patternStamp: ToolHandler = {
  onDown(ctx, p) {
    const layerId = ctx.activeId
    if (!layerId) return
    const fg = hexToRgb(ctx.foreground, BLACK)
    const bg = hexToRgb(ctx.background, WHITE)
    const tile = tileFor(options.patternId, fg, bg)
    if (!tile) return

    // Aligned: the mosaic is anchored to the document origin, so successive
    // strokes keep the same grid. Non-aligned: it restarts under the cursor.
    const originX = options.patternAligned ? 0 : Math.floor(p.x)
    const originY = options.patternAligned ? 0 : Math.floor(p.y)
    const { width: tw, height: th } = tile.def
    const px = tile.px
    const sampler: Sampler = (x, y, out) => {
      const i = (pmod(y - originY, th) * tw + pmod(x - originX, tw)) << 2
      out[0] = px[i]; out[1] = px[i + 1]; out[2] = px[i + 2]; out[3] = px[i + 3]
      return true
    }

    const stroke = Stroke.open(ctx, { layerId, sampler })
    if (!stroke) return
    stroke.begin(p.x, p.y)
    active = { stroke, source: null }
    refresh(ctx, { x: p.x, y: p.y })
  },

  onMove(ctx, p) {
    if (!active) {
      ctx.setPreview(makePreview(ctx, { cursor: { x: p.x, y: p.y }, source: null, radius: Math.max(0.5, ctx.brushSize / 2) }))
      return
    }
    active.stroke.lineTo(p.x, p.y)
    refresh(ctx, { x: p.x, y: p.y })
  },

  onUp(ctx) {
    if (!active) { ctx.setPreview(null); return }
    active.stroke.commit(ctx)
    endGesture(ctx)
  },

  onCancel(ctx) { endGesture(ctx) },
}

// ─────────────────────────────────────────────────────────────────────────────
// F10-1 · History brush
// ─────────────────────────────────────────────────────────────────────────────

const historyBrush: ToolHandler = {
  onDown(ctx, p) {
    const layerId = ctx.activeId
    if (!layerId) return
    const snap = snapshotFor(ctx, layerId)
    if (!snap) { ctx.setStatus(STAMP_STRINGS.historyNoSnapshot); return }

    const docW = ctx.docW
    const src = snap.px
    const sampler: Sampler = (x, y, out) => {
      const i = (y * docW + x) << 2
      out[0] = src[i]; out[1] = src[i + 1]; out[2] = src[i + 2]; out[3] = src[i + 3]
      return true
    }

    const stroke = Stroke.open(ctx, { layerId, sampler })
    if (!stroke) return
    stroke.begin(p.x, p.y)
    active = { stroke, source: null }
    ctx.setStatus(null)
    refresh(ctx, { x: p.x, y: p.y })
  },

  onMove(ctx, p) {
    if (!active) {
      ctx.setPreview(makePreview(ctx, { cursor: { x: p.x, y: p.y }, source: null, radius: Math.max(0.5, ctx.brushSize / 2) }))
      return
    }
    active.stroke.lineTo(p.x, p.y)
    refresh(ctx, { x: p.x, y: p.y })
  },

  onUp(ctx) {
    if (!active) { ctx.setPreview(null); return }
    active.stroke.commit(ctx)
    endGesture(ctx)
  },

  onCancel(ctx) { endGesture(ctx) },
}

// ─────────────────────────────────────────────────────────────────────────────
// F10-2 · Art history brush
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Style presets. `len` scales the configured stroke length, `curl` is how much a
 * flick bends per dab (radians) and `jitter` how far the flick's starting point
 * wanders off the pointer path — the scattering idea comes from GIMP's
 * `gimp_paintbrush_paint` jitter, retuned for short painterly touches.
 */
const ART_STYLES: Record<ArtStyle, { len: number; curl: number; jitter: number }> = {
  'dab':          { len: 0.00, curl: 0.00, jitter: 0.15 },
  'tight-short':  { len: 0.35, curl: 0.06, jitter: 0.10 },
  'tight-medium': { len: 0.70, curl: 0.06, jitter: 0.10 },
  'tight-long':   { len: 1.20, curl: 0.06, jitter: 0.10 },
  'loose-medium': { len: 0.70, curl: 0.02, jitter: 0.45 },
  'loose-long':   { len: 1.20, curl: 0.02, jitter: 0.45 },
  'tight-curl':   { len: 0.70, curl: 0.28, jitter: 0.10 },
  'loose-curl':   { len: 1.20, curl: 0.28, jitter: 0.45 },
}

interface ArtState {
  snap: Snapshot
  orig: Uint8Array
  rnd: () => number
  /** Squared RGB distance under which a pixel is left alone. */
  tol2: number
}

/** Seed of the next art history stroke; exported so tests are reproducible. */
let artSeed = 0x1a2b3c4d
export function setArtHistorySeed(seed: number): void { artSeed = seed >>> 0 }

/**
 * Lays one short painterly flick starting at (x, y): a run of dabs walking along
 * a random direction that slowly curls, all painted with the single colour the
 * snapshot holds at the flick's origin. That flat colour is what makes the
 * result look brushed rather than like a plain snapshot restore.
 */
function artFlick(ctx: ToolContext, st: ArtState, stroke: Stroke, x: number, y: number): void {
  const style = ART_STYLES[options.artStyle]
  const docW = ctx.docW, docH = ctx.docH
  const radius = Math.max(0.5, ctx.brushSize / 2)

  // Origin of the flick, jittered off the pointer path.
  const jr = radius * style.jitter * 2
  const ox = clamp(Math.floor(x + (st.rnd() - 0.5) * jr), 0, docW - 1)
  const oy = clamp(Math.floor(y + (st.rnd() - 0.5) * jr), 0, docH - 1)

  const si = (oy * docW + ox) << 2
  const cr = st.snap.px[si], cg = st.snap.px[si + 1], cb = st.snap.px[si + 2], ca = st.snap.px[si + 3]
  if (ca === 0) return                       // nothing recorded there → no touch

  // Tolerance: only pixels whose CURRENT colour is far enough from the snapshot
  // get repainted. Photoshop's rule — with a high tolerance an untouched layer
  // shows nothing, because nothing differs from the source state yet.
  const tol2 = st.tol2
  const orig = st.orig
  const snapPx = st.snap.px
  stroke.setSampler((px, py, out) => {
    if (tol2 > 0) {
      const i = (py * docW + px) << 2
      const dr = orig[i] - snapPx[i], dg = orig[i + 1] - snapPx[i + 1], db = orig[i + 2] - snapPx[i + 2]
      if (dr * dr + dg * dg + db * db < tol2) return false
    }
    out[0] = cr; out[1] = cg; out[2] = cb; out[3] = ca
    return true
  })

  const length = clamp(options.artLength, 0, 500) * style.len
  const step = Math.max(0.75, radius * 0.5)
  const count = clamp(Math.round(length / step), 1, 128)   // bounded: no runaway flick
  let ang = st.rnd() * Math.PI * 2
  const spin = (st.rnd() < 0.5 ? -1 : 1) * style.curl
  let cx = ox + 0.5, cy = oy + 0.5
  for (let i = 0; i < count; i++) {
    // Taper the tail so a flick ends softly instead of stopping square.
    const w = count === 1 ? 1 : 1 - 0.55 * (i / (count - 1))
    stroke.stampDab(cx, cy, w)
    ang += spin
    cx += Math.cos(ang) * step
    cy += Math.sin(ang) * step
    if (cx < -radius || cy < -radius || cx > docW + radius || cy > docH + radius) break
  }
}

const artHistoryBrush: ToolHandler = {
  onDown(ctx, p) {
    const layerId = ctx.activeId
    if (!layerId) return
    const snap = snapshotFor(ctx, layerId)
    if (!snap) { ctx.setStatus(STAMP_STRINGS.historyNoSnapshot); return }

    // Incremental mode: each flick lays its own flat colour over the previous
    // ones, which is what builds the impasto look.
    const stroke = Stroke.open(ctx, {
      layerId,
      sampler: () => false,          // replaced by every flick
      mode: 'incremental',
      spacing: 0.5,                  // flicks, not a solid line → sparser anchors
    })
    if (!stroke) return
    const tol = pct01(options.artTolerance) * 441.67   // 441.67 = max RGB distance
    const st: ArtState = { snap, orig: stroke.orig, rnd: mulberry32(artSeed), tol2: tol * tol }
    active = { stroke, source: null, art: st }
    artFlick(ctx, st, stroke, p.x, p.y)
    ctx.setStatus(null)
    refresh(ctx, { x: p.x, y: p.y })
  },

  onMove(ctx, p) {
    if (!active || !active.art) {
      ctx.setPreview(makePreview(ctx, { cursor: { x: p.x, y: p.y }, source: null, radius: Math.max(0.5, ctx.brushSize / 2) }))
      return
    }
    const st = active.art
    const stroke = active.stroke
    stroke.lineTo(p.x, p.y, (dx, dy) => artFlick(ctx, st, stroke, dx, dy))
    refresh(ctx, { x: p.x, y: p.y })
  },

  onUp(ctx) {
    if (!active) { ctx.setPreview(null); return }
    active.stroke.commit(ctx)
    endGesture(ctx)
  },

  onCancel(ctx) { endGesture(ctx) },
}

// ─────────────────────────────────────────────────────────────────────────────

registerTool('clone-stamp', cloneStamp)
registerTool('pattern-stamp', patternStamp)
registerTool('history-brush', historyBrush)
registerTool('art-history-brush', artHistoryBrush)

/** Test/integration surface — the editor never needs these to run the tools. */
export const __stampInternals = { cloneStamp, patternStamp, historyBrush, artHistoryBrush }

// `ToolPointer` is part of the public shape of the handlers above; re-exporting
// the type keeps the bench and the editor from importing `./types` themselves.
export type { ToolPointer }
