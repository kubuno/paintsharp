// The minimal GPU surface the filter stage needs.
//
// This file deliberately declares its OWN interface instead of importing the
// engine's `renderer/gl/` device: the filter stage is developed and tested in
// isolation, against a test double (see `testDevice.ts`). When the real
// `GLDevice` lands it only has to satisfy `GLDeviceLike` — no filter code
// changes. Four capabilities are needed and no more:
//   1. allocate a texture (and read it back),
//   2. compile/cache a fragment program,
//   3. bind a texture as the render target (framebuffer),
//   4. draw one fullscreen quad.

/** Working pixel format. The engine target is RGBA16F, linear, premultiplied. */
export type TextureFormat = 'rgba16f' | 'rgba8'

/** Texture sampling mode. Bilinear is required by the blur tap merging. */
export type TextureFilter = 'linear' | 'nearest'

/** Texture wrapping. `repeat` is only used by the Offset filter. */
export type TextureWrap = 'clamp' | 'repeat'

export interface TextureOptions {
  format?: TextureFormat
  filter?: TextureFilter
  wrap?:   TextureWrap
}

/**
 * An opaque, device-owned texture handle. `handle` must only ever be
 * dereferenced by the device that created it.
 */
export interface GpuTexture {
  readonly width:  number
  readonly height: number
  readonly format: TextureFormat
  readonly filter: TextureFilter
  readonly wrap:   TextureWrap
  readonly handle: unknown
}

/** An opaque, device-owned compiled program. */
export interface GpuProgram {
  readonly key:    string
  readonly handle: unknown
}

/**
 * A uniform value. Arrays map to `uniformNfv`; a texture binds to the next free
 * sampler unit; a boolean maps to an int (GLSL ES has no bool uniform setter
 * distinct from int in practice).
 */
export type UniformValue = number | boolean | readonly number[] | Float32Array | Int32Array | GpuTexture

export type UniformMap = Readonly<Record<string, UniformValue>>

/**
 * Vertex shader every filter program is linked against. The device is free to
 * use its own, provided it honours this contract:
 *   - covers the whole target with one triangle strip / triangle,
 *   - exposes `in vec2 vUv` to the fragment shader, in [0,1], origin at the
 *     first texel of the SOURCE texture (i.e. same orientation as the source),
 *   - fragment shaders are GLSL ES 3.00 and write `layout(location=0) out vec4`.
 */
export const QUAD_VERTEX_SHADER = `#version 300 es
precision highp float;
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`

export interface GLDeviceLike {
  /** Largest texture edge the device supports (guards LOD/plan decisions). */
  readonly maxTextureSize: number
  /** Format the working space should use; 'rgba8' means no HDR headroom. */
  readonly preferredFormat: TextureFormat

  /** Allocate a texture, optionally seeded with pixels (row 0 = top). */
  createTexture(width: number, height: number, opts?: TextureOptions, pixels?: ArrayBufferView | null): GpuTexture
  deleteTexture(tex: GpuTexture): void

  /**
   * Compile (or fetch from cache) a fragment program. `key` identifies the
   * source for caching — two calls with the same key must return the same
   * program, so callers must fold every `#define` permutation into the key.
   */
  getProgram(key: string, fragmentSource: string): GpuProgram

  /**
   * Bind `target` as the render target and set the viewport to its size.
   * `null` binds the default framebuffer (device-defined size).
   */
  bindTarget(target: GpuTexture | null): void

  /** Draw one fullscreen quad with `program` and the given uniforms. */
  drawQuad(program: GpuProgram, uniforms: UniformMap): void

  /**
   * Read back a texture. `out` must be large enough for width*height*4.
   * Synchronous; the async PBO path lives in the engine, not here.
   */
  readPixels(tex: GpuTexture, out: Uint8Array | Float32Array): void
}

/**
 * Small recycling pool so a multi-pass filter does not create and destroy a
 * texture per pass (the create/delete round-trip is a driver stall).
 * Textures are keyed by their full geometry+sampling signature.
 */
export class TexturePool {
  private readonly free = new Map<string, GpuTexture[]>()
  private readonly live = new Set<GpuTexture>()

  constructor(private readonly device: GLDeviceLike) {}

  private static key(w: number, h: number, o: Required<TextureOptions>): string {
    return `${w}x${h}:${o.format}:${o.filter}:${o.wrap}`
  }

  acquire(width: number, height: number, opts?: TextureOptions): GpuTexture {
    const full: Required<TextureOptions> = {
      format: opts?.format ?? this.device.preferredFormat,
      filter: opts?.filter ?? 'linear',
      wrap:   opts?.wrap   ?? 'clamp',
    }
    const k = TexturePool.key(width, height, full)
    const bucket = this.free.get(k)
    const reused = bucket?.pop()
    const tex = reused ?? this.device.createTexture(width, height, full)
    this.live.add(tex)
    return tex
  }

  release(tex: GpuTexture | null | undefined): void {
    if (!tex || !this.live.delete(tex)) return
    const k = TexturePool.key(tex.width, tex.height, { format: tex.format, filter: tex.filter, wrap: tex.wrap })
    const bucket = this.free.get(k)
    if (bucket) bucket.push(tex)
    else this.free.set(k, [tex])
  }

  /**
   * Give up ownership of a texture without freeing it: the caller becomes
   * responsible for deleting it. Used for the texture a filter returns.
   */
  detach(tex: GpuTexture): void { this.live.delete(tex) }

  /** Number of textures currently checked out (used by tests to catch leaks). */
  get liveCount(): number { return this.live.size }

  dispose(): void {
    for (const t of this.live) this.device.deleteTexture(t)
    this.live.clear()
    for (const bucket of this.free.values()) for (const t of bucket) this.device.deleteTexture(t)
    this.free.clear()
  }
}
