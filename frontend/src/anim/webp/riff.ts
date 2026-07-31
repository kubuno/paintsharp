// RIFF container primitives for WebP.
//
// Everything is little-endian, and a chunk whose payload has an ODD size is
// followed by a single 0x00 padding byte that is NOT counted in the payload
// size. Forgetting that byte is the classic way to produce a WebP that every
// decoder rejects one chunk too late to be diagnosable.

export interface RiffChunk {
  fourCC: string
  /** Offset of the payload (past FourCC and size). */
  start: number
  /** Offset just past the payload, padding excluded. */
  end: number
}

export function isRiffWebp(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 && // F
    bytes[8] === 0x57 && // W
    bytes[9] === 0x45 && // E
    bytes[10] === 0x42 && // B
    bytes[11] === 0x50 // P
  )
}

/** Iterate the chunks of a RIFF payload starting at `from`. Never throws. */
export function* riffChunks(bytes: Uint8Array, from: number, until = bytes.length): Generator<RiffChunk> {
  let p = from
  while (p + 8 <= until) {
    const fourCC = String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3])
    const size = readU32(bytes, p + 4)
    const start = p + 8
    const end = start + size
    if (size < 0 || end > until) return
    yield { fourCC, start, end }
    p = end + (size & 1) // odd payloads carry one padding byte
  }
}

export function readU32(b: Uint8Array, p: number): number {
  return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0
}

export function readU24(b: Uint8Array, p: number): number {
  return b[p] | (b[p + 1] << 8) | (b[p + 2] << 16)
}

export function writeU32(b: Uint8Array, p: number, v: number): void {
  b[p] = v & 0xff
  b[p + 1] = (v >>> 8) & 0xff
  b[p + 2] = (v >>> 16) & 0xff
  b[p + 3] = (v >>> 24) & 0xff
}

export function writeU24(b: Uint8Array, p: number, v: number): void {
  b[p] = v & 0xff
  b[p + 1] = (v >>> 8) & 0xff
  b[p + 2] = (v >>> 16) & 0xff
}

/** Build one chunk: FourCC + size + payload + odd-size padding. */
export function chunk(fourCC: string, payload: Uint8Array): Uint8Array {
  const pad = payload.length & 1
  const out = new Uint8Array(8 + payload.length + pad)
  for (let i = 0; i < 4; i++) out[i] = fourCC.charCodeAt(i)
  writeU32(out, 4, payload.length)
  out.set(payload, 8)
  return out
}

/** Wrap a list of chunks in `RIFF <size> WEBP`. */
export function riffWebp(parts: readonly Uint8Array[]): Uint8Array {
  let body = 0
  for (const p of parts) body += p.length
  const out = new Uint8Array(12 + body)
  out[0] = 0x52
  out[1] = 0x49
  out[2] = 0x46
  out[3] = 0x46
  // The RIFF size counts everything after this field, i.e. "WEBP" + the chunks.
  writeU32(out, 4, 4 + body)
  out[8] = 0x57
  out[9] = 0x45
  out[10] = 0x42
  out[11] = 0x50
  let o = 12
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

export const VP8X_ANIMATION = 0x02
export const VP8X_XMP = 0x04
export const VP8X_EXIF = 0x08
export const VP8X_ALPHA = 0x10
export const VP8X_ICC = 0x20

export function vp8x(flags: number, width: number, height: number): Uint8Array {
  const b = new Uint8Array(10)
  b[0] = flags
  // bytes 1..3 reserved, already zero
  writeU24(b, 4, Math.max(0, width - 1))
  writeU24(b, 7, Math.max(0, height - 1))
  return b
}
