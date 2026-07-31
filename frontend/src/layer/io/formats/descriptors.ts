// Format descriptors (spec 05 §7.2).
//
// GOLDEN RULE: no codec is imported statically here. Each descriptor is a few hundred
// bytes — strings, a `sniff` closure and `() => import(...)` thunks — so the whole set
// stays on the critical path for ~4 KiB while every decoder is a separate chunk.
//
// `sniff` returns a CONFIDENCE, never a boolean: TIFF and the RAW formats share a
// signature, and the RAW descriptors (spec 07) outbid the generic TIFF one with 0.9.

import { formats, type EncodeInput, type FormatDescriptor, type IoContext, type ReadOptions } from './registry'
import {
  isBmp,
  isCur,
  isDds,
  isExr,
  isHdr,
  isIco,
  isJpeg,
  isPng,
  isRiffWebp,
  isAnimatedWebp,
  isAvif,
  isPnm,
  tgaConfidence,
  tiffFlavour,
  classifyTiffFamily,
} from './sniff'
import type { ByteSource } from './registry'
import type { DecodedFile } from './types'

async function allBytes(source: ByteSource): Promise<Uint8Array> {
  return source.all()
}

function noWarn(): IoContext {
  return { warn: () => undefined }
}

export const tiffFormat: FormatDescriptor = {
  id: 'tiff',
  labelKey: 'layer.io.format.tiff',
  extensions: ['tif', 'tiff'],
  mimes: ['image/tiff'],
  canRead: true,
  canWrite: true,
  sniff: (head, filename) => {
    const flavour = tiffFlavour(head)
    if (!flavour) return 0
    if (flavour.magic !== 42 && flavour.magic !== 43) return 0 // ORF/RW2 pseudo-TIFF
    // Generic fallback of the TIFF family: RAW descriptors claim 0.9 on the same bytes.
    const verdict = classifyTiffFamily({ head, name: filename })
    return verdict.id === 'tiff' ? 0.6 : 0
  },
  probe: async (source) =>
    import('./tiff/decode').then((m) => {
      const head = source.all()
      return head.then((bytes) => {
        const p = m.probeTiffPages(bytes)
        return {
          formatId: 'tiff',
          width: p.width,
          height: p.height,
          bitDepth: p.bitDepth,
          pageCount: p.pageCount,
          hasIcc: p.hasIcc,
          hasExif: p.hasExif,
          orientation: p.orientation,
          colorModel: p.colorModel,
          extraChannels: Math.max(0, p.samplesPerPixel - 4),
          // TIFF has no native decoder at all: never.
          nativeDecodeSufficient: false,
        }
      })
    }),
  read: async (source, opts, ctx) => {
    const [{ decodeTiff }, bytes] = await Promise.all([import('./tiff/decode'), allBytes(source)])
    const native = await import('./native')
      .then((m) => m.createJpegBlockDecoder())
      .catch(() => undefined)
    return decodeTiff(bytes, {
      pageIndex: opts.pageIndex,
      maxPixels: opts.maxPixels,
      signal: ctx.signal,
      warn: ctx.warn,
      headerOnly: opts.headerOnly,
      jpegDecoder: native,
    })
  },
  write: async (input, opts) => {
    const { encodeTiff } = await import('./tiff/encode')
    const bytes = await encodeTiff([input.image, ...(input.pages ?? [])], {
      compression: (opts.compression as 'none' | 'deflate' | 'lzw' | 'packbits') ?? 'deflate',
      predictor: opts.predictor as boolean | undefined,
      metadata: input.metadata,
      iccProfile: input.metadata.icc?.raw,
    })
    return new Blob([bytes.buffer as ArrayBuffer], { type: 'image/tiff' })
  },
  capabilities: {
    maxBitDepth: 32,
    alpha: true,
    layers: false,
    multiPage: true,
    colorModels: ['gray', 'rgb', 'cmyk', 'lab', 'indexed'],
    icc: true,
    exif: true,
    xmp: true,
    iptc: true,
    lossless: 'optional',
  },
}

export const pngFormat: FormatDescriptor = {
  id: 'png',
  labelKey: 'layer.io.format.png',
  extensions: ['png'],
  mimes: ['image/png'],
  canRead: true,
  canWrite: true,
  // An exclusive 8-byte signature. APNG (spec 06) claims the same bytes with 0.9.
  sniff: (head) => (isPng(head) ? 1 : 0),
  probe: async (source) => {
    const { probePng } = await import('./png')
    const p = probePng(await source.slice(0, Math.min(source.size, 65536)))
    return {
      formatId: 'png',
      width: p.width,
      height: p.height,
      bitDepth: p.bitDepth,
      pageCount: 1,
      hasIcc: p.hasIcc,
      hasExif: p.hasExif,
      orientation: 1,
      colorModel: p.colorType === 3 ? 'indexed' : p.colorType === 0 || p.colorType === 4 ? 'gray' : 'rgb',
      extraChannels: 0,
      nativeDecodeSufficient: p.nativeDecodeSufficient,
    }
  },
  read: async (source) => {
    const { decodePng } = await import('./png')
    return decodePng(await allBytes(source))
  },
  write: async (input, opts) => {
    const { encodePng } = await import('./png')
    const bytes = await encodePng(input.image, {
      bitDepth: (opts.bitsPerSample as 8 | 16 | undefined) ?? (input.image.sampleType === 'u16' ? 16 : 8),
      filterStrategy: (opts.filterStrategy as 'fast' | 'optimal' | undefined) ?? 'optimal',
      iccProfile: input.metadata.icc?.raw,
      xmp: input.metadata.xmp?.raw,
    })
    return new Blob([bytes.buffer as ArrayBuffer], { type: 'image/png' })
  },
  capabilities: {
    maxBitDepth: 16,
    alpha: true,
    layers: false,
    multiPage: false,
    colorModels: ['gray', 'rgb', 'indexed'],
    icc: true,
    exif: true,
    xmp: true,
    iptc: false,
    lossless: true,
  },
}

export const bmpFormat: FormatDescriptor = {
  id: 'bmp',
  labelKey: 'layer.io.format.bmp',
  extensions: ['bmp', 'dib'],
  mimes: ['image/bmp'],
  canRead: true,
  canWrite: true,
  // 'BM' alone is two bytes; the DIB header size is cross-checked, hence 0.9 not 1.0.
  sniff: (head) => (isBmp(head) ? 0.9 : 0),
  read: async (source) => {
    const { decodeBmp } = await import('./bmp')
    return decodeBmp(await allBytes(source))
  },
  write: async (input, opts) => {
    const { encodeBmp } = await import('./bmp')
    const bytes = encodeBmp(input.image, { bitCount: opts.bitCount as 8 | 16 | 24 | 32 | undefined })
    return new Blob([bytes.buffer as ArrayBuffer], { type: 'image/bmp' })
  },
  capabilities: {
    maxBitDepth: 8,
    alpha: true,
    layers: false,
    multiPage: false,
    colorModels: ['rgb', 'indexed'],
    icc: false,
    exif: false,
    xmp: false,
    iptc: false,
    lossless: true,
  },
}

export const icoFormat: FormatDescriptor = {
  id: 'ico',
  labelKey: 'layer.io.format.ico',
  extensions: ['ico'],
  mimes: ['image/x-icon', 'image/vnd.microsoft.icon'],
  canRead: true,
  canWrite: true,
  sniff: (head) => (isIco(head) ? 1 : 0),
  read: async (source) => {
    const { decodeIco } = await import('./ico')
    return decodeIco(await allBytes(source))
  },
  write: async (input, opts) => {
    const { encodeIco } = await import('./ico')
    const bytes = await encodeIco([input.image, ...(input.pages ?? [])], {
      entryFormat: (opts.entryFormat as 'auto' | 'png' | 'bmp' | undefined) ?? 'auto',
    })
    return new Blob([bytes.buffer as ArrayBuffer], { type: 'image/x-icon' })
  },
  capabilities: {
    maxBitDepth: 8,
    alpha: true,
    layers: false,
    multiPage: true,
    colorModels: ['rgb', 'indexed'],
    icc: false,
    exif: false,
    xmp: false,
    iptc: false,
    lossless: true,
  },
}

export const curFormat: FormatDescriptor = {
  ...icoFormat,
  id: 'cur',
  labelKey: 'layer.io.format.cur',
  extensions: ['cur'],
  mimes: ['image/x-icon'],
  sniff: (head) => (isCur(head) ? 1 : 0),
  write: async (input, opts) => {
    const { encodeIco } = await import('./ico')
    const bytes = await encodeIco([input.image, ...(input.pages ?? [])], {
      cursor: true,
      entryFormat: (opts.entryFormat as 'auto' | 'png' | 'bmp' | undefined) ?? 'bmp',
    })
    return new Blob([bytes.buffer as ArrayBuffer], { type: 'image/x-icon' })
  },
}

export const tgaFormat: FormatDescriptor = {
  id: 'tga',
  labelKey: 'layer.io.format.tga',
  extensions: ['tga', 'icb', 'vda', 'vst'],
  mimes: ['image/x-tga', 'image/x-targa'],
  canRead: true,
  canWrite: true,
  // TGA 1.0 has NO signature: only a plausible header, hence a deliberately low score
  // that any real magic number outranks. The 2.0 footer is checked by `sniff` callers
  // that pass a tail; here only the header heuristic is available.
  sniff: (head, filename) => tgaConfidence({ head, name: filename }),
  read: async (source) => {
    const { decodeTga } = await import('./tga')
    return decodeTga(await allBytes(source))
  },
  write: async (input, opts) => {
    const { encodeTga } = await import('./tga')
    const bytes = encodeTga(input.image, {
      rle: (opts.rle as boolean | undefined) ?? true,
      origin: (opts.origin as 'bottom-left' | 'top-left' | undefined) ?? 'bottom-left',
    })
    return new Blob([bytes.buffer as ArrayBuffer], { type: 'image/x-tga' })
  },
  capabilities: {
    maxBitDepth: 8,
    alpha: true,
    layers: false,
    multiPage: false,
    colorModels: ['gray', 'rgb', 'indexed'],
    icc: false,
    exif: false,
    xmp: false,
    iptc: false,
    lossless: true,
  },
}

export const pnmFormat: FormatDescriptor = {
  id: 'pnm',
  labelKey: 'layer.io.format.pnm',
  extensions: ['pnm', 'ppm', 'pgm', 'pbm', 'pam', 'pfm'],
  mimes: ['image/x-portable-anymap', 'image/x-portable-pixmap'],
  canRead: true,
  canWrite: true,
  sniff: (head) => (isPnm(head) ? 1 : 0),
  read: async (source) => {
    const { decodePnm } = await import('./pnm')
    return decodePnm(await allBytes(source))
  },
  write: async (input, opts) => {
    const { encodePnm } = await import('./pnm')
    const bytes = encodePnm(input.image, { ascii: opts.ascii as boolean | undefined })
    return new Blob([bytes.buffer as ArrayBuffer], { type: 'image/x-portable-anymap' })
  },
  capabilities: {
    maxBitDepth: 16,
    alpha: true,
    layers: false,
    multiPage: false,
    colorModels: ['gray', 'rgb'],
    icc: false,
    exif: false,
    xmp: false,
    iptc: false,
    lossless: true,
  },
}

/**
 * JPEG: pixels natively, container in-house. `imageOrientation: 'none'` is mandatory so
 * the rotation is applied exactly once (spec 05 §6.3).
 */
export const jpegFormat: FormatDescriptor = {
  id: 'jpeg',
  labelKey: 'layer.io.format.jpeg',
  extensions: ['jpg', 'jpeg', 'jpe', 'jfif'],
  mimes: ['image/jpeg'],
  canRead: true,
  canWrite: true,
  sniff: (head) => (isJpeg(head) ? 1 : 0),
  read: async (source, opts, ctx) => {
    const { readNativeImage } = await import('./nativeRead')
    return readNativeImage(source, 'jpeg', 'image/jpeg', opts, ctx)
  },
  write: async (input, opts) => {
    const { nativeEncode } = await import('./native')
    const { toRgba8 } = await import('./bmp')
    const rgba = toRgba8(input.image)
    // Below 1.0 the browser always writes 4:2:0; exactly 1.0 switches to 4:4:4 (measured).
    return nativeEncode(rgba, input.image.width, input.image.height, 'image/jpeg', (opts.quality as number) ?? 0.92)
  },
  capabilities: {
    maxBitDepth: 8,
    alpha: false,
    layers: false,
    multiPage: false,
    colorModels: ['gray', 'rgb'],
    icc: true,
    exif: true,
    xmp: true,
    iptc: true,
    lossless: false,
  },
}

export const webpFormat: FormatDescriptor = {
  id: 'webp',
  labelKey: 'layer.io.format.webp',
  extensions: ['webp'],
  mimes: ['image/webp'],
  canRead: true,
  canWrite: true,
  // Animated WebP belongs to spec 06, which claims the same bytes with a higher score.
  sniff: (head) => (isRiffWebp(head) && !isAnimatedWebp(head) ? 1 : 0),
  read: async (source, opts, ctx) => {
    const { readNativeImage } = await import('./nativeRead')
    return readNativeImage(source, 'webp', 'image/webp', opts, ctx)
  },
  write: async (input, opts) => {
    const { nativeEncode } = await import('./native')
    const { toRgba8 } = await import('./bmp')
    const rgba = toRgba8(input.image)
    // quality === 1.0 selects LOSSLESS VP8L, and is often smaller than 0.99 (measured).
    return nativeEncode(rgba, input.image.width, input.image.height, 'image/webp', (opts.quality as number) ?? 0.9)
  },
  capabilities: {
    maxBitDepth: 8,
    alpha: true,
    layers: false,
    multiPage: false,
    colorModels: ['rgb'],
    icc: true,
    exif: true,
    xmp: true,
    iptc: false,
    lossless: 'optional',
  },
}

/** AVIF: readable natively, NOT writable — `convertToBlob` falls back to PNG (measured). */
export const avifFormat: FormatDescriptor = {
  id: 'avif',
  labelKey: 'layer.io.format.avif',
  extensions: ['avif'],
  mimes: ['image/avif'],
  canRead: true,
  canWrite: false,
  sniff: (head) => (isAvif(head) ? 1 : 0),
  read: async (source, opts, ctx) => {
    const { readNativeImage } = await import('./nativeRead')
    return readNativeImage(source, 'avif', 'image/avif', opts, ctx)
  },
  capabilities: {
    maxBitDepth: 8,
    alpha: true,
    layers: false,
    multiPage: false,
    colorModels: ['rgb'],
    icc: true,
    exif: true,
    xmp: true,
    iptc: false,
    lossless: 'optional',
  },
}

/**
 * Formats detected but not implemented here. Registering them with `canRead: false` is
 * what turns "nothing happens" into an explicit, translatable refusal.
 */
export const unsupportedFormats: readonly FormatDescriptor[] = [
  makeUnsupported('dds', 'layer.io.format.dds', ['dds'], ['image/vnd-ms.dds'], isDds),
  makeUnsupported('exr', 'layer.io.format.exr', ['exr'], ['image/x-exr'], isExr),
  makeUnsupported('hdr', 'layer.io.format.hdr', ['hdr', 'pic'], ['image/vnd.radiance'], isHdr),
]

function makeUnsupported(
  id: string,
  labelKey: string,
  extensions: readonly string[],
  mimes: readonly string[],
  test: (head: Uint8Array) => boolean,
): FormatDescriptor {
  return {
    id,
    labelKey,
    extensions,
    mimes,
    canRead: false,
    canWrite: false,
    sniff: (head) => (test(head) ? 1 : 0),
    capabilities: {
      maxBitDepth: 32,
      alpha: true,
      layers: false,
      multiPage: true,
      colorModels: ['rgb'],
      icc: false,
      exif: false,
      xmp: false,
      iptc: false,
      lossless: true,
    },
  }
}

/** Registers every descriptor this spec owns. Pure data: no codec is loaded. */
export function registerRasterFormats(): void {
  for (const d of [
    tiffFormat,
    pngFormat,
    jpegFormat,
    webpFormat,
    avifFormat,
    bmpFormat,
    icoFormat,
    curFormat,
    tgaFormat,
    pnmFormat,
    ...unsupportedFormats,
  ]) {
    formats.register(d)
  }
}

export type { DecodedFile, EncodeInput, ReadOptions }
export { noWarn }
