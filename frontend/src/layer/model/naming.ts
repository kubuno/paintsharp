// Display-name translation for default layer names.
//
// The stored value stays canonical ("Fond", "Calque 3") so logic and persistence
// are language-independent; only the rendered label is translated.
// Extracted verbatim from LayerEditorPage during the layer/ refactor.
import type { TFunction } from 'i18next'

export function displayLayerName(t: TFunction, name: string): string {
  if (name === 'Fond') return t('layer_default_background')
  const m = name.match(/^Calque (\d+)$/)
  if (m) return t('layer_default_layer', { n: m[1] })
  return name
}
