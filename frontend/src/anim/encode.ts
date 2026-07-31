// Encoding facade: dispatch by format, hand back a Blob.

import { encodeApng } from './apng/index.ts'
import { encodeGif } from './gif/index.ts'
import { encodeWebpAnim, type StillEncoder } from './webp/index.ts'
import type {
  AnimDoc,
  ApngEncodeOptions,
  GifEncodeOptions,
  WebpEncodeOptions,
} from './types.ts'

export type EncodeOptions =
  | ({ format: 'gif' } & GifEncodeOptions)
  | ({ format: 'apng' } & ApngEncodeOptions)
  | ({ format: 'webp' } & WebpEncodeOptions)

export const MIME: Record<EncodeOptions['format'], string> = {
  gif: 'image/gif',
  apng: 'image/apng',
  webp: 'image/webp',
}

export async function encodeAnimationBytes(
  doc: AnimDoc,
  opts: EncodeOptions,
  webpStill?: StillEncoder,
): Promise<Uint8Array> {
  switch (opts.format) {
    case 'gif':
      return encodeGif(doc, opts)
    case 'apng':
      return encodeApng(doc, opts)
    case 'webp':
      return encodeWebpAnim(doc, opts, webpStill)
    default: {
      // Exhaustiveness guard: adding a format without handling it fails to compile.
      const never: never = opts
      throw new Error(`Unsupported format: ${JSON.stringify(never)}`)
    }
  }
}

export async function encodeAnimation(
  doc: AnimDoc,
  opts: EncodeOptions,
  webpStill?: StillEncoder,
): Promise<Blob> {
  const bytes = await encodeAnimationBytes(doc, opts, webpStill)
  return new Blob([bytes.slice().buffer as ArrayBuffer], { type: MIME[opts.format] })
}
