// GIF LZW decoder — variable-width, LSB-first codes, 4096-entry table.
//
// Algorithm reimplemented in TypeScript from GIMP's
// plug-ins/common/file-gif-load.c (GPL-3.0-or-later), itself derived from the
// historical compress(1)/GIFLIB lineage. Kubuno is AGPL-3.0-or-later, into
// which GPLv3 code may be combined.
//
// Two traps are handled explicitly, and they are the reason most home-grown
// decoders produce "GIFs that only display correctly for other people":
//
//  * DEFERRED CLEAR CODE. Some encoders (older GIMP and Photoshop among them)
//    fill the table up to 4096 without ever emitting a clear code. From then on
//    the decoder must STOP adding entries and STOP growing the code size while
//    still emitting normally. A naive implementation throws or corrupts here.
//  * TRUNCATION. Extremely common in the wild. The decoder fills the remainder
//    with the transparent (or background) index and reports it; it never throws.

export interface LzwDecodeResult {
  indices: Uint8Array
  /** True when the code stream ended before the image was filled. */
  truncated: boolean
}

/** Reusable tables: allocated once, shared by every frame of a decode. */
export class LzwTables {
  readonly prefix = new Int16Array(4096)
  readonly suffix = new Uint8Array(4096)
  readonly first = new Uint8Array(4096)
  readonly stack = new Uint8Array(4096)
}

export function lzwDecode(
  data: Uint8Array,
  minCodeSize: number,
  pixelCount: number,
  fill = 0,
  tables: LzwTables = new LzwTables(),
): LzwDecodeResult {
  const out = new Uint8Array(pixelCount)
  if (minCodeSize < 2 || minCodeSize > 8) {
    out.fill(fill)
    return { indices: out, truncated: true }
  }

  const clearCode = 1 << minCodeSize
  const endCode = clearCode + 1
  const { prefix, suffix, first, stack } = tables
  for (let i = 0; i < clearCode; i++) {
    prefix[i] = -1
    suffix[i] = i
    first[i] = i
  }

  let next = endCode + 1
  let codeSize = minCodeSize + 1
  let prev = -1
  let o = 0

  // Bit reader. The sub-block chain was reassembled upstream, so there is no
  // framing to be transparent to here: the accumulator simply never resets.
  let pos = 0
  let acc = 0
  let accBits = 0
  const readCode = (size: number): number => {
    while (accBits < size) {
      if (pos >= data.length) return -1
      acc |= data[pos++] << accBits
      accBits += 8
    }
    const code = acc & ((1 << size) - 1)
    acc >>>= size
    accBits -= size
    return code
  }

  let truncated = false
  for (;;) {
    if (o >= pixelCount) break
    const code = readCode(codeSize)
    if (code < 0) {
      truncated = true
      break
    }
    if (code === endCode) break
    if (code === clearCode) {
      next = endCode + 1
      codeSize = minCodeSize + 1
      prev = -1
      continue
    }

    let emit: number
    // KwKwK: the code refers to the entry that is about to be created, so the
    // string to emit is string(prev) followed by prev's own first byte.
    let appendFirstOfPrev = false
    if (code < next) {
      emit = code
      if (prev >= 0 && next < 4096) {
        prefix[next] = prev
        suffix[next] = first[code]
        first[next] = first[prev]
        next++
      }
    } else if (code === next && prev >= 0) {
      emit = prev
      appendFirstOfPrev = true
      if (next < 4096) {
        prefix[next] = prev
        suffix[next] = first[prev]
        first[next] = first[prev]
        next++
      }
    } else {
      // code > next, or a non-root code right after a clear: corrupt stream.
      truncated = true
      break
    }

    // Walk the prefix chain, pushing suffixes, then pop. `first[]` is maintained
    // incrementally at insertion time, which avoids a second chain walk.
    let sp = 0
    let c = emit
    while (c > endCode && sp < 4096) {
      stack[sp++] = suffix[c]
      c = prefix[c]
      if (c < 0) break
    }
    if (c >= 0 && sp < 4096) stack[sp++] = c & 0xff
    while (sp > 0 && o < pixelCount) out[o++] = stack[--sp]
    if (appendFirstOfPrev && o < pixelCount) out[o++] = first[prev]

    // Deferred clear code: once the table is full, freeze it. `next` stays at
    // 4096 so this condition can never fire again, and codeSize stays at 12.
    if (next === 1 << codeSize && codeSize < 12) codeSize++
    prev = code
  }

  if (o < pixelCount) {
    out.fill(fill, o)
    truncated = true
  }
  return { indices: out, truncated }
}
