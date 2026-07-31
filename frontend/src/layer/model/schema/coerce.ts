// Tolerant scalar readers.
//
// Every reader takes an `unknown` and always returns a usable value. A wrong
// type or an out-of-range number produces the default plus a warning; it never
// throws and never propagates `NaN`, which is the failure mode that turns a
// single bad field into an unopenable document.

import type { LayerColorLabel, Mat2x3, RGBA, RectI } from '../types.ts'
import { MAT_IDENTITY } from '../types.ts'
import type { WarningSink } from './warnings.ts'

/** A node exactly as it appears in the JSON file: untyped and untrusted. */
export type RawNode = Record<string, unknown>

export function isRecord(v: unknown): v is RawNode {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export interface Ctx {
  sink: WarningSink
  /** Id of the node being read, for warning attribution. */
  layerId?: string
}

export function readString(v: unknown, fallback: string, ctx?: Ctx, field?: string): string {
  if (typeof v === 'string') return v
  if (v === undefined || v === null) return fallback
  ctx?.sink.debug('field.type', `Expected string for "${field ?? '?'}"`, ctx.layerId, field)
  return fallback
}

export function readBool(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v
  // A surprising number of legacy documents carry 0/1 or "true"/"false".
  if (v === 0 || v === '0' || v === 'false') return false
  if (v === 1 || v === '1' || v === 'true') return true
  return fallback
}

export function readNumber(v: unknown, fallback: number, ctx?: Ctx, field?: string): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  if (v !== undefined && v !== null) {
    ctx?.sink.debug('field.type', `Expected number for "${field ?? '?'}"`, ctx.layerId, field)
  }
  return fallback
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/** Reads a number and clamps it to `[lo, hi]`, warning when it had to clamp. */
export function readRange(
  v: unknown, lo: number, hi: number, fallback: number, ctx?: Ctx, field?: string,
): number {
  const n = readNumber(v, fallback, ctx, field)
  const c = clamp(n, lo, hi)
  if (c !== n) {
    ctx?.sink.debug('field.range', `"${field ?? '?'}" = ${n} clamped to ${c}`, ctx.layerId, field)
  }
  return c
}

export function readInt(v: unknown, lo: number, hi: number, fallback: number, ctx?: Ctx, field?: string): number {
  return Math.round(readRange(v, lo, hi, fallback, ctx, field))
}

export function readArray(v: unknown): unknown[] | null {
  return Array.isArray(v) ? v : null
}

export function readEnum<T extends string>(
  v: unknown, allowed: readonly T[], fallback: T, ctx?: Ctx, field?: string,
): T {
  if (typeof v === 'string' && (allowed as readonly string[]).includes(v)) return v as T
  if (v !== undefined && v !== null) {
    ctx?.sink.debug('field.enum', `Unknown "${field ?? '?'}" value ${JSON.stringify(v)}`, ctx.layerId, field)
  }
  return fallback
}

export function readRect(v: unknown, fallback: RectI, ctx?: Ctx, field?: string): RectI {
  if (!isRecord(v)) return { ...fallback }
  return {
    x: readNumber(v.x, fallback.x, ctx, field),
    y: readNumber(v.y, fallback.y, ctx, field),
    w: readNumber(v.w, fallback.w, ctx, field),
    h: readNumber(v.h, fallback.h, ctx, field),
  }
}

const HEX_RE = /^#?([0-9a-f]{3,8})$/i

/** Accepts `{r,g,b,a}` (0..255) or a `#rgb` / `#rrggbb` / `#rrggbbaa` string. */
export function readColor(v: unknown, fallback: RGBA, ctx?: Ctx, field?: string): RGBA {
  if (isRecord(v)) {
    return {
      r: readInt(v.r, 0, 255, fallback.r, ctx, field),
      g: readInt(v.g, 0, 255, fallback.g, ctx, field),
      b: readInt(v.b, 0, 255, fallback.b, ctx, field),
      a: readInt(v.a, 0, 255, fallback.a, ctx, field),
    }
  }
  if (typeof v === 'string') {
    const parsed = parseHexColor(v)
    if (parsed) return parsed
  }
  return { ...fallback }
}

export function parseHexColor(s: string): RGBA | null {
  const m = HEX_RE.exec(s.trim())
  if (!m) return null
  let h = m[1]
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  if (h.length === 6) h += 'ff'
  if (h.length !== 8) return null
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
    a: parseInt(h.slice(6, 8), 16),
  }
}

export function readMat2x3(v: unknown, fallback: Mat2x3 = MAT_IDENTITY): Mat2x3 {
  const a = readArray(v)
  if (!a || a.length !== 6) return fallback
  const out: number[] = []
  for (let i = 0; i < 6; i++) {
    const n = a[i]
    if (typeof n !== 'number' || !Number.isFinite(n)) return fallback
    out.push(n)
  }
  return out as unknown as Mat2x3
}

// ── Colour labels ────────────────────────────────────────────────────────────

/**
 * The v1 format stored a free-form hex in `colorLabel`. Photoshop exposes seven
 * named colours plus "none"; a hard-coded hex breaks dark mode and the module
 * accent, so the model stores the name and the theme decides the pixel value.
 */
export const COLOR_LABEL_HEX: Record<Exclude<LayerColorLabel, 'none'>, string> = {
  red: '#ef4444',
  orange: '#f59e0b',
  yellow: '#eab308',
  green: '#22c55e',
  blue: '#3b82f6',
  violet: '#a855f7',
  gray: '#9ca3af',
}

const LABEL_RGB: [LayerColorLabel, RGBA][] = (
  Object.entries(COLOR_LABEL_HEX) as [Exclude<LayerColorLabel, 'none'>, string][]
).map(([k, hex]) => [k, parseHexColor(hex) as RGBA])

/** Nearest named label for an arbitrary hex, in plain RGB distance. */
export function nearestColorLabel(v: unknown): LayerColorLabel {
  if (typeof v !== 'string' || v.trim() === '' || v === 'none') return 'none'
  const c = parseHexColor(v)
  if (!c) {
    // Already a name? Accept it directly, that is the v2 spelling.
    const name = v.toLowerCase()
    const known = LABEL_RGB.find(([k]) => k === name)
    return known ? known[0] : 'none'
  }
  let best: LayerColorLabel = 'none'
  let bestD = Number.POSITIVE_INFINITY
  for (const [name, ref] of LABEL_RGB) {
    const d = (c.r - ref.r) ** 2 + (c.g - ref.g) ** 2 + (c.b - ref.b) ** 2
    if (d < bestD) { bestD = d; best = name }
  }
  return best
}

export function colorLabelToHex(label: LayerColorLabel): string | undefined {
  return label === 'none' ? undefined : COLOR_LABEL_HEX[label]
}

// ── Opacity units ────────────────────────────────────────────────────────────
//
// On disk `opacity` and `fill` stay 0..100 (v1 semantics, never changed — an old
// client reading `opacity: 255` would display "255 %"). In memory they are
// 0..255 like the PSD format. The exact 0..255 value also travels, under the new
// name `opacity255`, so a round trip is lossless.

export const pctToByte = (p: number): number => Math.round(clamp(p, 0, 100) * 255 / 100)
export const byteToPct = (b: number): number => Math.round(clamp(b, 0, 255) * 100 / 255)
