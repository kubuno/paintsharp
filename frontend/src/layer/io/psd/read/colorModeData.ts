/*
 * PSD/PSB Color Mode Data section (spec §1.3).
 *
 * Derived from the GIMP PSD plug-in (file-psd), Copyright 2007 John Marshall,
 * GPLv3+ (psd-load.c, and the `psd-duotone-data` parasite of psd.h) and from
 * Adobe's public "Photoshop File Formats Specification". Independent TypeScript
 * re-implementation; no GIMP source was copied. Kubuno is AGPLv3.
 */
import type { ByteReader } from '../binary/ByteReader.ts'
import type { WarningSink } from '../types.ts'

/**
 * Returns the section payload verbatim, or null when empty.
 *
 * Indexed mode stores a 768-byte NON-interleaved palette (256 R, 256 G, 256 B).
 * Duotone stores opaque proprietary ink/transfer data that we keep untouched so
 * a round trip can put it back byte for byte.
 */
export function readColorModeData(r: ByteReader, sink: WarningSink): Uint8Array | null {
  let length: number
  try {
    length = r.u32()
  } catch {
    sink.warn('truncated-file', { section: 'color-mode-data' })
    return null
  }
  if (length === 0) return null
  if (length > r.remaining) {
    sink.warn('truncated-file', { section: 'color-mode-data', length })
    return r.bytes(r.remaining)
  }
  return r.bytes(length)
}
