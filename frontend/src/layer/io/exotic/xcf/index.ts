// SPDX-License-Identifier: AGPL-3.0-or-later
//
// XCF (GIMP) reader — orchestration.
//
// XCF decoding logic derived from the GIMP source code (app/xcf/xcf-load.c,
// app/xcf/xcf-read.c, app/xcf/xcf-private.h, app/xcf/xcf.c, pdb/enums.pl),
// Copyright (C) 1995 Spencer Kimball and Peter Mattis and the GIMP contributors,
// licensed GPL-3.0-or-later. Reimplemented in TypeScript for Kubuno
// (AGPL-3.0-or-later); no line of GIMP's code is copied. XCF has no normative published
// specification — GIMP's source IS the specification.
//
// WRITING XCF IS DELIBERATELY OUT OF SCOPE (spec 07 §4.12): a partial writer produces
// files GIMP opens crookedly, and Layer already exports PNG/JPEG/WebP/TIFF plus its
// native .kblay.

import { ImportError, throwIfAborted, toImportError } from '../errors'
import {
  DEFAULT_PIXEL_BUDGET,
  ImportWarningSink,
  importWarn,
  type BlendMode,
  type DecodeOptions,
  type ImportedDocument,
  type ImportedNode,
} from '../types'
import { checkDimensions } from '../../formats/limits'
import { GIMP_MODE_PASS_THROUGH, isLinearSpace, mapBlendMode } from './blendModes'
import { layerType, readHeader, type XcfHeader } from './header'
import { decodeHierarchy } from './hierarchy'
import { classifyParasites, readParasites } from './parasites'
import { rgbaTileSink, maskTileSink, bytesPerPixel, type PixelConfig } from './pixels'
import { componentReader } from './precision'
import {
  COLOR_TAG_HEX,
  COMPRESS,
  PROP,
  propBool,
  propColormap,
  propF32,
  propI32,
  propItemPath,
  propU32,
  readPropList,
  type XcfProp,
} from './props'
import { XcfReader } from './reader'
import { freezeTree, insertByPath, type MutableGroup, type MutableNode } from './tree'

/** Layers and channels a single file may declare. Past this the header is not credible. */
const MAX_ITEMS = 10_000

interface ImageInfo {
  compression: number
  palette?: Uint8Array
  dpi?: number
  iccProfile?: Uint8Array
  comment?: string
  channelCount: number
  pathCount: number
}

/**
 * Decodes a whole XCF file into the neutral pivot model.
 *
 * Never throws a bare `Error`: everything surfaces as a typed `ImportError`. A partially
 * corrupt file opens truncated, with warnings, rather than failing — matching GIMP's own
 * `n_broken_layers` tolerance.
 */
export async function decodeXcf(
  bytes: Uint8Array,
  opts: DecodeOptions = {},
): Promise<ImportedDocument> {
  try {
    return await decodeXcfInner(bytes, opts)
  } catch (e) {
    throw toImportError(e, 'xcf')
  }
}

async function decodeXcfInner(bytes: Uint8Array, opts: DecodeOptions): Promise<ImportedDocument> {
  const warn = new ImportWarningSink()
  const r = new XcfReader(bytes)
  const header = readHeader(r)

  checkDimensions(header.width, header.height, 'XCF image')
  if (header.future) warn.warn(importWarn('xcf.future-version', { version: header.version }))
  if (!header.precisionKnown) warn.warn(importWarn('xcf.unknown-precision', { version: header.version }))

  const info = readImageProps(r, header, warn)

  if (info.compression === COMPRESS.FRACTAL) {
    // GIMP never implemented fractal compression itself; a file claiming it is either
    // hand-crafted or corrupt. Refusing explicitly beats decoding noise.
    throw new ImportError('unsupported-format', 'layer.io.err.xcf_fractal_compression')
  }

  const layerOffsets = readOffsetList(r, warn, 'layer')
  info.channelCount = readOffsetList(r, warn, 'channel').length
  if (header.version >= 18) info.pathCount = readOffsetList(r, warn, 'path').length

  r.setJumpBudget(layerOffsets.length + info.channelCount + info.pathCount + 64)

  const budget = opts.maxPixelBudget ?? DEFAULT_PIXEL_BUDGET
  const surface = header.width * header.height * Math.max(1, layerOffsets.length)
  if (surface > budget) {
    throw new ImportError(
      'too-large',
      'layer.io.err.too_large',
      {
        width: header.width,
        height: header.height,
        layers: layerOffsets.length,
        megapixels: Math.round(surface / 1_000_000),
      },
      `${layerOffsets.length} layers × ${header.width}×${header.height}`,
    )
  }

  const roots: MutableNode[] = []
  let brokenPaths = 0
  let brokenLayers = 0
  let textLayers = 0
  let effectLayers = 0
  let approximatedModes = 0
  let outOfRange = false
  const approximatedNames = new Set<string>()

  for (let i = 0; i < layerOffsets.length; i++) {
    throwIfAborted(opts.signal)
    const offset = layerOffsets[i]
    let built: ReadLayerResult | null = null
    try {
      built = await readLayer(r, header, info, offset, warn)
    } catch (e) {
      if (e instanceof ImportError && (e.code === 'too-large' || e.code === 'cancelled')) throw e
      built = null
    }
    if (!built) {
      brokenLayers += 1
    } else {
      if (!insertByPath(roots, built.path, built.node)) brokenPaths += 1
      const meta = built.meta
      if (meta.approximated) {
        approximatedModes += 1
        approximatedNames.add(meta.gimpName)
      }
      if (meta.isText) textLayers += 1
      if (meta.effects > 0) effectLayers += 1
      if (meta.outOfRange) outOfRange = true
    }
    opts.onProgress?.((i + 1) / Math.max(1, layerOffsets.length))
  }

  if (brokenLayers > 0) warn.warn(importWarn('xcf.broken-layers', { count: brokenLayers }))
  if (brokenPaths > 0) warn.warn(importWarn('xcf.repaired-item-paths', { count: brokenPaths }))
  if (textLayers > 0) warn.warn(importWarn('xcf.text-layers-rasterized', { count: textLayers }))
  if (effectLayers > 0) warn.warn(importWarn('xcf.effects-dropped', { count: effectLayers }))
  if (info.channelCount > 0) warn.warn(importWarn('xcf.channels-skipped', { count: info.channelCount }))
  if (info.pathCount > 0) warn.warn(importWarn('xcf.paths-skipped', { count: info.pathCount }))
  if (approximatedModes > 0) {
    warn.warn(
      importWarn('xcf.approximated-blend-modes', {
        count: approximatedModes,
        modes: [...approximatedNames].join(', '),
      }),
    )
  }
  if (outOfRange) warn.warn(importWarn('xcf.out-of-range-clipped'))
  if (header.precision.bytesPerComponent > 1) {
    warn.warn(importWarn('xcf.depth-reduced-to-8bit', { source: header.precision.label }))
  }

  const layers = freezeTree(roots)
  const compressionName =
    info.compression === COMPRESS.RLE ? 'RLE' : info.compression === COMPRESS.ZLIB ? 'zlib' : 'none'

  return {
    width: header.width,
    height: header.height,
    title: stripExtension(opts.name) || 'XCF',
    layers,
    dpi: info.dpi,
    iccProfile: info.iccProfile,
    warnings: warn.list(),
    provenance:
      `XCF v${header.version} · ${compressionName} · ${header.precision.label} · ` +
      `${header.baseType.toUpperCase()} · ${layerOffsets.length} layer(s)`,
  }
}

// ---------------------------------------------------------------------------
// Image-level properties
// ---------------------------------------------------------------------------

function readImageProps(r: XcfReader, header: XcfHeader, warn: ImportWarningSink): ImageInfo {
  // GIMP initialises the compression to NONE before parsing, so a file WITHOUT
  // PROP_COMPRESSION is uncompressed — not RLE, whatever intuition suggests.
  const info: ImageInfo = { compression: COMPRESS.NONE, channelCount: 0, pathCount: 0 }

  readPropList(r, warn, (p: XcfProp) => {
    switch (p.type) {
      case PROP.COMPRESSION:
        if (p.size >= 1) {
          r.pos = p.at
          info.compression = r.u8()
        }
        break
      case PROP.COLORMAP:
        info.palette = propColormap(r, p, header.version, warn)
        break
      case PROP.RESOLUTION: {
        if (p.size >= 8) {
          r.pos = p.at
          const xres = r.f32()
          const yres = r.f32()
          if (Number.isFinite(xres) && xres > 0) info.dpi = Math.round((xres + (yres > 0 ? yres : xres)) / 2)
        }
        break
      }
      case PROP.PARASITES: {
        const known = classifyParasites(readParasites(r, p.at, p.size))
        info.iccProfile = known.iccProfile
        info.comment = known.comment
        break
      }
      default:
        // Every other image property is irrelevant to a raster import: guides, units,
        // sample points, item sets, the very old PROP_PATHS/PROP_VECTORS blocks.
        break
    }
  })

  if (header.baseType === 'indexed' && !info.palette) {
    warn.warn(importWarn('xcf.indexed-without-colormap'))
  }
  return info
}

/** Reads a NUL-terminated list of file pointers, validating each one. */
function readOffsetList(r: XcfReader, warn: ImportWarningSink, what: string): number[] {
  const out: number[] = []
  for (let i = 0; i < MAX_ITEMS; i++) {
    const posBefore = r.pos
    const offset = r.offset()
    if (offset === 0) return out
    // The forward-only rule (`offset >= info->cp` in GIMP) is the anti-loop guarantee.
    if (!r.validOffset(offset, posBefore)) {
      warn.warn(importWarn('xcf.bad-item-offset', { what }))
      return out
    }
    out.push(offset)
  }
  warn.warn(importWarn('xcf.too-many-items', { what }))
  return out
}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

interface LayerMeta {
  readonly approximated: boolean
  readonly gimpName: string
  readonly isText: boolean
  readonly effects: number
  readonly outOfRange: boolean
}

interface ReadLayerResult {
  readonly node: MutableNode
  readonly path: readonly number[]
  readonly meta: LayerMeta
}

async function readLayer(
  r: XcfReader,
  header: XcfHeader,
  info: ImageInfo,
  offset: number,
  warn: ImportWarningSink,
): Promise<ReadLayerResult | null> {
  r.pos = offset
  const lw = r.u32()
  const lh = r.u32()
  const typeRaw = r.u32()
  const name = r.string()

  const type = layerType(typeRaw)
  if (!type) {
    // GIMP counts this in `n_broken_layers` and keeps going: an amputated document beats
    // a failed one.
    warn.warn(importWarn('xcf.unknown-layer-type', { type: typeRaw }))
    return null
  }

  let opacity = 100
  let floatOpacity: number | undefined
  let gimpMode = header.version >= 7 ? 28 : 0
  let visible = true
  let locked = false
  let lockAlpha = false
  let lockPosition = false
  let applyMask = true
  let offX = 0
  let offY = 0
  let isGroup = false
  let expanded = false
  let path: readonly number[] = []
  let colorLabel: string | undefined
  let isText = false
  let isFloatingSelection = false
  let linearSpace = false

  readPropList(r, warn, (p) => {
    switch (p.type) {
      case PROP.OPACITY:
        opacity = (Math.min(255, propU32(r, p)) / 255) * 100
        break
      case PROP.FLOAT_OPACITY:
        floatOpacity = propF32(r, p)
        break
      case PROP.MODE:
        gimpMode = propU32(r, p)
        break
      case PROP.VISIBLE:
        visible = propBool(r, p)
        break
      case PROP.LOCK_ALPHA:
        lockAlpha = propBool(r, p)
        break
      case PROP.LOCK_CONTENT:
        locked = propBool(r, p)
        break
      case PROP.LOCK_POSITION:
        lockPosition = propBool(r, p)
        break
      case PROP.APPLY_MASK:
        applyMask = propBool(r, p)
        break
      case PROP.OFFSETS:
        if (p.size >= 8) {
          r.pos = p.at
          offX = r.i32()
          offY = r.i32()
        }
        break
      case PROP.GROUP_ITEM:
        isGroup = true
        break
      case PROP.GROUP_ITEM_FLAGS:
        expanded = (propU32(r, p) & 1) !== 0
        break
      case PROP.ITEM_PATH:
        path = propItemPath(r, p)
        break
      case PROP.COLOR_TAG:
        colorLabel = COLOR_TAG_HEX[propU32(r, p)]
        break
      case PROP.TEXT_LAYER_FLAGS:
        isText = true
        break
      case PROP.FLOATING_SELECTION:
        isFloatingSelection = true
        break
      case PROP.COMPOSITE_SPACE:
      case PROP.BLEND_SPACE:
        if (isLinearSpace(propI32(r, p))) linearSpace = true
        break
      case PROP.PARASITES:
        if (classifyParasites(readParasites(r, p.at, p.size)).isTextLayer) isText = true
        break
      case PROP.TRANSFORM:
        warn.warn(importWarn('xcf.deferred-transform-ignored'))
        break
      case PROP.LINK_LAYER:
        // The payload holds a FILESYSTEM PATH. It is never followed: that would be an
        // arbitrary-read primitive, and the fallback pixels are in the file anyway.
        warn.warn(importWarn('xcf.linked-layer-rasterized'))
        break
      default:
        break
    }
  })

  if (floatOpacity !== undefined && Number.isFinite(floatOpacity)) {
    // PROP_FLOAT_OPACITY takes precedence over the 0..255 integer form.
    opacity = Math.min(1, Math.max(0, floatOpacity)) * 100
  }
  if (linearSpace) warn.warn(importWarn('xcf.linear-blend-space'))
  if (isFloatingSelection) warn.warn(importWarn('xcf.floating-selection-as-layer', { name }))

  const hierarchyOffset = r.offset()
  const maskOffset = r.offset()

  // Non-destructive filter chain (v >= 20): a run of pointers terminated by 0. Layer has
  // no equivalent, and the stored pixels are UNFILTERED — a real visual loss to report.
  let effects = 0
  if (header.version >= 20) {
    for (let i = 0; i < 256; i++) {
      const eff = r.offset()
      if (eff === 0) break
      effects += 1
    }
  }

  const mapping = mapBlendMode(gimpMode)
  let blendMode: BlendMode = mapping.mode
  if (isGroup && gimpMode === GIMP_MODE_PASS_THROUGH) blendMode = 'pass-through'
  else if (!isGroup && blendMode === 'pass-through') blendMode = 'normal'

  const base = {
    name: name || (isGroup ? 'Group' : 'Layer'),
    visible,
    opacity,
    blendMode,
    locked,
    lockAlpha,
    lockPosition,
    colorLabel,
  }

  if (isGroup) {
    // A group carries no usable pixel buffer: GIMP skips reading it, because the tile
    // extent of a group does not match its declared size.
    const node: MutableGroup = {
      kind: 'group',
      node: { ...base, expanded, passThrough: gimpMode === GIMP_MODE_PASS_THROUGH },
      children: [],
    }
    return {
      node,
      path,
      meta: {
        approximated: mapping.approximated,
        gimpName: mapping.gimpName,
        isText: false,
        effects,
        outOfRange: false,
      },
    }
  }

  if (lw <= 0 || lh <= 0) {
    warn.warn(importWarn('xcf.empty-layer', { name }))
    return null
  }

  const reader = componentReader(header.precision)
  const cfg: PixelConfig = {
    base: type.base,
    hasAlpha: type.hasAlpha,
    components: type.components,
    reader,
    componentsBigEndian: header.componentsBigEndian,
    palette: info.palette,
  }

  const pixels = new Uint8ClampedArray(header.width * header.height * 4)
  if (hierarchyOffset !== 0 && r.validOffset(hierarchyOffset, 0)) {
    await decodeHierarchy(
      r,
      hierarchyOffset,
      info.compression,
      bytesPerPixel(cfg),
      warn,
      rgbaTileSink(pixels, header.width, header.height, offX, offY, cfg),
    )
  }

  let mask: { data: Uint8ClampedArray; enabled: boolean; inverted: boolean } | undefined
  if (maskOffset !== 0 && r.validOffset(maskOffset, 0)) {
    mask = await readLayerMask(r, header, info, maskOffset, offX, offY, applyMask, warn)
  }

  const node: MutableNode = {
    kind: 'raster',
    node: {
      ...base,
      pixels: { kind: 'rgba8', data: pixels, width: header.width, height: header.height },
      ...(mask ? { mask } : {}),
    },
  }
  return {
    node,
    path,
    meta: {
      approximated: mapping.approximated,
      gimpName: mapping.gimpName,
      isText,
      effects,
      outOfRange: reader.state.outOfRange,
    },
  }
}

/**
 * A layer mask has exactly a channel's structure: dimensions, name, properties, then one
 * hierarchy of a single grey component at the image's precision.
 *
 * Areas the mask does not cover stay 0 (fully masked), which is how GIMP renders them.
 * XCF has no "inverted mask" concept, so `inverted` is always false.
 */
async function readLayerMask(
  r: XcfReader,
  header: XcfHeader,
  info: ImageInfo,
  maskOffset: number,
  offX: number,
  offY: number,
  applyMask: boolean,
  warn: ImportWarningSink,
): Promise<{ data: Uint8ClampedArray; enabled: boolean; inverted: boolean } | undefined> {
  try {
    r.pos = maskOffset
    const mw = r.u32()
    const mh = r.u32()
    r.string() // mask name
    let enabled = applyMask
    readPropList(r, warn, (p) => {
      if (p.type === PROP.APPLY_MASK) enabled = propBool(r, p)
    })
    const hierarchyOffset = r.offset()
    if (mw <= 0 || mh <= 0 || hierarchyOffset === 0 || !r.validOffset(hierarchyOffset, 0)) return undefined

    const reader = componentReader(header.precision)
    const data = new Uint8ClampedArray(header.width * header.height)
    await decodeHierarchy(
      r,
      hierarchyOffset,
      info.compression,
      reader.bytes,
      warn,
      maskTileSink(data, header.width, header.height, offX, offY, reader, header.componentsBigEndian),
    )
    return { data, enabled, inverted: false }
  } catch {
    warn.warn(importWarn('xcf.mask-unreadable'))
    return undefined
  }
}

function stripExtension(name: string | undefined): string {
  if (!name) return ''
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(0, i) : name
}

export type { ImportedNode }
