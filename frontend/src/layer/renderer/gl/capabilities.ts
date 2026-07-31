// Stage 1 (GPU abstraction) — capability detection and format fallback.
//
// Nothing here is assumed: every capability is probed against the live context,
// and every candidate render-target format is validated by actually attaching a
// small texture to a framebuffer and asking for FRAMEBUFFER_COMPLETE. Drivers do
// expose extensions they cannot honour, so `getExtension() !== null` is treated
// as a hint, never as a guarantee.
//
// Measured on this machine (2026-07-27, Chrome 150, ANGLE/SwiftShader, headless):
//   EXT_color_buffer_float        present
//   EXT_color_buffer_half_float   present
//   OES_texture_float_linear      present
//   EXT_float_blend               present
//   EXT_texture_filter_anisotropic present (max 16)
//   KHR_parallel_shader_compile   ABSENT
//   EXT_texture_norm16            ABSENT   → "16 bits" means RGBA16F, never RGBA16
//   MAX_TEXTURE_SIZE = 8192, MAX_RENDERBUFFER_SIZE = 8192
// SwiftShader is a software rasteriser: it is a capability FLOOR, not a perf bench.

/** Working (compositing) pixel format. Always linear light, premultiplied alpha. */
export type WorkingFormat = 'rgba16f' | 'rgba32f' | 'rgba8'

/** Every texture format the engine is allowed to allocate. */
export type TextureFormat =
  | 'rgba8'
  | 'srgb8_alpha8'
  | 'rgba16f'
  | 'rgba32f'
  | 'r8'
  | 'r16f'

export interface TextureFormatInfo {
  /** GL sized internal format constant. */
  readonly internalFormat: GLenum
  /** GL client format constant used by texImage2D/texSubImage2D. */
  readonly format: GLenum
  /** Default GL client type for uploads. */
  readonly type: GLenum
  /** Bytes of VRAM per texel — the basis of all memory accounting. */
  readonly bytesPerTexel: number
  /** Number of colour channels stored. */
  readonly channels: 1 | 4
  /** true when the texels hold floating-point values. */
  readonly float: boolean
}

/**
 * Static description of each format. Resolved against a context at runtime
 * because GLenum values only exist on the context object.
 */
export function textureFormatInfo(
  gl: WebGL2RenderingContext,
  fmt: TextureFormat,
): TextureFormatInfo {
  switch (fmt) {
    case 'rgba8':
      return { internalFormat: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE, bytesPerTexel: 4, channels: 4, float: false }
    case 'srgb8_alpha8':
      // sRGB decode happens in the texture unit for free — §4.3 of the spec allows
      // this for 8-bit SOURCE textures only, never for the working space.
      return { internalFormat: gl.SRGB8_ALPHA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE, bytesPerTexel: 4, channels: 4, float: false }
    case 'rgba16f':
      return { internalFormat: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT, bytesPerTexel: 8, channels: 4, float: true }
    case 'rgba32f':
      return { internalFormat: gl.RGBA32F, format: gl.RGBA, type: gl.FLOAT, bytesPerTexel: 16, channels: 4, float: true }
    case 'r8':
      return { internalFormat: gl.R8, format: gl.RED, type: gl.UNSIGNED_BYTE, bytesPerTexel: 1, channels: 1, float: false }
    case 'r16f':
      return { internalFormat: gl.R16F, format: gl.RED, type: gl.HALF_FLOAT, bytesPerTexel: 2, channels: 1, float: true }
  }
}

/** Texture format backing a given working format. */
export function workingTextureFormat(w: WorkingFormat): TextureFormat {
  return w === 'rgba16f' ? 'rgba16f' : w === 'rgba32f' ? 'rgba32f' : 'rgba8'
}

export interface GLCaps {
  /** EXT_color_buffer_float — RGBA32F (and RGBA16F) usable as a render target. */
  readonly colorBufferFloat: boolean
  /** EXT_color_buffer_half_float — RGBA16F usable as a render target. */
  readonly colorBufferHalfFloat: boolean
  /** OES_texture_float_linear — LINEAR filtering on 32-bit float textures. */
  readonly textureFloatLinear: boolean
  /**
   * RGBA16F is filterable in core WebGL2, so this is always true; kept explicit
   * so callers never have to remember the asymmetry with 32F.
   */
  readonly textureHalfFloatLinear: boolean
  /** EXT_float_blend — hardware blending into a floating-point render target. */
  readonly floatBlend: boolean
  /**
   * EXT_texture_norm16 — normalised integer RGBA16. ABSENT on this machine, and
   * not needed: half-float has ~10 bits of mantissa per octave, which beats a
   * linear 16-bit integer in the shadows.
   */
  readonly textureNorm16: boolean
  /** 0 when unsupported, otherwise MAX_TEXTURE_MAX_ANISOTROPY_EXT. */
  readonly anisotropy: number
  /** KHR_parallel_shader_compile — lets link status be polled instead of blocked on. */
  readonly parallelShaderCompile: boolean
  /** WEBGL_lose_context — only used by tests and by dispose(). */
  readonly loseContext: boolean
  readonly maxTextureSize: number
  readonly maxRenderbufferSize: number
  readonly maxTextureImageUnits: number
  readonly maxCombinedTextureImageUnits: number
  readonly maxDrawBuffers: number
  /** Unmasked strings when WEBGL_debug_renderer_info is available. */
  readonly renderer: string
  readonly vendor: string
  /** Chosen after real FBO probing — never assumed. */
  readonly working: WorkingFormat
  /**
   * true when the working format is the RGBA8 fallback: stored values are LINEAR
   * (not sRGB) and must be ordered-dithered on store to hide the shadow banding.
   */
  readonly needsDither: boolean
  /** Formats that passed the FRAMEBUFFER_COMPLETE probe, in probe order. */
  readonly renderableFormats: readonly TextureFormat[]
}

export interface CapabilityOptions {
  /**
   * Extension names to pretend are missing. Test-only hook: it is the single
   * supported way to exercise the fallback paths without a second machine.
   */
  readonly disableExtensions?: readonly string[]
  /** Force a working format instead of probing. Test/diagnostic only. */
  readonly forceWorkingFormat?: WorkingFormat
  /**
   * Requested precision, mapped from the document's declared bit depth.
   * 32 only upgrades to RGBA32F when the hardware really supports it.
   */
  readonly preferredDepth?: 8 | 16 | 32
}

/** Extension lookup that honours the artificial-disable test hook. */
function ext(
  gl: WebGL2RenderingContext,
  name: string,
  disabled: readonly string[] | undefined,
): object | null {
  if (disabled && disabled.includes(name)) return null
  return gl.getExtension(name) as object | null
}

/**
 * Probe a candidate render-target format for real: allocate a 16×16 texture,
 * attach it, and require FRAMEBUFFER_COMPLETE with no GL error. Everything is
 * released before returning, whatever the outcome.
 */
export function probeRenderable(gl: WebGL2RenderingContext, fmt: TextureFormat): boolean {
  const info = textureFormatInfo(gl, fmt)
  const prevTex = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null
  const prevFb = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null
  const tex = gl.createTexture()
  const fb = gl.createFramebuffer()
  let ok = false
  try {
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texStorage2D(gl.TEXTURE_2D, 1, info.internalFormat, 16, 16)
    if (gl.getError() !== gl.NO_ERROR) return false
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
    ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE
      && gl.getError() === gl.NO_ERROR
  } finally {
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb)
    gl.bindTexture(gl.TEXTURE_2D, prevTex)
    gl.deleteFramebuffer(fb)
    gl.deleteTexture(tex)
  }
  return ok
}

/**
 * Probe order: RGBA16F → RGBA32F → RGBA8, biased by the requested depth.
 * RGBA8 is the last resort and stays LINEAR (dithered on store), never sRGB —
 * switching the fallback to sRGB storage would force conversions inside the
 * compositing loop, which §4.2 of the spec forbids.
 */
export function probeWorkingFormat(
  gl: WebGL2RenderingContext,
  caps: Pick<GLCaps, 'colorBufferFloat' | 'colorBufferHalfFloat' | 'textureFloatLinear'>,
  preferredDepth: 8 | 16 | 32 = 16,
): { working: WorkingFormat; renderable: TextureFormat[] } {
  const renderable: TextureFormat[] = []
  const half = caps.colorBufferHalfFloat || caps.colorBufferFloat
  const halfOk = half && probeRenderable(gl, 'rgba16f')
  if (halfOk) renderable.push('rgba16f')
  const fullOk = caps.colorBufferFloat && caps.textureFloatLinear && probeRenderable(gl, 'rgba32f')
  if (fullOk) renderable.push('rgba32f')
  if (probeRenderable(gl, 'rgba8')) renderable.push('rgba8')

  if (preferredDepth === 32 && fullOk) return { working: 'rgba32f', renderable }
  if (halfOk) return { working: 'rgba16f', renderable }
  if (fullOk) return { working: 'rgba32f', renderable }
  return { working: 'rgba8', renderable }
}

/**
 * Detect everything the engine may branch on. Extensions are fetched (not merely
 * listed), because in WebGL2 getExtension() is what actually ENABLES the
 * renderability of the float formats.
 */
export function detectCapabilities(
  gl: WebGL2RenderingContext,
  opts: CapabilityOptions = {},
): GLCaps {
  const off = opts.disableExtensions
  const colorBufferFloat = ext(gl, 'EXT_color_buffer_float', off) !== null
  const colorBufferHalfFloat = ext(gl, 'EXT_color_buffer_half_float', off) !== null || colorBufferFloat
  const textureFloatLinear = ext(gl, 'OES_texture_float_linear', off) !== null
  const floatBlend = ext(gl, 'EXT_float_blend', off) !== null
  const textureNorm16 = ext(gl, 'EXT_texture_norm16', off) !== null
  const parallelShaderCompile = ext(gl, 'KHR_parallel_shader_compile', off) !== null
  const loseContext = ext(gl, 'WEBGL_lose_context', off) !== null

  const aniso = ext(gl, 'EXT_texture_filter_anisotropic', off) as
    { MAX_TEXTURE_MAX_ANISOTROPY_EXT: GLenum } | null
  const anisotropy = aniso
    ? (gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number)
    : 0

  const dbg = ext(gl, 'WEBGL_debug_renderer_info', off) as
    { UNMASKED_RENDERER_WEBGL: GLenum; UNMASKED_VENDOR_WEBGL: GLenum } | null
  const renderer = String(gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER))
  const vendor = String(gl.getParameter(dbg ? dbg.UNMASKED_VENDOR_WEBGL : gl.VENDOR))

  const probed = probeWorkingFormat(
    gl,
    { colorBufferFloat, colorBufferHalfFloat, textureFloatLinear },
    opts.preferredDepth ?? 16,
  )
  const working = opts.forceWorkingFormat ?? probed.working

  return {
    colorBufferFloat,
    colorBufferHalfFloat,
    textureFloatLinear,
    textureHalfFloatLinear: true,
    floatBlend,
    textureNorm16,
    anisotropy,
    parallelShaderCompile,
    loseContext,
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    maxRenderbufferSize: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number,
    maxTextureImageUnits: gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS) as number,
    maxCombinedTextureImageUnits: gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS) as number,
    maxDrawBuffers: gl.getParameter(gl.MAX_DRAW_BUFFERS) as number,
    renderer,
    vendor,
    working,
    needsDither: working === 'rgba8',
    renderableFormats: probed.renderable,
  }
}

/** One-line human summary — used by the diagnostics panel and by CI logs. */
export function describeCaps(caps: GLCaps): string {
  const exts = [
    caps.colorBufferFloat && 'color_buffer_float',
    caps.colorBufferHalfFloat && 'color_buffer_half_float',
    caps.textureFloatLinear && 'texture_float_linear',
    caps.floatBlend && 'float_blend',
    caps.textureNorm16 && 'texture_norm16',
    caps.parallelShaderCompile && 'parallel_shader_compile',
    caps.anisotropy > 0 && `aniso×${caps.anisotropy}`,
  ].filter((s): s is string => typeof s === 'string')
  return `${caps.renderer} | working=${caps.working}${caps.needsDither ? ' (dithered fallback)' : ''}`
    + ` | maxTex=${caps.maxTextureSize} | ${exts.join(', ')}`
}
