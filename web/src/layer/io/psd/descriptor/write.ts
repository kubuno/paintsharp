/*
 * Adobe descriptor serialiser (spec §6.5) — the exact mirror of read.ts.
 *
 * Derived from Adobe's public "Photoshop File Formats Specification" and from
 * the GIMP PSD plug-in (file-psd), Copyright 2007 John Marshall, GPLv3+.
 * Independent TypeScript re-implementation; no GIMP source was copied.
 * Kubuno is AGPLv3.
 */
import type { ByteWriter } from '../binary/ByteWriter.ts'
import { writeUnicodeString } from '../binary/strings.ts'
import type { Descriptor, DescriptorValue, RefItem } from './types.ts'

/**
 * Writes a key.
 *
 * Four-character keys are emitted with the `0` length marker, which is what
 * Photoshop does and what `readKey()` expects; longer runtime keys carry their
 * real length.
 */
export function writeKey(w: ByteWriter, key: string): void {
  if (key.length === 4) {
    w.u32(0)
    w.ascii(key, 4)
  } else {
    w.u32(key.length)
    w.ascii(key)
  }
}

export function writeDescriptor(w: ByteWriter, d: Descriptor): void {
  writeUnicodeString(w, d.name)
  writeKey(w, d.classId)
  w.u32(d.items.size)
  for (const [key, value] of d.items) {
    writeKey(w, key)
    writeValue(w, value)
  }
}

export function writeValue(w: ByteWriter, v: DescriptorValue): void {
  switch (v.t) {
    case 'ref':
      w.ascii('obj ', 4)
      w.u32(v.items.length)
      for (const it of v.items) writeRefItem(w, it)
      break
    case 'desc':
      w.ascii(v.os, 4)
      writeDescriptor(w, v.value)
      break
    case 'list':
      w.ascii('VlLs', 4)
      w.u32(v.items.length)
      for (const it of v.items) writeValue(w, it)
      break
    case 'double':
      w.ascii('doub', 4)
      w.f64(v.value)
      break
    case 'unit':
      w.ascii('UntF', 4)
      w.ascii(v.unit, 4)
      w.f64(v.value)
      break
    case 'units':
      w.ascii('UnFl', 4)
      w.ascii(v.unit, 4)
      w.u32(v.values.length)
      for (const n of v.values) w.f64(n)
      break
    case 'text':
      w.ascii('TEXT', 4)
      writeUnicodeString(w, v.value)
      break
    case 'enum':
      w.ascii('enum', 4)
      writeKey(w, v.typeId)
      writeKey(w, v.value)
      break
    case 'int':
      w.ascii('long', 4)
      w.i32(v.value)
      break
    case 'large':
      w.ascii('comp', 4)
      w.u64(BigInt.asUintN(64, v.value))
      break
    case 'bool':
      w.ascii('bool', 4)
      w.u8(v.value ? 1 : 0)
      break
    case 'class':
      w.ascii(v.os, 4)
      writeUnicodeString(w, v.name)
      writeKey(w, v.classId)
      break
    case 'alias':
      w.ascii('alis', 4)
      w.u32(v.data.length)
      w.bytes(v.data)
      break
    case 'raw':
      w.ascii('tdta', 4)
      w.u32(v.data.length)
      w.bytes(v.data)
      break
    case 'objArr':
      w.ascii('ObAr', 4)
      w.u32(v.version)
      writeUnicodeString(w, v.name)
      writeKey(w, v.classId)
      w.u32(v.items.size)
      for (const [key, value] of v.items) {
        writeKey(w, key)
        writeValue(w, value)
      }
      break
  }
}

function writeRefItem(w: ByteWriter, it: RefItem): void {
  switch (it.t) {
    case 'prop':
      w.ascii('prop', 4)
      writeKey(w, it.classId)
      writeKey(w, it.keyId)
      break
    case 'class':
      w.ascii('Clss', 4)
      writeUnicodeString(w, it.name)
      writeKey(w, it.classId)
      break
    case 'enum':
      w.ascii('Enmr', 4)
      writeUnicodeString(w, it.name)
      writeKey(w, it.classId)
      writeKey(w, it.typeId)
      writeKey(w, it.value)
      break
    case 'offset':
      w.ascii('rele', 4)
      writeUnicodeString(w, it.name)
      writeKey(w, it.classId)
      w.u32(it.offset)
      break
    case 'identifier':
      w.ascii('Idnt', 4)
      w.u32(it.value)
      break
    case 'index':
      w.ascii('indx', 4)
      w.u32(it.value)
      break
    case 'name':
      w.ascii('name', 4)
      writeUnicodeString(w, it.name)
      writeKey(w, it.classId)
      writeUnicodeString(w, it.value)
      break
    case 'unknown':
      // Unreadable on the way in; emitting nothing keeps the stream coherent.
      break
  }
}
