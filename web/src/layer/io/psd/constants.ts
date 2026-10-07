/*
 * PSD/PSB shared constant tables.
 *
 * The tables below (colour-tag mapping, 64-bit additional-block keys, blend
 * keys) were derived from the GIMP PSD plug-in (file-psd), Copyright 2007 John
 * Marshall, GPLv3+ (`psd.h`, `psd-util.c`, `psd-layer-res-load.c`) and from
 * Adobe's public "Photoshop File Formats Specification". Independent
 * re-implementation; no GIMP source was copied. Kubuno is AGPLv3.
 */

/**
 * Hard ceilings. Every one of them turns a hostile or corrupt file into a clean
 * typed error instead of an allocation storm (spec §9.3).
 *
 * `MAX_TOTAL_LAYER_BYTES` is the cumulative budget for decoded layer pixels.
 * Because we keep every layer at its OWN rectangle (never expanded to the
 * document size — see the note on PsdLayer.rect), the realistic cost of a
 * 40-layer 6000x4000 document is ~1 GB rather than the ~3.8 GB it would be with
 * document-sized textures. The budget is checked before decoding, not after.
 */
export const LIMITS = {
  MAX_FILE_BYTES: 1_500_000_000, // 1.5 GB
  MAX_PIXELS: 300_000_000, // ~300 Mpx per image
  MAX_LAYERS: 8_000,
  MAX_CHANNELS_PER_LAYER: 99, // GIMP's MAX_CHANNELS, laxer than Adobe's 56
  MAX_DESCRIPTOR_DEPTH: 32,
  MAX_DESCRIPTOR_ITEMS: 65_536,
  MAX_LIST_ITEMS: 1_048_576,
  MAX_ADDITIONAL_BLOCK: 256_000_000, // 256 MB for one block (smart objects)
  MAX_IMAGE_RESOURCES: 65_536,
  MAX_GROUP_DEPTH: 64,
  MAX_TOTAL_LAYER_BYTES: 1_200_000_000, // cumulative decoded-pixel budget
  MAX_WRITE_BUFFER: 2_147_483_647, // 2 GiB - 1
} as const

export type PsdLimits = typeof LIMITS

/** File signature of every PSD/PSB. */
export const PSD_SIGNATURE = '8BPS'

/** Adobe's dimension ceilings, per file version. */
export const MAX_DIMENSION_PSD = 30_000
export const MAX_DIMENSION_PSB = 300_000

/** Colour modes we know how to name. Values not listed are rejected. */
export const KNOWN_COLOR_MODES: ReadonlySet<number> = new Set([0, 1, 2, 3, 4, 7, 8, 9])

export const COLOR_MODE = {
  BITMAP: 0,
  GRAYSCALE: 1,
  INDEXED: 2,
  RGB: 3,
  CMYK: 4,
  MULTICHANNEL: 7,
  DUOTONE: 8,
  LAB: 9,
} as const

/** Number of colour (non-alpha) channels for a given colour mode. */
export function colorChannelCount(mode: number): number {
  switch (mode) {
    case COLOR_MODE.RGB:
    case COLOR_MODE.LAB:
      return 3
    case COLOR_MODE.CMYK:
      return 4
    default:
      return 1
  }
}

export const COMPRESSION = {
  RAW: 0,
  RLE: 1,
  ZIP: 2,
  ZIP_PREDICTED: 3,
} as const

/**
 * Additional-layer-info keys whose length field is 64-bit in PSB files.
 * In a PSD (version 1) these very same keys keep a 32-bit length.
 *
 * Observed GIMP behaviour (psd-layer-res-load.c, get_layer_resource_header):
 * the `8B64` signature does NOT by itself widen the length field — only the
 * file version plus membership in this set do. We follow the same rule, and
 * accept `8B64` as a valid signature wherever `8BIM` is.
 */
export const PSB_64BIT_KEYS: ReadonlySet<string> = new Set([
  'LMsk', 'Lr16', 'Lr32', 'Layr', 'Mt16', 'Mt32', 'Mtrn',
  'Alph', 'FMsk', 'lnk2', 'FEid', 'FXid', 'PxSD',
  // Undocumented but observed in the wild and handled by GIMP.
  'lnkE', 'pths',
])

export const BLOCK_SIGNATURES: ReadonlySet<string> = new Set(['8BIM', '8B64'])

/** Image-resource signatures Photoshop and its friends emit. */
export const RESOURCE_SIGNATURES: ReadonlySet<string> = new Set([
  '8BIM', 'MeSa', 'PHUT', 'AgHg', 'DCSR',
])

export const RESOURCE_ID = {
  RESOLUTION_INFO: 1005,
  ALPHA_NAMES: 1006,
  THUMBNAIL_BGR: 1033,
  GRID_AND_GUIDES: 1032,
  THUMBNAIL_RGB: 1036,
  GLOBAL_ANGLE: 1037,
  ICC_PROFILE: 1039,
  ALPHA_NAMES_UNICODE: 1045,
  INDEXED_COLOR_COUNT: 1046,
  TRANSPARENT_INDEX: 1047,
  GLOBAL_ALTITUDE: 1049,
  VERSION_INFO: 1057,
  EXIF: 1058,
  XMP: 1060,
  LAYER_STATE: 1024,
  LAYER_SELECTION_IDS: 1069,
} as const

/**
 * `lclr` colour tag (0-7) -> Kubuno LAYER_COLORS hex values.
 * Derived from GIMP `psd_to_gimp_layer_color_tag()` (psd-util.c), GPLv3+.
 * Index 7 (grey) has no Kubuno equivalent and falls back to violet.
 */
export const PSD_COLOR_TAGS: readonly (string | null)[] = [
  null,       // 0 none
  '#ef4444',  // 1 red
  '#f59e0b',  // 2 orange
  '#eab308',  // 3 yellow
  '#22c55e',  // 4 green
  '#3b82f6',  // 5 blue
  '#a855f7',  // 6 violet
  '#a855f7',  // 7 grey -> no equivalent
]

/** Name Photoshop gives to the `lsct = 3` bounding section divider. */
export const SECTION_DIVIDER_NAME = '</Layer group>'

/** Layer record flag bits (spec §4.5). Bit 1 is INVERTED: set means hidden. */
export const LAYER_FLAG = {
  TRANSPARENCY_PROTECTED: 0x01,
  HIDDEN: 0x02,
  OBSOLETE: 0x04,
  BIT4_MEANINGFUL: 0x08,
  PIXEL_DATA_IRRELEVANT: 0x10,
} as const

/** Layer mask flag bits (spec §4.7). */
export const MASK_FLAG = {
  RELATIVE_TO_LAYER: 0x01,
  DISABLED: 0x02,
  INVERT_OBSOLETE: 0x04,
  FROM_RENDER: 0x08,
  HAS_PARAMETERS: 0x10,
} as const

/** `lspf` protection flags (spec §5.2). */
export const PROTECTION_FLAG = {
  TRANSPARENCY: 0x01,
  COMPOSITE: 0x02,
  POSITION: 0x04,
  NESTING: 0x08,
  ALL: 0x80000000,
} as const

/** Channel ids with a special meaning. */
export const CHANNEL_ID = {
  TRANSPARENCY: -1,
  USER_MASK: -2,
  REAL_MASK: -3,
} as const

/**
 * Additional-block keys we synthesise ourselves on write; any preserved raw
 * block carrying one of these is dropped so we never emit it twice.
 */
export const SELF_EMITTED_BLOCKS: ReadonlySet<string> = new Set([
  'luni', 'lyid', 'lclr', 'lspf', 'lsct', 'lsdk', 'iOpa',
])
