// Data model of the GPU filter stage.
//
// A filter is DATA, not code: `GpuFilterDef` carries its parameters, its pass
// list and its GLSL. Adding a filter means adding a record to `registry.ts` —
// no new module, no new switch case. Filters that cannot be expressed as a
// bounded-neighbourhood fragment program declare `backend: 'worker'` and carry
// the reason, so the routing layer knows what to hand to the worker pool.

import type { GpuTexture, TextureFilter, TextureFormat, TextureWrap, UniformMap } from './device'

/** A slider surfaced by the filter dialog. Mirrors the legacy `FilterParam`. */
export interface FilterParamDef {
  key:      string
  labelKey: string
  min:      number
  max:      number
  step:     number
  def:      number
}

export const param = (
  key: string, labelKey: string, min: number, max: number, step: number, def: number,
): FilterParamDef => ({ key, labelKey, min, max, step, def })

export type ParamValues = Readonly<Record<string, number>>

/** Where a pass reads from. */
export type PassInput =
  | 'source'            // the filter's original input texture
  | 'previous'          // output of the pass immediately before
  | { pass: string }    // output of a named earlier pass (kept alive for it)

/** Context handed to a pass when its uniforms are built. */
export interface PassContext {
  readonly params: ParamValues
  /** Size of THIS pass's render target, in pixels. */
  readonly width:  number
  readonly height: number
  /** Size of the filter input, in pixels (differs inside LOD chains). */
  readonly srcWidth:  number
  readonly srcHeight: number
  /** Deterministic seed. Same seed ⇒ same pixels, on GPU and in the worker. */
  readonly seed: number
}

/** One fullscreen-quad pass. */
export interface GpuPass {
  /** Unique within the filter; referenced by `{ pass: name }` inputs. */
  readonly name: string
  /** Complete GLSL ES 3.00 fragment source (build it with `fragmentShader`). */
  readonly glsl: string
  /**
   * Program cache key. Must change whenever `glsl` changes — include every
   * `#define` permutation. Defaults to `${filterId}/${name}`.
   */
  readonly key?: string
  /** Sampler bindings. `uSrc` defaults to 'previous' when omitted. */
  readonly inputs?: Readonly<Record<string, PassInput>>
  /** Extra uniforms, on top of uSize/uTexel/uSeed which are always set. */
  readonly uniforms?: (ctx: PassContext) => UniformMap
  /** Render-target size; defaults to the filter input size. */
  readonly size?: (params: ParamValues, w: number, h: number) => readonly [number, number]
  /** Render-target sampling/format overrides. */
  readonly target?: { format?: TextureFormat; filter?: TextureFilter; wrap?: TextureWrap }
}

/** Execution route, per spec §9.1. */
export type FilterBackend =
  | 'gpu'      // fully expressible as fragment passes
  | 'worker'   // needs sorting / sequential dependency / per-pixel histogram
  | 'hybrid'   // GPU chain with one worker link (typically a median)

export interface GpuFilterDef {
  readonly id:      string
  readonly group:   string
  readonly nameKey: string
  readonly params:  readonly FilterParamDef[]
  readonly backend: FilterBackend
  /**
   * Colour space the filter's maths are defined in.
   *  - 'linear'     : operates on linear light (physically correct ops).
   *  - 'perceptual' : operates on sRGB-encoded values (legacy/Photoshop parity).
   * Documented per filter because mixing the two silently is the classic bug.
   */
  readonly space: 'linear' | 'perceptual'
  /** Why a 'worker'/'hybrid' filter is not portable. Required for those. */
  readonly reason?: string
  /**
   * Pass list for a parameter set. Absent for pure-worker filters.
   * The source size is provided because a few filters (average blur, mosaic)
   * derive their pass COUNT from it, not just their uniforms.
   */
  readonly passes?: (params: ParamValues, width: number, height: number) => readonly GpuPass[]
  /**
   * Optional lookup textures the filter needs (curves, gradient maps).
   * Uploaded by the executor and bound by name.
   */
  readonly luts?: (params: ParamValues) => Readonly<Record<string, LutData>>
}

/** A 1-D lookup table uploaded as a width×1 RGBA texture. */
export interface LutData {
  readonly width: number
  /** RGBA, width*4 entries, 0..1. */
  readonly data:  Float32Array
}

/** Result of running a filter: a texture the CALLER owns and must release. */
export interface FilterResult {
  readonly texture: GpuTexture
  /** Number of fullscreen passes actually executed (for FrameStats). */
  readonly passCount: number
}

/** Default parameter map for a filter. */
export function filterDefaults(def: GpuFilterDef): Record<string, number> {
  const v: Record<string, number> = {}
  for (const p of def.params) v[p.key] = p.def
  return v
}
