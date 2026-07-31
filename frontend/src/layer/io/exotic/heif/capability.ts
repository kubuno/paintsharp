// SPDX-License-Identifier: AGPL-3.0-or-later
//
// HEIC/HEIF decoding-capability detection (spec 07 §6.2).
//
// NO WebAssembly decoder is shipped, by deliberate decision: libheif and libde265 are
// licence-compatible, but HEVC is covered by the MPEG-LA / Access Advance patent pools —
// which is exactly why Chrome refuses to decode HEIC in the first place. Shipping an
// HEVC decoder in a self-hosted platform is a patent exposure, not a copyright one, and
// no licence text makes it go away.
//
// The consequence is that capability must be PROBED, never assumed, and the obvious
// probe is wrong in both directions:
//
//   | Engine   | <img src=".heic">  | ImageDecoder('image/heic') |
//   |----------|--------------------|----------------------------|
//   | Safari   | yes (system codec) | NOT IMPLEMENTED in WebKit  |
//   | Chrome   | no                 | isTypeSupported -> false   |
//   | Firefox  | no                 | absent                     |
//
// Testing `ImageDecoder` alone rejects Safari, which is the platform where HEIC files
// actually come from. Hence two independent probes.

export type HeifPath =
  /** WebCodecs `ImageDecoder` accepts image/heic. */
  | 'imagedecoder'
  /** The platform decodes HEIC through the normal image pipeline (Safari, iOS, macOS). */
  | 'native-bitmap'
  /** Nothing on this browser can decode it. */
  | 'none'

interface ImageDecoderLike {
  isTypeSupported(type: string): Promise<boolean>
}

/** Probing costs a real decode, so the answer is cached for the lifetime of the realm. */
let cached: HeifPath | undefined
let inFlight: Promise<HeifPath> | undefined

/**
 * Determines how (or whether) this browser can decode HEIC.
 *
 * `sample` is the actual file being opened. Using it rather than an inlined 1×1 fixture
 * keeps a binary blob out of the bundle AND makes the probe strictly more accurate: a
 * platform may decode a baseline HEIC and refuse the profile in the user's file, and
 * only the real bytes reveal that.
 */
export async function detectHeifPath(sample?: Uint8Array): Promise<HeifPath> {
  if (cached !== undefined) return cached
  if (inFlight) return inFlight
  inFlight = probe(sample).then((p) => {
    // A negative answer obtained WITHOUT a sample is not conclusive: `ImageDecoder` may
    // simply be missing while the platform decoder works. It is not cached.
    if (p !== 'none' || sample) cached = p
    inFlight = undefined
    return p
  })
  return inFlight
}

async function probe(sample?: Uint8Array): Promise<HeifPath> {
  // 1. WebCodecs — the clean path, when it exists.
  const ID = (globalThis as { ImageDecoder?: ImageDecoderLike }).ImageDecoder
  if (ID && typeof ID.isTypeSupported === 'function') {
    const ok = await ID.isTypeSupported('image/heic').catch(() => false)
    if (ok) return 'imagedecoder'
  }

  // 2. The platform image pipeline. `createImageBitmap` is used rather than an <img>
  //    element because it works in a Worker too, and goes through the same system
  //    decoder that makes HEIC work on Apple platforms.
  if (sample && typeof createImageBitmap === 'function') {
    const blob = new Blob([sample.slice()], { type: 'image/heic' })
    try {
      const bitmap = await createImageBitmap(blob)
      bitmap.close()
      return 'native-bitmap'
    } catch {
      // Falls through: not decodable here.
    }
  }

  return 'none'
}

/** Test hook: forgets the cached answer. */
export function resetHeifCapabilityCache(): void {
  cached = undefined
  inFlight = undefined
}
