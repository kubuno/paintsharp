// Pure derivations over the toolbox registry. No React, no DOM, no side effects:
// every function here is deterministic and memoisable, which is what lets the
// options bar and the properties dock share one source of truth.
import { OPTION_BLOCKS } from './optionBlocks'
import {
  ALL_RAIL_FAMILIES, COMPACT_RAIL_GROUPS, FAMILY_MERGE_STAGES, RAIL_CHROME_HEIGHT,
  RAIL_ITEM_PITCH, TOOLS, TOOL_FAMILIES,
} from './toolDefs'
import { VALUELESS_KINDS } from './types'
import type {
  FamilyId, RailFamily, ToolDef, ToolFamily, ToolId, ToolOption, ToolValues,
} from './types'

// ── Lookups ──────────────────────────────────────────────────────────────────

const FAMILY_BY_ID: Record<FamilyId, ToolFamily> = TOOL_FAMILIES.reduce((acc, f) => {
  acc[f.id] = f
  return acc
}, {} as Record<FamilyId, ToolFamily>)

export const familyById = (id: FamilyId): ToolFamily => FAMILY_BY_ID[id]

export const toolById = (id: ToolId): ToolDef => TOOLS[id]

/** The family a tool belongs to. */
export const familyOf = (t: ToolId): ToolFamily => FAMILY_BY_ID[TOOLS[t].family]

/** Every tool id, in family then declaration order. */
export const ALL_TOOL_IDS: ToolId[] = TOOL_FAMILIES.flatMap(f => f.tools)

/** The tool a family button selects: the remembered one, else the family default. */
export function familyTool(
  fam: Pick<ToolFamily, 'id' | 'tools' | 'defaultTool'>,
  lastPerFam?: Partial<Record<FamilyId, ToolId>>,
): ToolId {
  const remembered = lastPerFam?.[fam.id]
  return remembered && fam.tools.includes(remembered) ? remembered : fam.defaultTool
}

// ── Options ──────────────────────────────────────────────────────────────────

/**
 * The full option list of a tool: its blocks in declaration order, then its own
 * options (a later option with the same id replaces the earlier one IN PLACE, so
 * a tool can retune an inherited control without moving it), minus `omit`, plus
 * `overrides`, finally sorted by ascending priority with a STABLE sort so the
 * declaration order survives inside a priority band.
 */
export function optionsFor(t: ToolId): ToolOption[] {
  const def = TOOLS[t]
  if (!def) return []

  const merged: ToolOption[] = []
  const indexOfId = new Map<string, number>()
  const push = (opt: ToolOption) => {
    const at = indexOfId.get(opt.id)
    if (at === undefined) {
      indexOfId.set(opt.id, merged.length)
      merged.push(opt)
    } else {
      merged[at] = opt
    }
  }

  for (const blockId of def.blocks ?? []) for (const opt of OPTION_BLOCKS[blockId]) push(opt)
  for (const opt of def.options ?? []) push(opt)

  let out = merged
  if (def.omit?.length) {
    const dropped = new Set(def.omit)
    out = out.filter(o => !dropped.has(o.id))
  }
  if (def.overrides) {
    const patches = def.overrides
    out = out.map(o => (patches[o.id] ? ({ ...o, ...patches[o.id] } as ToolOption) : o))
  }

  // `Array.prototype.sort` is stable since ES2019, so equal priorities keep their order.
  return out.slice().sort((a, b) => a.priority - b.priority)
}

/** Options currently applicable, i.e. whose `visibleIf` accepts the values. */
export const visibleOptions = (opts: ToolOption[], values: ToolValues): ToolOption[] =>
  opts.filter(o => (o.visibleIf ? o.visibleIf(values) : true))

/** True when the option must render greyed out for these values. */
export const isOptionDisabled = (opt: ToolOption, values: ToolValues): boolean =>
  opt.disabledIf ? opt.disabledIf(values) : false

/** Seed values for a tool, taken from every option's `def` (popovers included). */
export function defaultsFor(t: ToolId): ToolValues {
  const values: ToolValues = {}
  const walk = (opts: ToolOption[]) => {
    for (const o of opts) {
      if (o.kind === 'popover') { walk(o.items); continue }
      if (VALUELESS_KINDS.includes(o.kind)) continue
      values[o.id] = (o as { def: string | number | boolean }).def
    }
  }
  walk(optionsFor(t))
  return values
}

/** Values completed with the defaults of any option the stored state predates. */
export const withDefaults = (t: ToolId, stored?: ToolValues): ToolValues =>
  ({ ...defaultsFor(t), ...(stored ?? {}) })

// ── Shortcuts ────────────────────────────────────────────────────────────────

/** `Maj+B` typed once: 'shift+B' → '⇧B'. Symbols avoid a per-language string. */
export function formatShortcut(shortcut?: string): string {
  if (!shortcut) return ''
  return shortcut
    .split('+')
    .map(part => {
      const p = part.trim().toLowerCase()
      if (p === 'shift') return '⇧'
      if (p === 'alt') return '⌥'
      if (p === 'ctrl' || p === 'control') return '⌃'
      if (p === 'meta' || p === 'cmd') return '⌘'
      if (p === 'space') return '␣'
      return part.trim().toUpperCase()
    })
    .join('')
}

/**
 * Next tool of a family, wrapping around — what `Shift`+the family letter does.
 * Falls back to the family default when the current tool is not a member.
 */
export function cycleNext(fam: FamilyId, cur: ToolId): ToolId {
  const family = FAMILY_BY_ID[fam]
  if (!family || family.tools.length === 0) return cur
  const at = family.tools.indexOf(cur)
  if (at < 0) return family.defaultTool
  return family.tools[(at + 1) % family.tools.length]
}

/** Previous tool of a family, wrapping around (used by the flyout's ArrowUp). */
export function cyclePrev(fam: FamilyId, cur: ToolId): ToolId {
  const family = FAMILY_BY_ID[fam]
  if (!family || family.tools.length === 0) return cur
  const at = family.tools.indexOf(cur)
  if (at < 0) return family.defaultTool
  return family.tools[(at - 1 + family.tools.length) % family.tools.length]
}

/** The family whose letter matches a keystroke, if any (case-insensitive). */
export function familyForKey(key: string): ToolFamily | undefined {
  const k = key.toUpperCase()
  return TOOL_FAMILIES.find(f => f.shortcut === k)
}

/**
 * The tool a bare keystroke should select, honouring the `useShiftCycle` setting:
 * with it on, the letter picks the remembered tool and `Shift` cycles; with it
 * off, the letter itself cycles (the habit of some historical editors).
 */
export function toolForKeystroke(
  key: string,
  opts: { shift: boolean; current: ToolId; lastPerFam?: Partial<Record<FamilyId, ToolId>>; useShiftCycle?: boolean },
): ToolId | null {
  const fam = familyForKey(key)
  if (!fam) return null
  const useShiftCycle = opts.useShiftCycle ?? true
  const inFamily = fam.tools.includes(opts.current)
  const cycling = useShiftCycle ? opts.shift : inFamily
  if (cycling && inFamily) return cycleNext(fam.id, opts.current)
  if (cycling) return fam.defaultTool
  return familyTool(fam, opts.lastPerFam)
}

// ── Responsive rail ──────────────────────────────────────────────────────────

/** Merge `from` into `keep`, concatenating members and recording the provenance. */
function absorb(keep: RailFamily, from: ToolFamily[]): RailFamily {
  if (from.length === 0) return keep
  return {
    ...keep,
    tools: [...keep.tools, ...from.flatMap(f => f.tools)],
    mergedFrom: [...(keep.mergedFrom ?? []), ...from.map(f => f.id)],
  }
}

/** Apply the first `stages` cumulative merge stages to the full family list. */
function applyStages(stages: number): RailFamily[] {
  const byId = new Map<FamilyId, RailFamily>(ALL_RAIL_FAMILIES.map(f => [f.id, { ...f }]))
  const removed = new Set<FamilyId>()
  for (let i = 0; i < stages && i < FAMILY_MERGE_STAGES.length; i++) {
    for (const [keepId, mergeId] of FAMILY_MERGE_STAGES[i]) {
      const keep = byId.get(keepId)
      const merged = byId.get(mergeId)
      if (!keep || !merged || removed.has(keepId) || removed.has(mergeId)) continue
      byId.set(keepId, absorb(keep, [merged]))
      removed.add(mergeId)
    }
  }
  return ALL_RAIL_FAMILIES.filter(f => !removed.has(f.id)).map(f => byId.get(f.id)!)
}

/** The eight-group layout of a very short rail (spec §3.7). */
function compactRail(): RailFamily[] {
  return COMPACT_RAIL_GROUPS.map(g => {
    const keep = { ...FAMILY_BY_ID[g.keep] } as RailFamily
    return absorb(keep, g.absorb.map(id => FAMILY_BY_ID[id]))
  })
}

/** How many family buttons fit in `available` pixels of rail. */
export const railCapacity = (available: number): number =>
  Math.max(1, Math.floor((available - RAIL_CHROME_HEIGHT) / RAIL_ITEM_PITCH))

/**
 * The families the rail should show for the space it has. `available` is the
 * usable height in px for a vertical rail (or width for the mobile strip); the
 * smallest merge stage that fits wins, then the compact eight-group layout.
 */
export function railFamilies(available: number): RailFamily[] {
  const capacity = railCapacity(available)
  if (capacity >= TOOL_FAMILIES.length) return ALL_RAIL_FAMILIES
  for (let stage = 1; stage <= FAMILY_MERGE_STAGES.length; stage++) {
    const list = applyStages(stage)
    if (list.length <= capacity) return list
  }
  return compactRail()
}

/** Tool count of the registry — asserted by the demo page and worth a sanity check. */
export const TOOL_COUNT = ALL_TOOL_IDS.length

/** Family count of the registry. */
export const FAMILY_COUNT = TOOL_FAMILIES.length
