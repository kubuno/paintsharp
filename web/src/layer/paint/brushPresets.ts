// Brush presets (stamp/dab engine).
//
// Each preset drives the dab distribution & shape. The user-adjustable size /
// opacity sliders stay authoritative; presets only supply sensible defaults &
// the "character" (hardness, spacing, flow, jitter, shape, pressure dynamics).
// Extracted verbatim from LayerEditorPage during the layer/ refactor.
import {
  Circle, Brush, Pencil, Wind, Highlighter, PenLine, Sparkles, PenTool,
  Droplet, SprayCan, Feather,
} from 'lucide-react'

export type BrushPreset = {
  id:             string
  nameKey:        string  // i18n key
  category:       string  // i18n key of the brush-library group
  Icon:           React.ComponentType<{ size?: number; style?: React.CSSProperties }>
  hardness:       number  // 0..100 default edge softness
  spacing:        number  // dab interval as a fraction of the dab radius (>0)
  flow:           number  // 0..1 per-dab alpha (accumulation control)
  sizeJitter:     number  // 0..1 random radius variation per dab
  opacityJitter:  number  // 0..1 random alpha variation per dab
  scatter:        number  // 0..1 random positional offset (× radius)
  angle:          number  // dab rotation in degrees (for elliptical dabs)
  roundness:      number  // 0..1 (1 = circle, <1 = ellipse)
  pressureSize:   boolean // pressure modulates radius
  pressureOpacity:boolean // pressure modulates alpha
  defaultSize:    number  // suggested size (px) applied on first selection
}

// The subset of a brush the Brush Studio lets the user tune live (everything but
// identity/icon). `hardness`, size, opacity and flow already have their own state.
export type BrushDyn = Pick<BrushPreset, 'spacing'|'sizeJitter'|'opacityJitter'|'scatter'|'angle'|'roundness'|'pressureSize'|'pressureOpacity'>

export const extractDyn = (b: BrushPreset): BrushDyn => ({
  spacing:b.spacing, sizeJitter:b.sizeJitter, opacityJitter:b.opacityJitter, scatter:b.scatter,
  angle:b.angle, roundness:b.roundness, pressureSize:b.pressureSize, pressureOpacity:b.pressureOpacity,
})

// Ordered brush-library categories (Procreate-style sets).
export const BRUSH_CATEGORIES = ['sketching','inking','painting','airbrushing','calligraphy','textures'] as const

export const BRUSH_PRESETS: BrushPreset[] = [
  { id:'hard',    nameKey:'layer_brush_preset_hard',   category:'layer_brushcat_painting',   Icon:Circle,      hardness:100, spacing:0.10, flow:1.0,  sizeJitter:0,    opacityJitter:0,    scatter:0,    angle:0,  roundness:1,    pressureSize:true,  pressureOpacity:false, defaultSize:22 },
  { id:'soft',    nameKey:'layer_brush_preset_soft',   category:'layer_brushcat_painting',   Icon:Brush,       hardness:0,   spacing:0.06, flow:0.85, sizeJitter:0,    opacityJitter:0,    scatter:0,    angle:0,  roundness:1,    pressureSize:true,  pressureOpacity:true,  defaultSize:40 },
  { id:'pencil',  nameKey:'layer_brush_preset_pencil', category:'layer_brushcat_sketching',  Icon:Pencil,      hardness:92,  spacing:0.05, flow:0.9,  sizeJitter:0.05, opacityJitter:0.12, scatter:0.04, angle:0,  roundness:1,    pressureSize:true,  pressureOpacity:true,  defaultSize:6  },
  { id:'airbrush',nameKey:'layer_brush_preset_airbrush',category:'layer_brushcat_airbrushing',Icon:Wind,       hardness:0,   spacing:0.04, flow:0.10, sizeJitter:0,    opacityJitter:0.10, scatter:0.25, angle:0,  roundness:1,    pressureSize:false, pressureOpacity:true,  defaultSize:60 },
  { id:'marker',  nameKey:'layer_brush_preset_marker', category:'layer_brushcat_inking',     Icon:Highlighter, hardness:75,  spacing:0.03, flow:1.0,  sizeJitter:0,    opacityJitter:0,    scatter:0,    angle:0,  roundness:1,    pressureSize:false, pressureOpacity:false, defaultSize:30 },
  { id:'calligr', nameKey:'layer_brush_preset_calligraphy', category:'layer_brushcat_calligraphy', Icon:PenLine, hardness:88, spacing:0.05, flow:1.0,  sizeJitter:0,    opacityJitter:0,    scatter:0,    angle:40, roundness:0.28, pressureSize:true,  pressureOpacity:false, defaultSize:34 },
  { id:'charcoal',nameKey:'layer_brush_preset_charcoal',category:'layer_brushcat_sketching',  Icon:Sparkles,   hardness:35,  spacing:0.07, flow:0.55, sizeJitter:0.18, opacityJitter:0.35, scatter:0.45, angle:0,  roundness:0.85, pressureSize:true,  pressureOpacity:true,  defaultSize:46 },
  { id:'ink',     nameKey:'layer_brush_preset_ink',     category:'layer_brushcat_inking',     Icon:PenTool,    hardness:97,  spacing:0.04, flow:1.0,  sizeJitter:0,    opacityJitter:0,    scatter:0,    angle:0,  roundness:1,    pressureSize:true,  pressureOpacity:false, defaultSize:10 },
  { id:'water',   nameKey:'layer_brush_preset_watercolor',category:'layer_brushcat_painting', Icon:Droplet,  hardness:0,   spacing:0.05, flow:0.16, sizeJitter:0.08, opacityJitter:0.25, scatter:0.05, angle:0,  roundness:1,    pressureSize:true,  pressureOpacity:true,  defaultSize:70 },
  { id:'spray',   nameKey:'layer_brush_preset_spray',   category:'layer_brushcat_airbrushing',Icon:SprayCan,   hardness:60,  spacing:0.02, flow:0.05, sizeJitter:0.75, opacityJitter:0.55, scatter:1.0,  angle:0,  roundness:1,    pressureSize:false, pressureOpacity:true,  defaultSize:80 },
  { id:'chalk',   nameKey:'layer_brush_preset_chalk',   category:'layer_brushcat_sketching',  Icon:Feather,    hardness:55,  spacing:0.09, flow:0.7,  sizeJitter:0.3,  opacityJitter:0.45, scatter:0.3,  angle:25, roundness:0.7,  pressureSize:true,  pressureOpacity:true,  defaultSize:38 },
  // Enriched set (Procreate-like breadth).
  { id:'fineliner',nameKey:'layer_brush_preset_fineliner',category:'layer_brushcat_inking',  Icon:PenLine,    hardness:100, spacing:0.03, flow:1.0,  sizeJitter:0,    opacityJitter:0,    scatter:0,    angle:0,  roundness:1,    pressureSize:false, pressureOpacity:false, defaultSize:4  },
  { id:'gouache', nameKey:'layer_brush_preset_gouache', category:'layer_brushcat_painting',   Icon:Brush,      hardness:70,  spacing:0.06, flow:0.9,  sizeJitter:0.04, opacityJitter:0.08, scatter:0.03, angle:0,  roundness:0.95, pressureSize:true,  pressureOpacity:false, defaultSize:48 },
  { id:'oilpastel',nameKey:'layer_brush_preset_oilpastel',category:'layer_brushcat_sketching',Icon:Pencil,     hardness:45,  spacing:0.08, flow:0.75, sizeJitter:0.22, opacityJitter:0.3,  scatter:0.35, angle:15, roundness:0.8,  pressureSize:true,  pressureOpacity:true,  defaultSize:42 },
  { id:'stipple', nameKey:'layer_brush_preset_stipple', category:'layer_brushcat_textures',   Icon:SprayCan,   hardness:85,  spacing:0.5,  flow:0.9,  sizeJitter:0.5,  opacityJitter:0.4,  scatter:1.2,  angle:0,  roundness:1,    pressureSize:false, pressureOpacity:false, defaultSize:26 },
  { id:'grain',   nameKey:'layer_brush_preset_grain',   category:'layer_brushcat_textures',   Icon:Sparkles,   hardness:30,  spacing:0.12, flow:0.6,  sizeJitter:0.6,  opacityJitter:0.6,  scatter:0.7,  angle:0,  roundness:0.9,  pressureSize:true,  pressureOpacity:true,  defaultSize:36 },
]

export const DEFAULT_BRUSH = BRUSH_PRESETS[0]
