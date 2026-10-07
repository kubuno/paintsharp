// Writing: typed `Layer` tree -> raw JSON, with dual v1 + v2 emission.
//
// Two guarantees, both load-bearing:
//
//   1. Backward: while `dualEmit` is on, every node also carries the v1 fields.
//      A build from before this change opens a v2 document and sees a degraded
//      but coherent picture (rasters, groups, masks and opacities all work).
//   2. Forward: `_unknown` is spliced back in FIRST, so keys written by a newer
//      client survive an older client's read-edit-write cycle untouched.

import type {
  ArtboardLayer,
  FillLayer,
  GroupLayer,
  Layer,
  RasterLayer,
  ShapeLayer,
  SmartObjectLayer,
  TextLayer,
} from '../types.ts'
import { byteToPct, colorLabelToHex, type RawNode } from './coerce.ts'
import { UNKNOWN_KIND_KEY } from './fromWire.ts'
import { NODE_SCHEMA_VERSION } from './version.ts'

export interface WriteOptions {
  /**
   * Emit the v1 mirror fields alongside the v2 canonical ones. On by default
   * for two minor releases (see `DUAL_EMIT_SUNSET`).
   */
  dualEmit?: boolean
}

/** v1 only knew four types; map every newer kind onto its closest ancestor. */
function legacyType(kind: Layer['kind']): string {
  switch (kind) {
    case 'group': case 'artboard': return 'group'
    case 'adjustment': return 'adjustment'
    case 'text': return 'text'
    default: return 'raster'      // raster, fill, shape, smartObject
  }
}

export function toWire(node: Layer, opts: WriteOptions = {}): RawNode {
  const dual = opts.dualEmit !== false
  const unknownKind = typeof node._unknown?.[UNKNOWN_KIND_KEY] === 'string'
    ? (node._unknown[UNKNOWN_KIND_KEY] as string)
    : null

  // 1. Forward compatibility first: unknown keys, then our own fields on top.
  const out: RawNode = { ...(node._unknown ?? {}) }
  delete out[UNKNOWN_KIND_KEY]

  // 2. v2 canonical fields.
  out.id = node.id
  out.schemaVersion = Math.max(node.schemaVersion, NODE_SCHEMA_VERSION)
  out.kind = unknownKind ?? node.kind
  out.name = node.name
  out.visible = node.visible
  out.opacity255 = node.opacity
  out.fillOpacity255 = node.fillOpacity
  out.blendMode = node.blendMode
  out.clipping = node.clipping
  out.layerMask = node.layerMask
  out.vectorMask = node.vectorMask
  out.styles = node.styles
  out.smartFilters = node.smartFilters
  out.locks = node.locks
  out.colorTag = node.colorLabel
  out.linkGroup = node.linkGroup
  out.transform = node.transform

  // 3. v1 mirror. `opacity` and `fill` KEEP their v1 unit (0..100): an older
  //    client reading `opacity: 255` would display "255 %".
  if (dual) {
    out.type = legacyType(node.kind)
    out.opacity = byteToPct(node.opacity)
    out.fill = byteToPct(node.fillOpacity)
    out.locked = node.locks.all
    out.lockAlpha = node.locks.transparency
    out.lockPosition = node.locks.position
    out.mask = node.layerMask
      ? {
          enabled: node.layerMask.enabled,
          inverted: node.layerMask.inverted,
          layerId: node.layerMask.surface.surfaceId,
        }
      : null
    const hex = colorLabelToHex(node.colorLabel)
    if (hex !== undefined) out.colorLabel = hex
    out.x = node.transform[4]
    out.y = node.transform[5]
    // `effects` is required by the v1 type. Never clobber a spliced value.
    if (out.effects === undefined) out.effects = []
  }

  // 4. Kind-specific payload. A node whose kind this build does not understand
  //    keeps ONLY the forwarded keys: writing our stand-in raster fields would
  //    pollute it (and break the round-trip invariant).
  if (unknownKind === null) writeKindPayload(out, node, opts)

  return out
}

function writeKindPayload(out: RawNode, node: Layer, opts: WriteOptions): void {
  switch (node.kind) {
    case 'raster': {
      const l = node as RasterLayer
      out.surface = l.surface
      out.isBackground = l.isBackground
      break
    }
    case 'group': {
      const l = node as GroupLayer
      out.children = l.children.map(c => toWire(c, opts))
      out.expanded = l.expanded
      out.isolated = l.isolated
      out.knockout = l.knockout
      break
    }
    case 'artboard': {
      const l = node as ArtboardLayer
      out.children = l.children.map(c => toWire(c, opts))
      out.expanded = l.expanded
      out.frame = l.frame
      out.background = l.background
      out.presetName = l.presetName
      break
    }
    case 'adjustment':
      out.adjustment = node.adjustment
      break
    case 'fill': {
      // NOT `fill`: that name is taken by the v1 fill-opacity percentage.
      const l = node as FillLayer
      out.fillContent = l.fill
      break
    }
    case 'text': {
      const l = node as TextLayer
      out.text = l.text
      out.raster = l.raster
      break
    }
    case 'shape': {
      const l = node as ShapeLayer
      out.path = l.path
      out.shapeFill = l.fill
      out.shapeStroke = l.stroke
      out.liveShape = l.liveShape
      out.raster = l.raster
      break
    }
    case 'smartObject': {
      const l = node as SmartObjectLayer
      out.source = l.source
      out.sourceSize = l.sourceSize
      out.interpolation = l.interpolation
      out.raster = l.raster
      break
    }
  }
}

/** Whole tree. The result is always a JSON ARRAY, as the backend requires. */
export function treeToWire(tree: readonly Layer[], opts: WriteOptions = {}): RawNode[] {
  return tree.map(n => toWire(n, opts))
}
