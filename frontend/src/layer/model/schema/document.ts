// Document-level parse and serialise.
//
// The `.kblay` envelope, as written today and as written after this change:
//
//   {
//     "version": 1,               <- envelope, UNCHANGED (Rust + old clients)
//     "schemaVersion": 2,         <- NEW: version of the layer model
//     "layers_structure": [ ... ] <- still a JSON ARRAY at the top level
//     "view_settings": { ... },
//     "command_history": []
//   }
//
// `layers_structure` staying an array is not cosmetic: `save_structure` in
// `src/handlers/layer_docs.rs` derives `layer_count` from
// `body.layers_structure.as_array().map(|a| a.len())`. Wrapping the tree in an
// object silently collapses every document to `layer_count = 1`. The client
// also sends `layer_count` explicitly (the DTO already accepts it), but the
// array shape is kept anyway: an older client might omit the field.

import type { Layer, RectI } from '../types.ts'
import { isRecord, readArray, type RawNode } from './coerce.ts'
import { fromWire, makeReadCtx } from './fromWire.ts'
import { createRasterLayer } from '../ops/defaults.ts'
import { toWire, type WriteOptions } from './toWire.ts'
import { validateTree } from './validate.ts'
import { DOC_SCHEMA_VERSION, ENVELOPE_VERSION, NODE_SCHEMA_VERSION } from './version.ts'
import { WarningSink, type MigrationWarning } from './warnings.ts'

export interface ParseResult {
  tree: Layer[]
  /** Non-fatal issues, for a dismissible banner. Never a modal. */
  warnings: MigrationWarning[]
  /**
   * The document was upgraded IN MEMORY and would benefit from a rewrite.
   *
   * Opening a document must NOT rewrite it: the conversion is only persisted
   * when the user actually edits. `upgraded` is the flag the editor carries
   * until the first edit; see `shouldRewriteAfterEdit`.
   */
  upgraded: boolean
  /**
   * The file was written by a NEWER client. It is opened anyway, but automatic
   * rewriting is disabled so nothing is destroyed.
   */
  readOnly: boolean
  /** Schema version declared by the file (0 when absent). */
  fileSchemaVersion: number
  viewSettings: Record<string, unknown>
  /** Envelope keys we do not understand, preserved for serialisation. */
  envelopeExtras: Record<string, unknown>
}

/**
 * NEVER throws. A malformed document yields a best-effort tree plus warnings.
 */
export function parseDocument(raw: unknown, doc: { width: number; height: number }): ParseResult {
  const sink = new WarningSink()
  const docBounds: RectI = { x: 0, y: 0, w: doc.width, h: doc.height }
  const ctx = makeReadCtx(docBounds, sink)

  const envelope: RawNode = isRecord(raw) ? raw : {}
  if (!isRecord(raw)) {
    sink.error('doc.notAnObject', 'Document content is not a JSON object; opened as an empty document')
  }

  const fileSchemaVersion = typeof envelope.schemaVersion === 'number' && Number.isFinite(envelope.schemaVersion)
    ? Math.floor(envelope.schemaVersion)
    : 0
  const readOnly = fileSchemaVersion > DOC_SCHEMA_VERSION
  if (readOnly) {
    sink.warn(
      'doc.futureVersion',
      `Document schema v${fileSchemaVersion} is newer than this build (v${DOC_SCHEMA_VERSION}); automatic rewriting is disabled`,
    )
  }

  const rawLayers = readArray(envelope.layers_structure)
  if (!rawLayers) {
    sink.error('doc.noLayers', '"layers_structure" is missing or is not an array; opened with a single empty layer')
  }

  const parsed: Layer[] = (rawLayers ?? []).map(n => fromWire(n, ctx))
  const anyStale = (rawLayers ?? []).some(nodeIsStale)

  const validated = validateTree(
    parsed.length > 0 ? parsed : [createRasterLayer(docBounds, { name: 'Fond', isBackground: true })],
    docBounds,
  )
  for (const w of validated.warnings) sink.items.push(w)

  const envelopeExtras: Record<string, unknown> = {}
  for (const k of Object.keys(envelope)) {
    if (k === 'version' || k === 'schemaVersion' || k === 'layers_structure' || k === 'view_settings') continue
    envelopeExtras[k] = envelope[k]
  }

  return {
    tree: validated.tree,
    warnings: sink.items,
    upgraded: !readOnly && (fileSchemaVersion < DOC_SCHEMA_VERSION || anyStale || validated.repaired),
    readOnly,
    fileSchemaVersion,
    viewSettings: isRecord(envelope.view_settings) ? envelope.view_settings : {},
    envelopeExtras,
  }
}

function nodeIsStale(n: unknown): boolean {
  if (!isRecord(n)) return true
  const v = typeof n.schemaVersion === 'number' ? n.schemaVersion : 0
  if (v < NODE_SCHEMA_VERSION) return true
  const kids = readArray(n.children)
  return kids ? kids.some(nodeIsStale) : false
}

export interface SerializeOptions extends WriteOptions {
  viewSettings?: Record<string, unknown>
  /** Envelope keys carried over from `ParseResult.envelopeExtras`. */
  envelopeExtras?: Record<string, unknown>
}

export interface SerializedDocument {
  version: number
  schemaVersion: number
  layers_structure: RawNode[]
  view_settings: Record<string, unknown>
  [k: string]: unknown
}

export function serializeDocument(tree: readonly Layer[], opts: SerializeOptions = {}): SerializedDocument {
  const out: SerializedDocument = {
    // Unknown envelope keys first, so ours always win.
    ...(opts.envelopeExtras ?? {}),
    version: ENVELOPE_VERSION,
    schemaVersion: DOC_SCHEMA_VERSION,
    layers_structure: tree.map(n => toWire(n, opts)),
    view_settings: opts.viewSettings ?? {},
  }
  if (out.command_history === undefined) out.command_history = []
  return out
}

/**
 * `layer_count` as the backend would derive it, so the client can send it
 * explicitly instead of relying on the array length fallback.
 */
export function layerCountOf(tree: readonly Layer[]): number {
  return tree.length
}

/**
 * Rewriting policy. Opening a document is never a reason to write it back; a
 * silent rewrite on open is how a bad migration destroys a corpus before anyone
 * notices. The upgrade is persisted with the FIRST real edit.
 */
export function shouldRewriteAfterEdit(result: ParseResult): boolean {
  return !result.readOnly
}
