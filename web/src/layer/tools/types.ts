// Declarative description of the Layer editor toolbox — the CONTRACT every other
// file in `layer/tools/` and every consumer in `LayerEditorPage` reads.
//
// Nothing here renders: this module only describes tools, families and their
// option bars as DATA. The UI components (`ToolRail`, `ToolOptionsBar`) loop over
// that data; they never hardcode a tool or an option. Adding a tool is adding a
// row in `toolDefs.ts`, never a new branch in a JSX ternary cascade.
import type { LucideIcon } from 'lucide-react'
import type { BLEND_KEYS } from '../model/blend'

// ── Identifiers ──────────────────────────────────────────────────────────────

/** Blend modes understood by the compositing shader (see `layer/model/blend.ts`). */
export type BlendMode = (typeof BLEND_KEYS)[number]

/** The 65 tools, grouped by their flyout family (F01…F20). */
export type ToolId =
  // F01 move
  | 'move' | 'artboard'
  // F02 marquee
  | 'marquee-rect' | 'marquee-ellipse' | 'marquee-row' | 'marquee-column'
  // F03 lasso
  | 'lasso-free' | 'lasso-poly' | 'lasso-magnetic'
  // F04 autoselect
  | 'quick-select' | 'magic-wand' | 'object-select'
  // F05 crop
  | 'crop' | 'crop-perspective' | 'slice' | 'slice-select'
  // F06 sample
  | 'eyedropper' | 'color-sampler' | 'ruler' | 'note'
  // F07 healing
  | 'spot-heal' | 'heal' | 'patch' | 'content-move' | 'red-eye'
  // F08 paint
  | 'brush' | 'pencil' | 'color-replace' | 'mixer-brush'
  // F09 stamp
  | 'clone-stamp' | 'pattern-stamp'
  // F10 history
  | 'history-brush' | 'art-history-brush'
  // F11 eraser
  | 'eraser' | 'bg-eraser' | 'magic-eraser'
  // F12 fill
  | 'gradient' | 'bucket'
  // F13 focus
  | 'blur' | 'sharpen' | 'smudge'
  // F14 tone
  | 'dodge' | 'burn' | 'sponge'
  // F15 pen
  | 'pen' | 'pen-free' | 'pen-curvature' | 'anchor-add' | 'anchor-remove' | 'anchor-convert'
  // F16 text
  | 'text-h' | 'text-v' | 'text-mask-h' | 'text-mask-v'
  // F17 pathsel
  | 'path-select' | 'direct-select'
  // F18 shape
  | 'shape-rect' | 'shape-rrect' | 'shape-ellipse' | 'shape-polygon' | 'shape-line' | 'shape-custom'
  // F19 navigate
  | 'hand' | 'rotate-view'
  // F20 zoom
  | 'zoom'

/** The 20 flyout families. One rail button per family (fewer when merged). */
export type FamilyId =
  | 'move' | 'marquee' | 'lasso' | 'autoselect' | 'crop'
  | 'sample' | 'healing' | 'paint' | 'stamp' | 'history'
  | 'eraser' | 'fill' | 'focus' | 'tone' | 'pen'
  | 'text' | 'pathsel' | 'shape' | 'navigate' | 'zoom'

/** Delivery priority of a tool — drives what ships first, not the rendering. */
export type ToolPriority = 'P0' | 'P1' | 'P2'

/**
 * Responsive weight of an option control.
 * 0 = always visible · 1 = first to collapse on desktop · 2 = mobile sheet only.
 */
export type OptionPriority = 0 | 1 | 2

/** Values held by the editor for the active tool, keyed by `ToolOption.id`. */
export type ToolValues = Record<string, string | number | boolean>

// ── Options ──────────────────────────────────────────────────────────────────

/** One entry of a `select` / `segmented` control. */
export interface ToolChoice {
  value: string
  labelKey: string
  /** Rendered instead of the label in `segmented` controls. */
  icon?: LucideIcon
}

/**
 * Actions are dispatched by id; the editor owns the implementations, the toolbox
 * only says which button exists and where it sits.
 */
export type ActionId =
  // selection
  | 'refine-edge' | 'select-mask' | 'select-subject' | 'select-similar' | 'select-grow'
  // crop & slices
  | 'crop-apply' | 'crop-cancel' | 'crop-straighten'
  | 'slices-from-guides' | 'slice-promote' | 'slice-divide'
  // measure
  | 'sampler-clear' | 'ruler-straighten' | 'ruler-clear' | 'note-author' | 'notes-clear'
  // healing
  | 'patch-apply-pattern'
  // paint
  | 'brush-studio' | 'mixer-load' | 'mixer-clean'
  // text
  | 'text-warp' | 'text-panels' | 'text-apply' | 'text-cancel'
  // align & distribute (rendered inside a popover)
  | 'align-left' | 'align-center-h' | 'align-right'
  | 'align-top' | 'align-center-v' | 'align-bottom'
  | 'distribute-h' | 'distribute-v'
  // view
  | 'view-100' | 'view-fit' | 'view-fill' | 'reset-view'
  // toolbox itself
  | 'tool-reset' | 'tools-reset-all'

/** Read-only measures the options bar displays; the editor supplies the text. */
export type ReadoutId =
  | 'crop-size' | 'zoom-level' | 'view-rotation'
  | 'ruler-measure' | 'sampler-count'
  | 'clone-source-hint' | 'anchor-hint'

/** Fields shared by every option kind. */
export interface ToolOptionBase {
  /** Key inside `ToolValues`; stable, kebab-case. Later blocks override on clash. */
  id: string
  /** i18n key, `layer_topt_*`. */
  labelKey: string
  /** Shown instead of the label when horizontal space is tight. */
  icon?: LucideIcon
  /** 0 = always visible, 1 = collapses first on desktop, 2 = mobile sheet only. */
  priority: OptionPriority
  /** Hidden when the predicate returns false (e.g. pattern picker unless source = pattern). */
  visibleIf?: (v: ToolValues) => boolean
  /** Greyed out but still visible — discoverability beats a disappearing control. */
  disabledIf?: (v: ToolValues) => boolean
  /** i18n key of the tooltip shown on the control. */
  help?: string
  /** Optional fixed width (px) for the rendered control. */
  width?: number
  /** Suffix rendered after the value (`%`, `px`, `°`…) — free text, not an i18n key. */
  unit?: string
}

export type ToolOption =
  | (ToolOptionBase & { kind: 'slider'; min: number; max: number; step?: number; def: number })
  | (ToolOptionBase & { kind: 'number'; min: number; max: number; step?: number; def: number })
  | (ToolOptionBase & { kind: 'select'; choices: ToolChoice[]; def: string })
  | (ToolOptionBase & { kind: 'segmented'; choices: ToolChoice[]; def: string })
  | (ToolOptionBase & { kind: 'toggle'; def: boolean })
  | (ToolOptionBase & { kind: 'color'; def: 'fg' | 'bg' | string })
  | (ToolOptionBase & { kind: 'brush'; def: string })
  | (ToolOptionBase & { kind: 'gradient'; def: string })
  | (ToolOptionBase & { kind: 'pattern'; def: string })
  | (ToolOptionBase & { kind: 'shape'; def: string })
  | (ToolOptionBase & { kind: 'blend'; def: BlendMode })
  | (ToolOptionBase & { kind: 'font'; def: string })
  | (ToolOptionBase & { kind: 'action'; run: ActionId; variant?: 'primary' | 'ghost' })
  | (ToolOptionBase & { kind: 'readout'; read: ReadoutId })
  | (ToolOptionBase & { kind: 'popover'; items: ToolOption[] })

/** Discriminant of `ToolOption` — handy for exhaustive switches in renderers. */
export type ToolOptionKind = ToolOption['kind']

/** Kinds that hold no value of their own (nothing to seed in `ToolValues`). */
export const VALUELESS_KINDS: readonly ToolOptionKind[] = ['action', 'readout', 'popover']

// ── Tools ────────────────────────────────────────────────────────────────────

/** The five option blocks that factor out ~80 % of the options bars. */
export type OptionBlockId = 'selection' | 'brushCore' | 'sampling' | 'shapeStyle' | 'transformCommon'

/** Layer kinds a tool can operate on; the rail greys out what cannot apply. */
export type ToolRequirement = 'raster' | 'vector' | 'text' | 'selection'

/** Modifier keys a tool consumes, so the shell does not steal them. */
export type ToolModifier = 'alt' | 'shift' | 'ctrl' | 'space'

export interface ToolDef {
  id: ToolId
  family: FamilyId
  /** i18n key, `layer_tool_*`. */
  nameKey: string
  Icon: LucideIcon
  priority: ToolPriority
  /** Extra keystroke beyond the family letter (`Maj+B`, `R`…), for the flyout hint. */
  shortcut?: string
  /** CSS cursor, or a named custom cursor rendered from the brush size. */
  cursor?: string | 'brush-outline'
  /** Option blocks reused as-is, then merged with `options` (later wins on id clash). */
  blocks?: OptionBlockId[]
  /** Ids inherited from `blocks` that this tool drops (e.g. the pencil has no hardness). */
  omit?: string[]
  /** Per-tool overrides of an inherited option, merged field by field onto it. */
  overrides?: Record<string, Partial<ToolOption>>
  options?: ToolOption[]
  claims?: ToolModifier[]
  requires?: ToolRequirement[]
}

// ── Families ─────────────────────────────────────────────────────────────────

export interface ToolFamily {
  id: FamilyId
  /** i18n key, `layer_fam_*`. */
  nameKey: string
  /** Single uppercase letter; undefined for the focus family, which has none. */
  shortcut?: string
  /** Ordered members: also the Shift+key cycle order. */
  tools: ToolId[]
  defaultTool: ToolId
  /** Fallback icon when the family is merged with another one on a short rail. */
  Icon: LucideIcon
}

/**
 * A family as the rail actually shows it. Identical to `ToolFamily` when nothing
 * was merged; `mergedFrom` lists the absorbed families on a cramped rail.
 */
export interface RailFamily extends ToolFamily {
  mergedFrom?: FamilyId[]
}

// ── Runtime state ────────────────────────────────────────────────────────────

/** The toolbox slice the editor owns; persisted through `userPrefs.ts`. */
export interface ToolboxState {
  /** Active tool. */
  tool: ToolId
  /** Last tool used per family — what the family button shows and selects. */
  lastPerFam: Partial<Record<FamilyId, ToolId>>
  /** Per-tool option values, so each tool finds its settings back next session. */
  values: Partial<Record<ToolId, ToolValues>>
  /** Open flyout, `null` when closed. */
  flyout: FamilyId | null
  /** Temporary tool while a modifier is held (space → hand, etc.). */
  transient: ToolId | null
}

/** Persistence key for `lastPerFam` (userPrefs, localStorage fallback). */
export const FAMILY_TOOL_PREF_KEY = 'paintsharp:layer:familyTool'

/** Persistence key for per-tool option values. */
export const TOOL_VALUES_PREF_KEY = 'paintsharp:layer:toolValues'
