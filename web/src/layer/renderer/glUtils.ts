// Low-level WebGL2 helpers: shader/program/VAO creation, offscreen framebuffers
// and a per-program uniform-location cache.
// Extracted verbatim from LayerEditorPage during the layer/ refactor.

// Per-program uniform-location cache: getUniformLocation is a driver round-trip
// and composeLayer runs once per layer per composited frame, so looking these up
// by name every call shows up on big layer stacks.
const uniformCache = new WeakMap<WebGLProgram, Map<string, WebGLUniformLocation | null>>()

export function uloc(gl: WebGL2RenderingContext, prog: WebGLProgram, name: string): WebGLUniformLocation | null {
  let m = uniformCache.get(prog)
  if (!m) { m = new Map(); uniformCache.set(prog, m) }
  if (!m.has(name)) m.set(name, gl.getUniformLocation(prog, name))
  return m.get(name)!
}

export function glShader(gl: WebGL2RenderingContext, type: number, src: string) {
  const s = gl.createShader(type)!
  gl.shaderSource(s, src); gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)!)
  return s
}

export function glProg(gl: WebGL2RenderingContext, vs: string, fs: string) {
  const p = gl.createProgram()!
  gl.attachShader(p, glShader(gl, gl.VERTEX_SHADER, vs))
  gl.attachShader(p, glShader(gl, gl.FRAGMENT_SHADER, fs))
  gl.linkProgram(p)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p)!)
  return p
}

export function glVAO(gl: WebGL2RenderingContext, prog: WebGLProgram) {
  const vao = gl.createVertexArray()!; gl.bindVertexArray(vao)
  const buf = gl.createBuffer()!; gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,1,1]), gl.STATIC_DRAW)
  const loc = gl.getAttribLocation(prog, 'aPos')
  gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
  gl.bindVertexArray(null); return vao
}

export function glFB(gl: WebGL2RenderingContext, w: number, h: number) {
  const tex = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  // Anisotropic filtering: the single biggest quality win when the document is
  // viewed minified AND rotated/oblique (trilinear alone picks one LOD and either
  // blurs or aliases along the stretched axis).
  const aniso = gl.getExtension('EXT_texture_filter_anisotropic')
  if (aniso) {
    const max = gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number
    gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, max))
  }
  const fb = gl.createFramebuffer()!
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  return { tex, fb }
}
