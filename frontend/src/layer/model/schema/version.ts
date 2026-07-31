// Schema versions and the key inventory that drives forward compatibility.
//
// Three independent version numbers coexist in a `.kblay` file:
//
//   `version`        the historical ENVELOPE version written since day one.
//                    The Rust backend never interprets it; older clients do.
//                    It stays at 1 forever so that an old build keeps opening
//                    the file.
//   `schemaVersion`  (document level) the version of the LAYER MODEL.
//   `schemaVersion`  (node level) same, per node, so a single layer kind can
//                    evolve without rewriting a whole document.
//
// Hard constraint from the backend audit: `layers_structure` MUST remain a JSON
// ARRAY at the top level. `save_structure` derives `layer_count` from
// `body.layers_structure.as_array().map(|a| a.len())`; wrapping the tree in an
// object would silently collapse every document to `layer_count = 1`.

/** Bumped when the on-disk shape changes in a way older readers cannot follow. */
export const DOC_SCHEMA_VERSION = 2

/** Bumped independently per node. Currently in step with the document version. */
export const NODE_SCHEMA_VERSION = 2

/** The envelope version. Frozen at 1: it is what old clients gate on. */
export const ENVELOPE_VERSION = 1

/**
 * Dual emission window. While `dualEmit` is on, every v2 node also carries the
 * v1 fields (`type`, `opacity` 0..100, `locked`, `mask`, ...) so a build from
 * before this change still renders the document. Planned to stay on for two
 * minor releases; flip the default to `false` only after telemetry shows no
 * client below that version is still opening documents.
 */
export const DUAL_EMIT_SUNSET = '0.3.0'

/**
 * Keys consumed by EVERY node kind.
 *
 * Anything not consumed for a given node is stashed verbatim into
 * `LayerBase._unknown` at parse time and spliced back at serialise time, so a
 * newer client's data is never destroyed by an older one. `data` and
 * `mask_data` are deliberately ABSENT: the legacy inline PNG payloads must
 * survive a round trip untouched until the TileStore owns the pixels (spec
 * 11.6, phase 0).
 *
 * Naming rule that the whole scheme rests on: NEVER change the meaning of an
 * existing field name. `opacity` and `fill` keep their v1 meaning (0..100); the
 * exact 0..255 values travel under the new names `opacity255` / `fillOpacity255`.
 * A fill layer's content is `fillContent`, NOT `fill`, for the same reason.
 */
export const BASE_NODE_KEYS: readonly string[] = [
  // Shared v1 + v2
  'id', 'name', 'visible', 'blendMode', 'clipping', 'effects',
  // v1 only (read, and re-emitted as a legacy mirror)
  'type', 'opacity', 'fill', 'locked', 'lockAlpha', 'lockPosition', 'mask',
  'colorLabel', 'x', 'y',
  // v2 canonical
  'schemaVersion', 'kind', 'opacity255', 'fillOpacity255', 'locks', 'layerMask',
  'vectorMask', 'styles', 'smartFilters', 'colorTag', 'linkGroup', 'transform',
]

/** Extra keys consumed per node kind. Anything else is forwarded untouched. */
export const KIND_NODE_KEYS: Readonly<Record<string, readonly string[]>> = {
  raster: ['surface', 'isBackground'],
  group: ['children', 'expanded', 'isolated', 'knockout'],
  adjustment: ['adjustment'],
  fill: ['fillContent'],
  text: ['text', 'raster'],
  shape: ['path', 'shapeFill', 'shapeStroke', 'liveShape', 'raster'],
  smartObject: ['source', 'sourceSize', 'interpolation', 'raster', 'smartFilters'],
  artboard: ['frame', 'children', 'expanded', 'background', 'presetName'],
}

/** Union of the above — the full inventory, for documentation and tests. */
export const KNOWN_KEYS: ReadonlySet<string> = new Set([
  ...BASE_NODE_KEYS,
  ...Object.values(KIND_NODE_KEYS).flat(),
])

/** Keys consumed for a given kind. An unknown kind consumes only the base set,
 *  so every kind-specific field of a future layer type is forwarded intact. */
export function consumedKeys(kind: string): ReadonlySet<string> {
  return new Set([...BASE_NODE_KEYS, ...(KIND_NODE_KEYS[kind] ?? [])])
}

/** Keys of the document envelope this client understands. */
export const KNOWN_DOC_KEYS: ReadonlySet<string> = new Set([
  'version', 'schemaVersion', 'layers_structure', 'view_settings', 'command_history',
])
