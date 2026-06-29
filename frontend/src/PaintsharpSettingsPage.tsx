import React, { useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Palette, ArrowLeft, ExternalLink, Check } from 'lucide-react'
import { Toggle, Button, Radio } from '@ui'
import { useModulePrefs } from './userPrefs'

// ── Per-user preferences (backend, cross-device via core users.preferences) ─────
// Instance-wide (admin) settings are declared in module.toml `[[settings]]` and
// edited from the core admin console, not from a tab inside the module.

interface PaintsharpPrefs extends Record<string, unknown> {
  editorTheme: string   // 'dark' | 'light'
  showGrid:    boolean
  showRuler:   boolean
  snapping:    boolean
  autosave:    boolean
  brushCursor: string   // 'small' | 'medium' | 'large'
  units:       string   // 'px' | 'cm'
}

const DEFAULT_PREFS: PaintsharpPrefs = {
  editorTheme: 'dark', showGrid: true, showRuler: true,
  snapping: true, autosave: true, brushCursor: 'medium', units: 'px',
}

// ── Mail-style layout helpers ───────────────────────────────────────────────────

function SettingsRow({ label, description, children }: {
  label: string; description?: string; children: React.ReactNode
}) {
  return (
    <div className="flex items-start gap-8 py-4 border-b border-[#e8eaed] last:border-0">
      <div className="w-60 flex-shrink-0">
        <p className="text-sm text-[#202124] font-normal">{label}</p>
        {description && <p className="text-xs text-text-tertiary mt-0.5 leading-relaxed">{description}</p>}
      </div>
      <div className="flex-1">{children}</div>
    </div>
  )
}

function RadioGroup({ options, value, onChange }: {
  options: { value: string; label: string }[]; value: string; onChange: (v: string) => void
}) {
  return (
    <div className="flex flex-col items-start gap-2">
      {options.map(opt => (
        <Radio key={opt.value} checked={value === opt.value} onChange={() => onChange(opt.value)} label={opt.label} />
      ))}
    </div>
  )
}

// ── Préférences tab (per-user, backend-persisted) ───────────────────────────────

function PreferencesTab() {
  const { t } = useTranslation('paintsharp')
  const { prefs: saved, update } = useModulePrefs<PaintsharpPrefs>('paintsharp', DEFAULT_PREFS)
  const [prefs, setPrefs] = useState<PaintsharpPrefs>(saved)
  const [savedFlag, setSavedFlag] = useState(false)
  const [busy, setBusy] = useState(false)

  const set = <K extends keyof PaintsharpPrefs>(key: K, value: PaintsharpPrefs[K]) =>
    setPrefs(p => ({ ...p, [key]: value }))

  const save = async () => {
    setBusy(true)
    try {
      await update(prefs)
      setSavedFlag(true)
      setTimeout(() => setSavedFlag(false), 2500)
    } finally { setBusy(false) }
  }

  return (
    <div>
      <SettingsRow
        label={t('pref_editor_theme', { defaultValue: 'Thème de l\'éditeur' })}
        description={t('pref_editor_theme_desc', { defaultValue: 'Apparence des espaces de travail créatifs (Apex, Layer, Vertex, Motion).' })}
      >
        <RadioGroup
          value={prefs.editorTheme}
          onChange={v => set('editorTheme', v)}
          options={[
            { value: 'dark',  label: t('pref_editor_theme_dark',  { defaultValue: 'Sombre' }) },
            { value: 'light', label: t('pref_editor_theme_light', { defaultValue: 'Clair' }) },
          ]}
        />
      </SettingsRow>

      <SettingsRow label={t('pref_grid', { defaultValue: 'Grille' })}>
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <Toggle checked={prefs.showGrid} onChange={() => set('showGrid', !prefs.showGrid)} />
          <span className="text-sm text-text-primary">{t('pref_grid_on', { defaultValue: 'Afficher la grille sur le canevas' })}</span>
        </label>
      </SettingsRow>

      <SettingsRow label={t('pref_ruler', { defaultValue: 'Règle' })}>
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <Toggle checked={prefs.showRuler} onChange={() => set('showRuler', !prefs.showRuler)} />
          <span className="text-sm text-text-primary">{t('pref_ruler_on', { defaultValue: 'Afficher les règles sur les bords du canevas' })}</span>
        </label>
      </SettingsRow>

      <SettingsRow
        label={t('pref_snapping', { defaultValue: 'Magnétisme' })}
        description={t('pref_snapping_desc', { defaultValue: 'Aligner automatiquement les objets sur la grille et les repères.' })}
      >
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <Toggle checked={prefs.snapping} onChange={() => set('snapping', !prefs.snapping)} />
          <span className="text-sm text-text-primary">{t('pref_snapping_on', { defaultValue: 'Activer le magnétisme' })}</span>
        </label>
      </SettingsRow>

      <SettingsRow
        label={t('pref_autosave', { defaultValue: 'Auto-sauvegarde' })}
        description={t('pref_autosave_desc', { defaultValue: 'Enregistrer automatiquement vos modifications pendant le travail.' })}
      >
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <Toggle checked={prefs.autosave} onChange={() => set('autosave', !prefs.autosave)} />
          <span className="text-sm text-text-primary">{t('pref_autosave_on', { defaultValue: 'Activer l\'auto-sauvegarde' })}</span>
        </label>
      </SettingsRow>

      <SettingsRow
        label={t('pref_brush_cursor', { defaultValue: 'Taille du curseur de pinceau' })}
        description={t('pref_brush_cursor_desc', { defaultValue: 'Taille de l\'indicateur de pinceau dans les éditeurs raster.' })}
      >
        <RadioGroup
          value={prefs.brushCursor}
          onChange={v => set('brushCursor', v)}
          options={[
            { value: 'small',  label: t('pref_brush_cursor_small',  { defaultValue: 'Petit' }) },
            { value: 'medium', label: t('pref_brush_cursor_medium', { defaultValue: 'Moyen' }) },
            { value: 'large',  label: t('pref_brush_cursor_large',  { defaultValue: 'Grand' }) },
          ]}
        />
      </SettingsRow>

      <SettingsRow
        label={t('pref_units', { defaultValue: 'Unités' })}
        description={t('pref_units_desc', { defaultValue: 'Unité de mesure affichée dans les éditeurs.' })}
      >
        <RadioGroup
          value={prefs.units}
          onChange={v => set('units', v)}
          options={[
            { value: 'px', label: t('pref_units_px', { defaultValue: 'Pixels (px)' }) },
            { value: 'cm', label: t('pref_units_cm', { defaultValue: 'Centimètres (cm)' }) },
          ]}
        />
      </SettingsRow>

      <div className="pt-5 flex items-center gap-3">
        <Button onClick={save} loading={busy}>
          {savedFlag
            ? <><Check size={14} className="mr-1.5 inline" />{t('settings_saved', { defaultValue: 'Enregistré' })}</>
            : t('settings_save_changes', { defaultValue: 'Enregistrer les modifications' })}
        </Button>
        <Button variant="ghost" onClick={() => setPrefs(saved)}>
          {t('common_cancel', { defaultValue: 'Annuler' })}
        </Button>
      </div>
    </div>
  )
}

// ── About ───────────────────────────────────────────────────────────────────────

function AboutTab() {
  const { t } = useTranslation('paintsharp')
  const SUBMODULES = [
    { name: 'Vertex',    desc: t('settings_submodule_vertex_desc'),   color: '#e8824a' },
    { name: 'Layer',     desc: t('settings_submodule_layer_desc'),    color: '#4a90e8' },
    { name: 'Apex',      desc: t('settings_submodule_apex_desc'),     color: '#e84a90' },
    { name: 'Keyframe',  desc: t('settings_submodule_keyframe_desc'), color: '#e8e84a' },
    { name: 'Motion',    desc: t('settings_submodule_motion_desc'),   color: '#4ae84a' },
  ]

  return (
    <div className="bg-white rounded-xl border border-border overflow-hidden">
      <div className="flex items-center gap-3 p-5 border-b border-border">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center"
             style={{ background: '#1a1a2e' }}>
          <Palette size={20} style={{ color: '#e8824a' }} />
        </div>
        <div>
          <p className="text-sm font-semibold text-text-primary">Kubuno Paintsharp</p>
          <p className="text-xs text-text-tertiary">v0.1.0 · {t('settings_official_module')}</p>
        </div>
        <span className="ml-auto text-xs font-medium px-2 py-0.5 rounded-full bg-orange-100 text-orange-700">
          Rust
        </span>
      </div>

      <div className="divide-y divide-border">
        <div className="px-5 py-4">
          <p className="text-xs font-semibold text-text-tertiary uppercase tracking-wider mb-2">{t('settings_description_label')}</p>
          <p className="text-sm text-text-secondary leading-relaxed">
            {t('settings_description_text')}
          </p>
        </div>

        <div className="px-5 py-4">
          <p className="text-xs font-semibold text-text-tertiary uppercase tracking-wider mb-3">{t('settings_submodules_label')}</p>
          <div className="space-y-2">
            {SUBMODULES.map(s => (
              <div key={s.name} className="flex items-center gap-3">
                <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: s.color }} />
                <span className="text-sm font-medium text-text-primary w-20">{s.name}</span>
                <span className="text-xs text-text-secondary">{s.desc}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="px-5 py-4 grid grid-cols-2 gap-4">
          <div>
            <p className="text-xs font-semibold text-text-tertiary uppercase tracking-wider mb-2">{t('settings_author_label')}</p>
            <p className="text-sm text-text-primary">Kubuno Contributors</p>
          </div>
          <div>
            <p className="text-xs font-semibold text-text-tertiary uppercase tracking-wider mb-2">{t('settings_license_label')}</p>
            <p className="text-sm text-text-primary">AGPL-3.0</p>
          </div>
        </div>

        <div className="px-5 py-4">
          <p className="text-xs font-semibold text-text-tertiary uppercase tracking-wider mb-3">{t('settings_technologies_label')}</p>
          <div className="flex flex-wrap gap-2">
            {['Rust', 'Axum 0.7', 'SQLx 0.8', 'PostgreSQL 16', 'tokio', 'WebSocket', 'Three.js', 'Canvas 2D', 'Fabric.js (Apex)'].map(tech => (
              <span key={tech} className="text-xs px-2 py-1 rounded-lg bg-surface-2 text-text-secondary font-mono">{tech}</span>
            ))}
          </div>
        </div>

        <div className="px-5 py-4">
          <p className="text-xs font-semibold text-text-tertiary uppercase tracking-wider mb-2">{t('settings_links_label')}</p>
          <a href="https://github.com/kubuno/kubuno" target="_blank" rel="noopener noreferrer"
             className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline">
            <ExternalLink size={13} />
            github.com/kubuno/kubuno
          </a>
        </div>
      </div>
    </div>
  )
}

// ── Main page (mail-style breadcrumb + tab bar) ─────────────────────────────────

type Tab = 'preferences' | 'about'

export default function PaintsharpSettingsPage() {
  const { t } = useTranslation('paintsharp')
  const [tab, setTab] = useState<Tab>('preferences')

  const tabs: { id: Tab; label: string }[] = [
    { id: 'preferences', label: t('settings_tab_preferences', { defaultValue: 'Préférences' }) },
    { id: 'about',       label: t('settings_tab_about') },
  ]

  return (
    <div className="flex flex-col h-full bg-white overflow-hidden">
      {/* Breadcrumb header */}
      <div className="flex items-center gap-2 px-6 py-2.5 border-b border-[#e8eaed] flex-shrink-0" style={{ background: '#f8f9fa' }}>
        <Link to="/paintsharp" className="flex items-center gap-1.5 text-sm text-[#1a73e8] hover:underline">
          <ArrowLeft size={14} />
          PaintSharp
        </Link>
        <span className="text-text-tertiary text-sm">/</span>
        <div className="flex items-center gap-1.5">
          <Palette size={15} className="text-text-secondary" />
          <span className="text-sm text-text-primary">{t('settings_page_title', { defaultValue: 'Réglages' })}</span>
        </div>
      </div>

      {/* Tab bar (Gmail-style) */}
      <div className="flex items-end border-b border-[#e8eaed] px-4 flex-shrink-0 overflow-x-auto" style={{ background: '#fff' }}>
        {tabs.map(tb => (
          <button key={tb.id} onClick={() => setTab(tb.id)}
            className={`px-4 py-3 text-sm border-b-2 -mb-px transition-colors whitespace-nowrap ${
              tab === tb.id ? 'border-[#1a73e8] text-[#1a73e8] font-medium' : 'border-transparent text-[#5f6368] hover:text-[#202124] hover:bg-[#f1f3f4]'}`}>
            {tb.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-8 py-6">
          {tab === 'preferences' && <PreferencesTab />}
          {tab === 'about'  && <AboutTab />}
        </div>
      </div>
    </div>
  )
}
