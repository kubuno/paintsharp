// A `GLDeviceLike` test double.
//
// It compiles nothing and draws nothing: it RECORDS. That is enough to assert
// the things that break silently on a real GPU and are painful to debug there —
// pass count and order, program cache keys, render-target sizes, which texture
// each sampler was bound to, and whether every intermediate was returned to the
// pool. It also runs in Node, with no WebGL context, so the filter graph can be
// exercised without a browser.
//
// It does NOT validate GLSL. Shader correctness is verified against the CPU
// reference on a real context (see the harness in the scratchpad).

import type { GLDeviceLike, GpuProgram, GpuTexture, TextureFormat, TextureOptions, UniformMap } from './device'

export interface RecordedDraw {
  programKey: string
  /** Render-target size at the time of the draw. */
  target: { width: number; height: number; id: number } | null
  /** Sampler name → texture id. */
  samplers: Record<string, number>
  /** Non-sampler uniforms, copied. */
  uniforms: Record<string, number | boolean | readonly number[]>
}

interface FakeTextureHandle { id: number }

export class TestDevice implements GLDeviceLike {
  readonly maxTextureSize = 16384
  readonly preferredFormat: TextureFormat

  readonly draws: RecordedDraw[] = []
  readonly compiled = new Map<string, string>()
  /** Textures created and not yet deleted. */
  readonly liveTextures = new Set<number>()

  private nextId = 1
  private current: GpuTexture | null = null

  constructor(format: TextureFormat = 'rgba16f') { this.preferredFormat = format }

  createTexture(width: number, height: number, opts: TextureOptions = {}): GpuTexture {
    const id = this.nextId++
    this.liveTextures.add(id)
    const handle: FakeTextureHandle = { id }
    return {
      width, height,
      format: opts.format ?? this.preferredFormat,
      filter: opts.filter ?? 'linear',
      wrap: opts.wrap ?? 'clamp',
      handle,
    }
  }

  deleteTexture(tex: GpuTexture): void {
    this.liveTextures.delete((tex.handle as FakeTextureHandle).id)
  }

  getProgram(key: string, fragmentSource: string): GpuProgram {
    const previous = this.compiled.get(key)
    if (previous !== undefined && previous !== fragmentSource) {
      // Two different sources under one cache key is the bug the key exists to
      // prevent: on a real device the second filter would silently run the
      // first one's shader.
      throw new Error(`program key "${key}" reused for a different shader source`)
    }
    this.compiled.set(key, fragmentSource)
    return { key, handle: key }
  }

  bindTarget(target: GpuTexture | null): void { this.current = target }

  drawQuad(program: GpuProgram, uniforms: UniformMap): void {
    const samplers: Record<string, number> = {}
    const plain: Record<string, number | boolean | readonly number[]> = {}
    for (const [name, value] of Object.entries(uniforms)) {
      if (value !== null && typeof value === 'object' && 'handle' in value) {
        samplers[name] = ((value as GpuTexture).handle as FakeTextureHandle).id
      } else if (value instanceof Float32Array || value instanceof Int32Array) {
        plain[name] = Array.from(value)
      } else {
        plain[name] = value as number | boolean | readonly number[]
      }
    }
    this.draws.push({
      programKey: program.key,
      target: this.current
        ? { width: this.current.width, height: this.current.height, id: (this.current.handle as FakeTextureHandle).id }
        : null,
      samplers,
      uniforms: plain,
    })
  }

  readPixels(_tex: GpuTexture, out: Uint8Array | Float32Array): void { out.fill(0) }

  reset(): void {
    this.draws.length = 0
    this.compiled.clear()
    this.liveTextures.clear()
    this.nextId = 1
  }
}
