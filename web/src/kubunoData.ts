/**
 * Cross-module data sharing over the clipboard (JSON envelopes) — producer side.
 *
 * VENDORED from core `@kubuno/sdk` (`DataTransferRegistry`): replace the local
 * copy with `import { … } from '@kubuno/sdk'` once `@kubuno/sdk >= 0.1.3` is
 * published on npm. The runtime contract (envelope shape, `data-kubuno` HTML
 * marker, `core.data-card` extension point) is shared with the host and all
 * consumer modules, so the copies MUST stay in sync.
 */
import { ExtensionRegistry } from '@kubuno/sdk'
import type React from 'react'

export interface KubunoDataEnvelope {
  kubuno: 1
  type: string
  module: string
  title?: string
  text?: string
  href?: string
  data: unknown
}

export const DATA_CARD_EXTENSION = 'core.data-card'

export interface DataCardProps { envelope: KubunoDataEnvelope }

/** Static rendering of an envelope, for consumers that cannot host live React. */
export interface DataCardStaticRender {
  svg?: string
  dataUrl?: string
  width: number
  height: number
}

export interface DataCardRenderer {
  types: string[]
  Component?: React.ComponentType<DataCardProps>
  renderStatic?: (envelope: KubunoDataEnvelope) => Promise<DataCardStaticRender | null>
}

/** Registers this module's card renderer on the shared extension point. */
export function registerDataCardRenderer(moduleId: string, renderer: DataCardRenderer): void {
  ExtensionRegistry.register(DATA_CARD_EXTENSION, moduleId, renderer)
}

function encodeBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function kubunoDataToHtml(envelope: KubunoDataEnvelope): string {
  const b64 = encodeBase64Utf8(JSON.stringify(envelope))
  const label = envelope.text ?? envelope.title ?? envelope.type
  return `<span data-kubuno="${b64}">${escapeHtml(label)}</span>`
}

/** `document.execCommand('copy')` path for browsers without the async clipboard API. */
function execCopy(text: string, html: string): boolean {
  const onCopy = (e: ClipboardEvent) => {
    e.preventDefault()
    e.clipboardData?.setData('text/plain', text)
    e.clipboardData?.setData('text/html', html)
  }
  document.addEventListener('copy', onCopy, true)
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } finally {
    document.removeEventListener('copy', onCopy, true)
  }
}

/** Writes an envelope to the system clipboard (dual `text/plain` + `text/html`). */
export async function copyKubunoData(envelope: KubunoDataEnvelope): Promise<boolean> {
  const text = envelope.text ?? envelope.title ?? JSON.stringify(envelope)
  const html = kubunoDataToHtml(envelope)
  if (typeof navigator !== 'undefined' && navigator.clipboard && typeof ClipboardItem !== 'undefined') {
    try {
      await navigator.clipboard.write([new ClipboardItem({
        'text/plain': new Blob([text], { type: 'text/plain' }),
        'text/html': new Blob([html], { type: 'text/html' }),
      })])
      return true
    } catch { /* permission denied or insecure context: fall back */ }
  }
  return execCopy(text, html)
}
