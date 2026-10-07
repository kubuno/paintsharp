// Layer identifiers.
//
// `crypto.randomUUID` is NOT used: it is undefined in an insecure context (plain
// HTTP on a non-localhost origin), which is a supported Kubuno deployment. The
// shared `uid()` helper falls back to `crypto.getRandomValues`.

import { uid } from '../../../uid.ts'
import type { LayerId } from '../types.ts'

/** Mint a fresh, never-reused layer identifier. */
export function newLayerId(): LayerId {
  return uid() as LayerId
}

/** Brand an existing string (documents read from disk, PSD import). */
export function asLayerId(v: string): LayerId {
  return v as LayerId
}

/** A usable identifier is a non-empty string. Nothing else is required. */
export function isLayerId(v: unknown): v is LayerId {
  return typeof v === 'string' && v.length > 0
}

/** Deterministic 32-bit hash of an id — the `dissolve` seed, and dedup keys. */
export function hashId(id: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h >>> 0
}
