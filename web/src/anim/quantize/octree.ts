// Octree quantiser (Gervautz-Purgathofer 1988) — the "fast" preset.
//
// Kept alongside median cut because it has properties median cut does not:
// bounded memory by construction and incremental insertion, which suits very
// large images and a future streaming path. It is exact on flat-colour art with
// <= 256 tints, a cut below median cut + Lloyd on photographs.
//
// Deterministic: nodes are inserted in ascending histogram-bin order and
// reduction always picks the deepest level, then the smallest population, then
// the earliest-created node.

import type { Histogram } from './histogram.ts'
import { sortPalette } from './medianCut.ts'

const MAX_LEVEL = 7

interface Node {
  count: number
  sumR: number
  sumG: number
  sumB: number
  children: (Node | null)[]
  childCount: number
  leaf: boolean
  /** Creation order, used as the final deterministic tie-break. */
  seq: number
}

export function octreePalette(hist: Histogram, maxColors: number): { rgb: Uint8Array; size: number } {
  const k = Math.max(1, Math.min(256, Math.floor(maxColors)))
  if (hist.usedCount === 0) return { rgb: new Uint8Array([0, 0, 0]), size: 1 }

  let seq = 0
  const newNode = (leaf: boolean): Node => ({
    count: 0,
    sumR: 0,
    sumG: 0,
    sumB: 0,
    children: [null, null, null, null, null, null, null, null],
    childCount: 0,
    leaf,
    seq: seq++,
  })

  const root = newNode(false)
  const levels: Node[][] = Array.from({ length: MAX_LEVEL + 1 }, () => [])
  let leaves = 0

  const insert = (r: number, g: number, b: number, count: number): void => {
    let node = root
    for (let level = 0; level <= MAX_LEVEL; level++) {
      if (node.leaf) break
      const shift = 7 - level
      const i = (((r >> shift) & 1) << 2) | (((g >> shift) & 1) << 1) | ((b >> shift) & 1)
      let child = node.children[i]
      if (!child) {
        child = newNode(level === MAX_LEVEL)
        node.children[i] = child
        node.childCount++
        if (child.leaf) leaves++
        else levels[level].push(child)
      }
      node = child
    }
    node.count += count
    node.sumR += r * count
    node.sumG += g * count
    node.sumB += b * count
    if (!node.leaf && node.childCount === 0) {
      // Should not happen, but never leave a dangling non-leaf accumulator.
      node.leaf = true
      leaves++
    }
  }

  for (let i = 0; i < hist.usedCount; i++) {
    const bi = hist.used[i]
    const c = hist.counts[bi]
    insert(
      Math.round(hist.sumR[bi] / c),
      Math.round(hist.sumG[bi] / c),
      Math.round(hist.sumB[bi] / c),
      c,
    )
    while (leaves > k) if (!reduce()) break
  }
  while (leaves > k) if (!reduce()) break

  function reduce(): boolean {
    for (let level = MAX_LEVEL; level >= 0; level--) {
      const list = levels[level]
      if (list.length === 0) continue
      let bestIdx = -1
      let best: Node | null = null
      for (let i = 0; i < list.length; i++) {
        const n = list[i]
        if (n.leaf || n.childCount === 0) continue
        if (!best || n.count + sumChildren(n) < best.count + sumChildren(best)) {
          best = n
          bestIdx = i
        }
      }
      if (!best) {
        levels[level] = []
        continue
      }
      for (let i = 0; i < 8; i++) {
        const c = best.children[i]
        if (!c) continue
        best.count += c.count
        best.sumR += c.sumR
        best.sumG += c.sumG
        best.sumB += c.sumB
        if (c.leaf) leaves--
        best.children[i] = null
      }
      best.childCount = 0
      best.leaf = true
      leaves++
      list.splice(bestIdx, 1)
      return true
    }
    return false
  }

  function sumChildren(n: Node): number {
    let s = 0
    for (const c of n.children) if (c) s += c.count
    return s
  }

  const out: number[] = []
  const walk = (n: Node): void => {
    if (n.leaf) {
      if (n.count > 0) {
        out.push(
          Math.round(n.sumR / n.count),
          Math.round(n.sumG / n.count),
          Math.round(n.sumB / n.count),
        )
      }
      return
    }
    for (const c of n.children) if (c) walk(c)
  }
  walk(root)

  if (out.length === 0) return { rgb: new Uint8Array([0, 0, 0]), size: 1 }
  const size = out.length / 3
  return sortPalette(Uint8Array.from(out), size)
}
