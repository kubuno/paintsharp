// Public surface of the metadata layer (spec 05 §6).
//
// EXIF, XMP, IPTC and ICC are the same blocks in every container: parsed once here, and
// plugged into each container by its own adapter.

export type {
  Chromaticities,
  ExifData,
  ExifIfd,
  ExifTagValue,
  IccProfile,
  ImageMetadata,
  IptcData,
  MutableImageMetadata,
  RenderingIntent,
  TransferFn,
  XmpPacket,
  XYZ,
} from './types'
export { EMPTY_METADATA, EXIF_TYPE_SIZE, ExifType, finishMetadata } from './types'

export {
  EXIF_TAG,
  GPS_TAG,
  exifGpsDecimal,
  exifNumber,
  exifOrientation,
  exifString,
  parseExif,
  parseExifFromReader,
  serializeExif,
  stripExifPrefix,
} from './exif'
export type { SerializeExifOptions } from './exif'

export { isSrgbProfile, joinIccFromJpeg, parseIcc, splitIccForJpeg } from './icc'

export { IPTC_FIELD, extract8BimIptc, iptcValue, iptcValues, parseIptc, serializeIptc, wrap8Bim } from './iptc'

export {
  XMP_EXTENDED_JPEG_ID,
  XMP_JPEG_ID,
  XMP_PROPERTY,
  findXmpPacket,
  joinExtendedXmp,
  parseXmp,
  xmpGet,
  xmpSet,
} from './xmp'

export type { Orientation } from './orientation'
export {
  applyOrientation,
  isOrientation,
  orientationLabel,
  orientationSwapsAxes,
  resetOrientationTag,
  transformRgba,
  transformSamples,
} from './orientation'

export { mergeMetadataFields } from './merge'
