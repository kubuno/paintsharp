/*
 * Rebuilds the layer tree from the flat `lsct` divider sequence (spec §5.2).
 *
 * Derived from the GIMP PSD plug-in (file-psd), Copyright 2007 John Marshall,
 * GPLv3+ (`load_resource_lsct()` in psd-layer-res-load.c) and from Adobe's
 * public "Photoshop File Formats Specification". Independent TypeScript
 * re-implementation; no GIMP source was copied. Kubuno is AGPLv3.
 */
import { LIMITS } from '../constants.ts'
import { SECTION_TYPE } from '../additional/common.ts'
import type { PsdLayer, WarningSink } from '../types.ts'
import type { ParsedLayer } from './layerAndMask.ts'

/**
 * Layers arrive BOTTOM-UP. Photoshop writes a folder as:
 *
 *   [lsct = 3]  "</Layer group>"   <- end marker, at the BOTTOM of the content
 *   [content, bottom-up]
 *   [lsct = 1|2] "Folder name"     <- opening marker, at the TOP
 *
 * Walking the list in reverse (top layer first) therefore mirrors exactly what
 * the layers panel shows, and a simple stack rebuilds the tree.
 *
 * @returns the tree, TOP layer first.
 */
export function buildLayerTree(flat: readonly ParsedLayer[], sink: WarningSink): PsdLayer[] {
  const roots: PsdLayer[] = []
  const stack: PsdLayer[][] = [roots]
  let unbalanced = 0

  for (let i = flat.length - 1; i >= 0; i--) {
    const item = flat[i]
    const target = stack[stack.length - 1]
    if (
      item.sectionType === SECTION_TYPE.OPEN_FOLDER ||
      item.sectionType === SECTION_TYPE.CLOSED_FOLDER
    ) {
      const children: PsdLayer[] = []
      const group: PsdLayer = { ...item.base, kind: 'group', children }
      target.push(group)
      if (stack.length < LIMITS.MAX_GROUP_DEPTH) {
        stack.push(children)
      } else {
        // Beyond the nesting cap the content is flattened rather than dropped.
        sink.warn('clipping-flattened', { reason: 'group-depth' })
      }
    } else if (item.sectionType === SECTION_TYPE.DIVIDER) {
      // The bounding section divider closes the group. It is a real layer in
      // the file (empty rect, 4 empty channels) but produces no Kubuno layer.
      if (stack.length > 1) stack.pop()
      else unbalanced++
    } else {
      target.push({ ...item.base, children: [] })
    }
  }

  if (unbalanced > 0) {
    sink.warn('malformed-block-skipped', { unbalancedDividers: unbalanced })
  }
  // Any group left open at the end is closed implicitly.
  return roots
}

/** Depth-first walk of the tree, parents before children. */
export function walkLayers(
  layers: readonly PsdLayer[],
  visit: (layer: PsdLayer, depth: number) => void,
  depth = 0,
): void {
  for (const l of layers) {
    visit(l, depth)
    if (l.children.length > 0) walkLayers(l.children, visit, depth + 1)
  }
}

/** Total number of layers in the tree, groups included. */
export function countLayers(layers: readonly PsdLayer[]): number {
  let n = 0
  walkLayers(layers, () => {
    n++
  })
  return n
}
