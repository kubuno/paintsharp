// Paintsharp shared menu builder. Every Paintsharp editor gets the same baseline menus
// (Fichier > Enregistrer / Fermer, Édition > Annuler / Rétablir, Affichage >
// Zoom…), wired to its own handlers, plus its own editor-specific menus.
import type { TFunction } from 'i18next'
import type { MenuItem } from './MenuBar'

export type PaintsharpMenu = { label: string; items: MenuItem[] }

export function paintsharpMenus(t: TFunction, o: {
  onSave?: () => void
  onExport?: () => void
  exportLabel?: string
  onClose?: () => void
  onUndo?: () => void
  onRedo?: () => void
  canUndo?: boolean
  canRedo?: boolean
  editExtra?: MenuItem[]                 // extra items appended to the Édition menu
  onZoomIn?: () => void
  onZoomOut?: () => void
  onFit?: () => void
  viewExtra?: MenuItem[]                  // extra items appended to the Affichage menu
  extraMenus?: PaintsharpMenu[]                // editor-specific menus, inserted before Affichage
}): PaintsharpMenu[] {
  const menus: PaintsharpMenu[] = []

  // Fichier
  const file: MenuItem[] = []
  if (o.onSave)   file.push({ label: t('common_save'), onClick: o.onSave, shortcut: 'Ctrl+S' })
  if (o.onExport) file.push({ label: o.exportLabel ?? t('menu_export'), onClick: o.onExport })
  if ((file.length) && o.onClose) file.push('sep')
  if (o.onClose)  file.push({ label: t('menu_close'), onClick: o.onClose })
  if (file.length) menus.push({ label: t('menu_file'), items: file })

  // Édition
  const edit: MenuItem[] = []
  if (o.onUndo) edit.push({ label: t('menu_undo'), onClick: o.onUndo, disabled: o.canUndo === false, shortcut: 'Ctrl+Z' })
  if (o.onRedo) edit.push({ label: t('menu_redo'), onClick: o.onRedo, disabled: o.canRedo === false, shortcut: 'Ctrl+Shift+Z' })
  if (o.editExtra?.length) { if (edit.length) edit.push('sep'); edit.push(...o.editExtra) }
  if (edit.length) menus.push({ label: t('menu_edit'), items: edit })

  // Editor-specific menus
  if (o.extraMenus?.length) menus.push(...o.extraMenus)

  // Affichage
  const view: MenuItem[] = []
  if (o.onZoomIn)  view.push({ label: t('menu_zoom_in'),  onClick: o.onZoomIn })
  if (o.onZoomOut) view.push({ label: t('menu_zoom_out'), onClick: o.onZoomOut })
  if (o.onFit)     view.push({ label: t('menu_fit'),      onClick: o.onFit })
  if (o.viewExtra?.length) { if (view.length) view.push('sep'); view.push(...o.viewExtra) }
  if (view.length) menus.push({ label: t('menu_view'), items: view })

  return menus
}
