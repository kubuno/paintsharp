// SPDX-License-Identifier: AGPL-3.0-or-later
//
// HEIF container parsing (spec 07 §6.3-6.4).
//
// The container is parsed even when the platform decodes the pixels for us, because the
// browser will not tell us what it just did: the rotation, the tiling, the HDR transfer
// function and the multi-image collection are all things the user must be told about,
// and they only exist in the boxes.

import { ByteReader } from '../../formats/reader'
import { containerPayloadStart, iterBoxes, readBrands, type BmffBox } from '../raw/bmff'

export interface HeifItem {
  readonly id: number
  /** `'hvc1'`, `'grid'`, `'iovl'`, `'Exif'`, `'mime'`, `'av01'`, `'jpeg'`… */
  readonly type: string
  readonly name?: string
}

export interface HeifGrid {
  readonly rows: number
  readonly columns: number
  readonly width: number
  readonly height: number
}

export interface HeifInfo {
  readonly brands: readonly string[]
  /** True when a brand says HEVC-in-HEIF; false for a generic `mif1` or an AVIF. */
  readonly isHevc: boolean
  readonly isAvif: boolean
  /** Primary item id from `pitm`, when declared. */
  readonly primaryItem?: number
  readonly items: readonly HeifItem[]
  /** `ispe` of the primary item. */
  readonly width?: number
  readonly height?: number
  /** `irot` in degrees counter-clockwise: 0, 90, 180 or 270. */
  readonly rotation: number
  /** `imir`: 0 = vertical axis (left-right flip), 1 = horizontal axis. */
  readonly mirror?: 0 | 1
  /** Present when the primary item is a tiled `grid`. */
  readonly grid?: HeifGrid
  /** True when an auxiliary alpha image is attached through an `auxl` reference. */
  readonly hasAlphaAux: boolean
  /** `nclx` transfer characteristics: 16 = PQ, 18 = HLG, 1/13 = SDR. */
  readonly transferCharacteristics?: number
  readonly colorPrimaries?: number
  /** Verbatim ICC profile from a `colr` box of type `rICC`/`prof`. */
  readonly iccProfile?: Uint8Array
  /** Number of images that are neither tiles nor auxiliaries. */
  readonly imageCount: number
}

const IMAGE_ITEM_TYPES = new Set(['hvc1', 'hev1', 'av01', 'avc1', 'jpeg', 'j2ki', 'grid', 'iovl'])
const HEVC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx'])
const AVIF_BRANDS = new Set(['avif', 'avis'])

/**
 * Reads everything the importer needs from the metadata boxes.
 *
 * Never throws: a HEIF whose boxes are unreadable still has a chance of decoding through
 * the platform, and refusing it on a metadata technicality would be absurd.
 */
export function readHeifInfo(bytes: Uint8Array): HeifInfo {
  const brands = readBrands(bytes)
  const base: HeifInfo = {
    brands,
    isHevc: brands.some((b) => HEVC_BRANDS.has(b)),
    isAvif: brands.some((b) => AVIF_BRANDS.has(b)),
    items: [],
    rotation: 0,
    hasAlphaAux: false,
    imageCount: 0,
  }
  try {
    return parseMeta(bytes, base)
  } catch {
    return base
  }
}

function parseMeta(bytes: Uint8Array, base: HeifInfo): HeifInfo {
  let meta: BmffBox | undefined
  for (const box of iterBoxes(bytes, 0, bytes.length)) {
    if (box.type === 'meta') {
      meta = box
      break
    }
  }
  if (!meta) return base

  const r = new ByteReader(bytes, false)
  let primaryItem: number | undefined
  const items: HeifItem[] = []
  let ipco: BmffBox | undefined
  let ipma: BmffBox | undefined
  const refs: { from: number; type: string; to: number[] }[] = []

  // `meta` is a FullBox: the four version/flags bytes MUST be skipped before its children.
  for (const box of iterBoxes(bytes, containerPayloadStart(meta), meta.end)) {
    switch (box.type) {
      case 'pitm': {
        const version = r.u8At(box.start)
        primaryItem = version >= 1 ? r.u32At(box.start + 4, false) : r.u16At(box.start + 4, false)
        break
      }
      case 'iinf':
        items.push(...parseIinf(bytes, box))
        break
      case 'iref':
        refs.push(...parseIref(bytes, box))
        break
      case 'iprp':
        for (const child of iterBoxes(bytes, box.start, box.end)) {
          if (child.type === 'ipco') ipco = child
          if (child.type === 'ipma') ipma = child
        }
        break
      default:
        break
    }
  }

  const props = ipco ? [...iterBoxes(bytes, ipco.start, ipco.end)] : []
  const assoc = ipma ? parseIpma(bytes, ipma) : new Map<number, number[]>()

  const primary = primaryItem ?? items[0]?.id
  const primaryProps = (primary !== undefined ? assoc.get(primary) : undefined) ?? []

  let width: number | undefined
  let height: number | undefined
  let rotation = 0
  let mirror: 0 | 1 | undefined
  let transferCharacteristics: number | undefined
  let colorPrimaries: number | undefined
  let iccProfile: Uint8Array | undefined

  for (const index of primaryProps) {
    // `ipma` indices are 1-based into `ipco`.
    const box = props[index - 1]
    if (!box) continue
    switch (box.type) {
      case 'ispe':
        width = r.u32At(box.start + 4, false)
        height = r.u32At(box.start + 8, false)
        break
      case 'irot':
        rotation = (r.u8At(box.start) & 3) * 90
        break
      case 'imir':
        mirror = (r.u8At(box.start) & 1) as 0 | 1
        break
      case 'colr': {
        const kind = r.ascii(box.start, 4)
        if (kind === 'nclx') {
          colorPrimaries = r.u16At(box.start + 4, false)
          transferCharacteristics = r.u16At(box.start + 6, false)
        } else if (kind === 'rICC' || kind === 'prof') {
          iccProfile = bytes.slice(box.start + 4, box.end)
        }
        break
      }
      default:
        break
    }
  }

  // Grids: the primary item is derived, its tiles are the `dimg` references.
  let grid: HeifGrid | undefined
  const primaryItemEntry = items.find((i) => i.id === primary)
  if (primaryItemEntry?.type === 'grid') {
    grid = parseGridPayload(bytes, meta, refs, primary)
    if (grid) {
      width = grid.width
      height = grid.height
    }
  }

  const tileIds = new Set(refs.filter((x) => x.type === 'dimg').flatMap((x) => x.to))
  const auxIds = new Set(refs.filter((x) => x.type === 'auxl').flatMap((x) => x.from))
  const imageCount = items.filter(
    (i) => IMAGE_ITEM_TYPES.has(i.type) && !tileIds.has(i.id) && !auxIds.has(i.id),
  ).length

  return {
    ...base,
    primaryItem: primary,
    items,
    width,
    height,
    rotation,
    mirror,
    grid,
    hasAlphaAux: auxIds.size > 0,
    transferCharacteristics,
    colorPrimaries,
    iccProfile,
    imageCount,
  }
}

function parseIinf(bytes: Uint8Array, box: BmffBox): HeifItem[] {
  const r = new ByteReader(bytes, false)
  const version = r.u8At(box.start)
  let p = box.start + 4
  // entry_count is u16 in version 0, u32 from version 1.
  if (version === 0) p += 2
  else p += 4
  const out: HeifItem[] = []
  for (const infe of iterBoxes(bytes, p, box.end)) {
    if (infe.type !== 'infe') continue
    const v = r.u8At(infe.start)
    if (v < 2) continue // versions 0/1 predate item_type; not produced by any HEIF writer
    const idSize = v === 2 ? 2 : 4
    const id = v === 2 ? r.u16At(infe.start + 4, false) : r.u32At(infe.start + 4, false)
    const typeAt = infe.start + 4 + idSize + 2 // + protection_index
    if (typeAt + 4 > infe.end) continue
    out.push({ id, type: r.ascii(typeAt, 4) })
    if (out.length >= 4096) break
  }
  return out
}

function parseIref(bytes: Uint8Array, box: BmffBox): { from: number; type: string; to: number[] }[] {
  const r = new ByteReader(bytes, false)
  const version = r.u8At(box.start)
  const wide = version >= 1
  const out: { from: number; type: string; to: number[] }[] = []
  for (const ref of iterBoxes(bytes, box.start + 4, box.end)) {
    let p = ref.start
    if (!r.has(p, wide ? 6 : 4)) continue
    const from = wide ? r.u32At(p, false) : r.u16At(p, false)
    p += wide ? 4 : 2
    const count = r.u16At(p, false)
    p += 2
    const to: number[] = []
    for (let i = 0; i < count && i < 4096; i++) {
      if (!r.has(p, wide ? 4 : 2)) break
      to.push(wide ? r.u32At(p, false) : r.u16At(p, false))
      p += wide ? 4 : 2
    }
    out.push({ from, type: ref.type, to })
    if (out.length >= 4096) break
  }
  return out
}

function parseIpma(bytes: Uint8Array, box: BmffBox): Map<number, number[]> {
  const r = new ByteReader(bytes, false)
  const version = r.u8At(box.start)
  const flags = (r.u8At(box.start + 1) << 16) | (r.u8At(box.start + 2) << 8) | r.u8At(box.start + 3)
  const wideIndex = (flags & 1) !== 0
  let p = box.start + 4
  const count = r.u32At(p, false)
  p += 4
  const map = new Map<number, number[]>()
  for (let i = 0; i < count && i < 4096; i++) {
    if (!r.has(p, version < 1 ? 3 : 5)) break
    const id = version < 1 ? r.u16At(p, false) : r.u32At(p, false)
    p += version < 1 ? 2 : 4
    const n = r.u8At(p)
    p += 1
    const indices: number[] = []
    for (let k = 0; k < n; k++) {
      if (!r.has(p, wideIndex ? 2 : 1)) break
      // The top bit is the "essential" flag; the index is what remains.
      indices.push(wideIndex ? r.u16At(p, false) & 0x7fff : r.u8At(p) & 0x7f)
      p += wideIndex ? 2 : 1
    }
    map.set(id, indices)
  }
  return map
}

/**
 * `grid` payload: version, flags (bit 0 = 32-bit output dimensions), rows-1, columns-1,
 * then the output size. The payload lives in `idat` or in `mdat`; only the `idat` case is
 * resolved here, which is what iPhone files use.
 */
function parseGridPayload(
  bytes: Uint8Array,
  meta: BmffBox,
  refs: readonly { from: number; type: string; to: number[] }[],
  primary: number | undefined,
): HeifGrid | undefined {
  let idat: BmffBox | undefined
  for (const box of iterBoxes(bytes, containerPayloadStart(meta), meta.end)) {
    if (box.type === 'idat') idat = box
  }
  if (!idat || idat.end - idat.start < 8) return undefined
  const r = new ByteReader(bytes, false)
  const flags = r.u8At(idat.start + 1)
  const rows = r.u8At(idat.start + 2) + 1
  const columns = r.u8At(idat.start + 3) + 1
  const wide = (flags & 1) !== 0
  const width = wide ? r.u32At(idat.start + 4, false) : r.u16At(idat.start + 4, false)
  const height = wide
    ? r.u32At(idat.start + 8, false)
    : r.u16At(idat.start + 6, false)
  const tiles = refs.find((x) => x.type === 'dimg' && x.from === primary)?.to.length ?? 0
  if (width <= 0 || height <= 0) return undefined
  void tiles
  return { rows, columns, width, height }
}
