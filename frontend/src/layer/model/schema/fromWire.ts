// Reading: raw JSON -> typed `Layer` tree.
//
// Contract: NEVER throws. A malformed document yields a best-effort tree plus
// warnings. Losing one layer is bad; refusing to open the document is worse.

import { asBlendMode } from '../../blend/modes.ts'
import {
  WHITE,
  createRasterLayer,
  defaultAdjustment,
  defaultFillContent,
  defaultTextData,
  emptyPath,
  emptySurface,
} from '../ops/defaults.ts'
import { newLayerId } from '../ops/ids.ts'
import type {
  ArtboardLayer,
  FillLayer,
  GroupLayer,
  Layer,
  LayerBase,
  LayerColorLabel,
  LayerId,
  LayerKind,
  RasterLayer,
  RectI,
  ShapeLayer,
  SmartObjectLayer,
  TextLayer,
} from '../types.ts'
import { LAYER_KINDS } from '../types.ts'
import {
  isRecord,
  nearestColorLabel,
  pctToByte,
  readArray,
  readBool,
  readColor,
  readEnum,
  readInt,
  readMat2x3,
  readNumber,
  readRect,
  readString,
  type Ctx,
  type RawNode,
} from './coerce.ts'
import { legacySurfaceId, migrateNode, type MigrationCtx } from './migrate.ts'
import {
  readAdjustment,
  readFillContent,
  readLayerMask,
  readLiveShape,
  readSmartFilters,
  readStyleStack,
  readSurfaceRef,
  readTextData,
  readVectorMask,
  readVectorPath,
  readVectorStroke,
} from './parts.ts'
import { consumedKeys } from './version.ts'
import { WarningSink } from './warnings.ts'

/** Marker used to carry a layer kind this build does not know about. */
export const UNKNOWN_KIND_KEY = '__unknownKind'

export interface ReadCtx extends MigrationCtx {
  /** Ids already used in this document; drives duplicate detection. */
  seenIds: Set<string>
  /** Old id -> new id, for the duplicates we had to reassign. */
  remapped: Map<string, string>
}

export function makeReadCtx(docBounds: RectI, sink = new WarningSink()): ReadCtx {
  return { sink, docBounds, seenIds: new Set(), remapped: new Map() }
}

function stashUnknown(raw: RawNode, kind: string): Record<string, unknown> | undefined {
  const consumed = consumedKeys(kind)
  let out: Record<string, unknown> | undefined
  for (const k of Object.keys(raw)) {
    if (consumed.has(k)) continue
    if (raw[k] === undefined) continue
    ;(out ??= {})[k] = raw[k]
  }
  // `effects` is consumed (v1 mirror) but was never populated by any released
  // build. If something IS there, keep it: it belongs to someone.
  const eff = readArray(raw.effects)
  if (eff && eff.length > 0) (out ??= {}).effects = eff
  return out
}

/** Unique id, reassigning duplicates instead of letting two nodes collide. */
function readId(raw: RawNode, ctx: ReadCtx): LayerId {
  const raw_id = typeof raw.id === 'string' && raw.id !== '' ? raw.id : null
  if (raw_id === null) {
    const id = newLayerId()
    ctx.seenIds.add(id)
    ctx.sink.warn('node.noId', 'Layer without an id; a new one was assigned')
    return id
  }
  if (ctx.seenIds.has(raw_id)) {
    const id = newLayerId()
    ctx.seenIds.add(id)
    ctx.remapped.set(raw_id, id)
    ctx.sink.warn('node.duplicateId', `Duplicate layer id "${raw_id}"; reassigned`, raw_id)
    return id
  }
  ctx.seenIds.add(raw_id)
  return raw_id as LayerId
}

function readKind(raw: RawNode, ctx: ReadCtx, id: string): { kind: LayerKind; unknown: string | null } {
  const stashed = raw[UNKNOWN_KIND_KEY]
  const declared = typeof raw.kind === 'string' ? raw.kind
    : typeof stashed === 'string' ? stashed
    : typeof raw.type === 'string' ? raw.type
    : 'raster'
  if ((LAYER_KINDS as readonly string[]).includes(declared)) {
    return { kind: declared as LayerKind, unknown: null }
  }
  ctx.sink.warn(
    'node.unknownKind',
    `Unknown layer kind "${declared}"; kept as a locked empty raster layer so it survives a round trip`,
    id, 'kind',
  )
  return { kind: 'raster', unknown: declared }
}

function readBase(raw: RawNode, kind: string, id: LayerId, ctx: ReadCtx): LayerBase {
  const c: Ctx = { sink: ctx.sink, layerId: id }

  // Opacity: prefer the exact 0..255 value; fall back to the v1 percentage.
  const opacity = raw.opacity255 !== undefined
    ? readInt(raw.opacity255, 0, 255, 255, c, 'opacity255')
    : pctToByte(readNumber(raw.opacity, 100, c, 'opacity'))
  const fillOpacity = raw.fillOpacity255 !== undefined
    ? readInt(raw.fillOpacity255, 0, 255, 255, c, 'fillOpacity255')
    : pctToByte(readNumber(raw.fill, 100, c, 'fill'))

  const locksRaw = isRecord(raw.locks) ? raw.locks : {}
  const colorTag: LayerColorLabel = raw.colorTag !== undefined
    ? nearestColorLabel(raw.colorTag)
    : nearestColorLabel(raw.colorLabel)

  const stash = stashUnknown(raw, kind)

  const base: LayerBase = {
    id,
    schemaVersion: readInt(raw.schemaVersion, 0, 1e6, 0, c, 'schemaVersion'),
    name: readString(raw.name, '', c, 'name'),
    visible: readBool(raw.visible, true),
    opacity,
    fillOpacity,
    blendMode: asBlendMode(typeof raw.blendMode === 'string' ? raw.blendMode : undefined),
    clipping: readBool(raw.clipping, false),
    layerMask: raw.layerMask !== undefined
      ? readLayerMask(raw.layerMask, ctx.docBounds, c)
      : null,
    vectorMask: readVectorMask(raw.vectorMask, c),
    styles: readStyleStack(raw.styles, c),
    smartFilters: readSmartFilters(raw.smartFilters, ctx.docBounds, c),
    locks: {
      transparency: readBool(locksRaw.transparency, raw.lockAlpha === true),
      pixels: readBool(locksRaw.pixels, false),
      position: readBool(locksRaw.position, raw.lockPosition === true),
      nesting: readBool(locksRaw.nesting, false),
      all: readBool(locksRaw.all, raw.locked === true),
    },
    colorLabel: colorTag,
    linkGroup: typeof raw.linkGroup === 'string' ? raw.linkGroup : null,
    transform: readMat2x3(raw.transform),
  }
  if (stash) base._unknown = stash
  return base
}

/** Reads one node (and its subtree). Total: always returns a layer. */
export function fromWire(rawIn: unknown, ctx: ReadCtx, depth = 0): Layer {
  if (!isRecord(rawIn)) {
    ctx.sink.error('node.notAnObject', 'Layer entry is not an object; replaced by an empty raster layer')
    return createRasterLayer(ctx.docBounds, { name: '' })
  }
  if (depth > 64) {
    // Cut the branch, but keep the node's identity so a re-read is stable.
    ctx.sink.error('tree.tooDeep', 'Layer nesting deeper than 64; the branch was cut')
    const cutId = typeof rawIn.id === 'string' && rawIn.id !== '' ? (rawIn.id as LayerId) : newLayerId()
    ctx.seenIds.add(cutId)
    return createRasterLayer(ctx.docBounds, {
      id: cutId,
      name: readString(rawIn.name, '', undefined, 'name'),
      surfaceId: legacySurfaceId(cutId),
    })
  }

  const raw = migrateNode(rawIn, ctx)
  const id = readId(raw, ctx)
  const { kind, unknown } = readKind(raw, ctx, id)
  const c: Ctx = { sink: ctx.sink, layerId: id }
  const base = readBase(raw, unknown ?? kind, id, ctx)

  if (unknown !== null) {
    // Keep the original discriminator so a client that understands it can read
    // the node back, and lock the degraded stand-in so nothing edits it.
    base._unknown = { ...(base._unknown ?? {}), [UNKNOWN_KIND_KEY]: unknown }
    base.locks = { ...base.locks, all: true }
    const layer: RasterLayer = {
      ...base, kind: 'raster',
      surface: emptySurface(ctx.docBounds, legacySurfaceId(id)),
      isBackground: false,
    }
    return layer
  }

  switch (kind) {
    case 'group': {
      const children = readChildren(raw, ctx, depth)
      const g: GroupLayer = {
        ...base, kind: 'group', children,
        expanded: readBool(raw.expanded, true),
        isolated: readBool(raw.isolated, base.blendMode !== 'pass-through'),
        knockout: readEnum(raw.knockout, ['none', 'shallow', 'deep'] as const, 'none', c, 'knockout'),
      }
      return g
    }
    case 'artboard': {
      const children = readChildren(raw, ctx, depth)
      const bgRaw = isRecord(raw.background) ? raw.background : {}
      const a: ArtboardLayer = {
        ...base, kind: 'artboard', children,
        frame: readRect(raw.frame, ctx.docBounds, c, 'frame'),
        expanded: readBool(raw.expanded, true),
        background: readEnum(bgRaw.type, ['transparent', 'solid'] as const, 'solid', c, 'background.type') === 'transparent'
          ? { type: 'transparent' }
          : { type: 'solid', color: readColor(bgRaw.color, WHITE, c, 'background.color') },
        presetName: typeof raw.presetName === 'string' ? raw.presetName : null,
      }
      return a
    }
    case 'adjustment': {
      const spec = readAdjustment(raw.adjustment, c)
      if (!spec && raw.adjustment !== undefined && raw.adjustment !== null) {
        // Unreadable payload: keep it aside rather than dropping it silently.
        base._unknown = { ...(base._unknown ?? {}), adjustment_legacy: raw.adjustment }
        ctx.sink.warn('adjustment.unreadable', 'Adjustment payload not understood; a neutral Curves was substituted', id, 'adjustment')
      }
      return { ...base, kind: 'adjustment', adjustment: spec ?? defaultAdjustment('curves') }
    }
    case 'fill': {
      const f: FillLayer = {
        ...base, kind: 'fill',
        fill: raw.fillContent !== undefined ? readFillContent(raw.fillContent, c) : defaultFillContent(),
      }
      return f
    }
    case 'text': {
      const t: TextLayer = {
        ...base, kind: 'text',
        text: raw.text !== undefined ? readTextData(raw.text, c) : defaultTextData(),
        raster: readSurfaceRef(raw.raster, ctx.docBounds, c),
      }
      return t
    }
    case 'shape': {
      const s: ShapeLayer = {
        ...base, kind: 'shape',
        path: raw.path !== undefined ? readVectorPath(raw.path, c) : emptyPath(),
        fill: raw.shapeFill !== undefined && raw.shapeFill !== null ? readFillContent(raw.shapeFill, c) : null,
        stroke: readVectorStroke(raw.shapeStroke, c),
        liveShape: readLiveShape(raw.liveShape, c),
        raster: readSurfaceRef(raw.raster, ctx.docBounds, c),
      }
      return s
    }
    case 'smartObject': {
      const srcRaw = isRecord(raw.source) ? raw.source : {}
      const sizeRaw = isRecord(raw.sourceSize) ? raw.sourceSize : {}
      const so: SmartObjectLayer = {
        ...base, kind: 'smartObject',
        source: readEnum(srcRaw.type, ['embedded', 'linked'] as const, 'embedded', c, 'source.type') === 'linked'
          ? { type: 'linked', fileId: readString(srcRaw.fileId, '', c, 'source.fileId') }
          : { type: 'embedded', contentId: readString(srcRaw.contentId, '', c, 'source.contentId') },
        sourceSize: {
          w: readNumber(sizeRaw.w, ctx.docBounds.w, c, 'sourceSize.w'),
          h: readNumber(sizeRaw.h, ctx.docBounds.h, c, 'sourceSize.h'),
        },
        interpolation: readEnum(
          raw.interpolation,
          ['nearest', 'bilinear', 'bicubic', 'bicubicSharper', 'bicubicSmoother'] as const,
          'bicubic', c, 'interpolation',
        ),
        raster: readSurfaceRef(raw.raster, ctx.docBounds, c),
      }
      return so
    }
    case 'raster':
    default: {
      const surface = readSurfaceRef(raw.surface, ctx.docBounds, c)
      const r: RasterLayer = {
        ...base, kind: 'raster',
        surface: surface ?? emptySurface(ctx.docBounds, legacySurfaceId(id)),
        isBackground: readBool(raw.isBackground, false),
      }
      return r
    }
  }
}

function readChildren(raw: RawNode, ctx: ReadCtx, depth: number): Layer[] {
  const arr = readArray(raw.children)
  if (!arr) return []
  const out: Layer[] = []
  for (const child of arr) out.push(fromWire(child, ctx, depth + 1))
  return out
}

/** Convenience: the legacy inline pixel payload, if the document still has one. */
export function legacyPixelData(l: Layer): { data?: string; maskData?: string } {
  const u = l._unknown
  if (!u) return {}
  const out: { data?: string; maskData?: string } = {}
  if (typeof u.data === 'string') out.data = u.data
  if (typeof u.mask_data === 'string') out.maskData = u.mask_data
  return out
}
