// The migration cascade, applied to RAW nodes before they are typed.
//
// One-way and idempotent: `migrateNode(migrateNode(n))` equals `migrateNode(n)`.
// Migrations are never skipped and never removed — a document written in 2026
// must still open in 2036.
//
// A migration NEVER deletes a field it does not understand: `data` /
// `mask_data` in particular are left in place, so that the pixel payload of a
// v1 document survives even if the caller has no TileStore wired up yet.

import { asBlendMode } from '../../blend/modes.ts'
import type { RectI } from '../types.ts'
import { MAT_IDENTITY } from '../types.ts'
import { isRecord, nearestColorLabel, pctToByte, readNumber, type RawNode } from './coerce.ts'
import { NODE_SCHEMA_VERSION } from './version.ts'
import type { WarningSink } from './warnings.ts'

export interface MigrationCtx {
  sink: WarningSink
  /** Document bounds, used to give migrated surfaces a sane extent. */
  docBounds: RectI
}

export interface Migration {
  from: number
  to: number
  run: (n: RawNode, ctx: MigrationCtx) => RawNode
}

/** Deterministic surface id for a v1 layer, so a re-migration finds the same
 *  tiles. Never random: two migrations of the same file must agree. */
export function legacySurfaceId(layerId: string): string {
  return `s_${layerId}`
}

/**
 * v0 -> v1. "v0" is any node written before this spec existed: same shape as
 * v1, simply without a node-level `schemaVersion`. The only real work is
 * normalising the two shapes the old editor could produce.
 */
function migrateLegacyUnversioned(n: RawNode, ctx: MigrationCtx): RawNode {
  const out: RawNode = { ...n, schemaVersion: 1 }

  if (typeof out.id !== 'string' || out.id === '') {
    // A node without an id cannot be addressed; `fromWire` mints one and warns.
    ctx.sink.warn('node.noId', 'Layer without an id; a new one will be assigned')
  }

  // A node carrying children is a group, whatever `type` claims.
  if (Array.isArray(out.children) && out.type !== 'group') {
    ctx.sink.warn('node.promotedToGroup', `Node of type "${String(out.type)}" has children; promoted to group`,
      typeof out.id === 'string' ? out.id : undefined)
    out.type = 'group'
  }
  if (out.type === 'group' && !Array.isArray(out.children)) out.children = []
  if (typeof out.type !== 'string') out.type = 'raster'
  return out
}

/**
 * v1 -> v2. Documented field by field in spec 11.5.
 *
 * The single most dangerous line of this whole file is the group blend mode.
 * In v1 EVERY group is composited in isolation (the old `compositeInto` always
 * allocated an isolated framebuffer pair). The v2 default for a *newly created*
 * group is `pass-through`. Migrating existing groups to `pass-through` would
 * silently change the rendering of every document that contains a group with a
 * non-Normal child. So: migrated groups get `blendMode: 'normal'`, i.e. they
 * stay isolated, and the rendering is strictly preserved.
 */
function migrateV1toV2(n: RawNode, ctx: MigrationCtx): RawNode {
  const out: RawNode = { ...n, schemaVersion: 2 }
  const id = typeof n.id === 'string' ? n.id : undefined

  // 1. type -> kind. v1 only ever wrote four types.
  const t = typeof n.type === 'string' ? n.type : 'raster'
  out.kind = t === 'group' ? 'group'
    : t === 'adjustment' ? 'adjustment'
    : t === 'text' ? 'text'
    : 'raster'

  // 2. Locks: three flat booleans -> one object.
  out.locks = {
    all: n.locked === true,
    transparency: n.lockAlpha === true,
    pixels: false,            // never existed in v1
    position: n.lockPosition === true,
    nesting: false,
  }

  // 3. Opacity: v1 stores 0..100. The canonical 0..255 value travels under a
  //    NEW name; the old one keeps its old meaning forever.
  out.opacity255 = pctToByte(readNumber(n.opacity, 100))
  out.fillOpacity255 = pctToByte(readNumber(n.fill, 100))

  // 4. Mask. In v1, `mask.layerId` was a TEXTURE key, never a tree node id.
  //    It becomes the surface id, which is exactly what it always was.
  if (isRecord(n.mask) && typeof n.mask.layerId === 'string') {
    out.layerMask = {
      surface: { surfaceId: n.mask.layerId, bounds: { ...ctx.docBounds }, version: 0 },
      enabled: n.mask.enabled !== false,
      inverted: n.mask.inverted === true,
      linked: true,           // v1 had no unlink; Photoshop's default is linked
      density: 255,
      feather: 0,
      outsideValue: 255,
      previewAsRubylith: false,
      rubylithColor: { r: 255, g: 0, b: 0, a: 128 },
    }
  } else {
    out.layerMask = null
  }
  out.vectorMask = null

  // 5. Pixels leave the tree. The surface id is derived from the layer id so
  //    that the (later) extraction pass is idempotent. `data` / `mask_data`
  //    stay in the node until the TileStore has confirmed the write — belt and
  //    braces, per spec 11.6 phase 0.
  if (out.kind === 'raster' && id) {
    out.surface = { surfaceId: legacySurfaceId(id), bounds: { ...ctx.docBounds }, version: 0 }
    out.isBackground = n.name === 'Fond'
  }

  // 6. Colour label: free-form hex -> nearest named label.
  out.colorTag = nearestColorLabel(n.colorLabel)

  // 7. Styles. `effects: unknown[]` was declared but never populated by any
  //    released build. Anything present is kept verbatim by `fromWire`, which
  //    stashes a non-empty `effects` array into `_unknown`.
  out.styles = null

  // 8. Blend mode: v1 ids map 1:1 onto v2 ids.
  const bm = typeof n.blendMode === 'string' ? n.blendMode : 'normal'
  const mapped = asBlendMode(bm)
  if (mapped !== bm) {
    ctx.sink.warn('blend.unknown', `Unknown blend mode "${bm}", falling back to normal`, id, 'blendMode')
  }
  out.blendMode = mapped

  // 9. New fields, with the defaults that preserve v1 rendering.
  out.linkGroup = null
  const x = readNumber(n.x, 0)
  const y = readNumber(n.y, 0)
  out.transform = [MAT_IDENTITY[0], MAT_IDENTITY[1], MAT_IDENTITY[2], MAT_IDENTITY[3], x, y]

  if (out.kind === 'group') {
    // See the comment above: isolated, NOT pass-through.
    out.blendMode = mapped === 'pass-through' ? 'normal' : mapped
    out.isolated = true
    out.knockout = 'none'
  }

  return out
}

export const MIGRATIONS: readonly Migration[] = [
  { from: 0, to: 1, run: migrateLegacyUnversioned },
  { from: 1, to: 2, run: migrateV1toV2 },
  // v3, v4… are appended here. Never a jump, never a deletion.
]

/** Runs the cascade from whatever version the node claims up to the current one. */
export function migrateNode(n: RawNode, ctx: MigrationCtx): RawNode {
  let v = typeof n.schemaVersion === 'number' && Number.isFinite(n.schemaVersion)
    ? Math.floor(n.schemaVersion)
    : 0
  let out = n
  for (const m of MIGRATIONS) {
    if (m.from >= v) {
      out = m.run(out, ctx)
      v = m.to
    }
  }
  if (v < NODE_SCHEMA_VERSION) {
    ctx.sink.debug('node.stale', `Node left at schema v${v}`, typeof n.id === 'string' ? n.id : undefined)
  }
  return out
}

/** True when the node needs work — used to decide whether a rewrite is due. */
export function nodeNeedsUpgrade(n: RawNode): boolean {
  const v = typeof n.schemaVersion === 'number' ? n.schemaVersion : 0
  return v < NODE_SCHEMA_VERSION
}
