// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Neutral pivot model for the exotic-format importers (spec 07 §3.1).
//
// Every exotic decoder (XCF, RAW preview, HEIF, SVG, PDF) produces this exact shape,
// which is deliberately independent of Layer's persistence model: it can therefore be
// produced and asserted upon without a backend, without React and without a DOM.
//
// Architecture rule (CLAUDE.md §7 / spec 05 §12): nothing under `layer/io/**` imports
// React or `@kubuno/*`. `BlendMode` is imported as a *type only*, so it contributes no
// runtime code and no chunk edge.

import type { BlendMode } from '../../blend/modes'

export type { BlendMode }

/** Non-fatal issue, surfaced to the user as ONE grouped notice, never as a toast storm. */
export interface ImportWarning {
  /** Stable machine code, e.g. `'xcf.approximated-blend-mode'`. */
  readonly code: string
  /** i18n key resolved by the UI. */
  readonly messageKey: string
  readonly params?: Record<string, string | number>
}

/** Builds a warning whose i18n key is derived from its code (`layer.io.warn.<code>`). */
export function importWarn(code: string, params?: Record<string, string | number>): ImportWarning {
  return { code, messageKey: `layer.io.warn.${code}`, params }
}

/**
 * Bounded warning collector. A pathological file must not be able to accumulate a
 * million warnings, and repeating the same code a hundred times helps nobody: each code
 * is kept once, with the number of occurrences.
 */
export class ImportWarningSink {
  private readonly byCode = new Map<string, { w: ImportWarning; count: number }>()

  warn(w: ImportWarning): void {
    const seen = this.byCode.get(w.code)
    if (seen) {
      seen.count += 1
      return
    }
    if (this.byCode.size >= 64) return
    this.byCode.set(w.code, { w, count: 1 })
  }

  /** Warnings in first-seen order; `params.count` carries the number of occurrences. */
  list(): readonly ImportWarning[] {
    return [...this.byCode.values()].map(({ w, count }) =>
      count > 1 ? { ...w, params: { ...w.params, count } } : w,
    )
  }
}

interface ImportedNodeBase {
  readonly name: string
  readonly visible: boolean
  /** 0..100, matching `LayerStructureItem.opacity`. */
  readonly opacity: number
  readonly blendMode: BlendMode
  readonly locked?: boolean
  readonly lockAlpha?: boolean
  readonly lockPosition?: boolean
  /** Hex colour of the layer-panel tag, or undefined for none. */
  readonly colorLabel?: string
}

/**
 * Pixel payload of a raster node.
 *
 * The union exists because a Worker-side decoder wants to PNG-encode each layer as soon
 * as it is produced and release the RGBA buffer, whereas a test or a synchronous caller
 * wants the raw samples (spec 07 §4.13).
 */
export type RasterPayload =
  | { readonly kind: 'rgba8'; readonly data: Uint8ClampedArray; readonly width: number; readonly height: number }
  | { readonly kind: 'png-blob'; readonly blob: Blob; readonly width: number; readonly height: number }

export interface ImportedRaster extends ImportedNodeBase {
  readonly kind: 'raster'
  /** Full-document-sized, non-premultiplied RGBA8 (the offset is baked in — §3.3). */
  readonly pixels: RasterPayload
  /** Full-document-sized, 1 byte per pixel, 0 = fully masked. */
  readonly mask?: {
    readonly data: Uint8ClampedArray
    readonly enabled: boolean
    readonly inverted: boolean
  }
  readonly clipping?: boolean
}

export interface ImportedGroup extends ImportedNodeBase {
  readonly kind: 'group'
  readonly expanded: boolean
  readonly children: readonly ImportedNode[]
  /** XCF `PASS_THROUGH` (GimpLayerMode 61) lands here. */
  readonly passThrough?: boolean
}

export type ImportedNode = ImportedRaster | ImportedGroup

export interface ImportedDocument {
  readonly width: number
  readonly height: number
  /** Suggested title — the file name without its extension. */
  readonly title: string
  /** TOP-FIRST, exactly like `LayerStructureItem[]` (spec 07 §3.2 — XCF agrees, PSD does not). */
  readonly layers: readonly ImportedNode[]
  readonly dpi?: number
  /** Embedded ICC profile, carried but NOT applied by v1 (§3.4). */
  readonly iccProfile?: Uint8Array
  readonly warnings: readonly ImportWarning[]
  /** Free-form provenance for bug reports: `"XCF v22 · RLE · u16 non-linear · 14 layers"`. */
  readonly provenance: string
}

export interface DecodeOptions {
  /** Original file name; only used for the document title. */
  readonly name?: string
  /** `width * height * layerCount` ceiling before the caller must offer to flatten (§3.3). */
  readonly maxPixelBudget?: number
  readonly signal?: AbortSignal
  /** 0..1. Called at most a few dozen times for a whole document. */
  onProgress?(fraction: number): void
}

/** Default pixel budget: 350 Mpx of layer surface, per spec 07 §3.3. */
export const DEFAULT_PIXEL_BUDGET = 350_000_000

/** Walks a layer tree depth-first, parents before children. */
export function* walkNodes(nodes: readonly ImportedNode[]): Generator<ImportedNode> {
  for (const n of nodes) {
    yield n
    if (n.kind === 'group') yield* walkNodes(n.children)
  }
}

export function countNodes(nodes: readonly ImportedNode[]): { rasters: number; groups: number } {
  let rasters = 0
  let groups = 0
  for (const n of walkNodes(nodes)) {
    if (n.kind === 'group') groups += 1
    else rasters += 1
  }
  return { rasters, groups }
}
