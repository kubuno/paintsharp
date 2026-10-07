/*
 * Adobe descriptor parser (spec §6).
 *
 * Derived from the GIMP PSD plug-in (file-psd), Copyright 2007 John Marshall,
 * licensed under the GNU General Public License v3 or later — `parse_descriptor()`,
 * `load_descriptor()`, `load_type()`, `load_key()` in psd-util.c — and from
 * Adobe's public "Photoshop File Formats Specification".
 *
 * This is an independent TypeScript re-implementation; no GIMP source code was
 * copied. Kubuno is AGPLv3, compatible with the GPLv3 (GPLv3 §13).
 */
import type { ByteReader } from '../binary/ByteReader.ts'
import { readUnicodeString } from '../binary/strings.ts'
import { PsdError } from '../errors.ts'
import { LIMITS } from '../constants.ts'
import type { Descriptor, DescriptorValue, RefItem } from './types.ts'

/**
 * Reads a key.
 *
 * ⚠️ The single most counter-intuitive rule of the format: a length of ZERO
 * means a four-byte key, not an empty one (GIMP: `load_key()`).
 */
export function readKey(r: ByteReader): string {
  const len = r.u32()
  if (len === 0) return r.ascii(4)
  if (len > 1024) throw new PsdError('DESCRIPTOR_MALFORMED', { keyLength: len })
  return r.ascii(len)
}

/**
 * Reads an Adobe descriptor.
 *
 * Throws `PsdError` on malformed data (unknown OSType, runaway nesting, EOF);
 * callers wrap the whole additional block so a single corrupt layer style can
 * never abort an import — they simply seek to the block's declared end and
 * report `malformed-block-skipped`.
 */
export function readDescriptor(r: ByteReader, depth = 0): Descriptor {
  if (depth > LIMITS.MAX_DESCRIPTOR_DEPTH) {
    throw new PsdError('DESCRIPTOR_TOO_DEEP', { depth })
  }
  const name = readUnicodeString(r)
  const classId = readKey(r)
  const count = r.u32()
  if (count > LIMITS.MAX_DESCRIPTOR_ITEMS) {
    throw new PsdError('DESCRIPTOR_MALFORMED', { itemCount: count })
  }
  const items = new Map<string, DescriptorValue>()
  for (let i = 0; i < count; i++) {
    const key = readKey(r)
    const value = readValue(r, depth)
    items.set(key, value)
  }
  return { name, classId, items }
}

export function readValue(r: ByteReader, depth: number): DescriptorValue {
  const os = r.ascii(4)
  switch (os) {
    case 'obj ':
      return { t: 'ref', items: readReference(r) }
    case 'Objc':
    case 'GlbO':
      return { t: 'desc', os, value: readDescriptor(r, depth + 1) }
    case 'VlLs': {
      const count = r.u32()
      if (count > LIMITS.MAX_LIST_ITEMS) {
        throw new PsdError('DESCRIPTOR_MALFORMED', { listCount: count })
      }
      const list: DescriptorValue[] = []
      // List items carry no key — just an OSType and a value.
      for (let i = 0; i < count; i++) list.push(readValue(r, depth + 1))
      return { t: 'list', items: list }
    }
    case 'doub':
      return { t: 'double', value: r.f64() }
    case 'UntF':
      return { t: 'unit', unit: r.ascii(4), value: r.f64() }
    case 'UnFl': {
      const unit = r.ascii(4)
      const count = r.u32()
      if (count > LIMITS.MAX_LIST_ITEMS) {
        throw new PsdError('DESCRIPTOR_MALFORMED', { listCount: count })
      }
      const values: number[] = []
      for (let i = 0; i < count; i++) values.push(r.f64())
      return { t: 'units', unit, values }
    }
    case 'TEXT':
      return { t: 'text', value: readUnicodeString(r) }
    case 'enum': {
      const typeId = readKey(r)
      return { t: 'enum', typeId, value: readKey(r) }
    }
    case 'long':
      return { t: 'int', value: r.i32() }
    case 'comp':
      // GIMP reads these as a plain uint32 pair; we read the real int64.
      return { t: 'large', value: BigInt.asIntN(64, r.u64()) }
    case 'bool':
      return { t: 'bool', value: r.u8() !== 0 }
    case 'type':
    case 'GlbC': {
      const name = readUnicodeString(r)
      return { t: 'class', os, name, classId: readKey(r) }
    }
    case 'alis': {
      const len = r.u32()
      return { t: 'alias', data: r.bytes(Math.min(len, r.remaining)) }
    }
    case 'tdta': {
      const len = r.u32()
      return { t: 'raw', data: r.bytes(Math.min(len, r.remaining)) }
    }
    case 'ObAr': {
      // Undocumented "object array"; layout confirmed against real files.
      const version = r.u32()
      const name = readUnicodeString(r)
      const classId = readKey(r)
      const count = r.u32()
      if (count > LIMITS.MAX_DESCRIPTOR_ITEMS) {
        throw new PsdError('DESCRIPTOR_MALFORMED', { objArrCount: count })
      }
      const items = new Map<string, DescriptorValue>()
      for (let i = 0; i < count; i++) {
        const key = readKey(r)
        items.set(key, readValue(r, depth + 1))
      }
      return { t: 'objArr', version, name, classId, items }
    }
    default:
      // We cannot know the length of an unknown type, so continuing would
      // desynchronise the whole descriptor. Bail out; the caller repositions.
      throw new PsdError('DESCRIPTOR_MALFORMED', { osType: os })
  }
}

function readReference(r: ByteReader): RefItem[] {
  const count = r.u32()
  if (count > LIMITS.MAX_DESCRIPTOR_ITEMS) {
    throw new PsdError('DESCRIPTOR_MALFORMED', { refCount: count })
  }
  const items: RefItem[] = []
  for (let i = 0; i < count; i++) {
    const refType = r.ascii(4)
    switch (refType) {
      case 'prop': {
        const classId = readKey(r)
        items.push({ t: 'prop', classId, keyId: readKey(r) })
        break
      }
      case 'Clss': {
        const name = readUnicodeString(r)
        items.push({ t: 'class', name, classId: readKey(r) })
        break
      }
      case 'Enmr': {
        const name = readUnicodeString(r)
        const classId = readKey(r)
        const typeId = readKey(r)
        items.push({ t: 'enum', name, classId, typeId, value: readKey(r) })
        break
      }
      case 'rele': {
        const name = readUnicodeString(r)
        const classId = readKey(r)
        items.push({ t: 'offset', name, classId, offset: r.u32() })
        break
      }
      case 'Idnt':
        items.push({ t: 'identifier', value: r.u32() })
        break
      case 'indx':
        items.push({ t: 'index', value: r.u32() })
        break
      case 'name': {
        const name = readUnicodeString(r)
        const classId = readKey(r)
        items.push({ t: 'name', name, classId, value: readUnicodeString(r) })
        break
      }
      default:
        throw new PsdError('DESCRIPTOR_MALFORMED', { refType })
    }
  }
  return items
}
