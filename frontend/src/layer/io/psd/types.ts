/*
 * PSD/PSB pivot data model.
 *
 * Derived from Adobe's public "Photoshop File Formats Specification" and from
 * the GIMP PSD plug-in (file-psd), Copyright 2007 John Marshall, GPLv3+.
 * Independent TypeScript re-implementation; no GIMP source was copied.
 * Kubuno is AGPLv3, compatible with the GPLv3 (GPLv3 §13).
 */
import type { Descriptor } from './descriptor/types.ts'
import type { PsdLimits } from './constants.ts'

export type PsdVersion = 1 | 2
export type PsdDepth = 1 | 8 | 16 | 32
export type PsdColorMode = 0 | 1 | 2 | 3 | 4 | 7 | 8 | 9

/** Rectangle in DOCUMENT coordinates; `bottom`/`right` are exclusive. */
export interface PsdRect {
  readonly top: number
  readonly left: number
  readonly bottom: number
  readonly right: number
}

export function rectWidth(r: PsdRect): number {
  return Math.max(0, r.right - r.left)
}

export function rectHeight(r: PsdRect): number {
  return Math.max(0, r.bottom - r.top)
}

export const EMPTY_RECT: PsdRect = { top: 0, left: 0, bottom: 0, right: 0 }

/** Stable machine codes for lossy conversions, used as i18n key suffixes. */
export type PsdWarningCode =
  | 'color-mode-converted'
  | 'bit-depth-reduced'
  | 'hdr-tone-mapped'
  | 'blend-mode-approximated'
  | 'blend-mode-unsupported'
  | 'layer-effects-rasterized'
  | 'adjustment-approximated'
  | 'adjustment-unsupported'
  | 'text-rasterized'
  | 'smart-object-rasterized'
  | 'vector-mask-rasterized'
  | 'clipping-flattened'
  | 'channels-dropped'
  | 'unknown-blocks-preserved'
  | 'truncated-file'
  | 'malformed-block-skipped'

export interface PsdWarning {
  readonly code: PsdWarningCode
  /** Free-form details for the message (layer name, mode key…). Never localised. */
  readonly detail?: Record<string, string | number>
  readonly severity: 'info' | 'warning'
}

export interface PsdImageResource {
  readonly id: number
  readonly name: string
  readonly signature: string
  readonly data: Uint8Array
}

/** An additional-layer-information block, kept verbatim for round-tripping. */
export interface PsdRawBlock {
  readonly signature: string
  readonly key: string
  readonly data: Uint8Array
}

/**
 * One channel of one layer.
 *
 * `decode()` is lazy on purpose: pass 1 of the reader only records
 * `offset`/`dataLength` so a 500 MB file yields its full layer tree in a few
 * milliseconds (spec §9.2). The decoded buffer is cached after the first call.
 *
 * The returned bytes are the channel's samples in FILE layout — one byte per
 * sample at depth 8, two big-endian bytes at depth 16, four big-endian bytes at
 * depth 32, MSB-first packed rows at depth 1 — sized for the channel's OWN
 * rectangle (the layer rect, or the mask rect for ids -2 and -3), never for the
 * document.
 */
export interface PsdChannel {
  readonly id: number
  readonly dataLength: number
  /** Absolute offset of the channel payload in the source buffer, or -1. */
  readonly offset: number
  decode(): Promise<Uint8Array>
}

export interface PsdMask {
  readonly rect: PsdRect
  readonly defaultColor: number
  readonly flags: number
  /** `(flags & 0x02) !== 0` — the mask exists but is switched off. */
  readonly disabled: boolean
  readonly relative: boolean
  readonly fromRender: boolean
  readonly real: {
    readonly rect: PsdRect
    readonly defaultColor: number
    readonly flags: number
  } | null
  readonly density: number | null
  readonly feather: number | null
}

export type PsdLayerKind =
  | 'raster'
  | 'group'
  | 'adjustment'
  | 'fill'
  | 'text'
  | 'smart-object'

export interface PsdLayer {
  readonly kind: PsdLayerKind
  readonly name: string
  /** `lyid` — stable Photoshop layer id, or null when absent. */
  readonly id: number | null
  /**
   * The layer's OWN rectangle. Pixels are always decoded at this size and are
   * NEVER expanded to the document size: doing so is what makes a 40-layer
   * 6000x4000 document cost 3.8 GB instead of ~1 GB (spec §7.3 "E1", §9.3).
   * Consumers that need document-space pixels must blit on demand.
   */
  readonly rect: PsdRect
  /** 0..255. */
  readonly opacity: number
  /** 0..255; from the `iOpa` block, 255 when absent. */
  readonly fillOpacity: number
  /** Raw 4-character key, exactly as found in the file. */
  readonly blendMode: string
  readonly visible: boolean
  readonly clipping: boolean
  readonly locks: {
    readonly all: boolean
    readonly alpha: boolean
    readonly composite: boolean
    readonly position: boolean
  }
  /** `lclr`, 0..7. */
  readonly colorTag: number
  /** `lsct = 1` (open folder) vs 2 (collapsed). Meaningless for non-groups. */
  readonly expanded: boolean
  readonly channels: readonly PsdChannel[]
  readonly mask: PsdMask | null
  /** `lfx2` descriptor, kept as parsed; null when the layer has no effects. */
  readonly effects: Descriptor | null
  readonly adjustment: {
    readonly key: string
    readonly descriptor: Descriptor | null
    readonly legacy: Uint8Array | null
  } | null
  readonly text: {
    readonly transform: readonly number[]
    readonly descriptor: Descriptor | null
  } | null
  readonly children: readonly PsdLayer[]
  /** Every additional block, in file order, including the ones we understand. */
  readonly blocks: readonly PsdRawBlock[]
  /** Legacy blending ranges, preserved verbatim (never interpreted). */
  readonly blendingRanges: Uint8Array | null
  /** Raw layer flags byte, preserved so unknown bits survive a round trip. */
  readonly flags: number
}

export interface PsdGlobalMask {
  readonly overlayColorSpace: number
  readonly colorComponents: readonly number[]
  readonly opacity: number
  readonly kind: number
  readonly data: Uint8Array
}

/** Flattened preview, always normalised to non-premultiplied 8-bit sRGB RGBA. */
export interface PsdImage {
  readonly width: number
  readonly height: number
  readonly data: Uint8Array
}

export interface PsdResolution {
  /** Horizontal resolution in pixels per inch. */
  readonly hDpi: number
  readonly vDpi: number
}

export interface PsdDocument {
  readonly version: PsdVersion
  readonly width: number
  readonly height: number
  readonly channels: number
  readonly depth: PsdDepth
  readonly colorMode: PsdColorMode
  readonly colorModeData: Uint8Array | null
  /** Image resources in file order, so unknown ones can be re-emitted as-is. */
  readonly resources: readonly PsdImageResource[]
  /** Layer tree, TOP layer first (the panel order). */
  readonly layers: readonly PsdLayer[]
  readonly globalMask: PsdGlobalMask | null
  /** Document-level additional blocks (`Patt`, `lnk2`, `Txt2`…). */
  readonly documentBlocks: readonly PsdRawBlock[]
  /** Composite preview from the Image Data section; null when skipped. */
  readonly composite: PsdImage | null
  readonly resolution: PsdResolution
  readonly warnings: readonly PsdWarning[]
  /**
   * True when the file declared a negative layer count, i.e. the first alpha
   * channel of the merged image holds the transparency of the composite.
   */
  readonly compositeHasAlpha: boolean
}

export type ReadPhase = 'header' | 'resources' | 'layers' | 'channels' | 'composite'
export type WritePhase = 'header' | 'resources' | 'layers' | 'channels' | 'composite'

export interface ReadOptions {
  /** Decode every channel eagerly instead of on first use. Default: false. */
  eager?: boolean
  /** Decode the flattened Image Data preview. Default: true. */
  composite?: boolean
  onProgress?: (p: number, phase: ReadPhase) => void
  /** Overrides for LIMITS. Use with care. */
  limits?: Partial<PsdLimits>
}

export interface WriteOptions {
  /** 1 = PSD, 2 = PSB, 'auto' = pick from the document size. Default: 'auto'. */
  version?: PsdVersion | 'auto'
  /** Flattened RGBA8 preview for the Image Data section. Strongly recommended. */
  composite?: PsdImage
  onProgress?: (p: number, phase: WritePhase) => void
}

/** Mutable warning sink shared by every reader stage. */
export interface WarningSink {
  warn(
    code: PsdWarningCode,
    detail?: Record<string, string | number>,
    severity?: 'info' | 'warning',
  ): void
}

/** Everything the sub-readers need to know about the file being parsed. */
export interface ReadCtx extends WarningSink {
  readonly isPsb: boolean
  readonly depth: PsdDepth
  readonly colorMode: PsdColorMode
  readonly limits: PsdLimits
  /** Cumulative decoded-pixel budget, decremented as channels are reserved. */
  budget: { remaining: number }
}
