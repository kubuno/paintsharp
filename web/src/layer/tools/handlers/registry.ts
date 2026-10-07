// Tool handler registry.
//
// Each tool file exports a `ToolHandler` and registers it here. Nothing else in
// the editor imports those files directly, so a new tool never requires touching
// `LayerEditorPage`: the pointer dispatcher just looks the active tool up.
import type { ToolId } from '../types'
import type { ToolHandler } from './types'

const handlers = new Map<ToolId, ToolHandler>()

export function registerTool(id: ToolId, handler: ToolHandler): void {
  if (handlers.has(id)) {
    // A duplicate means two files claim the same tool — worth knowing about,
    // but the first registration wins so behaviour stays deterministic.
    console.warn(`[layer/tools] "${id}" is already registered; ignoring the second handler`)
    return
  }
  handlers.set(id, handler)
}

export const getTool = (id: ToolId): ToolHandler | undefined => handlers.get(id)
export const hasTool = (id: ToolId): boolean => handlers.has(id)

/** Tools driven by a registered handler. Drives which rail entries are live. */
export const registeredTools = (): ToolId[] => [...handlers.keys()]
