// Factory functions and Photoshop-parity defaults for every layer kind.
//
// Every factory returns a fully populated node: the model has no optional
// fields to guess at, which is what makes the round-trip test in `../schema/`
// meaningful and what keeps the renderer free of `?? default` noise.

import { uid } from '../../../uid.ts'
import { newLayerId } from './ids.ts'
import {
  MAT_IDENTITY,
  type AdjustmentKind,
  type AdjustmentLayer,
  type AdjustmentSpec,
  type ArtboardLayer,
  type BlendMode,
  type ContourSpec,
  type CurvePoints,
  type FillContent,
  type FillLayer,
  type GradientSpec,
  type GroupLayer,
  type HSLBand,
  type Layer,
  type LayerBase,
  type LayerId,
  type LayerLocks,
  type LayerMask,
  type LayerStyleStack,
  type LevelsParams,
  type RGBA,
  type RasterLayer,
  type RasterSurfaceRef,
  type RectI,
  type ShapeLayer,
  type SmartFilterStack,
  type SmartObjectLayer,
  type TextLayer,
  type TextLayerData,
  type VectorMask,
  type VectorPath,
} from '../types.ts'

/** Mint a fresh tile-store surface identifier. */
export function newSurfaceId(): string { return `s_${uid()}` }

export const rgba = (r: number, g: number, b: number, a = 255): RGBA => ({ r, g, b, a })

export const BLACK: RGBA = rgba(0, 0, 0)
export const WHITE: RGBA = rgba(255, 255, 255)

export function defaultLocks(): LayerLocks {
  return { transparency: false, pixels: false, position: false, nesting: false, all: false }
}

export function defaultContour(presetId = 'linear'): ContourSpec {
  return {
    points: [
      { x: 0, y: 0, corner: false },
      { x: 1, y: 1, corner: false },
    ],
    presetId,
  }
}

export function defaultGradient(): GradientSpec {
  return {
    colorStops: [
      { position: 0, color: BLACK, midpoint: 0.5, shape: 'linear' },
      { position: 1, color: WHITE, midpoint: 0.5, shape: 'linear' },
    ],
    opacityStops: [
      { position: 0, opacity: 255, midpoint: 0.5 },
      { position: 1, opacity: 255, midpoint: 0.5 },
    ],
    interpolation: 'rgb',
    presetId: null,
  }
}

export function defaultFillContent(): FillContent {
  return { type: 'solid', color: BLACK }
}

export function emptySurface(bounds: RectI, surfaceId = newSurfaceId()): RasterSurfaceRef {
  return { surfaceId, bounds: { ...bounds }, version: 0 }
}

/** A fully revealing mask, which is what "Add layer mask" produces. */
export function defaultLayerMask(bounds: RectI, surfaceId = newSurfaceId()): LayerMask {
  return {
    surface: emptySurface(bounds, surfaceId),
    enabled: true,
    inverted: false,
    linked: true,
    density: 255,
    feather: 0,
    outsideValue: 255,
    previewAsRubylith: false,
    rubylithColor: rgba(255, 0, 0, 128),
  }
}

export function defaultVectorMask(path: VectorPath): VectorMask {
  return { path, enabled: true, inverted: false, linked: true, density: 255, feather: 0 }
}

export function emptyPath(): VectorPath {
  return { subpaths: [], fillRule: 'nonzero' }
}

/** An empty style stack: present but contributing nothing. */
export function defaultStyleStack(): LayerStyleStack {
  return {
    enabled: true,
    scale: 1,
    dropShadow: [],
    innerShadow: [],
    outerGlow: null,
    innerGlow: null,
    bevelEmboss: null,
    satin: null,
    colorOverlay: [],
    gradientOverlay: [],
    patternOverlay: [],
    stroke: [],
    blendClippedAsGroup: true,
    blendInteriorEffectsAsGroup: false,
    transparencyShapesLayer: true,
    layerMaskHidesEffects: false,
    vectorMaskHidesEffects: false,
    knockout: 'none',
    blendIf: null,
  }
}

export function defaultSmartFilterStack(): SmartFilterStack {
  return { enabled: true, filters: [], mask: null }
}

// ── Adjustments ──────────────────────────────────────────────────────────────

const levelsIdentity = (): LevelsParams => ({
  lowInput: 0, highInput: 1, gamma: 1, lowOutput: 0, highOutput: 1,
  clampInput: false, clampOutput: false,
})

const curveIdentity = (): CurvePoints => ({
  points: [{ x: 0, y: 0, type: 'smooth' }, { x: 1, y: 1, type: 'smooth' }],
})

const hslBand = (range: [number, number, number, number] | null): HSLBand =>
  ({ hue: 0, saturation: 0, lightness: 0, range })

/** Photoshop's six default hue bands, in degrees (a, b, c, d handles). */
const PS_HUE_BANDS: [number, number, number, number][] = [
  [315, 345, 15, 45],   // reds
  [15, 45, 75, 105],    // yellows
  [75, 105, 135, 165],  // greens
  [135, 165, 195, 225], // cyans
  [195, 225, 255, 285], // blues
  [255, 285, 315, 345], // magentas
]

export function defaultAdjustment(kind: AdjustmentKind): AdjustmentSpec {
  switch (kind) {
    case 'brightnessContrast':
      return { type: 'brightnessContrast', brightness: 0, contrast: 0, useLegacy: false }
    case 'levels':
      return {
        type: 'levels',
        channels: {
          master: levelsIdentity(), r: levelsIdentity(),
          g: levelsIdentity(), b: levelsIdentity(),
        },
      }
    case 'curves':
      return {
        type: 'curves',
        channels: {
          master: curveIdentity(), r: curveIdentity(), g: curveIdentity(),
          b: curveIdentity(), a: curveIdentity(),
        },
      }
    case 'exposure':
      return { type: 'exposure', exposure: 0, offset: 0, gammaCorrection: 1 }
    case 'vibrance':
      return { type: 'vibrance', vibrance: 0, saturation: 0 }
    case 'hueSaturation':
      return {
        type: 'hueSaturation',
        colorize: false,
        master: hslBand(null),
        bands: PS_HUE_BANDS.map(r => hslBand([...r] as [number, number, number, number])),
      }
    case 'colorBalance':
      return {
        type: 'colorBalance',
        shadows: { cyanRed: 0, magentaGreen: 0, yellowBlue: 0 },
        midtones: { cyanRed: 0, magentaGreen: 0, yellowBlue: 0 },
        highlights: { cyanRed: 0, magentaGreen: 0, yellowBlue: 0 },
        preserveLuminosity: true,
      }
    case 'blackAndWhite':
      return {
        type: 'blackAndWhite',
        weights: { reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80 },
        tint: null,
      }
    case 'photoFilter':
      return { type: 'photoFilter', color: rgba(236, 138, 0), density: 25, preserveLuminosity: true }
    case 'channelMixer':
      return {
        type: 'channelMixer',
        monochrome: false,
        out: {
          r: { r: 100, g: 0, b: 0, constant: 0 },
          g: { r: 0, g: 100, b: 0, constant: 0 },
          b: { r: 0, g: 0, b: 100, constant: 0 },
          gray: { r: 40, g: 40, b: 20, constant: 0 },
        },
      }
    case 'colorLookup':
      return { type: 'colorLookup', lutId: '', dither: false, amount: 100 }
    case 'invert':
      return { type: 'invert' }
    case 'posterize':
      return { type: 'posterize', levels: 4 }
    case 'threshold':
      return { type: 'threshold', level: 128 }
    case 'gradientMap':
      return { type: 'gradientMap', gradient: defaultGradient(), reverse: false, dither: false }
    case 'selectiveColor': {
      const zero = () => ({ cyan: 0, magenta: 0, yellow: 0, black: 0 })
      return {
        type: 'selectiveColor',
        method: 'relative',
        families: {
          reds: zero(), yellows: zero(), greens: zero(), cyans: zero(), blues: zero(),
          magentas: zero(), whites: zero(), neutrals: zero(), blacks: zero(),
        },
      }
    }
  }
}

// ── Layer factories ──────────────────────────────────────────────────────────

export interface BaseInit {
  id?: LayerId
  name?: string
  visible?: boolean
  /** 0..255. */
  opacity?: number
  /** 0..255. */
  fillOpacity?: number
  blendMode?: BlendMode
  clipping?: boolean
}

export function layerBase(init: BaseInit = {}): LayerBase {
  return {
    id: init.id ?? newLayerId(),
    schemaVersion: NODE_SCHEMA_VERSION_DEFAULT,
    name: init.name ?? '',
    visible: init.visible ?? true,
    opacity: init.opacity ?? 255,
    fillOpacity: init.fillOpacity ?? 255,
    blendMode: init.blendMode ?? 'normal',
    clipping: init.clipping ?? false,
    layerMask: null,
    vectorMask: null,
    styles: null,
    smartFilters: null,
    locks: defaultLocks(),
    colorLabel: 'none',
    linkGroup: null,
    transform: MAT_IDENTITY,
  }
}

/**
 * Duplicated from `../schema/version.ts` on purpose: `defaults.ts` must stay
 * importable by the schema layer without creating an import cycle. The two are
 * kept in step by a unit test.
 */
export const NODE_SCHEMA_VERSION_DEFAULT = 2

export function createRasterLayer(
  bounds: RectI,
  init: BaseInit & { surfaceId?: string; isBackground?: boolean } = {},
): RasterLayer {
  const base = layerBase(init)
  const isBackground = init.isBackground ?? false
  // The Background layer is implicitly pinned and opaque (spec 8.1).
  if (isBackground) base.locks = { ...base.locks, position: true, transparency: true }
  return { ...base, kind: 'raster', surface: emptySurface(bounds, init.surfaceId), isBackground }
}

export function createGroup(children: Layer[] = [], init: BaseInit = {}): GroupLayer {
  // A freshly created group is pass-through, like Photoshop. Documents migrated
  // from v1 are deliberately NOT: see `../schema/migrate.ts`.
  return {
    ...layerBase({ blendMode: 'pass-through', ...init }),
    kind: 'group',
    children,
    expanded: true,
    isolated: false,
    knockout: 'none',
  }
}

export function createAdjustmentLayer(
  kind: AdjustmentKind,
  bounds: RectI,
  init: BaseInit = {},
): AdjustmentLayer {
  return {
    ...layerBase(init),
    kind: 'adjustment',
    adjustment: defaultAdjustment(kind),
    // Photoshop always gives an adjustment layer a (white) mask; the UI relies
    // on it being present.
    layerMask: defaultLayerMask(bounds),
  }
}

export function createFillLayer(
  fill: FillContent,
  init: BaseInit = {},
): FillLayer {
  return { ...layerBase(init), kind: 'fill', fill }
}

export function defaultTextData(): TextLayerData {
  return {
    content: '',
    runs: [],
    paragraphs: [],
    mode: 'point',
    box: null,
    orientation: 'horizontal',
    warp: null,
    pathId: null,
    version: 0,
  }
}

export function createTextLayer(text: Partial<TextLayerData> = {}, init: BaseInit = {}): TextLayer {
  return {
    ...layerBase(init),
    kind: 'text',
    text: { ...defaultTextData(), ...text },
    raster: null,
  }
}

export function createShapeLayer(path: VectorPath, init: BaseInit = {}): ShapeLayer {
  return {
    ...layerBase(init),
    kind: 'shape',
    path,
    fill: defaultFillContent(),
    stroke: null,
    liveShape: null,
    raster: null,
  }
}

export function createSmartObjectLayer(
  source: SmartObjectLayer['source'],
  sourceSize: { w: number; h: number },
  init: BaseInit = {},
): SmartObjectLayer {
  return {
    ...layerBase(init),
    kind: 'smartObject',
    source,
    sourceSize: { ...sourceSize },
    interpolation: 'bicubic',
    raster: null,
    smartFilters: defaultSmartFilterStack(),
  }
}

export function createArtboard(frame: RectI, children: Layer[] = [], init: BaseInit = {}): ArtboardLayer {
  return {
    ...layerBase(init),
    kind: 'artboard',
    frame: { ...frame },
    children,
    expanded: true,
    background: { type: 'solid', color: WHITE },
    presetName: null,
  }
}
