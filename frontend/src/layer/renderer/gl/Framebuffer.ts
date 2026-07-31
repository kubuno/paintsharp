// Stage 1 (GPU abstraction) — render target + reusable framebuffer pool.
//
// The current engine creates and deletes a framebuffer around EVERY readback
// (readTex l.1199, readTexRect l.1227): one object creation, one destruction and
// a full pipeline stall per undo snapshot. Framebuffers are cheap to keep and
// expensive to churn, so here they are pooled and keyed by (size, format).

import { type TextureFormat } from './capabilities'
import { fromHalfArray, GLTexture, type TextureFilter, type TextureOptions } from './Texture'
import { ResourceTracker, type GLResource, type ResourceKind } from './resources'

export interface FramebufferOptions {
  readonly width: number
  readonly height: number
  readonly format: TextureFormat
  readonly minFilter?: TextureFilter
  readonly magFilter?: TextureFilter
  readonly label?: string
  /**
   * Attach an existing texture instead of allocating one. The framebuffer then
   * does NOT own it and will not dispose it — used to render into layer tiles.
   */
  readonly color?: GLTexture
}

export interface ReadRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** A colour-only framebuffer. No depth, no stencil: the pipeline draws quads. */
export class GLFramebuffer implements GLResource {
  readonly kind: ResourceKind = 'framebuffer'
  readonly resourceId = ResourceTracker.nextId()
  readonly label: string
  readonly color: GLTexture
  readonly width: number
  readonly height: number
  /** The framebuffer object itself has no storage; its texture is counted once. */
  readonly gpuBytes = 0

  private handleRef: WebGLFramebuffer | null
  private readonly ownsColor: boolean

  /**
   * Not called directly — go through `GLDevice.createFramebuffer`.
   * @internal
   */
  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly tracker: ResourceTracker,
    opts: FramebufferOptions,
    makeTexture: (o: TextureOptions) => GLTexture,
  ) {
    this.label = opts.label ?? 'fbo'
    if (opts.color) {
      this.color = opts.color
      this.ownsColor = false
    } else {
      this.color = makeTexture({
        width: opts.width,
        height: opts.height,
        format: opts.format,
        minFilter: opts.minFilter ?? 'linear',
        magFilter: opts.magFilter ?? 'linear',
        label: `${this.label}.color`,
      })
      this.ownsColor = true
    }
    this.width = this.color.width
    this.height = this.color.height

    const fb = gl.createFramebuffer()
    if (!fb) throw new Error('GLFramebuffer: createFramebuffer failed (context lost?)')
    this.handleRef = fb
    const prev = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.color.handle, 0)
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
    gl.bindFramebuffer(gl.FRAMEBUFFER, prev)
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteFramebuffer(fb)
      this.handleRef = null
      if (this.ownsColor) this.color.dispose()
      throw new Error(`GLFramebuffer(${this.label}): incomplete (0x${status.toString(16)})`)
    }
    tracker.register(this)
  }

  get disposed(): boolean {
    return this.handleRef === null
  }

  get format(): TextureFormat {
    return this.color.format
  }

  /** Raw GL object. Only stage-1 code may touch it. @internal */
  get handle(): WebGLFramebuffer {
    if (!this.handleRef) throw new Error(`GLFramebuffer(${this.label}): used after dispose`)
    return this.handleRef
  }

  /**
   * Synchronous GPU→CPU readback. Kept for the eyedropper (4 to 16 bytes) and
   * for tests; every bulk transfer must go through the async PBO path instead,
   * because a synchronous readPixels drains the whole pipeline.
   */
  readPixels(rect?: ReadRect, out?: Uint8Array | Float32Array): Uint8Array | Float32Array {
    const gl = this.gl
    const x = rect?.x ?? 0
    const y = rect?.y ?? 0
    const w = rect?.width ?? this.width
    const h = rect?.height ?? this.height
    const n = w * h * 4
    const prev = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.handle)
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1)
    try {
      if (this.color.info.float) {
        const buf = (out instanceof Float32Array && out.length >= n) ? out : new Float32Array(n)
        gl.getError()
        gl.readPixels(x, y, w, h, gl.RGBA, gl.FLOAT, buf)
        if (gl.getError() === gl.NO_ERROR) return buf
        // Some drivers only accept the implementation-defined pair on float
        // targets; HALF_FLOAT is the one that matters in practice.
        const half = new Uint16Array(n)
        gl.readPixels(x, y, w, h, gl.RGBA, gl.HALF_FLOAT, half)
        buf.set(fromHalfArray(half))
        return buf
      }
      const buf = (out instanceof Uint8Array && out.length >= n) ? out : new Uint8Array(n)
      gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf)
      return buf
    } finally {
      gl.pixelStorei(gl.PACK_ALIGNMENT, 4)
      gl.bindFramebuffer(gl.FRAMEBUFFER, prev)
    }
  }

  dispose(): void {
    if (!this.handleRef) return
    this.gl.deleteFramebuffer(this.handleRef)
    this.handleRef = null
    if (this.ownsColor) this.color.dispose()
    this.tracker.unregister(this)
  }
}

const poolKey = (w: number, h: number, f: TextureFormat): string => `${w}x${h}:${f}`

/**
 * Recycles framebuffers of identical (size, format). Sized by the pass plan's
 * `scratchDepth` in the composite stage, so it converges to a handful of
 * tile-sized targets instead of the document-sized ping-pong pair used today.
 */
export class FramebufferPool {
  private readonly free = new Map<string, GLFramebuffer[]>()
  private readonly busy = new Set<GLFramebuffer>()

  /** @internal — constructed by GLDevice. */
  constructor(private readonly make: (o: FramebufferOptions) => GLFramebuffer) {}

  acquire(width: number, height: number, format: TextureFormat, label = 'pool'): GLFramebuffer {
    const key = poolKey(width, height, format)
    const bucket = this.free.get(key)
    const reused = bucket?.pop()
    const fb = reused ?? this.make({ width, height, format, label: `${label}:${key}` })
    this.busy.add(fb)
    return fb
  }

  release(fb: GLFramebuffer): void {
    if (!this.busy.delete(fb)) return
    if (fb.disposed) return
    const key = poolKey(fb.width, fb.height, fb.format)
    const bucket = this.free.get(key)
    if (bucket) bucket.push(fb)
    else this.free.set(key, [fb])
  }

  /** Number of framebuffers held, split by state — for the diagnostics panel. */
  stats(): { free: number; busy: number; bytes: number } {
    let free = 0
    let bytes = 0
    for (const bucket of this.free.values()) {
      free += bucket.length
      for (const fb of bucket) bytes += fb.color.gpuBytes
    }
    for (const fb of this.busy) bytes += fb.color.gpuBytes
    return { free, busy: this.busy.size, bytes }
  }

  /** Drop idle framebuffers beyond `keepPerBucket` (default: drop them all). */
  trim(keepPerBucket = 0): void {
    for (const [key, bucket] of this.free) {
      while (bucket.length > keepPerBucket) bucket.pop()!.dispose()
      if (bucket.length === 0) this.free.delete(key)
    }
  }

  /** Release everything, including framebuffers still checked out. */
  dispose(): void {
    this.trim(0)
    for (const fb of this.busy) fb.dispose()
    this.busy.clear()
    this.free.clear()
  }
}
