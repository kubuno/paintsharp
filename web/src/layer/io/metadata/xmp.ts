// XMP packets (spec 05 §6.4).
//
// No RDF model is implemented. The original packet is kept VERBATIM and only the
// properties the user edits are rewritten in place — regenerating the XML would drop the
// proprietary extensions Lightroom and Capture One rely on.
//
// Reading uses the platform `DOMParser` when there is one (browser, worker); in a plain
// runtime it falls back to a bounded regular-expression scan, which is enough for the few
// properties we expose and keeps this file testable without a DOM.

import type { XmpPacket } from './types'

const PACKET_BEGIN = '<?xpacket begin='
const PACKET_END = '<?xpacket end='

/** Properties surfaced in the file-information panel. */
export const XMP_PROPERTY = {
  Title: 'dc:title',
  Description: 'dc:description',
  Creator: 'dc:creator',
  Subject: 'dc:subject',
  Rights: 'dc:rights',
  Rating: 'xmp:Rating',
  CreateDate: 'xmp:CreateDate',
  Credit: 'photoshop:Credit',
  Headline: 'photoshop:Headline',
} as const

/** Wraps a raw packet. Returns `null` when the bytes do not look like XMP at all. */
export function parseXmp(raw: Uint8Array): XmpPacket | null {
  if (raw.length === 0 || raw.length > 64 * 1024 * 1024) return null
  let xml: string
  try {
    xml = new TextDecoder('utf-8', { fatal: false }).decode(raw)
  } catch {
    return null
  }
  if (!xml.includes('<x:xmpmeta') && !xml.includes('<rdf:RDF') && !xml.includes(PACKET_BEGIN)) {
    return null
  }
  return { raw, xml }
}

/** JPEG APP1 XMP payloads are prefixed with this NUL-terminated namespace URI. */
export const XMP_JPEG_ID = 'http://ns.adobe.com/xap/1.0/\0'
export const XMP_EXTENDED_JPEG_ID = 'http://ns.adobe.com/xmp/extension/\0'

/**
 * Reassembles Extended XMP (JPEG only): packets above 64 KiB are split across APP1
 * segments carrying a GUID, a total size and an offset. Reading is supported; writing
 * truncates with a warning, which is acceptable outside Lightroom workflows.
 */
export function joinExtendedXmp(segments: readonly Uint8Array[]): Uint8Array | null {
  const idLen = XMP_EXTENDED_JPEG_ID.length
  const parts: { offset: number; data: Uint8Array }[] = []
  let totalSize = 0
  for (const s of segments) {
    if (s.length < idLen + 40) continue
    let ok = true
    for (let i = 0; i < idLen; i++) {
      if (s[i] !== XMP_EXTENDED_JPEG_ID.charCodeAt(i)) {
        ok = false
        break
      }
    }
    if (!ok) continue
    const view = new DataView(s.buffer, s.byteOffset, s.byteLength)
    // 32-byte GUID, then total size and offset, both big-endian.
    const size = view.getUint32(idLen + 32, false)
    const offset = view.getUint32(idLen + 36, false)
    totalSize = Math.max(totalSize, size)
    parts.push({ offset, data: s.subarray(idLen + 40) })
  }
  if (parts.length === 0 || totalSize === 0 || totalSize > 64 * 1024 * 1024) return null
  const out = new Uint8Array(totalSize)
  for (const p of parts) {
    if (p.offset + p.data.length <= totalSize) out.set(p.data, p.offset)
  }
  return out
}

/**
 * Reads a property. Array-valued properties (`dc:subject`, `dc:creator`) return every
 * `rdf:li`; language alternatives return the `x-default` entry.
 */
export function xmpGet(packet: XmpPacket | undefined, property: string): readonly string[] {
  if (!packet) return []
  const dom = tryDom(packet.xml)
  if (dom) {
    const [prefix, local] = splitName(property)
    const nodes = collectElements(dom, prefix, local)
    const out: string[] = []
    for (const node of nodes) {
      const items = node.getElementsByTagName('*')
      let found = false
      for (let i = 0; i < items.length; i++) {
        const el = items[i]
        if (localName(el.nodeName) === 'li') {
          const t = el.textContent?.trim()
          if (t) out.push(t)
          found = true
        }
      }
      if (!found) {
        const t = node.textContent?.trim()
        if (t) out.push(t)
      }
    }
    return out
  }
  return regexGet(packet.xml, property)
}

/** Bounded regex fallback: element form, then attribute form. */
function regexGet(xml: string, property: string): string[] {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const element = new RegExp(`<${escaped}[^>]*>([\\s\\S]{0,8192}?)</${escaped}>`)
  const m = element.exec(xml)
  if (m) {
    const inner = m[1]
    const items = [...inner.matchAll(/<rdf:li[^>]*>([\s\S]{0,4096}?)<\/rdf:li>/g)].map((x) =>
      decodeEntities(x[1].trim()),
    )
    if (items.length > 0) return items
    return [decodeEntities(inner.replace(/<[^>]*>/g, '').trim())].filter((s) => s.length > 0)
  }
  const attribute = new RegExp(`${escaped}="([^"]{0,4096})"`)
  const a = attribute.exec(xml)
  return a ? [decodeEntities(a[1])] : []
}

/**
 * Rewrites a simple text property in place, preserving everything else in the packet.
 * Only element and attribute forms of a scalar property are handled; anything more
 * structured is left untouched and reported by the return value.
 */
export function xmpSet(packet: XmpPacket, property: string, value: string): XmpPacket | null {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const encoded = encodeEntities(value)
  const element = new RegExp(`(<${escaped}[^>]*>)([\\s\\S]{0,8192}?)(</${escaped}>)`)
  let xml = packet.xml
  if (element.test(xml)) {
    xml = xml.replace(element, `$1${encoded}$3`)
  } else {
    const attribute = new RegExp(`(${escaped}=")([^"]{0,4096})(")`)
    if (!attribute.test(xml)) return null
    xml = xml.replace(attribute, `$1${encoded}$3`)
  }
  return { raw: new TextEncoder().encode(xml), xml, extended: packet.extended }
}

function tryDom(xml: string): Document | null {
  if (typeof DOMParser === 'undefined') return null
  try {
    const doc = new DOMParser().parseFromString(xml, 'application/xml')
    if (doc.getElementsByTagName('parsererror').length > 0) return null
    return doc
  } catch {
    return null
  }
}

function collectElements(doc: Document, prefix: string, local: string): Element[] {
  const out: Element[] = []
  const all = doc.getElementsByTagName('*')
  for (let i = 0; i < all.length; i++) {
    const el = all[i]
    const name = el.nodeName
    if (name === `${prefix}:${local}` || localName(name) === local) out.push(el)
  }
  return out
}

function splitName(property: string): [string, string] {
  const i = property.indexOf(':')
  return i < 0 ? ['', property] : [property.slice(0, i), property.slice(i + 1)]
}

function localName(nodeName: string): string {
  const i = nodeName.indexOf(':')
  return i < 0 ? nodeName : nodeName.slice(i + 1)
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function encodeEntities(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Extracts the packet from a larger buffer that may hold leading/trailing padding. */
export function findXmpPacket(bytes: Uint8Array): Uint8Array | null {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  const start = text.indexOf(PACKET_BEGIN)
  if (start < 0) return bytes.length > 0 ? bytes : null
  const endMarker = text.indexOf(PACKET_END, start)
  if (endMarker < 0) return bytes.subarray(start)
  const closing = text.indexOf('>', endMarker)
  const end = closing < 0 ? text.length : closing + 1
  return new TextEncoder().encode(text.slice(start, end))
}
