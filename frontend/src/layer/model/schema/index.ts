// Public surface of the persistence / migration layer.
//
// Everything outside `model/` goes through this barrel; the individual modules
// are implementation detail.

export {
  DOC_SCHEMA_VERSION,
  NODE_SCHEMA_VERSION,
  ENVELOPE_VERSION,
  DUAL_EMIT_SUNSET,
  BASE_NODE_KEYS,
  KIND_NODE_KEYS,
  KNOWN_KEYS,
  consumedKeys,
} from './version.ts'

export { WarningSink } from './warnings.ts'
export type { MigrationWarning, WarningLevel } from './warnings.ts'

export {
  byteToPct,
  pctToByte,
  nearestColorLabel,
  colorLabelToHex,
  parseHexColor,
  COLOR_LABEL_HEX,
} from './coerce.ts'
export type { RawNode } from './coerce.ts'

export { MIGRATIONS, migrateNode, legacySurfaceId, nodeNeedsUpgrade } from './migrate.ts'
export type { Migration, MigrationCtx } from './migrate.ts'

export { fromWire, makeReadCtx, legacyPixelData, UNKNOWN_KIND_KEY } from './fromWire.ts'
export type { ReadCtx } from './fromWire.ts'

export { toWire, treeToWire } from './toWire.ts'
export type { WriteOptions } from './toWire.ts'

export { validateTree } from './validate.ts'
export type { ValidateResult } from './validate.ts'

export {
  parseDocument,
  serializeDocument,
  layerCountOf,
  shouldRewriteAfterEdit,
} from './document.ts'
export type { ParseResult, SerializeOptions, SerializedDocument } from './document.ts'
