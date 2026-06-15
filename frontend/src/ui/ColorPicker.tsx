// Promoted to the core UI layer (@ui) so every module — not just Paintsharp — can use
// it. Kept here as a thin re-export for back-compat with existing Paintsharp imports.
export { ColorPicker, harmonyColors } from '@ui'
export type { Scheme } from '@ui'
