// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SVG rasterisation, shared between the Paintsharp sub-modules (spec 07 §7.1-7.2).
//
// Placement note: Apex, PdfWriter and Layer are sub-modules of ONE module — one git
// repository, one `package.json`, one build, one `entry.ts`, one port. The "never import
// across modules" rule of CLAUDE.md §7 governs boundaries between REPOSITORIES; sharing
// inside `paintsharp/frontend/src/` is ordinary internal reuse, and duplicating this file
// is exactly the anti-pattern that rule exists to prevent. What stays forbidden is
// reaching into another sub-module's components, state or routes — hence this neutral
// `shared/` home rather than an import of `ApexEditorPage.tsx`.
//
// The rasteriser is the browser itself: no library is needed, and an SVG drawn through
// an <img> executes no script and loads no external resource, so untrusted SVG can be
// rasterised without an SSRF or XSS path.

export interface SvgRasterOptions {
  /** Scale relative to the SVG's own user units. */
  readonly scale: number
  /** Hard ceiling; the scale is reduced to fit and a warning is reported. */
  readonly maxPixels: number
  /** Transparent when omitted. */
  readonly background?: string
}

export interface SvgRasterResult {
  readonly canvas: OffscreenCanvas
  readonly width: number
  readonly height: number
  /** Intrinsic size found in the document, before scaling. */
  readonly intrinsic: { readonly width: number; readonly height: number }
  /** True when the document declared no usable size and the fallback was applied. */
  readonly sizeGuessed: boolean
  /** True when `maxPixels` forced the requested scale down. */
  readonly scaleReduced: boolean
}

export class SvgParseError extends Error {
  constructor(message = 'the file is not well-formed SVG') {
    super(message)
    this.name = 'SvgParseError'
  }
}

/** Used when a document declares neither size nor viewBox — nothing better exists. */
const FALLBACK_SIZE = 1024

/**
 * Resolves the intrinsic size, which is the part that actually bites.
 *
 * An SVG has no reliable intrinsic size: `width="100%"` with a `viewBox` renders at
 * 300×150 in Chrome (the CSS replaced-element default), which silently destroys the
 * import. The viewBox is therefore authoritative whenever the explicit size is not in
 * absolute units.
 */
export function resolveIntrinsicSize(svg: Element): {
  width: number
  height: number
  guessed: boolean
} {
  const viewBox = parseViewBox(svg.getAttribute('viewBox'))
  const w = parseLength(svg.getAttribute('width'))
  const h = parseLength(svg.getAttribute('height'))

  if (w && h) return { width: w, height: h, guessed: false }
  if (viewBox) {
    // One explicit dimension plus a viewBox: keep the aspect ratio.
    if (w) return { width: w, height: (w * viewBox.height) / viewBox.width, guessed: false }
    if (h) return { width: (h * viewBox.width) / viewBox.height, height: h, guessed: false }
    return { width: viewBox.width, height: viewBox.height, guessed: false }
  }
  return { width: FALLBACK_SIZE, height: FALLBACK_SIZE, guessed: true }
}

/** CSS absolute units only: a percentage is not an intrinsic size. */
function parseLength(raw: string | null): number | undefined {
  if (!raw) return undefined
  const m = /^\s*([+-]?[\d.]+)\s*(px|pt|pc|mm|cm|in|)\s*$/.exec(raw)
  if (!m) return undefined
  const v = Number.parseFloat(m[1])
  if (!Number.isFinite(v) || v <= 0) return undefined
  const perUnit: Record<string, number> = { px: 1, '': 1, pt: 96 / 72, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96 }
  return v * (perUnit[m[2]] ?? 1)
}

function parseViewBox(raw: string | null): { width: number; height: number } | undefined {
  if (!raw) return undefined
  const parts = raw.trim().split(/[\s,]+/).map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return undefined
  const [, , width, height] = parts
  if (width <= 0 || height <= 0) return undefined
  return { width, height }
}

/**
 * Rasterises SVG source into an offscreen canvas.
 *
 * `createImageBitmap(svgBlob)` is NOT used: several engines (Safari in particular) reject
 * SVG there. `new Image()` + `decode()` + `drawImage` is the path that works everywhere,
 * at the cost of requiring a DOM — which is fine, since rasterisation is a main-thread
 * operation anyway.
 */
export async function rasterizeSvg(
  svgText: string,
  opts: SvgRasterOptions,
): Promise<SvgRasterResult> {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml')
  // A parse failure yields a <parsererror> root instead of throwing.
  if (doc.querySelector('parsererror') || doc.documentElement.localName !== 'svg') {
    throw new SvgParseError()
  }
  const svg = doc.documentElement
  const intrinsic = resolveIntrinsicSize(svg)

  const maxScale = Math.sqrt(Math.max(1, opts.maxPixels) / (intrinsic.width * intrinsic.height))
  const scale = Math.max(0.01, Math.min(opts.scale, maxScale))
  const width = Math.max(1, Math.round(intrinsic.width * scale))
  const height = Math.max(1, Math.round(intrinsic.height * scale))

  // Fix the size on the serialised copy, so the <img> gets a defined intrinsic size.
  svg.setAttribute('width', String(width))
  svg.setAttribute('height', String(height))
  if (!svg.getAttribute('viewBox')) {
    svg.setAttribute('viewBox', `0 0 ${intrinsic.width} ${intrinsic.height}`)
  }

  const serialized = new XMLSerializer().serializeToString(svg)
  const url = URL.createObjectURL(new Blob([serialized], { type: 'image/svg+xml;charset=utf-8' }))
  try {
    const img = new Image()
    img.decoding = 'sync'
    img.src = url
    await img.decode()

    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new SvgParseError('2D context unavailable')
    if (opts.background) {
      ctx.fillStyle = opts.background
      ctx.fillRect(0, 0, width, height)
    }
    ctx.drawImage(img, 0, 0, width, height)
    return {
      canvas,
      width,
      height,
      intrinsic,
      sizeGuessed: intrinsic.guessed,
      scaleReduced: scale < opts.scale,
    }
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Font families the document references that the browser cannot resolve. */
export function missingFontFamilies(svgText: string): string[] {
  const families = new Set<string>()
  for (const m of svgText.matchAll(/font-family\s*[:=]\s*["']?([^"';>]+)/gi)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().replace(/^["']|["']$/g, '')
      if (name && !/^(serif|sans-serif|monospace|cursive|fantasy|system-ui|inherit)$/i.test(name)) {
        families.add(name)
      }
    }
  }
  if (families.size === 0 || typeof document === 'undefined') return []
  return [...families].filter((f) => {
    try {
      return !document.fonts.check(`16px "${f.replace(/"/g, '')}"`)
    } catch {
      return false
    }
  })
}
