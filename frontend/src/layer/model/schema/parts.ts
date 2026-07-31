// Readers for the composite sub-objects of a layer node.
//
// The wire form of these parts IS their in-memory form (plain JSON data, no
// special encoding), so the writer side is a structural clone. What matters
// here is that each reader is TOTAL and IDEMPOTENT: fed the writer's output it
// must return an identical object, otherwise `fromWire(toWire(n)) === n` fails.

import { asBlendMode } from '../../blend/modes.ts'
import {
  BLACK,
  WHITE,
  defaultAdjustment,
  defaultContour,
  defaultGradient,
  defaultLayerMask,
  defaultSmartFilterStack,
  defaultStyleStack,
  defaultTextData,
  emptyPath,
  rgba,
} from '../ops/defaults.ts'
import type {
  AdjustmentKind,
  AdjustmentSpec,
  BevelEmboss,
  BlendIfSpec,
  CMYKTriple,
  ColorOverlay,
  ContourSpec,
  CurvePoints,
  CurvesChannel,
  DropShadow,
  FillContent,
  GradientOverlay,
  GradientSegmentShape,
  GradientSpec,
  GradientStyle,
  HSLBand,
  InnerGlow,
  InnerShadow,
  KnockoutMode,
  LayerMask,
  LayerStyleStack,
  LevelsChannel,
  LevelsParams,
  LiveShape,
  MixerRow,
  OuterGlow,
  ParagraphStyle,
  PatternOverlay,
  RGBA,
  RGBTriple,
  RasterSurfaceRef,
  RectI,
  Satin,
  SelectiveFamily,
  SmartFilter,
  SmartFilterStack,
  StrokeEffect,
  SubPath,
  TextLayerData,
  TextRun,
  TextWarpSpec,
  VectorMask,
  VectorNode,
  VectorPath,
  VectorStroke,
} from '../types.ts'
import {
  isRecord,
  readArray,
  readBool,
  readColor,
  readEnum,
  readInt,
  readNumber,
  readRange,
  readRect,
  readString,
  type Ctx,
  type RawNode,
} from './coerce.ts'

const rec = (v: unknown): RawNode => (isRecord(v) ? v : {})
const list = (v: unknown): unknown[] => readArray(v) ?? []

// ── Surfaces and masks ───────────────────────────────────────────────────────

export function readSurfaceRef(v: unknown, bounds: RectI, ctx: Ctx): RasterSurfaceRef | null {
  if (!isRecord(v)) return null
  const id = readString(v.surfaceId, '', ctx, 'surfaceId')
  if (!id) return null
  return {
    surfaceId: id,
    bounds: readRect(v.bounds, bounds, ctx, 'bounds'),
    version: readInt(v.version, 0, Number.MAX_SAFE_INTEGER, 0, ctx, 'version'),
  }
}

export function readLayerMask(v: unknown, docBounds: RectI, ctx: Ctx): LayerMask | null {
  if (!isRecord(v)) return null
  const d = defaultLayerMask(docBounds, '')
  const surface = readSurfaceRef(v.surface, docBounds, ctx)
  if (!surface) return null
  return {
    surface,
    enabled: readBool(v.enabled, d.enabled),
    inverted: readBool(v.inverted, d.inverted),
    linked: readBool(v.linked, d.linked),
    density: readInt(v.density, 0, 255, d.density, ctx, 'layerMask.density'),
    feather: readRange(v.feather, 0, 1000, d.feather, ctx, 'layerMask.feather'),
    outsideValue: readNumber(v.outsideValue, 255) === 0 ? 0 : 255,
    previewAsRubylith: readBool(v.previewAsRubylith, d.previewAsRubylith),
    rubylithColor: readColor(v.rubylithColor, d.rubylithColor, ctx, 'layerMask.rubylithColor'),
  }
}

export function readVectorMask(v: unknown, ctx: Ctx): VectorMask | null {
  if (!isRecord(v)) return null
  return {
    path: readVectorPath(v.path, ctx),
    enabled: readBool(v.enabled, true),
    inverted: readBool(v.inverted, false),
    linked: readBool(v.linked, true),
    density: readInt(v.density, 0, 255, 255, ctx, 'vectorMask.density'),
    feather: readRange(v.feather, 0, 1000, 0, ctx, 'vectorMask.feather'),
  }
}

// ── Vector geometry ──────────────────────────────────────────────────────────

const SUBPATH_OPS = ['add', 'subtract', 'intersect', 'exclude'] as const

function readVectorNode(v: unknown, ctx: Ctx): VectorNode {
  const o = rec(v)
  const x = readNumber(o.x, 0, ctx, 'path.x')
  const y = readNumber(o.y, 0, ctx, 'path.y')
  return {
    x, y,
    inX: readNumber(o.inX, x, ctx, 'path.inX'),
    inY: readNumber(o.inY, y, ctx, 'path.inY'),
    outX: readNumber(o.outX, x, ctx, 'path.outX'),
    outY: readNumber(o.outY, y, ctx, 'path.outY'),
  }
}

export function readVectorPath(v: unknown, ctx: Ctx): VectorPath {
  if (!isRecord(v)) return emptyPath()
  const subpaths: SubPath[] = list(v.subpaths).map(sp => {
    const o = rec(sp)
    return {
      closed: readBool(o.closed, true),
      nodes: list(o.nodes).map(n => readVectorNode(n, ctx)),
      op: readEnum(o.op, SUBPATH_OPS, 'add', ctx, 'subpath.op'),
    }
  })
  return { subpaths, fillRule: readEnum(v.fillRule, ['nonzero', 'evenodd'] as const, 'nonzero', ctx, 'fillRule') }
}

export function readVectorStroke(v: unknown, ctx: Ctx): VectorStroke | null {
  if (!isRecord(v)) return null
  const dashRaw = v.dash
  return {
    color: readFillContent(v.color, ctx),
    width: readRange(v.width, 0, 10000, 1, ctx, 'stroke.width'),
    align: readEnum(v.align, ['inside', 'center', 'outside'] as const, 'center', ctx, 'stroke.align'),
    cap: readEnum(v.cap, ['butt', 'round', 'square'] as const, 'butt', ctx, 'stroke.cap'),
    join: readEnum(v.join, ['miter', 'round', 'bevel'] as const, 'miter', ctx, 'stroke.join'),
    miterLimit: readRange(v.miterLimit, 1, 500, 10, ctx, 'stroke.miterLimit'),
    dash: isRecord(dashRaw)
      ? {
          pattern: list(dashRaw.pattern).map(n => readNumber(n, 0, ctx, 'stroke.dash')),
          offset: readNumber(dashRaw.offset, 0, ctx, 'stroke.dash.offset'),
        }
      : null,
  }
}

// ── Gradients and fills ──────────────────────────────────────────────────────

const SEGMENT_SHAPES: readonly GradientSegmentShape[] = [
  'linear', 'curved', 'sine', 'sphereIncreasing', 'sphereDecreasing', 'step',
]
const GRADIENT_STYLES: readonly GradientStyle[] = [
  'linear', 'radial', 'angle', 'reflected', 'diamond',
]

export function readGradient(v: unknown, ctx: Ctx): GradientSpec {
  if (!isRecord(v)) return defaultGradient()
  const d = defaultGradient()
  const colorStops = list(v.colorStops).map(s => {
    const o = rec(s)
    return {
      position: readRange(o.position, 0, 1, 0, ctx, 'gradient.position'),
      color: readColor(o.color, BLACK, ctx, 'gradient.color'),
      midpoint: readRange(o.midpoint, 0, 1, 0.5, ctx, 'gradient.midpoint'),
      shape: readEnum(o.shape, SEGMENT_SHAPES, 'linear', ctx, 'gradient.shape'),
    }
  })
  const opacityStops = list(v.opacityStops).map(s => {
    const o = rec(s)
    return {
      position: readRange(o.position, 0, 1, 0, ctx, 'gradient.position'),
      opacity: readInt(o.opacity, 0, 255, 255, ctx, 'gradient.opacity'),
      midpoint: readRange(o.midpoint, 0, 1, 0.5, ctx, 'gradient.midpoint'),
    }
  })
  return {
    colorStops: colorStops.length ? colorStops : d.colorStops,
    opacityStops: opacityStops.length ? opacityStops : d.opacityStops,
    interpolation: readEnum(
      v.interpolation, ['rgb', 'hsvCw', 'hsvCcw', 'perceptual'] as const, 'rgb', ctx, 'gradient.interpolation',
    ),
    presetId: typeof v.presetId === 'string' ? v.presetId : null,
  }
}

const xy = (v: unknown, ctx: Ctx): { x: number; y: number } => {
  const o = rec(v)
  return { x: readNumber(o.x, 0, ctx, 'offset.x'), y: readNumber(o.y, 0, ctx, 'offset.y') }
}

export function readFillContent(v: unknown, ctx: Ctx): FillContent {
  if (!isRecord(v)) return { type: 'solid', color: BLACK }
  const type = readEnum(v.type, ['solid', 'gradient', 'pattern'] as const, 'solid', ctx, 'fill.type')
  if (type === 'gradient') {
    return {
      type: 'gradient',
      gradient: readGradient(v.gradient, ctx),
      style: readEnum(v.style, GRADIENT_STYLES, 'linear', ctx, 'fill.style'),
      angle: readNumber(v.angle, 90, ctx, 'fill.angle'),
      scale: readRange(v.scale, 1, 1000, 100, ctx, 'fill.scale'),
      reverse: readBool(v.reverse, false),
      dither: readBool(v.dither, false),
      alignWithLayer: readBool(v.alignWithLayer, true),
      offset: xy(v.offset, ctx),
    }
  }
  if (type === 'pattern') {
    return {
      type: 'pattern',
      patternId: readString(v.patternId, '', ctx, 'fill.patternId'),
      scale: readRange(v.scale, 1, 1000, 100, ctx, 'fill.scale'),
      angle: readNumber(v.angle, 0, ctx, 'fill.angle'),
      linkWithLayer: readBool(v.linkWithLayer, true),
      offset: xy(v.offset, ctx),
    }
  }
  return { type: 'solid', color: readColor(v.color, BLACK, ctx, 'fill.color') }
}

// ── Text ─────────────────────────────────────────────────────────────────────

function readTextRun(v: unknown, ctx: Ctx): TextRun {
  const o = rec(v)
  return {
    start: readInt(o.start, 0, Number.MAX_SAFE_INTEGER, 0, ctx, 'run.start'),
    end: readInt(o.end, 0, Number.MAX_SAFE_INTEGER, 0, ctx, 'run.end'),
    fontFamily: readString(o.fontFamily, 'Arial', ctx, 'run.fontFamily'),
    fontSize: readRange(o.fontSize, 0.1, 5000, 16, ctx, 'run.fontSize'),
    fontWeight: readInt(o.fontWeight, 1, 1000, 400, ctx, 'run.fontWeight'),
    italic: readBool(o.italic, false),
    underline: readBool(o.underline, false),
    strikethrough: readBool(o.strikethrough, false),
    color: readColor(o.color, BLACK, ctx, 'run.color'),
    tracking: readNumber(o.tracking, 0, ctx, 'run.tracking'),
    leading: o.leading === null || o.leading === undefined ? null : readNumber(o.leading, 1.2, ctx, 'run.leading'),
    baselineShift: readNumber(o.baselineShift, 0, ctx, 'run.baselineShift'),
    caps: readEnum(o.caps, ['none', 'small', 'all'] as const, 'none', ctx, 'run.caps'),
  }
}

function readParagraph(v: unknown, ctx: Ctx): ParagraphStyle {
  const o = rec(v)
  return {
    start: readInt(o.start, 0, Number.MAX_SAFE_INTEGER, 0, ctx, 'para.start'),
    end: readInt(o.end, 0, Number.MAX_SAFE_INTEGER, 0, ctx, 'para.end'),
    align: readEnum(o.align, ['left', 'center', 'right', 'justify'] as const, 'left', ctx, 'para.align'),
    indentFirst: readNumber(o.indentFirst, 0, ctx, 'para.indentFirst'),
    indentLeft: readNumber(o.indentLeft, 0, ctx, 'para.indentLeft'),
    indentRight: readNumber(o.indentRight, 0, ctx, 'para.indentRight'),
    spaceBefore: readNumber(o.spaceBefore, 0, ctx, 'para.spaceBefore'),
    spaceAfter: readNumber(o.spaceAfter, 0, ctx, 'para.spaceAfter'),
    hyphenate: readBool(o.hyphenate, false),
  }
}

export function readTextData(v: unknown, ctx: Ctx): TextLayerData {
  if (!isRecord(v)) return defaultTextData()
  const warpRaw = v.warp
  const warp: TextWarpSpec | null = isRecord(warpRaw)
    ? {
        style: readString(warpRaw.style, 'none', ctx, 'warp.style'),
        bend: readNumber(warpRaw.bend, 0, ctx, 'warp.bend'),
        horizontalDistortion: readNumber(warpRaw.horizontalDistortion, 0, ctx, 'warp.h'),
        verticalDistortion: readNumber(warpRaw.verticalDistortion, 0, ctx, 'warp.v'),
      }
    : null
  return {
    content: readString(v.content, '', ctx, 'text.content'),
    runs: list(v.runs).map(r => readTextRun(r, ctx)),
    paragraphs: list(v.paragraphs).map(p => readParagraph(p, ctx)),
    mode: readEnum(v.mode, ['point', 'paragraph'] as const, 'point', ctx, 'text.mode'),
    box: isRecord(v.box) ? readRect(v.box, { x: 0, y: 0, w: 0, h: 0 }, ctx, 'text.box') : null,
    orientation: readEnum(v.orientation, ['horizontal', 'vertical'] as const, 'horizontal', ctx, 'text.orientation'),
    warp,
    pathId: typeof v.pathId === 'string' ? v.pathId : null,
    version: readInt(v.version, 0, Number.MAX_SAFE_INTEGER, 0, ctx, 'text.version'),
  }
}

// ── Smart filters ────────────────────────────────────────────────────────────

export function readSmartFilters(v: unknown, docBounds: RectI, ctx: Ctx): SmartFilterStack | null {
  if (!isRecord(v)) return null
  const d = defaultSmartFilterStack()
  const filters: SmartFilter[] = list(v.filters).map(f => {
    const o = rec(f)
    const params: Record<string, number> = {}
    const praw = rec(o.params)
    for (const k of Object.keys(praw)) params[k] = readNumber(praw[k], 0, ctx, `filter.${k}`)
    return {
      id: readString(o.id, '', ctx, 'filter.id'),
      filterId: readString(o.filterId, '', ctx, 'filter.filterId'),
      params,
      enabled: readBool(o.enabled, true),
      blendMode: asBlendMode(typeof o.blendMode === 'string' ? o.blendMode : undefined),
      opacity: readInt(o.opacity, 0, 255, 255, ctx, 'filter.opacity'),
    }
  })
  return {
    enabled: readBool(v.enabled, d.enabled),
    filters,
    mask: readLayerMask(v.mask, docBounds, ctx),
  }
}

// ── Layer styles ─────────────────────────────────────────────────────────────

export function readContour(v: unknown, ctx: Ctx): ContourSpec {
  if (!isRecord(v)) return defaultContour()
  const points = list(v.points).map(p => {
    const o = rec(p)
    return {
      x: readRange(o.x, 0, 1, 0, ctx, 'contour.x'),
      y: readRange(o.y, 0, 1, 0, ctx, 'contour.y'),
      corner: readBool(o.corner, false),
    }
  })
  return {
    points: points.length >= 2 ? points : defaultContour().points,
    presetId: typeof v.presetId === 'string' ? v.presetId : null,
  }
}

interface EffectDefaults { blendMode: string; opacity: number }

function readEffectBase(o: RawNode, d: EffectDefaults, ctx: Ctx) {
  return {
    enabled: readBool(o.enabled, true),
    blendMode: asBlendMode(typeof o.blendMode === 'string' ? o.blendMode : d.blendMode),
    opacity: readInt(o.opacity, 0, 255, d.opacity, ctx, 'effect.opacity'),
  }
}

const MAX_STYLE_SIZE = 250
const MAX_STYLE_DISTANCE = 30000

function readDropShadow(v: unknown, ctx: Ctx): DropShadow {
  const o = rec(v)
  return {
    ...readEffectBase(o, { blendMode: 'multiply', opacity: 191 }, ctx),
    color: readColor(o.color, BLACK, ctx, 'dropShadow.color'),
    angle: readNumber(o.angle, 120, ctx, 'dropShadow.angle'),
    useGlobalLight: readBool(o.useGlobalLight, true),
    distance: readRange(o.distance, 0, MAX_STYLE_DISTANCE, 5, ctx, 'dropShadow.distance'),
    spread: readRange(o.spread, 0, 1, 0, ctx, 'dropShadow.spread'),
    size: readRange(o.size, 0, MAX_STYLE_SIZE, 5, ctx, 'dropShadow.size'),
    contour: readContour(o.contour, ctx),
    antiAliased: readBool(o.antiAliased, false),
    noise: readRange(o.noise, 0, 1, 0, ctx, 'dropShadow.noise'),
    layerKnocksOut: readBool(o.layerKnocksOut, true),
  }
}

function readInnerShadow(v: unknown, ctx: Ctx): InnerShadow {
  const o = rec(v)
  return {
    ...readEffectBase(o, { blendMode: 'multiply', opacity: 191 }, ctx),
    color: readColor(o.color, BLACK, ctx, 'innerShadow.color'),
    angle: readNumber(o.angle, 120, ctx, 'innerShadow.angle'),
    useGlobalLight: readBool(o.useGlobalLight, true),
    distance: readRange(o.distance, 0, MAX_STYLE_DISTANCE, 5, ctx, 'innerShadow.distance'),
    choke: readRange(o.choke, 0, 1, 0, ctx, 'innerShadow.choke'),
    size: readRange(o.size, 0, MAX_STYLE_SIZE, 5, ctx, 'innerShadow.size'),
    contour: readContour(o.contour, ctx),
    antiAliased: readBool(o.antiAliased, false),
    noise: readRange(o.noise, 0, 1, 0, ctx, 'innerShadow.noise'),
  }
}

const GLOW_YELLOW: RGBA = rgba(255, 255, 190)

function readGlowFill(v: unknown, ctx: Ctx): OuterGlow['fill'] {
  const o = rec(v)
  if (readEnum(o.type, ['solid', 'gradient'] as const, 'solid', ctx, 'glow.fill.type') === 'gradient') {
    return { type: 'gradient', gradient: readGradient(o.gradient, ctx) }
  }
  return { type: 'solid', color: readColor(o.color, GLOW_YELLOW, ctx, 'glow.fill.color') }
}

function readOuterGlow(v: unknown, ctx: Ctx): OuterGlow | null {
  if (!isRecord(v)) return null
  return {
    ...readEffectBase(v, { blendMode: 'screen', opacity: 191 }, ctx),
    fill: readGlowFill(v.fill, ctx),
    technique: readEnum(v.technique, ['softer', 'precise'] as const, 'softer', ctx, 'outerGlow.technique'),
    spread: readRange(v.spread, 0, 1, 0, ctx, 'outerGlow.spread'),
    size: readRange(v.size, 0, MAX_STYLE_SIZE, 5, ctx, 'outerGlow.size'),
    contour: readContour(v.contour, ctx),
    antiAliased: readBool(v.antiAliased, false),
    range: readRange(v.range, 0, 1, 0.5, ctx, 'outerGlow.range'),
    jitter: readRange(v.jitter, 0, 1, 0, ctx, 'outerGlow.jitter'),
    noise: readRange(v.noise, 0, 1, 0, ctx, 'outerGlow.noise'),
  }
}

function readInnerGlow(v: unknown, ctx: Ctx): InnerGlow | null {
  if (!isRecord(v)) return null
  return {
    ...readEffectBase(v, { blendMode: 'screen', opacity: 191 }, ctx),
    fill: readGlowFill(v.fill, ctx),
    technique: readEnum(v.technique, ['softer', 'precise'] as const, 'softer', ctx, 'innerGlow.technique'),
    choke: readRange(v.choke, 0, 1, 0, ctx, 'innerGlow.choke'),
    size: readRange(v.size, 0, MAX_STYLE_SIZE, 5, ctx, 'innerGlow.size'),
    contour: readContour(v.contour, ctx),
    antiAliased: readBool(v.antiAliased, false),
    range: readRange(v.range, 0, 1, 0.5, ctx, 'innerGlow.range'),
    jitter: readRange(v.jitter, 0, 1, 0, ctx, 'innerGlow.jitter'),
    noise: readRange(v.noise, 0, 1, 0, ctx, 'innerGlow.noise'),
    source: readEnum(v.source, ['center', 'edge'] as const, 'edge', ctx, 'innerGlow.source'),
  }
}

function readBevel(v: unknown, ctx: Ctx): BevelEmboss | null {
  if (!isRecord(v)) return null
  const sub = v.contour
  const tex = v.texture
  return {
    enabled: readBool(v.enabled, true),
    style: readEnum(
      v.style,
      ['outerBevel', 'innerBevel', 'emboss', 'pillowEmboss', 'strokeEmboss'] as const,
      'innerBevel', ctx, 'bevel.style',
    ),
    technique: readEnum(
      v.technique, ['smooth', 'chiselHard', 'chiselSoft'] as const, 'smooth', ctx, 'bevel.technique',
    ),
    depth: readRange(v.depth, 1, 1000, 100, ctx, 'bevel.depth'),
    direction: readEnum(v.direction, ['up', 'down'] as const, 'up', ctx, 'bevel.direction'),
    size: readRange(v.size, 0, MAX_STYLE_SIZE, 5, ctx, 'bevel.size'),
    soften: readRange(v.soften, 0, 16, 0, ctx, 'bevel.soften'),
    angle: readNumber(v.angle, 120, ctx, 'bevel.angle'),
    altitude: readRange(v.altitude, 0, 90, 30, ctx, 'bevel.altitude'),
    useGlobalLight: readBool(v.useGlobalLight, true),
    glossContour: readContour(v.glossContour, ctx),
    glossAntiAliased: readBool(v.glossAntiAliased, false),
    highlightMode: asBlendMode(typeof v.highlightMode === 'string' ? v.highlightMode : 'screen'),
    highlightColor: readColor(v.highlightColor, WHITE, ctx, 'bevel.highlightColor'),
    highlightOpacity: readInt(v.highlightOpacity, 0, 255, 191, ctx, 'bevel.highlightOpacity'),
    shadowMode: asBlendMode(typeof v.shadowMode === 'string' ? v.shadowMode : 'multiply'),
    shadowColor: readColor(v.shadowColor, BLACK, ctx, 'bevel.shadowColor'),
    shadowOpacity: readInt(v.shadowOpacity, 0, 255, 191, ctx, 'bevel.shadowOpacity'),
    contour: isRecord(sub)
      ? {
          contour: readContour(sub.contour, ctx),
          range: readRange(sub.range, 0, 1, 0.5, ctx, 'bevel.contour.range'),
          antiAliased: readBool(sub.antiAliased, false),
        }
      : null,
    texture: isRecord(tex)
      ? {
          patternId: readString(tex.patternId, '', ctx, 'bevel.texture.patternId'),
          scale: readRange(tex.scale, 1, 1000, 100, ctx, 'bevel.texture.scale'),
          depth: readRange(tex.depth, -1000, 1000, 100, ctx, 'bevel.texture.depth'),
          invert: readBool(tex.invert, false),
          linkWithLayer: readBool(tex.linkWithLayer, true),
          offset: xy(tex.offset, ctx),
        }
      : null,
  }
}

function readSatin(v: unknown, ctx: Ctx): Satin | null {
  if (!isRecord(v)) return null
  return {
    ...readEffectBase(v, { blendMode: 'multiply', opacity: 128 }, ctx),
    color: readColor(v.color, BLACK, ctx, 'satin.color'),
    angle: readNumber(v.angle, 19, ctx, 'satin.angle'),
    distance: readRange(v.distance, 0, MAX_STYLE_DISTANCE, 11, ctx, 'satin.distance'),
    size: readRange(v.size, 0, MAX_STYLE_SIZE, 14, ctx, 'satin.size'),
    contour: readContour(v.contour, ctx),
    antiAliased: readBool(v.antiAliased, false),
    invert: readBool(v.invert, true),
  }
}

function readColorOverlay(v: unknown, ctx: Ctx): ColorOverlay {
  const o = rec(v)
  return {
    ...readEffectBase(o, { blendMode: 'normal', opacity: 255 }, ctx),
    color: readColor(o.color, rgba(255, 0, 0), ctx, 'colorOverlay.color'),
  }
}

function readGradientOverlay(v: unknown, ctx: Ctx): GradientOverlay {
  const o = rec(v)
  return {
    ...readEffectBase(o, { blendMode: 'normal', opacity: 255 }, ctx),
    gradient: readGradient(o.gradient, ctx),
    style: readEnum(o.style, GRADIENT_STYLES, 'linear', ctx, 'gradientOverlay.style'),
    angle: readNumber(o.angle, 90, ctx, 'gradientOverlay.angle'),
    scale: readRange(o.scale, 10, 150, 100, ctx, 'gradientOverlay.scale'),
    reverse: readBool(o.reverse, false),
    dither: readBool(o.dither, false),
    alignWithLayer: readBool(o.alignWithLayer, true),
    offset: xy(o.offset, ctx),
  }
}

function readPatternOverlay(v: unknown, ctx: Ctx): PatternOverlay {
  const o = rec(v)
  return {
    ...readEffectBase(o, { blendMode: 'normal', opacity: 255 }, ctx),
    patternId: readString(o.patternId, '', ctx, 'patternOverlay.patternId'),
    scale: readRange(o.scale, 1, 1000, 100, ctx, 'patternOverlay.scale'),
    angle: readNumber(o.angle, 0, ctx, 'patternOverlay.angle'),
    linkWithLayer: readBool(o.linkWithLayer, true),
    offset: xy(o.offset, ctx),
  }
}

function readStrokeEffect(v: unknown, ctx: Ctx): StrokeEffect {
  const o = rec(v)
  return {
    ...readEffectBase(o, { blendMode: 'normal', opacity: 255 }, ctx),
    size: readRange(o.size, 0, MAX_STYLE_SIZE, 3, ctx, 'stroke.size'),
    position: readEnum(o.position, ['outside', 'inside', 'center'] as const, 'outside', ctx, 'stroke.position'),
    fill: readFillContent(o.fill, ctx),
    overprint: readBool(o.overprint, false),
  }
}

const KNOCKOUTS: readonly KnockoutMode[] = ['none', 'shallow', 'deep']

function readBlendIf(v: unknown, ctx: Ctx): BlendIfSpec | null {
  if (!isRecord(v)) return null
  const quad = (raw: unknown, def: [number, number, number, number]): [number, number, number, number] => {
    const a = readArray(raw)
    if (!a || a.length !== 4) return def
    return [
      readInt(a[0], 0, 255, def[0], ctx, 'blendIf'),
      readInt(a[1], 0, 255, def[1], ctx, 'blendIf'),
      readInt(a[2], 0, 255, def[2], ctx, 'blendIf'),
      readInt(a[3], 0, 255, def[3], ctx, 'blendIf'),
    ]
  }
  return {
    channel: readEnum(v.channel, ['gray', 'r', 'g', 'b'] as const, 'gray', ctx, 'blendIf.channel'),
    thisLayer: quad(v.thisLayer, [0, 0, 255, 255]),
    underlyingLayer: quad(v.underlyingLayer, [0, 0, 255, 255]),
  }
}

export function readStyleStack(v: unknown, ctx: Ctx): LayerStyleStack | null {
  if (!isRecord(v)) return null
  const d = defaultStyleStack()
  return {
    enabled: readBool(v.enabled, d.enabled),
    scale: readRange(v.scale, 0.01, 100, 1, ctx, 'styles.scale'),
    dropShadow: list(v.dropShadow).map(e => readDropShadow(e, ctx)),
    innerShadow: list(v.innerShadow).map(e => readInnerShadow(e, ctx)),
    outerGlow: readOuterGlow(v.outerGlow, ctx),
    innerGlow: readInnerGlow(v.innerGlow, ctx),
    bevelEmboss: readBevel(v.bevelEmboss, ctx),
    satin: readSatin(v.satin, ctx),
    colorOverlay: list(v.colorOverlay).map(e => readColorOverlay(e, ctx)),
    gradientOverlay: list(v.gradientOverlay).map(e => readGradientOverlay(e, ctx)),
    patternOverlay: list(v.patternOverlay).map(e => readPatternOverlay(e, ctx)),
    stroke: list(v.stroke).map(e => readStrokeEffect(e, ctx)),
    blendClippedAsGroup: readBool(v.blendClippedAsGroup, d.blendClippedAsGroup),
    blendInteriorEffectsAsGroup: readBool(v.blendInteriorEffectsAsGroup, d.blendInteriorEffectsAsGroup),
    transparencyShapesLayer: readBool(v.transparencyShapesLayer, d.transparencyShapesLayer),
    layerMaskHidesEffects: readBool(v.layerMaskHidesEffects, d.layerMaskHidesEffects),
    vectorMaskHidesEffects: readBool(v.vectorMaskHidesEffects, d.vectorMaskHidesEffects),
    knockout: readEnum(v.knockout, KNOCKOUTS, 'none', ctx, 'styles.knockout'),
    blendIf: readBlendIf(v.blendIf, ctx),
  }
}

// ── Live shapes ──────────────────────────────────────────────────────────────

export function readLiveShape(v: unknown, ctx: Ctx): LiveShape | null {
  if (!isRecord(v)) return null
  const t = readEnum(v.type, ['rect', 'ellipse', 'polygon', 'line', 'custom'] as const, 'ellipse', ctx, 'liveShape.type')
  switch (t) {
    case 'rect': {
      const a = readArray(v.radii) ?? []
      const r = (i: number) => readRange(a[i], 0, 100000, 0, ctx, 'liveShape.radii')
      return { type: 'rect', radii: [r(0), r(1), r(2), r(3)] }
    }
    case 'polygon':
      return {
        type: 'polygon',
        sides: readInt(v.sides, 3, 1000, 5, ctx, 'liveShape.sides'),
        starRatio: v.starRatio === null || v.starRatio === undefined
          ? null : readRange(v.starRatio, 0, 1, 0.5, ctx, 'liveShape.starRatio'),
        radius: readRange(v.radius, 0, 1e6, 0, ctx, 'liveShape.radius'),
      }
    case 'line':
      return { type: 'line', thickness: readRange(v.thickness, 0, 1e4, 1, ctx, 'liveShape.thickness') }
    case 'custom':
      return { type: 'custom', presetId: readString(v.presetId, '', ctx, 'liveShape.presetId') }
    default:
      return { type: 'ellipse' }
  }
}

// ── Adjustments ──────────────────────────────────────────────────────────────

const ADJUSTMENT_KINDS: readonly AdjustmentKind[] = [
  'brightnessContrast', 'levels', 'curves', 'exposure', 'vibrance', 'hueSaturation',
  'colorBalance', 'blackAndWhite', 'photoFilter', 'channelMixer', 'colorLookup',
  'invert', 'posterize', 'threshold', 'gradientMap', 'selectiveColor',
]

export function isAdjustmentKind(v: unknown): v is AdjustmentKind {
  return typeof v === 'string' && (ADJUSTMENT_KINDS as readonly string[]).includes(v)
}

function readLevelsParams(v: unknown, ctx: Ctx): LevelsParams {
  const o = rec(v)
  return {
    lowInput: readRange(o.lowInput, 0, 1, 0, ctx, 'levels.lowInput'),
    highInput: readRange(o.highInput, 0, 1, 1, ctx, 'levels.highInput'),
    gamma: readRange(o.gamma, 0.1, 10, 1, ctx, 'levels.gamma'),
    lowOutput: readRange(o.lowOutput, 0, 1, 0, ctx, 'levels.lowOutput'),
    highOutput: readRange(o.highOutput, 0, 1, 1, ctx, 'levels.highOutput'),
    clampInput: readBool(o.clampInput, false),
    clampOutput: readBool(o.clampOutput, false),
  }
}

function readCurvePoints(v: unknown, ctx: Ctx): CurvePoints {
  const o = rec(v)
  const pts = list(o.points).map(p => {
    const q = rec(p)
    return {
      x: readRange(q.x, 0, 1, 0, ctx, 'curve.x'),
      y: readRange(q.y, 0, 1, 0, ctx, 'curve.y'),
      type: readEnum(q.type, ['smooth', 'corner'] as const, 'smooth', ctx, 'curve.type'),
    }
  })
  return { points: pts.length >= 2 ? pts : [{ x: 0, y: 0, type: 'smooth' }, { x: 1, y: 1, type: 'smooth' }] }
}

function readHSLBand(v: unknown, ctx: Ctx): HSLBand {
  const o = rec(v)
  const r = readArray(o.range)
  return {
    hue: readRange(o.hue, -180, 180, 0, ctx, 'hsl.hue'),
    saturation: readRange(o.saturation, -100, 100, 0, ctx, 'hsl.saturation'),
    lightness: readRange(o.lightness, -100, 100, 0, ctx, 'hsl.lightness'),
    range: r && r.length === 4
      ? [
          readNumber(r[0], 0, ctx, 'hsl.range'), readNumber(r[1], 0, ctx, 'hsl.range'),
          readNumber(r[2], 0, ctx, 'hsl.range'), readNumber(r[3], 0, ctx, 'hsl.range'),
        ]
      : null,
  }
}

const readTriple = (v: unknown, ctx: Ctx): RGBTriple => {
  const o = rec(v)
  return {
    cyanRed: readRange(o.cyanRed, -1, 1, 0, ctx, 'balance.cyanRed'),
    magentaGreen: readRange(o.magentaGreen, -1, 1, 0, ctx, 'balance.magentaGreen'),
    yellowBlue: readRange(o.yellowBlue, -1, 1, 0, ctx, 'balance.yellowBlue'),
  }
}

const readMixerRow = (v: unknown, ctx: Ctx, def: MixerRow): MixerRow => {
  const o = rec(v)
  return {
    r: readRange(o.r, -200, 200, def.r, ctx, 'mixer.r'),
    g: readRange(o.g, -200, 200, def.g, ctx, 'mixer.g'),
    b: readRange(o.b, -200, 200, def.b, ctx, 'mixer.b'),
    constant: readRange(o.constant, -200, 200, def.constant, ctx, 'mixer.constant'),
  }
}

const readCMYK = (v: unknown, ctx: Ctx): CMYKTriple => {
  const o = rec(v)
  return {
    cyan: readRange(o.cyan, -100, 100, 0, ctx, 'selective.cyan'),
    magenta: readRange(o.magenta, -100, 100, 0, ctx, 'selective.magenta'),
    yellow: readRange(o.yellow, -100, 100, 0, ctx, 'selective.yellow'),
    black: readRange(o.black, -100, 100, 0, ctx, 'selective.black'),
  }
}

/**
 * Reads an adjustment spec. Returns `null` when nothing usable is there, so the
 * caller can decide between "keep the raw payload aside" and "substitute a
 * neutral spec". Never throws.
 */
export function readAdjustment(v: unknown, ctx: Ctx): AdjustmentSpec | null {
  if (!isRecord(v) || !isAdjustmentKind(v.type)) return null
  const kind = v.type
  const d = defaultAdjustment(kind)
  switch (kind) {
    case 'brightnessContrast':
      return {
        type: kind,
        brightness: readRange(v.brightness, -150, 150, 0, ctx, 'brightness'),
        contrast: readRange(v.contrast, -50, 100, 0, ctx, 'contrast'),
        useLegacy: readBool(v.useLegacy, false),
      }
    case 'levels': {
      const ch = rec(v.channels)
      const keys: LevelsChannel[] = ['master', 'r', 'g', 'b']
      const channels = {} as Record<LevelsChannel, LevelsParams>
      for (const k of keys) channels[k] = readLevelsParams(ch[k], ctx)
      return { type: kind, channels }
    }
    case 'curves': {
      const ch = rec(v.channels)
      const keys: CurvesChannel[] = ['master', 'r', 'g', 'b', 'a']
      const channels = {} as Record<CurvesChannel, CurvePoints>
      for (const k of keys) channels[k] = readCurvePoints(ch[k], ctx)
      return { type: kind, channels }
    }
    case 'exposure':
      return {
        type: kind,
        exposure: readRange(v.exposure, -20, 20, 0, ctx, 'exposure'),
        offset: readRange(v.offset, -0.5, 0.5, 0, ctx, 'offset'),
        gammaCorrection: readRange(v.gammaCorrection, 0.01, 9.99, 1, ctx, 'gammaCorrection'),
      }
    case 'vibrance':
      return {
        type: kind,
        vibrance: readRange(v.vibrance, -100, 100, 0, ctx, 'vibrance'),
        saturation: readRange(v.saturation, -100, 100, 0, ctx, 'saturation'),
      }
    case 'hueSaturation': {
      const bandsRaw = readArray(v.bands)
      const dflt = d as Extract<AdjustmentSpec, { type: 'hueSaturation' }>
      return {
        type: kind,
        colorize: readBool(v.colorize, false),
        master: readHSLBand(v.master, ctx),
        bands: bandsRaw ? bandsRaw.map(b => readHSLBand(b, ctx)) : dflt.bands,
      }
    }
    case 'colorBalance':
      return {
        type: kind,
        shadows: readTriple(v.shadows, ctx),
        midtones: readTriple(v.midtones, ctx),
        highlights: readTriple(v.highlights, ctx),
        preserveLuminosity: readBool(v.preserveLuminosity, true),
      }
    case 'blackAndWhite': {
      const w = rec(v.weights)
      const dw = (d as Extract<AdjustmentSpec, { type: 'blackAndWhite' }>).weights
      return {
        type: kind,
        weights: {
          reds: readRange(w.reds, -200, 300, dw.reds, ctx, 'bw.reds'),
          yellows: readRange(w.yellows, -200, 300, dw.yellows, ctx, 'bw.yellows'),
          greens: readRange(w.greens, -200, 300, dw.greens, ctx, 'bw.greens'),
          cyans: readRange(w.cyans, -200, 300, dw.cyans, ctx, 'bw.cyans'),
          blues: readRange(w.blues, -200, 300, dw.blues, ctx, 'bw.blues'),
          magentas: readRange(w.magentas, -200, 300, dw.magentas, ctx, 'bw.magentas'),
        },
        tint: isRecord(v.tint) || typeof v.tint === 'string'
          ? readColor(v.tint, WHITE, ctx, 'bw.tint') : null,
      }
    }
    case 'photoFilter':
      return {
        type: kind,
        color: readColor(v.color, rgba(236, 138, 0), ctx, 'photoFilter.color'),
        density: readRange(v.density, 0, 100, 25, ctx, 'photoFilter.density'),
        preserveLuminosity: readBool(v.preserveLuminosity, true),
      }
    case 'channelMixer': {
      const o = rec(v.out)
      const dd = (d as Extract<AdjustmentSpec, { type: 'channelMixer' }>).out
      return {
        type: kind,
        monochrome: readBool(v.monochrome, false),
        out: {
          r: readMixerRow(o.r, ctx, dd.r),
          g: readMixerRow(o.g, ctx, dd.g),
          b: readMixerRow(o.b, ctx, dd.b),
          gray: readMixerRow(o.gray, ctx, dd.gray),
        },
      }
    }
    case 'colorLookup':
      return {
        type: kind,
        lutId: readString(v.lutId, '', ctx, 'colorLookup.lutId'),
        dither: readBool(v.dither, false),
        amount: readRange(v.amount, 0, 100, 100, ctx, 'colorLookup.amount'),
      }
    case 'invert':
      return { type: kind }
    case 'posterize':
      return { type: kind, levels: readInt(v.levels, 2, 255, 4, ctx, 'posterize.levels') }
    case 'threshold':
      return { type: kind, level: readInt(v.level, 1, 255, 128, ctx, 'threshold.level') }
    case 'gradientMap':
      return {
        type: kind,
        gradient: readGradient(v.gradient, ctx),
        reverse: readBool(v.reverse, false),
        dither: readBool(v.dither, false),
      }
    case 'selectiveColor': {
      const f = rec(v.families)
      const keys: SelectiveFamily[] = [
        'reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas', 'whites', 'neutrals', 'blacks',
      ]
      const families = {} as Record<SelectiveFamily, CMYKTriple>
      for (const k of keys) families[k] = readCMYK(f[k], ctx)
      return {
        type: kind,
        method: readEnum(v.method, ['relative', 'absolute'] as const, 'relative', ctx, 'selective.method'),
        families,
      }
    }
  }
}
