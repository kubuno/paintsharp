// Container-agnostic animation model shared by every codec of `src/anim/`.
//
// This file is the contract: every decoder produces an `AnimDoc`, every encoder
// consumes one. Nothing here depends on React, on `@kubuno/*` or on the DOM, so
// the whole library can run inside a Web Worker or a plain Node test harness.

/**
 * What the decoder must do with the frame's rectangle AFTER the frame has been
 * displayed, in order to prepare the next one.
 *
 * The three animated containers agree on the semantics, only the names differ:
 *   GIF  disposal 0 (unspecified) / 1 (do not dispose) -> 'none'
 *   GIF  disposal 2 (restore to background)            -> 'background'
 *   GIF  disposal 3 (restore to previous)              -> 'previous'
 *   APNG dispose_op 0 NONE / 1 BACKGROUND / 2 PREVIOUS
 *   WebP ANMF `D` flag: 0 -> 'none', 1 -> 'background' (no 'previous' at all)
 */
export type Disposal = 'none' | 'background' | 'previous'

/**
 * How the frame's pixels are combined with what is already on the canvas.
 *   'over'   standard source-over compositing (APNG blend_op OVER, WebP B = 0)
 *   'source' the frame's RGBA replaces the rectangle, alpha included
 *            (APNG blend_op SOURCE, WebP B = 1). GIF cannot express it.
 */
export type Blend = 'over' | 'source'

/** Which container the document came from, or 'layer' when authored in-app. */
export type AnimSource = 'gif' | 'apng' | 'png' | 'webp' | 'avif' | 'layer'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * A plain RGBA8 raster. Structurally a superset-compatible view of the DOM's
 * `ImageData` (an `ImageData` is assignable to this, not the other way round),
 * which lets callers pass `ImageData` straight in while we stay DOM-free.
 */
export interface RgbaImage {
  width: number
  height: number
  data: Uint8ClampedArray
}

export interface AnimFrame {
  /** Sub-rectangle this frame actually carries; may be the whole canvas. */
  rect: Rect
  /** RGBA8 for `rect` only — length is exactly rect.w * rect.h * 4. */
  pixels: Uint8ClampedArray
  /** Authored delay in ms, never clamped. Playback clamping is playbackDelayMs(). */
  delayMs: number
  disposal: Disposal
  blend: Blend
}

export interface AnimDoc {
  width: number
  height: number
  /** 0 = loop forever, 1 = play once, n = play n times. */
  loop: number
  frames: AnimFrame[]
  source: AnimSource
  /** True when the container ended early; the frames decoded so far are still valid. */
  truncated?: boolean
}

/** Cheap container metadata, no pixel decoding. Used for import budgeting. */
export interface AnimInfo {
  format: AnimSource | 'still'
  width: number
  height: number
  frameCount: number
  loop: number
  /** Decoded RGBA byte cost: width * height * 4 * frameCount. */
  estimatedBytes: number
  /** True when the container is animated (more than one frame). */
  animated: boolean
}

// ── Palettes ────────────────────────────────────────────────────────────────

/**
 * An indexed palette. `rgb` holds `size` RGB triplets packed as r,g,b,r,g,b…
 * `transparentIndex` is -1 when the palette carries no transparent entry; when
 * it is >= 0 that entry's RGB is meaningless and must never be drawn.
 */
export interface Palette {
  rgb: Uint8Array
  size: number
  transparentIndex: number
}

export type QuantizerKind = 'medianCut' | 'octree' | 'exact'
export type DitherKind = 'bayer' | 'floydSteinberg' | 'none'
export type PaletteMode = 'global' | 'auto' | 'local'

// ── Per-format capabilities ─────────────────────────────────────────────────

/**
 * What a container can express. Kept as a table rather than as `if (format ===
 * 'gif')` branches scattered through the encoders; `resolveForTarget()` is the
 * single place that normalises an AnimDoc against one of these.
 */
export interface FormatCaps {
  /** Can encode disposal 'previous'. WebP cannot. */
  previousDisposal: boolean
  /** Can encode blend 'source'. GIF cannot (it is always 'over'). */
  sourceBlend: boolean
  /** 'binary' = one fully transparent palette index, 'full' = real alpha channel. */
  alpha: 'binary' | 'full'
  /** Quantum of the delay field in ms (GIF: 10, APNG/WebP: 1). */
  delayQuantumMs: number
  /** Frame offsets must be a multiple of this (WebP ANMF stores x/y in 2-px units). */
  offsetGranularity: number
}

export const GIF_CAPS: FormatCaps = {
  previousDisposal: true,
  sourceBlend: false,
  alpha: 'binary',
  delayQuantumMs: 10,
  offsetGranularity: 1,
}

export const APNG_CAPS: FormatCaps = {
  previousDisposal: true,
  sourceBlend: true,
  alpha: 'full',
  delayQuantumMs: 1,
  offsetGranularity: 1,
}

export const WEBP_CAPS: FormatCaps = {
  previousDisposal: false,
  sourceBlend: true,
  alpha: 'full',
  delayQuantumMs: 1,
  offsetGranularity: 2,
}

// ── Encoding options ────────────────────────────────────────────────────────

export interface CommonEncodeOptions {
  /** 0 = loop forever. Defaults to the document's own loop count. */
  loop?: number
  /** Inter-frame optimisation (coalescing + minimal diff rect). Default true. */
  optimize?: boolean
  /** Replace every frame delay by this value, in ms. */
  uniformDelayMs?: number
  /** Inclusive frame range to export. */
  range?: { from: number; to: number }
  signal?: AbortSignal
  onProgress?: (done: number, total: number, phase: EncodePhase) => void
}

export type EncodePhase = 'composite' | 'palette' | 'encode' | 'assemble'

export interface GifEncodeOptions extends CommonEncodeOptions {
  /** 2..256. Default 256. */
  colors?: number
  quantizer?: QuantizerKind
  palette?: PaletteMode
  dither?: DitherKind
  /** 0..100. Default 75. */
  ditherStrength?: number
  /** Source alpha below this becomes fully transparent. Default 128. */
  alphaThreshold?: number
  /** Colour semi-transparent pixels are matted against before thresholding. */
  matte?: [number, number, number]
}

export interface ApngEncodeOptions extends CommonEncodeOptions {
  /** 'auto' picks indexed when the document has <= 256 distinct colours. */
  indexed?: boolean | 'auto'
  /** Options used only when the indexed path is taken. */
  colors?: number
  quantizer?: QuantizerKind
  dither?: DitherKind
  ditherStrength?: number
}

export interface WebpEncodeOptions extends CommonEncodeOptions {
  /** 1..100, or 'lossless'. Default 80. */
  quality?: number | 'lossless'
}

export interface DecodeOptions {
  /** Use the browser's ImageDecoder for pixels when it supports the type. */
  preferImageDecoder?: boolean
  /** Hard cap on decoded RGBA bytes; decoding stops (truncated) beyond it. */
  maxBytes?: number
  signal?: AbortSignal
}

// ── Small helpers on the model ──────────────────────────────────────────────

/**
 * Delay to use for PLAYBACK only — never for storage, never for re-encoding.
 * Browsers clamp GIF delays of 0 and 10 ms up to 100 ms, and every player has
 * followed suit for twenty-five years. The authored value stays untouched in
 * `AnimFrame.delayMs` so a round-trip does not silently retime the animation.
 */
export function playbackDelayMs(delayMs: number): number {
  if (!Number.isFinite(delayMs) || delayMs <= 10) return 100
  return delayMs
}

export function emptyRect(r: Rect): boolean {
  return r.w <= 0 || r.h <= 0
}

/** Total duration of one loop, using authored delays. */
export function animDurationMs(doc: AnimDoc): number {
  let total = 0
  for (const f of doc.frames) total += f.delayMs
  return total
}
