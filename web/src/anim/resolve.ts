// Normalise an AnimDoc against a target container's capabilities.
//
// One function, testable on its own, instead of three encoders each improvising
// their own workarounds. Everything a format cannot express is resolved here by
// flattening — which is always correct, because the compositor is the reference.

import { flatten } from './compositor.ts'
import type { AnimDoc, CommonEncodeOptions, FormatCaps } from './types.ts'

/** Apply range selection and uniform delay. Cheap, no pixel work. */
export function applyCommonOptions(doc: AnimDoc, opts: CommonEncodeOptions): AnimDoc {
  let frames = doc.frames
  if (opts.range) {
    const from = Math.max(0, Math.min(frames.length - 1, opts.range.from | 0))
    const to = Math.max(from, Math.min(frames.length - 1, opts.range.to | 0))
    frames = frames.slice(from, to + 1)
    // A sliced range no longer starts from the original canvas state; flattening
    // is done by the caller through resolveForTarget(), which handles it.
  }
  if (opts.uniformDelayMs !== undefined) {
    const d = Math.max(0, Math.round(opts.uniformDelayMs))
    frames = frames.map((f) => ({ ...f, delayMs: d }))
  }
  if (frames === doc.frames) return doc
  return { ...doc, frames, loop: opts.loop ?? doc.loop }
}

/**
 * Returns a document whose frames every encoder can write as-is: full canvas,
 * 'none' disposal, 'source' blend, delays quantised to the container's unit.
 *
 * Flattening is unconditional on purpose. The encoders re-derive their own
 * (much better informed) disposal and rectangles in `optimize.ts`, from the
 * composited state — deriving them from a half-resolved document instead is how
 * subtle one-frame-off bugs get in.
 */
export function resolveForTarget(doc: AnimDoc, caps: FormatCaps, opts: CommonEncodeOptions = {}): AnimDoc {
  const ranged = applyCommonOptions(doc, opts)
  const flat = flatten(ranged)
  const q = Math.max(1, caps.delayQuantumMs)
  for (const f of flat.frames) {
    // Quantise to the container's delay unit so that what we write is exactly
    // what a decoder will read back — otherwise every round-trip drifts.
    f.delayMs = Math.round(f.delayMs / q) * q
  }
  flat.loop = normaliseLoop(opts.loop ?? doc.loop)
  return flat
}

export function normaliseLoop(loop: number): number {
  if (!Number.isFinite(loop) || loop < 0) return 0
  return Math.min(0xffff, Math.round(loop))
}
