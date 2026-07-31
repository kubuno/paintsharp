/*
 * PSD/PSB zlib (ZIP) compression, on top of the native Compression Streams API.
 *
 * The surrounding format handling was derived from the GIMP PSD plug-in
 * (file-psd), Copyright 2007 John Marshall, GPLv3+ — the `PSD_COMP_ZIP` branch
 * of psd-load.c (~l. 5306-5342). Independent TypeScript re-implementation; no
 * GIMP source was copied. Kubuno is AGPLv3.
 *
 * No npm dependency is added: `DecompressionStream` / `CompressionStream` are
 * available in every browser Kubuno supports (Chrome 80+, Firefox 113+, Safari
 * 16.4+) and in Node 18+.
 */
import { PsdError, allocBytes } from '../errors.ts'

type ZlibFormat = 'deflate' | 'deflate-raw'

/**
 * ⚠️ In the Compression Streams spec, `'deflate'` means zlib (RFC 1950) and
 * `'deflate-raw'` means bare deflate (RFC 1951). PSD stores zlib streams, so
 * `'deflate'` is the correct choice — this is the classic mistake.
 */
const ZLIB: ZlibFormat = 'deflate'
const RAW: ZlibFormat = 'deflate-raw'

export function zipAvailable(): boolean {
  return typeof DecompressionStream === 'function'
}

export function deflateAvailable(): boolean {
  return typeof CompressionStream === 'function'
}

/** True when the first two bytes look like a valid zlib header (RFC 1950). */
function looksLikeZlib(src: Uint8Array): boolean {
  if (src.length < 2) return false
  const b0 = src[0]
  const b1 = src[1]
  return (b0 & 0x0f) === 8 && (((b0 << 8) | b1) % 31) === 0
}

/**
 * Inflates a zlib stream, stopping as soon as `expectedLen` bytes are produced.
 *
 * The output buffer is pre-allocated at exactly `expectedLen`, which is derived
 * from the channel geometry and never from the file's own length fields — that
 * is the zip-bomb protection: a 4 GB expansion simply gets truncated.
 *
 * Falls back to raw deflate when the payload does not carry a zlib header and
 * the zlib path failed (some exotic writers store RFC 1951 directly).
 */
export async function inflateZlib(src: Uint8Array, expectedLen: number): Promise<Uint8Array> {
  if (!zipAvailable()) throw new PsdError('ZIP_UNAVAILABLE')
  if (expectedLen <= 0) return allocBytes(0)

  try {
    return await inflateWith(src, expectedLen, ZLIB)
  } catch (e) {
    if (looksLikeZlib(src)) throw toPsdError(e)
    try {
      return await inflateWith(src, expectedLen, RAW)
    } catch {
      throw toPsdError(e)
    }
  }
}

async function inflateWith(
  src: Uint8Array,
  expectedLen: number,
  format: ZlibFormat,
): Promise<Uint8Array> {
  const out = allocBytes(expectedLen)
  let filled = 0

  // Typed as BufferSource because that is what DecompressionStream's writable
  // side accepts; a plain ReadableStream<Uint8Array> does not line up.
  const source = new ReadableStream<BufferSource>({
    start(controller) {
      // A copy is required: the stream may outlive the caller's view of the
      // (possibly huge and about-to-be-released) source ArrayBuffer.
      controller.enqueue(src.slice())
      controller.close()
    },
  })

  const reader = source.pipeThrough(new DecompressionStream(format)).getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value || value.length === 0) continue
      const take = Math.min(value.length, expectedLen - filled)
      if (take > 0) {
        out.set(value.subarray(0, take), filled)
        filled += take
      }
      if (filled >= expectedLen) break
    }
  } finally {
    // Cancelling releases the underlying transformer when we stopped early.
    try {
      await reader.cancel()
    } catch {
      /* already closed */
    }
  }
  // Short streams are tolerated: the tail stays zero-filled and the caller
  // reports a `truncated-file` warning rather than failing the whole import.
  return out
}

/** Compresses to a zlib stream. Callers must fall back to RLE when unavailable. */
export async function deflateZlib(src: Uint8Array): Promise<Uint8Array> {
  if (!deflateAvailable()) throw new PsdError('ZIP_UNAVAILABLE')
  const source = new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(src.slice())
      controller.close()
    },
  })
  const reader = source.pipeThrough(new CompressionStream(ZLIB)).getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value || value.length === 0) continue
    chunks.push(value)
    total += value.length
  }
  const out = allocBytes(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

function toPsdError(e: unknown): PsdError {
  if (e instanceof PsdError) return e
  return new PsdError('UNSUPPORTED_COMPRESSION', {
    reason: e instanceof Error ? e.message : String(e),
  })
}
