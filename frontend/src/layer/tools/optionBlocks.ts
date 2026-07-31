// The five reusable option blocks (spec §2.0). Together they cover ~80 % of the
// tools' options bars: a `ToolDef` composes them with `blocks: [...]` and only
// declares what is genuinely its own. They are plain constants, never JSX, so the
// same description drives the horizontal options bar, the vertical properties
// dock and the mobile bottom sheet.
import {
  AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical,
  AlignHorizontalSpaceBetween, AlignStartHorizontal, AlignStartVertical,
  AlignVerticalSpaceBetween, Circle, Combine, Diff, Grid2x2, Group, Merge, Shapes,
  Spline, Square, SquareDot, SquareMinus, SquarePlus, Ungroup,
} from 'lucide-react'
import type { OptionBlockId, ToolOption, ToolValues } from './types'

// ── BLOC A — selection mode, carried by every selection tool ─────────────────

/** The four boolean combinations, driven by Shift / Alt as well. */
export const SELECTION_MODE_CHOICES = [
  { value: 'new',       labelKey: 'layer_topt_sel_mode_new',       icon: Square },
  { value: 'add',       labelKey: 'layer_topt_sel_mode_add',       icon: SquarePlus },
  { value: 'subtract',  labelKey: 'layer_topt_sel_mode_subtract',  icon: SquareMinus },
  { value: 'intersect', labelKey: 'layer_topt_sel_mode_intersect', icon: SquareDot },
]

const SELECTION: ToolOption[] = [
  {
    kind: 'segmented', id: 'sel-mode', labelKey: 'layer_topt_sel_mode', priority: 0,
    choices: SELECTION_MODE_CHOICES, def: 'new',
  },
  {
    kind: 'number', id: 'feather', labelKey: 'layer_topt_feather', priority: 1,
    min: 0, max: 250, step: 1, unit: 'px', def: 0, width: 52,
  },
  { kind: 'toggle', id: 'antialias', labelKey: 'layer_topt_antialias', priority: 1, def: true },
  { kind: 'action', id: 'refine-edge', labelKey: 'layer_topt_refine_edge', priority: 2, run: 'refine-edge' },
]

// ── BLOC B — brush core, carried by every stamping tool ──────────────────────

export const SYMMETRY_CHOICES = [
  { value: 'none',       labelKey: 'layer_topt_symmetry_none' },
  { value: 'vertical',   labelKey: 'layer_topt_symmetry_vertical' },
  { value: 'horizontal', labelKey: 'layer_topt_symmetry_horizontal' },
  { value: 'quadrant',   labelKey: 'layer_topt_symmetry_quadrant' },
  { value: 'radial',     labelKey: 'layer_topt_symmetry_radial' },
  { value: 'mandala',    labelKey: 'layer_topt_symmetry_mandala' },
]

const BRUSH_CORE: ToolOption[] = [
  { kind: 'brush',  id: 'brush', labelKey: 'layer_topt_brush', priority: 0, def: 'hard' },
  {
    kind: 'number', id: 'size', labelKey: 'layer_topt_size', priority: 0,
    min: 1, max: 5000, step: 1, unit: 'px', def: 22, width: 56,
  },
  {
    kind: 'slider', id: 'hardness', labelKey: 'layer_topt_hardness', priority: 1,
    min: 0, max: 100, step: 1, unit: '%', def: 100, width: 84,
  },
  { kind: 'blend',  id: 'blend', labelKey: 'layer_topt_blend', priority: 1, def: 'normal', width: 116 },
  {
    kind: 'number', id: 'opacity', labelKey: 'layer_topt_opacity', priority: 0,
    min: 0, max: 100, step: 1, unit: '%', def: 100, width: 52,
  },
  {
    kind: 'number', id: 'flow', labelKey: 'layer_topt_flow', priority: 1,
    min: 1, max: 100, step: 1, unit: '%', def: 100, width: 52,
  },
  {
    kind: 'number', id: 'smoothing', labelKey: 'layer_topt_smoothing', priority: 2,
    min: 0, max: 100, step: 1, unit: '%', def: 0, width: 52,
  },
  { kind: 'toggle', id: 'airbrush',          labelKey: 'layer_topt_airbrush',          priority: 2, def: false },
  { kind: 'toggle', id: 'pressure-size',     labelKey: 'layer_topt_pressure_size',     priority: 2, def: true },
  { kind: 'toggle', id: 'pressure-opacity',  labelKey: 'layer_topt_pressure_opacity',  priority: 2, def: false },
  {
    kind: 'select', id: 'symmetry', labelKey: 'layer_topt_symmetry', priority: 2,
    choices: SYMMETRY_CHOICES, def: 'none', width: 108,
  },
]

// ── BLOC C — pixel sampling, carried by wand / bucket / healing / stamps ─────

export const SAMPLE_SOURCE_CHOICES = [
  { value: 'active',      labelKey: 'layer_topt_sample_source_active' },
  { value: 'active-below', labelKey: 'layer_topt_sample_source_below' },
  { value: 'all',         labelKey: 'layer_topt_sample_source_all' },
]

const SAMPLING: ToolOption[] = [
  {
    kind: 'number', id: 'tolerance', labelKey: 'layer_topt_tolerance', priority: 0,
    min: 0, max: 255, step: 1, def: 32, width: 52,
  },
  { kind: 'toggle', id: 'contiguous', labelKey: 'layer_topt_contiguous', priority: 1, def: true },
  { kind: 'toggle', id: 'sample-all', labelKey: 'layer_topt_sample_all', priority: 1, def: false },
  {
    kind: 'select', id: 'sample-source', labelKey: 'layer_topt_sample_source', priority: 2,
    choices: SAMPLE_SOURCE_CHOICES, def: 'active', width: 132,
  },
]

// ── BLOC D — vector shape styling, carried by shapes and the pen ─────────────

export const SHAPE_OUTPUT_CHOICES = [
  { value: 'shape',  labelKey: 'layer_topt_shape_output_shape',  icon: Shapes },
  { value: 'path',   labelKey: 'layer_topt_shape_output_path',   icon: Spline },
  { value: 'pixels', labelKey: 'layer_topt_shape_output_pixels', icon: Grid2x2 },
]

export const STROKE_STYLE_CHOICES = [
  { value: 'solid',  labelKey: 'layer_topt_stroke_style_solid' },
  { value: 'dashed', labelKey: 'layer_topt_stroke_style_dashed' },
  { value: 'dotted', labelKey: 'layer_topt_stroke_style_dotted' },
]

export const PATH_OP_CHOICES = [
  { value: 'new',       labelKey: 'layer_topt_path_op_new',       icon: Square },
  { value: 'union',     labelKey: 'layer_topt_path_op_union',     icon: Combine },
  { value: 'subtract',  labelKey: 'layer_topt_path_op_subtract',  icon: Diff },
  { value: 'intersect', labelKey: 'layer_topt_path_op_intersect', icon: Group },
  { value: 'exclude',   labelKey: 'layer_topt_path_op_exclude',   icon: Ungroup },
  { value: 'merge',     labelKey: 'layer_topt_path_op_merge',     icon: Merge },
]

export const PATH_ORDER_CHOICES = [
  { value: 'front',    labelKey: 'layer_topt_path_order_front' },
  { value: 'forward',  labelKey: 'layer_topt_path_order_forward' },
  { value: 'backward', labelKey: 'layer_topt_path_order_backward' },
  { value: 'back',     labelKey: 'layer_topt_path_order_back' },
]

/** Six alignments + two distributions, offered inside a single popover. */
export const PATH_ALIGN_ITEMS: ToolOption[] = [
  { kind: 'action', id: 'align-left',     labelKey: 'layer_topt_align_left',     priority: 0, run: 'align-left',     icon: AlignStartVertical },
  { kind: 'action', id: 'align-center-h', labelKey: 'layer_topt_align_center_h', priority: 0, run: 'align-center-h', icon: AlignCenterVertical },
  { kind: 'action', id: 'align-right',    labelKey: 'layer_topt_align_right',    priority: 0, run: 'align-right',    icon: AlignEndVertical },
  { kind: 'action', id: 'align-top',      labelKey: 'layer_topt_align_top',      priority: 0, run: 'align-top',      icon: AlignStartHorizontal },
  { kind: 'action', id: 'align-center-v', labelKey: 'layer_topt_align_center_v', priority: 0, run: 'align-center-v', icon: AlignCenterHorizontal },
  { kind: 'action', id: 'align-bottom',   labelKey: 'layer_topt_align_bottom',   priority: 0, run: 'align-bottom',   icon: AlignEndHorizontal },
  { kind: 'action', id: 'distribute-h',   labelKey: 'layer_topt_distribute_h',   priority: 0, run: 'distribute-h',   icon: AlignHorizontalSpaceBetween },
  { kind: 'action', id: 'distribute-v',   labelKey: 'layer_topt_distribute_v',   priority: 0, run: 'distribute-v',   icon: AlignVerticalSpaceBetween },
]

const SHAPE_STYLE: ToolOption[] = [
  {
    kind: 'segmented', id: 'shape-output', labelKey: 'layer_topt_shape_output', priority: 0,
    choices: SHAPE_OUTPUT_CHOICES, def: 'shape',
  },
  { kind: 'color', id: 'fill',   labelKey: 'layer_topt_fill',   priority: 0, def: 'fg' },
  { kind: 'color', id: 'stroke', labelKey: 'layer_topt_stroke', priority: 1, def: 'none' },
  {
    kind: 'number', id: 'stroke-width', labelKey: 'layer_topt_stroke_width', priority: 1,
    min: 0, max: 1000, step: 1, unit: 'px', def: 1, width: 52,
  },
  {
    kind: 'select', id: 'stroke-style', labelKey: 'layer_topt_stroke_style', priority: 2,
    choices: STROKE_STYLE_CHOICES, def: 'solid', width: 104,
    // A stroke style is meaningless while there is no stroke at all.
    disabledIf: (v: ToolValues) => v['stroke'] === 'none',
  },
  {
    kind: 'select', id: 'path-op', labelKey: 'layer_topt_path_op', priority: 2,
    choices: PATH_OP_CHOICES, def: 'new', width: 116,
  },
  { kind: 'popover', id: 'path-align', labelKey: 'layer_topt_path_align', priority: 2, items: PATH_ALIGN_ITEMS },
  {
    kind: 'select', id: 'path-order', labelKey: 'layer_topt_path_order', priority: 2,
    choices: PATH_ORDER_CHOICES, def: 'front', width: 116,
  },
  { kind: 'toggle', id: 'antialias', labelKey: 'layer_topt_antialias', priority: 2, def: true },
]

// ── BLOC E — geometry shared by crop / artboard / content-aware move ─────────

export const RATIO_CHOICES = [
  { value: 'free',     labelKey: 'layer_topt_ratio_free' },
  { value: 'fixed',    labelKey: 'layer_topt_ratio_fixed' },
  { value: 'size',     labelKey: 'layer_topt_ratio_size' },
  { value: 'original', labelKey: 'layer_topt_ratio_original' },
  { value: '1:1',      labelKey: 'layer_topt_ratio_1_1' },
  { value: '4:3',      labelKey: 'layer_topt_ratio_4_3' },
  { value: '16:9',     labelKey: 'layer_topt_ratio_16_9' },
  { value: 'a4',       labelKey: 'layer_topt_ratio_a4' },
]

export const OVERLAY_CHOICES = [
  { value: 'none',      labelKey: 'layer_topt_overlay_none' },
  { value: 'thirds',    labelKey: 'layer_topt_overlay_thirds' },
  { value: 'grid',      labelKey: 'layer_topt_overlay_grid' },
  { value: 'diagonals', labelKey: 'layer_topt_overlay_diagonals' },
  { value: 'triangle',  labelKey: 'layer_topt_overlay_triangle' },
  { value: 'spiral',    labelKey: 'layer_topt_overlay_spiral' },
]

const TRANSFORM_COMMON: ToolOption[] = [
  {
    kind: 'select', id: 'ratio', labelKey: 'layer_topt_ratio', priority: 0,
    choices: RATIO_CHOICES, def: 'free', width: 132,
  },
  {
    kind: 'number', id: 'width', labelKey: 'layer_topt_width', priority: 1,
    min: 1, max: 30000, step: 1, unit: 'px', def: 1920, width: 60,
    // Free-form crops have no target size to type in.
    disabledIf: (v: ToolValues) => v['ratio'] === 'free' || v['ratio'] === 'original',
  },
  {
    kind: 'number', id: 'height', labelKey: 'layer_topt_height', priority: 1,
    min: 1, max: 30000, step: 1, unit: 'px', def: 1080, width: 60,
    disabledIf: (v: ToolValues) => v['ratio'] === 'free' || v['ratio'] === 'original',
  },
  {
    kind: 'number', id: 'resolution', labelKey: 'layer_topt_resolution', priority: 2,
    min: 1, max: 2400, step: 1, unit: 'ppp', def: 72, width: 56,
  },
  {
    kind: 'select', id: 'overlay', labelKey: 'layer_topt_overlay', priority: 1,
    choices: OVERLAY_CHOICES, def: 'thirds', width: 132,
  },
]

// ── Registry ─────────────────────────────────────────────────────────────────

export const OPTION_BLOCKS: Record<OptionBlockId, ToolOption[]> = {
  selection:       SELECTION,
  brushCore:       BRUSH_CORE,
  sampling:        SAMPLING,
  shapeStyle:      SHAPE_STYLE,
  transformCommon: TRANSFORM_COMMON,
}

/** Circle icon kept for the shape-constraint control declared in `toolDefs`. */
export const CONSTRAINT_ICON = Circle
