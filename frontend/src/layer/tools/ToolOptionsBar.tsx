// The contextual options bar — entirely data-driven.
//
// It loops over `optionsFor(tool)` and renders one control per `ToolOption.kind`.
// There is no per-tool branch anywhere: adding an option to a tool in
// `toolDefs.ts` makes it appear here, in the right place, with the right
// responsive behaviour. When the bar runs out of width, the controls with the
// highest `priority` fold into a "⋯" button that opens a `MenuDropdown` from
// `@ui` (a bottom sheet on touch, courtesy of the same primitive).
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { TFunction } from 'i18next'
import { Ellipsis, RotateCcw } from 'lucide-react'
import { Dropdown, MenuDropdown, RangeSlider, Tooltip } from '@ui'
import { C } from '../../ui/theme'
import { BLEND_KEYS, blendLabel } from '../model/blend'
import { FONT_FAMILIES } from '../model/constants'
import { BRUSH_PRESETS } from '../paint/brushPresets'
import { isOptionDisabled, optionsFor, toolById, visibleOptions } from './helpers'
import type { ActionId, ReadoutId, ToolId, ToolOption, ToolValues } from './types'

/** Horizontal gap between two controls, mirrored in the width budget. */
const GAP = 8
/** Room the "⋯" button needs once the bar starts folding. */
const OVERFLOW_W = 32

export interface ToolOptionsBarProps {
  t: TFunction
  tool: ToolId
  values: ToolValues
  onChange: (id: string, value: string | number | boolean) => void
  onAction?: (id: ActionId) => void
  /** Live text for `readout` controls (crop size, zoom level…). */
  readouts?: Partial<Record<ReadoutId, string>>
  /** Mobile presentation: a single 44 px row, priority-0 controls only. */
  mobile?: boolean
  /** Called by the leading "reset this tool" button. */
  onResetTool?: () => void
  className?: string
  style?: CSSProperties
}

// ── Small shared primitives ──────────────────────────────────────────────────

function FieldLabel({ children }: { children: ReactNode }) {
  return <span className="text-[11px] whitespace-nowrap" style={{ color: C.textDim }}>{children}</span>
}

function NumField({ value, min, max, step, unit, width, disabled, onChange }: {
  value: number; min: number; max: number; step?: number; unit?: string
  width?: number; disabled?: boolean; onChange: (v: number) => void
}) {
  return (
    <span className="inline-flex items-center gap-1">
      <input
        type="number" value={value} min={min} max={max} step={step ?? 1} disabled={disabled}
        onChange={e => onChange(Math.max(min, Math.min(max, Number(e.target.value))))}
        className="h-5 text-[11px] text-center outline-none focus:ring-2 focus:ring-primary rounded-[2px]"
        style={{ width: width ?? 52, background: '#252525', color: C.text, border: `1px solid ${C.border}` }}
      />
      {unit && <span className="text-[10px]" style={{ color: C.textDim }}>{unit}</span>}
    </span>
  )
}

/** A pill toggle. Never bold — the core forbids bold buttons. */
function ToggleChip({ on, label, disabled, onToggle }: {
  on: boolean; label: string; disabled?: boolean; onToggle: () => void
}) {
  return (
    <button
      type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled}
      onClick={onToggle}
      className="h-5 px-2 rounded-[3px] text-[11px] transition-colors outline-none
                 focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-40"
      style={{
        background: on ? `${C.accent}33` : '#2c2c2c',
        color: on ? C.accent : C.textDim,
        border: `1px solid ${on ? C.accent : '#3a3a3a'}`,
      }}
    >
      {label}
    </button>
  )
}

function Segmented({ opt, value, disabled, t, onChange }: {
  opt: Extract<ToolOption, { kind: 'segmented' }>
  value: string; disabled?: boolean; t: TFunction; onChange: (v: string) => void
}) {
  return (
    <span role="radiogroup" aria-label={t(opt.labelKey)} className="inline-flex rounded-[3px] overflow-hidden"
          style={{ border: `1px solid ${C.border}` }}>
      {opt.choices.map(c => {
        const on = c.value === value
        const Icon = c.icon
        return (
          <Tooltip key={c.value} label={t(c.labelKey)}>
            <button
              type="button" role="radio" aria-checked={on} disabled={disabled}
              onClick={() => onChange(c.value)}
              className="h-5 px-1.5 inline-flex items-center justify-center text-[11px] transition-colors
                         outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-40"
              style={{ background: on ? C.accent : '#2c2c2c', color: on ? '#fff' : C.textDim, minWidth: 22 }}
            >
              {Icon ? <Icon size={13} /> : t(c.labelKey)}
            </button>
          </Tooltip>
        )
      })}
    </span>
  )
}

/**
 * Trigger + `MenuDropdown` list. Backs every catalogue-style control (brush,
 * blend mode, font, gradient, pattern, custom shape) until each gets its rich
 * picker; the DATA contract does not change when they do.
 */
function PickerControl({ label, value, entries, disabled, width, onPick }: {
  label: string; value: string; width?: number; disabled?: boolean
  entries: { value: string; label: string }[]
  onPick: (v: string) => void
}) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const current = entries.find(e => e.value === value)
  return (
    <>
      <button
        type="button" aria-haspopup="menu" aria-expanded={pos !== null} aria-label={label} disabled={disabled}
        onClick={e => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
          setPos(p => (p ? null : { top: r.bottom + 2, left: r.left }))
        }}
        className="h-5 px-2 rounded-[3px] text-[11px] text-left truncate transition-colors outline-none
                   focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-40"
        style={{
          width: width ?? 116, background: '#252525', color: C.text,
          border: `1px solid ${pos ? 'var(--color-primary)' : C.border}`,
          boxShadow: pos ? 'inset 0 0 0 1px var(--color-primary)' : undefined,
        }}
      >
        {current?.label ?? value}
      </button>
      {pos && (
        <MenuDropdown
          theme="dark" pos={{ ...pos, minWidth: width ?? 160 }} onClose={() => setPos(null)}
          items={entries.map(e => ({
            type: 'action' as const,
            label: e.label,
            checked: e.value === value,
            onClick: () => onPick(e.value),
          }))}
        />
      )}
    </>
  )
}

// ── Catalogues backing the picker kinds ──────────────────────────────────────

const GRADIENT_PRESETS = ['fg-bg', 'fg-transparent', 'black-white', 'spectrum', 'sunset']
const PATTERN_PRESETS = ['checker', 'dots', 'stripes', 'grid', 'noise']
const CUSTOM_SHAPES = ['heart', 'arrow', 'cloud', 'flower', 'lightning', 'crown']

// ── One control ──────────────────────────────────────────────────────────────

function OptionControl({ opt, values, t, onChange, onAction, readouts }: {
  opt: ToolOption; values: ToolValues; t: TFunction
  onChange: (id: string, v: string | number | boolean) => void
  onAction?: (id: ActionId) => void
  readouts?: Partial<Record<ReadoutId, string>>
}) {
  const label = t(opt.labelKey)
  const disabled = isOptionDisabled(opt, values)
  const num = (fallback: number) => (typeof values[opt.id] === 'number' ? (values[opt.id] as number) : fallback)
  const str = (fallback: string) => (typeof values[opt.id] === 'string' ? (values[opt.id] as string) : fallback)
  const bool = (fallback: boolean) => (typeof values[opt.id] === 'boolean' ? (values[opt.id] as boolean) : fallback)

  switch (opt.kind) {
    case 'slider':
      return (
        <span className="inline-flex items-center gap-1.5">
          <FieldLabel>{label}</FieldLabel>
          <RangeSlider
            value={num(opt.def)} min={opt.min} max={opt.max} step={opt.step ?? 1} disabled={disabled}
            accent={C.accent} trackColor="#4a4a4a" aria-label={label}
            style={{ width: opt.width ?? 84 }}
            format={v => `${v}${opt.unit ?? ''}`}
            onChange={v => onChange(opt.id, v)}
          />
        </span>
      )
    case 'number':
      return (
        <span className="inline-flex items-center gap-1.5">
          <FieldLabel>{label}</FieldLabel>
          <NumField
            value={num(opt.def)} min={opt.min} max={opt.max} step={opt.step} unit={opt.unit}
            width={opt.width} disabled={disabled} onChange={v => onChange(opt.id, v)}
          />
        </span>
      )
    case 'select':
      return (
        <span className="inline-flex items-center gap-1.5">
          <FieldLabel>{label}</FieldLabel>
          <Dropdown
            variant="dark" height={20} fontSize={11} width={opt.width ?? 116} disabled={disabled}
            value={str(opt.def)} onChange={v => onChange(opt.id, v)}
            options={opt.choices.map(c => ({ value: c.value, label: t(c.labelKey) }))}
          />
        </span>
      )
    case 'segmented':
      return <Segmented opt={opt} value={str(opt.def)} disabled={disabled} t={t} onChange={v => onChange(opt.id, v)} />
    case 'toggle':
      return <ToggleChip on={bool(opt.def)} label={label} disabled={disabled} onToggle={() => onChange(opt.id, !bool(opt.def))} />
    case 'color': {
      const raw = str(opt.def)
      // `fg` / `bg` / `none` are symbolic: they follow the document's colours.
      const swatch = raw.startsWith('#') ? raw : raw === 'bg' ? '#ffffff' : raw === 'none' ? 'transparent' : C.accent
      return (
        <span className="inline-flex items-center gap-1.5">
          <FieldLabel>{label}</FieldLabel>
          <input
            type="color" aria-label={label} disabled={disabled}
            value={raw.startsWith('#') ? raw : '#000000'}
            onChange={e => onChange(opt.id, e.target.value)}
            className="w-6 h-5 p-0 rounded-[2px] cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-primary"
            style={{ background: swatch, border: `1px solid ${C.border}` }}
          />
        </span>
      )
    }
    case 'brush':
      return (
        <span className="inline-flex items-center gap-1.5">
          <FieldLabel>{label}</FieldLabel>
          <PickerControl
            label={label} value={str(opt.def)} width={opt.width ?? 132} disabled={disabled}
            entries={BRUSH_PRESETS.map(b => ({ value: b.id, label: t(b.nameKey) }))}
            onPick={v => onChange(opt.id, v)}
          />
        </span>
      )
    case 'blend':
      return (
        <span className="inline-flex items-center gap-1.5">
          <FieldLabel>{label}</FieldLabel>
          <PickerControl
            label={label} value={str(opt.def)} width={opt.width ?? 116} disabled={disabled}
            entries={BLEND_KEYS.map(k => ({ value: k, label: blendLabel(t, k) }))}
            onPick={v => onChange(opt.id, v)}
          />
        </span>
      )
    case 'font':
      return (
        <span className="inline-flex items-center gap-1.5">
          <FieldLabel>{label}</FieldLabel>
          <PickerControl
            label={label} value={str(opt.def)} width={opt.width ?? 132} disabled={disabled}
            entries={FONT_FAMILIES.map(f => ({ value: f, label: f }))}
            onPick={v => onChange(opt.id, v)}
          />
        </span>
      )
    case 'gradient':
    case 'pattern':
    case 'shape': {
      const catalogue = opt.kind === 'gradient' ? GRADIENT_PRESETS
        : opt.kind === 'pattern' ? PATTERN_PRESETS : CUSTOM_SHAPES
      return (
        <span className="inline-flex items-center gap-1.5">
          <FieldLabel>{label}</FieldLabel>
          <PickerControl
            label={label} value={str(opt.def)} width={opt.width ?? 116} disabled={disabled}
            entries={catalogue.map(v => ({ value: v, label: v }))}
            onPick={v => onChange(opt.id, v)}
          />
        </span>
      )
    }
    case 'action':
      return (
        <button
          type="button" disabled={disabled} onClick={() => onAction?.(opt.run)}
          className="h-5 px-2 rounded-[3px] text-[11px] transition-colors outline-none
                     focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-40"
          style={{
            background: opt.variant === 'primary' ? C.accent : '#2c2c2c',
            color: opt.variant === 'primary' ? '#fff' : C.text,
            border: `1px solid ${opt.variant === 'primary' ? C.accent : '#3a3a3a'}`,
          }}
        >
          {label}
        </button>
      )
    case 'readout':
      return (
        <span className="text-[11px] whitespace-nowrap" style={{ color: C.textDim }}>
          {readouts?.[opt.read] ?? label}
        </span>
      )
    case 'popover':
      return <PopoverGroup opt={opt} values={values} t={t} onChange={onChange} onAction={onAction} readouts={readouts} />
  }
}

/** A nested group of controls, opened from the bar inside a `MenuDropdown`. */
function PopoverGroup({ opt, values, t, onChange, onAction, readouts }: {
  opt: Extract<ToolOption, { kind: 'popover' }>
  values: ToolValues; t: TFunction
  onChange: (id: string, v: string | number | boolean) => void
  onAction?: (id: ActionId) => void
  readouts?: Partial<Record<ReadoutId, string>>
}) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  return (
    <>
      <button
        type="button" aria-haspopup="menu" aria-expanded={pos !== null}
        onClick={e => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
          setPos(p => (p ? null : { top: r.bottom + 2, left: r.left }))
        }}
        className="h-5 px-2 rounded-[3px] text-[11px] transition-colors outline-none
                   focus-visible:ring-2 focus-visible:ring-primary"
        style={{
          background: '#2c2c2c', color: C.text,
          border: `1px solid ${pos ? 'var(--color-primary)' : '#3a3a3a'}`,
        }}
      >
        {t(opt.labelKey)} ▾
      </button>
      {pos && (
        <MenuDropdown
          theme="dark" pos={{ ...pos, minWidth: 240 }} onClose={() => setPos(null)}
          items={[{
            type: 'custom' as const,
            render: () => (
              <div role="group" aria-label={t(opt.labelKey)} className="flex flex-col gap-2 px-3 py-2">
                {visibleOptions(opt.items, values).map(child => (
                  <div key={child.id} className="flex items-center justify-between gap-3">
                    <OptionControl
                      opt={child} values={values} t={t}
                      onChange={onChange} onAction={onAction} readouts={readouts}
                    />
                  </div>
                ))}
              </div>
            ),
          }]}
        />
      )}
    </>
  )
}

// ── The bar ──────────────────────────────────────────────────────────────────

export function ToolOptionsBar({
  t, tool, values, onChange, onAction, readouts, mobile = false, onResetTool, className, style,
}: ToolOptionsBarProps) {
  const def = toolById(tool)
  const all = useMemo(() => visibleOptions(optionsFor(tool), values), [tool, values])

  const outerRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  const [avail, setAvail] = useState(0)
  const [widths, setWidths] = useState<Record<string, number>>({})

  // Available width for the controls area.
  useLayoutEffect(() => {
    const el = outerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const read = () => setAvail(el.clientWidth)
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Natural width of every control, measured from an off-screen mirror row.
  useLayoutEffect(() => {
    const row = measureRef.current
    if (!row) return
    const next: Record<string, number> = {}
    row.querySelectorAll<HTMLElement>('[data-opt-id]').forEach(el => {
      next[el.dataset.optId!] = Math.ceil(el.getBoundingClientRect().width)
    })
    setWidths(prev => {
      const same = Object.keys(next).length === Object.keys(prev).length
        && Object.keys(next).every(k => prev[k] === next[k])
      return same ? prev : next
    })
  }, [all, values, t])

  const { visible, folded } = useMemo(() => {
    if (mobile) {
      // Mobile keeps one 44 px row: only the essentials, everything else folds.
      return { visible: all.filter(o => o.priority === 0), folded: all.filter(o => o.priority !== 0) }
    }
    if (!avail || Object.keys(widths).length === 0) return { visible: all, folded: [] as ToolOption[] }

    const width = (o: ToolOption) => (widths[o.id] ?? 80) + GAP
    let total = all.reduce((s, o) => s + width(o), 0)
    if (total <= avail) return { visible: all, folded: [] as ToolOption[] }

    // Fold from the lowest-priority end backwards until the row fits.
    const order = all
      .map((o, i) => ({ o, i }))
      .sort((a, b) => (b.o.priority - a.o.priority) || (b.i - a.i))
    const dropped = new Set<string>()
    total += OVERFLOW_W
    for (const { o } of order) {
      if (total <= avail) break
      dropped.add(o.id)
      total -= width(o)
    }
    return {
      visible: all.filter(o => !dropped.has(o.id)),
      folded: all.filter(o => dropped.has(o.id)),
    }
  }, [all, avail, widths, mobile])

  const [overflowPos, setOverflowPos] = useState<{ top: number; left: number } | null>(null)
  const [resetPos, setResetPos] = useState<{ top: number; left: number } | null>(null)

  const renderOption = useCallback((opt: ToolOption) => (
    <OptionControl opt={opt} values={values} t={t} onChange={onChange} onAction={onAction} readouts={readouts} />
  ), [values, t, onChange, onAction, readouts])

  const rowHeight = mobile ? 44 : 30

  return (
    <div
      role="toolbar"
      aria-label={`${t('layer_topt_options')} — ${t(def.nameKey)}`}
      className={className}
      style={{
        display: 'flex', alignItems: 'center', gap: GAP, height: rowHeight,
        padding: '0 8px', background: C.header, borderBottom: `1px solid ${C.border}`,
        // A single row, always: never a wrapping multi-line toolbar.
        flexWrap: 'nowrap', overflow: 'hidden', position: 'relative',
        ...style,
      }}
    >
      {/* Tool identity + per-tool reset. */}
      <span className="inline-flex items-center gap-1.5 flex-none">
        <def.Icon size={15} style={{ color: C.text }} />
        {!mobile && <span className="text-[11px] whitespace-nowrap" style={{ color: C.text }}>{t(def.nameKey)}</span>}
        <Tooltip label={t('layer_topt_reset_tool')}>
          <button
            type="button" aria-haspopup="menu" aria-expanded={resetPos !== null}
            aria-label={t('layer_topt_reset_tool')}
            onClick={e => {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
              setResetPos(p => (p ? null : { top: r.bottom + 2, left: r.left }))
            }}
            className="w-5 h-5 inline-flex items-center justify-center rounded-[3px] transition-colors
                       outline-none focus-visible:ring-2 focus-visible:ring-primary"
            style={{ color: C.textDim }}
          >
            <RotateCcw size={13} />
          </button>
        </Tooltip>
      </span>
      <span className="flex-none" style={{ width: 1, height: 16, background: C.border }} />

      {/* Controls. */}
      <div ref={outerRef} className="flex items-center flex-1 min-w-0" style={{ gap: GAP, flexWrap: 'nowrap' }}>
        {visible.map(opt => (
          <span key={opt.id} className="flex-none inline-flex items-center">{renderOption(opt)}</span>
        ))}
      </div>

      {folded.length > 0 && (
        <button
          type="button" aria-haspopup="menu" aria-expanded={overflowPos !== null}
          aria-label={t('layer_topt_more')}
          onClick={e => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
            setOverflowPos(p => (p ? null : { top: r.bottom + 2, left: Math.max(8, r.right - 260) }))
          }}
          className="flex-none w-6 h-5 inline-flex items-center justify-center rounded-[3px] transition-colors
                     outline-none focus-visible:ring-2 focus-visible:ring-primary"
          style={{ background: '#2c2c2c', color: C.text, border: `1px solid #3a3a3a` }}
        >
          <Ellipsis size={14} />
        </button>
      )}

      {overflowPos && (
        <MenuDropdown
          theme="dark" pos={{ ...overflowPos, minWidth: 260 }} onClose={() => setOverflowPos(null)}
          items={[{
            type: 'custom' as const,
            render: () => (
              <div role="group" aria-label={t('layer_topt_more')} className="flex flex-col gap-2 px-3 py-2">
                {folded.map(opt => (
                  <div key={opt.id} className="flex items-center justify-between gap-3">{renderOption(opt)}</div>
                ))}
              </div>
            ),
          }]}
        />
      )}

      {resetPos && (
        <MenuDropdown
          theme="dark" pos={{ ...resetPos, minWidth: 220 }} onClose={() => setResetPos(null)}
          items={[
            { type: 'action', label: t('layer_topt_reset_tool'), onClick: () => onResetTool?.() },
            { type: 'action', label: t('layer_topt_reset_all_tools'), onClick: () => onAction?.('tools-reset-all') },
          ]}
        />
      )}

      {/* Off-screen mirror used only to measure each control's natural width. */}
      <div
        ref={measureRef} aria-hidden="true" inert
        style={{
          position: 'absolute', top: 0, left: 0, visibility: 'hidden', pointerEvents: 'none',
          display: 'flex', alignItems: 'center', gap: GAP, whiteSpace: 'nowrap',
        }}
      >
        {all.map(opt => (
          <span key={opt.id} data-opt-id={opt.id} className="inline-flex items-center flex-none">
            {renderOption(opt)}
          </span>
        ))}
      </div>
    </div>
  )
}
