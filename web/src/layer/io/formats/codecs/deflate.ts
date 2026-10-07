// Deflate/Inflate through the platform's `CompressionStream` / `DecompressionStream`.
//
// Measured available (spec 05 §2.5) with 'deflate' (zlib wrapper — exactly PNG's IDAT
// and TIFF's Adobe Deflate), 'deflate-raw' and 'gzip'. This is why the whole layer needs
// neither `pako` (~45 KiB) nor `fflate` (~30 KiB).
//
// Note the level is NOT adjustable through this API: the export dialog's "compression
// level" therefore reduces to a filter-strategy choice for PNG (spec 05 §3.3).

import { IoError } from '../types'
import { MAX_BUFFER_BYTES } from '../limits'

export type DeflateFormat = 'deflate' | 'deflate-raw' | 'gzip'

function assertAvailable(): void {
  if (typeof DecompressionStream === 'undefined' || typeof CompressionStream === 'undefined') {
    throw new IoError('io.no-compression-stream', 'CompressionStream is unavailable in this runtime')
  }
}

async function runStream(
  src: Uint8Array,
  stream: GenericTransformStream,
  expectedBytes: number | undefined,
): Promise<Uint8Array> {
  // A copy into a fresh ArrayBuffer: `src` is often a subarray of a much larger buffer,
  // and Blob/stream APIs would otherwise keep the whole file alive.
  const input = new Blob([src.slice().buffer as ArrayBuffer]).stream()
  // `CompressionStream.writable` is typed `WritableStream<BufferSource>`, which TypeScript
  // will not unify with `ReadableStream<Uint8Array>.pipeThrough`. The runtime contract is
  // exact — Uint8Array is a BufferSource — so the pair is re-stated here.
  const out = input.pipeThrough(stream as unknown as ReadableWritablePair<Uint8Array, Uint8Array>)
  const reader = out.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  // Guard against zip bombs: a strip that expands past the buffer ceiling is refused.
  const ceiling = Math.min(MAX_BUFFER_BYTES, expectedBytes ? Math.max(expectedBytes * 4, 1 << 20) : MAX_BUFFER_BYTES)
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      total += value.length
      if (total > ceiling) {
        await reader.cancel().catch(() => undefined)
        throw new IoError('io.inflate-overflow', `inflated stream exceeds ${ceiling} bytes`)
      }
      parts.push(value)
    }
  }
  if (parts.length === 1) return parts[0]
  const merged = new Uint8Array(total)
  let p = 0
  for (const part of parts) {
    merged.set(part, p)
    p += part.length
  }
  return merged
}

/**
 * Inflates a zlib (`deflate`) stream. Some TIFF and PNG writers emit a raw deflate
 * stream without the two-byte zlib header, so a failure is retried as `deflate-raw`
 * before giving up — that single retry fixes a whole class of "broken" files.
 *
 * `expectedBytes` is the decoder's own estimate of the output size; it only tightens the
 * anti-zip-bomb ceiling and is never used as an allocation size.
 */
export async function inflate(
  src: Uint8Array,
  format: DeflateFormat = 'deflate',
  expectedBytes?: number,
): Promise<Uint8Array> {
  assertAvailable()
  try {
    return await runStream(src, new DecompressionStream(format), expectedBytes)
  } catch (e) {
    if (format === 'deflate') {
      try {
        return await runStream(src, new DecompressionStream('deflate-raw'), expectedBytes)
      } catch {
        /* fall through to the original error */
      }
    }
    throw e instanceof IoError ? e : new IoError('io.inflate-failed', `inflate failed: ${String(e)}`)
  }
}

export async function deflate(src: Uint8Array, format: DeflateFormat = 'deflate'): Promise<Uint8Array> {
  assertAvailable()
  return runStream(src, new CompressionStream(format), src.length)
}
