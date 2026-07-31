// Non-fatal diagnostics collected while reading a document.
//
// Reading NEVER throws. A malformed document yields a best-effort tree plus a
// list of warnings: losing a layer is bad, refusing to open the document is
// worse. The UI surfaces these in a dismissible banner, never a modal.

export type WarningLevel = 'debug' | 'warn' | 'error'

export interface MigrationWarning {
  level: WarningLevel
  /** Stable machine-readable code, safe to switch on and to translate. */
  code: string
  /** English developer-facing detail. The UI translates from `code`. */
  message: string
  /** Layer this warning is about, when applicable. */
  layerId?: string
  /** Dotted path inside the node, e.g. `layerMask.density`. */
  field?: string
}

/** Accumulator threaded through the whole parse. Cheap, never throws. */
export class WarningSink {
  readonly items: MigrationWarning[] = []
  private capped = false
  /** Hard cap: a pathological document must not produce a million warnings. */
  private readonly max: number

  // Explicit field assignment, not a TypeScript parameter property: the model
  // must run under Node's type-stripping loader, which rejects that syntax.
  constructor(max = 500) { this.max = max }

  add(level: WarningLevel, code: string, message: string, layerId?: string, field?: string): void {
    if (this.items.length >= this.max) {
      if (!this.capped) {
        this.capped = true
        this.items.push({
          level: 'warn',
          code: 'warnings.truncated',
          message: `More than ${this.max} issues; further warnings suppressed.`,
        })
      }
      return
    }
    const w: MigrationWarning = { level, code, message }
    if (layerId !== undefined) w.layerId = layerId
    if (field !== undefined) w.field = field
    this.items.push(w)
  }

  debug(code: string, message: string, layerId?: string, field?: string): void {
    this.add('debug', code, message, layerId, field)
  }

  warn(code: string, message: string, layerId?: string, field?: string): void {
    this.add('warn', code, message, layerId, field)
  }

  error(code: string, message: string, layerId?: string, field?: string): void {
    this.add('error', code, message, layerId, field)
  }

  get hasErrors(): boolean { return this.items.some(w => w.level === 'error') }
}
