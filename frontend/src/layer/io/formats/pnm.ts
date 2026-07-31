// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PNM family: PBM/PGM/PPM (P1-P6), PAM (P7) and PFM (Pf/PF) — spec 05 §3.3.
//
// The header is a whitespace-separated token stream where `#` starts a comment that runs
// to the end of the line, and `maxval > 255` switches the samples to 16-bit BIG-ENDIAN.
// The type table and the header scanning follow GIMP's plug-ins/common/file-pnm.c
// (Copyright (C) 1995-2025 Spencer Kimball, Peter Mattis and the GIMP developers,
// GPL-3.0-or-later; Kubuno is AGPL-3.0-or-later, which is compatible). Reimplemented in
// TypeScript; no code was copied.

import { EMPTY_METADATA } from '../metadata/types'
import { allocF32, allocU16, allocU8, checkDimensions } from './limits'
import {
  IoInvalidError,
  IoUnsupportedError,
  WarningSink,
  type AlphaMode,
  type ColorModel,
  type DecodedFile,
  type RasterImage,
  type SampleArray,
} from './types'

/** Header cursor over the ASCII part of the file. */
class TokenReader {
  private p: number

  constructor(
    private readonly bytes: Uint8Array,
    start = 0,
  ) {
    this.p = start
  }

  get offset(): number {
    return this.p
  }

  /** Next whitespace-delimited token, skipping `#` comments. Empty at end of input. */
  next(): string {
    let guard = 0
    while (this.p < this.bytes.length && guard++ < 1_000_000) {
      const c = this.bytes[this.p]
      if (c === 0x23) {
        while (this.p < this.bytes.length && this.bytes[this.p] !== 0x0a) this.p++
        continue
      }
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) {
        this.p++
        continue
      }
      break
    }
    let s = ''
    while (this.p < this.bytes.length && s.length < 64) {
      const c = this.bytes[this.p]
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) break
      s += String.fromCharCode(c)
      this.p++
    }
    return s
  }

  /** Consumes the single whitespace byte that terminates a binary header. */
  consumeOneWhitespace(): void {
    if (this.p < this.bytes.length) {
      const c = this.bytes[this.p]
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) this.p++
    }
  }

  int(): number {
    const t = this.next()
    const v = Number.parseInt(t, 10)
    if (!Number.isFinite(v)) throw new IoInvalidError(`PNM: expected a number, got "${t}"`)
    return v
  }
}

export function decodePnm(bytes: Uint8Array): DecodedFile {
  const sink = new WarningSink()
  if (bytes.length < 3 || bytes[0] !== 0x50) throw new IoInvalidError('not a PNM file')
  const kind = String.fromCharCode(bytes[1])
  if (kind === '7') return decodePam(bytes, sink)
  if (kind === 'f' || kind === 'F') return decodePfm(bytes, kind === 'F', sink)

  const type = Number.parseInt(kind, 10)
  if (!Number.isInteger(type) || type < 1 || type > 6) {
    throw new IoUnsupportedError(`PNM type P${kind}`, 'pnm.type')
  }
  const t = new TokenReader(bytes, 2)
  const width = t.int()
  const height = t.int()
  checkDimensions(width, height, 'PNM')
  // P1/P4 (bitmap) have no maxval field.
  const maxval = type === 1 || type === 4 ? 1 : t.int()
  if (maxval < 1 || maxval > 65535) throw new IoInvalidError(`PNM maxval ${maxval}`)

  const channels = type === 3 || type === 6 ? 3 : 1
  const colorModel: ColorModel = channels === 3 ? 'rgb' : 'gray'
  const ascii = type <= 3
  const sixteenBit = maxval > 255
  const count = width * height * channels
  const data: SampleArray = sixteenBit ? allocU16(count, 'PNM') : allocU8(count, 'PNM')

  if (ascii) {
    for (let i = 0; i < count; i++) {
      const token = t.next()
      if (token === '') break
      const v = Number.parseInt(token, 10)
      // P1 stores 1 = black, the opposite of every other PNM type.
      data[i] = type === 1 ? (v ? 0 : 255) : v
    }
  } else {
    t.consumeOneWhitespace()
    const start = t.offset
    if (type === 4) {
      // Packed bitmap: rows padded to a byte, 1 = black.
      const rowBytes = Math.ceil(width / 8)
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const byte = bytes[start + y * rowBytes + (x >> 3)]
          if (byte === undefined) break
          data[y * width + x] = (byte >> (7 - (x & 7))) & 1 ? 0 : 255
        }
      }
    } else if (sixteenBit) {
      for (let i = 0; i < count; i++) {
        const o = start + i * 2
        if (o + 1 >= bytes.length) break
        data[i] = (bytes[o] << 8) | bytes[o + 1] // big-endian
      }
    } else {
      const available = Math.min(count, bytes.length - start)
      ;(data as Uint8Array).set(bytes.subarray(start, start + available))
    }
  }

  // Normalise an unusual maxval to the full range so consumers need not know about it.
  if (!ascii || type !== 1) rescale(data, maxval, sixteenBit ? 65535 : 255)

  return single(
    {
      width,
      height,
      colorModel,
      sampleType: sixteenBit ? 'u16' : 'u8',
      colorChannels: channels,
      alpha: 'none',
      data,
      colorSpace: { kind: 'srgb' },
      metadata: EMPTY_METADATA,
      sourceBitDepth: sixteenBit ? 16 : type === 1 || type === 4 ? 1 : 8,
    },
    sink,
  )
}

function decodePam(bytes: Uint8Array, sink: WarningSink): DecodedFile {
  const t = new TokenReader(bytes, 2)
  let width = 0
  let height = 0
  let depth = 0
  let maxval = 255
  let tupleType = ''
  for (let guard = 0; guard < 64; guard++) {
    const key = t.next()
    if (key === '' || key === 'ENDHDR') break
    const value = t.next()
    if (key === 'WIDTH') width = Number.parseInt(value, 10)
    else if (key === 'HEIGHT') height = Number.parseInt(value, 10)
    else if (key === 'DEPTH') depth = Number.parseInt(value, 10)
    else if (key === 'MAXVAL') maxval = Number.parseInt(value, 10)
    else if (key === 'TUPLTYPE') tupleType = value
  }
  checkDimensions(width, height, 'PAM')
  if (depth < 1 || depth > 4) throw new IoUnsupportedError(`PAM depth ${depth}`, 'pnm.pam-depth')
  t.consumeOneWhitespace()
  const start = t.offset

  const sixteenBit = maxval > 255
  const count = width * height * depth
  const data: SampleArray = sixteenBit ? allocU16(count, 'PAM') : allocU8(count, 'PAM')
  for (let i = 0; i < count; i++) {
    if (sixteenBit) {
      const o = start + i * 2
      if (o + 1 >= bytes.length) break
      data[i] = (bytes[o] << 8) | bytes[o + 1]
    } else {
      if (start + i >= bytes.length) break
      data[i] = bytes[start + i]
    }
  }
  rescale(data, maxval, sixteenBit ? 65535 : 255)

  const hasAlpha = depth === 2 || depth === 4 || tupleType.endsWith('_ALPHA')
  const colorChannels = depth >= 3 ? 3 : 1
  const alpha: AlphaMode = hasAlpha ? 'unassociated' : 'none'
  return single(
    {
      width,
      height,
      colorModel: colorChannels === 3 ? 'rgb' : 'gray',
      sampleType: sixteenBit ? 'u16' : 'u8',
      colorChannels,
      alpha,
      data,
      colorSpace: { kind: 'srgb' },
      metadata: EMPTY_METADATA,
      sourceBitDepth: sixteenBit ? 16 : 8,
    },
    sink,
  )
}

/** PFM: 32-bit floats, `scale < 0` means little-endian, rows stored bottom-up. */
function decodePfm(bytes: Uint8Array, color: boolean, sink: WarningSink): DecodedFile {
  const t = new TokenReader(bytes, 2)
  const width = t.int()
  const height = t.int()
  checkDimensions(width, height, 'PFM')
  const scale = Number.parseFloat(t.next())
  if (!Number.isFinite(scale)) throw new IoInvalidError('PFM: invalid scale factor')
  t.consumeOneWhitespace()
  const start = t.offset
  const littleEndian = scale < 0
  const channels = color ? 3 : 1
  const count = width * height * channels
  const data = allocF32(count, 'PFM')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let y = 0; y < height; y++) {
    // PFM rows run bottom-up.
    const srcRow = start + y * width * channels * 4
    const dstRow = (height - 1 - y) * width * channels
    for (let i = 0; i < width * channels; i++) {
      const o = srcRow + i * 4
      if (o + 4 > bytes.length) break
      data[dstRow + i] = view.getFloat32(o, littleEndian)
    }
  }
  return single(
    {
      width,
      height,
      colorModel: color ? 'rgb' : 'gray',
      sampleType: 'f32',
      colorChannels: channels,
      alpha: 'none',
      data,
      // PFM is scene-linear by construction: applying a transfer function here would be
      // the classic HDR mistake (spec 05 §5.3).
      colorSpace: { kind: 'linear-rec709' },
      metadata: EMPTY_METADATA,
      sourceBitDepth: 32,
    },
    sink,
  )
}

function rescale(data: SampleArray, maxval: number, target: number): void {
  if (maxval === target || maxval <= 0) return
  const f = target / maxval
  for (let i = 0; i < data.length; i++) data[i] = Math.min(target, Math.round(data[i] * f))
}

function single(image: RasterImage, sink: WarningSink): DecodedFile {
  return {
    formatId: 'pnm',
    pages: [{ image, role: 'main', index: 0 }],
    metadata: EMPTY_METADATA,
    warnings: sink.warnings,
  }
}

// ---------------------------------------------------------------------------
// Encoder
// ---------------------------------------------------------------------------

export interface PnmEncodeOptions {
  /** GIMP's single option: raw (binary) or ASCII. */
  readonly ascii?: boolean
  /** Forces a family; by default it follows the image (PBM/PGM/PPM/PAM/PFM). */
  readonly family?: 'pbm' | 'pgm' | 'ppm' | 'pam' | 'pfm'
}

export function encodePnm(image: RasterImage, opts: PnmEncodeOptions = {}): Uint8Array {
  const { width, height } = image
  checkDimensions(width, height, 'PNM')
  const hasAlpha = image.alpha !== 'none'
  const family =
    opts.family ??
    (image.sampleType === 'f32'
      ? 'pfm'
      : hasAlpha
        ? 'pam'
        : image.colorModel === 'gray' || image.colorModel === 'indexed'
          ? 'pgm'
          : 'ppm')

  if (family === 'pfm') return encodePfm(image)
  if (family === 'pam') return encodePam(image)

  const channels = family === 'ppm' ? 3 : 1
  const sixteenBit = image.sampleType === 'u16'
  const maxval = family === 'pbm' ? 1 : sixteenBit ? 65535 : 255
  const magic = opts.ascii
    ? family === 'pbm'
      ? 'P1'
      : family === 'pgm'
        ? 'P2'
        : 'P3'
    : family === 'pbm'
      ? 'P4'
      : family === 'pgm'
        ? 'P5'
        : 'P6'
  const header =
    family === 'pbm' ? `${magic}\n${width} ${height}\n` : `${magic}\n${width} ${height}\n${maxval}\n`
  const headerBytes = new TextEncoder().encode(header)

  const samples = extractSamples(image, channels, sixteenBit)
  if (opts.ascii) {
    const parts: string[] = []
    for (let i = 0; i < samples.length; i++) {
      parts.push(String(family === 'pbm' ? (samples[i] < 128 ? 1 : 0) : samples[i]))
      if ((i + 1) % 16 === 0) parts.push('\n')
      else parts.push(' ')
    }
    const body = new TextEncoder().encode(parts.join(''))
    return concat(headerBytes, body)
  }
  if (family === 'pbm') {
    const rowBytes = Math.ceil(width / 8)
    const body = new Uint8Array(rowBytes * height)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (samples[y * width + x] < 128) body[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7)
      }
    }
    return concat(headerBytes, body)
  }
  const body = new Uint8Array(samples.length * (sixteenBit ? 2 : 1))
  for (let i = 0; i < samples.length; i++) {
    if (sixteenBit) {
      body[i * 2] = (samples[i] >> 8) & 0xff
      body[i * 2 + 1] = samples[i] & 0xff
    } else {
      body[i] = samples[i]
    }
  }
  return concat(headerBytes, body)
}

function encodePam(image: RasterImage): Uint8Array {
  const channels = (image.colorModel === 'gray' || image.colorModel === 'indexed' ? 1 : 3) + 1
  const sixteenBit = image.sampleType === 'u16'
  const maxval = sixteenBit ? 65535 : 255
  const tupleType = channels === 2 ? 'GRAYSCALE_ALPHA' : 'RGB_ALPHA'
  const header = `P7\nWIDTH ${image.width}\nHEIGHT ${image.height}\nDEPTH ${channels}\nMAXVAL ${maxval}\nTUPLTYPE ${tupleType}\nENDHDR\n`
  const samples = extractSamples(image, channels, sixteenBit)
  const body = new Uint8Array(samples.length * (sixteenBit ? 2 : 1))
  for (let i = 0; i < samples.length; i++) {
    if (sixteenBit) {
      body[i * 2] = (samples[i] >> 8) & 0xff
      body[i * 2 + 1] = samples[i] & 0xff
    } else {
      body[i] = samples[i]
    }
  }
  return concat(new TextEncoder().encode(header), body)
}

function encodePfm(image: RasterImage): Uint8Array {
  const color = image.colorChannels >= 3
  const channels = color ? 3 : 1
  // Negative scale = little-endian, which is what every current machine wants.
  const header = `${color ? 'PF' : 'Pf'}\n${image.width} ${image.height}\n-1.0\n`
  const body = new Uint8Array(image.width * image.height * channels * 4)
  const view = new DataView(body.buffer)
  const spp = image.data.length / (image.width * image.height)
  for (let y = 0; y < image.height; y++) {
    const srcRow = (image.height - 1 - y) * image.width * spp
    const dstRow = y * image.width * channels
    for (let x = 0; x < image.width; x++) {
      for (let c = 0; c < channels; c++) {
        view.setFloat32((dstRow + x * channels + c) * 4, Number(image.data[srcRow + x * spp + c] ?? 0), true)
      }
    }
  }
  return concat(new TextEncoder().encode(header), body)
}

/** Interleaved samples in the requested channel count, dropping or padding as needed. */
function extractSamples(image: RasterImage, channels: number, sixteenBit: boolean): Uint16Array {
  const pixels = image.width * image.height
  const spp = image.data.length / pixels
  const out = new Uint16Array(pixels * channels)
  const max = sixteenBit ? 65535 : 255
  const srcMax = image.sampleType === 'u16' ? 65535 : image.sampleType === 'u8' ? 255 : 1
  for (let i = 0; i < pixels; i++) {
    const s = i * spp
    for (let c = 0; c < channels; c++) {
      const raw = Number(image.data[s + Math.min(c, spp - 1)] ?? 0)
      const scaled = image.sampleType === 'f32' ? raw * max : (raw * max) / srcMax
      out[i * channels + c] = Math.max(0, Math.min(max, Math.round(scaled)))
    }
  }
  return out
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}
