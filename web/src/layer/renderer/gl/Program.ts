// Stage 1 (GPU abstraction) — compiled program with a typed uniform cache.
//
// `getUniformLocation` is a driver round-trip and the compositor calls into a
// program once per layer per tile, so locations are resolved ONCE, at link time,
// from the program's own active-uniform list. That list also carries the
// declared GL type of every uniform, which is what lets `setUniforms` dispatch
// correctly without the caller having to remember that `uMode` is an int and
// `uOpacity` a float — the classic source of silent INVALID_OPERATION.
//
// This is the clean re-implementation of the `uloc` WeakMap cache of the current
// engine (layer/renderer/glUtils.ts): same idea, but eager, per-program, and
// type-aware instead of name-keyed and untyped.

import { GLTexture } from './Texture'
import { ResourceTracker, type GLResource, type ResourceKind } from './resources'

export type DefineValue = string | number | boolean

export interface ProgramOptions {
  readonly vertex: string
  readonly fragment: string
  /** `#define` permutations, injected right after the `#version` line. */
  readonly defines?: Readonly<Record<string, DefineValue>>
  /** Source appended after the defines — the device injects its shared chunks. */
  readonly preamble?: string
  /**
   * Attribute names bound to locations 0, 1, … before linking. Pinning them is
   * what lets a single VAO be reused across every program (the fullscreen quad).
   */
  readonly attributes?: readonly string[]
  readonly label?: string
}

/** Anything `setUniforms` accepts. Textures are bound to auto-assigned units. */
export type UniformValue =
  | number
  | boolean
  | GLTexture
  | Float32Array
  | Int32Array
  | readonly number[]

export interface UniformInfo {
  readonly location: WebGLUniformLocation
  /** Declared GL type (gl.FLOAT, gl.FLOAT_VEC4, gl.SAMPLER_2D, …). */
  readonly type: GLenum
  /** Array length; 1 for scalars. */
  readonly size: number
}

/** Inject `#define`s and a shared preamble after the `#version` directive. */
export function composeSource(
  src: string,
  defines?: Readonly<Record<string, DefineValue>>,
  preamble?: string,
): string {
  const lines: string[] = []
  if (defines) {
    for (const [k, v] of Object.entries(defines)) {
      if (v === false) continue
      lines.push(`#define ${k} ${v === true ? '1' : String(v)}`)
    }
  }
  if (preamble) lines.push(preamble)
  if (lines.length === 0) return src
  const m = /^\s*#version[^\n]*\n/.exec(src)
  if (!m) return `${lines.join('\n')}\n${src}`
  return src.slice(0, m[0].length) + lines.join('\n') + '\n' + src.slice(m[0].length)
}

/** Annotate a shader log with the offending source lines — GLSL logs are terse. */
function annotate(log: string, src: string): string {
  const lines = src.split('\n')
  return log.replace(/\b(\d+):(\d+)\b/g, (whole, _col: string, row: string) => {
    const n = Number(row)
    const text = lines[n - 1]
    return text ? `${whole} « ${text.trim()} »` : whole
  })
}

export class GLProgram implements GLResource {
  readonly kind: ResourceKind = 'program'
  readonly resourceId = ResourceTracker.nextId()
  readonly label: string
  /** Programs hold no addressable VRAM budget of their own. */
  readonly gpuBytes = 0

  private handleRef: WebGLProgram | null
  private readonly uniforms = new Map<string, UniformInfo>()
  private readonly attribs = new Map<string, number>()
  private linkChecked = false
  private readonly vertexSrc: string
  private readonly fragmentSrc: string

  /**
   * Not called directly — go through `GLDevice.createProgram`.
   * @internal
   */
  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly tracker: ResourceTracker,
    opts: ProgramOptions,
  ) {
    this.label = opts.label ?? 'program'
    this.vertexSrc = composeSource(opts.vertex, opts.defines, opts.preamble)
    this.fragmentSrc = composeSource(opts.fragment, opts.defines, opts.preamble)

    const prog = gl.createProgram()
    if (!prog) throw new Error('GLProgram: createProgram failed (context lost?)')
    this.handleRef = prog

    const vs = this.compile(gl.VERTEX_SHADER, this.vertexSrc)
    const fs = this.compile(gl.FRAGMENT_SHADER, this.fragmentSrc)
    gl.attachShader(prog, vs)
    gl.attachShader(prog, fs)
    if (opts.attributes) {
      opts.attributes.forEach((name, i) => gl.bindAttribLocation(prog, i, name))
    }
    gl.linkProgram(prog)
    // Detach + delete now: the objects survive until the program is released,
    // and the link status is queried lazily so the driver can keep compiling in
    // the background when KHR_parallel_shader_compile is available.
    gl.detachShader(prog, vs)
    gl.detachShader(prog, fs)
    gl.deleteShader(vs)
    gl.deleteShader(fs)

    tracker.register(this)
  }

  private compile(type: GLenum, src: string): WebGLShader {
    const gl = this.gl
    const sh = gl.createShader(type)
    if (!sh) throw new Error(`GLProgram(${this.label}): createShader failed`)
    gl.shaderSource(sh, src)
    gl.compileShader(sh)
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh) ?? '(no log)'
      gl.deleteShader(sh)
      throw new Error(`GLProgram(${this.label}) ${type === gl.VERTEX_SHADER ? 'vertex' : 'fragment'}: ${annotate(log, src)}`)
    }
    return sh
  }

  get disposed(): boolean {
    return this.handleRef === null
  }

  /** Raw GL object. Only stage-1 code may touch it. @internal */
  get handle(): WebGLProgram {
    if (!this.handleRef) throw new Error(`GLProgram(${this.label}): used after dispose`)
    return this.handleRef
  }

  /**
   * True when the driver has finished linking. Without
   * KHR_parallel_shader_compile this always reports ready (the link already
   * blocked inside `linkProgram`).
   */
  ready(): boolean {
    const gl = this.gl
    const ext = gl.getExtension('KHR_parallel_shader_compile')
    if (!ext) return true
    return gl.getProgramParameter(this.handle, ext.COMPLETION_STATUS_KHR) === true
  }

  /** Validate the link and build the uniform/attribute caches. Idempotent. */
  ensureLinked(): void {
    if (this.linkChecked) return
    const gl = this.gl
    const prog = this.handle
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(prog) ?? '(no log)'
      throw new Error(`GLProgram(${this.label}) link: ${log}`)
    }
    this.linkChecked = true

    const nu = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS) as number
    for (let i = 0; i < nu; i++) {
      const info = gl.getActiveUniform(prog, i)
      if (!info) continue
      const loc = gl.getUniformLocation(prog, info.name)
      if (!loc) continue
      const entry: UniformInfo = { location: loc, type: info.type, size: info.size }
      this.uniforms.set(info.name, entry)
      // Array uniforms come back as `uOffsets[0]`; accept the bare name too.
      if (info.name.endsWith('[0]')) this.uniforms.set(info.name.slice(0, -3), entry)
    }
    const na = gl.getProgramParameter(prog, gl.ACTIVE_ATTRIBUTES) as number
    for (let i = 0; i < na; i++) {
      const info = gl.getActiveAttrib(prog, i)
      if (!info) continue
      this.attribs.set(info.name, gl.getAttribLocation(prog, info.name))
    }
  }

  use(): void {
    this.ensureLinked()
    this.gl.useProgram(this.handle)
  }

  /** Cached location, or null when the uniform was optimised out. */
  uniform(name: string): UniformInfo | null {
    this.ensureLinked()
    return this.uniforms.get(name) ?? null
  }

  attribLocation(name: string): number {
    this.ensureLinked()
    return this.attribs.get(name) ?? -1
  }

  /** Names of every active uniform — used by tests and the diagnostics panel. */
  uniformNames(): string[] {
    this.ensureLinked()
    return [...this.uniforms.keys()].filter(n => !n.endsWith('[0]'))
  }

  /**
   * Assign uniforms. The program must already be current (`use()`).
   * Unknown names are ignored on purpose: a shader permutation may legitimately
   * drop a uniform, and throwing would make `#ifdef` variants unusable.
   * Textures are bound to units allocated in iteration order.
   */
  setUniforms(values: Readonly<Record<string, UniformValue>>, firstUnit = 0): number {
    let unit = firstUnit
    for (const [name, value] of Object.entries(values)) {
      if (value instanceof GLTexture) {
        this.setTexture(name, value, unit)
        unit++
      } else {
        this.setUniform(name, value)
      }
    }
    return unit
  }

  setTexture(name: string, tex: GLTexture, unit: number): void {
    const u = this.uniform(name)
    if (!u) return
    tex.bind(unit)
    this.gl.uniform1i(u.location, unit)
  }

  setUniform(name: string, value: Exclude<UniformValue, GLTexture>): void {
    const u = this.uniform(name)
    if (!u) return
    const gl = this.gl
    const loc = u.location

    if (typeof value === 'boolean') {
      gl.uniform1i(loc, value ? 1 : 0)
      return
    }
    if (typeof value === 'number') {
      switch (u.type) {
        case gl.FLOAT: gl.uniform1f(loc, value); return
        case gl.UNSIGNED_INT: gl.uniform1ui(loc, value); return
        default: gl.uniform1i(loc, value | 0); return   // INT, BOOL, SAMPLER_*
      }
    }

    const isInt = u.type === gl.INT || u.type === gl.BOOL
      || u.type === gl.INT_VEC2 || u.type === gl.INT_VEC3 || u.type === gl.INT_VEC4
      || u.type === gl.BOOL_VEC2 || u.type === gl.BOOL_VEC3 || u.type === gl.BOOL_VEC4
    const data: Float32Array | Int32Array = value instanceof Float32Array || value instanceof Int32Array
      ? value
      : isInt ? Int32Array.from(value) : Float32Array.from(value)

    switch (u.type) {
      case gl.FLOAT_MAT2: gl.uniformMatrix2fv(loc, false, data as Float32Array); return
      case gl.FLOAT_MAT3: gl.uniformMatrix3fv(loc, false, data as Float32Array); return
      case gl.FLOAT_MAT4: gl.uniformMatrix4fv(loc, false, data as Float32Array); return
      case gl.FLOAT_VEC2: gl.uniform2fv(loc, data as Float32Array); return
      case gl.FLOAT_VEC3: gl.uniform3fv(loc, data as Float32Array); return
      case gl.FLOAT_VEC4: gl.uniform4fv(loc, data as Float32Array); return
      case gl.INT_VEC2: case gl.BOOL_VEC2: gl.uniform2iv(loc, data as Int32Array); return
      case gl.INT_VEC3: case gl.BOOL_VEC3: gl.uniform3iv(loc, data as Int32Array); return
      case gl.INT_VEC4: case gl.BOOL_VEC4: gl.uniform4iv(loc, data as Int32Array); return
      case gl.FLOAT: gl.uniform1fv(loc, data as Float32Array); return
      default: gl.uniform1iv(loc, data as Int32Array); return
    }
  }

  /** Full source actually sent to the driver — for shader-error triage. */
  sources(): { vertex: string; fragment: string } {
    return { vertex: this.vertexSrc, fragment: this.fragmentSrc }
  }

  dispose(): void {
    if (!this.handleRef) return
    this.gl.deleteProgram(this.handleRef)
    this.handleRef = null
    this.uniforms.clear()
    this.attribs.clear()
    this.tracker.unregister(this)
  }
}
