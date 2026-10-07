/*
 * PSD/PSB typed error surface.
 *
 * The binary layout and the decoding/encoding algorithms implemented in this
 * directory were derived from the GIMP PSD plug-in (file-psd), Copyright 2007
 * John Marshall, licensed under the GNU General Public License v3 or later, and
 * from Adobe's public "Photoshop File Formats Specification".
 *
 * This is an independent TypeScript re-implementation; no GIMP source code was
 * copied. Kubuno is distributed under the GNU Affero General Public License v3,
 * which is compatible with the GPLv3 (GPLv3 §13).
 */

/** Fatal error codes. Each one maps to an `layer_psd_error_<code>` i18n key. */
export type PsdErrorCode =
  | 'NOT_A_PSD'
  | 'BAD_VERSION'
  | 'BAD_HEADER'
  | 'BAD_DIMENSIONS'
  | 'BAD_DEPTH'
  | 'BAD_COLOR_MODE'
  | 'BAD_CHANNEL_COUNT'
  | 'BAD_DEPTH_FOR_MODE'
  | 'TOO_LARGE'
  | 'UNEXPECTED_EOF'
  | 'OUT_OF_MEMORY'
  | 'OUTPUT_TOO_LARGE'
  | 'UNSUPPORTED_COMPRESSION'
  | 'DESCRIPTOR_TOO_DEEP'
  | 'DESCRIPTOR_MALFORMED'
  | 'ZIP_UNAVAILABLE'

/**
 * The only error type this module throws. Anything recoverable is reported
 * through `PsdDocument.warnings` instead (see spec §9.4).
 */
export class PsdError extends Error {
  readonly code: PsdErrorCode
  readonly detail: Record<string, unknown> | undefined

  constructor(code: PsdErrorCode, detail?: Record<string, unknown>) {
    super(detail ? `PSD ${code}: ${safeJson(detail)}` : `PSD ${code}`)
    this.name = 'PsdError'
    this.code = code
    this.detail = detail
    // Keeps `instanceof` working when the class is transpiled down to ES5.
    Object.setPrototypeOf(this, PsdError.prototype)
  }
}

export function isPsdError(e: unknown): e is PsdError {
  return e instanceof PsdError
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v)
  } catch {
    return '[unserialisable]'
  }
}

/** Hard ceiling for a single typed-array allocation (2 GiB - 1). */
const MAX_SINGLE_ALLOCATION = 2_147_483_647

/**
 * Allocates a zero-filled byte buffer from a length that came out of the file.
 *
 * Every allocation whose size is attacker-controlled MUST go through this
 * helper: it rejects absurd lengths up-front and converts the engine's
 * `RangeError` into a typed `PsdError`, so a hostile PSD can never crash the
 * worker nor make it try to reserve gigabytes.
 */
export function allocBytes(n: number, cap = MAX_SINGLE_ALLOCATION): Uint8Array {
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > cap) {
    throw new PsdError('OUT_OF_MEMORY', { requested: n, cap })
  }
  try {
    return new Uint8Array(n)
  } catch {
    throw new PsdError('OUT_OF_MEMORY', { requested: n })
  }
}
