// Stage 1 (GPU abstraction) — public surface of the new Layer render engine's
// GL floor. This is the ONLY module upper stages import from; everything they
// need to drive the GPU is re-exported here.
//
// Confinement rule (spec §13.4): no `gl.*` call may exist outside this folder.
// Mechanical check:
//   grep -rn "\bgl\." frontend/src/layer/renderer --exclude-dir=gl   → empty
// To be wired as an ESLint `no-restricted-syntax` rule on
// `MemberExpression[object.name="gl"]` for `src/layer/renderer/**` with an
// exception for `src/layer/renderer/gl/**`.
//
// This engine lives ALONGSIDE the current one (layer/renderer/{shaders,glUtils}.ts,
// LayerEditorPage) — the switchover is a separate, later step.

export {
  BLEND_ADD,
  BLEND_OVER_PREMULTIPLIED,
  GLBuffer,
  GLDevice,
  GLVertexArray,
  QUAD_ATTRIB,
  QUAD_VERT,
  type BlendEquation,
  type BlendFactor,
  type BlendState,
  type BufferTarget,
  type BufferUsage,
  type GLDeviceOptions,
  type PassOptions,
  type ScissorRect,
  type VertexAttribSpec,
} from './GLDevice'

export {
  describeCaps,
  detectCapabilities,
  probeRenderable,
  probeWorkingFormat,
  textureFormatInfo,
  workingTextureFormat,
  type CapabilityOptions,
  type GLCaps,
  type TextureFormat,
  type TextureFormatInfo,
  type WorkingFormat,
} from './capabilities'

export {
  GLSL_COLOR_SPACE,
  GLSL_DITHER,
  WORKING_TRC,
  configureOutputColorSpace,
  displayIsWideGamut,
  hexToLinearPremultiplied,
  linearPremultipliedToSrgbU8,
  linearToSrgb,
  linearToSrgbU8,
  premultiplyInPlace,
  srgbToLinear,
  srgbToLinearLut,
  srgbU8ToLinearPremultiplied,
  unpremultiplyInPlace,
  type OutputColorSpaceResult,
} from './colorSpace'

export {
  GLProgram,
  composeSource,
  type DefineValue,
  type ProgramOptions,
  type UniformInfo,
  type UniformValue,
} from './Program'

export {
  GLTexture,
  floatToHalf,
  fromHalfArray,
  halfToFloat,
  toHalfArray,
  type TextureFilter,
  type TextureOptions,
  type TexturePixels,
  type TextureUploadRegion,
  type TextureWrap,
} from './Texture'

export {
  FramebufferPool,
  GLFramebuffer,
  type FramebufferOptions,
  type ReadRect,
} from './Framebuffer'

export {
  RESOURCE_KINDS,
  ResourceTracker,
  emptyInventory,
  type GLResource,
  type ResourceInventory,
  type ResourceKind,
} from './resources'
