// Runtime capability probes.
//
// Always probe by CAPABILITY and by TYPE, never by browser or by version
// number: an engine can expose `ImageDecoder` and still refuse a given
// container. Nothing in this library depends on WebCodecs for a mandatory path.

import { hasCompressionStream, hasDecompressionStream } from './apng/zlib.ts'
import { probeWebpEncoding } from './webp/encode.ts'

export interface AnimCaps {
  /** Per-MIME support of the platform's own image decoders. */
  imageDecoder: Record<string, boolean>
  compressionStream: boolean
  decompressionStream: boolean
  /** True when the platform really produces WebP (checked on the magic bytes). */
  webpEncode: boolean
}

const MIMES = ['image/gif', 'image/webp', 'image/avif', 'image/png'] as const

export async function canDecodeNatively(mime: string): Promise<boolean> {
  const ID = (globalThis as { ImageDecoder?: typeof ImageDecoder }).ImageDecoder
  if (!ID) return false
  try {
    return await ID.isTypeSupported(mime)
  } catch {
    return false
  }
}

let cached: Promise<AnimCaps> | null = null

export function animCaps(): Promise<AnimCaps> {
  cached ??= (async (): Promise<AnimCaps> => {
    const imageDecoder: Record<string, boolean> = {}
    for (const m of MIMES) imageDecoder[m] = await canDecodeNatively(m)
    return {
      imageDecoder,
      compressionStream: hasCompressionStream(),
      decompressionStream: hasDecompressionStream(),
      webpEncode: typeof OffscreenCanvas === 'function' ? await probeWebpEncoding() : false,
    }
  })()
  return cached
}

/** Forget the cached probe result — for tests, and after a worker restart. */
export function resetAnimCaps(): void {
  cached = null
}
