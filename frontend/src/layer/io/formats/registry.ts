// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Format registry — SHARED, FROZEN CONTRACT (spec 05 §7).
//
// Three specs write against this file: 05 (fixed raster), 06 (animated formats) and
// 07 (exotic formats). Its shape is the coordination point between them, so it is
// complete from day one — including the members this module does not use yet — and must
// not be reshaped afterwards. Additions are allowed only as new *optional* members.
//
// Golden rule: this file and every descriptor import NO codec statically. A descriptor
// weighs a few hundred bytes (strings plus `() => import(...)` closures); the registry
// on the critical path stays around 4 KiB.
//
// Layout note: spec 05 §12 places this file at `layer/io/registry.ts`. It lives under
// `layer/io/formats/` because that subtree is the only one this agent owns; the intended
// tree (`codecs/`, `tiff/`, one file per format) is mirrored inside it.
//
// Architecture rule (spec 05 §12): nothing under `layer/io/**` may import React,
// `@kubuno/ui` or `@kubuno/drive`. This is pure TypeScript, runnable in a Web Worker and
// testable without a DOM.

import type {
  ColorModel,
  DecodedFile,
  FastProbe,
  ImageMetadata,
  IoWarning,
  RasterImage,
} from './types'

/**
 * Lazily readable bytes. Lets a 2 GiB TIFF be read range-by-range instead of
 * materialising it in memory (spec 05 §8.3). Backed by a Blob or an ArrayBuffer.
 */
export interface ByteSource {
  readonly size: number
  /** Cached, coalesced range reads. `end` is exclusive. */
  slice(start: number, end: number): Promise<Uint8Array>
  /** Whole content — only for formats that genuinely need it. */
  all(): Promise<Uint8Array>
}

export interface IoContext {
  /** 0..1; the UI shows a determinate progress bar. Called at most ~30×/s. */
  onProgress?(fraction: number, stage?: string): void
  readonly signal?: AbortSignal
  /** Non-fatal problems. Never throw for these — collect and report. */
  warn(w: IoWarning): void
}

export interface ReadOptions {
  /** Original file name. Used for the document title and for sniff tie-breaks only. */
  readonly name?: string
  /** Decode a single page of a multi-image file; all pages when omitted. */
  readonly pageIndex?: number
  /** Skip pages whose role is not 'main'/'page' (thumbnails, mipmaps). */
  readonly mainPagesOnly?: boolean
  /** Hard ceiling on `width * height` for one page (spec 05 §8.3). */
  readonly maxPixels?: number
  /** Stop after the header: pixels are not decoded. */
  readonly headerOnly?: boolean
}

export interface EncodeInput {
  /** Already in the target colour model/depth: the pipeline did the conversion (§5.2). */
  readonly image: RasterImage
  /** Extra pages for multi-page formats (TIFF, ICO). */
  readonly pages?: readonly RasterImage[]
  readonly metadata: ImageMetadata
}

/** Base shape of a format's export options; each format narrows it. */
export interface FormatOptions {
  readonly [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Declarative export-dialog schema (spec 05 §7.3). The dialog is generic: adding a
// format adds its dialog for free, and the UI rules (no bold buttons, @ui dropdowns,
// equal-width OK/Cancel) are enforced in one place.
// ---------------------------------------------------------------------------

export type OptionField<O> =
  | {
      kind: 'select'
      key: keyof O
      labelKey: string
      options: readonly { value: string; labelKey: string; disabled?: (o: O) => boolean }[]
      default: string
    }
  | {
      kind: 'slider'
      key: keyof O
      labelKey: string
      min: number
      max: number
      step: number
      default: number
      suffix?: string
    }
  | { kind: 'toggle'; key: keyof O; labelKey: string; default: boolean }
  | { kind: 'number'; key: keyof O; labelKey: string; min?: number; max?: number; default: number }
  | { kind: 'group'; labelKey: string; fields: readonly OptionField<O>[] }
  /** Multi-size picker, used by ICO. */
  | { kind: 'sizes'; key: keyof O; labelKey: string; choices: readonly number[]; default: readonly number[] }

export interface OptionsSchema<O> {
  readonly fields: readonly OptionField<O>[]
  /**
   * Cross-field rules: greys out 4:4:4 below quality 100 (§2.2), disables ICC on formats
   * that cannot carry it, forces BigTIFF past 3.9 GiB (§4.9).
   */
  readonly refine?: (
    o: O,
    ctx: { image: RasterImage; estimatedBytes: number },
  ) => Partial<O> & { warnings?: IoWarning[] }
}

// ---------------------------------------------------------------------------
// The descriptor
// ---------------------------------------------------------------------------

export interface FormatCapabilities {
  readonly maxBitDepth: 8 | 16 | 32
  readonly alpha: boolean
  readonly layers: boolean
  readonly multiPage: boolean
  readonly colorModels: readonly ColorModel[]
  readonly icc: boolean
  readonly exif: boolean
  readonly xmp: boolean
  readonly iptc: boolean
  readonly lossless: boolean | 'optional'
}

export interface FormatDescriptor<O extends FormatOptions = FormatOptions> {
  /** Stable identifier, also the persisted key of user export presets. */
  readonly id: string
  /** Human label, i18n key resolved by the UI. */
  readonly labelKey: string
  /** Lower-case, no dot. First entry is the default extension on export. */
  readonly extensions: readonly string[]
  /** First entry is the canonical MIME used when uploading to Drive. */
  readonly mimes: readonly string[]

  readonly canRead: boolean
  readonly canWrite: boolean

  /**
   * Magic-number sniffing on the first bytes. Must not read beyond `head`, must not
   * allocate proportionally to the file, and must never throw.
   *
   * Returns a CONFIDENCE, not a boolean: several descriptors legitimately match the same
   * signature (TIFF vs CR2 vs DNG vs NEF). Convention (§7.2):
   *   1.0 — exclusive signature (`\x89PNG`, `#?RADIANCE`)
   *   0.9 — shared signature where we are the more specific claimant (CR2/NEF: extra tags checked)
   *   0.6 — shared signature where we are the generic fallback (plain TIFF)
   *   0.0 — no match
   * The registry keeps the maximum; ties are broken by the extension.
   */
  sniff(head: Uint8Array, filename?: string): number

  /**
   * Cheap header-only probe. Never decodes pixels. Drives the native-vs-in-house
   * decision (§3.2) and lets the import dialog show size/pages/depth before any
   * memory is committed.
   */
  probe?(source: ByteSource): Promise<FastProbe>

  /** Full decode. Runs inside a worker. */
  read?(source: ByteSource, opts: ReadOptions, ctx: IoContext): Promise<DecodedFile>

  /** Encode. Runs inside a worker. Returns a Blob — never a data URL (§8.1). */
  write?(input: EncodeInput, opts: O, ctx: IoContext): Promise<Blob>

  /** Declarative description of the export dialog (§9). */
  readonly optionsSchema?: OptionsSchema<O>

  /**
   * Live size estimate without a full encode (§9.5). When absent the UI falls back to
   * encoding a downscaled proxy.
   */
  estimateSize?(input: EncodeInput, opts: O): number | undefined

  /**
   * Which document capabilities survive this format. Drives the pre-export warnings
   * ("this format has no alpha channel", "layers will be flattened").
   */
  readonly capabilities: FormatCapabilities
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** Result of a detection, kept for diagnostics and for the "unsupported" message. */
export interface DetectResult {
  readonly descriptor: FormatDescriptor
  readonly confidence: number
  /** True when the file name suggested a different format than the bytes did. */
  readonly extensionMismatch: boolean
}

export class FormatRegistry {
  private readonly byIdMap = new Map<string, FormatDescriptor>()

  register(d: FormatDescriptor): void {
    this.byIdMap.set(d.id, d)
  }

  byId(id: string): FormatDescriptor | undefined {
    return this.byIdMap.get(id)
  }

  all(): readonly FormatDescriptor[] {
    return [...this.byIdMap.values()]
  }

  /** Test-only. */
  clear(): void {
    this.byIdMap.clear()
  }

  /**
   * Extension first (fast, and the user's intent), magic bytes as arbiter.
   * Extension and content disagreeing is a warning: content always wins.
   */
  detect(head: Uint8Array, filename?: string): FormatDescriptor | undefined {
    return this.detectDetailed(head, filename)?.descriptor
  }

  detectDetailed(head: Uint8Array, filename?: string): DetectResult | undefined {
    const ext = extensionOf(filename)
    let best: FormatDescriptor | undefined
    let bestScore = 0
    for (const d of this.byIdMap.values()) {
      let score = 0
      try {
        score = d.sniff(head, filename)
      } catch {
        // A descriptor must never take detection down with it.
        score = 0
      }
      if (!Number.isFinite(score) || score <= 0) continue
      // Extension only breaks ties: +0.001 can never outrank a stronger signature.
      const adjusted = score + (ext && d.extensions.includes(ext) ? 0.001 : 0)
      if (adjusted > bestScore) {
        bestScore = adjusted
        best = d
      }
    }
    if (!best) return undefined
    const mismatch = ext !== null && !best.extensions.includes(ext)
    return { descriptor: best, confidence: Math.min(1, bestScore), extensionMismatch: mismatch }
  }

  readable(): readonly FormatDescriptor[] {
    return this.all().filter((d) => d.canRead)
  }

  writable(): readonly FormatDescriptor[] {
    return this.all().filter((d) => d.canWrite)
  }

  /** MIME/extension lists for FileTypeRegistry (entry.ts) and drive pickers. */
  acceptedMimes(): readonly string[] {
    return dedupe(this.readable().flatMap((d) => d.mimes))
  }

  acceptedExtensions(): readonly string[] {
    return dedupe(this.readable().flatMap((d) => d.extensions))
  }
}

export const formats = new FormatRegistry()

function extensionOf(name: string | undefined): string | null {
  if (!name) return null
  const i = name.lastIndexOf('.')
  if (i < 0 || i === name.length - 1) return null
  return name.slice(i + 1).toLowerCase()
}

function dedupe(xs: readonly string[]): string[] {
  return [...new Set(xs)]
}
