// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Typed import errors (spec 07 §10.1).
//
// Rule: an exotic decoder never lets a bare `Error`, a `TypeError` from an out-of-bounds
// read or an unhandled rejection escape. Everything the user can see carries an i18n key
// and an actionable message; the technical `detail` is for the console and the support
// "Details" disclosure, never rendered raw.

import { IoError as RasterIoError, IoLimitError, IoTruncatedError } from '../formats/types'

export type ImportErrorCode =
  /** No descriptor matched the bytes. */
  | 'unknown-format'
  /** Recognised, but decoding is deliberately not implemented (CRW, X3F, fractal XCF). */
  | 'unsupported-format'
  /** The file ends in the middle of a structure. */
  | 'truncated'
  /** Structurally invalid beyond what tolerance can absorb. */
  | 'corrupt'
  /** An optional decoder plug-in is absent, or the machine is out of memory. */
  | 'decoder-unavailable'
  /** The browser itself cannot decode this (HEIC outside Apple platforms). */
  | 'capability-missing'
  /** Past the pixel/memory budget and the user declined to flatten or downscale. */
  | 'too-large'
  | 'cancelled'

export class ImportError extends Error {
  readonly code: ImportErrorCode
  readonly i18nKey: string
  readonly params?: Record<string, string | number>
  /** Technical detail for the console. NEVER shown raw to the user. */
  readonly detail?: string

  constructor(
    code: ImportErrorCode,
    i18nKey: string,
    params?: Record<string, string | number>,
    detail?: string,
  ) {
    super(`${code}: ${i18nKey}${detail ? ` (${detail})` : ''}`)
    this.name = 'ImportError'
    this.code = code
    this.i18nKey = i18nKey
    this.params = params
    this.detail = detail
  }
}

export function isImportError(e: unknown): e is ImportError {
  return e instanceof ImportError
}

/**
 * Funnels anything thrown by a decoder into an `ImportError`.
 *
 * The bounds-checked reader of `layer/io/formats` already raises typed errors; those map
 * one-to-one. Everything else becomes `corrupt`, because an unexpected throw inside a
 * parser means the bytes did not describe what they claimed to.
 */
export function toImportError(e: unknown, fallbackDetail?: string): ImportError {
  if (e instanceof ImportError) return e
  if (e instanceof IoTruncatedError) {
    return new ImportError('truncated', 'layer.io.err.truncated', undefined, e.message)
  }
  if (e instanceof IoLimitError) {
    return new ImportError('too-large', 'layer.io.err.too_large', undefined, e.message)
  }
  if (e instanceof RasterIoError) {
    return new ImportError('corrupt', 'layer.io.err.corrupt', undefined, `${e.code}: ${e.message}`)
  }
  if (e instanceof DOMException && e.name === 'AbortError') {
    return new ImportError('cancelled', 'layer.io.err.cancelled')
  }
  const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
  return new ImportError('corrupt', 'layer.io.err.corrupt', undefined, fallbackDetail ?? detail)
}

/** Throws `cancelled` if the caller aborted. Called at every coarse decoding step. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ImportError('cancelled', 'layer.io.err.cancelled')
}
