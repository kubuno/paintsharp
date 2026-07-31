// Public surface of the GPU filter stage.
//
// Consumers (the composite plan, the filter dialog, the worker router) should
// import from here only. Everything below is either data (the registry, the
// adjustment specs) or a pure function of it.

export type {
  GLDeviceLike, GpuProgram, GpuTexture, TextureFilter, TextureFormat, TextureOptions,
  TextureWrap, UniformMap, UniformValue,
} from './device'
export { QUAD_VERTEX_SHADER, TexturePool } from './device'

export type {
  FilterBackend, FilterParamDef, FilterResult, GpuFilterDef, GpuPass, LutData, ParamValues,
  PassContext, PassInput,
} from './types'
export { filterDefaults, param } from './types'

export { runGpuFilter, uploadLut } from './execute'
export type { RunOptions } from './execute'

export { GPU_FILTERS, filterCoverage, filtersByBackend, findGpuFilter, nonPortableFilters } from './registry'

export {
  BW_DEFAULT, CURVE_LUT_SIZE, LEVELS_IDENTITY, adjustmentLuts, adjustmentPass, adjustmentSpace,
  adjustmentImpl, applyAdjustmentPixel, buildCurveLut, isIdentityAdjustment,
  linearToOklabJS, oklabToLinearJS, rgbToHslJS, hslToRgbJS,
} from './adjustments'
export type {
  AdjustmentImpl, AdjustmentSpec, AdjustmentType, BWWeights, ColorSpaceMode, CurvePoints,
  LevelsParams, RGBTriple,
} from './adjustments'

export { MAX_TAPS, boxTaps, blurPasses, gaussianTaps, motionTaps, planGaussian } from './blur'
export type { GaussianPlan, GaussianTaps } from './blur'
export { highPassPasses, unsharpPasses } from './sharpen'
export type { UnsharpParams } from './sharpen'
export { noisePasses, diffusePasses } from './noise'
export type { NoiseParams } from './noise'
export { WebGL2Device } from './webgl2Device'
export { TestDevice } from './testDevice'
export type { RecordedDraw } from './testDevice'
