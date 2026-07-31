// Bridge between the editor's historical 15-tool union and the 65-tool,
// 20-family model in `toolDefs.ts`.
//
// The rail now presents the full Photoshop-shaped family/flyout structure, but
// only the tools the editor can actually perform are selectable. Everything
// else is greyed out rather than hidden: the structure is the point, and a tool
// that silently disappears is harder to reason about than one that is visibly
// not ready yet.
//
// `transform` has no rail entry on purpose — the spec reclassifies free
// transform as a COMMAND (Ctrl+T), which is also what Photoshop does. It stays
// reachable from the keyboard and the menus.
import { ALL_TOOL_IDS } from './helpers'
import type { ToolId } from './types'

/** The editor's own tool union (mirrors `Tool` in LayerEditorPage). */
export type LegacyTool =
  | 'select' | 'brush' | 'eraser' | 'eyedrop' | 'fill' | 'hand' | 'crop' | 'text'
  | 'rect-sel' | 'ellipse-sel' | 'lasso' | 'magic' | 'transform' | 'zoom' | 'rotate'

/** Legacy tool → the rail entry that stands for it. */
export const LEGACY_TO_TOOL: Record<Exclude<LegacyTool, 'transform'>, ToolId> = {
  select:        'move',
  brush:         'brush',
  eraser:        'eraser',
  eyedrop:       'eyedropper',
  fill:          'bucket',
  hand:          'hand',
  crop:          'crop',
  text:          'text-h',
  'rect-sel':    'marquee-rect',
  'ellipse-sel': 'marquee-ellipse',
  lasso:         'lasso-free',
  magic:         'magic-wand',
  zoom:          'zoom',
  rotate:        'rotate-view',
}

/** Rail entry → the editor behaviour it drives. */
export const TOOL_TO_LEGACY: Partial<Record<ToolId, LegacyTool>> = Object.fromEntries(
  Object.entries(LEGACY_TO_TOOL).map(([legacy, id]) => [id, legacy as LegacyTool]),
) as Partial<Record<ToolId, LegacyTool>>

/** Tools the editor can genuinely perform today. */
export const IMPLEMENTED_TOOLS: ToolId[] = Object.values(LEGACY_TO_TOOL)

/**
 * Everything else — passed to `ToolRail.disabledTools` so the families and their
 * flyouts render in full while unavailable entries stay unselectable.
 */
export const UNIMPLEMENTED_TOOLS: ToolId[] =
  ALL_TOOL_IDS.filter(id => !IMPLEMENTED_TOOLS.includes(id))

/** Rail selection → editor tool, or null when the entry is not wired yet. */
export function legacyForTool(id: ToolId): LegacyTool | null {
  return TOOL_TO_LEGACY[id] ?? null
}

/** Editor tool → the rail entry to highlight. Transform borrows the move button. */
export function toolForLegacy(t: LegacyTool): ToolId {
  return t === 'transform' ? 'move' : LEGACY_TO_TOOL[t]
}
