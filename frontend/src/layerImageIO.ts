// Layer ⇄ drive interop: opens a picture from the Files module as a new Layer
// document.
//
// Routing is driven by the file's MAGIC BYTES, never by its extension or MIME
// type (a PNG renamed `.tif` must still open as a PNG). Four paths:
//
//   • PSD/PSB              → layer/io/psd      — layers, groups and masks preserved
//   • XCF, RAW, HEIC,
//     SVG, PDF             → layer/io/exotic   — lazily loaded per family
//   • TIFF, BMP, ICO,
//     TGA, PNM             → layer/io/formats  — the browser cannot decode these
//   • JPEG, WebP, AVIF,
//     GIF, plain PNG       → createImageBitmap — native, fastest path
//
// Every heavy decoder sits behind a dynamic import, so opening a plain JPEG
// never pays for the PSD or XCF code.
import { filesApi } from '@kubuno/drive'
import { layerApi, type LayerStructureItem } from './api'
import type { ImportedNode } from './layer/io/exotic/types'
import { uid } from './uid'

/** True for standard raster pictures (vector svg is Apex territory). */
export function isRasterImage(mime: string): boolean {
  return mime.startsWith('image/') && mime !== 'image/svg+xml'
}

/** Bytes handed to the sniffer — every signature we know fits well inside this. */
const SNIFF_WINDOW = 4096

/** Refuse absurd documents before allocating anything. */
const MAX_SIDE = 30000
const MAX_PIXELS = 300_000_000

/** What every decode path funnels into before the document is created. */
interface ImportedForLayer {
  width:      number
  height:     number
  title:      string
  structure:  LayerStructureItem[]
  warnings:   string[]
  /** Free-form origin string, useful in bug reports. */
  provenance: string
}

function stripExt(name: string): string {
  return name.replace(/\.[^.]+$/, '')
}

function blankLayer(name: string): LayerStructureItem {
  return {
    id: uid(), type: 'raster', name, visible: true, locked: false,
    opacity: 100, blendMode: 'normal', mask: null, effects: [],
  }
}

function guardSize(w: number, h: number): void {
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    throw new Error(`invalid image size ${w}x${h}`)
  }
  if (w > MAX_SIDE || h > MAX_SIDE || w * h > MAX_PIXELS) {
    throw new Error(`image too large to open (${w}x${h})`)
  }
}

/**
 * Encodes straight RGBA8 to a PNG data URL.
 *
 * The wire model stores layer pixels as PNG data URLs, so a data URL is what we
 * have to produce. Passing a layer's TIGHT rectangle here rather than a
 * document-sized bitmap is what keeps a 40-layer PSD from becoming a
 * several-hundred-megabyte payload: `LayerStructureItem.x`/`y` carry the origin
 * and the editor's loader places it there.
 */
function rgbaToPngDataUrl(data: Uint8Array | Uint8ClampedArray, w: number, h: number): string {
  const canvas = document.createElement('canvas')
  canvas.width = w; canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas 2d unavailable')
  ctx.putImageData(new ImageData(new Uint8ClampedArray(data), w, h), 0, 0)
  return canvas.toDataURL('image/png')
}

function bitmapToPngDataUrl(bmp: ImageBitmap): string {
  const canvas = document.createElement('canvas')
  canvas.width = bmp.width; canvas.height = bmp.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas 2d unavailable')
  ctx.drawImage(bmp, 0, 0)
  return canvas.toDataURL('image/png')
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

// ── Path 1: PSD / PSB ────────────────────────────────────────────────────────
async function importPsd(bytes: Uint8Array, name: string): Promise<ImportedForLayer> {
  const { readPsd, psdToKubuno } = await import('./layer/io/psd/index')
  const psd = await readPsd(toArrayBuffer(bytes))
  const mapped = await psdToKubuno(psd)
  guardSize(mapped.width, mapped.height)

  // The mapper hands back tight rectangles on purpose (its "E1" note): attach
  // them along with each layer's own origin instead of expanding to doc size.
  const attach = (nodes: LayerStructureItem[]): void => {
    for (const node of nodes) {
      const px = mapped.pixels.get(node.id)
      if (px) {
        node.data = rgbaToPngDataUrl(px.data, px.w, px.h)
        node.x = px.x
        node.y = px.y
      }
      const mk = mapped.masks.get(node.id)
      if (mk && node.mask) node.mask_data = rgbaToPngDataUrl(mk.data, mk.w, mk.h)
      if (node.children) attach(node.children)
    }
  }
  attach(mapped.layers)

  return {
    width: mapped.width, height: mapped.height, title: stripExt(name),
    structure: mapped.layers,
    warnings: mapped.warnings.map((w: unknown) => String((w as { message?: string }).message ?? w)),
    provenance: `PSD · ${mapped.width}x${mapped.height}`,
  }
}

// ── Path 2: XCF / RAW / HEIC / SVG / PDF ─────────────────────────────────────
async function importExotic(bytes: Uint8Array, formatId: string, name: string): Promise<ImportedForLayer> {
  const { decodeExotic } = await import('./layer/io/exotic/index')
  const docs = await decodeExotic(bytes, formatId, { name })
  const first = docs[0]
  if (!first) throw new Error(`${formatId}: decoder produced no document`)
  guardSize(first.width, first.height)

  // These decoders return document-sized RGBA with the offset already baked in,
  // so no per-layer origin is needed on this path.
  const convert = async (nodes: readonly ImportedNode[]): Promise<LayerStructureItem[]> => {
    const out: LayerStructureItem[] = []
    for (const n of nodes) {
      const item = blankLayer(n.name)
      item.visible = n.visible
      item.opacity = n.opacity
      item.blendMode = n.blendMode
      if (n.locked) item.locked = true
      if (n.lockAlpha) item.lockAlpha = true
      if (n.lockPosition) item.lockPosition = true
      if (n.colorLabel) item.colorLabel = n.colorLabel

      if (n.kind === 'group') {
        item.type = 'group'
        item.expanded = n.expanded
        item.children = await convert(n.children)
      } else {
        if (n.clipping) item.clipping = true
        const p = n.pixels
        if (p.kind === 'rgba8') {
          item.data = rgbaToPngDataUrl(p.data, p.width, p.height)
        } else {
          const bmp = await createImageBitmap(p.blob)
          item.data = bitmapToPngDataUrl(bmp)
          bmp.close()
        }
        if (n.mask) {
          item.mask = { enabled: n.mask.enabled, inverted: n.mask.inverted, layerId: item.id }
          // Masks are one byte per pixel; expand to grey RGBA so they survive PNG.
          const src = n.mask.data
          const rgba = new Uint8ClampedArray(src.length * 4)
          for (let i = 0; i < src.length; i++) {
            const v = src[i]
            rgba[i * 4] = v; rgba[i * 4 + 1] = v; rgba[i * 4 + 2] = v; rgba[i * 4 + 3] = 255
          }
          item.mask_data = rgbaToPngDataUrl(rgba, first.width, first.height)
        }
      }
      out.push(item)
    }
    return out
  }

  return {
    width: first.width, height: first.height, title: first.title || stripExt(name),
    structure: await convert(first.layers),
    warnings: first.warnings.map(w => String((w as { message?: string }).message ?? w)),
    provenance: first.provenance,
  }
}

// ── Path 3: formats needing our own decoder (TIFF, BMP, ICO, TGA, PNM) ───────
async function importViaFormats(bytes: Uint8Array, formatId: string, name: string): Promise<ImportedForLayer> {
  // Import the narrow modules, NOT the `formats/index` barrel: the barrel
  // statically re-exports every codec, which defeats the per-format dynamic
  // imports declared in `descriptors.ts` (rolldown reports it as
  // INEFFECTIVE_DYNAMIC_IMPORT) and would pull TIFF+BMP+ICO+TGA+PNM in at once.
  const [{ formats }, { registerRasterFormats }, { bufferSource }, { toRgba8 }] = await Promise.all([
    import('./layer/io/formats/registry'),
    import('./layer/io/formats/descriptors'),
    import('./layer/io/formats/bytes'),
    import('./layer/io/formats/bmp'),
  ])
  registerRasterFormats()
  const descriptor = formats.byId(formatId)
  if (!descriptor?.read) throw new Error(`${formatId}: no reader registered`)

  const warnings: string[] = []
  const decoded = await descriptor.read(
    bufferSource(bytes),
    { name, mainPagesOnly: true, maxPixels: MAX_PIXELS },
    { warn: w => warnings.push(`${w.severity}/${w.code} (${w.messageKey})`) },
  )
  // Multi-page files (TIFF, ICO) open on their first main page; the rest are
  // reachable once the format picker dialog lands.
  const page = decoded.pages[0]
  if (!page) throw new Error(`${formatId}: no decodable page`)
  const image = page.image
  guardSize(image.width, image.height)
  const rgba = toRgba8(image)

  const layer = blankLayer('Fond')
  layer.data = rgbaToPngDataUrl(rgba, image.width, image.height)
  if (decoded.pages.length > 1) {
    warnings.push(`${decoded.pages.length} pages found; only the first was opened`)
  }
  return {
    width: image.width, height: image.height, title: stripExt(name),
    structure: [layer], warnings,
    provenance: `${formatId} · ${image.width}x${image.height} · ${decoded.pages.length} page(s)`,
  }
}

// ── Path 4: native browser decode (JPEG, WebP, AVIF, GIF, plain PNG) ─────────
async function importNative(blob: Blob, name: string): Promise<ImportedForLayer> {
  const bmp = await createImageBitmap(blob)
  const w = bmp.width, h = bmp.height
  guardSize(w, h)
  const layer = blankLayer('Fond')
  layer.data = bitmapToPngDataUrl(bmp)
  bmp.close()
  return {
    width: w, height: h, title: stripExt(name),
    structure: [layer], warnings: [],
    provenance: `native · ${w}x${h}`,
  }
}

/** Formats the browser cannot decode at all, so our own codecs must. */
const OWN_DECODER = new Set(['tiff', 'bmp', 'ico', 'cur', 'tga', 'pnm'])
/** Families that live in layer/io/exotic. */
const EXOTIC = new Set(['xcf', 'heif', 'svg', 'pdf'])

async function decodeAny(blob: Blob, name: string): Promise<ImportedForLayer> {
  const head = new Uint8Array(await blob.slice(0, SNIFF_WINDOW).arrayBuffer())
  const { sniff } = await import('./layer/io/formats/sniff')
  const verdict = sniff({ head, size: blob.size, name })

  // Unrecognised: still give the browser a chance, it may know a container we
  // do not sniff for.
  if (!verdict) return importNative(blob, name)

  const id = verdict.id
  if (id === 'psd')                        return importPsd(new Uint8Array(await blob.arrayBuffer()), name)
  if (EXOTIC.has(id) || id.startsWith('raw-')) return importExotic(new Uint8Array(await blob.arrayBuffer()), id, name)
  if (OWN_DECODER.has(id))                 return importViaFormats(new Uint8Array(await blob.arrayBuffer()), id, name)
  return importNative(blob, name)
}

/** Opens a drive picture in Layer. Returns the new document id. */
export async function openImageAsLayer(file: { id: string; name: string }): Promise<string> {
  const resp = await fetch(`${filesApi.downloadUrl(file.id)}?inline=1`, { credentials: 'include' })
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  const blob = await resp.blob()

  const imported = await decodeAny(blob, file.name)
  if (imported.warnings.length) {
    console.warn(`[layer] ${file.name}: ${imported.provenance} —`, imported.warnings)
  }

  const { id } = (await layerApi.createDoc({
    title: imported.title, width: imported.width, height: imported.height,
  })).data
  await layerApi.saveStructure(id, imported.structure, imported.structure.length)
  return id
}
