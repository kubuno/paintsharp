// Stage 1 (GPU abstraction) — the WebGL2 façade.
//
// ARCHITECTURAL RULE, enforced by review and by a `no-restricted-syntax` ESLint
// rule to come: **every `gl.*` call of the engine lives under
// `layer/renderer/gl/`.** Stages 2 (tiles), 3 (composite) and 4 (Renderer) talk
// to this class only. The check is mechanical:
//   grep -rn "\bgl\." frontend/src/layer/renderer --exclude-dir=gl   → must be empty
// That single discipline is also the only preparation this codebase does for a
// possible WebGPU back-end: no speculative RHI abstraction (spec §13.4).
//
// The class also owns the fix for F10/F11/F8/F9 of the audit:
//   F10 leaked framebuffer pairs   → every object goes through ResourceTracker
//   F11 no context-loss listener   → both events are handled here
//   F8  per-call FBO create/delete → FramebufferPool
//   F9  preserveDrawingBuffer:true → removed (nothing reads the canvas)
//
// Zero React, zero DOM beyond the canvas: instantiable and testable headless.

import {
  detectCapabilities,
  workingTextureFormat,
  type CapabilityOptions,
  type GLCaps,
  type TextureFormat,
} from './capabilities'
import { configureOutputColorSpace, GLSL_COLOR_SPACE, GLSL_DITHER } from './colorSpace'
import { FramebufferPool, GLFramebuffer, type FramebufferOptions } from './Framebuffer'
import { GLProgram, type DefineValue, type ProgramOptions, type UniformValue } from './Program'
import { GLTexture, type TextureOptions } from './Texture'
import { ResourceTracker, type GLResource, type ResourceInventory, type ResourceKind } from './resources'

// ── Buffers and vertex arrays ──────────────────────────────────────────────

export type BufferTarget = 'array' | 'element' | 'uniform' | 'pixel-pack' | 'pixel-unpack'
export type BufferUsage = 'static' | 'dynamic' | 'stream'

export class GLBuffer implements GLResource {
  readonly kind: ResourceKind = 'buffer'
  readonly resourceId = ResourceTracker.nextId()
  readonly label: string
  readonly target: GLenum
  gpuBytes: number

  private handleRef: WebGLBuffer | null

  /** @internal — go through `GLDevice.createBuffer`. */
  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly tracker: ResourceTracker,
    target: BufferTarget,
    data: ArrayBufferView | number,
    usage: BufferUsage,
    label = 'buffer',
  ) {
    this.label = label
    this.target = bufferTargetEnum(gl, target)
    const buf = gl.createBuffer()
    if (!buf) throw new Error('GLBuffer: createBuffer failed (context lost?)')
    this.handleRef = buf
    const usageEnum = usage === 'static' ? gl.STATIC_DRAW : usage === 'stream' ? gl.STREAM_DRAW : gl.DYNAMIC_DRAW
    gl.bindBuffer(this.target, buf)
    if (typeof data === 'number') {
      gl.bufferData(this.target, data, usageEnum)
      this.gpuBytes = data
    } else {
      gl.bufferData(this.target, data, usageEnum)
      this.gpuBytes = data.byteLength
    }
    gl.bindBuffer(this.target, null)
    tracker.register(this)
  }

  get disposed(): boolean {
    return this.handleRef === null
  }

  /** @internal */
  get handle(): WebGLBuffer {
    if (!this.handleRef) throw new Error(`GLBuffer(${this.label}): used after dispose`)
    return this.handleRef
  }

  bind(): void {
    this.gl.bindBuffer(this.target, this.handle)
  }

  /** Update a range without reallocating — the instanced-dab path needs this. */
  update(data: ArrayBufferView, byteOffset = 0): void {
    const gl = this.gl
    gl.bindBuffer(this.target, this.handle)
    gl.bufferSubData(this.target, byteOffset, data)
    gl.bindBuffer(this.target, null)
  }

  dispose(): void {
    if (!this.handleRef) return
    this.gl.deleteBuffer(this.handleRef)
    this.handleRef = null
    this.tracker.unregister(this)
  }
}

function bufferTargetEnum(gl: WebGL2RenderingContext, t: BufferTarget): GLenum {
  switch (t) {
    case 'array': return gl.ARRAY_BUFFER
    case 'element': return gl.ELEMENT_ARRAY_BUFFER
    case 'uniform': return gl.UNIFORM_BUFFER
    case 'pixel-pack': return gl.PIXEL_PACK_BUFFER
    case 'pixel-unpack': return gl.PIXEL_UNPACK_BUFFER
  }
}

export interface VertexAttribSpec {
  /** Attribute location, matching the `attributes` order given to createProgram. */
  readonly location: number
  readonly buffer: GLBuffer
  readonly size: 1 | 2 | 3 | 4
  readonly type?: 'float' | 'byte' | 'short' | 'ubyte' | 'ushort'
  readonly normalized?: boolean
  readonly stride?: number
  readonly offset?: number
  /** Non-zero turns the attribute into a per-instance one. */
  readonly divisor?: number
}

export class GLVertexArray implements GLResource {
  readonly kind: ResourceKind = 'vertexArray'
  readonly resourceId = ResourceTracker.nextId()
  readonly label: string
  readonly gpuBytes = 0

  private handleRef: WebGLVertexArrayObject | null

  /** @internal — go through `GLDevice.createVertexArray`. */
  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly tracker: ResourceTracker,
    attribs: readonly VertexAttribSpec[],
    label = 'vao',
  ) {
    this.label = label
    const vao = gl.createVertexArray()
    if (!vao) throw new Error('GLVertexArray: createVertexArray failed (context lost?)')
    this.handleRef = vao
    gl.bindVertexArray(vao)
    for (const a of attribs) {
      a.buffer.bind()
      gl.enableVertexAttribArray(a.location)
      gl.vertexAttribPointer(
        a.location, a.size, attribTypeEnum(gl, a.type ?? 'float'),
        a.normalized ?? false, a.stride ?? 0, a.offset ?? 0,
      )
      if (a.divisor) gl.vertexAttribDivisor(a.location, a.divisor)
    }
    gl.bindVertexArray(null)
    gl.bindBuffer(gl.ARRAY_BUFFER, null)
    tracker.register(this)
  }

  get disposed(): boolean {
    return this.handleRef === null
  }

  /** @internal */
  get handle(): WebGLVertexArrayObject {
    if (!this.handleRef) throw new Error(`GLVertexArray(${this.label}): used after dispose`)
    return this.handleRef
  }

  dispose(): void {
    if (!this.handleRef) return
    this.gl.deleteVertexArray(this.handleRef)
    this.handleRef = null
    this.tracker.unregister(this)
  }
}

function attribTypeEnum(gl: WebGL2RenderingContext, t: NonNullable<VertexAttribSpec['type']>): GLenum {
  switch (t) {
    case 'float': return gl.FLOAT
    case 'byte': return gl.BYTE
    case 'ubyte': return gl.UNSIGNED_BYTE
    case 'short': return gl.SHORT
    case 'ushort': return gl.UNSIGNED_SHORT
  }
}

// ── Blend state ────────────────────────────────────────────────────────────

export type BlendFactor =
  | 'zero' | 'one'
  | 'src-alpha' | 'one-minus-src-alpha'
  | 'dst-alpha' | 'one-minus-dst-alpha'
  | 'src-color' | 'one-minus-src-color'
  | 'dst-color' | 'one-minus-dst-color'

export type BlendEquation = 'add' | 'subtract' | 'reverse-subtract' | 'min' | 'max'

export interface BlendState {
  readonly srcRGB: BlendFactor
  readonly dstRGB: BlendFactor
  readonly srcAlpha: BlendFactor
  readonly dstAlpha: BlendFactor
  readonly equation?: BlendEquation
}

/**
 * `source-over` on PREMULTIPLIED colours: `c = src + dst·(1-src.a)`.
 * No division, no `a < eps` branch — that is the whole point of §4.4.
 * Usable on a float render target because EXT_float_blend is available here.
 */
export const BLEND_OVER_PREMULTIPLIED: BlendState = {
  srcRGB: 'one', dstRGB: 'one-minus-src-alpha',
  srcAlpha: 'one', dstAlpha: 'one-minus-src-alpha',
}

/** Additive (linear dodge) on premultiplied colours. */
export const BLEND_ADD: BlendState = {
  srcRGB: 'one', dstRGB: 'one', srcAlpha: 'one', dstAlpha: 'one',
}

function blendFactorEnum(gl: WebGL2RenderingContext, f: BlendFactor): GLenum {
  switch (f) {
    case 'zero': return gl.ZERO
    case 'one': return gl.ONE
    case 'src-alpha': return gl.SRC_ALPHA
    case 'one-minus-src-alpha': return gl.ONE_MINUS_SRC_ALPHA
    case 'dst-alpha': return gl.DST_ALPHA
    case 'one-minus-dst-alpha': return gl.ONE_MINUS_DST_ALPHA
    case 'src-color': return gl.SRC_COLOR
    case 'one-minus-src-color': return gl.ONE_MINUS_SRC_COLOR
    case 'dst-color': return gl.DST_COLOR
    case 'one-minus-dst-color': return gl.ONE_MINUS_DST_COLOR
  }
}

function blendEquationEnum(gl: WebGL2RenderingContext, e: BlendEquation): GLenum {
  switch (e) {
    case 'add': return gl.FUNC_ADD
    case 'subtract': return gl.FUNC_SUBTRACT
    case 'reverse-subtract': return gl.FUNC_REVERSE_SUBTRACT
    case 'min': return gl.MIN
    case 'max': return gl.MAX
  }
}

// ── Passes ─────────────────────────────────────────────────────────────────

export interface ScissorRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface PassOptions {
  /** Viewport in target pixels. Defaults to the whole target. */
  readonly viewport?: ScissorRect
  /** Scissor in target pixels, or null to disable. */
  readonly scissor?: ScissorRect | null
  /** RGBA clear colour, applied after the scissor is set. */
  readonly clear?: readonly [number, number, number, number]
  /** null (default) disables blending. */
  readonly blend?: BlendState | null
}

// ── Device ─────────────────────────────────────────────────────────────────

export interface GLDeviceOptions extends CapabilityOptions {
  /** Ask for a Display-P3 drawing buffer (P1). P0 stays on sRGB. */
  readonly wideGamut?: boolean
  /**
   * `desynchronized: true` lowers stylus latency but can tear and, on some
   * drivers, drops hardware acceleration. Spec §15 lists it as UNRESOLVED: it
   * must be adopted on the strength of a latency measurement, not of the docs.
   * Default therefore stays false.
   */
  readonly desynchronized?: boolean
  /** Escape hatch for tests; merged over the engine's target attributes. */
  readonly contextAttributes?: WebGLContextAttributes
  /** Free the driver-side context on dispose via WEBGL_lose_context. Default true. */
  readonly loseContextOnDispose?: boolean
  readonly onContextLost?: () => void
  readonly onContextRestored?: () => void
}

/** Name of the fullscreen-quad vertex attribute, pinned to location 0. */
export const QUAD_ATTRIB = 'aPos'

/** Vertex shader for every fullscreen pass. No Y-flip: doc-top stays at t=0. */
export const QUAD_VERT = `#version 300 es
in vec2 ${QUAD_ATTRIB};
out vec2 vUv;
void main() { vUv = ${QUAD_ATTRIB} * 0.5 + 0.5; gl_Position = vec4(${QUAD_ATTRIB}, 0.0, 1.0); }`

export class GLDevice {
  readonly canvas: HTMLCanvasElement | OffscreenCanvas
  readonly caps: GLCaps
  /** Pool of reusable render targets — never create framebuffers ad hoc. */
  readonly framebuffers: FramebufferPool

  private readonly tracker = new ResourceTracker()
  /**
   * The raw context. Stage-1 only; nothing outside `gl/` may read it.
   * @internal
   */
  private readonly glCtx: WebGL2RenderingContext
  private quadBuffer: GLBuffer | null = null
  private quadVao: GLVertexArray | null = null
  private currentTarget: GLFramebuffer | null = null
  private currentBlend: BlendState | null = null
  private scissorOn = false
  private lost = false
  private disposedFlag = false
  private readonly opts: GLDeviceOptions
  private readonly onLost: (e: Event) => void
  private readonly onRestored: () => void
  private drawCalls = 0

  private constructor(
    canvas: HTMLCanvasElement | OffscreenCanvas,
    gl: WebGL2RenderingContext,
    opts: GLDeviceOptions,
  ) {
    this.canvas = canvas
    this.glCtx = gl
    this.opts = opts
    this.caps = detectCapabilities(gl, opts)
    configureOutputColorSpace(gl, opts.wideGamut ?? false)
    this.framebuffers = new FramebufferPool(o => this.createFramebuffer(o))

    // F11: the current engine has no context-loss listener at all. Without
    // preventDefault() the context is never restored, and the editor dies.
    this.onLost = (e: Event) => {
      e.preventDefault()
      this.lost = true
      // Every GPU object is gone; drop them so the inventory tells the truth and
      // so upper stages get a loud "used after dispose" instead of silent
      // corruption if they keep painting.
      this.framebuffers.dispose()
      this.tracker.disposeAll()
      this.quadBuffer = null
      this.quadVao = null
      this.currentTarget = null
      opts.onContextLost?.()
    }
    this.onRestored = () => {
      this.lost = false
      opts.onContextRestored?.()
    }
    if (canvas instanceof HTMLCanvasElement) {
      canvas.addEventListener('webglcontextlost', this.onLost)
      canvas.addEventListener('webglcontextrestored', this.onRestored)
    }
  }

  /**
   * Create a device. Returns null when WebGL2 is unavailable — never throws for
   * that reason, because "no WebGL2" is a supported end-user situation.
   */
  static create(
    canvas: HTMLCanvasElement | OffscreenCanvas,
    opts: GLDeviceOptions = {},
  ): GLDevice | null {
    const attrs: WebGLContextAttributes = {
      // The display pass always writes a = 1 (it paints the checkerboard or the
      // out-of-document background everywhere), so an opaque drawing buffer costs
      // nothing and buys subpixel antialiasing for the DOM text composited above.
      alpha: false,
      premultipliedAlpha: false,   // irrelevant when alpha:false, kept explicit
      preserveDrawingBuffer: false, // F9: nothing reads the canvas; exports read FBOs
      antialias: false,             // only fullscreen quads are ever drawn
      depth: false,
      stencil: false,
      desynchronized: opts.desynchronized ?? false,
      powerPreference: 'high-performance',
      ...opts.contextAttributes,
    }
    let gl: WebGL2RenderingContext | null = null
    try {
      gl = canvas.getContext('webgl2', attrs) as WebGL2RenderingContext | null
    } catch {
      return null
    }
    if (!gl) return null
    return new GLDevice(canvas, gl, opts)
  }

  // ── State ────────────────────────────────────────────────────────────────

  get contextLost(): boolean {
    return this.lost || this.glCtx.isContextLost()
  }

  get disposed(): boolean {
    return this.disposedFlag
  }

  /** Working texture format chosen after probing (RGBA16F here). */
  get workingFormat(): TextureFormat {
    return workingTextureFormat(this.caps.working)
  }

  /** Draw calls issued since the last `resetStats()`. */
  get drawCallCount(): number {
    return this.drawCalls
  }

  resetStats(): void {
    this.drawCalls = 0
  }

  /**
   * `#define`s every engine shader gets, so a shader never has to re-derive the
   * working format or whether it must dither on store.
   */
  commonDefines(): Record<string, DefineValue> {
    return {
      KB_WORKING_RGBA8: this.caps.working === 'rgba8',
      KB_WORKING_RGBA16F: this.caps.working === 'rgba16f',
      KB_WORKING_RGBA32F: this.caps.working === 'rgba32f',
      KB_DITHER: this.caps.needsDither,
      KB_FLOAT_BLEND: this.caps.floatBlend,
    }
  }

  /**
   * Shared GLSL injected into every program (colour space + dithering).
   *
   * The precision statements come FIRST and are part of the preamble on purpose:
   * the preamble is inserted right after `#version`, i.e. BEFORE the shader's own
   * `precision highp float;`, and GLSL ES 3.00 fragment shaders have no default
   * float precision — without this, every shared function fails to compile with
   * "No precision specified for (float)". Redeclaring precision later in the
   * shader is legal, so a shader that declares its own is unaffected.
   */
  shaderPreamble(): string {
    return 'precision highp float;\nprecision highp int;\n' + GLSL_COLOR_SPACE + GLSL_DITHER
  }

  // ── Resource creation ────────────────────────────────────────────────────

  createTexture(opts: TextureOptions): GLTexture {
    this.assertUsable()
    const max = this.caps.maxTextureSize
    if (opts.width > max || opts.height > max) {
      throw new Error(`GLDevice: texture ${opts.width}×${opts.height} exceeds MAX_TEXTURE_SIZE ${max}`)
    }
    return new GLTexture(this.glCtx, this.tracker, opts, this.caps.anisotropy)
  }

  createFramebuffer(opts: FramebufferOptions): GLFramebuffer {
    this.assertUsable()
    return new GLFramebuffer(this.glCtx, this.tracker, opts, o => this.createTexture(o))
  }

  createProgram(opts: ProgramOptions): GLProgram {
    this.assertUsable()
    return new GLProgram(this.glCtx, this.tracker, {
      ...opts,
      defines: { ...this.commonDefines(), ...opts.defines },
      preamble: opts.preamble ?? this.shaderPreamble(),
      attributes: opts.attributes ?? [QUAD_ATTRIB],
    })
  }

  createBuffer(
    target: BufferTarget,
    data: ArrayBufferView | number,
    usage: BufferUsage = 'static',
    label = 'buffer',
  ): GLBuffer {
    this.assertUsable()
    return new GLBuffer(this.glCtx, this.tracker, target, data, usage, label)
  }

  createVertexArray(attribs: readonly VertexAttribSpec[], label = 'vao'): GLVertexArray {
    this.assertUsable()
    return new GLVertexArray(this.glCtx, this.tracker, attribs, label)
  }

  // ── Passes ───────────────────────────────────────────────────────────────

  /**
   * Bind a render target and set the per-pass state. `target === null` means the
   * canvas' default framebuffer.
   */
  beginPass(target: GLFramebuffer | null, opts: PassOptions = {}): void {
    this.assertUsable()
    const gl = this.glCtx
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.handle : null)
    this.currentTarget = target
    const w = target ? target.width : this.drawingBufferWidth
    const h = target ? target.height : this.drawingBufferHeight
    const vp = opts.viewport
    gl.viewport(vp?.x ?? 0, vp?.y ?? 0, vp?.width ?? w, vp?.height ?? h)
    this.setScissor(opts.scissor ?? null)
    this.setBlend(opts.blend ?? null)
    if (opts.clear) this.clear(opts.clear)
  }

  setScissor(rect: ScissorRect | null): void {
    const gl = this.glCtx
    if (!rect) {
      if (this.scissorOn) { gl.disable(gl.SCISSOR_TEST); this.scissorOn = false }
      return
    }
    if (!this.scissorOn) { gl.enable(gl.SCISSOR_TEST); this.scissorOn = true }
    gl.scissor(rect.x, rect.y, rect.width, rect.height)
  }

  setBlend(state: BlendState | null): void {
    const gl = this.glCtx
    if (!state) {
      if (this.currentBlend) { gl.disable(gl.BLEND); this.currentBlend = null }
      return
    }
    if (!this.currentBlend) gl.enable(gl.BLEND)
    this.currentBlend = state
    gl.blendFuncSeparate(
      blendFactorEnum(gl, state.srcRGB), blendFactorEnum(gl, state.dstRGB),
      blendFactorEnum(gl, state.srcAlpha), blendFactorEnum(gl, state.dstAlpha),
    )
    const eq = blendEquationEnum(gl, state.equation ?? 'add')
    gl.blendEquationSeparate(eq, eq)
  }

  clear(color: readonly [number, number, number, number]): void {
    const gl = this.glCtx
    gl.clearColor(color[0], color[1], color[2], color[3])
    gl.clear(gl.COLOR_BUFFER_BIT)
  }

  /**
   * Draw the fullscreen quad with `program`. This is THE draw primitive of the
   * engine: every pass (composite, display, filter, LOD reduction) is a quad.
   */
  drawQuad(program: GLProgram, uniforms: Readonly<Record<string, UniformValue>> = {}): void {
    this.assertUsable()
    const gl = this.glCtx
    program.use()
    program.setUniforms(uniforms)
    gl.bindVertexArray(this.quad().handle)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.bindVertexArray(null)
    this.drawCalls++
  }

  /** Instanced variant, for the GPU dab stamper (spec §8.2 a). */
  drawInstanced(program: GLProgram, vao: GLVertexArray, instanceCount: number,
    uniforms: Readonly<Record<string, UniformValue>> = {}): void {
    this.assertUsable()
    const gl = this.glCtx
    program.use()
    program.setUniforms(uniforms)
    gl.bindVertexArray(vao.handle)
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, instanceCount)
    gl.bindVertexArray(null)
    this.drawCalls++
  }

  endPass(): void {
    const gl = this.glCtx
    this.setScissor(null)
    this.setBlend(null)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    this.currentTarget = null
  }

  /** Framebuffer-to-framebuffer copy; `null` designates the default framebuffer. */
  blit(
    src: GLFramebuffer | null,
    dst: GLFramebuffer | null,
    srcRect: ScissorRect,
    dstRect: ScissorRect,
    filter: 'nearest' | 'linear' = 'nearest',
  ): void {
    this.assertUsable()
    const gl = this.glCtx
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, src ? src.handle : null)
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dst ? dst.handle : null)
    gl.blitFramebuffer(
      srcRect.x, srcRect.y, srcRect.x + srcRect.width, srcRect.y + srcRect.height,
      dstRect.x, dstRect.y, dstRect.x + dstRect.width, dstRect.y + dstRect.height,
      gl.COLOR_BUFFER_BIT, filter === 'linear' ? gl.LINEAR : gl.NEAREST,
    )
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null)
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null)
  }

  /** Synchronous readback of the DEFAULT framebuffer. Tests and screenshots only. */
  readDefaultFramebuffer(rect?: ScissorRect): Uint8Array {
    const gl = this.glCtx
    const x = rect?.x ?? 0
    const y = rect?.y ?? 0
    const w = rect?.width ?? this.drawingBufferWidth
    const h = rect?.height ?? this.drawingBufferHeight
    const out = new Uint8Array(w * h * 4)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out)
    return out
  }

  /** Flush pending commands without blocking. */
  flush(): void {
    this.glCtx.flush()
  }

  /** Block until the GPU is idle. Tests only — never in the render loop. */
  finish(): void {
    this.glCtx.finish()
  }

  /** Last GL error code, drained. 0 means NO_ERROR. */
  getError(): number {
    return this.glCtx.getError()
  }

  get drawingBufferWidth(): number {
    return this.glCtx.drawingBufferWidth
  }

  get drawingBufferHeight(): number {
    return this.glCtx.drawingBufferHeight
  }

  /** Currently bound render target, or null for the default framebuffer. */
  get target(): GLFramebuffer | null {
    return this.currentTarget
  }

  // ── Canvas sizing (§6.2) ─────────────────────────────────────────────────

  /**
   * The backing store is sized in DEVICE pixels and must be an integer.
   * Rounding the CSS size and multiplying is wrong: it drifts by up to dpr-1
   * device pixels and blurs the image by half a pixel at every zoom level.
   * Returns true when the size changed — a resize resets GL state, so callers
   * must redraw.
   */
  syncCanvasSize(dpr: number): boolean {
    const cv = this.canvas
    if (!(cv instanceof HTMLCanvasElement)) return false
    const w = Math.max(1, Math.round(cv.clientWidth * dpr))
    const h = Math.max(1, Math.round(cv.clientHeight * dpr))
    if (cv.width === w && cv.height === h) return false
    cv.width = w
    cv.height = h
    return true
  }

  // ── Diagnostics & lifecycle ──────────────────────────────────────────────

  /** Live GPU objects, per kind, plus attributable VRAM. */
  inventory(): ResourceInventory {
    return this.tracker.inventory()
  }

  /** What is still alive, with labels — the leak report. */
  liveResources(): { kind: ResourceKind; label: string; gpuBytes: number }[] {
    return this.tracker.list()
  }

  /** VRAM attributable to live resources, in bytes. */
  get gpuBytesResident(): number {
    return this.tracker.inventory().bytes
  }

  /**
   * Force a context loss. Test hook for the restore path; also used by
   * `dispose()` so the driver frees its side immediately instead of waiting for
   * the canvas to be garbage-collected.
   */
  loseContext(): boolean {
    const ext = this.glCtx.getExtension('WEBGL_lose_context')
    if (!ext) return false
    ext.loseContext()
    return true
  }

  /**
   * Release EVERY GPU object owned by this device. Idempotent.
   * The inventory is guaranteed to be empty afterwards — that is the property
   * the leak test asserts, and the one the current engine fails (F10).
   */
  dispose(): void {
    if (this.disposedFlag) return
    this.disposedFlag = true
    if (this.canvas instanceof HTMLCanvasElement) {
      this.canvas.removeEventListener('webglcontextlost', this.onLost)
      this.canvas.removeEventListener('webglcontextrestored', this.onRestored)
    }
    this.framebuffers.dispose()
    this.quadVao = null
    this.quadBuffer = null
    this.tracker.disposeAll()
    if (!this.contextLost) {
      const gl = this.glCtx
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.bindVertexArray(null)
      gl.useProgram(null)
      if (this.opts.loseContextOnDispose ?? true) this.loseContext()
    }
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /** Lazily created fullscreen-quad VAO — one per device, shared by all passes. */
  private quad(): GLVertexArray {
    if (this.quadVao) return this.quadVao
    this.quadBuffer = this.createBuffer(
      'array',
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      'static',
      'quad',
    )
    this.quadVao = this.createVertexArray(
      [{ location: 0, buffer: this.quadBuffer, size: 2 }],
      'quad',
    )
    return this.quadVao
  }

  private assertUsable(): void {
    if (this.disposedFlag) throw new Error('GLDevice: used after dispose')
    if (this.contextLost) throw new Error('GLDevice: WebGL context is lost')
  }
}
