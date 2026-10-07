// Foreground / background colour swatches for the Layer tool rail.
//
// Same visual language as Apex's fill/stroke pair, so the two editors read alike:
// two overlapping discs — the foreground solid at top-left with a white
// inner ring, the background rendered as a DONUT at bottom-right (its hole is
// punched with the rail colour) — and a swap control underneath.
//
// Both discs are `ColorField` from `@ui`, which brings the shared picker and the
// recent-colour history with it.
import type { TFunction } from 'i18next'
import { ColorField } from '../../ui'

export interface ColorSwatchesProps {
  t: TFunction
  /** Picker theme, forwarded to `ColorField`. */
  C: Parameters<typeof ColorField>[0]['C']
  fg: string
  bg: string
  onFg: (hex: string) => void
  onBg: (hex: string) => void
  onSwap: () => void
  onReset: () => void
  /** Recent colours, shared with the rest of the editor. */
  history?: string[]
  onPickHistory?: (hex: string) => void
  /** Colour painted into the donut hole so it reads as a ring, not a disc. */
  railBg: string
}

// Sized to sit inside the 44 px tool rail with a little breathing room.
const DISC = 23
const BOX = 34

export function ColorSwatches({
  t, C, fg, bg, onFg, onBg, onSwap, onReset, history, onPickHistory, railBg,
}: ColorSwatchesProps) {
  return (
    <div className="flex flex-col items-center mb-1">
      <div className="relative" style={{ width: BOX, height: BOX }}>
        {/* Background — behind and below-right, drawn as a ring. */}
        <ColorField
          t={t} C={C} width={DISC} height={DISC} className="absolute"
          style={{ right: 0, bottom: 0, borderRadius: '50%', overflow: 'hidden' }}
          color={bg} onChange={onBg} history={history} onPickHistory={onPickHistory}
        />
        <div className="absolute pointer-events-none"
             style={{ right: 0, bottom: 0, width: DISC, height: DISC, borderRadius: '50%',
                      boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.35)' }} />
        {/* The hole: filled with the rail colour so the disc reads as a ring. */}
        <div className="absolute pointer-events-none"
             style={{ right: 6.5, bottom: 6.5, width: 10, height: 10, borderRadius: '50%',
                      background: railBg, boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.3)' }} />

        {/* Foreground — in front, solid, ringed in white like Apex's fill. */}
        <ColorField
          t={t} C={C} width={DISC} height={DISC} className="absolute"
          style={{ left: 0, top: 0, borderRadius: '50%', overflow: 'hidden' }}
          color={fg} onChange={onFg} history={history} onPickHistory={onPickHistory}
        />
        <div className="absolute pointer-events-none"
             style={{ left: 0, top: 0, width: DISC, height: DISC, borderRadius: '50%',
                      boxShadow: 'inset 0 0 0 2px #fff, 0 0 0 1px rgba(0,0,0,0.45)' }} />
      </div>

      <div className="flex gap-0.5 mt-0.5">
        {/* Swap (X) — same curved arrow as Apex. */}
        <button type="button" onClick={onSwap} title={`${t('layer_color_swap')} (X)`}
                aria-label={t('layer_color_swap')}
                className="flex items-center justify-center hover:bg-white/10"
                style={{ width: 21, height: 20, borderRadius: 6, boxSizing: 'border-box', color: 'rgb(142,142,142)' }}>
          <svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor"
               strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"
               style={{ transform: 'scaleY(-1)' }} aria-hidden="true">
            <path d="M3.5 7 Q8 2.5 12.5 7" />
            <path d="M3.5 7 l0.4 -2.1 M3.5 7 l2.1 0.4" />
            <path d="M12.5 7 l-0.4 -2.1 M12.5 7 l-2.1 0.4" />
          </svg>
        </button>
        {/* Restore black / white (D). */}
        <button type="button" onClick={onReset} title={`${t('layer_color_reset')} (D)`}
                aria-label={t('layer_color_reset')}
                className="flex items-center justify-center hover:bg-white/10"
                style={{ width: 21, height: 20, borderRadius: 6, boxSizing: 'border-box' }}>
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <circle cx="9" cy="9" r="4.2" fill="#ffffff" stroke="rgba(0,0,0,0.45)" strokeWidth="1" />
            <circle cx="5" cy="5" r="4.2" fill="#000000" stroke="rgba(255,255,255,0.55)" strokeWidth="1" />
          </svg>
        </button>
      </div>
    </div>
  )
}
