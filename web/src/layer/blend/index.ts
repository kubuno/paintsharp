// Public surface of the blend-mode module.
//
// `modes.ts`    — metadata table (ids, PSD keys, i18n keys, categories, uMode)
// `formulas.ts` — the TypeScript REFERENCE implementation (the oracle)
// `glsl.ts`     — the GLSL ES 3.00 twin, as injectable string fragments
//
// Algorithms derived from GIMP `app/operations/layer-modes/*` (GPLv3+) and the
// public PDF 1.7 §11.3.5 / PSD specifications. Kubuno is AGPLv3.

export {
  BLEND_MODES,
  BLEND_MODE_TABLE,
  BLEND_MODE_LIST,
  BLEND_CATEGORY_ORDER,
  BLEND_UMODE,
  COMPOSITE_OP_INT,
  ERASER_MODE_INT,
  LAYER_BLEND_MODES,
  asBlendMode,
  blendModeFromPsdKey,
  blendModeFromUMode,
  blendModesByCategory,
  isSeparable,
  psdKeyOf,
} from './modes.ts'
export type { BlendMode, BlendCategory, BlendModeInfo, CompositeOp } from './modes.ts'

export {
  BLEND_FN,
  EPSILON,
  LUM_B,
  LUM_G,
  LUM_R,
  SAFE_DIV_MAX,
  UNPREMUL_MAX,
  blendRGB,
  clipColor,
  compositePremultiplied,
  compositeStraight,
  dissolveAlpha,
  dissolveRand,
  dissolveSeedFromId,
  hash3,
  lum,
  safeDiv,
  sat,
  setLum,
  setSat,
  softLightD,
  unpremultiply,
} from './formulas.ts'
export type { BlendFn, PremultipliedPixel, RGB, StraightPixel } from './formulas.ts'

export {
  BLEND_GLSL_EXPR,
  GLSL_COMPOSITE,
  GLSL_DISSOLVE,
  GLSL_NON_SEPARABLE,
  GLSL_PRELUDE,
  GLSL_SEPARABLE,
  blendModeChunk,
  glslBlendDispatch,
  glslBlendSingle,
  glslModeDefines,
} from './glsl.ts'
