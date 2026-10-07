// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Minimal ISO base media file format walker, shared by Canon CR3 (§5.4) and HEIF (§6.3).
//
// Three traps this file exists to avoid, each of which turns a malformed file into an
// infinite loop in a naive implementation:
//   * `size === 0` means "to the end of the file", not "empty box";
//   * `size === 1` means the real, 64-bit size follows the type field;
//   * a `size` smaller than the header itself must terminate the walk, not rewind it.
// On top of that the walk is capped in depth and in box count.

import { ByteReader } from '../../formats/reader'

export interface BmffBox {
  /** Four-character type, e.g. `'ftyp'`, `'meta'`, `'uuid'`. */
  readonly type: string
  /** Absolute offset of the box header. */
  readonly at: number
  /** Absolute offset of the payload (after size/type, and after `usertype` for `uuid`). */
  readonly start: number
  /** Absolute end of the payload (exclusive). */
  readonly end: number
  /** 16-byte user type of a `uuid` box, lower-case hex without dashes. */
  readonly uuid?: string
}

const MAX_DEPTH = 16
const MAX_BOXES = 100_000

/** Boxes whose payload is itself a list of boxes preceded by nothing. */
const CONTAINER_BOXES = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'iprp', 'ipco', 'dinf'])
/** FullBoxes (version + flags) whose payload continues with child boxes. */
const FULLBOX_CONTAINERS = new Set(['meta'])

export interface BoxWalkState {
  boxes: number
}

/**
 * Iterates the boxes directly inside `[start, end)`. Nested boxes are reached by calling
 * again on a parent's payload — the caller decides how deep to go, which keeps a
 * pathological file from being fully expanded.
 */
export function* iterBoxes(
  bytes: Uint8Array,
  start: number,
  end: number,
  state: BoxWalkState = { boxes: 0 },
): Generator<BmffBox> {
  const r = new ByteReader(bytes, false)
  let pos = Math.max(0, start)
  const limit = Math.min(end, bytes.length)

  while (pos + 8 <= limit) {
    if (++state.boxes > MAX_BOXES) return
    let size: number
    try {
      size = r.u32At(pos, false)
    } catch {
      return
    }
    const type = r.ascii(pos + 4, 4)
    let headerSize = 8
    if (size === 1) {
      if (pos + 16 > limit) return
      const hi = r.u32At(pos + 8, false)
      const lo = r.u32At(pos + 12, false)
      size = hi * 0x1_0000_0000 + lo
      if (!Number.isSafeInteger(size)) return
      headerSize = 16
    } else if (size === 0) {
      size = limit - pos
    }
    if (size < headerSize || pos + size > limit) {
      // A truncated last box is common in the wild; yield what is readable, then stop.
      if (pos + headerSize <= limit) {
        yield { type, at: pos, start: pos + headerSize, end: limit }
      }
      return
    }

    let payloadStart = pos + headerSize
    let uuid: string | undefined
    if (type === 'uuid' && payloadStart + 16 <= limit) {
      uuid = hex(bytes.subarray(payloadStart, payloadStart + 16))
      payloadStart += 16
    }
    yield { type, at: pos, start: payloadStart, end: pos + size, uuid }
    pos += size
  }
}

/** True for boxes whose payload can be walked as a box list. */
export function isContainer(type: string): boolean {
  return CONTAINER_BOXES.has(type) || FULLBOX_CONTAINERS.has(type) || type === 'uuid'
}

/** Payload start of a container, skipping the FullBox version/flags where required. */
export function containerPayloadStart(box: BmffBox): number {
  return FULLBOX_CONTAINERS.has(box.type) ? box.start + 4 : box.start
}

/**
 * Depth-first search for every box of the given type, wherever it sits in the tree.
 * Bounded by `MAX_DEPTH` and by the shared box budget.
 */
export function findBoxes(
  bytes: Uint8Array,
  start: number,
  end: number,
  wanted: ReadonlySet<string>,
  depth = 0,
  state: BoxWalkState = { boxes: 0 },
): BmffBox[] {
  if (depth >= MAX_DEPTH) return []
  const out: BmffBox[] = []
  for (const box of iterBoxes(bytes, start, end, state)) {
    if (wanted.has(box.type)) out.push(box)
    if (isContainer(box.type)) {
      out.push(...findBoxes(bytes, containerPayloadStart(box), box.end, wanted, depth + 1, state))
    }
  }
  return out
}

/** `ftyp` brands: major brand first, then every compatible brand. */
export function readBrands(bytes: Uint8Array): string[] {
  const r = new ByteReader(bytes, false)
  if (!r.has(0, 12) || r.ascii(4, 4) !== 'ftyp') return []
  let size = r.u32At(0, false)
  if (size === 0 || size > bytes.length) size = bytes.length
  const brands = [r.ascii(8, 4)]
  for (let p = 16; p + 4 <= size; p += 4) brands.push(r.ascii(p, 4))
  return brands.filter((b) => b.length > 0)
}

function hex(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0')
  return s
}
