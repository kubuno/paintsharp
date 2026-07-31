// Pass executor: turns a `GpuFilterDef` into draw calls on a `GLDeviceLike`.
//
// Intentionally dumb and allocation-free in steady state: the pass list is
// walked once, intermediate targets come from a `TexturePool`, and everything
// but the final texture is returned to the pool before the call returns.

import { TexturePool } from './device'
import type { GLDeviceLike, GpuTexture, UniformMap, UniformValue } from './device'
import type { FilterResult, GpuFilterDef, GpuPass, LutData, ParamValues, PassContext, PassInput } from './types'

export interface RunOptions {
  /** Deterministic seed (undo replay must reproduce the exact pixels). */
  seed?: number
  /** Pool to draw intermediates from; one is created and disposed if absent. */
  pool?: TexturePool
}

function resolveInput(
  spec: PassInput,
  source: GpuTexture,
  previous: GpuTexture,
  named: ReadonlyMap<string, GpuTexture>,
  passName: string,
): GpuTexture {
  if (spec === 'source') return source
  if (spec === 'previous') return previous
  const t = named.get(spec.pass)
  if (!t) throw new Error(`filter pass "${passName}": unknown input pass "${spec.pass}"`)
  return t
}

/** Upload a 1-D LUT as a width×1 RGBA texture with linear filtering. */
export function uploadLut(device: GLDeviceLike, lut: LutData): GpuTexture {
  return device.createTexture(lut.width, 1, { format: 'rgba16f', filter: 'linear', wrap: 'clamp' }, lut.data)
}

/**
 * Run a filter. The returned texture belongs to the caller: release it through
 * the pool that was passed in, or delete it if none was.
 */
export function runGpuFilter(
  device: GLDeviceLike,
  def: GpuFilterDef,
  params: ParamValues,
  source: GpuTexture,
  opts: RunOptions = {},
): FilterResult {
  if (!def.passes) throw new Error(`filter "${def.id}" has no GPU passes (backend=${def.backend})`)
  const passes = def.passes(params, source.width, source.height)
  if (passes.length === 0) throw new Error(`filter "${def.id}" produced an empty pass list`)

  const ownPool = !opts.pool
  const pool = opts.pool ?? new TexturePool(device)
  const seed = opts.seed ?? 0x9e3779b1

  const lutSpecs = def.luts?.(params)
  const lutTextures = new Map<string, GpuTexture>()
  if (lutSpecs) for (const [name, lut] of Object.entries(lutSpecs)) lutTextures.set(name, uploadLut(device, lut))

  const named = new Map<string, GpuTexture>()
  // Textures that may be recycled once no later pass references them.
  const recyclable = new Set<GpuTexture>()
  let previous = source

  try {
    for (let i = 0; i < passes.length; i++) {
      const pass = passes[i]
      const last = i === passes.length - 1
      const [w, h] = pass.size ? pass.size(params, source.width, source.height) : [source.width, source.height]
      const target = pool.acquire(w, h, pass.target)

      const ctx: PassContext = {
        params, width: w, height: h,
        srcWidth: source.width, srcHeight: source.height, seed,
      }

      const uniforms: Record<string, UniformValue> = {
        uSize:  [w, h],
        uTexel: [1 / w, 1 / h],
        uSeed:  seed,
        ...(pass.uniforms ? pass.uniforms(ctx) : {}),
      }
      // Sampler bindings. `uSrc` defaults to the previous pass output.
      const inputs = pass.inputs ?? { uSrc: 'previous' as PassInput }
      for (const [name, spec] of Object.entries(inputs)) {
        uniforms[name] = resolveInput(spec, source, previous, named, pass.name)
      }
      if (!('uSrc' in uniforms)) uniforms.uSrc = previous
      for (const [name, tex] of lutTextures) uniforms[name] = tex

      const program = device.getProgram(pass.key ?? `${def.id}/${pass.name}`, pass.glsl)
      device.bindTarget(target)
      device.drawQuad(program, uniforms as UniformMap)

      named.set(pass.name, target)
      if (previous !== source && !isReferencedLater(passes, i + 1, named, previous)) {
        pool.release(previous)
        recyclable.delete(previous)
      }
      previous = target
      if (!last) recyclable.add(target)
    }

    for (const t of recyclable) if (t !== previous) pool.release(t)
    if (ownPool) {
      // No pool was supplied: the result is handed to the caller and every
      // intermediate is freed here, so nothing outlives the call.
      pool.detach(previous)
      pool.dispose()
    }
    return { texture: previous, passCount: passes.length }
  } catch (err) {
    if (ownPool) pool.dispose()
    throw err
  } finally {
    for (const t of lutTextures.values()) device.deleteTexture(t)
  }
}

/** True when a texture produced by an earlier pass is still an input later on. */
function isReferencedLater(
  passes: readonly GpuPass[],
  from: number,
  named: ReadonlyMap<string, GpuTexture>,
  tex: GpuTexture,
): boolean {
  for (let i = from; i < passes.length; i++) {
    const inputs = passes[i].inputs
    if (!inputs) continue
    for (const spec of Object.values(inputs)) {
      if (spec === 'source' || spec === 'previous') continue
      if (named.get(spec.pass) === tex) return true
    }
  }
  return false
}
