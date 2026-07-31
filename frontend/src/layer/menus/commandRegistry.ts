// Layer editor command registry — the single place where a menu entry id is
// bound to real behaviour.
//
// Menu DEFINITIONS (`menuDefs.ts`, `contextMenus.ts`) are pure data: they only
// ever name a command by its id, never a function. The editor registers the
// implementations here, and `build()` compiles definition + registry + current
// state into the `MenuNode` tree consumed by `ui/menuModel.ts` adapters.
//
// Consequences:
//   - `menuDefs.ts` never imports the editor, so it is not a merge-conflict
//     hotspot and can be unit-tested with no React at all;
//   - an entry whose command is not registered yet still shows up, greyed out
//     with an explanatory hint, instead of silently disappearing;
//   - enabled/checked state is resolved in ONE place, from either a predicate
//     function (`isEnabled`) or a declarative expression (`enableWhen`).
import type { ReactNode } from 'react'
import type { TFunction } from 'i18next'
import type { MenuDefinition, MenuItemId, MenuNode } from '../../ui/menuModel'

/* ------------------------------------------------------------- context ----- */

/** Translation function, structurally minimal so the registry stays testable
 *  under plain Node without pulling i18next in. */
export type MenuTranslate = (key: string, options?: { defaultValue?: string } & Record<string, unknown>) => string

// Compile-time proof that i18next's `TFunction` can be passed as `MenuTranslate`.
const _tFunctionIsCompatible: MenuTranslate = null as unknown as TFunction
void _tFunctionIsCompatible

/** State vocabulary used by the `when` / `enableWhen` expressions. Mirrors §0 of
 *  the menu specification: `doc`, `sel`, `clip`, `L`, `L.group`, `L.locked`,
 *  `L.mask`, `nLeaves`, `embedded`… Missing flags read as false / 0. */
export type MenuFlags = Readonly<Record<string, boolean | number>>

export interface MenuContext {
  t: MenuTranslate
  flags: MenuFlags
}

/* --------------------------------------------- declarative predicates ------ */

type Predicate = (flags: MenuFlags) => boolean

const NUM_OPS: Record<string, (a: number, b: number) => boolean> = {
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b,
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
  '==': (a, b) => a === b,
  '!=': (a, b) => a !== b,
}

/**
 * Tiny boolean expression compiler over the flag vocabulary.
 * Grammar: `or := and ('||' and)*`, `and := unary ('&&' unary)*`,
 * `unary := '!' unary | primary`, `primary := '(' or ')' | ident [op number]`.
 * No property access, no calls, no `eval` — it only reads the flags record.
 */
export function compilePredicate(expr: string): Predicate {
  const src = expr.trim()
  let i = 0

  const ws = () => { while (i < src.length && src[i] === ' ') i++ }
  const eat = (tok: string) => { ws(); if (src.startsWith(tok, i)) { i += tok.length; return true } return false }

  const readIdent = (): string => {
    ws()
    const start = i
    while (i < src.length && /[A-Za-z0-9_.]/.test(src[i])) i++
    if (start === i) throw new Error(`menu predicate: identifier expected at ${i} in "${expr}"`)
    return src.slice(start, i)
  }

  const readNumber = (): number => {
    ws()
    const start = i
    if (src[i] === '-') i++
    while (i < src.length && /[0-9.]/.test(src[i])) i++
    const n = Number(src.slice(start, i))
    if (Number.isNaN(n)) throw new Error(`menu predicate: number expected at ${start} in "${expr}"`)
    return n
  }

  const num = (v: boolean | number | undefined): number => (typeof v === 'number' ? v : v ? 1 : 0)

  const parsePrimary = (): Predicate => {
    ws()
    if (eat('(')) {
      const inner = parseOr()
      if (!eat(')')) throw new Error(`menu predicate: ")" expected in "${expr}"`)
      return inner
    }
    const name = readIdent()
    ws()
    for (const op of ['>=', '<=', '==', '!=', '>', '<']) {
      if (src.startsWith(op, i)) {
        i += op.length
        const rhs = readNumber()
        const fn = NUM_OPS[op]
        return flags => fn(num(flags[name]), rhs)
      }
    }
    return flags => !!flags[name]
  }

  const parseUnary = (): Predicate => {
    ws()
    if (eat('!')) { const inner = parseUnary(); return flags => !inner(flags) }
    return parsePrimary()
  }

  const parseAnd = (): Predicate => {
    let left = parseUnary()
    for (;;) {
      ws()
      if (!eat('&&')) return left
      const right = parseUnary()
      const l = left
      left = flags => l(flags) && right(flags)
    }
  }

  function parseOr(): Predicate {
    let left = parseAnd()
    for (;;) {
      ws()
      if (!eat('||')) return left
      const right = parseAnd()
      const l = left
      left = flags => l(flags) || right(flags)
    }
  }

  const root = parseOr()
  ws()
  if (i !== src.length) throw new Error(`menu predicate: unexpected "${src.slice(i)}" in "${expr}"`)
  return root
}

const predicateCache = new Map<string, Predicate>()

/** Evaluates a `when` expression against the current flags (compiled once). */
export function evalWhen(expr: string, flags: MenuFlags): boolean {
  let p = predicateCache.get(expr)
  if (!p) { p = compilePredicate(expr); predicateCache.set(expr, p) }
  return p(flags)
}

/* -------------------------------------------------------- command defs ----- */

export type CommandKind = 'action' | 'checkbox' | 'radio'

export interface CommandDefinition<C extends MenuContext = MenuContext> {
  /** What the command does. Receives the context so handlers stay stateless. */
  run: (ctx: C, value?: string) => void
  /** i18n key of the default label (menus may override it entry by entry). */
  labelKey?: string
  /** French fallback passed as `defaultValue` while the key is untranslated. */
  labelFallback?: string
  /** Dynamic label — wins over `labelKey`. This is how a label stops lying:
   *  "Ajouter un masque" / "Supprimer le masque" are decided from state. */
  label?: (ctx: C) => string
  /** Canonical accelerator; a menu entry may still display its own. */
  shortcut?: string
  kind?: CommandKind
  isEnabled?: (ctx: C) => boolean
  /** Declarative alternative to `isEnabled`, e.g. "doc && sel && !L.locked". */
  enableWhen?: string
  isChecked?: (ctx: C) => boolean
  checkedWhen?: string
  isHidden?: (ctx: C) => boolean
  hiddenWhen?: string
  danger?: boolean
  icon?: ReactNode | ((ctx: C) => ReactNode)
  /** Tooltip, typically explaining why the entry is greyed out. */
  hint?: string
  /** Radio group name (radio commands only). */
  group?: string
}

/** Builds the nodes of a dynamic submenu (blend modes, filter groups, open
 *  documents, zoom presets…). Referenced from the definitions by id only. */
export type MenuNodeProvider<C extends MenuContext = MenuContext> = (ctx: C) => MenuNode[]

/* ---------------------------------------------------- declarative specs ---- */

export type MenuPriority = 'P0' | 'P1' | 'P2'

/** Separator. */
export const SEP = '---' as const
export type MenuSeparatorSpec = typeof SEP

/** Non-interactive section heading. */
export interface MenuHeadingSpec {
  head: string            // i18n key
  fr?: string             // French fallback
  when?: string
}

/** A single entry bound to a registered command id. */
export interface MenuEntrySpec {
  cmd: MenuItemId
  key?: string            // i18n key (overrides the command's own)
  fr?: string             // French fallback for `key`
  sc?: string             // displayed accelerator
  /** false = displayed but never bound (e.g. "Ctrl+clic vignette"). */
  bind?: boolean
  when?: string           // visibility
  on?: string             // extra enable condition, ANDed with the command's
  check?: boolean         // force checkbox rendering
  danger?: boolean
  p?: MenuPriority
}

/** A nested submenu: either a static list of specs, or a provider id. */
export interface MenuSubmenuSpec {
  sub: MenuItemId
  key?: string
  fr?: string
  when?: string
  on?: string
  items?: MenuSpec[]
  provider?: string
  p?: MenuPriority
}

/** Splices a provider's nodes inline (no submenu level). */
export interface MenuDynamicSpec {
  dyn: string
  when?: string
}

export type MenuSpec = MenuSeparatorSpec | MenuHeadingSpec | MenuEntrySpec | MenuSubmenuSpec | MenuDynamicSpec

/** One top-level menu of the menu bar, as data. */
export interface MenuBarSpec {
  id: MenuItemId
  key: string
  fr?: string
  when?: string
  items: MenuSpec[]
}

/** One right-click target, as data. */
export interface ContextMenuSpec {
  id: string
  /** Human-readable description of the target (spec section, for traceability). */
  about?: string
  when?: string
  items: MenuSpec[]
}

export const isSeparatorSpec = (s: MenuSpec): s is MenuSeparatorSpec => s === SEP
export const isHeadingSpec = (s: MenuSpec): s is MenuHeadingSpec => typeof s === 'object' && 'head' in s
export const isEntrySpec = (s: MenuSpec): s is MenuEntrySpec => typeof s === 'object' && 'cmd' in s
export const isSubmenuSpec = (s: MenuSpec): s is MenuSubmenuSpec => typeof s === 'object' && 'sub' in s
export const isDynamicSpec = (s: MenuSpec): s is MenuDynamicSpec => typeof s === 'object' && 'dyn' in s

/* ------------------------------------------------------------- registry ---- */

/** What to do with an entry whose command id is not registered (yet). */
export type MissingPolicy = 'disable' | 'hide' | 'throw'

export interface BuildOptions {
  missing?: MissingPolicy
  /** Hint shown on entries greyed out because they are not implemented yet. */
  missingHint?: string
}

export interface ResolvedState {
  label: string
  disabled: boolean
  hidden: boolean
  checked: boolean
  danger: boolean
  hint?: string
  icon?: ReactNode
}

export class CommandRegistry<C extends MenuContext = MenuContext> {
  private readonly commands = new Map<MenuItemId, CommandDefinition<C>>()
  private readonly providers = new Map<string, MenuNodeProvider<C>>()

  /** Binds a command id to its implementation. Later registrations win, so the
   *  editor can override a default. */
  register(id: MenuItemId, def: CommandDefinition<C>): this {
    this.commands.set(id, def)
    return this
  }

  /** Bulk form — `registerAll({ 'layer.new': { run, labelKey }, … })`. */
  registerAll(defs: Record<MenuItemId, CommandDefinition<C>>): this {
    for (const [id, def] of Object.entries(defs)) this.commands.set(id, def)
    return this
  }

  /** Binds a dynamic submenu provider id (blend modes, filters, open docs…). */
  registerProvider(id: string, provider: MenuNodeProvider<C>): this {
    this.providers.set(id, provider)
    return this
  }

  has(id: MenuItemId): boolean { return this.commands.has(id) }
  get(id: MenuItemId): CommandDefinition<C> | undefined { return this.commands.get(id) }
  hasProvider(id: string): boolean { return this.providers.has(id) }
  ids(): MenuItemId[] { return [...this.commands.keys()].sort() }
  providerIds(): string[] { return [...this.providers.keys()].sort() }

  /** Command ids referenced by the given specs but never registered. Used by the
   *  wiring checklist and by the unit tests. */
  missing(specs: MenuSpec[]): MenuItemId[] {
    const out = new Set<MenuItemId>()
    const walk = (list: MenuSpec[]) => {
      for (const s of list) {
        if (isEntrySpec(s) && !this.commands.has(s.cmd)) out.add(s.cmd)
        else if (isSubmenuSpec(s)) {
          if (s.items) walk(s.items)
          if (s.provider && !this.providers.has(s.provider)) out.add(`provider:${s.provider}`)
        } else if (isDynamicSpec(s) && !this.providers.has(s.dyn)) out.add(`provider:${s.dyn}`)
      }
    }
    walk(specs)
    return [...out].sort()
  }

  /** Resolves label / disabled / checked / hidden for one command in one state. */
  resolveState(id: MenuItemId, ctx: C, override?: Pick<MenuEntrySpec, 'key' | 'fr' | 'on' | 'danger'>): ResolvedState | null {
    const def = this.commands.get(id)
    if (!def) return null
    const label = def.label
      ? def.label(ctx)
      : override?.key
        ? ctx.t(override.key, override.fr ? { defaultValue: override.fr } : undefined)
        : def.labelKey
          ? ctx.t(def.labelKey, def.labelFallback ? { defaultValue: def.labelFallback } : undefined)
          : id
    const enabledByDef = def.isEnabled ? def.isEnabled(ctx) : def.enableWhen ? evalWhen(def.enableWhen, ctx.flags) : true
    const enabledBySpec = override?.on ? evalWhen(override.on, ctx.flags) : true
    const checked = def.isChecked ? def.isChecked(ctx) : def.checkedWhen ? evalWhen(def.checkedWhen, ctx.flags) : false
    const hidden = def.isHidden ? def.isHidden(ctx) : def.hiddenWhen ? evalWhen(def.hiddenWhen, ctx.flags) : false
    return {
      label,
      disabled: !(enabledByDef && enabledBySpec),
      hidden,
      checked,
      danger: override?.danger ?? def.danger ?? false,
      hint: def.hint,
      icon: typeof def.icon === 'function' ? (def.icon as (c: C) => ReactNode)(ctx) : def.icon,
    }
  }

  /** Compiles a list of declarative specs into renderable `MenuNode`s. */
  build(specs: MenuSpec[], ctx: C, opts: BuildOptions = {}): MenuNode[] {
    const policy = opts.missing ?? 'disable'
    const out: MenuNode[] = []

    for (const spec of specs) {
      if (isSeparatorSpec(spec)) { out.push({ kind: 'separator' }); continue }

      if (isHeadingSpec(spec)) {
        if (spec.when && !evalWhen(spec.when, ctx.flags)) continue
        out.push({ kind: 'heading', label: ctx.t(spec.head, spec.fr ? { defaultValue: spec.fr } : undefined) })
        continue
      }

      if (isDynamicSpec(spec)) {
        if (spec.when && !evalWhen(spec.when, ctx.flags)) continue
        const provider = this.providers.get(spec.dyn)
        if (provider) out.push(...provider(ctx))
        else if (policy === 'throw') throw new Error(`unknown menu provider "${spec.dyn}"`)
        continue
      }

      if (isSubmenuSpec(spec)) {
        if (spec.when && !evalWhen(spec.when, ctx.flags)) continue
        const label = ctx.t(spec.key ?? spec.sub, spec.fr ? { defaultValue: spec.fr } : undefined)
        const disabled = spec.on ? !evalWhen(spec.on, ctx.flags) : false
        const provider = spec.provider ? this.providers.get(spec.provider) : undefined
        if (spec.provider && !provider) {
          if (policy === 'throw') throw new Error(`unknown menu provider "${spec.provider}"`)
          if (policy === 'hide') continue
          out.push({ kind: 'submenu', id: spec.sub, label, disabled: true, hint: opts.missingHint, items: [] })
          continue
        }
        // Thunk: children are only built when `MenuDropdown` opens the submenu.
        const items = (): MenuNode[] => [
          ...(spec.items ? this.build(spec.items, ctx, opts) : []),
          ...(provider ? provider(ctx) : []),
        ]
        out.push({ kind: 'submenu', id: spec.sub, label, disabled, items })
        continue
      }

      // Plain entry bound to a command id.
      if (spec.when && !evalWhen(spec.when, ctx.flags)) continue
      const def = this.commands.get(spec.cmd)
      if (!def) {
        if (policy === 'throw') throw new Error(`unknown menu command "${spec.cmd}"`)
        if (policy === 'hide') continue
        out.push({
          kind: 'action',
          id: spec.cmd,
          label: ctx.t(spec.key ?? spec.cmd, spec.fr ? { defaultValue: spec.fr } : undefined),
          shortcut: spec.sc,
          bindAccelerator: spec.bind,
          disabled: true,
          hint: opts.missingHint,
          danger: spec.danger,
          onClick: () => {},
        })
        continue
      }

      const st = this.resolveState(spec.cmd, ctx, spec)!
      if (st.hidden) continue
      const base = {
        id: spec.cmd,
        label: st.label,
        shortcut: spec.sc ?? def.shortcut,
        bindAccelerator: spec.bind,
        disabled: st.disabled,
        icon: st.icon,
        danger: st.danger,
        hint: st.hint,
      }
      const kind = spec.check ? 'checkbox' : def.kind ?? 'action'
      if (kind === 'checkbox') out.push({ ...base, kind: 'checkbox', checked: st.checked, onToggle: () => def.run(ctx) })
      else if (kind === 'radio') out.push({ ...base, kind: 'radio', group: def.group ?? spec.cmd, value: spec.cmd, checked: st.checked, onSelect: () => def.run(ctx) })
      else out.push({ ...base, kind: 'action', onClick: () => def.run(ctx) })
    }

    return out
  }

  /** Compiles the whole menu bar. Each menu's items are a thunk, so opening one
   *  menu never builds the other eight. */
  buildMenuBar(bar: MenuBarSpec[], ctx: C, opts: BuildOptions = {}): MenuDefinition[] {
    return bar
      .filter(m => !m.when || evalWhen(m.when, ctx.flags))
      .map<MenuDefinition>(m => ({
        id: m.id,
        label: ctx.t(m.key, m.fr ? { defaultValue: m.fr } : undefined),
        items: () => this.build(m.items, ctx, opts),
      }))
  }

  /** Compiles one right-click target. Returns [] when its `when` guard fails. */
  buildContextMenu(spec: ContextMenuSpec, ctx: C, opts: BuildOptions = {}): MenuNode[] {
    if (spec.when && !evalWhen(spec.when, ctx.flags)) return []
    return this.build(spec.items, ctx, opts)
  }
}

export function createCommandRegistry<C extends MenuContext = MenuContext>(): CommandRegistry<C> {
  return new CommandRegistry<C>()
}

/* ---------------------------------------------------------- radio helper --- */

/** Builds a radio group as `MenuNode`s from a value list. Used by the dynamic
 *  providers (blend modes, zoom presets, label colours, ruler units…), which are
 *  the only places allowed to create nodes outside the registry. */
export function radioGroup<T>(args: {
  group: string
  idPrefix: MenuItemId
  options: readonly T[]
  current: T
  labelOf: (value: T) => string
  valueOf: (value: T) => string
  iconOf?: (value: T) => ReactNode
  onSelect: (value: T) => void
  disabled?: boolean
  separatorAfter?: readonly string[]
}): MenuNode[] {
  const out: MenuNode[] = []
  for (const opt of args.options) {
    const value = args.valueOf(opt)
    out.push({
      kind: 'radio',
      id: `${args.idPrefix}:${value}`,
      group: args.group,
      value,
      data: opt,
      label: args.labelOf(opt),
      icon: args.iconOf?.(opt),
      checked: args.valueOf(args.current) === value,
      disabled: args.disabled,
      onSelect: () => args.onSelect(opt),
    })
    if (args.separatorAfter?.includes(value)) out.push({ kind: 'separator' })
  }
  return out
}
