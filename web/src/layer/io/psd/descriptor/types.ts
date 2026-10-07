/*
 * Adobe descriptor data model (spec §6.3).
 *
 * Derived from Adobe's public "Photoshop File Formats Specification" and from
 * the GIMP PSD plug-in (file-psd), Copyright 2007 John Marshall, GPLv3+
 * (`parse_descriptor()` / `load_descriptor()` in psd-util.c). Independent
 * TypeScript re-implementation; no GIMP source was copied. Kubuno is AGPLv3.
 */

/** `UntF` unit identifiers. Unknown units are preserved verbatim. */
export type UnitId = string

export type RefItem =
  | { t: 'prop'; classId: string; keyId: string }
  | { t: 'class'; name: string; classId: string }
  | { t: 'enum'; name: string; classId: string; typeId: string; value: string }
  | { t: 'offset'; name: string; classId: string; offset: number }
  | { t: 'identifier'; value: number }
  | { t: 'index'; value: number }
  | { t: 'name'; name: string; classId: string; value: string }
  /** A reference type we do not know: the rest of the reference is unreadable. */
  | { t: 'unknown'; refType: string }

export type DescriptorValue =
  | { t: 'ref'; items: RefItem[] }
  /** `Objc` / `GlbO` — `os` keeps the original tag for a bit-exact rewrite. */
  | { t: 'desc'; os: 'Objc' | 'GlbO'; value: Descriptor }
  | { t: 'list'; items: DescriptorValue[] }
  | { t: 'double'; value: number }
  | { t: 'unit'; unit: UnitId; value: number }
  | { t: 'units'; unit: UnitId; values: number[] }
  | { t: 'text'; value: string }
  | { t: 'enum'; typeId: string; value: string }
  | { t: 'int'; value: number }
  | { t: 'large'; value: bigint }
  | { t: 'bool'; value: boolean }
  /** `type` / `GlbC`. */
  | { t: 'class'; os: 'type' | 'GlbC'; name: string; classId: string }
  | { t: 'alias'; data: Uint8Array }
  /** `tdta` — often EngineData or XML; kept opaque. */
  | { t: 'raw'; data: Uint8Array }
  | { t: 'objArr'; version: number; name: string; classId: string; items: Map<string, DescriptorValue> }

export interface Descriptor {
  readonly name: string
  readonly classId: string
  /** Insertion order is preserved, which is what makes a rewrite bit-exact. */
  readonly items: Map<string, DescriptorValue>
}

/** Convenience accessors — descriptors are deeply nested by nature. */
export function descGet(d: Descriptor | null, key: string): DescriptorValue | undefined {
  return d?.items.get(key)
}

export function descNumber(d: Descriptor | null, key: string): number | undefined {
  const v = descGet(d, key)
  if (!v) return undefined
  if (v.t === 'double' || v.t === 'unit' || v.t === 'int') return v.value
  if (v.t === 'large') return Number(v.value)
  if (v.t === 'bool') return v.value ? 1 : 0
  return undefined
}

export function descBool(d: Descriptor | null, key: string): boolean | undefined {
  const v = descGet(d, key)
  if (!v) return undefined
  if (v.t === 'bool') return v.value
  if (v.t === 'int') return v.value !== 0
  return undefined
}

export function descText(d: Descriptor | null, key: string): string | undefined {
  const v = descGet(d, key)
  if (!v) return undefined
  if (v.t === 'text') return v.value
  if (v.t === 'enum') return v.value
  return undefined
}

export function descChild(d: Descriptor | null, key: string): Descriptor | null {
  const v = descGet(d, key)
  return v && v.t === 'desc' ? v.value : null
}
