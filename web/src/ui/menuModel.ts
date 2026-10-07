// Unified Paintsharp menu model, shared by the menu bar and every context menu.
//
// Superset of `MenuItem` from `@ui`: adds stable ids, radio groups, headings and
// visibility so that ONE descriptor tree can drive, at the same time:
//   - the `@ui` `MenuDropdown` primitive (context menus, and the menu bar once the
//     SDK type catches up)               → `toUiMenuItems()`
//   - the legacy flat `WorkspaceMenuItem` menu bar of `@kubuno/sdk`
//                                        → `toWorkspaceMenuItems()`
//   - the keyboard handler, generated FROM the menus instead of duplicating them
//                                        → `collectAccelerators()`
//
// Rendering always goes through `MenuDropdown` from `@ui` — never a hand-rolled
// floating div. Checked state is a real boolean, never a "✓ " string prefix.
//
// This file is additive: `ui/menus.ts`, `ui/MenuBar.tsx` and `ui/ContextMenu.tsx`
// are untouched, so Apex / Vertex / Motion / Keyframe / PdfWriter keep their
// existing code path while Layer migrates to this model.
import type { ReactNode } from 'react'
import type { MenuItem as UiMenuItem } from '@ui'
import type { WorkspaceMenuItem } from '@kubuno/sdk'

/* ------------------------------------------------------------------ model -- */

/** Stable, dot-namespaced identifier, e.g. "layer.mask.add". Used for tests,
 *  accelerator binding and command-palette lookup. */
export type MenuItemId = string

export interface MenuItemBase {
  /** Stable id — required on anything actionable. */
  id?: MenuItemId
  /** Already-translated label. Callers pass t('...'), never a raw key. */
  label: string
  /** Displayed accelerator, e.g. "Ctrl+Maj+S". Also registered by
   *  `collectAccelerators()` unless `bindAccelerator` is false. */
  shortcut?: string
  /** Set to false for a display-only hint such as "Ctrl+clic vignette", which is
   *  not a real accelerator and must not reach the keyboard handler. */
  bindAccelerator?: boolean
  disabled?: boolean
  /** Hidden entirely instead of greyed out. Prefer `disabled` for discoverability. */
  hidden?: boolean
  icon?: ReactNode
  /** Destructive styling (red). Previously only available on context menus. */
  danger?: boolean
  /** Tooltip explaining why the entry is disabled. */
  hint?: string
}

export interface MenuActionItem extends MenuItemBase {
  kind: 'action'
  onClick: () => void
}

/** Independent on/off toggle. Renders a checkmark slot that reserves space even
 *  when unchecked, so labels never shift. Replaces the '✓ ' string prefix hack. */
export interface MenuCheckboxItem extends MenuItemBase {
  kind: 'checkbox'
  checked: boolean
  onToggle: (next: boolean) => void
}

/** One option of a radio group. `group` ties options together; exactly one is
 *  checked. `value` is compared with the group's current value.
 *
 *  Values are strings on purpose: a generic `MenuRadioItem<T>` cannot be widened
 *  into the `MenuNode` union without variance errors (the spec sketch used
 *  `MenuRadioItem<never>`, which no concrete radio is assignable to). Non-string
 *  domains (zoom factors, thumbnail sizes) serialise their value and keep the raw
 *  one in `data`. */
export interface MenuRadioItem extends MenuItemBase {
  kind: 'radio'
  group: string
  value: string
  checked: boolean
  onSelect: (value: string) => void
  /** Raw, non-serialised value (number, object…) for the call site. */
  data?: unknown
}

/** Nested submenu. `items` may be a thunk so large or expensive submenus
 *  (blend modes, filter groups, open documents) are only built when opened. */
export interface MenuSubmenuItem extends MenuItemBase {
  kind: 'submenu'
  items: MenuNode[] | (() => MenuNode[])
}

/** Non-interactive section heading inside a menu. Replaces the disabled
 *  pseudo-items currently used as fake group headers in the Filter menu. */
export interface MenuHeadingItem {
  kind: 'heading'
  id?: MenuItemId
  label: string
  hidden?: boolean
}

export interface MenuSeparatorItem {
  kind: 'separator'
  hidden?: boolean
}

/** Escape hatch for inline widgets (brush size sliders, colour swatch strip).
 *  `close` lets the widget dismiss the menu when it is done. */
export interface MenuCustomItem {
  kind: 'custom'
  id?: MenuItemId
  hidden?: boolean
  render: (close: () => void) => ReactNode
}

export type MenuNode =
  | MenuActionItem
  | MenuCheckboxItem
  | MenuRadioItem
  | MenuSubmenuItem
  | MenuHeadingItem
  | MenuSeparatorItem
  | MenuCustomItem

/** A top-level menu of the menu bar. */
export interface MenuDefinition {
  id: MenuItemId
  label: string
  items: MenuNode[] | (() => MenuNode[])
  hidden?: boolean
}

/* ---------------------------------------------------------------- helpers -- */

/** Resolves an `items` field that may be a lazily-built thunk. */
export function resolveMenuItems(items: MenuNode[] | (() => MenuNode[])): MenuNode[] {
  return typeof items === 'function' ? items() : items
}

/** True for nodes the user can activate (and therefore that may own an id/shortcut). */
export function isInteractive(n: MenuNode): n is MenuActionItem | MenuCheckboxItem | MenuRadioItem | MenuSubmenuItem {
  return n.kind === 'action' || n.kind === 'checkbox' || n.kind === 'radio' || n.kind === 'submenu'
}

/** Depth-first walk over a node tree, submenu thunks included. `visit` may return
 *  false to skip a submenu's children. */
export function walkMenuNodes(
  nodes: MenuNode[],
  visit: (node: MenuNode, path: MenuNode[]) => void | false,
  path: MenuNode[] = [],
): void {
  for (const n of nodes) {
    const go = visit(n, path)
    if (go !== false && n.kind === 'submenu') {
      walkMenuNodes(resolveMenuItems(n.items), visit, [...path, n])
    }
  }
}

/** Finds the first node carrying `id`, anywhere in the tree. */
export function findMenuNode(nodes: MenuNode[], id: MenuItemId): MenuNode | null {
  let found: MenuNode | null = null
  walkMenuNodes(nodes, n => {
    if (found) return false
    if ('id' in n && n.id === id) { found = n; return false }
  })
  return found
}

/** Drops hidden nodes, then collapses leading/trailing/duplicated separators.
 *  Hiding entries otherwise leaves visible double rules in the menu. */
export function pruneMenuNodes(nodes: MenuNode[]): MenuNode[] {
  const visible = nodes.filter(n => !('hidden' in n && n.hidden))
  const out: MenuNode[] = []
  for (const n of visible) {
    if (n.kind === 'separator') {
      if (out.length === 0) continue
      if (out[out.length - 1].kind === 'separator') continue
    }
    out.push(n)
  }
  while (out.length && out[out.length - 1].kind === 'separator') out.pop()
  return out
}

/* ------------------------------------------------------- adapter: @ui ------ */

export interface ToUiOptions {
  /** Build submenu children only when the submenu is actually opened (default).
   *  `MenuDropdown` reads `item.items` lazily when it renders the open submenu,
   *  so a memoised getter keeps large submenus (23 blend modes, 55 filters) out
   *  of the initial render. Set false for tests/serialisation. */
  lazySubmenus?: boolean
}

/**
 * Maps the Paintsharp model onto the `@ui` primitive. Checkboxes and radios
 * collapse to `action` items carrying a real `checked` boolean, headings to
 * `type:'label'`, hidden items are dropped and the resulting separator runs are
 * collapsed. Pure function: no React, no i18n, no DOM.
 */
export function toUiMenuItems(nodes: MenuNode[], opts: ToUiOptions = {}): UiMenuItem[] {
  const lazy = opts.lazySubmenus !== false
  return pruneMenuNodes(nodes).map<UiMenuItem>(n => {
    switch (n.kind) {
      case 'separator':
        return { type: 'separator' }
      case 'heading':
        return { type: 'label', text: n.label }
      case 'custom':
        return { type: 'custom', render: n.render }
      case 'submenu': {
        const base = {
          type: 'submenu' as const,
          label: n.label,
          icon: n.icon,
          disabled: n.disabled,
        }
        if (!lazy) return { ...base, items: toUiMenuItems(resolveMenuItems(n.items), opts) }
        // Memoised getter: evaluated on first read (i.e. when the submenu opens).
        let cache: UiMenuItem[] | null = null
        return Object.defineProperty(base, 'items', {
          enumerable: true,
          configurable: true,
          get: () => (cache ??= toUiMenuItems(resolveMenuItems(n.items), opts)),
        }) as UiMenuItem
      }
      case 'checkbox':
        return {
          type: 'action', label: n.label, shortcut: n.shortcut, disabled: n.disabled,
          checked: n.checked, danger: n.danger, icon: n.icon,
          onClick: () => n.onToggle(!n.checked),
        }
      case 'radio':
        return {
          type: 'action', label: n.label, shortcut: n.shortcut, disabled: n.disabled,
          checked: n.checked, danger: n.danger, icon: n.icon,
          onClick: () => n.onSelect(n.value),
        }
      case 'action':
      default:
        return {
          type: 'action', label: n.label, shortcut: n.shortcut, disabled: n.disabled,
          danger: n.danger, icon: n.icon, onClick: n.onClick,
        }
    }
  })
}

/* ------------------------------------------- adapter: legacy SDK menu bar -- */

export interface ToWorkspaceOptions {
  /** Submenu levels flattened inline. Deeper submenus render as a disabled
   *  placeholder rather than exploding the list. Default: Infinity. */
  maxDepth?: number
  /** Indent string repeated once per nesting level. Default: two NBSPs. */
  indent?: string
}

const CHECK_ON = '✓ '   // "✓ " — legacy bridge only, see comment below
const CHECK_OFF = '  '  // figure space: same advance width, no label shift

/**
 * Backwards-compatible bridge for the menu bar while `WorkspaceMenuItem` (SDK)
 * still lacks nesting, `checked`, `icon` and `danger`. Submenus are flattened
 * into a heading followed by indented entries; deeper levels keep indenting.
 *
 * The check glyph prefix here is NOT the "✓ " hack the model exists to remove:
 * the model keeps a real boolean, and this string only ever appears in the
 * legacy fallback path, with a same-width blank reserved when unchecked so
 * labels never shift. Delete this function once the SDK type gains recursion.
 */
export function toWorkspaceMenuItems(nodes: MenuNode[], opts: ToWorkspaceOptions = {}): WorkspaceMenuItem[] {
  const maxDepth = opts.maxDepth ?? Infinity
  const indent = opts.indent ?? '  '
  const out: WorkspaceMenuItem[] = []

  const emit = (list: MenuNode[], depth: number, forcedDisabled: boolean) => {
    for (const n of pruneMenuNodes(list)) {
      const pad = indent.repeat(depth)
      switch (n.kind) {
        case 'separator':
          out.push('sep')
          break
        case 'heading':
          out.push({ label: `${pad}— ${n.label} —`, disabled: true })
          break
        case 'custom':
          // No inline widgets in the legacy bar; the entry is simply skipped.
          break
        case 'submenu': {
          const disabled = forcedDisabled || !!n.disabled
          out.push({ label: `${pad}— ${n.label} —`, disabled: true })
          if (depth + 1 > maxDepth) {
            out.push({ label: `${pad}${indent}…`, disabled: true })
          } else {
            emit(resolveMenuItems(n.items), depth + 1, disabled)
          }
          break
        }
        case 'checkbox':
          out.push({
            label: `${pad}${n.checked ? CHECK_ON : CHECK_OFF}${n.label}`,
            onClick: () => n.onToggle(!n.checked),
            disabled: forcedDisabled || n.disabled,
            shortcut: n.shortcut,
          })
          break
        case 'radio':
          out.push({
            label: `${pad}${n.checked ? CHECK_ON : CHECK_OFF}${n.label}`,
            onClick: () => n.onSelect(n.value),
            disabled: forcedDisabled || n.disabled,
            shortcut: n.shortcut,
          })
          break
        case 'action':
        default:
          out.push({
            label: `${pad}${n.label}`,
            onClick: n.onClick,
            disabled: forcedDisabled || n.disabled,
            shortcut: n.shortcut,
          })
      }
    }
  }

  emit(nodes, 0, false)
  // A flattened submenu can end on a separator; tidy the tail.
  while (out.length && out[out.length - 1] === 'sep') out.pop()
  return out
}

/** Convenience: whole menu bar in one call, for `<MenuBar menus={…} />`. */
export function toWorkspaceMenus(
  menus: MenuDefinition[],
  opts: ToWorkspaceOptions = {},
): { label: string; items: WorkspaceMenuItem[] }[] {
  return menus
    .filter(m => !m.hidden)
    .map(m => ({ label: m.label, items: toWorkspaceMenuItems(resolveMenuItems(m.items), opts) }))
}

/* ------------------------------------------------------- accelerators ------ */

/** Canonical modifier order used by every normalised accelerator string. */
const MOD_ORDER = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const

const MOD_ALIASES: Record<string, (typeof MOD_ORDER)[number]> = {
  ctrl: 'Ctrl', control: 'Ctrl', ctl: 'Ctrl',
  alt: 'Alt', option: 'Alt', opt: 'Alt', '⌥': 'Alt',
  shift: 'Shift', maj: 'Shift', '⇧': 'Shift',
  meta: 'Meta', cmd: 'Meta', command: 'Meta', '⌘': 'Meta', super: 'Meta', win: 'Meta',
}

/** French / glyph key names → the `KeyboardEvent.key` spelling. */
const KEY_ALIASES: Record<string, string> = {
  suppr: 'Delete', del: 'Delete', delete: 'Delete',
  '⌫': 'Backspace', retour: 'Backspace', backspace: 'Backspace',
  entrée: 'Enter', entree: 'Enter', enter: 'Enter', '⏎': 'Enter',
  échap: 'Escape', echap: 'Escape', esc: 'Escape', escape: 'Escape',
  espace: 'Space', space: 'Space', ' ': 'Space',
  tab: 'Tab', tabulation: 'Tab',
  haut: 'ArrowUp', bas: 'ArrowDown', gauche: 'ArrowLeft', droite: 'ArrowRight',
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
}

/** Splits "Ctrl+Maj+]" / "Ctrl++" / "Ctrl+-" into tokens, treating a '+' that
 *  directly follows a separator as the literal plus key. */
function tokenizeAccelerator(accel: string): string[] {
  const out: string[] = []
  let cur = ''
  for (const ch of accel) {
    if (ch === '+') {
      if (cur === '') out.push('+')
      else { out.push(cur); cur = '' }
    } else cur += ch
  }
  if (cur !== '') out.push(cur)
  return out
}

/**
 * Canonical form of a displayed accelerator: modifiers in a fixed order, then the
 * key. Returns null when the string is not a bindable accelerator (free text such
 * as "Ctrl+clic vignette", or an empty/modifier-only string).
 *
 *   "Ctrl+Maj+Z" → "Ctrl+Shift+Z"      "⌘+S"  → "Meta+S"
 *   "Ctrl++"     → "Ctrl++"            "Suppr" → "Delete"
 */
export function normalizeAccelerator(accel: string | undefined | null): string | null {
  if (!accel) return null
  const raw = accel.trim()
  if (!raw || /\s/.test(raw)) return null      // "Ctrl+clic vignette" and friends
  const tokens = tokenizeAccelerator(raw)
  if (!tokens.length) return null
  const mods = new Set<(typeof MOD_ORDER)[number]>()
  let key: string | null = null
  for (const tok of tokens) {
    const mod = MOD_ALIASES[tok.toLowerCase()]
    if (mod) { mods.add(mod); continue }
    if (key !== null) return null              // two non-modifier tokens → not an accelerator
    key = tok
  }
  if (key === null) return null                // modifier-only
  const alias = KEY_ALIASES[key.toLowerCase()]
  if (alias) key = alias
  else if (key.length === 1) key = key.toUpperCase()
  else key = key[0].toUpperCase() + key.slice(1)
  return [...MOD_ORDER.filter(m => mods.has(m)), key].join('+')
}

/** Minimal shape of a keyboard event, so this stays testable without a DOM. */
export interface AcceleratorEventLike {
  key: string
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  metaKey?: boolean
}

/** Canonical accelerator for a keyboard event — the lookup key into the map
 *  returned by `collectAccelerators()`. */
export function acceleratorFromEvent(e: AcceleratorEventLike): string {
  const mods: string[] = []
  if (e.ctrlKey) mods.push('Ctrl')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  if (e.metaKey) mods.push('Meta')
  let key = e.key
  if (key === ' ') key = 'Space'
  else if (key.length === 1) key = key.toUpperCase()
  return [...mods, key].join('+')
}

export interface AcceleratorConflict {
  accelerator: string
  ids: MenuItemId[]
}

interface AcceleratorHit { accelerator: string; id: MenuItemId }

function gatherAccelerators(nodes: MenuNode[]): AcceleratorHit[] {
  const hits: AcceleratorHit[] = []
  walkMenuNodes(nodes, n => {
    if (!isInteractive(n)) return
    if (n.bindAccelerator === false || !n.shortcut || !n.id) return
    const accelerator = normalizeAccelerator(n.shortcut)
    if (accelerator) hits.push({ accelerator, id: n.id })
  })
  return hits
}

function asNodes(source: MenuDefinition[] | MenuNode[]): MenuNode[] {
  if (source.length === 0) return []
  const first = source[0] as MenuDefinition & MenuNode
  const isMenuBar = typeof first === 'object' && first !== null && !('kind' in first) && 'items' in first
  if (!isMenuBar) return source as MenuNode[]
  return (source as MenuDefinition[])
    .filter(m => !m.hidden)
    .map<MenuNode>(m => ({ kind: 'submenu', id: m.id, label: m.label, items: m.items }))
}

/**
 * Walks the whole tree and returns every bindable `shortcut` mapped to its `id`,
 * so the keyboard handler is GENERATED from the menus instead of duplicating
 * them. This is what removes the current menu/keyboard divergences (Ctrl+J bound
 * to a different action than the one the menu advertises, Ctrl+S displayed but
 * never bound).
 *
 * A Map cannot hold a duplicate key, so the result is conflict-free by
 * construction: the FIRST declaration wins. Use `findAcceleratorConflicts()` to
 * assert in tests that nothing was silently dropped.
 */
export function collectAccelerators(source: MenuDefinition[] | MenuNode[]): Map<string, MenuItemId> {
  const map = new Map<string, MenuItemId>()
  for (const { accelerator, id } of gatherAccelerators(asNodes(source))) {
    if (!map.has(accelerator)) map.set(accelerator, id)
  }
  return map
}

/**
 * Every accelerator claimed by two or more DIFFERENT command ids. The same id
 * appearing several times (a legitimate alias, e.g. "Aplatir l'image" listed in
 * both Image and Calque) is not a conflict.
 */
export function findAcceleratorConflicts(source: MenuDefinition[] | MenuNode[]): AcceleratorConflict[] {
  const byAccel = new Map<string, Set<MenuItemId>>()
  for (const { accelerator, id } of gatherAccelerators(asNodes(source))) {
    const set = byAccel.get(accelerator) ?? new Set<MenuItemId>()
    set.add(id)
    byAccel.set(accelerator, set)
  }
  const out: AcceleratorConflict[] = []
  for (const [accelerator, ids] of byAccel) {
    if (ids.size > 1) out.push({ accelerator, ids: [...ids] })
  }
  return out.sort((a, b) => a.accelerator.localeCompare(b.accelerator))
}
