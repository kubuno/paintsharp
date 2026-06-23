// Shared Paintsharp editor UI library — primitives & shell reused by every Paintsharp
// sub-editor (Layer, Apex, Vertex, Keyframe, Motion, PdfWriter).
export * from './theme'
export { ColorPicker, harmonyColors } from './ColorPicker'
export type { Scheme } from './ColorPicker'
export { ColorField } from './ColorField'
export { useContextMenu, type CtxItem } from './ContextMenu'
// Use the CORE dock (via @kubuno/sdk) so every Dock improvement (column/row
// resize, float snapping, roll-up/maximize, VS-style dock guides) is shared
// instead of duplicated. The old local `./Dock` copy was removed.
export { DockArea } from '@kubuno/sdk'
export type { DockPanel, DockController } from '@kubuno/sdk'
export { Navigator } from './Navigator'
export { MenuBar, type MenuItem } from './MenuBar'
export { paintsharpMenus, type PaintsharpMenu } from './menus'
export { OptNum } from './controls'
export { EditorShell } from './EditorShell'
