// GIF constants and the sub-block transport layer.
//
// GIF stores payloads as a chain of <len:u8><len bytes> ending with a 0 byte.
// This is TRANSPORT ONLY: an LZW stream runs across sub-block boundaries as a
// single continuous bit stream. Reassembling the chain first (rather than
// feeding the bit reader block by block) makes that impossible to get wrong.

export const GIF_EXTENSION = 0x21
export const GIF_IMAGE_DESCRIPTOR = 0x2c
export const GIF_TRAILER = 0x3b

export const EXT_GRAPHIC_CONTROL = 0xf9
export const EXT_COMMENT = 0xfe
export const EXT_PLAIN_TEXT = 0x01
export const EXT_APPLICATION = 0xff

/** Growable little-endian byte writer. */
export class ByteWriter {
  private buf: Uint8Array
  private len = 0

  constructor(capacity = 1 << 16) {
    this.buf = new Uint8Array(Math.max(16, capacity))
  }

  private ensure(n: number): void {
    if (this.len + n <= this.buf.length) return
    let cap = this.buf.length * 2
    while (cap < this.len + n) cap *= 2
    const next = new Uint8Array(cap)
    next.set(this.buf.subarray(0, this.len))
    this.buf = next
  }

  u8(v: number): void {
    this.ensure(1)
    this.buf[this.len++] = v & 0xff
  }

  u16(v: number): void {
    this.ensure(2)
    this.buf[this.len++] = v & 0xff
    this.buf[this.len++] = (v >> 8) & 0xff
  }

  bytes(src: Uint8Array): void {
    this.ensure(src.length)
    this.buf.set(src, this.len)
    this.len += src.length
  }

  ascii(s: string): void {
    this.ensure(s.length)
    for (let i = 0; i < s.length; i++) this.buf[this.len++] = s.charCodeAt(i) & 0xff
  }

  get length(): number {
    return this.len
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.len)
  }
}

/**
 * Split a payload into GIF sub-blocks and terminate it.
 * Only ever called with already-compressed data.
 */
export function writeSubBlocks(w: ByteWriter, data: Uint8Array): void {
  let off = 0
  while (off < data.length) {
    const n = Math.min(255, data.length - off)
    w.u8(n)
    w.bytes(data.subarray(off, off + n))
    off += n
  }
  w.u8(0)
}

export interface SubBlockRead {
  data: Uint8Array
  /** Offset just past the terminating 0 byte, or past the end when truncated. */
  next: number
  truncated: boolean
}

/**
 * Read a sub-block chain into one contiguous buffer.
 * Never throws: a truncated chain returns what was readable.
 */
export function readSubBlocks(src: Uint8Array, pos: number): SubBlockRead {
  // First pass records the ranges, so the result is a single exact allocation
  // and a malformed length byte cannot make us allocate wildly.
  const ranges: number[] = []
  let p = pos
  let total = 0
  let truncated = false
  for (;;) {
    if (p >= src.length) {
      truncated = true
      break
    }
    const n = src[p]
    p++
    if (n === 0) break
    const end = Math.min(src.length, p + n)
    if (end < p + n) truncated = true
    ranges.push(p, end)
    total += end - p
    p = end
    if (truncated) break
  }
  const data = new Uint8Array(total)
  let w = 0
  for (let i = 0; i < ranges.length; i += 2) {
    data.set(src.subarray(ranges[i], ranges[i + 1]), w)
    w += ranges[i + 1] - ranges[i]
  }
  return { data, next: p, truncated }
}

/** Skip a sub-block chain without copying. Used for extensions we ignore. */
export function skipSubBlocks(src: Uint8Array, pos: number): number {
  let p = pos
  for (;;) {
    if (p >= src.length) return src.length
    const n = src[p]
    p++
    if (n === 0) return p
    p += n
  }
}

/**
 * Map the j-th decoded row to its real y coordinate (GIF interlace, 4 passes:
 * rows 0/8, 4/8, 2/4, 1/2).
 */
export function deinterlaceRow(j: number, h: number): number {
  const p1 = Math.ceil(h / 8)
  const p2 = Math.ceil(Math.max(0, h - 4) / 8)
  const p3 = Math.ceil(Math.max(0, h - 2) / 4)
  if (j < p1) return j * 8
  if (j < p1 + p2) return 4 + (j - p1) * 8
  if (j < p1 + p2 + p3) return 2 + (j - p1 - p2) * 4
  return 1 + (j - p1 - p2 - p3) * 2
}
