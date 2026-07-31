// Public surface of the fixed-raster format layer (spec 05 §10.5, §12).
//
// Nothing under `layer/io/**` may import React, `@kubuno/ui` or `@kubuno/drive`: this is
// pure TypeScript, runnable in a Web Worker and testable without a DOM.

export type {
  AlphaMode,
  ColorModel,
  ColorSpaceRef,
  DecodedFile,
  ExtraChannel,
  FastProbe,
  IoWarning,
  PageRole,
  RasterImage,
  RasterPage,
  SampleArray,
  SampleType,
} from './types'
export {
  IoError,
  IoInvalidError,
  IoLimitError,
  IoTruncatedError,
  IoUnsupportedError,
  WarningSink,
  channelsForModel,
  ioWarn,
  samplesPerPixel,
} from './types'

export type {
  ByteSource,
  DetectResult,
  EncodeInput,
  FormatCapabilities,
  FormatDescriptor,
  FormatOptions,
  IoContext,
  OptionField,
  OptionsSchema,
  ReadOptions,
} from './registry'
export { FormatRegistry, formats } from './registry'

export { blobSource, bufferSource, readSniffWindow } from './bytes'
export { ByteReader, latin1, matchAscii, matchBytes } from './reader'
export {
  MAX_BUFFER_BYTES,
  MAX_DIMENSION,
  MAX_PAGES,
  MAX_PIXELS,
  checkDimensions,
  checkSampleCount,
} from './limits'

export type { ContainerKind, SniffInput, SniffResult, SniffedFormatId } from './sniff'
export { classifyTiffFamily, sniff, tiffFlavour } from './sniff'

export { registerRasterFormats } from './descriptors'

// Codecs, exported because the animated (06) and exotic (07) specs reuse them.
export { deflate, inflate } from './codecs/deflate'
export { lzwDecode, lzwEncode } from './codecs/lzw'
export { packBits, unpackBits } from './codecs/packbits'
export {
  applyHorizontalPredictor,
  undoFloatingPredictor,
  undoHorizontalPredictor,
} from './codecs/predictor'
export { floatToHalf, halfToFloat, packSubByteSamples, reverseBits, unpackSubByteSamples } from './codecs/bits'

// TIFF, including the IFD reader shared with the EXIF parser.
export { IfdReader, readTiffHeader, tagBytes, tagNumber, tagNumbers, tagText } from './tiff/ifd'
export type { Ifd, IfdEntry, TiffHeader } from './tiff/ifd'
export { decodeTiff, probeTiffPages } from './tiff/decode'
export type { JpegBlockDecoder, TiffDecodeOptions } from './tiff/decode'
export { encodeTiff } from './tiff/encode'
export type { TiffCompression, TiffEncodeOptions } from './tiff/encode'
export { insertJpegSegments, readJpegSegments, rebuildJpegStream } from './tiff/jpegStream'

// Individual codecs.
export { decodeBmp, encodeBmp, toRgba8 } from './bmp'
export { decodeIco, encodeIco } from './ico'
export { decodePng, encodePng, probePng } from './png'
export { decodeTga, encodeTga } from './tga'
export { decodePnm, encodePnm } from './pnm'
export { createJpegBlockDecoder, nativeDecode, nativeEncode, probeNativeEncoders } from './native'
export { readJpegMetadata, readNativeImage, readRiffMetadata } from './nativeRead'
