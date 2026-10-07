// Static registration point for tool handlers.
//
// Importing this module is what pulls every tool file in and runs its
// `registerTool` call. It is the ONLY file that knows the full list, which keeps
// each tool file free of cross-references — add a tool by adding one line here.
//
// Owned by the integrator: tool files must not edit it.

// Side-effect imports: each one runs its file's `registerTool` calls.
import './focusTone'
import './healing'
import './measure'
import './move'
import './paintExtra'
import './pen'
import './select'
import './shapes'
import './stamp'

export { getTool, hasTool, registerTool, registeredTools } from './registry'
export type { ToolContext, ToolHandler, ToolPointer, SelectMode, Rect } from './types'
