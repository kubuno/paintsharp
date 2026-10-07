import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Input, NumberInput, Dropdown } from '@ui'
import { FloatingWindow } from '@ui'
import { FileText } from 'lucide-react'

// Fenêtre flottante « Nouveau document » (façon Photoshop) pour Layer :
// catégories de préréglages vierges à gauche, détails du préréglage à droite.

type Unit = 'px' | 'in' | 'cm' | 'mm'

export interface NewLayerDocParams {
  title:      string
  width:      number   // pixels
  height:     number   // pixels
  color_mode: string
  bit_depth:  number
  dpi:        number
}

interface Preset {
  id:    string
  label: string  // formats/marques — non traduits
  w:     number
  h:     number
  unit:  Unit
  dpi:   number
}

interface Category { id: string; presets: Preset[] }

const CATEGORIES: Category[] = [
  { id: 'print', presets: [
    { id: 'letter',  label: 'US Letter', w: 8.5, h: 11,  unit: 'in', dpi: 300 },
    { id: 'legal',   label: 'Legal',     w: 8.5, h: 14,  unit: 'in', dpi: 300 },
    { id: 'tabloid', label: 'Tabloid',   w: 11,  h: 17,  unit: 'in', dpi: 300 },
    { id: 'a4',      label: 'A4',        w: 210, h: 297, unit: 'mm', dpi: 300 },
    { id: 'a3',      label: 'A3',        w: 297, h: 420, unit: 'mm', dpi: 300 },
    { id: 'a5',      label: 'A5',        w: 148, h: 210, unit: 'mm', dpi: 300 },
  ]},
  { id: 'screen', presets: [
    { id: 'hd',      label: 'HD 1080p',   w: 1920, h: 1080, unit: 'px', dpi: 72 },
    { id: 'uhd',     label: '4K UHD',     w: 3840, h: 2160, unit: 'px', dpi: 72 },
    { id: 'hd720',   label: 'HD 720p',    w: 1280, h: 720,  unit: 'px', dpi: 72 },
    { id: 'web',     label: 'Web 1440',   w: 1440, h: 1024, unit: 'px', dpi: 72 },
  ]},
  { id: 'photo', presets: [
    { id: 'p43',     label: '10×15 cm',   w: 15,  h: 10,  unit: 'cm', dpi: 300 },
    { id: 'p57',     label: '13×18 cm',   w: 18,  h: 13,  unit: 'cm', dpi: 300 },
    { id: 'square',  label: 'Square 2000', w: 2000, h: 2000, unit: 'px', dpi: 300 },
  ]},
  { id: 'mobile', presets: [
    { id: 'iphone',  label: 'iPhone',     w: 1170, h: 2532, unit: 'px', dpi: 72 },
    { id: 'android', label: 'Android',    w: 1080, h: 1920, unit: 'px', dpi: 72 },
    { id: 'insta',   label: 'Instagram',  w: 1080, h: 1080, unit: 'px', dpi: 72 },
    { id: 'story',   label: 'Story',      w: 1080, h: 1920, unit: 'px', dpi: 72 },
  ]},
]

const BG_COLORS: Record<string, string> = { white: '#ffffff', black: '#000000', transparent: 'transparent' }

function toPixels(value: number, unit: Unit, dpi: number): number {
  switch (unit) {
    case 'px': return Math.round(value)
    case 'in': return Math.round(value * dpi)
    case 'cm': return Math.round((value / 2.54) * dpi)
    case 'mm': return Math.round((value / 25.4) * dpi)
  }
}

interface Props {
  onClose:  () => void
  onCreate: (params: NewLayerDocParams) => void
  loading?: boolean
}

export default function NewLayerDocumentModal({ onClose, onCreate, loading }: Props) {
  const { t } = useTranslation('paintsharp')

  const [cat, setCat]         = useState('print')
  const [presetId, setPreset] = useState('letter')
  const [name, setName]       = useState(() => t('ldnew_untitled'))
  const [width, setWidth]     = useState(8.5)
  const [height, setHeight]   = useState(11)
  const [unit, setUnit]       = useState<Unit>('in')
  const [dpi, setDpi]         = useState(300)
  const [colorMode, setColorMode] = useState('rgba')
  const [bitDepth, setBitDepth]   = useState('8')
  const [background, setBackground] = useState('white')

  const unitOpts = useMemo(() => [
    { value: 'px', label: t('ldnew_unit_px') }, { value: 'in', label: t('ldnew_unit_in') },
    { value: 'cm', label: t('ldnew_unit_cm') }, { value: 'mm', label: t('ldnew_unit_mm') },
  ], [t])
  const colorModeOpts = useMemo(() => [
    { value: 'rgba', label: t('ldnew_cm_rgb') }, { value: 'grayscale', label: t('ldnew_cm_gray') },
  ], [t])
  const bitDepthOpts = useMemo(() => [
    { value: '8', label: t('ldnew_depth_bits', { n: 8 }) },
    { value: '16', label: t('ldnew_depth_bits', { n: 16 }) },
    { value: '32', label: t('ldnew_depth_bits', { n: 32 }) },
  ], [t])
  const bgOpts = useMemo(() => [
    { value: 'white', label: t('ldnew_bg_white') }, { value: 'black', label: t('ldnew_bg_black') },
    { value: 'transparent', label: t('ldnew_bg_transparent') },
  ], [t])

  const applyPreset = (p: Preset) => {
    setPreset(p.id); setWidth(p.w); setHeight(p.h); setUnit(p.unit); setDpi(p.dpi)
  }

  const orientation: 'portrait' | 'landscape' = height >= width ? 'portrait' : 'landscape'
  const setOrientation = (o: 'portrait' | 'landscape') => {
    if (o === orientation) return
    setWidth(height); setHeight(width); setPreset('')
  }

  const presets = useMemo(() => CATEGORIES.find(c => c.id === cat)?.presets ?? [], [cat])

  const handleCreate = () => {
    onCreate({
      title:      name.trim() || t('ldnew_untitled'),
      width:      Math.max(1, toPixels(width, unit, dpi)),
      height:     Math.max(1, toPixels(height, unit, dpi)),
      color_mode: colorMode,
      bit_depth:  parseInt(bitDepth, 10),
      dpi,
    })
  }

  const pxW = Math.max(1, toPixels(width, unit, dpi))
  const pxH = Math.max(1, toPixels(height, unit, dpi))

  return (
    <FloatingWindow title={t('layerdocs_new_doc')} onClose={onClose} defaultWidth={880} defaultHeight={560} resizable backdrop>
      <div className="flex h-full min-h-0">
        {/* Préréglages (gauche) */}
        <div className="flex-1 min-w-0 flex flex-col border-r border-border">
          {/* Onglets catégories */}
          <div className="flex items-center gap-1 px-4 pt-3 pb-2 border-b border-border flex-shrink-0 overflow-x-auto">
            {CATEGORIES.map(c => (
              <button
                key={c.id}
                onClick={() => setCat(c.id)}
                className={`px-3 py-1.5 text-sm rounded-md whitespace-nowrap transition-colors ${
                  cat === c.id ? 'bg-primary-light text-primary font-medium' : 'text-text-secondary hover:bg-surface-2'
                }`}
              >
                {t(`ldnew_cat_${c.id}`)}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-text-tertiary mb-3">
              {t('ldnew_blank_presets')}
            </p>
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
              {presets.map(p => {
                const active = presetId === p.id
                return (
                  <button
                    key={p.id}
                    onClick={() => applyPreset(p)}
                    className={`flex flex-col items-center gap-2 p-3 rounded-lg border transition-all ${
                      active ? 'border-primary bg-primary-light' : 'border-border hover:border-border-strong hover:bg-surface-1'
                    }`}
                  >
                    <FileText size={40} strokeWidth={1} className={active ? 'text-primary' : 'text-text-tertiary'} />
                    <span className="text-xs font-medium text-text-primary text-center leading-tight">{p.label}</span>
                    <span className="text-[10px] text-text-tertiary text-center">
                      {p.w} × {p.h} {p.unit} · {p.dpi} ppi
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        </div>

        {/* Détails du préréglage (droite) */}
        <div className="w-[300px] flex-shrink-0 flex flex-col bg-surface-1">
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-text-tertiary">{t('ldnew_preset_details')}</p>

            <Input label={t('ldnew_f_name')} value={name} onChange={e => setName(e.target.value)} />

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-xs text-text-secondary mb-1">{t('ldnew_f_width')}</label>
                <NumberInput value={width} min={1} onChange={v => { setWidth(v); setPreset('') }} />
              </div>
              <div>
                <label className="block text-xs text-text-secondary mb-1">{t('ldnew_f_unit')}</label>
                <Dropdown value={unit} onChange={v => setUnit(v as Unit)} options={unitOpts} width="100%" height={36} />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 items-end">
              <div>
                <label className="block text-xs text-text-secondary mb-1">{t('ldnew_f_height')}</label>
                <NumberInput value={height} min={1} onChange={v => { setHeight(v); setPreset('') }} />
              </div>
              <div>
                <label className="block text-xs text-text-secondary mb-1">{t('ldnew_f_orientation')}</label>
                <div className="flex gap-1">
                  <button
                    onClick={() => setOrientation('portrait')}
                    className={`flex-1 h-9 rounded-md border flex items-center justify-center transition-colors ${
                      orientation === 'portrait' ? 'border-primary bg-primary-light text-primary' : 'border-border text-text-secondary hover:bg-surface-2'
                    }`}
                    title={t('ldnew_orient_portrait')}
                  >
                    <div className="w-3.5 h-5 border-2 border-current rounded-sm" />
                  </button>
                  <button
                    onClick={() => setOrientation('landscape')}
                    className={`flex-1 h-9 rounded-md border flex items-center justify-center transition-colors ${
                      orientation === 'landscape' ? 'border-primary bg-primary-light text-primary' : 'border-border text-text-secondary hover:bg-surface-2'
                    }`}
                    title={t('ldnew_orient_landscape')}
                  >
                    <div className="w-5 h-3.5 border-2 border-current rounded-sm" />
                  </button>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-xs text-text-secondary mb-1">{t('ldnew_f_resolution')}</label>
                <NumberInput value={dpi} min={1} onChange={v => setDpi(v)} />
              </div>
              <div>
                <label className="block text-xs text-text-secondary mb-1">&nbsp;</label>
                <div className="h-9 flex items-center px-2 text-sm text-text-tertiary border border-border rounded-md">{t('ldnew_res_ppi')}</div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-xs text-text-secondary mb-1">{t('ldnew_f_colormode')}</label>
                <Dropdown value={colorMode} onChange={setColorMode} options={colorModeOpts} width="100%" height={36} />
              </div>
              <div>
                <label className="block text-xs text-text-secondary mb-1">{t('ldnew_f_depth')}</label>
                <Dropdown value={bitDepth} onChange={setBitDepth} options={bitDepthOpts} width="100%" height={36} />
              </div>
            </div>

            <div>
              <label className="block text-xs text-text-secondary mb-1">{t('ldnew_f_background')}</label>
              <div className="flex items-center gap-2">
                <div className="flex-1"><Dropdown value={background} onChange={setBackground} options={bgOpts} width="100%" height={36} /></div>
                <div
                  className="w-9 h-9 rounded-md border border-border flex-shrink-0"
                  style={background === 'transparent'
                    ? { backgroundImage: 'linear-gradient(45deg,#ccc 25%,transparent 25%,transparent 75%,#ccc 75%),linear-gradient(45deg,#ccc 25%,#fff 25%,#fff 75%,#ccc 75%)', backgroundSize: '10px 10px', backgroundPosition: '0 0,5px 5px' }
                    : { background: BG_COLORS[background] }}
                />
              </div>
            </div>

            <p className="text-[11px] text-text-tertiary pt-1">{t('ldnew_final_size', { w: pxW, h: pxH })}</p>
          </div>

          {/* Pied : actions */}
          <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border flex-shrink-0">
            <Button variant="secondary" onClick={onClose}>{t('ldnew_close')}</Button>
            <Button onClick={handleCreate} loading={loading}>{t('ldnew_create')}</Button>
          </div>
        </div>
      </div>
    </FloatingWindow>
  )
}
