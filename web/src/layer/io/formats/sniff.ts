// Magic-number format detection (spec 05 §7 / spec 07 §1).
//
// NEVER trust the extension or the MIME type. The Files module returns
// `application/octet-stream` for a .cr3, `image/tiff` for a .nef, and a browser-guessed
// type for anything uploaded from a phone. A .jpg renamed .xcf must not reach the XCF
// decoder. The name is used ONLY to break ties between byte-identical containers.
//
// The detector reads the first bytes (64 KiB is plenty) plus, for TGA alone, the last
// 18 bytes. It allocates nothing proportional to the file size and never throws.

import { matchAscii, matchBytes } from './reader'

/**
 * Detection input. `tail` is only needed for the TGA 2.0 footer; everything else is
 * decided on the head.
 */
export interface SniffInput {
  /** First bytes of the file (>= 64 KiB recommended, >= 8 bytes minimum). */
  readonly head: Uint8Array
  /** Last 18 bytes, for the TGA footer. Optional. */
  readonly tail?: Uint8Array
  /** File name — used ONLY to disambiguate byte-identical containers. */
  readonly name?: string
  readonly size?: number
}

/** Container family, for diagnostics and for the "unsupported format" message. */
export type ContainerKind = 'raw-bytes' | 'tiff' | 'iso-bmff' | 'riff' | 'text' | 'xcf'

/**
 * Every id this detector can emit. Ids owned by the animated (06) and exotic (07) specs
 * are listed too: detection is centralised so a `.nef` never reaches the TIFF decoder.
 */
export type SniffedFormatId =
  | 'png' | 'jpeg' | 'webp' | 'avif' | 'bmp' | 'ico' | 'cur' | 'tiff'
  | 'tga' | 'pnm' | 'dds' | 'exr' | 'hdr'
  | 'gif' | 'apng' | 'webp-animated'
  | 'psd' | 'xcf' | 'heif' | 'svg' | 'pdf' | 'jpeg2000'
  | 'raw-cr2' | 'raw-cr3' | 'raw-nef' | 'raw-arw' | 'raw-dng'
  | 'raw-orf' | 'raw-raf' | 'raw-rw2' | 'raw-tiff-generic'

export interface SniffResult {
  readonly id: SniffedFormatId
  /** Same convention as `FormatDescriptor.sniff`: 1 exclusive, 0.9 specific, 0.6 generic. */
  readonly confidence: number
  readonly container: ContainerKind
}

/** Below this a file cannot be identified at all. */
const MIN_SNIFF_BYTES = 8

function result(id: SniffedFormatId, container: ContainerKind, confidence = 1): SniffResult {
  return { id, confidence, container }
}

// ---------------------------------------------------------------------------
// Individual signatures — each is exported so a FormatDescriptor can reuse it.
// ---------------------------------------------------------------------------

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

export function isPng(head: Uint8Array): boolean {
  return matchBytes(head, 0, PNG_SIG)
}

/** APNG = PNG carrying an `acTL` chunk before the first `IDAT`. */
export function isApng(head: Uint8Array): boolean {
  if (!isPng(head)) return false
  let p = 8
  // Bounded chunk walk: stop at IDAT, at the end of the probe window, or after 64 chunks.
  for (let guard = 0; guard < 64 && p + 8 <= head.length; guard++) {
    const len =
      (head[p] << 24) | (head[p + 1] << 16) | (head[p + 2] << 8) | head[p + 3]
    if (len < 0) return false
    if (matchAscii(head, p + 4, 'acTL')) return true
    if (matchAscii(head, p + 4, 'IDAT')) return false
    p += 12 + len
  }
  return false
}

export function isJpeg(head: Uint8Array): boolean {
  return matchBytes(head, 0, [0xff, 0xd8, 0xff])
}

export function isGif(head: Uint8Array): boolean {
  return matchAscii(head, 0, 'GIF87a') || matchAscii(head, 0, 'GIF89a')
}

export function isRiffWebp(head: Uint8Array): boolean {
  return matchAscii(head, 0, 'RIFF') && matchAscii(head, 8, 'WEBP')
}

/** Animated WebP: extended container whose VP8X sets the ANIM flag, or an ANMF chunk. */
export function isAnimatedWebp(head: Uint8Array): boolean {
  if (!isRiffWebp(head)) return false
  if (matchAscii(head, 12, 'VP8X') && head.length > 20) {
    // VP8X flags byte: bit 1 (0x02) = animation.
    if ((head[20] & 0x02) !== 0) return true
  }
  // Fall back to spotting an ANMF chunk in the probe window.
  for (let p = 12; p + 4 <= Math.min(head.length, 4096); p += 2) {
    if (matchAscii(head, p, 'ANMF')) return true
  }
  return false
}

export function isBmp(head: Uint8Array): boolean {
  // 'BM' is only two bytes: cross-check the DIB header size, which is one of the five
  // documented values. Without this, any text file starting with "BM" matches.
  if (!matchAscii(head, 0, 'BM') || head.length < 18) return false
  const dib = readU32LE(head, 14)
  return dib === 12 || dib === 40 || dib === 52 || dib === 56 || dib === 64 || dib === 108 || dib === 124
}

export function isIco(head: Uint8Array): boolean {
  return matchBytes(head, 0, [0x00, 0x00, 0x01, 0x00]) && icoCountLooksSane(head)
}

export function isCur(head: Uint8Array): boolean {
  return matchBytes(head, 0, [0x00, 0x00, 0x02, 0x00]) && icoCountLooksSane(head)
}

function icoCountLooksSane(head: Uint8Array): boolean {
  if (head.length < 6) return false
  const n = head[4] | (head[5] << 8)
  return n >= 1 && n <= 512
}

export function isTiffLike(head: Uint8Array): boolean {
  return tiffFlavour(head) !== null
}

export interface TiffFlavour {
  readonly littleEndian: boolean
  /** 42 classic, 43 BigTIFF, 0x4f52/0x5352 Olympus ORF, 0x55 Panasonic RW2. */
  readonly magic: number
  readonly bigTiff: boolean
}

/** Recognises the whole TIFF family from the 4-byte header. */
export function tiffFlavour(head: Uint8Array): TiffFlavour | null {
  if (head.length < 8) return null
  const le = head[0] === 0x49 && head[1] === 0x49
  const be = head[0] === 0x4d && head[1] === 0x4d
  if (!le && !be) return null
  const magic = le ? head[2] | (head[3] << 8) : (head[2] << 8) | head[3]
  if (magic === 42) return { littleEndian: le, magic, bigTiff: false }
  if (magic === 43) return { littleEndian: le, magic, bigTiff: true }
  // Pseudo-TIFF RAW containers, magic taken from GIMP
  // plug-ins/file-raw/file-raw-formats.h (GPLv3, see attribution header of this module).
  if (le && (magic === 0x4f52 || magic === 0x5352)) return { littleEndian: true, magic, bigTiff: false }
  if (be && magic === 0x4f52) return { littleEndian: false, magic, bigTiff: false }
  if (le && magic === 0x55) return { littleEndian: true, magic, bigTiff: false }
  return null
}

export function isDds(head: Uint8Array): boolean {
  return matchAscii(head, 0, 'DDS ')
}

export function isExr(head: Uint8Array): boolean {
  return matchBytes(head, 0, [0x76, 0x2f, 0x31, 0x01])
}

export function isHdr(head: Uint8Array): boolean {
  return matchAscii(head, 0, '#?RADIANCE') || matchAscii(head, 0, '#?RGBE')
}

export function isPsd(head: Uint8Array): boolean {
  return matchAscii(head, 0, '8BPS')
}

export function isXcf(head: Uint8Array): boolean {
  return matchAscii(head, 0, 'gimp xcf ')
}

export function isPdf(head: Uint8Array): boolean {
  // Some PDFs carry junk before %PDF-; the spec tolerates up to 1 KiB.
  const limit = Math.min(head.length, 1024)
  for (let i = 0; i + 5 <= limit; i++) {
    if (matchAscii(head, i, '%PDF-')) return true
  }
  return false
}

export function isJpeg2000(head: Uint8Array): boolean {
  return (
    matchBytes(head, 0, [0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a]) ||
    matchBytes(head, 0, [0xff, 0x4f, 0xff, 0x51])
  )
}

/** PNM/PAM/PFM: `P1`..`P7`, `PF`/`Pf`, followed by whitespace. */
export function isPnm(head: Uint8Array): boolean {
  if (head.length < 3 || head[0] !== 0x50) return false
  const c = head[1]
  const ws = head[2]
  const isWs = ws === 0x20 || ws === 0x09 || ws === 0x0a || ws === 0x0d
  if (!isWs) return false
  if (c >= 0x31 && c <= 0x37) return true // '1'..'7'
  return c === 0x46 || c === 0x66 // 'F' / 'f' (PFM)
}

// ---- ISO-BMFF ------------------------------------------------------------

export interface BmffBrands {
  readonly major: string
  readonly compatible: readonly string[]
}

export function bmffBrands(head: Uint8Array): BmffBrands | null {
  if (head.length < 16 || !matchAscii(head, 4, 'ftyp')) return null
  const size = readU32BE(head, 0)
  const end = Math.min(head.length, size > 0 && size <= head.length ? size : head.length)
  const major = asciiAt(head, 8, 4)
  const compatible: string[] = []
  for (let p = 16; p + 4 <= end && compatible.length < 32; p += 4) {
    compatible.push(asciiAt(head, p, 4))
  }
  return { major, compatible }
}

const AVIF_BRANDS = new Set(['avif', 'avis'])
const HEIF_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1'])

export function isAvif(head: Uint8Array): boolean {
  const b = bmffBrands(head)
  if (!b) return false
  if (AVIF_BRANDS.has(b.major)) return true
  // `mif1` + an `av01`-flavoured compatible brand is still an AVIF.
  return b.compatible.some((x) => AVIF_BRANDS.has(x))
}

export function isHeif(head: Uint8Array): boolean {
  const b = bmffBrands(head)
  if (!b) return false
  if (isAvif(head)) return false
  return HEIF_BRANDS.has(b.major) || b.compatible.some((x) => HEIF_BRANDS.has(x))
}

// ---- SVG (text, no magic) -------------------------------------------------

export function svgConfidence(head: Uint8Array): number {
  // Strip a UTF-8 BOM, decode a small window, skip prologue nodes.
  let start = 0
  if (matchBytes(head, 0, [0xef, 0xbb, 0xbf])) start = 3
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: false }).decode(head.subarray(start, Math.min(head.length, start + 4096)))
  } catch {
    return 0
  }
  let s = text
  for (let guard = 0; guard < 16; guard++) {
    s = s.replace(/^\s+/, '')
    if (s.startsWith('<?xml')) {
      const i = s.indexOf('?>')
      if (i < 0) break
      s = s.slice(i + 2)
      continue
    }
    if (s.startsWith('<!--')) {
      const i = s.indexOf('-->')
      if (i < 0) break
      s = s.slice(i + 3)
      continue
    }
    if (s.startsWith('<!DOCTYPE')) {
      // The internal subset may contain '>' characters inside [ ... ].
      let depth = 0
      let i = 0
      for (; i < s.length; i++) {
        const ch = s[i]
        if (ch === '[') depth++
        else if (ch === ']') depth--
        else if (ch === '>' && depth <= 0) break
      }
      if (i >= s.length) break
      s = s.slice(i + 1)
      continue
    }
    break
  }
  if (/^<svg[\s>]/.test(s)) return 1
  if (/^<[A-Za-z_][\w.-]*:svg[\s>]/.test(s)) return 1
  if (text.includes('xmlns="http://www.w3.org/2000/svg"')) return 0.7
  return 0
}

// ---- TGA (no magic in 1.0) -----------------------------------------------

const TGA_FOOTER = 'TRUEVISION-XFILE'

/** 1 when the 2.0 footer is present, 0.4 for a plausible 1.0 header, 0 otherwise. */
export function tgaConfidence(input: SniffInput): number {
  const tail = input.tail
  if (tail && tail.length >= 18 && matchAscii(tail, tail.length - 18, TGA_FOOTER)) return 1
  const h = input.head
  if (h.length < 18) return 0
  const colorMapType = h[1]
  const imageType = h[2]
  const bpp = h[16]
  const desc = h[17]
  if (colorMapType > 1) return 0
  if (![0, 1, 2, 3, 9, 10, 11, 32, 33].includes(imageType)) return 0
  if (imageType === 0) return 0
  if (![8, 15, 16, 24, 32].includes(bpp)) return 0
  if ((desc & 0xc0) !== 0) return 0 // reserved bits must be zero
  const w = h[12] | (h[13] << 8)
  const hh = h[14] | (h[15] << 8)
  if (w === 0 || hh === 0) return 0
  if (colorMapType === 0 && (h[3] | h[4] | h[5] | h[6] | h[7]) !== 0) return 0
  // Weak evidence only: the extension must agree for this to win a tie.
  return 0.4
}

// ---------------------------------------------------------------------------
// TIFF family disambiguation (spec 07 §1.3) — a *bounded* IFD0 scan.
// ---------------------------------------------------------------------------

const TAG_MAKE = 0x010f
const TAG_PHOTOMETRIC = 0x0106
const TAG_DNG_VERSION = 0xc612
const TAG_SUB_IFDS = 0x014a
/** PhotometricInterpretation = 32803: colour filter array, i.e. undemosaiced RAW. */
const PHOTOMETRIC_CFA = 32803

interface Ifd0Facts {
  readonly make: string
  readonly hasDngVersion: boolean
  readonly hasSubIfds: boolean
  readonly photometric: number | null
}

/** Reads only IFD0's entries, inside the probe window, never following offsets far out. */
function scanIfd0(head: Uint8Array, le: boolean, bigTiff: boolean): Ifd0Facts | null {
  try {
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength)
    const u16 = (o: number) => (o + 2 <= head.length ? view.getUint16(o, le) : -1)
    const u32 = (o: number) => (o + 4 <= head.length ? view.getUint32(o, le) : -1)
    let ifdOffset: number
    let entrySize: number
    let count: number
    let entryStart: number
    if (bigTiff) {
      if (head.length < 16) return null
      const off = view.getBigUint64(8, le)
      if (off > BigInt(head.length)) return null
      ifdOffset = Number(off)
      if (ifdOffset + 8 > head.length) return null
      count = Number(view.getBigUint64(ifdOffset, le))
      entryStart = ifdOffset + 8
      entrySize = 20
    } else {
      ifdOffset = u32(4)
      if (ifdOffset < 8 || ifdOffset + 2 > head.length) return null
      count = u16(ifdOffset)
      entryStart = ifdOffset + 2
      entrySize = 12
    }
    if (count < 0 || count > 4096) return null

    let make = ''
    let hasDngVersion = false
    let hasSubIfds = false
    let photometric: number | null = null

    for (let i = 0; i < count; i++) {
      const e = entryStart + i * entrySize
      if (e + entrySize > head.length) break
      const tag = u16(e)
      const type = u16(e + 2)
      if (tag === TAG_DNG_VERSION) hasDngVersion = true
      else if (tag === TAG_SUB_IFDS) hasSubIfds = true
      else if (tag === TAG_PHOTOMETRIC && type === 3) {
        photometric = u16(bigTiff ? e + 12 : e + 8)
      } else if (tag === TAG_MAKE && type === 2 && !bigTiff) {
        const n = u32(e + 4)
        if (n > 0 && n < 128) {
          const off = n <= 4 ? e + 8 : u32(e + 8)
          if (off >= 0 && off + n <= head.length) {
            make = asciiAt(head, off, n).trim()
          }
        }
      }
    }
    return { make, hasDngVersion, hasSubIfds, photometric }
  } catch {
    return null
  }
}

const MAKE_TO_RAW: readonly (readonly [RegExp, SniffedFormatId])[] = [
  [/^NIKON/i, 'raw-nef'],
  [/^SONY/i, 'raw-arw'],
  [/^(PENTAX|RICOH)/i, 'raw-tiff-generic'],
  [/^SAMSUNG/i, 'raw-tiff-generic'],
  [/^Hasselblad/i, 'raw-tiff-generic'],
  [/^Phase\s*One/i, 'raw-tiff-generic'],
  [/^SEIKO EPSON/i, 'raw-tiff-generic'],
  [/^Leica/i, 'raw-tiff-generic'],
]

const RAW_TIFF_EXTENSIONS: Readonly<Record<string, SniffedFormatId>> = {
  nef: 'raw-nef',
  nrw: 'raw-nef',
  arw: 'raw-arw',
  sr2: 'raw-arw',
  srf: 'raw-arw',
  dng: 'raw-dng',
  pef: 'raw-tiff-generic',
  srw: 'raw-tiff-generic',
  '3fr': 'raw-tiff-generic',
  fff: 'raw-tiff-generic',
  iiq: 'raw-tiff-generic',
  cap: 'raw-tiff-generic',
  erf: 'raw-tiff-generic',
  mef: 'raw-tiff-generic',
  mos: 'raw-tiff-generic',
  rwl: 'raw-tiff-generic',
  dcr: 'raw-tiff-generic',
  kdc: 'raw-tiff-generic',
}

/**
 * Decides which member of the TIFF family a `II*\0` / `MM\0*` file belongs to.
 * Returns 'tiff' for an ordinary picture — the only one this module decodes.
 */
export function classifyTiffFamily(input: SniffInput): SniffResult {
  const head = input.head
  const flavour = tiffFlavour(head)!
  if (flavour.magic === 0x4f52 || flavour.magic === 0x5352) return result('raw-orf', 'tiff')
  if (flavour.magic === 0x55) return result('raw-rw2', 'tiff')

  // Canon CR2: II*\0 + first IFD at 0x10 + "CR".
  if (matchBytes(head, 0, [0x49, 0x49, 0x2a, 0x00, 0x10, 0x00, 0x00, 0x00, 0x43, 0x52])) {
    return result('raw-cr2', 'tiff')
  }

  const facts = scanIfd0(head, flavour.littleEndian, flavour.bigTiff)
  if (facts) {
    if (facts.hasDngVersion) return result('raw-dng', 'tiff')
    for (const [re, id] of MAKE_TO_RAW) {
      if (re.test(facts.make)) return result(id, 'tiff', 0.9)
    }
    if (facts.photometric === PHOTOMETRIC_CFA) return result('raw-tiff-generic', 'tiff', 0.9)
    if (facts.photometric !== null) return result('tiff', 'tiff')
    if (facts.hasSubIfds) {
      // No photometric in IFD0 but SubIFDs present: typical of RAW containers.
      const ext = extensionOf(input.name)
      if (ext && RAW_TIFF_EXTENSIONS[ext]) return result(RAW_TIFF_EXTENSIONS[ext], 'tiff', 0.5)
    }
  }
  const ext = extensionOf(input.name)
  if (ext && RAW_TIFF_EXTENSIONS[ext]) return result(RAW_TIFF_EXTENSIONS[ext], 'tiff', 0.5)
  return result('tiff', 'tiff')
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Full detection over the signature table. Returns `null` for an unidentifiable or
 * too-short file. Never throws.
 */
export function sniff(input: SniffInput): SniffResult | null {
  const head = input.head
  if (!head || head.length < MIN_SNIFF_BYTES) return null
  try {
    if (isPng(head)) return result(isApng(head) ? 'apng' : 'png', 'raw-bytes')
    if (isJpeg(head)) return result('jpeg', 'raw-bytes')
    if (isGif(head)) return result('gif', 'raw-bytes')
    if (isRiffWebp(head)) return result(isAnimatedWebp(head) ? 'webp-animated' : 'webp', 'riff')
    if (isPsd(head)) return result('psd', 'raw-bytes')
    if (isXcf(head)) return result('xcf', 'xcf')
    if (isDds(head)) return result('dds', 'raw-bytes')
    if (isExr(head)) return result('exr', 'raw-bytes')
    if (isHdr(head)) return result('hdr', 'text')
    if (isJpeg2000(head)) return result('jpeg2000', 'raw-bytes')
    if (isIco(head)) return result('ico', 'raw-bytes')
    if (isCur(head)) return result('cur', 'raw-bytes')
    if (isBmp(head)) return result('bmp', 'raw-bytes')
    if (isPnm(head)) return result('pnm', 'text')
    if (bmffBrands(head)) {
      if (isAvif(head)) return result('avif', 'iso-bmff')
      const brands = bmffBrands(head)!
      if (brands.major === 'crx ' || brands.compatible.includes('crx ')) {
        return result('raw-cr3', 'iso-bmff')
      }
      if (isHeif(head)) return result('heif', 'iso-bmff')
      return null // mp4/qt video: not ours
    }
    if (isTiffLike(head)) return classifyTiffFamily(input)
    if (isPdf(head)) return result('pdf', 'raw-bytes')

    const svg = svgConfidence(head)
    if (svg > 0) return result('svg', 'text', svg)

    const tga = tgaConfidence(input)
    if (tga > 0) {
      const ext = extensionOf(input.name)
      const boosted = ext === 'tga' || ext === 'vda' || ext === 'icb' || ext === 'vst' ? Math.max(tga, 0.8) : tga
      return result('tga', 'raw-bytes', boosted)
    }
    return null
  } catch {
    // Detection is best-effort by construction: a hostile file yields "unknown".
    return null
  }
}

// ---------------------------------------------------------------------------

function extensionOf(name: string | undefined): string | null {
  if (!name) return null
  const i = name.lastIndexOf('.')
  if (i < 0 || i === name.length - 1) return null
  return name.slice(i + 1).toLowerCase()
}

function asciiAt(buf: Uint8Array, off: number, len: number): string {
  let s = ''
  const end = Math.min(buf.length, off + len)
  for (let i = off; i < end; i++) {
    const c = buf[i]
    if (c === 0) break
    s += String.fromCharCode(c)
  }
  return s
}

function readU32LE(b: Uint8Array, o: number): number {
  if (o + 4 > b.length) return -1
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0
}

function readU32BE(b: Uint8Array, o: number): number {
  if (o + 4 > b.length) return -1
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0
}
