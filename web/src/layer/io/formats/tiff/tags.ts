// TIFF tag numbers and enumerations (spec 05 §4.2 / §4.3 / §4.4).

export const TIFF_TAG = {
  NewSubfileType: 254,
  SubfileType: 255,
  ImageWidth: 256,
  ImageLength: 257,
  BitsPerSample: 258,
  Compression: 259,
  PhotometricInterpretation: 262,
  Threshholding: 263,
  FillOrder: 266,
  DocumentName: 269,
  ImageDescription: 270,
  Make: 271,
  Model: 272,
  StripOffsets: 273,
  Orientation: 274,
  SamplesPerPixel: 277,
  RowsPerStrip: 278,
  StripByteCounts: 279,
  MinSampleValue: 280,
  MaxSampleValue: 281,
  XResolution: 282,
  YResolution: 283,
  PlanarConfiguration: 284,
  PageName: 285,
  XPosition: 286,
  YPosition: 287,
  ResolutionUnit: 296,
  PageNumber: 297,
  Software: 305,
  DateTime: 306,
  Artist: 315,
  HostComputer: 316,
  Predictor: 317,
  WhitePoint: 318,
  PrimaryChromaticities: 319,
  ColorMap: 320,
  TileWidth: 322,
  TileLength: 323,
  TileOffsets: 324,
  TileByteCounts: 325,
  SubIFDs: 330,
  InkSet: 332,
  NumberOfInks: 334,
  ExtraSamples: 338,
  SampleFormat: 339,
  SMinSampleValue: 340,
  SMaxSampleValue: 341,
  JPEGTables: 347,
  YCbCrCoefficients: 529,
  YCbCrSubSampling: 530,
  YCbCrPositioning: 531,
  ReferenceBlackWhite: 532,
  XMP: 700,
  Copyright: 33432,
  IPTC: 33723,
  Photoshop: 34377,
  ExifIFD: 34665,
  InterColorProfile: 34675,
  GPSIFD: 34853,
  InteroperabilityIFD: 40965,
  ImageSourceData: 37724,
} as const

export const COMPRESSION = {
  None: 1,
  CcittRle: 2,
  CcittG3: 3,
  CcittG4: 4,
  Lzw: 5,
  OldJpeg: 6,
  Jpeg: 7,
  AdobeDeflate: 8,
  Jbig85: 9,
  Jbig43: 10,
  NeXT: 32766,
  PackBits: 32773,
  ThunderScan: 32809,
  DeflateOld: 32946,
  Jpeg2000: 34712,
} as const

export const PHOTOMETRIC = {
  WhiteIsZero: 0,
  BlackIsZero: 1,
  Rgb: 2,
  Palette: 3,
  TransparencyMask: 4,
  Separated: 5,
  YCbCr: 6,
  CieLab: 8,
  IccLab: 9,
  ItuLab: 10,
  Cfa: 32803,
  LogL: 32844,
  LogLuv: 32845,
  LinearRaw: 34892,
} as const

export const SAMPLE_FORMAT = {
  Uint: 1,
  Int: 2,
  IeeeFloat: 3,
  Undefined: 4,
} as const

export const EXTRA_SAMPLE = {
  Unspecified: 0,
  AssociatedAlpha: 1,
  UnassociatedAlpha: 2,
} as const

export const PLANAR = {
  Chunky: 1,
  Planar: 2,
} as const

export const PREDICTOR = {
  None: 1,
  Horizontal: 2,
  FloatingPoint: 3,
} as const

export const RESOLUTION_UNIT = {
  None: 1,
  Inch: 2,
  Centimeter: 3,
} as const

/** `NewSubfileType` bit flags (tag 254). */
export const SUBFILE = {
  ReducedResolution: 1,
  Page: 2,
  TransparencyMask: 4,
} as const

/** Compression names, for warnings and diagnostics. */
export function compressionName(code: number): string {
  for (const [name, value] of Object.entries(COMPRESSION)) {
    if (value === code) return name
  }
  return `unknown(${code})`
}

export function photometricName(code: number): string {
  for (const [name, value] of Object.entries(PHOTOMETRIC)) {
    if (value === code) return name
  }
  return `unknown(${code})`
}
