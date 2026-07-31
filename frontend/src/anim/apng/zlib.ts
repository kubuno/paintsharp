// zlib streams through the platform's own CompressionStream/DecompressionStream.
//
// THE TRAP: 'deflate' is RFC 1950 — the zlib wrapper, with its 2-byte header
// and trailing Adler-32. 'deflate-raw' is RFC 1951, the bare deflate stream.
// PNG IDAT/fdAT payloads are RFC 1950, so 'deflate' is the correct name here;
// picking 'deflate-raw' fails with an unhelpful error. This is the single most
// common mistake when writing a PNG codec against the Streams API.
//
// `src/anim/**` must stay usable by Layer, Keyframe and Motion alike, so it
// cannot import a sibling sub-module's private helpers. The implementation
// below is therefore self-contained, but `setZlibCodec()` lets the host swap in
// a shared one at integration time without touching a single call site.

import { adler32 } from './crc32.ts'

export interface ZlibCodec {
  /** Inflate an RFC 1950 (zlib) stream. */
  inflate(data: Uint8Array): Promise<Uint8Array>
  /** Deflate to an RFC 1950 (zlib) stream. */
  deflate(data: Uint8Array): Promise<Uint8Array>
}

/** Ceiling on inflated output, to stop a crafted file from exhausting memory. */
export const MAX_INFLATED_BYTES = 512 * 1024 * 1024

export function hasCompressionStream(): boolean {
  return typeof globalThis.CompressionStream === 'function'
}

export function hasDecompressionStream(): boolean {
  return typeof globalThis.DecompressionStream === 'function'
}

async function runStream(data: Uint8Array, stream: GenericTransformStream, ceiling: number): Promise<Uint8Array> {
  // A copy into a fresh ArrayBuffer: `data` is usually a subarray of the whole
  // file, which the stream would otherwise keep alive.
  const input = new Blob([data.slice().buffer as ArrayBuffer]).stream()
  // `CompressionStream.writable` is typed `WritableStream<BufferSource>`, which
  // TypeScript will not unify with `ReadableStream<Uint8Array>.pipeThrough`.
  // The runtime contract is exact (a Uint8Array is a BufferSource), so the pair
  // is simply re-stated.
  const reader = input.pipeThrough(stream as unknown as ReadableWritablePair<Uint8Array, Uint8Array>).getReader()
  const parts: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.length
    if (total > ceiling) {
      await reader.cancel().catch(() => undefined)
      throw new Error(`Inflated stream exceeds ${ceiling} bytes`)
    }
    parts.push(value)
  }
  if (parts.length === 1) return parts[0]
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

const platformCodec: ZlibCodec = {
  async inflate(data) {
    if (!hasDecompressionStream()) {
      throw new Error('DecompressionStream is unavailable: cannot read compressed PNG data')
    }
    try {
      return await runStream(data, new DecompressionStream('deflate'), MAX_INFLATED_BYTES)
    } catch (e) {
      // Some writers emit a bare RFC 1951 stream with no zlib header. One retry
      // recovers a whole class of files otherwise reported as broken.
      try {
        return await runStream(data, new DecompressionStream('deflate-raw'), MAX_INFLATED_BYTES)
      } catch {
        throw e
      }
    }
  },
  async deflate(data) {
    // `CompressionStream` gives no control over the level (roughly 6); level 9
    // would gain about 3 %, which does not justify a hand-written deflate.
    // Without the API we fall back to STORED blocks: the file is large but
    // always valid, so encoding never fails.
    if (!hasCompressionStream()) return storedZlib(data)
    return runStream(data, new CompressionStream('deflate'), MAX_INFLATED_BYTES)
  },
}

let codec: ZlibCodec = platformCodec

/**
 * Replace the zlib backend, e.g. with the repository's shared implementation.
 * Pass nothing to restore the built-in platform codec.
 */
export function setZlibCodec(next: ZlibCodec | null): void {
  codec = next ?? platformCodec
}

export function inflate(data: Uint8Array): Promise<Uint8Array> {
  return codec.inflate(data)
}

export function deflate(data: Uint8Array): Promise<Uint8Array> {
  return codec.deflate(data)
}

/** RFC 1950 container around RFC 1951 stored (uncompressed) blocks. */
export function storedZlib(data: Uint8Array): Uint8Array {
  const MAX = 0xffff
  const blocks = Math.max(1, Math.ceil(data.length / MAX))
  const out = new Uint8Array(2 + blocks * 5 + data.length + 4)
  let o = 0
  out[o++] = 0x78 // CMF: deflate, 32k window
  out[o++] = 0x01 // FLG: no dictionary; 0x7801 is a multiple of 31, as required
  for (let i = 0; i < blocks; i++) {
    const start = i * MAX
    const len = Math.min(MAX, data.length - start)
    out[o++] = i === blocks - 1 ? 1 : 0 // BFINAL, BTYPE = 00 (stored)
    out[o++] = len & 0xff
    out[o++] = (len >> 8) & 0xff
    out[o++] = ~len & 0xff
    out[o++] = (~len >> 8) & 0xff
    out.set(data.subarray(start, start + len), o)
    o += len
  }
  const ad = adler32(data)
  out[o++] = (ad >>> 24) & 0xff
  out[o++] = (ad >>> 16) & 0xff
  out[o++] = (ad >>> 8) & 0xff
  out[o++] = ad & 0xff
  return out.subarray(0, o)
}
