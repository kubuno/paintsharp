// CRC-32 as used by PNG chunks (reflected polynomial 0xEDB88320) and Adler-32
// as used by the zlib wrapper.

const TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let c = 0xffffffff
  for (let i = start; i < end; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** CRC of several buffers in sequence — a PNG CRC covers type + data. */
export function crc32Concat(parts: readonly Uint8Array[]): number {
  let c = 0xffffffff
  for (const p of parts) {
    for (let i = 0; i < p.length; i++) c = TABLE[(c ^ p[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

export function adler32(bytes: Uint8Array): number {
  let a = 1
  let b = 0
  // 5552 is the largest block that cannot overflow the 32-bit accumulators.
  for (let i = 0; i < bytes.length; ) {
    const end = Math.min(bytes.length, i + 5552)
    for (; i < end; i++) {
      a += bytes[i]
      b += a
    }
    a %= 65521
    b %= 65521
  }
  return ((b << 16) | a) >>> 0
}
