/**
 * `paintsharp.vectors` envelope support: builds the envelope from an Apex
 * selection, renders it as a card (chat…) and as a static SVG/PNG on demand
 * (office documents…). Registered on `core.data-card` from `entry.ts`, so
 * consumer modules resolve it dynamically without importing paintsharp.
 */
import { useMemo } from 'react'
import { PenTool } from 'lucide-react'
import { pageDataToSvg } from './apexSvg'
import type { VectorElement, VectorPageData } from './api'
import type { DataCardProps, DataCardStaticRender, KubunoDataEnvelope } from './kubunoData'

export interface VectorsData {
  elements: VectorElement[]
  bbox: { x: number; y: number; w: number; h: number }
}

const PAD = 8

/** Builds an envelope from the selected elements (+ their bounding box). */
export function vectorsEnvelope(elements: VectorElement[], bbox: { x: number; y: number; w: number; h: number }): KubunoDataEnvelope {
  const n = elements.filter(e => e.type !== 'group').length || elements.length
  const title = n === 1
    ? (elements[0]?.name || 'Objet vectoriel')
    : `${n} objets vectoriels`
  return {
    kubuno: 1,
    type: 'paintsharp.vectors',
    module: 'paintsharp',
    title,
    text: `${title} — Apex (${Math.round(bbox.w)}×${Math.round(bbox.h)})`,
    data: { elements, bbox } satisfies VectorsData,
  }
}

function isVectorsData(v: unknown): v is VectorsData {
  const d = v as VectorsData | null
  return !!d && Array.isArray(d.elements) && !!d.bbox
    && Number.isFinite(d.bbox.w) && Number.isFinite(d.bbox.h)
}

/** Rebuilds a minimal page around the copied elements and renders it to SVG. */
export function vectorsToSvg(data: VectorsData): { svg: string; width: number; height: number } {
  const { bbox } = data
  const width = Math.max(1, Math.ceil(bbox.w + PAD * 2))
  const height = Math.max(1, Math.ceil(bbox.h + PAD * 2))
  const pd: VectorPageData = {
    artboards: [{
      id: 'clip', name: 'clip',
      x: bbox.x - PAD, y: bbox.y - PAD, width, height,
      background: 'transparent',
    }],
    elements: data.elements,
    guides: [],
  }
  return { svg: pageDataToSvg(pd), width, height }
}

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

/** SVG → PNG data URL (offscreen canvas), for consumers that prefer raster. */
function rasterizeSvg(svg: string, w: number, h: number): Promise<string | null> {
  return new Promise(resolve => {
    const img = new window.Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      // 2x for crispness, capped to keep documents lightweight.
      const scale = Math.min(2, 1600 / Math.max(w, h, 1))
      canvas.width = Math.max(1, Math.round(w * scale))
      canvas.height = Math.max(1, Math.round(h * scale))
      const ctx = canvas.getContext('2d')
      if (!ctx) { resolve(null); return }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      try { resolve(canvas.toDataURL('image/png')) } catch { resolve(null) }
    }
    img.onerror = () => resolve(null)
    img.src = svgDataUrl(svg)
  })
}

/** `renderStatic` entry of the data-card renderer (async, producer-side). */
export async function renderVectorsStatic(envelope: KubunoDataEnvelope): Promise<DataCardStaticRender | null> {
  if (!isVectorsData(envelope.data)) return null
  const { svg, width, height } = vectorsToSvg(envelope.data)
  const dataUrl = await rasterizeSvg(svg, width, height)
  return { svg, dataUrl: dataUrl ?? undefined, width, height }
}

/** Live card (chat bubbles…): the SVG is rebuilt synchronously from the JSON. */
export function ApexVectorsCard({ envelope }: DataCardProps) {
  const rendered = useMemo(
    () => (isVectorsData(envelope.data) ? vectorsToSvg(envelope.data) : null),
    [envelope],
  )
  if (!rendered) return null
  const maxW = 288
  const scale = Math.min(1, maxW / rendered.width)
  return (
    <div className="w-72 max-w-full rounded-xl border border-border bg-surface-0 overflow-hidden">
      <div
        className="flex items-center justify-center bg-white"
        style={{ backgroundImage: 'repeating-conic-gradient(#f1f3f4 0% 25%, #ffffff 0% 50%)', backgroundSize: '16px 16px' }}
      >
        <img
          src={svgDataUrl(rendered.svg)}
          width={Math.round(rendered.width * scale)}
          height={Math.round(rendered.height * scale)}
          style={{ maxHeight: 220, objectFit: 'contain' }}
          alt={envelope.title ?? 'vectors'}
        />
      </div>
      <div className="px-3 py-2 flex items-center gap-2">
        <PenTool size={14} className="text-primary flex-shrink-0" />
        <p className="text-xs font-semibold text-text-primary truncate">{envelope.title}</p>
      </div>
    </div>
  )
}
