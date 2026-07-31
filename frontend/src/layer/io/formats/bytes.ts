// `ByteSource` implementations (spec 05 §7.1, §8.3).
//
// A 2 GiB TIFF must be readable range by range instead of being materialised whole, and
// the same decoder code has to work over an in-memory buffer in tests. Both back ends
// implement the same interface; only `all()` on a Blob source actually commits the
// memory, and decoders avoid calling it.

import { IoTruncatedError } from './types'
import type { ByteSource } from './registry'

class BufferSource implements ByteSource {
  constructor(private readonly bytes: Uint8Array) {}

  get size(): number {
    return this.bytes.length
  }

  async slice(start: number, end: number): Promise<Uint8Array> {
    const s = clamp(start, 0, this.bytes.length)
    const e = clamp(end, s, this.bytes.length)
    return this.bytes.subarray(s, e)
  }

  async all(): Promise<Uint8Array> {
    return this.bytes
  }
}

/** Coalescing, caching range reader over a Blob (a Drive download, a File input). */
class BlobByteSource implements ByteSource {
  /** Range cache: aligned chunks so successive small reads hit the same fetch. */
  private readonly chunks = new Map<number, Uint8Array>()
  private whole: Uint8Array | null = null

  constructor(
    private readonly blob: Blob,
    private readonly chunkSize = 1 << 20,
    /** Above this we refuse `all()` rather than blow the heap up. */
    private readonly maxWholeBytes = 1 << 30,
  ) {}

  get size(): number {
    return this.blob.size
  }

  async slice(start: number, end: number): Promise<Uint8Array> {
    const s = clamp(start, 0, this.blob.size)
    const e = clamp(end, s, this.blob.size)
    if (e === s) return new Uint8Array(0)
    if (this.whole) return this.whole.subarray(s, e)

    const first = Math.floor(s / this.chunkSize)
    const last = Math.floor((e - 1) / this.chunkSize)
    if (first === last) {
      const chunk = await this.chunk(first)
      const off = s - first * this.chunkSize
      return chunk.subarray(off, off + (e - s))
    }
    // Spanning read: one fetch rather than N cached chunks.
    const buf = new Uint8Array(await this.blob.slice(s, e).arrayBuffer())
    if (buf.length < e - s) throw new IoTruncatedError(`short read at ${s}..${e}`)
    return buf
  }

  private async chunk(index: number): Promise<Uint8Array> {
    const cached = this.chunks.get(index)
    if (cached) return cached
    const start = index * this.chunkSize
    const end = Math.min(this.blob.size, start + this.chunkSize)
    const buf = new Uint8Array(await this.blob.slice(start, end).arrayBuffer())
    // Bounded cache: keep the last 32 chunks (32 MiB) at most.
    if (this.chunks.size >= 32) {
      const oldest = this.chunks.keys().next()
      if (!oldest.done) this.chunks.delete(oldest.value)
    }
    this.chunks.set(index, buf)
    return buf
  }

  async all(): Promise<Uint8Array> {
    if (this.whole) return this.whole
    if (this.blob.size > this.maxWholeBytes) {
      throw new IoTruncatedError(
        `refusing to materialise ${Math.round(this.blob.size / (1 << 20))} MiB in memory`,
      )
    }
    this.whole = new Uint8Array(await this.blob.arrayBuffer())
    this.chunks.clear()
    return this.whole
  }
}

export function bufferSource(bytes: Uint8Array | ArrayBuffer): ByteSource {
  return new BufferSource(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
}

export function blobSource(blob: Blob): ByteSource {
  return new BlobByteSource(blob)
}

/** Head + tail needed by the sniffer, in at most two range reads. */
export async function readSniffWindow(
  source: ByteSource,
  headBytes = 64 * 1024,
): Promise<{ head: Uint8Array; tail: Uint8Array }> {
  const head = await source.slice(0, Math.min(headBytes, source.size))
  const tailStart = Math.max(0, source.size - 18)
  const tail = source.size > 18 ? await source.slice(tailStart, source.size) : head
  return { head, tail }
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo
  return v < lo ? lo : v > hi ? hi : v
}
