// Stage 1 (GPU abstraction) — typed 2D texture.
//
// Storage is IMMUTABLE (texStorage2D): size, format and level count are fixed at
// creation, so the driver can pick its optimal layout once and the VRAM figure
// carried in the inventory can never drift from reality. Content updates go
// through texSubImage2D, which is also what the tiled engine wants (partial
// uploads, spec §8.1 "upload dirty-rect only").

import { textureFormatInfo, type TextureFormat, type TextureFormatInfo } from './capabilities'
import { ResourceTracker, type GLResource, type ResourceKind } from './resources'

export type TextureFilter = 'nearest' | 'linear'
export type TextureWrap = 'clamp' | 'repeat' | 'mirror'

export interface TextureOptions {
  readonly width: number
  readonly height: number
  readonly format: TextureFormat
  /** Mip levels to allocate. 1 = no pyramid (the tile pyramid is explicit, §3.6). */
  readonly levels?: number
  readonly minFilter?: TextureFilter
  readonly magFilter?: TextureFilter
  readonly wrap?: TextureWrap
  /** Max anisotropy to request; clamped to the hardware maximum by the device. */
  readonly anisotropy?: number
  /** Diagnostic name — shows up in leak reports. */
  readonly label?: string
}

export interface TextureUploadRegion {
  readonly x?: number
  readonly y?: number
  readonly width?: number
  readonly height?: number
  readonly level?: number
}

/** Pixel data accepted by `upload`. The client type is inferred from the view. */
export type TexturePixels = Uint8Array | Uint8ClampedArray | Uint16Array | Float32Array

// ── half-float helpers ─────────────────────────────────────────────────────
// Needed because RGBA16F uploads take a Uint16Array of IEEE-754 binary16 codes,
// and because tests must be able to build and verify 16F content on the CPU.

const f32 = new Float32Array(1)
const u32 = new Uint32Array(f32.buffer)

/** IEEE-754 binary32 → binary16 bit pattern (round-to-nearest-even ignored: RTZ+bias). */
export function floatToHalf(v: number): number {
  f32[0] = v
  const x = u32[0]!
  const sign = (x >>> 16) & 0x8000
  let exp = ((x >>> 23) & 0xff) - 127 + 15
  let mant = x & 0x7fffff
  if (exp <= 0) {
    if (exp < -10) return sign
    mant |= 0x800000
    const shift = 14 - exp
    return sign | (mant >>> shift)
  }
  if (exp >= 0x1f) return sign | 0x7c00
  return sign | (exp << 10) | (mant >>> 13)
}

/** IEEE-754 binary16 bit pattern → binary32 value. */
export function halfToFloat(h: number): number {
  const sign = (h & 0x8000) ? -1 : 1
  const exp = (h >>> 10) & 0x1f
  const mant = h & 0x3ff
  if (exp === 0) return sign * Math.pow(2, -14) * (mant / 1024)
  if (exp === 0x1f) return mant ? NaN : sign * Infinity
  return sign * Math.pow(2, exp - 15) * (1 + mant / 1024)
}

/** Convert a float buffer to the binary16 codes texSubImage2D expects. */
export function toHalfArray(src: ArrayLike<number>): Uint16Array {
  const out = new Uint16Array(src.length)
  for (let i = 0; i < src.length; i++) out[i] = floatToHalf(src[i]!)
  return out
}

/** Convert binary16 codes back to floats. */
export function fromHalfArray(src: Uint16Array): Float32Array {
  const out = new Float32Array(src.length)
  for (let i = 0; i < src.length; i++) out[i] = halfToFloat(src[i]!)
  return out
}

export class GLTexture implements GLResource {
  readonly kind: ResourceKind = 'texture'
  readonly resourceId = ResourceTracker.nextId()
  readonly label: string
  readonly width: number
  readonly height: number
  readonly levels: number
  readonly format: TextureFormat
  readonly info: TextureFormatInfo
  readonly gpuBytes: number

  private handleRef: WebGLTexture | null
  private minFilter: TextureFilter
  private magFilter: TextureFilter

  /**
   * Not called directly — go through `GLDevice.createTexture`, which registers
   * the object so that `dispose()` can be exhaustive.
   * @internal
   */
  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly tracker: ResourceTracker,
    opts: TextureOptions,
    maxAnisotropy: number,
  ) {
    const { width, height, format } = opts
    if (width <= 0 || height <= 0 || (width | 0) !== width || (height | 0) !== height) {
      throw new Error(`GLTexture: invalid size ${width}×${height}`)
    }
    this.label = opts.label ?? format
    this.width = width
    this.height = height
    this.levels = Math.max(1, opts.levels ?? 1)
    this.format = format
    this.info = textureFormatInfo(gl, format)
    this.minFilter = opts.minFilter ?? 'linear'
    this.magFilter = opts.magFilter ?? 'linear'

    const tex = gl.createTexture()
    if (!tex) throw new Error('GLTexture: createTexture failed (context lost?)')
    this.handleRef = tex

    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texStorage2D(gl.TEXTURE_2D, this.levels, this.info.internalFormat, width, height)
    this.applyFilter()
    this.applyWrap(opts.wrap ?? 'clamp')
    if (opts.anisotropy && maxAnisotropy > 1) {
      // Anisotropy is the single biggest quality win when the document is both
      // minified and rotated: trilinear alone picks one LOD and either blurs or
      // aliases along the stretched axis.
      const anisoExt = gl.getExtension('EXT_texture_filter_anisotropic')
      if (anisoExt) {
        gl.texParameterf(
          gl.TEXTURE_2D,
          anisoExt.TEXTURE_MAX_ANISOTROPY_EXT,
          Math.min(opts.anisotropy, maxAnisotropy),
        )
      }
    }
    gl.bindTexture(gl.TEXTURE_2D, null)

    // Mip chain adds 1/3 to the footprint, at most.
    const mipFactor = this.levels > 1 ? 4 / 3 : 1
    this.gpuBytes = Math.round(width * height * this.info.bytesPerTexel * mipFactor)
    tracker.register(this)
  }

  get disposed(): boolean {
    return this.handleRef === null
  }

  /** Raw GL object. Only stage-1 code may touch it. @internal */
  get handle(): WebGLTexture {
    if (!this.handleRef) throw new Error(`GLTexture(${this.label}): used after dispose`)
    return this.handleRef
  }

  bind(unit = 0): void {
    const gl = this.gl
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, this.handle)
  }

  setFilter(min: TextureFilter, mag: TextureFilter = min): void {
    if (min === this.minFilter && mag === this.magFilter) return
    this.minFilter = min
    this.magFilter = mag
    const gl = this.gl
    gl.bindTexture(gl.TEXTURE_2D, this.handle)
    this.applyFilter()
    gl.bindTexture(gl.TEXTURE_2D, null)
  }

  private applyFilter(): void {
    const gl = this.gl
    const min = this.minFilter === 'nearest'
      ? (this.levels > 1 ? gl.NEAREST_MIPMAP_NEAREST : gl.NEAREST)
      : (this.levels > 1 ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, min)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER,
      this.magFilter === 'nearest' ? gl.NEAREST : gl.LINEAR)
  }

  private applyWrap(wrap: TextureWrap): void {
    const gl = this.gl
    const w = wrap === 'repeat' ? gl.REPEAT
      : wrap === 'mirror' ? gl.MIRRORED_REPEAT
        : gl.CLAMP_TO_EDGE
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, w)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, w)
  }

  /** GL client type matching a typed-array view, validated against the format. */
  private clientType(px: TexturePixels): GLenum {
    const gl = this.gl
    if (px instanceof Float32Array) {
      if (!this.info.float) throw new Error(`GLTexture(${this.label}): Float32Array into an integer format`)
      return gl.FLOAT
    }
    if (px instanceof Uint16Array) {
      if (!this.info.float) throw new Error(`GLTexture(${this.label}): Uint16Array into an integer format`)
      return gl.HALF_FLOAT
    }
    if (this.info.float) throw new Error(`GLTexture(${this.label}): 8-bit data into a float format`)
    return gl.UNSIGNED_BYTE
  }

  /**
   * Upload a sub-rectangle. Defaults to the whole level-0 image.
   * `px === null` is a no-op: immutable storage is already allocated.
   */
  upload(px: TexturePixels | null, region: TextureUploadRegion = {}): void {
    if (!px) return
    const gl = this.gl
    const level = region.level ?? 0
    const x = region.x ?? 0
    const y = region.y ?? 0
    const w = region.width ?? Math.max(1, this.width >> level)
    const h = region.height ?? Math.max(1, this.height >> level)
    const need = w * h * this.info.channels
    if (px.length < need) {
      throw new Error(`GLTexture(${this.label}): need ${need} elements, got ${px.length}`)
    }
    gl.bindTexture(gl.TEXTURE_2D, this.handle)
    // Single-channel and float rows are not 4-byte aligned in general.
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.texSubImage2D(gl.TEXTURE_2D, level, x, y, w, h, this.info.format, this.clientType(px), px)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
    gl.bindTexture(gl.TEXTURE_2D, null)
  }

  /**
   * Upload from a DOM source (ImageBitmap, canvas, video…).
   * The engine never asks the browser to premultiply or to flip: both are done
   * in the upload shader, in linear light, which is the only correct place.
   */
  uploadSource(src: TexImageSource, region: TextureUploadRegion = {}): void {
    const gl = this.gl
    const level = region.level ?? 0
    const x = region.x ?? 0
    const y = region.y ?? 0
    const w = region.width ?? Math.max(1, this.width >> level)
    const h = region.height ?? Math.max(1, this.height >> level)
    gl.bindTexture(gl.TEXTURE_2D, this.handle)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0)
    gl.texSubImage2D(gl.TEXTURE_2D, level, x, y, w, h, this.info.format, this.info.type, src)
    gl.bindTexture(gl.TEXTURE_2D, null)
  }

  /** Rebuild the mip chain. Only meaningful when `levels > 1`. */
  generateMipmap(): void {
    if (this.levels <= 1) return
    const gl = this.gl
    gl.bindTexture(gl.TEXTURE_2D, this.handle)
    gl.generateMipmap(gl.TEXTURE_2D)
    gl.bindTexture(gl.TEXTURE_2D, null)
  }

  dispose(): void {
    if (!this.handleRef) return
    this.gl.deleteTexture(this.handleRef)
    this.handleRef = null
    this.tracker.unregister(this)
  }
}
