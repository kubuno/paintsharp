// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Magic-number detection for the exotic formats (spec 07 §1).
//
// NEVER the extension, NEVER the MIME type. The Files module returns
// `application/octet-stream` for a .cr3, `image/tiff` for a .nef, and a browser-guessed
// type for anything uploaded from a phone. A .jpg renamed .xcf must not reach the XCF
// decoder.
//
// Confidence scores follow the convention frozen in `formats/registry.ts`:
//   1.0  exclusive signature
//   0.9  shared signature where we are the more specific claimant (extra tags checked)
//   0.6  shared signature where we are the generic fallback
//   0.0  no match
// The registry keeps the maximum and breaks ties with the extension. TIFF-family RAW is
// exactly why the contract is a score and not a boolean: NEF, ARW, DNG and plain TIFF are
// byte-identical for the first four bytes.

import { latin1, matchAscii, matchBytes } from '../formats/reader'
import { readRawTiffHeader, sensorSize, sweepIfds, TAG } from './raw/tiff'
import { readBrands } from './raw/bmff'
import type { RawFormatId } from './raw/perFormat'

/** Below this a file is empty or truncated; nothing can be identified. */
const MIN_SNIFF_BYTES = 32

// ---------------------------------------------------------------------------
// XCF
// ---------------------------------------------------------------------------

/** `gimp xcf ` — an exclusive nine-byte signature. */
export function sniffXcf(head: Uint8Array): number {
  if (head.length < 26) return 0
  return matchAscii(head, 0, 'gimp xcf ') ? 1 : 0
}

// ---------------------------------------------------------------------------
// ISO-BMFF family: CR3, HEIC
// ---------------------------------------------------------------------------

const HEIF_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1'])
const AVIF_BRANDS = new Set(['avif', 'avis'])

function isBmff(head: Uint8Array): boolean {
  return matchAscii(head, 4, 'ftyp')
}

export function sniffCr3(head: Uint8Array): number {
  if (!isBmff(head)) return 0
  return readBrands(head).includes('crx ') ? 1 : 0
}

/**
 * HEIC/HEIF. AVIF shares the container and is deliberately NOT claimed here: it is
 * natively decodable everywhere and belongs to the plain raster path (spec 05).
 */
export function sniffHeif(head: Uint8Array): number {
  if (!isBmff(head)) return 0
  const brands = readBrands(head)
  if (brands.some((b) => AVIF_BRANDS.has(b))) return 0
  if (brands.some((b) => HEIF_BRANDS.has(b))) return brands[0] === 'mif1' ? 0.9 : 1
  return 0
}

// ---------------------------------------------------------------------------
// RAW with an exclusive signature
// ---------------------------------------------------------------------------

/** `II*\0` + IFD offset 0x10 + `CR` + major version. */
export function sniffCr2(head: Uint8Array): number {
  return matchBytes(head, 0, [0x49, 0x49, 0x2a, 0x00, 0x10, 0x00, 0x00, 0x00, 0x43, 0x52]) ? 1 : 0
}

/** `FUJIFILMCCD-RAW`. */
export function sniffRaf(head: Uint8Array): number {
  return matchAscii(head, 0, 'FUJIFILMCCD-RAW') ? 1 : 0
}

/** Olympus: a TIFF whose magic is 0x4F52 (`IIRO`), 0x5352 (`IIRS`) or `MMOR`. */
export function sniffOrf(head: Uint8Array): number {
  if (matchAscii(head, 0, 'IIRO') || matchAscii(head, 0, 'IIRS') || matchAscii(head, 0, 'MMOR')) {
    return 1
  }
  return 0
}

/** Panasonic RW2/RAW: `IIU\0`, a TIFF whose magic is 0x55. */
export function sniffRw2(head: Uint8Array): number {
  return matchBytes(head, 0, [0x49, 0x49, 0x55, 0x00]) ? 1 : 0
}

/** Families we recognise only in order to refuse them by name. */
export function sniffUnsupportedRaw(head: Uint8Array): 'raw-crw' | 'raw-x3f' | 'raw-mrw' | null {
  if (matchAscii(head, 6, 'HEAPCCDR')) return 'raw-crw'
  if (matchAscii(head, 0, 'FOVb')) return 'raw-x3f'
  if (matchBytes(head, 0, [0x00, 0x4d, 0x52, 0x4d])) return 'raw-mrw'
  return null
}

// ---------------------------------------------------------------------------
// TIFF family: NEF, ARW, DNG, and the generic RAW fallback
// ---------------------------------------------------------------------------

export interface TiffFamilyVerdict {
  readonly id: RawFormatId | 'tiff'
  readonly confidence: number
  /** `Make` as written in IFD0, for diagnostics. */
  readonly make?: string
}

const MAKE_TO_FORMAT: readonly (readonly [RegExp, RawFormatId])[] = [
  [/^NIKON/i, 'raw-nef'],
  [/^SONY/i, 'raw-arw'],
  [/^(PENTAX|RICOH)/i, 'raw-tiff-generic'],
  [/^SAMSUNG/i, 'raw-tiff-generic'],
  [/^Hasselblad/i, 'raw-tiff-generic'],
  [/^Phase\s?One/i, 'raw-tiff-generic'],
  [/^SEIKO\s?EPSON/i, 'raw-tiff-generic'],
  [/^Leica/i, 'raw-tiff-generic'],
  [/^Mamiya/i, 'raw-tiff-generic'],
  [/^EASTMAN\s?KODAK|^KODAK/i, 'raw-tiff-generic'],
]

/**
 * Classifies a TIFF-like header into a RAW flavour or plain TIFF.
 *
 * The order is the one the specification fixes, and it matters:
 *   1. `DNGVersion` (0xC612) is the only NORMATIVE discriminant — a DNG says so;
 *   2. `Make` names the manufacturer, which names the flavour;
 *   3. a CFA sub-IFD proves it is raw sensor data from an unknown body;
 *   4. otherwise it is an ordinary TIFF and belongs to the plain raster decoder.
 *
 * The IFD walk is a *sniff*, so it must be cheap and must never throw: on any doubt it
 * returns plain TIFF at low confidence and lets the registry arbitrate.
 */
export function classifyTiffFamily(head: Uint8Array): TiffFamilyVerdict {
  const header = readRawTiffHeader(head)
  if (!header) return { id: 'tiff', confidence: 0 }
  // Olympus and Panasonic already matched on their own magic.
  if (header.magic !== 42 && header.magic !== 43) return { id: 'tiff', confidence: 0 }

  try {
    const sweep = sweepIfds(head, header)
    const ifd0 = sweep.ifd0
    if (!ifd0) return { id: 'tiff', confidence: 0.3 }

    if (ifd0.entries.has(TAG.DNGVersion)) return { id: 'raw-dng', confidence: 0.95 }

    const make = ifd0.entries.get(TAG.Make)?.text?.trim()
    if (make) {
      for (const [pattern, id] of MAKE_TO_FORMAT) {
        if (pattern.test(make)) return { id, confidence: 0.9, make }
      }
    }

    // An unknown body still betrays itself with a colour-filter-array sub-IFD.
    if (sensorSize(sweep)) return { id: 'raw-tiff-generic', confidence: 0.8, make }

    return { id: 'tiff', confidence: 0.6, make }
  } catch {
    return { id: 'tiff', confidence: 0.3 }
  }
}

// ---------------------------------------------------------------------------
// Text formats: SVG, PDF
// ---------------------------------------------------------------------------

/** `%PDF-`, tolerating up to 1 KiB of junk preamble, which real-world PDFs do have. */
export function sniffPdf(head: Uint8Array): number {
  const limit = Math.min(head.length, 1024)
  for (let i = 0; i + 5 <= limit; i++) {
    if (matchAscii(head, i, '%PDF-')) return i === 0 ? 1 : 0.9
  }
  return 0
}

/**
 * SVG detection, which has no magic number at all.
 *
 * Skips a BOM, the XML declaration, comments and the DOCTYPE — including a DOCTYPE with
 * an internal subset, whose `[ … ]` legitimately contains `>` characters and defeats a
 * naive "skip to the next >" loop.
 */
export function sniffSvg(head: Uint8Array): number {
  let start = 0
  if (head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) start = 3
  const utf16 =
    (head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff)
  const text = utf16
    ? new TextDecoder(head[0] === 0xff ? 'utf-16le' : 'utf-16be', { fatal: false }).decode(
        head.subarray(2, Math.min(head.length, 8194)),
      )
    : latin1(head, start, Math.min(head.length - start, 4096))

  let i = 0
  for (let guard = 0; guard < 64; guard++) {
    while (i < text.length && /\s/.test(text[i])) i++
    if (text.startsWith('<?', i)) {
      const end = text.indexOf('?>', i)
      if (end < 0) break
      i = end + 2
      continue
    }
    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i)
      if (end < 0) break
      i = end + 3
      continue
    }
    if (text.startsWith('<!DOCTYPE', i) || text.startsWith('<!doctype', i)) {
      // An internal subset must be consumed as a unit: its brackets contain '>'.
      const bracket = text.indexOf('[', i)
      const close = text.indexOf('>', i)
      if (bracket >= 0 && close >= 0 && bracket < close) {
        const endSubset = text.indexOf(']', bracket)
        const end = endSubset >= 0 ? text.indexOf('>', endSubset) : -1
        if (end < 0) break
        i = end + 1
      } else {
        if (close < 0) break
        i = close + 1
      }
      continue
    }
    break
  }

  const rest = text.slice(i)
  if (/^<svg[\s/>]/.test(rest)) return 1
  if (/^<[A-Za-z_][\w.-]*:svg[\s/>]/.test(rest)) return 1
  // Exporters that emit stray content before the root still declare the namespace.
  if (text.includes('http://www.w3.org/2000/svg')) return 0.7
  return 0
}

/** gzip envelope: an `.svgz` must be inflated before detection can run again. */
export function isGzip(head: Uint8Array): boolean {
  return head.length >= 3 && head[0] === 0x1f && head[1] === 0x8b && head[2] === 0x08
}

export function tooShortToSniff(head: Uint8Array): boolean {
  return head.length < MIN_SNIFF_BYTES
}
