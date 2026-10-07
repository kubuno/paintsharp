/*
 * PSD/PSB string primitives: Pascal strings and UTF-16BE Unicode strings.
 *
 * Derived from the GIMP PSD plug-in (file-psd), Copyright 2007 John Marshall,
 * GPLv3+ — `fread_pascal_string()` / `fread_unicode_string()` in psd-util.c —
 * and from Adobe's public "Photoshop File Formats Specification". Independent
 * TypeScript re-implementation; no GIMP source was copied. Kubuno is AGPLv3.
 */
import type { ByteReader } from './ByteReader.ts'
import type { ByteWriter } from './ByteWriter.ts'

/** Padding modulus: 2 in image resources, 4 for layer names, 1 elsewhere. */
export type ModLen = 1 | 2 | 4

const utf8Strict = makeDecoder('utf-8', true)
const macRoman = makeDecoder('macintosh', false)
const latin1 = makeDecoder('windows-1252', false)

function makeDecoder(label: string, fatal: boolean): TextDecoder | null {
  try {
    return new TextDecoder(label, { fatal })
  } catch {
    return null
  }
}

/**
 * Decodes a legacy (non-Unicode) Photoshop string. Historically MacRoman; in
 * practice modern writers emit UTF-8, so we try strict UTF-8 first and fall
 * back to MacRoman, then to windows-1252, then to a raw Latin-1 expansion.
 */
export function decodeLegacyText(bytes: Uint8Array): string {
  if (bytes.length === 0) return ''
  if (utf8Strict) {
    try {
      return utf8Strict.decode(bytes)
    } catch {
      /* not UTF-8 — fall through */
    }
  }
  if (macRoman) {
    try {
      return macRoman.decode(bytes)
    } catch {
      /* unavailable encoding — fall through */
    }
  }
  if (latin1) {
    try {
      return latin1.decode(bytes)
    } catch {
      /* fall through */
    }
  }
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return s
}

/**
 * Pascal string: `uint8 length` + bytes, the whole thing padded so that
 * `1 + length` is a multiple of `modLen`. Length 0 still occupies one byte.
 */
export function readPascalString(r: ByteReader, modLen: ModLen): string {
  const len = r.u8()
  const raw = r.peekBytes(Math.min(len, r.remaining))
  const s = decodeLegacyText(raw)
  const total = 1 + len
  const pad = (modLen - (total % modLen)) % modLen
  r.skip(pad)
  return s
}

/** Encodes to Latin-1-ish bytes; anything outside becomes '?'. */
function toLegacyBytes(s: string, maxLen: number): Uint8Array {
  const n = Math.min(s.length, maxLen)
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i)
    out[i] = c < 0x100 ? c : 0x3f
  }
  return out
}

export function writePascalString(w: ByteWriter, s: string, modLen: ModLen): void {
  const bytes = toLegacyBytes(s, 255)
  w.u8(bytes.length)
  w.bytes(bytes)
  const total = 1 + bytes.length
  w.zeros((modLen - (total % modLen)) % modLen)
}

export function pascalStringLength(s: string, modLen: ModLen): number {
  const n = Math.min(s.length, 255)
  const total = 1 + n
  return total + ((modLen - (total % modLen)) % modLen)
}

/**
 * Unicode string: `uint32` UTF-16 UNIT count (not bytes) then big-endian units.
 * Photoshop sometimes counts a terminating U+0000 — we strip it. Surrogate
 * pairs are preserved verbatim.
 *
 * `maxUnits` guards against a forged count: it is clamped to what the reader
 * actually still holds, so no allocation can be driven past the block size.
 */
export function readUnicodeString(r: ByteReader): string {
  const declared = r.u32()
  const available = r.remaining >> 1
  const count = Math.min(declared, available)
  if (count <= 0) return ''
  const units = new Array<number>(count)
  for (let i = 0; i < count; i++) units[i] = r.u16()
  let end = units.length
  while (end > 0 && units[end - 1] === 0) end--
  return unitsToString(units, end)
}

function unitsToString(units: number[], end: number): string {
  // Chunked to stay clear of the argument-count limit on very long strings.
  let s = ''
  const CHUNK = 4096
  for (let i = 0; i < end; i += CHUNK) {
    s += String.fromCharCode(...units.slice(i, Math.min(end, i + CHUNK)))
  }
  return s
}

/** Number of UTF-16 code units in `s` (JS strings are already UTF-16). */
export function utf16Length(s: string): number {
  return s.length
}

export function writeUnicodeString(w: ByteWriter, s: string): void {
  w.u32(s.length)
  for (let i = 0; i < s.length; i++) w.u16(s.charCodeAt(i))
}

export function unicodeStringLength(s: string): number {
  return 4 + s.length * 2
}
