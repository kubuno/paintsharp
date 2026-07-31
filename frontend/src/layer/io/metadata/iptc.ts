// SPDX-License-Identifier: AGPL-3.0-or-later
//
// IPTC IIM parsing, inside its 8BIM envelope (spec 05 §6.5).
//
// Layout: a sequence of records `0x1C, record, dataset, length` where a length with
// bit 15 set introduces a 4-byte extended length. The block is usually wrapped in an
// 8BIM resource 0x0404 (JPEG APP13 `Photoshop 3.0\0`, TIFF tags 34377/33723).
//
// Text is Latin-1 unless dataset 1:90 declares `%G` (UTF-8) — respecting that is what
// stops accented captions from turning to mojibake.

import type { IptcData } from './types'

const IIM_MARKER = 0x1c
/** 1:90 CodedCharacterSet. */
const CODED_CHARACTER_SET = '1:90'

/** Datasets exposed in the UI, keyed `record:dataset`. */
export const IPTC_FIELD = {
  ObjectName: '2:05',
  Keywords: '2:25',
  Byline: '2:80',
  Headline: '2:105',
  Copyright: '2:116',
  Caption: '2:120',
  City: '2:90',
  Country: '2:101',
} as const

/**
 * Parses an IPTC block. Accepts either a bare IIM stream or a Photoshop 8BIM resource
 * block, which is what JPEG APP13 and TIFF 34377 actually carry.
 */
export function parseIptc(block: Uint8Array): IptcData | null {
  const iim = looksLike8Bim(block) ? extract8BimIptc(block) : block
  if (!iim || iim.length < 5) return null

  const raw = new Map<string, Uint8Array[]>()
  let p = 0
  let guard = 0
  while (p + 5 <= iim.length && guard++ < 8192) {
    if (iim[p] !== IIM_MARKER) {
      p++
      continue
    }
    const record = iim[p + 1]
    const dataset = iim[p + 2]
    let length = (iim[p + 3] << 8) | iim[p + 4]
    let dataStart = p + 5
    if ((length & 0x8000) !== 0) {
      // Extended length: the low bits give the size of the length field itself.
      const sizeOfLength = length & 0x7fff
      if (sizeOfLength !== 4 || dataStart + 4 > iim.length) break
      length =
        (iim[dataStart] << 24) | (iim[dataStart + 1] << 16) | (iim[dataStart + 2] << 8) | iim[dataStart + 3]
      dataStart += 4
    }
    if (length < 0 || dataStart + length > iim.length) break
    const key = `${record}:${String(dataset).padStart(2, '0')}`
    const list = raw.get(key) ?? []
    list.push(iim.subarray(dataStart, dataStart + length))
    raw.set(key, list)
    p = dataStart + length
  }
  if (raw.size === 0) return null

  const charset = raw.get(CODED_CHARACTER_SET)?.[0]
  const utf8 = charset ? isUtf8Escape(charset) : false
  const decode = utf8
    ? (b: Uint8Array) => new TextDecoder('utf-8', { fatal: false }).decode(b)
    : (b: Uint8Array) => {
        let s = ''
        for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i])
        return s
      }

  const datasets = new Map<string, string[]>()
  for (const [key, values] of raw) {
    datasets.set(
      key,
      values.map((v) => decode(v).replace(/\0+$/, '')),
    )
  }
  return { datasets, utf8 }
}

/** The ISO 2022 escape `\x1B%G` selects UTF-8. */
function isUtf8Escape(b: Uint8Array): boolean {
  return b.length >= 3 && b[0] === 0x1b && b[1] === 0x25 && b[2] === 0x47
}

function looksLike8Bim(b: Uint8Array): boolean {
  return b.length >= 4 && b[0] === 0x38 && b[1] === 0x42 && b[2] === 0x49 && b[3] === 0x4d
}

/** Walks 8BIM resources and returns the payload of resource 0x0404 (IPTC-NAA). */
export function extract8BimIptc(block: Uint8Array): Uint8Array | null {
  let p = 0
  let guard = 0
  while (p + 12 <= block.length && guard++ < 4096) {
    if (!looksLike8Bim(block.subarray(p, p + 4))) {
      p++
      continue
    }
    const id = (block[p + 4] << 8) | block[p + 5]
    const nameLen = block[p + 6]
    // Pascal name padded to an even total length (the length byte counts).
    let q = p + 6 + 1 + nameLen
    if ((nameLen + 1) % 2 === 1) q++
    if (q + 4 > block.length) break
    const size = (block[q] << 24) | (block[q + 1] << 16) | (block[q + 2] << 8) | block[q + 3]
    q += 4
    if (size < 0 || q + size > block.length) break
    if (id === 0x0404) return block.subarray(q, q + size)
    p = q + size + (size % 2)
  }
  return null
}

/** Value of a dataset, or the first value when repeated. */
export function iptcValue(data: IptcData | undefined, key: string): string | undefined {
  return data?.datasets.get(key)?.[0]
}

/** Every value of a repeatable dataset (2:25 Keywords is the usual one). */
export function iptcValues(data: IptcData | undefined, key: string): readonly string[] {
  return data?.datasets.get(key) ?? []
}

/**
 * Serialises datasets back to an IIM stream (UTF-8 declared through 1:90 `%G`).
 * The caller wraps it in an 8BIM resource for JPEG/TIFF.
 */
export function serializeIptc(data: IptcData): Uint8Array {
  const parts: number[] = []
  const push = (record: number, dataset: number, bytes: Uint8Array): void => {
    if (bytes.length > 0x7fff) return
    parts.push(IIM_MARKER, record, dataset, (bytes.length >> 8) & 0xff, bytes.length & 0xff)
    for (const b of bytes) parts.push(b)
  }
  // Always declare UTF-8 first: writing Latin-1 would silently mangle non-ASCII text.
  push(1, 90, new Uint8Array([0x1b, 0x25, 0x47]))
  const encoder = new TextEncoder()
  for (const [key, values] of data.datasets) {
    if (key === CODED_CHARACTER_SET) continue
    const [recordStr, datasetStr] = key.split(':')
    const record = Number(recordStr)
    const dataset = Number(datasetStr)
    if (!Number.isInteger(record) || !Number.isInteger(dataset)) continue
    for (const v of values) push(record, dataset, encoder.encode(v))
  }
  return new Uint8Array(parts)
}

/** Wraps an IIM stream in an 8BIM resource 0x0404, as JPEG APP13 and TIFF 34377 expect. */
export function wrap8Bim(iim: Uint8Array): Uint8Array {
  const padded = iim.length % 2 === 1 ? 1 : 0
  const out = new Uint8Array(12 + iim.length + padded)
  out[0] = 0x38
  out[1] = 0x42
  out[2] = 0x49
  out[3] = 0x4d // '8BIM'
  out[4] = 0x04
  out[5] = 0x04 // resource 0x0404
  out[6] = 0 // empty Pascal name
  out[7] = 0
  out[8] = (iim.length >>> 24) & 0xff
  out[9] = (iim.length >>> 16) & 0xff
  out[10] = (iim.length >>> 8) & 0xff
  out[11] = iim.length & 0xff
  out.set(iim, 12)
  return out
}
