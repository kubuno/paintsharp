// The Layer toolbox registry: 20 flyout families, 65 tools, and the responsive
// merge plan the rail applies when it runs out of height.
//
// Every icon below was checked against the `lucide-react` build actually installed
// in this package (1.18.0) — a missing export is a build error, not a runtime one.
import {
  ALargeSmall, Bandage, Baseline, Blend, Brush, Circle, CircleDashed, Contrast,
  CornerUpRight, Crop, Droplet, Droplets, Eraser, Eye, Feather,
  Fingerprint, Frame, Grid2x2, Grid3x3, Hand, Hexagon, History, Lasso, Layers,
  Magnet, Minus, MinusCircle, Moon, MousePointer2, MousePointerClick, Move3d,
  MoveHorizontal, MoveVertical, PaintBucket, PenLine, PenTool, Pencil, Pipette,
  PlusCircle, Replace, RotateCcw, Ruler, Scan, Slash, Spline, Square, SquareDashed,
  SquareDashedMousePointer, SquareDot, Squircle, Stamp, Star, Stethoscope,
  StickyNote, Sun, Target, TextCursor, Triangle, Type, Wand, WandSparkles,
  Waypoints, Zap, ZoomIn, ZoomOut,
  AlignCenter, AlignJustify, AlignLeft, AlignRight,
  Crosshair, Infinity as InfinityIcon, Palette, Shapes, Sparkles,
} from 'lucide-react'
import { PATH_ALIGN_ITEMS, PATH_ORDER_CHOICES, SAMPLE_SOURCE_CHOICES } from './optionBlocks'
import type { FamilyId, RailFamily, ToolDef, ToolFamily, ToolId, ToolOption, ToolValues } from './types'

// ── Shared choice tables ─────────────────────────────────────────────────────

const ALIGN_ITEMS: ToolOption[] = PATH_ALIGN_ITEMS.slice(0, 6)
const DISTRIBUTE_ITEMS: ToolOption[] = PATH_ALIGN_ITEMS.slice(6)

const SAMPLE_SIZE_CHOICES = [
  { value: 'point', labelKey: 'layer_topt_sample_size_point' },
  { value: '3', labelKey: 'layer_topt_sample_size_3' },
  { value: '5', labelKey: 'layer_topt_sample_size_5' },
  { value: '11', labelKey: 'layer_topt_sample_size_11' },
  { value: '31', labelKey: 'layer_topt_sample_size_31' },
  { value: '51', labelKey: 'layer_topt_sample_size_51' },
  { value: '101', labelKey: 'layer_topt_sample_size_101' },
]

const MARQUEE_STYLE_CHOICES = [
  { value: 'normal', labelKey: 'layer_topt_marquee_style_normal' },
  { value: 'ratio', labelKey: 'layer_topt_marquee_style_ratio' },
  { value: 'size', labelKey: 'layer_topt_marquee_style_size' },
]

const LIMITS_CHOICES = [
  { value: 'discontiguous', labelKey: 'layer_topt_limits_discontiguous' },
  { value: 'contiguous', labelKey: 'layer_topt_limits_contiguous' },
  { value: 'find-edges', labelKey: 'layer_topt_limits_find_edges' },
]

const SAMPLING_MODE_CHOICES = [
  { value: 'continuous', labelKey: 'layer_topt_sampling_continuous', icon: InfinityIcon },
  { value: 'once', labelKey: 'layer_topt_sampling_once', icon: Crosshair },
  { value: 'background', labelKey: 'layer_topt_sampling_background', icon: Square },
]

const FOCUS_MODE_CHOICES = [
  { value: 'normal', labelKey: 'layer_blend_normal' },
  { value: 'lighten', labelKey: 'layer_blend_lighten' },
  { value: 'darken', labelKey: 'layer_blend_darken' },
  { value: 'hue', labelKey: 'layer_blend_hue' },
  { value: 'saturation', labelKey: 'layer_blend_saturation' },
  { value: 'color', labelKey: 'layer_blend_color' },
  { value: 'luminosity', labelKey: 'layer_blend_luminosity' },
]

const SHAPE_CONSTRAINT_CHOICES = [
  { value: 'free', labelKey: 'layer_topt_shape_constraint_free' },
  { value: 'equal', labelKey: 'layer_topt_shape_constraint_equal' },
  { value: 'size', labelKey: 'layer_topt_shape_constraint_size' },
  { value: 'ratio', labelKey: 'layer_topt_shape_constraint_ratio' },
  { value: 'center', labelKey: 'layer_topt_shape_constraint_center' },
]

/** Brush / size / hardness only — the trio every "painterly" retouch tool shows. */
const BRUSH_TRIO_OMIT = [
  'blend', 'opacity', 'flow', 'smoothing', 'airbrush',
  'pressure-size', 'pressure-opacity', 'symmetry',
]

/** Shape styling without the fill/stroke half — used by the anchor-point tools. */
const PATH_ONLY_OMIT = ['shape-output', 'fill', 'stroke', 'stroke-width', 'stroke-style', 'antialias']

// Common option fragments reused verbatim by several tools.
const optSampleAll: ToolOption =
  { kind: 'toggle', id: 'sample-all', labelKey: 'layer_topt_sample_all', priority: 1, def: false }
const optShapeConstraint: ToolOption = {
  kind: 'select', id: 'shape-constraint', labelKey: 'layer_topt_shape_constraint', priority: 1,
  choices: SHAPE_CONSTRAINT_CHOICES, def: 'free', width: 132,
}
const optStructure: ToolOption =
  { kind: 'number', id: 'structure', labelKey: 'layer_topt_structure', priority: 1, min: 1, max: 7, def: 4, width: 48 }
const optColorAdapt: ToolOption =
  { kind: 'number', id: 'color-adapt', labelKey: 'layer_topt_color_adapt', priority: 1, min: 0, max: 10, def: 0, width: 48 }

/** The text options bar, shared by the four text tools. */
function textOptions(orientation: 'h' | 'v', withColor: boolean): ToolOption[] {
  const opts: ToolOption[] = [
    {
      kind: 'segmented', id: 'text-orientation', labelKey: 'layer_topt_text_orientation', priority: 1,
      choices: [
        { value: 'h', labelKey: 'layer_topt_text_orientation_h', icon: MoveHorizontal },
        { value: 'v', labelKey: 'layer_topt_text_orientation_v', icon: MoveVertical },
      ],
      def: orientation,
    },
    { kind: 'font', id: 'font', labelKey: 'layer_topt_font', priority: 0, def: 'Arial', width: 132 },
    {
      kind: 'select', id: 'font-style', labelKey: 'layer_topt_font_style', priority: 1, width: 108,
      choices: [
        { value: 'regular', labelKey: 'layer_topt_font_style_regular' },
        { value: 'italic', labelKey: 'layer_topt_font_style_italic' },
        { value: 'bold', labelKey: 'layer_topt_font_style_bold' },
        { value: 'bold-italic', labelKey: 'layer_topt_font_style_bold_italic' },
      ],
      def: 'regular',
    },
    {
      kind: 'number', id: 'font-size', labelKey: 'layer_topt_font_size', priority: 0,
      min: 4, max: 2000, step: 1, unit: 'pt', def: 24, width: 56,
    },
    {
      kind: 'select', id: 'text-aa', labelKey: 'layer_topt_text_aa', priority: 2, width: 108,
      choices: [
        { value: 'none', labelKey: 'layer_topt_text_aa_none' },
        { value: 'sharp', labelKey: 'layer_topt_text_aa_sharp' },
        { value: 'crisp', labelKey: 'layer_topt_text_aa_crisp' },
        { value: 'strong', labelKey: 'layer_topt_text_aa_strong' },
        { value: 'smooth', labelKey: 'layer_topt_text_aa_smooth' },
      ],
      def: 'sharp',
    },
    {
      kind: 'segmented', id: 'text-align', labelKey: 'layer_topt_text_align', priority: 1,
      choices: [
        { value: 'left', labelKey: 'layer_topt_text_align_left', icon: AlignLeft },
        { value: 'center', labelKey: 'layer_topt_text_align_center', icon: AlignCenter },
        { value: 'right', labelKey: 'layer_topt_text_align_right', icon: AlignRight },
        { value: 'justify', labelKey: 'layer_topt_text_align_justify', icon: AlignJustify },
      ],
      def: 'left',
    },
  ]
  if (withColor) {
    opts.push({ kind: 'color', id: 'text-color', labelKey: 'layer_topt_text_color', priority: 0, def: 'fg' })
  }
  opts.push(
    { kind: 'action', id: 'text-warp', labelKey: 'layer_topt_text_warp', priority: 2, run: 'text-warp' },
    { kind: 'action', id: 'text-panels', labelKey: 'layer_topt_text_panels', priority: 2, run: 'text-panels' },
    { kind: 'action', id: 'text-apply', labelKey: 'layer_topt_apply', priority: 1, run: 'text-apply', variant: 'primary' },
    { kind: 'action', id: 'text-cancel', labelKey: 'layer_topt_cancel', priority: 1, run: 'text-cancel', variant: 'ghost' },
  )
  return opts
}

/** Blur / sharpen / smudge share the same skeleton. */
function focusToolOptions(extra: ToolOption[]): ToolOption[] {
  return [
    {
      kind: 'select', id: 'focus-mode', labelKey: 'layer_topt_focus_mode', priority: 1,
      choices: FOCUS_MODE_CHOICES, def: 'normal', width: 116,
    },
    {
      kind: 'number', id: 'strength', labelKey: 'layer_topt_strength', priority: 0,
      min: 0, max: 100, step: 1, unit: '%', def: 50, width: 52,
    },
    optSampleAll,
    ...extra,
  ]
}

/** Dodge / burn share the same skeleton. */
const TONE_OPTIONS: ToolOption[] = [
  {
    kind: 'select', id: 'tone-range', labelKey: 'layer_topt_tone_range', priority: 0, width: 116,
    choices: [
      { value: 'shadows', labelKey: 'layer_topt_tone_range_shadows' },
      { value: 'midtones', labelKey: 'layer_topt_tone_range_midtones' },
      { value: 'highlights', labelKey: 'layer_topt_tone_range_highlights' },
    ],
    def: 'midtones',
  },
  {
    kind: 'number', id: 'exposure', labelKey: 'layer_topt_exposure', priority: 0,
    min: 0, max: 100, step: 1, unit: '%', def: 50, width: 52,
  },
  { kind: 'toggle', id: 'airbrush', labelKey: 'layer_topt_airbrush', priority: 2, def: false },
  { kind: 'toggle', id: 'protect-tones', labelKey: 'layer_topt_protect_tones', priority: 1, def: true },
]

// ── The 20 families ──────────────────────────────────────────────────────────

export const TOOL_FAMILIES: ToolFamily[] = [
  { id: 'move', nameKey: 'layer_fam_move', shortcut: 'V', Icon: MousePointer2,
    tools: ['move', 'artboard'], defaultTool: 'move' },
  { id: 'marquee', nameKey: 'layer_fam_marquee', shortcut: 'M', Icon: SquareDashed,
    tools: ['marquee-rect', 'marquee-ellipse', 'marquee-row', 'marquee-column'], defaultTool: 'marquee-rect' },
  { id: 'lasso', nameKey: 'layer_fam_lasso', shortcut: 'L', Icon: Lasso,
    tools: ['lasso-free', 'lasso-poly', 'lasso-magnetic'], defaultTool: 'lasso-free' },
  { id: 'autoselect', nameKey: 'layer_fam_autoselect', shortcut: 'W', Icon: Wand,
    tools: ['quick-select', 'magic-wand', 'object-select'], defaultTool: 'magic-wand' },
  { id: 'crop', nameKey: 'layer_fam_crop', shortcut: 'C', Icon: Crop,
    tools: ['crop', 'crop-perspective', 'slice', 'slice-select'], defaultTool: 'crop' },
  { id: 'sample', nameKey: 'layer_fam_sample', shortcut: 'I', Icon: Pipette,
    tools: ['eyedropper', 'color-sampler', 'ruler', 'note'], defaultTool: 'eyedropper' },
  { id: 'healing', nameKey: 'layer_fam_healing', shortcut: 'J', Icon: Bandage,
    tools: ['spot-heal', 'heal', 'patch', 'content-move', 'red-eye'], defaultTool: 'spot-heal' },
  { id: 'paint', nameKey: 'layer_fam_paint', shortcut: 'B', Icon: Brush,
    tools: ['brush', 'pencil', 'color-replace', 'mixer-brush'], defaultTool: 'brush' },
  { id: 'stamp', nameKey: 'layer_fam_stamp', shortcut: 'S', Icon: Stamp,
    tools: ['clone-stamp', 'pattern-stamp'], defaultTool: 'clone-stamp' },
  { id: 'history', nameKey: 'layer_fam_history', shortcut: 'Y', Icon: History,
    tools: ['history-brush', 'art-history-brush'], defaultTool: 'history-brush' },
  { id: 'eraser', nameKey: 'layer_fam_eraser', shortcut: 'E', Icon: Eraser,
    tools: ['eraser', 'bg-eraser', 'magic-eraser'], defaultTool: 'eraser' },
  { id: 'fill', nameKey: 'layer_fam_fill', shortcut: 'G', Icon: PaintBucket,
    tools: ['gradient', 'bucket'], defaultTool: 'gradient' },
  // Deliberately shortcut-free: every sensible letter is already taken (spec §1).
  { id: 'focus', nameKey: 'layer_fam_focus', Icon: Droplet,
    tools: ['blur', 'sharpen', 'smudge'], defaultTool: 'blur' },
  { id: 'tone', nameKey: 'layer_fam_tone', shortcut: 'O', Icon: Sun,
    tools: ['dodge', 'burn', 'sponge'], defaultTool: 'dodge' },
  { id: 'pen', nameKey: 'layer_fam_pen', shortcut: 'P', Icon: PenTool,
    tools: ['pen', 'pen-free', 'pen-curvature', 'anchor-add', 'anchor-remove', 'anchor-convert'],
    defaultTool: 'pen' },
  { id: 'text', nameKey: 'layer_fam_text', shortcut: 'T', Icon: Type,
    tools: ['text-h', 'text-v', 'text-mask-h', 'text-mask-v'], defaultTool: 'text-h' },
  { id: 'pathsel', nameKey: 'layer_fam_pathsel', shortcut: 'A', Icon: Waypoints,
    tools: ['path-select', 'direct-select'], defaultTool: 'path-select' },
  { id: 'shape', nameKey: 'layer_fam_shape', shortcut: 'U', Icon: Shapes,
    tools: ['shape-rect', 'shape-rrect', 'shape-ellipse', 'shape-polygon', 'shape-line', 'shape-custom'],
    defaultTool: 'shape-rect' },
  { id: 'navigate', nameKey: 'layer_fam_navigate', shortcut: 'H', Icon: Hand,
    tools: ['hand', 'rotate-view'], defaultTool: 'hand' },
  { id: 'zoom', nameKey: 'layer_fam_zoom', shortcut: 'Z', Icon: ZoomIn,
    tools: ['zoom'], defaultTool: 'zoom' },
]

// ── The 65 tools ─────────────────────────────────────────────────────────────

export const TOOLS: Record<ToolId, ToolDef> = {
  // ── F01 Move ───────────────────────────────────────────────────────────────
  move: {
    id: 'move', family: 'move', nameKey: 'layer_tool_move', Icon: MousePointer2,
    priority: 'P0', shortcut: 'V', cursor: 'move', claims: ['alt', 'shift'],
    options: [
      { kind: 'toggle', id: 'autoselect', labelKey: 'layer_topt_autoselect', priority: 0, def: true },
      {
        kind: 'select', id: 'autoselect-target', labelKey: 'layer_topt_autoselect_target', priority: 1, width: 104,
        choices: [
          { value: 'layer', labelKey: 'layer_topt_autoselect_target_layer' },
          { value: 'group', labelKey: 'layer_topt_autoselect_target_group' },
        ],
        def: 'layer',
        disabledIf: (v: ToolValues) => v['autoselect'] === false,
      },
      { kind: 'toggle', id: 'show-transform', labelKey: 'layer_topt_show_transform', priority: 1, def: false },
      { kind: 'popover', id: 'align', labelKey: 'layer_topt_align', priority: 2, items: ALIGN_ITEMS },
      { kind: 'popover', id: 'distribute', labelKey: 'layer_topt_distribute', priority: 2, items: DISTRIBUTE_ITEMS },
      { kind: 'toggle', id: 'snap', labelKey: 'layer_topt_snap', priority: 1, def: true },
    ],
  },
  artboard: {
    id: 'artboard', family: 'move', nameKey: 'layer_tool_artboard', Icon: Frame,
    priority: 'P2', shortcut: 'shift+V', blocks: ['transformCommon'],
    options: [
      {
        kind: 'select', id: 'artboard-preset', labelKey: 'layer_topt_artboard_preset', priority: 0, width: 132,
        choices: [
          { value: 'screen', labelKey: 'layer_topt_artboard_preset_screen' },
          { value: 'mobile', labelKey: 'layer_topt_artboard_preset_mobile' },
          { value: 'tablet', labelKey: 'layer_topt_artboard_preset_tablet' },
          { value: 'a4', labelKey: 'layer_topt_artboard_preset_a4' },
          { value: 'print', labelKey: 'layer_topt_artboard_preset_print' },
        ],
        def: 'screen',
      },
      { kind: 'color', id: 'artboard-bg', labelKey: 'layer_topt_artboard_bg', priority: 1, def: '#ffffff' },
    ],
  },

  // ── F02 Marquee ────────────────────────────────────────────────────────────
  'marquee-rect': {
    id: 'marquee-rect', family: 'marquee', nameKey: 'layer_tool_marquee_rect', Icon: SquareDashed,
    priority: 'P0', shortcut: 'M', cursor: 'crosshair', blocks: ['selection'], claims: ['alt', 'shift'],
    options: [
      {
        kind: 'select', id: 'marquee-style', labelKey: 'layer_topt_marquee_style', priority: 1,
        choices: MARQUEE_STYLE_CHOICES, def: 'normal', width: 132,
      },
      {
        kind: 'number', id: 'width', labelKey: 'layer_topt_width', priority: 1,
        min: 1, max: 30000, step: 1, def: 1, width: 56,
        disabledIf: (v: ToolValues) => v['marquee-style'] === 'normal',
      },
      {
        kind: 'number', id: 'height', labelKey: 'layer_topt_height', priority: 1,
        min: 1, max: 30000, step: 1, def: 1, width: 56,
        disabledIf: (v: ToolValues) => v['marquee-style'] === 'normal',
      },
      { kind: 'toggle', id: 'from-center', labelKey: 'layer_topt_from_center', priority: 2, def: false },
      { kind: 'action', id: 'select-mask', labelKey: 'layer_topt_select_mask', priority: 2, run: 'select-mask' },
    ],
  },
  'marquee-ellipse': {
    id: 'marquee-ellipse', family: 'marquee', nameKey: 'layer_tool_marquee_ellipse', Icon: CircleDashed,
    priority: 'P0', shortcut: 'shift+M', cursor: 'crosshair', blocks: ['selection'], claims: ['alt', 'shift'],
    options: [
      {
        kind: 'select', id: 'marquee-style', labelKey: 'layer_topt_marquee_style', priority: 1,
        choices: MARQUEE_STYLE_CHOICES, def: 'normal', width: 132,
      },
      {
        kind: 'number', id: 'width', labelKey: 'layer_topt_width', priority: 1,
        min: 1, max: 30000, step: 1, def: 1, width: 56,
        disabledIf: (v: ToolValues) => v['marquee-style'] === 'normal',
      },
      {
        kind: 'number', id: 'height', labelKey: 'layer_topt_height', priority: 1,
        min: 1, max: 30000, step: 1, def: 1, width: 56,
        disabledIf: (v: ToolValues) => v['marquee-style'] === 'normal',
      },
      { kind: 'toggle', id: 'from-center', labelKey: 'layer_topt_from_center', priority: 2, def: false },
      { kind: 'action', id: 'select-mask', labelKey: 'layer_topt_select_mask', priority: 2, run: 'select-mask' },
    ],
  },
  // Single row/column: no geometry, no feathering — a 1px band cannot be feathered.
  'marquee-row': {
    id: 'marquee-row', family: 'marquee', nameKey: 'layer_tool_marquee_row', Icon: Minus,
    priority: 'P2', shortcut: 'shift+M', cursor: 'crosshair', blocks: ['selection'], omit: ['feather'],
    options: [{ kind: 'action', id: 'select-mask', labelKey: 'layer_topt_select_mask', priority: 2, run: 'select-mask' }],
  },
  'marquee-column': {
    id: 'marquee-column', family: 'marquee', nameKey: 'layer_tool_marquee_column', Icon: Slash,
    priority: 'P2', shortcut: 'shift+M', cursor: 'crosshair', blocks: ['selection'], omit: ['feather'],
    options: [{ kind: 'action', id: 'select-mask', labelKey: 'layer_topt_select_mask', priority: 2, run: 'select-mask' }],
  },

  // ── F03 Lasso ──────────────────────────────────────────────────────────────
  'lasso-free': {
    id: 'lasso-free', family: 'lasso', nameKey: 'layer_tool_lasso_free', Icon: Lasso,
    priority: 'P0', shortcut: 'L', cursor: 'crosshair', blocks: ['selection'], claims: ['alt', 'shift'],
  },
  'lasso-poly': {
    id: 'lasso-poly', family: 'lasso', nameKey: 'layer_tool_lasso_poly', Icon: Spline,
    priority: 'P0', shortcut: 'shift+L', cursor: 'crosshair', blocks: ['selection'], claims: ['alt', 'shift'],
    options: [{ kind: 'toggle', id: 'auto-close', labelKey: 'layer_topt_auto_close', priority: 1, def: true }],
  },
  'lasso-magnetic': {
    id: 'lasso-magnetic', family: 'lasso', nameKey: 'layer_tool_lasso_magnetic', Icon: Magnet,
    priority: 'P1', shortcut: 'shift+L', cursor: 'crosshair', blocks: ['selection'], claims: ['alt', 'shift'],
    options: [
      {
        kind: 'number', id: 'magnetic-width', labelKey: 'layer_topt_magnetic_width', priority: 1,
        min: 1, max: 256, step: 1, unit: 'px', def: 10, width: 52,
      },
      {
        kind: 'number', id: 'magnetic-contrast', labelKey: 'layer_topt_magnetic_contrast', priority: 1,
        min: 1, max: 100, step: 1, unit: '%', def: 10, width: 52,
      },
      {
        kind: 'number', id: 'magnetic-frequency', labelKey: 'layer_topt_magnetic_frequency', priority: 2,
        min: 0, max: 100, step: 1, def: 57, width: 52,
      },
      { kind: 'toggle', id: 'pressure-width', labelKey: 'layer_topt_pressure_width', priority: 2, def: false },
    ],
  },

  // ── F04 Automatic selection ────────────────────────────────────────────────
  'quick-select': {
    id: 'quick-select', family: 'autoselect', nameKey: 'layer_tool_quick_select', Icon: WandSparkles,
    priority: 'P1', shortcut: 'W', cursor: 'brush-outline', claims: ['alt', 'shift'],
    options: [
      {
        kind: 'segmented', id: 'sel-mode', labelKey: 'layer_topt_sel_mode', priority: 0,
        choices: [
          { value: 'new', labelKey: 'layer_topt_sel_mode_new', icon: Square },
          { value: 'add', labelKey: 'layer_topt_sel_mode_add', icon: PlusCircle },
          { value: 'subtract', labelKey: 'layer_topt_sel_mode_subtract', icon: MinusCircle },
        ],
        def: 'new',
      },
      {
        kind: 'number', id: 'size', labelKey: 'layer_topt_size', priority: 0,
        min: 1, max: 1000, step: 1, unit: 'px', def: 30, width: 56,
      },
      optSampleAll,
      { kind: 'toggle', id: 'auto-enhance', labelKey: 'layer_topt_auto_enhance', priority: 2, def: false },
      { kind: 'action', id: 'select-subject', labelKey: 'layer_topt_select_subject', priority: 1, run: 'select-subject' },
    ],
  },
  'magic-wand': {
    id: 'magic-wand', family: 'autoselect', nameKey: 'layer_tool_magic_wand', Icon: Wand,
    priority: 'P0', shortcut: 'shift+W', cursor: 'crosshair',
    blocks: ['selection', 'sampling'], omit: ['sample-source'], claims: ['alt', 'shift'],
    options: [
      { kind: 'action', id: 'select-similar', labelKey: 'layer_topt_select_similar', priority: 2, run: 'select-similar' },
      { kind: 'action', id: 'select-grow', labelKey: 'layer_topt_select_grow', priority: 2, run: 'select-grow' },
    ],
  },
  'object-select': {
    id: 'object-select', family: 'autoselect', nameKey: 'layer_tool_object_select', Icon: SquareDashedMousePointer,
    priority: 'P2', shortcut: 'shift+W', cursor: 'crosshair', blocks: ['selection'], omit: ['feather', 'refine-edge'],
    options: [
      {
        kind: 'select', id: 'object-mode', labelKey: 'layer_topt_object_mode', priority: 1, width: 116,
        choices: [
          { value: 'rect', labelKey: 'layer_topt_object_mode_rect' },
          { value: 'lasso', labelKey: 'layer_topt_object_mode_lasso' },
        ],
        def: 'rect',
      },
      optSampleAll,
      { kind: 'action', id: 'select-subject', labelKey: 'layer_topt_select_subject', priority: 1, run: 'select-subject' },
    ],
  },

  // ── F05 Crop & slices ──────────────────────────────────────────────────────
  crop: {
    id: 'crop', family: 'crop', nameKey: 'layer_tool_crop', Icon: Crop,
    priority: 'P0', shortcut: 'C', cursor: 'crosshair', blocks: ['transformCommon'], claims: ['alt', 'shift'],
    options: [
      { kind: 'action', id: 'crop-straighten', labelKey: 'layer_topt_straighten', priority: 2, run: 'crop-straighten' },
      { kind: 'toggle', id: 'delete-cropped', labelKey: 'layer_topt_delete_cropped', priority: 2, def: true },
      { kind: 'toggle', id: 'content-aware-fill', labelKey: 'layer_topt_content_aware_fill', priority: 2, def: false },
      { kind: 'readout', id: 'crop-dims', labelKey: 'layer_topt_crop_dims', priority: 1, read: 'crop-size' },
      { kind: 'action', id: 'crop-apply', labelKey: 'layer_topt_apply', priority: 0, run: 'crop-apply', variant: 'primary' },
      { kind: 'action', id: 'crop-cancel', labelKey: 'layer_topt_cancel', priority: 0, run: 'crop-cancel', variant: 'ghost' },
    ],
  },
  'crop-perspective': {
    id: 'crop-perspective', family: 'crop', nameKey: 'layer_tool_crop_perspective', Icon: Scan,
    priority: 'P1', shortcut: 'shift+C', cursor: 'crosshair',
    options: [
      { kind: 'number', id: 'width', labelKey: 'layer_topt_width', priority: 0, min: 1, max: 30000, unit: 'px', def: 1920, width: 60 },
      { kind: 'number', id: 'height', labelKey: 'layer_topt_height', priority: 0, min: 1, max: 30000, unit: 'px', def: 1080, width: 60 },
      { kind: 'number', id: 'resolution', labelKey: 'layer_topt_resolution', priority: 2, min: 1, max: 2400, unit: 'ppp', def: 72, width: 56 },
      { kind: 'toggle', id: 'show-grid', labelKey: 'layer_topt_show_grid', priority: 1, def: true },
      { kind: 'action', id: 'crop-apply', labelKey: 'layer_topt_apply', priority: 0, run: 'crop-apply', variant: 'primary' },
      { kind: 'action', id: 'crop-cancel', labelKey: 'layer_topt_cancel', priority: 0, run: 'crop-cancel', variant: 'ghost' },
    ],
  },
  slice: {
    id: 'slice', family: 'crop', nameKey: 'layer_tool_slice', Icon: Grid2x2,
    priority: 'P2', shortcut: 'shift+C', cursor: 'crosshair',
    options: [
      {
        kind: 'select', id: 'marquee-style', labelKey: 'layer_topt_marquee_style', priority: 1,
        choices: MARQUEE_STYLE_CHOICES, def: 'normal', width: 132,
      },
      { kind: 'number', id: 'width', labelKey: 'layer_topt_width', priority: 1, min: 1, max: 30000, unit: 'px', def: 100, width: 56 },
      { kind: 'number', id: 'height', labelKey: 'layer_topt_height', priority: 1, min: 1, max: 30000, unit: 'px', def: 100, width: 56 },
      { kind: 'action', id: 'slices-from-guides', labelKey: 'layer_topt_slices_from_guides', priority: 1, run: 'slices-from-guides' },
    ],
  },
  'slice-select': {
    id: 'slice-select', family: 'crop', nameKey: 'layer_tool_slice_select', Icon: MousePointerClick,
    priority: 'P2', shortcut: 'shift+C',
    options: [
      {
        kind: 'select', id: 'path-order', labelKey: 'layer_topt_path_order', priority: 0,
        choices: PATH_ORDER_CHOICES, def: 'front', width: 116,
      },
      { kind: 'action', id: 'slice-promote', labelKey: 'layer_topt_slice_promote', priority: 1, run: 'slice-promote' },
      { kind: 'action', id: 'slice-divide', labelKey: 'layer_topt_slice_divide', priority: 1, run: 'slice-divide' },
      { kind: 'toggle', id: 'hide-auto-slices', labelKey: 'layer_topt_hide_auto_slices', priority: 2, def: false },
    ],
  },

  // ── F06 Measure & sampling ─────────────────────────────────────────────────
  eyedropper: {
    id: 'eyedropper', family: 'sample', nameKey: 'layer_tool_eyedropper', Icon: Pipette,
    priority: 'P0', shortcut: 'I', cursor: 'crosshair', claims: ['alt'],
    options: [
      {
        kind: 'select', id: 'sample-size', labelKey: 'layer_topt_sample_size', priority: 0,
        choices: SAMPLE_SIZE_CHOICES, def: '3', width: 116,
      },
      {
        kind: 'select', id: 'sample-source', labelKey: 'layer_topt_sample_source', priority: 1, width: 148,
        choices: [
          { value: 'all', labelKey: 'layer_topt_sample_source_all' },
          { value: 'active', labelKey: 'layer_topt_sample_source_active' },
          { value: 'active-no-adj', labelKey: 'layer_topt_sample_source_no_adj' },
        ],
        def: 'all',
      },
      { kind: 'toggle', id: 'sampling-ring', labelKey: 'layer_topt_sampling_ring', priority: 2, def: true },
      {
        kind: 'segmented', id: 'sample-target', labelKey: 'layer_topt_sample_target', priority: 1,
        choices: [
          { value: 'fg', labelKey: 'layer_topt_sample_target_fg', icon: Palette },
          { value: 'bg', labelKey: 'layer_topt_sample_target_bg', icon: Square },
        ],
        def: 'fg',
      },
    ],
  },
  'color-sampler': {
    id: 'color-sampler', family: 'sample', nameKey: 'layer_tool_color_sampler', Icon: Target,
    priority: 'P1', shortcut: 'shift+I', cursor: 'crosshair',
    options: [
      {
        kind: 'select', id: 'sample-size', labelKey: 'layer_topt_sample_size', priority: 0,
        choices: SAMPLE_SIZE_CHOICES, def: '3', width: 116,
      },
      { kind: 'action', id: 'sampler-clear', labelKey: 'layer_topt_sampler_clear', priority: 1, run: 'sampler-clear' },
      { kind: 'readout', id: 'sampler-count', labelKey: 'layer_topt_sampler_count', priority: 1, read: 'sampler-count' },
    ],
  },
  ruler: {
    id: 'ruler', family: 'sample', nameKey: 'layer_tool_ruler', Icon: Ruler,
    priority: 'P1', shortcut: 'shift+I', cursor: 'crosshair',
    options: [
      {
        kind: 'select', id: 'units', labelKey: 'layer_topt_units', priority: 1, width: 108,
        choices: [
          { value: 'px', labelKey: 'layer_topt_units_px' },
          { value: 'cm', labelKey: 'layer_topt_units_cm' },
          { value: 'mm', labelKey: 'layer_topt_units_mm' },
          { value: 'in', labelKey: 'layer_topt_units_in' },
          { value: 'pt', labelKey: 'layer_topt_units_pt' },
          { value: 'pct', labelKey: 'layer_topt_units_pct' },
        ],
        def: 'px',
      },
      { kind: 'readout', id: 'ruler-measure', labelKey: 'layer_topt_ruler_measure', priority: 0, read: 'ruler-measure' },
      { kind: 'action', id: 'ruler-straighten', labelKey: 'layer_topt_ruler_straighten', priority: 1, run: 'ruler-straighten' },
      { kind: 'action', id: 'ruler-clear', labelKey: 'layer_topt_ruler_clear', priority: 2, run: 'ruler-clear' },
    ],
  },
  note: {
    id: 'note', family: 'sample', nameKey: 'layer_tool_note', Icon: StickyNote,
    priority: 'P2', shortcut: 'shift+I', cursor: 'crosshair',
    options: [
      // The data model has no free-text control; the author is edited through the
      // module's PromptDialog (never a browser prompt), hence an action.
      { kind: 'action', id: 'note-author', labelKey: 'layer_topt_note_author', priority: 1, run: 'note-author' },
      { kind: 'color', id: 'note-color', labelKey: 'layer_topt_note_color', priority: 1, def: '#f5c542' },
      { kind: 'action', id: 'notes-clear', labelKey: 'layer_topt_notes_clear', priority: 2, run: 'notes-clear' },
    ],
  },

  // ── F07 Healing ────────────────────────────────────────────────────────────
  'spot-heal': {
    id: 'spot-heal', family: 'healing', nameKey: 'layer_tool_spot_heal', Icon: Bandage,
    priority: 'P0', shortcut: 'J', cursor: 'brush-outline', claims: ['alt'],
    blocks: ['brushCore'],
    omit: ['flow', 'smoothing', 'airbrush', 'pressure-opacity', 'symmetry', 'opacity'],
    overrides: { size: { def: 19 } },
    options: [
      { kind: 'number', id: 'spacing', labelKey: 'layer_topt_spacing', priority: 2, min: 1, max: 1000, unit: '%', def: 25, width: 52 },
      { kind: 'number', id: 'angle', labelKey: 'layer_topt_angle', priority: 2, min: -180, max: 180, unit: '°', def: 0, width: 52 },
      { kind: 'number', id: 'roundness', labelKey: 'layer_topt_roundness', priority: 2, min: 1, max: 100, unit: '%', def: 100, width: 52 },
      {
        kind: 'segmented', id: 'heal-type', labelKey: 'layer_topt_heal_type', priority: 0,
        choices: [
          { value: 'proximity', labelKey: 'layer_topt_heal_type_proximity', icon: Palette },
          { value: 'texture', labelKey: 'layer_topt_heal_type_texture', icon: Grid3x3 },
          { value: 'content-aware', labelKey: 'layer_topt_heal_type_content', icon: Sparkles },
        ],
        def: 'content-aware',
      },
      optSampleAll,
      { kind: 'number', id: 'diffusion', labelKey: 'layer_topt_diffusion', priority: 1, min: 1, max: 7, def: 5, width: 48 },
    ],
  },
  heal: {
    id: 'heal', family: 'healing', nameKey: 'layer_tool_heal', Icon: Stethoscope,
    priority: 'P1', shortcut: 'shift+J', cursor: 'brush-outline', claims: ['alt'],
    blocks: ['brushCore'], omit: ['smoothing', 'symmetry'],
    options: [
      {
        kind: 'segmented', id: 'heal-source', labelKey: 'layer_topt_heal_source', priority: 0,
        choices: [
          { value: 'sample', labelKey: 'layer_topt_heal_source_sample', icon: Crosshair },
          { value: 'pattern', labelKey: 'layer_topt_heal_source_pattern', icon: Grid3x3 },
        ],
        def: 'sample',
      },
      {
        kind: 'pattern', id: 'pattern', labelKey: 'layer_topt_pattern', priority: 1, def: 'checker',
        visibleIf: (v: ToolValues) => v['heal-source'] === 'pattern',
      },
      { kind: 'toggle', id: 'aligned', labelKey: 'layer_topt_aligned', priority: 1, def: false },
      {
        kind: 'select', id: 'sample-source', labelKey: 'layer_topt_sample_source', priority: 2, width: 132,
        choices: SAMPLE_SOURCE_CHOICES, def: 'active',
      },
      { kind: 'number', id: 'diffusion', labelKey: 'layer_topt_diffusion', priority: 1, min: 1, max: 7, def: 5, width: 48 },
    ],
  },
  patch: {
    id: 'patch', family: 'healing', nameKey: 'layer_tool_patch', Icon: Blend,
    priority: 'P1', shortcut: 'shift+J', cursor: 'crosshair', claims: ['alt', 'shift'],
    blocks: ['selection'], omit: ['feather', 'antialias', 'refine-edge'],
    options: [
      {
        kind: 'segmented', id: 'patch-mode', labelKey: 'layer_topt_patch_mode', priority: 0,
        choices: [
          { value: 'normal', labelKey: 'layer_topt_patch_mode_normal', icon: Square },
          { value: 'content-aware', labelKey: 'layer_topt_patch_mode_content', icon: Sparkles },
        ],
        def: 'normal',
      },
      {
        kind: 'segmented', id: 'patch-direction', labelKey: 'layer_topt_patch_direction', priority: 0,
        choices: [
          { value: 'source', labelKey: 'layer_topt_patch_direction_source', icon: MoveHorizontal },
          { value: 'destination', labelKey: 'layer_topt_patch_direction_dest', icon: MoveVertical },
        ],
        def: 'source',
        visibleIf: (v: ToolValues) => v['patch-mode'] === 'normal',
      },
      { kind: 'toggle', id: 'transparent', labelKey: 'layer_topt_transparent', priority: 2, def: false },
      { kind: 'pattern', id: 'pattern', labelKey: 'layer_topt_pattern', priority: 2, def: 'checker' },
      { kind: 'action', id: 'patch-apply-pattern', labelKey: 'layer_topt_patch_apply', priority: 2, run: 'patch-apply-pattern' },
      { ...optStructure, visibleIf: (v: ToolValues) => v['patch-mode'] === 'content-aware' },
      { ...optColorAdapt, visibleIf: (v: ToolValues) => v['patch-mode'] === 'content-aware' },
    ],
  },
  'content-move': {
    id: 'content-move', family: 'healing', nameKey: 'layer_tool_content_move', Icon: Move3d,
    priority: 'P2', shortcut: 'shift+J', cursor: 'move', claims: ['alt', 'shift'],
    blocks: ['selection'], omit: ['antialias', 'refine-edge'],
    options: [
      {
        kind: 'segmented', id: 'move-mode', labelKey: 'layer_topt_move_mode', priority: 0,
        choices: [
          { value: 'move', labelKey: 'layer_topt_move_mode_move', icon: MoveHorizontal },
          { value: 'extend', labelKey: 'layer_topt_move_mode_extend', icon: MoveVertical },
        ],
        def: 'move',
      },
      optStructure,
      optColorAdapt,
      { kind: 'toggle', id: 'transform-on-drop', labelKey: 'layer_topt_transform_on_drop', priority: 1, def: true },
    ],
  },
  'red-eye': {
    id: 'red-eye', family: 'healing', nameKey: 'layer_tool_red_eye', Icon: Eye,
    priority: 'P1', shortcut: 'shift+J', cursor: 'crosshair',
    options: [
      { kind: 'number', id: 'pupil-size', labelKey: 'layer_topt_pupil_size', priority: 0, min: 0, max: 100, unit: '%', def: 50, width: 52 },
      { kind: 'number', id: 'darken-amount', labelKey: 'layer_topt_darken_amount', priority: 0, min: 0, max: 100, unit: '%', def: 50, width: 52 },
    ],
  },

  // ── F08 Paint ──────────────────────────────────────────────────────────────
  brush: {
    id: 'brush', family: 'paint', nameKey: 'layer_tool_brush', Icon: Brush,
    priority: 'P0', shortcut: 'B', cursor: 'brush-outline', claims: ['alt'], requires: ['raster'],
    blocks: ['brushCore'],
    options: [
      { kind: 'action', id: 'brush-studio', labelKey: 'layer_topt_brush_studio', priority: 1, run: 'brush-studio' },
      {
        kind: 'popover', id: 'smoothing-options', labelKey: 'layer_topt_smoothing_options', priority: 2,
        items: [
          { kind: 'toggle', id: 'smoothing-pulled', labelKey: 'layer_topt_smoothing_pulled', priority: 0, def: true },
          { kind: 'toggle', id: 'smoothing-catchup', labelKey: 'layer_topt_smoothing_catchup', priority: 0, def: true },
          { kind: 'toggle', id: 'smoothing-catchup-end', labelKey: 'layer_topt_smoothing_catchup_end', priority: 0, def: false },
          { kind: 'toggle', id: 'smoothing-zoom', labelKey: 'layer_topt_smoothing_zoom', priority: 0, def: true },
        ],
      },
    ],
  },
  pencil: {
    id: 'pencil', family: 'paint', nameKey: 'layer_tool_pencil', Icon: Pencil,
    priority: 'P0', shortcut: 'shift+B', cursor: 'brush-outline', claims: ['alt'], requires: ['raster'],
    // A pencil is aliasing-free by definition: hardness is pinned at 100 %.
    blocks: ['brushCore'], omit: ['hardness', 'airbrush'],
    options: [{ kind: 'toggle', id: 'auto-erase', labelKey: 'layer_topt_auto_erase', priority: 1, def: false }],
  },
  'color-replace': {
    id: 'color-replace', family: 'paint', nameKey: 'layer_tool_color_replace', Icon: Replace,
    priority: 'P1', shortcut: 'shift+B', cursor: 'brush-outline', claims: ['alt'], requires: ['raster'],
    blocks: ['brushCore'], omit: BRUSH_TRIO_OMIT, overrides: { size: { def: 30 } },
    options: [
      {
        kind: 'select', id: 'replace-mode', labelKey: 'layer_topt_replace_mode', priority: 0, width: 116,
        choices: [
          { value: 'hue', labelKey: 'layer_blend_hue' },
          { value: 'saturation', labelKey: 'layer_blend_saturation' },
          { value: 'color', labelKey: 'layer_blend_color' },
          { value: 'luminosity', labelKey: 'layer_blend_luminosity' },
        ],
        def: 'color',
      },
      {
        kind: 'segmented', id: 'sampling', labelKey: 'layer_topt_sampling', priority: 1,
        choices: SAMPLING_MODE_CHOICES, def: 'continuous',
      },
      {
        kind: 'select', id: 'limits', labelKey: 'layer_topt_limits', priority: 1,
        choices: LIMITS_CHOICES, def: 'contiguous', width: 148,
      },
      { kind: 'number', id: 'tolerance', labelKey: 'layer_topt_tolerance', priority: 0, min: 0, max: 100, unit: '%', def: 30, width: 52 },
      { kind: 'toggle', id: 'antialias', labelKey: 'layer_topt_antialias', priority: 2, def: true },
    ],
  },
  'mixer-brush': {
    id: 'mixer-brush', family: 'paint', nameKey: 'layer_tool_mixer_brush', Icon: Droplets,
    priority: 'P2', shortcut: 'shift+B', cursor: 'brush-outline', claims: ['alt'], requires: ['raster'],
    blocks: ['brushCore'],
    omit: ['hardness', 'blend', 'opacity', 'smoothing', 'airbrush', 'pressure-size', 'pressure-opacity', 'symmetry'],
    options: [
      { kind: 'color', id: 'reservoir', labelKey: 'layer_topt_reservoir', priority: 0, def: 'fg' },
      { kind: 'action', id: 'mixer-load', labelKey: 'layer_topt_mixer_load', priority: 1, run: 'mixer-load' },
      { kind: 'action', id: 'mixer-clean', labelKey: 'layer_topt_mixer_clean', priority: 1, run: 'mixer-clean' },
      {
        kind: 'select', id: 'mixer-preset', labelKey: 'layer_topt_mixer_preset', priority: 0, width: 148,
        choices: [
          { value: 'dry', labelKey: 'layer_topt_mixer_preset_dry' },
          { value: 'moist', labelKey: 'layer_topt_mixer_preset_moist' },
          { value: 'wet', labelKey: 'layer_topt_mixer_preset_wet' },
          { value: 'very-wet', labelKey: 'layer_topt_mixer_preset_very_wet' },
        ],
        def: 'moist',
      },
      { kind: 'number', id: 'wet', labelKey: 'layer_topt_wet', priority: 1, min: 0, max: 100, unit: '%', def: 50, width: 52 },
      { kind: 'number', id: 'load', labelKey: 'layer_topt_load', priority: 1, min: 0, max: 100, unit: '%', def: 50, width: 52 },
      { kind: 'number', id: 'mix', labelKey: 'layer_topt_mix', priority: 1, min: 0, max: 100, unit: '%', def: 50, width: 52 },
      optSampleAll,
    ],
  },

  // ── F09 Stamp ──────────────────────────────────────────────────────────────
  'clone-stamp': {
    id: 'clone-stamp', family: 'stamp', nameKey: 'layer_tool_clone_stamp', Icon: Stamp,
    priority: 'P0', shortcut: 'S', cursor: 'brush-outline', claims: ['alt'], requires: ['raster'],
    blocks: ['brushCore'],
    options: [
      { kind: 'toggle', id: 'aligned', labelKey: 'layer_topt_aligned', priority: 1, def: true },
      {
        kind: 'select', id: 'sample-source', labelKey: 'layer_topt_sample_source', priority: 2, width: 132,
        choices: [
          { value: 'active', labelKey: 'layer_topt_sample_source_active' },
          { value: 'active-below', labelKey: 'layer_topt_sample_source_below' },
          { value: 'all', labelKey: 'layer_topt_sample_source_all' },
        ],
        def: 'active',
      },
      {
        kind: 'popover', id: 'clone-source', labelKey: 'layer_topt_clone_source', priority: 2,
        items: [
          { kind: 'number', id: 'clone-slot', labelKey: 'layer_topt_clone_slot', priority: 0, min: 1, max: 5, def: 1, width: 48 },
          { kind: 'number', id: 'clone-offset-x', labelKey: 'layer_topt_clone_offset_x', priority: 0, min: -30000, max: 30000, unit: 'px', def: 0, width: 60 },
          { kind: 'number', id: 'clone-offset-y', labelKey: 'layer_topt_clone_offset_y', priority: 0, min: -30000, max: 30000, unit: 'px', def: 0, width: 60 },
          { kind: 'number', id: 'clone-scale', labelKey: 'layer_topt_clone_scale', priority: 0, min: 1, max: 1000, unit: '%', def: 100, width: 56 },
          { kind: 'number', id: 'clone-rotation', labelKey: 'layer_topt_clone_rotation', priority: 0, min: -180, max: 180, unit: '°', def: 0, width: 56 },
          { kind: 'toggle', id: 'clone-mirror', labelKey: 'layer_topt_clone_mirror', priority: 0, def: false },
          { kind: 'toggle', id: 'clone-overlay', labelKey: 'layer_topt_clone_overlay', priority: 0, def: true },
        ],
      },
      { kind: 'readout', id: 'clone-hint', labelKey: 'layer_topt_clone_hint', priority: 2, read: 'clone-source-hint' },
    ],
  },
  'pattern-stamp': {
    id: 'pattern-stamp', family: 'stamp', nameKey: 'layer_tool_pattern_stamp', Icon: Grid3x3,
    priority: 'P2', shortcut: 'shift+S', cursor: 'brush-outline', requires: ['raster'],
    blocks: ['brushCore'],
    options: [
      { kind: 'pattern', id: 'pattern', labelKey: 'layer_topt_pattern', priority: 0, def: 'checker' },
      { kind: 'toggle', id: 'aligned', labelKey: 'layer_topt_aligned', priority: 1, def: true },
      { kind: 'toggle', id: 'impressionist', labelKey: 'layer_topt_impressionist', priority: 2, def: false },
    ],
  },

  // ── F10 History ────────────────────────────────────────────────────────────
  'history-brush': {
    id: 'history-brush', family: 'history', nameKey: 'layer_tool_history_brush', Icon: History,
    priority: 'P1', shortcut: 'Y', cursor: 'brush-outline', requires: ['raster'],
    blocks: ['brushCore'],
    options: [
      {
        kind: 'select', id: 'history-source', labelKey: 'layer_topt_history_source', priority: 0, width: 148,
        choices: [{ value: 'snapshot', labelKey: 'layer_topt_history_source_snapshot' }], def: 'snapshot',
      },
    ],
  },
  'art-history-brush': {
    id: 'art-history-brush', family: 'history', nameKey: 'layer_tool_art_history_brush', Icon: Feather,
    priority: 'P2', shortcut: 'shift+Y', cursor: 'brush-outline', requires: ['raster'],
    blocks: ['brushCore'],
    options: [
      {
        kind: 'select', id: 'art-style', labelKey: 'layer_topt_art_style', priority: 0, width: 148,
        choices: [
          { value: 'tight-short', labelKey: 'layer_topt_art_style_tight_short' },
          { value: 'tight-medium', labelKey: 'layer_topt_art_style_tight_medium' },
          { value: 'tight-long', labelKey: 'layer_topt_art_style_tight_long' },
          { value: 'loose-medium', labelKey: 'layer_topt_art_style_loose_medium' },
          { value: 'loose-long', labelKey: 'layer_topt_art_style_loose_long' },
          { value: 'dab', labelKey: 'layer_topt_art_style_dab' },
          { value: 'tight-curl', labelKey: 'layer_topt_art_style_tight_curl' },
          { value: 'loose-curl', labelKey: 'layer_topt_art_style_loose_curl' },
        ],
        def: 'tight-short',
      },
      { kind: 'number', id: 'art-area', labelKey: 'layer_topt_art_area', priority: 1, min: 0, max: 500, unit: 'px', def: 50, width: 56 },
      { kind: 'number', id: 'tolerance', labelKey: 'layer_topt_tolerance', priority: 1, min: 0, max: 100, unit: '%', def: 0, width: 52 },
    ],
  },

  // ── F11 Eraser ─────────────────────────────────────────────────────────────
  eraser: {
    id: 'eraser', family: 'eraser', nameKey: 'layer_tool_eraser', Icon: Eraser,
    priority: 'P0', shortcut: 'E', cursor: 'brush-outline', claims: ['alt'], requires: ['raster'],
    blocks: ['brushCore'],
    options: [
      {
        kind: 'segmented', id: 'eraser-mode', labelKey: 'layer_topt_eraser_mode', priority: 0,
        choices: [
          { value: 'brush', labelKey: 'layer_topt_eraser_mode_brush', icon: Brush },
          { value: 'pencil', labelKey: 'layer_topt_eraser_mode_pencil', icon: Pencil },
          { value: 'block', labelKey: 'layer_topt_eraser_mode_block', icon: Square },
        ],
        def: 'brush',
      },
      { kind: 'toggle', id: 'erase-to-history', labelKey: 'layer_topt_erase_to_history', priority: 2, def: false },
    ],
  },
  'bg-eraser': {
    id: 'bg-eraser', family: 'eraser', nameKey: 'layer_tool_bg_eraser', Icon: Layers,
    priority: 'P1', shortcut: 'shift+E', cursor: 'brush-outline', requires: ['raster'],
    blocks: ['brushCore'], omit: BRUSH_TRIO_OMIT,
    options: [
      {
        kind: 'segmented', id: 'sampling', labelKey: 'layer_topt_sampling', priority: 0,
        choices: SAMPLING_MODE_CHOICES, def: 'continuous',
      },
      {
        kind: 'select', id: 'limits', labelKey: 'layer_topt_limits', priority: 1,
        choices: LIMITS_CHOICES, def: 'contiguous', width: 148,
      },
      { kind: 'number', id: 'tolerance', labelKey: 'layer_topt_tolerance', priority: 0, min: 0, max: 100, unit: '%', def: 50, width: 52 },
      { kind: 'toggle', id: 'protect-fg', labelKey: 'layer_topt_protect_fg', priority: 2, def: false },
    ],
  },
  'magic-eraser': {
    id: 'magic-eraser', family: 'eraser', nameKey: 'layer_tool_magic_eraser', Icon: Zap,
    priority: 'P1', shortcut: 'shift+E', cursor: 'crosshair', requires: ['raster'],
    options: [
      { kind: 'number', id: 'tolerance', labelKey: 'layer_topt_tolerance', priority: 0, min: 0, max: 255, def: 32, width: 52 },
      { kind: 'toggle', id: 'antialias', labelKey: 'layer_topt_antialias', priority: 1, def: true },
      { kind: 'toggle', id: 'contiguous', labelKey: 'layer_topt_contiguous', priority: 1, def: true },
      optSampleAll,
      { kind: 'number', id: 'opacity', labelKey: 'layer_topt_opacity', priority: 0, min: 0, max: 100, unit: '%', def: 100, width: 52 },
    ],
  },

  // ── F12 Fill ───────────────────────────────────────────────────────────────
  gradient: {
    id: 'gradient', family: 'fill', nameKey: 'layer_tool_gradient', Icon: Contrast,
    priority: 'P0', shortcut: 'G', cursor: 'crosshair', claims: ['shift'], requires: ['raster'],
    options: [
      { kind: 'gradient', id: 'gradient', labelKey: 'layer_topt_gradient', priority: 0, def: 'fg-bg' },
      {
        kind: 'segmented', id: 'gradient-type', labelKey: 'layer_topt_gradient_type', priority: 0,
        choices: [
          { value: 'linear', labelKey: 'layer_topt_gradient_type_linear', icon: MoveHorizontal },
          { value: 'radial', labelKey: 'layer_topt_gradient_type_radial', icon: Circle },
          { value: 'angle', labelKey: 'layer_topt_gradient_type_angle', icon: RotateCcw },
          { value: 'reflected', labelKey: 'layer_topt_gradient_type_reflected', icon: MoveVertical },
          { value: 'diamond', labelKey: 'layer_topt_gradient_type_diamond', icon: SquareDot },
        ],
        def: 'linear',
      },
      { kind: 'blend', id: 'blend', labelKey: 'layer_topt_blend', priority: 1, def: 'normal', width: 116 },
      { kind: 'number', id: 'opacity', labelKey: 'layer_topt_opacity', priority: 0, min: 0, max: 100, unit: '%', def: 100, width: 52 },
      { kind: 'toggle', id: 'reverse', labelKey: 'layer_topt_reverse', priority: 1, def: false },
      { kind: 'toggle', id: 'dither', labelKey: 'layer_topt_dither', priority: 2, def: true },
      { kind: 'toggle', id: 'transparency', labelKey: 'layer_topt_transparency', priority: 2, def: true },
      {
        kind: 'select', id: 'gradient-method', labelKey: 'layer_topt_gradient_method', priority: 2, width: 132,
        choices: [
          { value: 'perceptual', labelKey: 'layer_topt_gradient_method_perceptual' },
          { value: 'linear', labelKey: 'layer_topt_gradient_method_linear' },
          { value: 'classic', labelKey: 'layer_topt_gradient_method_classic' },
        ],
        def: 'perceptual',
      },
    ],
  },
  bucket: {
    id: 'bucket', family: 'fill', nameKey: 'layer_tool_bucket', Icon: PaintBucket,
    priority: 'P0', shortcut: 'shift+G', cursor: 'crosshair', requires: ['raster'],
    blocks: ['sampling'], omit: ['sample-source'],
    options: [
      {
        kind: 'select', id: 'fill-source', labelKey: 'layer_topt_fill_source', priority: 0, width: 132,
        choices: [
          { value: 'fg', labelKey: 'layer_topt_fill_source_fg' },
          { value: 'bg', labelKey: 'layer_topt_fill_source_bg' },
          { value: 'pattern', labelKey: 'layer_topt_fill_source_pattern' },
        ],
        def: 'fg',
      },
      {
        kind: 'pattern', id: 'pattern', labelKey: 'layer_topt_pattern', priority: 1, def: 'checker',
        visibleIf: (v: ToolValues) => v['fill-source'] === 'pattern',
      },
      { kind: 'blend', id: 'blend', labelKey: 'layer_topt_blend', priority: 1, def: 'normal', width: 116 },
      { kind: 'number', id: 'opacity', labelKey: 'layer_topt_opacity', priority: 0, min: 0, max: 100, unit: '%', def: 100, width: 52 },
      { kind: 'toggle', id: 'antialias', labelKey: 'layer_topt_antialias', priority: 2, def: true },
    ],
  },

  // ── F13 Local retouch ──────────────────────────────────────────────────────
  blur: {
    id: 'blur', family: 'focus', nameKey: 'layer_tool_blur', Icon: Droplet,
    priority: 'P0', cursor: 'brush-outline', requires: ['raster'],
    blocks: ['brushCore'], omit: BRUSH_TRIO_OMIT,
    options: focusToolOptions([]),
  },
  sharpen: {
    id: 'sharpen', family: 'focus', nameKey: 'layer_tool_sharpen', Icon: Triangle,
    priority: 'P0', cursor: 'brush-outline', requires: ['raster'],
    blocks: ['brushCore'], omit: BRUSH_TRIO_OMIT,
    options: focusToolOptions([
      { kind: 'toggle', id: 'protect-detail', labelKey: 'layer_topt_protect_detail', priority: 1, def: true },
    ]),
  },
  smudge: {
    id: 'smudge', family: 'focus', nameKey: 'layer_tool_smudge', Icon: Fingerprint,
    priority: 'P1', cursor: 'brush-outline', requires: ['raster'],
    blocks: ['brushCore'], omit: BRUSH_TRIO_OMIT,
    options: focusToolOptions([
      { kind: 'toggle', id: 'finger-paint', labelKey: 'layer_topt_finger_paint', priority: 1, def: false },
    ]),
  },

  // ── F14 Tone ───────────────────────────────────────────────────────────────
  dodge: {
    id: 'dodge', family: 'tone', nameKey: 'layer_tool_dodge', Icon: Sun,
    priority: 'P0', shortcut: 'O', cursor: 'brush-outline', requires: ['raster'],
    blocks: ['brushCore'], omit: BRUSH_TRIO_OMIT, options: TONE_OPTIONS,
  },
  burn: {
    id: 'burn', family: 'tone', nameKey: 'layer_tool_burn', Icon: Moon,
    priority: 'P0', shortcut: 'shift+O', cursor: 'brush-outline', requires: ['raster'],
    blocks: ['brushCore'], omit: BRUSH_TRIO_OMIT, options: TONE_OPTIONS,
  },
  sponge: {
    id: 'sponge', family: 'tone', nameKey: 'layer_tool_sponge', Icon: Droplets,
    priority: 'P1', shortcut: 'shift+O', cursor: 'brush-outline', requires: ['raster'],
    blocks: ['brushCore'], omit: BRUSH_TRIO_OMIT,
    options: [
      {
        kind: 'segmented', id: 'sponge-mode', labelKey: 'layer_topt_sponge_mode', priority: 0,
        choices: [
          { value: 'desaturate', labelKey: 'layer_topt_sponge_mode_desaturate', icon: Droplet },
          { value: 'saturate', labelKey: 'layer_topt_sponge_mode_saturate', icon: Palette },
        ],
        def: 'desaturate',
      },
      { kind: 'number', id: 'flow', labelKey: 'layer_topt_flow', priority: 0, min: 0, max: 100, unit: '%', def: 50, width: 52 },
      { kind: 'toggle', id: 'airbrush', labelKey: 'layer_topt_airbrush', priority: 2, def: false },
      { kind: 'toggle', id: 'vibrance', labelKey: 'layer_topt_vibrance', priority: 1, def: true },
    ],
  },

  // ── F15 Pen & paths ────────────────────────────────────────────────────────
  pen: {
    id: 'pen', family: 'pen', nameKey: 'layer_tool_pen', Icon: PenTool,
    priority: 'P1', shortcut: 'P', cursor: 'crosshair', claims: ['ctrl', 'alt'], requires: ['vector'],
    blocks: ['shapeStyle'],
    options: [
      { kind: 'toggle', id: 'auto-add-delete', labelKey: 'layer_topt_auto_add_delete', priority: 1, def: true },
      { kind: 'toggle', id: 'rubber-band', labelKey: 'layer_topt_rubber_band', priority: 1, def: true },
    ],
  },
  'pen-free': {
    id: 'pen-free', family: 'pen', nameKey: 'layer_tool_pen_free', Icon: PenLine,
    priority: 'P1', shortcut: 'shift+P', cursor: 'crosshair', claims: ['ctrl', 'alt'], requires: ['vector'],
    blocks: ['shapeStyle'],
    options: [
      { kind: 'toggle', id: 'auto-add-delete', labelKey: 'layer_topt_auto_add_delete', priority: 1, def: true },
      { kind: 'toggle', id: 'rubber-band', labelKey: 'layer_topt_rubber_band', priority: 1, def: true },
      { kind: 'number', id: 'curve-fit', labelKey: 'layer_topt_curve_fit', priority: 1, min: 0.5, max: 10, step: 0.5, unit: 'px', def: 2, width: 52 },
      { kind: 'toggle', id: 'magnetic', labelKey: 'layer_topt_magnetic', priority: 2, def: false },
    ],
  },
  'pen-curvature': {
    id: 'pen-curvature', family: 'pen', nameKey: 'layer_tool_pen_curvature', Icon: Spline,
    priority: 'P2', shortcut: 'shift+P', cursor: 'crosshair', claims: ['ctrl', 'alt'], requires: ['vector'],
    blocks: ['shapeStyle'],
    options: [
      { kind: 'toggle', id: 'auto-add-delete', labelKey: 'layer_topt_auto_add_delete', priority: 1, def: true },
      { kind: 'toggle', id: 'rubber-band', labelKey: 'layer_topt_rubber_band', priority: 1, def: true },
    ],
  },
  // The three anchor tools have no options of their own: they show the active
  // path's bar plus a one-line hint.
  'anchor-add': {
    id: 'anchor-add', family: 'pen', nameKey: 'layer_tool_anchor_add', Icon: PlusCircle,
    priority: 'P2', shortcut: 'shift+P', cursor: 'crosshair', requires: ['vector'],
    blocks: ['shapeStyle'], omit: PATH_ONLY_OMIT,
    options: [{ kind: 'readout', id: 'anchor-hint', labelKey: 'layer_topt_anchor_hint', priority: 1, read: 'anchor-hint' }],
  },
  'anchor-remove': {
    id: 'anchor-remove', family: 'pen', nameKey: 'layer_tool_anchor_remove', Icon: MinusCircle,
    priority: 'P2', shortcut: 'shift+P', cursor: 'crosshair', requires: ['vector'],
    blocks: ['shapeStyle'], omit: PATH_ONLY_OMIT,
    options: [{ kind: 'readout', id: 'anchor-hint', labelKey: 'layer_topt_anchor_hint', priority: 1, read: 'anchor-hint' }],
  },
  'anchor-convert': {
    id: 'anchor-convert', family: 'pen', nameKey: 'layer_tool_anchor_convert', Icon: CornerUpRight,
    priority: 'P2', shortcut: 'shift+P', cursor: 'crosshair', requires: ['vector'],
    blocks: ['shapeStyle'], omit: PATH_ONLY_OMIT,
    options: [{ kind: 'readout', id: 'anchor-hint', labelKey: 'layer_topt_anchor_hint', priority: 1, read: 'anchor-hint' }],
  },

  // ── F16 Text ───────────────────────────────────────────────────────────────
  'text-h': {
    id: 'text-h', family: 'text', nameKey: 'layer_tool_text_h', Icon: Type,
    priority: 'P0', shortcut: 'T', cursor: 'text', requires: ['text'], options: textOptions('h', true),
  },
  'text-v': {
    id: 'text-v', family: 'text', nameKey: 'layer_tool_text_v', Icon: TextCursor,
    priority: 'P1', shortcut: 'shift+T', cursor: 'text', requires: ['text'], options: textOptions('v', true),
  },
  'text-mask-h': {
    id: 'text-mask-h', family: 'text', nameKey: 'layer_tool_text_mask_h', Icon: Baseline,
    priority: 'P2', shortcut: 'shift+T', cursor: 'text', requires: ['text'],
    blocks: ['selection'], options: textOptions('h', false),
  },
  'text-mask-v': {
    id: 'text-mask-v', family: 'text', nameKey: 'layer_tool_text_mask_v', Icon: ALargeSmall,
    priority: 'P2', shortcut: 'shift+T', cursor: 'text', requires: ['text'],
    blocks: ['selection'], options: textOptions('v', false),
  },

  // ── F17 Path selection ─────────────────────────────────────────────────────
  'path-select': {
    id: 'path-select', family: 'pathsel', nameKey: 'layer_tool_path_select', Icon: MousePointer2,
    priority: 'P1', shortcut: 'A', cursor: 'default', requires: ['vector'],
    blocks: ['shapeStyle'], omit: ['shape-output', 'antialias'],
    options: [
      {
        kind: 'select', id: 'path-scope', labelKey: 'layer_topt_path_scope', priority: 0, width: 132,
        choices: [
          { value: 'active', labelKey: 'layer_topt_path_scope_active' },
          { value: 'all', labelKey: 'layer_topt_path_scope_all' },
        ],
        def: 'active',
      },
      { kind: 'toggle', id: 'constrain-path', labelKey: 'layer_topt_constrain_path', priority: 2, def: false },
    ],
  },
  'direct-select': {
    id: 'direct-select', family: 'pathsel', nameKey: 'layer_tool_direct_select', Icon: Waypoints,
    priority: 'P1', shortcut: 'shift+A', cursor: 'default', requires: ['vector'],
    blocks: ['shapeStyle'], omit: ['shape-output', 'antialias'],
    options: [{ kind: 'toggle', id: 'show-handles', labelKey: 'layer_topt_show_handles', priority: 1, def: true }],
  },

  // ── F18 Vector shapes ──────────────────────────────────────────────────────
  'shape-rect': {
    id: 'shape-rect', family: 'shape', nameKey: 'layer_tool_shape_rect', Icon: Square,
    priority: 'P0', shortcut: 'U', cursor: 'crosshair', claims: ['shift', 'alt'], requires: ['vector'],
    blocks: ['shapeStyle'],
    options: [
      { kind: 'number', id: 'corner-radius', labelKey: 'layer_topt_corner_radius', priority: 1, min: 0, max: 1000, unit: 'px', def: 0, width: 52 },
      optShapeConstraint,
    ],
  },
  'shape-rrect': {
    id: 'shape-rrect', family: 'shape', nameKey: 'layer_tool_shape_rrect', Icon: Squircle,
    priority: 'P0', shortcut: 'shift+U', cursor: 'crosshair', claims: ['shift', 'alt'], requires: ['vector'],
    blocks: ['shapeStyle'],
    options: [
      { kind: 'number', id: 'corner-radius', labelKey: 'layer_topt_corner_radius', priority: 0, min: 0, max: 1000, unit: 'px', def: 8, width: 52 },
      { kind: 'toggle', id: 'same-radii', labelKey: 'layer_topt_same_radii', priority: 1, def: true },
      optShapeConstraint,
    ],
  },
  'shape-ellipse': {
    id: 'shape-ellipse', family: 'shape', nameKey: 'layer_tool_shape_ellipse', Icon: Circle,
    priority: 'P0', shortcut: 'shift+U', cursor: 'crosshair', claims: ['shift', 'alt'], requires: ['vector'],
    blocks: ['shapeStyle'], options: [optShapeConstraint],
  },
  'shape-polygon': {
    id: 'shape-polygon', family: 'shape', nameKey: 'layer_tool_shape_polygon', Icon: Hexagon,
    priority: 'P1', shortcut: 'shift+U', cursor: 'crosshair', claims: ['shift', 'alt'], requires: ['vector'],
    blocks: ['shapeStyle'],
    options: [
      { kind: 'number', id: 'sides', labelKey: 'layer_topt_sides', priority: 0, min: 3, max: 100, def: 5, width: 48 },
      { kind: 'toggle', id: 'star', labelKey: 'layer_topt_star', priority: 1, def: false },
      {
        kind: 'number', id: 'star-indent', labelKey: 'layer_topt_star_indent', priority: 1,
        min: 1, max: 99, unit: '%', def: 50, width: 52,
        disabledIf: (v: ToolValues) => v['star'] !== true,
      },
      { kind: 'toggle', id: 'smooth-corners', labelKey: 'layer_topt_smooth_corners', priority: 2, def: false },
      { kind: 'number', id: 'radius', labelKey: 'layer_topt_radius', priority: 2, min: 0, max: 30000, unit: 'px', def: 0, width: 60 },
      optShapeConstraint,
    ],
  },
  'shape-line': {
    id: 'shape-line', family: 'shape', nameKey: 'layer_tool_shape_line', Icon: Minus,
    priority: 'P0', shortcut: 'shift+U', cursor: 'crosshair', claims: ['shift', 'alt'], requires: ['vector'],
    blocks: ['shapeStyle'],
    options: [
      { kind: 'number', id: 'line-weight', labelKey: 'layer_topt_line_weight', priority: 0, min: 1, max: 1000, unit: 'px', def: 5, width: 52 },
      {
        kind: 'popover', id: 'arrowheads', labelKey: 'layer_topt_arrowheads', priority: 1,
        items: [
          { kind: 'toggle', id: 'arrow-start', labelKey: 'layer_topt_arrow_start', priority: 0, def: false },
          { kind: 'toggle', id: 'arrow-end', labelKey: 'layer_topt_arrow_end', priority: 0, def: false },
          { kind: 'number', id: 'arrow-width', labelKey: 'layer_topt_arrow_width', priority: 0, min: 10, max: 1000, unit: '%', def: 500, width: 60 },
          { kind: 'number', id: 'arrow-length', labelKey: 'layer_topt_arrow_length', priority: 0, min: 10, max: 5000, unit: '%', def: 1000, width: 60 },
          { kind: 'number', id: 'arrow-concavity', labelKey: 'layer_topt_arrow_concavity', priority: 0, min: -50, max: 50, unit: '%', def: 0, width: 60 },
        ],
      },
      optShapeConstraint,
    ],
  },
  'shape-custom': {
    id: 'shape-custom', family: 'shape', nameKey: 'layer_tool_shape_custom', Icon: Star,
    priority: 'P1', shortcut: 'shift+U', cursor: 'crosshair', claims: ['shift', 'alt'], requires: ['vector'],
    blocks: ['shapeStyle'],
    options: [
      { kind: 'shape', id: 'custom-shape', labelKey: 'layer_topt_custom_shape', priority: 0, def: 'heart' },
      optShapeConstraint,
    ],
  },

  // ── F19 Navigation ─────────────────────────────────────────────────────────
  hand: {
    id: 'hand', family: 'navigate', nameKey: 'layer_tool_hand', Icon: Hand,
    priority: 'P0', shortcut: 'H', cursor: 'grab', claims: ['space'],
    options: [
      { kind: 'action', id: 'view-100', labelKey: 'layer_topt_view_100', priority: 0, run: 'view-100' },
      { kind: 'action', id: 'view-fit', labelKey: 'layer_topt_view_fit', priority: 0, run: 'view-fit' },
      { kind: 'action', id: 'view-fill', labelKey: 'layer_topt_view_fill', priority: 1, run: 'view-fill' },
      { kind: 'toggle', id: 'scroll-all', labelKey: 'layer_topt_scroll_all', priority: 2, def: false },
      { kind: 'readout', id: 'zoom-level', labelKey: 'layer_topt_zoom_level', priority: 1, read: 'zoom-level' },
      { kind: 'readout', id: 'view-rotation', labelKey: 'layer_topt_view_rotation', priority: 2, read: 'view-rotation' },
    ],
  },
  'rotate-view': {
    id: 'rotate-view', family: 'navigate', nameKey: 'layer_tool_rotate_view', Icon: RotateCcw,
    priority: 'P0', shortcut: 'R', cursor: 'grab',
    options: [
      { kind: 'number', id: 'angle', labelKey: 'layer_topt_angle', priority: 0, min: -180, max: 180, step: 1, unit: '°', def: 0, width: 56 },
      { kind: 'action', id: 'reset-view', labelKey: 'layer_topt_reset_view', priority: 0, run: 'reset-view' },
      { kind: 'toggle', id: 'rotate-all', labelKey: 'layer_topt_rotate_all', priority: 2, def: false },
    ],
  },

  // ── F20 Zoom ───────────────────────────────────────────────────────────────
  zoom: {
    id: 'zoom', family: 'zoom', nameKey: 'layer_tool_zoom', Icon: ZoomIn,
    priority: 'P0', shortcut: 'Z', cursor: 'zoom-in', claims: ['alt', 'space'],
    options: [
      {
        kind: 'segmented', id: 'zoom-direction', labelKey: 'layer_topt_zoom_direction', priority: 0,
        choices: [
          { value: 'in', labelKey: 'layer_topt_zoom_direction_in', icon: ZoomIn },
          { value: 'out', labelKey: 'layer_topt_zoom_direction_out', icon: ZoomOut },
        ],
        def: 'in',
      },
      { kind: 'toggle', id: 'resize-windows', labelKey: 'layer_topt_resize_windows', priority: 2, def: false },
      { kind: 'toggle', id: 'zoom-all', labelKey: 'layer_topt_zoom_all', priority: 2, def: false },
      { kind: 'toggle', id: 'animated-zoom', labelKey: 'layer_topt_animated_zoom', priority: 2, def: true },
      { kind: 'action', id: 'view-100', labelKey: 'layer_topt_view_100', priority: 0, run: 'view-100' },
      { kind: 'action', id: 'view-fit', labelKey: 'layer_topt_view_fit', priority: 0, run: 'view-fit' },
      { kind: 'action', id: 'view-fill', labelKey: 'layer_topt_view_fill', priority: 1, run: 'view-fill' },
      { kind: 'readout', id: 'zoom-level', labelKey: 'layer_topt_zoom_level', priority: 1, read: 'zoom-level' },
    ],
  },
}

// ── Responsive merge plan (spec §3.7) ────────────────────────────────────────

/**
 * Successive merge stages. Each stage is CUMULATIVE with the ones before it: the
 * rail applies the smallest stage that makes the 20 family buttons fit. Pairs are
 * ordered by semantic proximity so a merged flyout still reads as one idea.
 */
export const FAMILY_MERGE_STAGES: [FamilyId, FamilyId][][] = [
  [['marquee', 'lasso'], ['crop', 'sample']],
  [['stamp', 'history'], ['fill', 'focus']],
  [['healing', 'tone'], ['pathsel', 'shape']],
  [['move', 'autoselect'], ['pen', 'text'], ['navigate', 'zoom']],
]

/**
 * Last resort on a very short rail: eight groups only. Not expressible as pairs
 * (it regroups differently), so it is spelled out — spec §3.7.
 */
export const COMPACT_RAIL_GROUPS: { keep: FamilyId; absorb: FamilyId[] }[] = [
  { keep: 'move', absorb: ['marquee', 'crop'] },
  { keep: 'lasso', absorb: ['autoselect', 'sample'] },
  { keep: 'paint', absorb: ['healing', 'stamp', 'history', 'tone', 'focus'] },
  { keep: 'eraser', absorb: [] },
  { keep: 'fill', absorb: [] },
  { keep: 'text', absorb: [] },
  { keep: 'shape', absorb: ['pen', 'pathsel'] },
  { keep: 'navigate', absorb: ['zoom'] },
]

/** Height (px) one rail button occupies, gap included — drives `railFamilies`. */
export const RAIL_ITEM_PITCH = 36

/** Room the rail reserves above/below the family buttons (separators, padding). */
export const RAIL_CHROME_HEIGHT = 16

/** Long-press delay before a flyout opens, in ms (spec §3.2, settable 120–600). */
export const FLYOUT_LONGPRESS_MS = 200

/** Pointer travel (px) that cancels a long press. */
export const FLYOUT_MOVE_TOLERANCE = 4

/** Convenience: an empty merged view, used as the identity of `railFamilies`. */
export const ALL_RAIL_FAMILIES: RailFamily[] = TOOL_FAMILIES.map(f => ({ ...f }))
