// The vertical tool rail and its flyouts.
//
// One button per FAMILY, never one per tool: a click selects the family's
// remembered tool, a long press / right-click / click on the corner triangle
// opens the flyout listing the family's members. The floating layer is always
// `MenuDropdown` from `@ui` — it owns the portal, the viewport clamping and the
// automatic switch to a bottom sheet on touch — while the menu's CONTENT is ours
// so it can carry `role="menu"` / `role="menuitemradio"`, which the primitive
// does not emit on its own.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import type { TFunction } from 'i18next'
import { MenuDropdown, Tooltip } from '@ui'
import { C } from '../../ui/theme'
import { familyTool, formatShortcut, railFamilies, toolById } from './helpers'
import { ALL_RAIL_FAMILIES, FLYOUT_LONGPRESS_MS, FLYOUT_MOVE_TOLERANCE } from './toolDefs'
import type { FamilyId, RailFamily, ToolId } from './types'

export interface ToolRailProps {
  t: TFunction
  /** Active tool. */
  tool: ToolId
  onSelect: (tool: ToolId) => void
  /** Remembered tool per family. Uncontrolled when omitted. */
  lastPerFam?: Partial<Record<FamilyId, ToolId>>
  onLastPerFamChange?: (next: Partial<Record<FamilyId, ToolId>>) => void
  /** Usable length in px (height when vertical). Measured from the DOM when omitted. */
  available?: number
  orientation?: 'vertical' | 'horizontal'
  /** Long-press delay before the flyout opens — 120…600 ms for motor accessibility. */
  longPressMs?: number
  /** Tools the current layer cannot accept; shown greyed out and not selectable. */
  disabledTools?: ToolId[]
  /** Forces the touch presentation (bottom sheet, 44 px targets) in tests. */
  forceTouch?: boolean
  className?: string
  style?: CSSProperties
}

interface FlyoutState {
  family: RailFamily
  /** Viewport coordinates the menu anchors to. */
  left: number
  top: number
}

/** Matches the media query `MenuDropdown` itself uses to switch to a bottom sheet. */
function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(
    () => typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(pointer: coarse)').matches,
  )
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia('(pointer: coarse)')
    const onChange = () => setCoarse(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return coarse
}

export function ToolRail({
  t, tool, onSelect, lastPerFam, onLastPerFamChange, available,
  orientation = 'vertical', longPressMs = FLYOUT_LONGPRESS_MS,
  disabledTools, forceTouch = false, className, style,
}: ToolRailProps) {
  const vertical = orientation === 'vertical'
  const coarse = useCoarsePointer()
  const touch = forceTouch || coarse

  // Uncontrolled memory, used only while `lastPerFam` is not supplied.
  const [ownLast, setOwnLast] = useState<Partial<Record<FamilyId, ToolId>>>({})
  const memory = lastPerFam ?? ownLast

  const railRef = useRef<HTMLDivElement>(null)
  const [measured, setMeasured] = useState<number | null>(null)
  const [flyout, setFlyout] = useState<FlyoutState | null>(null)
  const [highlight, setHighlight] = useState(0)
  const [focusIdx, setFocusIdx] = useState(0)
  const [announce, setAnnounce] = useState('')

  // Long-press bookkeeping, kept in refs so a pending gesture never re-renders.
  const pressTimer = useRef<number | null>(null)
  const pressOrigin = useRef<{ x: number; y: number } | null>(null)
  const suppressClick = useRef(false)

  // ── Responsive family list ─────────────────────────────────────────────────
  useLayoutEffect(() => {
    const el = railRef.current
    if (!el || available !== undefined || typeof ResizeObserver === 'undefined') return
    const read = () => setMeasured(vertical ? el.clientHeight : el.clientWidth)
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [available, vertical])

  const families = useMemo(() => {
    const room = available ?? measured
    // Before the first measurement, show everything rather than flash the compact rail.
    return room == null ? ALL_RAIL_FAMILIES : railFamilies(room)
  }, [available, measured])

  const disabled = useMemo(() => new Set(disabledTools ?? []), [disabledTools])

  // Keep the roving focus on a button that still exists after a merge.
  useEffect(() => {
    setFocusIdx(i => Math.min(i, Math.max(0, families.length - 1)))
  }, [families.length])

  // ── Selection ──────────────────────────────────────────────────────────────
  const remember = useCallback((famId: FamilyId, toolId: ToolId) => {
    const next = { ...memory, [famId]: toolId }
    if (onLastPerFamChange) onLastPerFamChange(next)
    if (lastPerFam === undefined) setOwnLast(next)
  }, [memory, onLastPerFamChange, lastPerFam])

  const pick = useCallback((famId: FamilyId, toolId: ToolId) => {
    if (disabled.has(toolId)) return
    remember(famId, toolId)
    onSelect(toolId)
    setAnnounce(t(toolById(toolId).nameKey))
  }, [disabled, remember, onSelect, t])

  // ── Flyout ─────────────────────────────────────────────────────────────────
  const openFlyout = useCallback((family: RailFamily, btn: HTMLElement) => {
    const r = btn.getBoundingClientRect()
    // Beside the rail (desktop). MenuDropdown clamps and flips near the edges.
    const left = vertical ? r.right + 2 : r.left
    const top = vertical ? r.top : r.top - 8
    setFlyout({ family, left, top })
    const current = family.tools.indexOf(tool)
    setHighlight(current >= 0 ? current : 0)
    if (touch && typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(10)
    }
  }, [tool, touch, vertical])

  const closeFlyout = useCallback(() => setFlyout(null), [])

  const clearPress = useCallback(() => {
    if (pressTimer.current !== null) {
      window.clearTimeout(pressTimer.current)
      pressTimer.current = null
    }
    pressOrigin.current = null
  }, [])

  useEffect(() => () => {
    if (pressTimer.current !== null) window.clearTimeout(pressTimer.current)
  }, [])

  // ── Pointer gestures on a family button ────────────────────────────────────
  const onPointerDown = (family: RailFamily) => (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button === 2) return // right-click handled by onContextMenu
    const btn = e.currentTarget
    const r = btn.getBoundingClientRect()
    // The 12×12 corner carrying the triangle opens the flyout straight away.
    const inCorner = family.tools.length > 1
      && e.clientX >= r.right - 12 && e.clientY >= r.bottom - 12
    if (inCorner) {
      suppressClick.current = true
      openFlyout(family, btn)
      return
    }
    if (family.tools.length < 2) return
    pressOrigin.current = { x: e.clientX, y: e.clientY }
    pressTimer.current = window.setTimeout(() => {
      pressTimer.current = null
      suppressClick.current = true
      openFlyout(family, btn)
    }, longPressMs)
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const origin = pressOrigin.current
    if (!origin) return
    if (Math.hypot(e.clientX - origin.x, e.clientY - origin.y) > FLYOUT_MOVE_TOLERANCE) clearPress()
  }

  const onClick = (family: RailFamily) => () => {
    clearPress()
    if (suppressClick.current) { suppressClick.current = false; return }
    pick(family.id, familyTool(family, memory))
  }

  // ── Keyboard ───────────────────────────────────────────────────────────────
  const focusButton = useCallback((idx: number) => {
    const el = railRef.current?.querySelectorAll<HTMLButtonElement>('[data-family-button]')[idx]
    el?.focus()
  }, [])

  const onKeyDown = (family: RailFamily, idx: number) => (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (flyout) return // the document-level handler drives the open menu
    const nextKey = vertical ? 'ArrowDown' : 'ArrowRight'
    const prevKey = vertical ? 'ArrowUp' : 'ArrowLeft'
    const openKey = vertical ? 'ArrowRight' : 'ArrowUp'
    if (e.key === nextKey) {
      e.preventDefault()
      const n = (idx + 1) % families.length
      setFocusIdx(n); focusButton(n)
    } else if (e.key === prevKey) {
      e.preventDefault()
      const n = (idx - 1 + families.length) % families.length
      setFocusIdx(n); focusButton(n)
    } else if (e.key === 'Home') {
      e.preventDefault(); setFocusIdx(0); focusButton(0)
    } else if (e.key === 'End') {
      e.preventDefault(); const n = families.length - 1; setFocusIdx(n); focusButton(n)
    } else if ((e.key === openKey || (e.altKey && e.key === 'ArrowDown')) && family.tools.length > 1) {
      e.preventDefault()
      openFlyout(family, e.currentTarget)
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      pick(family.id, familyTool(family, memory))
    }
  }

  // Menu-level keyboard handling: the trigger keeps the DOM focus (MenuDropdown
  // cancels the mousedown), so the open menu listens at the document level.
  useEffect(() => {
    if (!flyout) return
    const members = flyout.family.tools
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation()
        closeFlyout(); focusButton(focusIdx)
      } else if (e.key === 'ArrowDown') {
        e.preventDefault(); setHighlight(h => (h + 1) % members.length)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault(); setHighlight(h => (h - 1 + members.length) % members.length)
      } else if (e.key === 'Home') {
        e.preventDefault(); setHighlight(0)
      } else if (e.key === 'End') {
        e.preventDefault(); setHighlight(members.length - 1)
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        pick(flyout.family.id, members[highlight])
        closeFlyout(); focusButton(focusIdx)
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [flyout, highlight, focusIdx, pick, closeFlyout, focusButton])

  // ── Rendering ──────────────────────────────────────────────────────────────
  const btnSize = touch ? 44 : 32
  const iconSize = touch ? 20 : 16

  const menuItems = useMemo(() => {
    if (!flyout) return []
    const fam = flyout.family
    return [{
      type: 'custom' as const,
      render: (close: () => void) => (
        <div role="menu" aria-label={t(fam.nameKey)} style={touch ? { padding: '4px 12px 12px' } : undefined}>
          {touch ? (
            // Mobile: a thumb-sized icon grid, not a shrunken desktop menu.
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
              {fam.tools.map((id, i) => {
                const def = toolById(id)
                const Icon = def.Icon
                const on = id === tool
                return (
                  <button
                    key={id} role="menuitemradio" aria-checked={on} type="button"
                    disabled={disabled.has(id)}
                    onClick={() => { pick(fam.id, id); close() }}
                    onPointerEnter={() => setHighlight(i)}
                    className="flex flex-col items-center justify-center gap-1.5 rounded transition-colors disabled:opacity-40"
                    style={{
                      minHeight: 76, padding: 8,
                      background: on ? `${C.accent}22` : 'transparent',
                      color: on ? C.accent : C.text,
                      outline: i === highlight ? `2px solid ${C.accent}` : 'none',
                      outlineOffset: -2,
                    }}
                  >
                    <Icon size={22} />
                    <span className="text-[11px] leading-tight text-center">{t(def.nameKey)}</span>
                  </button>
                )
              })}
            </div>
          ) : (
            fam.tools.map((id, i) => {
              const def = toolById(id)
              const Icon = def.Icon
              const on = id === tool
              return (
                <button
                  key={id} role="menuitemradio" aria-checked={on} type="button"
                  disabled={disabled.has(id)}
                  onClick={() => { pick(fam.id, id); close() }}
                  onPointerEnter={() => setHighlight(i)}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors disabled:opacity-40"
                  style={{
                    background: i === highlight ? C.active : 'transparent',
                    color: on ? C.accent : C.text,
                  }}
                >
                  <span aria-hidden="true" style={{ width: 14, display: 'inline-flex', color: on ? C.accent : 'transparent' }}>✓</span>
                  <Icon size={15} />
                  <span className="flex-1 text-xs">{t(def.nameKey)}</span>
                  <span className="text-[11px]" style={{ color: C.textDim }}>{formatShortcut(def.shortcut)}</span>
                </button>
              )
            })
          )}
        </div>
      ),
    }]
  }, [flyout, highlight, tool, t, pick, disabled, touch])

  return (
    <div
      ref={railRef}
      role="toolbar"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      aria-label={t('layer_fam_toolbar')}
      className={className}
      style={{
        display: 'flex',
        flexDirection: vertical ? 'column' : 'row',
        alignItems: 'center',
        gap: 4,
        padding: touch ? '4px 8px' : '8px 0',
        background: C.toolbar,
        // Mobile: ONE scrolling row, never a wrapping grid.
        overflowX: vertical ? 'visible' : 'auto',
        overflowY: vertical ? 'auto' : 'visible',
        flexWrap: 'nowrap',
        scrollSnapType: vertical ? undefined : 'x proximity',
        ...style,
      }}
    >
      {families.map((family, idx) => {
        const activeTool = familyTool(family, memory)
        const shown = toolById(activeTool)
        const Icon = shown.Icon
        const isActive = family.tools.includes(tool)
        const isOpen = flyout?.family.id === family.id
        const label = `${t(shown.nameKey)}${family.shortcut ? ` (${family.shortcut})` : ''}`
        return (
          <Tooltip key={family.id} label={label}>
            <button
              type="button"
              data-family-button
              data-family={family.id}
              aria-pressed={isActive}
              aria-haspopup={family.tools.length > 1 ? 'menu' : undefined}
              aria-expanded={family.tools.length > 1 ? isOpen : undefined}
              aria-controls={family.tools.length > 1 ? `layer-flyout-${family.id}` : undefined}
              tabIndex={idx === focusIdx ? 0 : -1}
              disabled={disabled.has(activeTool)}
              onFocus={() => setFocusIdx(idx)}
              onPointerDown={onPointerDown(family)}
              onPointerMove={onPointerMove}
              onPointerUp={clearPress}
              onPointerCancel={clearPress}
              onPointerLeave={clearPress}
              onClick={onClick(family)}
              onContextMenu={e => {
                e.preventDefault()
                suppressClick.current = true
                if (family.tools.length > 1) openFlyout(family, e.currentTarget)
              }}
              onKeyDown={onKeyDown(family, idx)}
              className="relative flex items-center justify-center rounded transition-colors
                         focus:outline-none focus-visible:ring-2 focus-visible:ring-primary
                         disabled:opacity-40 disabled:cursor-not-allowed"
              style={{
                width: btnSize, height: btnSize, flex: '0 0 auto',
                touchAction: 'none',
                scrollSnapAlign: vertical ? undefined : 'center',
                // Selection is a background tint — never a coloured bar on the edge.
                background: isActive ? C.active : 'transparent',
                color: isActive ? '#fff' : C.textDim,
                // An open flyout wears the same focus ring as a focused Input.
                boxShadow: isOpen ? 'inset 0 0 0 2px var(--color-primary)' : undefined,
              }}
            >
              <Icon size={iconSize} />
              {/* Family indicator: a filled corner triangle, only when ≥ 2 members. */}
              {family.tools.length > 1 && (
                <span
                  aria-hidden="true"
                  style={{
                    position: 'absolute', right: 2, bottom: 2, width: 0, height: 0,
                    borderLeft: '5px solid transparent',
                    borderBottom: `5px solid ${isActive ? C.accent : C.textDim}`,
                    opacity: 0.55,
                  }}
                />
              )}
            </button>
          </Tooltip>
        )
      })}

      {flyout && (
        <div id={`layer-flyout-${flyout.family.id}`}>
          <MenuDropdown
            items={menuItems}
            pos={{ top: flyout.top, left: flyout.left, minWidth: 220 }}
            onClose={closeFlyout}
            theme="dark"
          />
        </div>
      )}

      {/* Screen-reader announcement of the active tool. */}
      <span
        aria-live="polite"
        style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }}
      >
        {announce}
      </span>
    </div>
  )
}
