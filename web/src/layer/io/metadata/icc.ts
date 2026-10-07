// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ICC profile header + tag table parsing (spec 05 §6.6).
//
// This is NOT a colour-management engine. The raw bytes are always kept so the original
// profile can be re-embedded on export, even a LUT-based one we cannot interpret; only
// the matrix/TRC part is reduced to primaries + transfer, which covers ~95 % of real
// images (sRGB, Adobe RGB, Display P3, ProPhoto).
//
// The APP2 chunking rules used by the JPEG writer follow GIMP's jpeg-icc.c
// (plug-ins/file-jpeg/, GPL-3.0-or-later). Reimplemented; no code copied.

import type { Chromaticities, IccProfile, RenderingIntent, TransferFn, XYZ } from './types'

const HEADER_SIZE = 128

/** Parses the header and the tags we use. Returns `null` when the bytes are not a profile. */
export function parseIcc(raw: Uint8Array): IccProfile | null {
  if (raw.length < HEADER_SIZE + 4) return null
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  const size = view.getUint32(0, false)
  // The declared size may exceed the buffer on truncated files: tolerate, but sanity-check.
  if (size < HEADER_SIZE || size > 100 * 1024 * 1024) return null
  const colorSpace = sig(raw, 16)
  const pcs = sig(raw, 20)
  const versionMajor = raw[8]
  const versionMinor = raw[9] >> 4
  const intentRaw = view.getUint32(64, false)
  const renderingIntent = (intentRaw <= 3 ? intentRaw : 0) as RenderingIntent

  const tags = readTagTable(raw, view)
  const description = readDescription(raw, view, tags)
  const matrixTrc = readMatrixTrc(raw, view, tags)

  return {
    raw,
    size,
    colorSpace,
    pcs,
    version: `${versionMajor}.${versionMinor}`,
    renderingIntent,
    description,
    matrixTrc,
  }
}

interface IccTag {
  readonly offset: number
  readonly size: number
}

function readTagTable(raw: Uint8Array, view: DataView): Map<string, IccTag> {
  const tags = new Map<string, IccTag>()
  const count = view.getUint32(HEADER_SIZE, false)
  if (count > 1024) return tags
  for (let i = 0; i < count; i++) {
    const p = HEADER_SIZE + 4 + i * 12
    if (p + 12 > raw.length) break
    const name = sig(raw, p)
    const offset = view.getUint32(p + 4, false)
    const size = view.getUint32(p + 8, false)
    if (offset + size > raw.length) continue
    tags.set(name, { offset, size })
  }
  return tags
}

function readDescription(raw: Uint8Array, view: DataView, tags: Map<string, IccTag>): string | undefined {
  const tag = tags.get('desc')
  if (!tag || tag.size < 12) return undefined
  const type = sig(raw, tag.offset)
  if (type === 'desc') {
    // ICC v2 'desc': ASCII length then the string.
    const len = view.getUint32(tag.offset + 8, false)
    if (len === 0 || tag.offset + 12 + len > raw.length) return undefined
    return latin1(raw, tag.offset + 12, Math.min(len - 1, 255))
  }
  if (type === 'mluc') {
    // ICC v4 multi-localised Unicode: take the first record, UTF-16BE.
    const records = view.getUint32(tag.offset + 8, false)
    if (records === 0) return undefined
    const len = view.getUint32(tag.offset + 20, false)
    const off = view.getUint32(tag.offset + 24, false)
    const start = tag.offset + off
    if (len === 0 || start + len > raw.length) return undefined
    let s = ''
    for (let i = 0; i + 1 < Math.min(len, 512); i += 2) {
      s += String.fromCharCode((raw[start + i] << 8) | raw[start + i + 1])
    }
    return s
  }
  return undefined
}

function readMatrixTrc(
  raw: Uint8Array,
  view: DataView,
  tags: Map<string, IccTag>,
): IccProfile['matrixTrc'] {
  const r = readXyz(view, tags.get('rXYZ'))
  const g = readXyz(view, tags.get('gXYZ'))
  const b = readXyz(view, tags.get('bXYZ'))
  const wtpt = readXyz(view, tags.get('wtpt'))
  if (!r || !g || !b || !wtpt) return undefined
  const transfer = readTrc(raw, view, tags.get('rTRC')) ?? { kind: 'srgb' as const }
  return { primaries: xyzToChromaticities(r, g, b, wtpt), transfer, wtpt }
}

function readXyz(view: DataView, tag: IccTag | undefined): XYZ | undefined {
  if (!tag || tag.size < 20) return undefined
  // 's15Fixed16Number' triplet after the 8-byte type header.
  const at = (o: number) => view.getInt32(tag.offset + o, false) / 65536
  return { x: at(8), y: at(12), z: at(16) }
}

function readTrc(raw: Uint8Array, view: DataView, tag: IccTag | undefined): TransferFn | undefined {
  if (!tag || tag.size < 12) return undefined
  const type = sig(raw, tag.offset)
  if (type === 'curv') {
    const count = view.getUint32(tag.offset + 8, false)
    if (count === 0) return { kind: 'linear' }
    if (count === 1) {
      // A single u8Fixed8 value is a pure gamma.
      return { kind: 'gamma', gamma: view.getUint16(tag.offset + 12, false) / 256 }
    }
    const n = Math.min(count, 4096)
    if (tag.offset + 12 + n * 2 > raw.length) return undefined
    const samples = new Float32Array(n)
    for (let i = 0; i < n; i++) samples[i] = view.getUint16(tag.offset + 12 + i * 2, false) / 65535
    return { kind: 'curve', samples }
  }
  if (type === 'para') {
    const fn = view.getUint16(tag.offset + 8, false)
    const g = view.getInt32(tag.offset + 12, false) / 65536
    // Type 3/4 with these coefficients is sRGB; anything else is reported as a gamma.
    if (fn === 0) return { kind: 'gamma', gamma: g }
    return { kind: 'srgb' }
  }
  return undefined
}

function xyzToChromaticities(r: XYZ, g: XYZ, b: XYZ, w: XYZ): Chromaticities {
  const xy = (v: XYZ): [number, number] => {
    const sum = v.x + v.y + v.z
    return sum === 0 ? [0, 0] : [v.x / sum, v.y / sum]
  }
  const [rx, ry] = xy(r)
  const [gx, gy] = xy(g)
  const [bx, by] = xy(b)
  const [wx, wy] = xy(w)
  return { rx, ry, gx, gy, bx, by, wx, wy }
}

/** True when the profile is (bit-for-bit or by description) plain sRGB. */
export function isSrgbProfile(p: IccProfile): boolean {
  if (p.colorSpace !== 'RGB ') return false
  const d = p.description?.toLowerCase() ?? ''
  return d.includes('srgb')
}

// ---------------------------------------------------------------------------
// JPEG APP2 chunking — an ICC profile larger than 65 533 bytes must be split across
// several APP2 segments, each prefixed by `ICC_PROFILE\0` + 1-based index + total.
// ---------------------------------------------------------------------------

const ICC_JPEG_ID = 'ICC_PROFILE\0'
/** 65 533 payload − 12 id bytes − 2 counter bytes. */
const ICC_CHUNK_MAX = 65519

export function splitIccForJpeg(raw: Uint8Array): Uint8Array[] {
  const chunks: Uint8Array[] = []
  const total = Math.max(1, Math.ceil(raw.length / ICC_CHUNK_MAX))
  if (total > 255) return [] // cannot be represented; caller warns
  for (let i = 0; i < total; i++) {
    const slice = raw.subarray(i * ICC_CHUNK_MAX, Math.min(raw.length, (i + 1) * ICC_CHUNK_MAX))
    const out = new Uint8Array(ICC_JPEG_ID.length + 2 + slice.length)
    for (let k = 0; k < ICC_JPEG_ID.length; k++) out[k] = ICC_JPEG_ID.charCodeAt(k)
    out[ICC_JPEG_ID.length] = i + 1
    out[ICC_JPEG_ID.length + 1] = total
    out.set(slice, ICC_JPEG_ID.length + 2)
    chunks.push(out)
  }
  return chunks
}

/** Reassembles the APP2 chunks of a JPEG back into one profile, in index order. */
export function joinIccFromJpeg(segments: readonly Uint8Array[]): Uint8Array | null {
  const parts: { index: number; data: Uint8Array }[] = []
  for (const s of segments) {
    if (s.length < ICC_JPEG_ID.length + 2) continue
    let ok = true
    for (let k = 0; k < ICC_JPEG_ID.length; k++) {
      if (s[k] !== ICC_JPEG_ID.charCodeAt(k)) {
        ok = false
        break
      }
    }
    if (!ok) continue
    parts.push({ index: s[ICC_JPEG_ID.length], data: s.subarray(ICC_JPEG_ID.length + 2) })
  }
  if (parts.length === 0) return null
  parts.sort((a, b) => a.index - b.index)
  const total = parts.reduce((n, p) => n + p.data.length, 0)
  const out = new Uint8Array(total)
  let p = 0
  for (const part of parts) {
    out.set(part.data, p)
    p += part.data.length
  }
  return out
}

function sig(raw: Uint8Array, offset: number): string {
  if (offset + 4 > raw.length) return ''
  return String.fromCharCode(raw[offset], raw[offset + 1], raw[offset + 2], raw[offset + 3])
}

function latin1(raw: Uint8Array, offset: number, length: number): string {
  let s = ''
  const end = Math.min(raw.length, offset + length)
  for (let i = offset; i < end; i++) {
    if (raw[i] === 0) break
    s += String.fromCharCode(raw[i])
  }
  return s
}
