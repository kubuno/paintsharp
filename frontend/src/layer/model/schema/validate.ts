// Structural invariants.
//
// `validateTree` is a REPAIR pass, not a gate: it never rejects a document, it
// fixes what it can and reports what it fixed. It is idempotent — running it
// twice changes nothing the second time, which is what lets it run on every
// load and after every import without drifting.

import { createRasterLayer, defaultLayerMask } from '../ops/defaults.ts'
import type { ArtboardLayer, GroupLayer, Layer, RectI } from '../types.ts'
import { isContainer, needsIsolation } from '../types.ts'
import { WarningSink, type MigrationWarning } from './warnings.ts'

export interface ValidateResult {
  tree: Layer[]
  warnings: MigrationWarning[]
  /** True when at least one repair was applied. */
  repaired: boolean
}

export function validateTree(tree: readonly Layer[], docBounds: RectI): ValidateResult {
  const sink = new WarningSink()
  let repaired = false
  const mark = () => { repaired = true }

  const seen = new Set<string>()
  const lifted: ArtboardLayer[] = []

  const visit = (nodes: readonly Layer[], isRoot: boolean): Layer[] => {
    const out: Layer[] = []
    for (const nRaw of nodes) {
      let n = nRaw

      // 1. Unique ids. A collision comes from imports and from naive copies.
      if (seen.has(n.id)) {
        sink.warn('validate.duplicateId', `Duplicate id "${n.id}" left in the tree`, n.id)
        mark()
      }
      seen.add(n.id)

      // 2. `pass-through` is legal only on groups.
      if (n.blendMode === 'pass-through' && n.kind !== 'group') {
        sink.warn('validate.passThrough', 'pass-through is group-only; downgraded to normal', n.id, 'blendMode')
        n = { ...n, blendMode: 'normal' }
        mark()
      }

      // 3. An adjustment layer always carries a mask (Photoshop convention the
      //    properties panel relies on). Deterministic surface id: idempotent.
      if (n.kind === 'adjustment' && n.layerMask === null) {
        n = { ...n, layerMask: defaultLayerMask(docBounds, `s_mask_${n.id}`) }
        sink.debug('validate.adjustmentMask', 'Adjustment layer given its default white mask', n.id)
        mark()
      }

      // 4. Recurse, and hoist artboards: they may only live at the root.
      if (isContainer(n)) {
        const children = visit(n.children, false)
        if (children !== n.children) { n = { ...n, children } as Layer }
        if (n.kind === 'artboard' && !isRoot) {
          sink.warn('validate.nestedArtboard', 'Nested artboard lifted to the root', n.id)
          lifted.push(n)
          mark()
          continue
        }
      }

      // 5. A group's isolation flag is derived, never authored.
      if (n.kind === 'group') {
        const iso = needsIsolation(n as GroupLayer)
        if ((n as GroupLayer).isolated !== iso) {
          n = { ...(n as GroupLayer), isolated: iso }
          mark()
        }
      }

      out.push(n)
    }

    // 6. The bottom-most sibling cannot be clipped: it has no base below it.
    //    `children[0]` is the TOP of the stack, so the bottom is the last entry.
    if (out.length > 0) {
      const last = out[out.length - 1]
      if (last.clipping) {
        sink.warn('validate.clipBottom', 'Bottom-most layer of a stack cannot be clipped; cleared', last.id, 'clipping')
        out[out.length - 1] = { ...last, clipping: false }
        mark()
      }
    }
    return out
  }

  let root = visit(tree, true)
  if (lifted.length > 0) root = [...root, ...lifted]

  // 7. `isBackground` is only meaningful on the bottom-most ROOT layer, and it
  //    implies a locked position and locked transparency.
  for (let i = 0; i < root.length; i++) {
    const n = root[i]
    if (n.kind !== 'raster' || !n.isBackground) continue
    if (i !== root.length - 1) {
      sink.warn('validate.background', 'Only the bottom-most layer can be the Background; flag cleared', n.id)
      root[i] = { ...n, isBackground: false }
      mark()
    } else if (!n.locks.position || !n.locks.transparency) {
      root[i] = { ...n, locks: { ...n.locks, position: true, transparency: true } }
      mark()
    }
  }

  // 8. A document always has at least one layer.
  if (root.length === 0) {
    sink.warn('validate.empty', 'Document had no layer; an empty raster layer was added')
    const bg = createRasterLayer(docBounds, { name: 'Fond', isBackground: true })
    bg.locks = { ...bg.locks, position: true, transparency: true }
    root = [bg]
    mark()
  }

  return { tree: root, warnings: sink.items, repaired }
}
