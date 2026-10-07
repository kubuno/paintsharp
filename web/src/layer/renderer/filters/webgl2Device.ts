// A `GLDeviceLike` backed by a real WebGL2 context.
//
// This is the adapter the filter stage uses until the engine's own
// `renderer/gl/GLDevice` is available; at that point this file becomes the
// reference implementation the test double is checked against, and the engine
// device can be passed in unchanged as long as it satisfies `GLDeviceLike`.
//
// Deliberately small: no tiling, no LOD, no readback pipelining. Those belong
// to the engine, not to the filter stage.

import { QUAD_VERTEX_SHADER } from './device'
import type { GLDeviceLike, GpuProgram, GpuTexture, TextureFormat, TextureOptions, UniformMap, UniformValue } from './device'

interface GLTextureHandle {
  tex: WebGLTexture
  fb:  WebGLFramebuffer | null
}

interface UniformInfo {
  location: WebGLUniformLocation
  type: number
  size: number
}

interface GLProgramHandle {
  program: WebGLProgram
  uniforms: Map<string, UniformInfo>
}

function isFloatArray(v: UniformValue): v is Float32Array | readonly number[] {
  return v instanceof Float32Array || Array.isArray(v)
}

export class WebGL2Device implements GLDeviceLike {
  readonly maxTextureSize: number
  readonly preferredFormat: TextureFormat

  private readonly programs = new Map<string, GpuProgram>()
  private readonly vao: WebGLVertexArrayObject
  private readonly quadBuffer: WebGLBuffer
  private target: GpuTexture | null = null

  constructor(private readonly gl: WebGL2RenderingContext, opts: { forceFormat?: TextureFormat } = {}) {
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number
    // RGBA16F is only usable as a render target with this extension; without
    // it the working space degrades to 8 bits and banding comes back.
    const halfFloatRenderable = !!gl.getExtension('EXT_color_buffer_float')
    this.preferredFormat = opts.forceFormat ?? (halfFloatRenderable ? 'rgba16f' : 'rgba8')

    this.quadBuffer = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    this.vao = gl.createVertexArray()!
    gl.bindVertexArray(this.vao)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    gl.bindVertexArray(null)
  }

  createTexture(width: number, height: number, opts: TextureOptions = {}, pixels: ArrayBufferView | null = null): GpuTexture {
    const gl = this.gl
    const format = opts.format ?? this.preferredFormat
    const filter = opts.filter ?? 'linear'
    const wrap = opts.wrap ?? 'clamp'
    const tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, tex)
    if (format === 'rgba16f') {
      // Uploading Float32 into an RGBA16F texture is allowed and is what the
      // test harness does; the driver converts on upload.
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.FLOAT, pixels as ArrayBufferView | null)
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels as ArrayBufferView | null)
    }
    const f = filter === 'linear' ? gl.LINEAR : gl.NEAREST
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f)
    const w = wrap === 'repeat' ? gl.REPEAT : gl.CLAMP_TO_EDGE
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, w)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, w)
    gl.bindTexture(gl.TEXTURE_2D, null)
    const handle: GLTextureHandle = { tex, fb: null }
    return { width, height, format, filter, wrap, handle }
  }

  deleteTexture(tex: GpuTexture): void {
    const h = tex.handle as GLTextureHandle
    if (h.fb) this.gl.deleteFramebuffer(h.fb)
    this.gl.deleteTexture(h.tex)
  }

  getProgram(key: string, fragmentSource: string): GpuProgram {
    const cached = this.programs.get(key)
    if (cached) return cached
    const gl = this.gl
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!
      gl.shaderSource(s, src)
      gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(s) ?? ''
        gl.deleteShader(s)
        throw new Error(`filter shader "${key}" failed to compile: ${log}`)
      }
      return s
    }
    const vs = compile(gl.VERTEX_SHADER, QUAD_VERTEX_SHADER)
    const fs = compile(gl.FRAGMENT_SHADER, fragmentSource)
    const program = gl.createProgram()!
    gl.attachShader(program, vs)
    gl.attachShader(program, fs)
    // The quad attribute is always location 0; the VAO is shared by every pass.
    gl.bindAttribLocation(program, 0, 'aPos')
    gl.linkProgram(program)
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program) ?? ''
      gl.deleteProgram(program)
      throw new Error(`filter program "${key}" failed to link: ${log}`)
    }
    const uniforms = new Map<string, UniformInfo>()
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(program, i)
      if (!info) continue
      const loc = gl.getUniformLocation(program, info.name)
      if (!loc) continue
      // Array uniforms are reported as "uOffsets[0]".
      const name = info.name.endsWith('[0]') ? info.name.slice(0, -3) : info.name
      uniforms.set(name, { location: loc, type: info.type, size: info.size })
    }
    const handle: GLProgramHandle = { program, uniforms }
    const wrapped: GpuProgram = { key, handle }
    this.programs.set(key, wrapped)
    return wrapped
  }

  bindTarget(target: GpuTexture | null): void {
    const gl = this.gl
    this.target = target
    if (!target) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      return
    }
    const h = target.handle as GLTextureHandle
    if (!h.fb) {
      h.fb = gl.createFramebuffer()!
      gl.bindFramebuffer(gl.FRAMEBUFFER, h.fb)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, h.tex, 0)
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error(`framebuffer incomplete (0x${status.toString(16)}) for a ${target.format} target`)
      }
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, h.fb)
    }
    gl.viewport(0, 0, target.width, target.height)
  }

  drawQuad(program: GpuProgram, uniforms: UniformMap): void {
    const gl = this.gl
    const h = program.handle as GLProgramHandle
    gl.useProgram(h.program)
    let unit = 0
    for (const [name, info] of h.uniforms) {
      const value = uniforms[name]
      if (value === undefined) continue
      switch (info.type) {
        case gl.SAMPLER_2D: {
          const tex = value as GpuTexture
          gl.activeTexture(gl.TEXTURE0 + unit)
          gl.bindTexture(gl.TEXTURE_2D, (tex.handle as GLTextureHandle).tex)
          gl.uniform1i(info.location, unit)
          unit++
          break
        }
        case gl.FLOAT:
          if (isFloatArray(value)) gl.uniform1fv(info.location, value as Float32Array)
          else gl.uniform1f(info.location, value as number)
          break
        case gl.FLOAT_VEC2: gl.uniform2fv(info.location, value as Float32Array); break
        case gl.FLOAT_VEC3: gl.uniform3fv(info.location, value as Float32Array); break
        case gl.FLOAT_VEC4: gl.uniform4fv(info.location, value as Float32Array); break
        case gl.INT:
        case gl.BOOL:
          gl.uniform1i(info.location, typeof value === 'boolean' ? (value ? 1 : 0) : (value as number))
          break
        case gl.INT_VEC2: gl.uniform2iv(info.location, value as Int32Array); break
        default:
          throw new Error(`uniform "${name}" has an unsupported type 0x${info.type.toString(16)}`)
      }
    }
    gl.bindVertexArray(this.vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    gl.disable(gl.BLEND)
    // One oversized triangle instead of a quad: no diagonal seam, one fewer
    // vertex, and the rasteriser clips the excess for free.
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.bindVertexArray(null)
  }

  readPixels(tex: GpuTexture, out: Uint8Array | Float32Array): void {
    const gl = this.gl
    const previous = this.target
    this.bindTarget(tex)
    if (out instanceof Float32Array) gl.readPixels(0, 0, tex.width, tex.height, gl.RGBA, gl.FLOAT, out)
    else gl.readPixels(0, 0, tex.width, tex.height, gl.RGBA, gl.UNSIGNED_BYTE, out)
    this.bindTarget(previous)
  }

  dispose(): void {
    const gl = this.gl
    for (const p of this.programs.values()) gl.deleteProgram((p.handle as GLProgramHandle).program)
    this.programs.clear()
    gl.deleteVertexArray(this.vao)
    gl.deleteBuffer(this.quadBuffer)
  }
}
