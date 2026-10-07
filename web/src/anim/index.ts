// Public surface of the shared animated-image library.
//
// This directory is a LIBRARY: no React, no `@kubuno/*`, no UI, and no import
// from any sibling sub-module's private folder. Layer, Keyframe and Motion all
// consume it as equals — which is why it lives at `src/anim/` and not under one
// of them. It is testable without a DOM and runs unchanged in a Web Worker;
// the two places that genuinely need the platform (WebP still encoding and
// decoding) take an injectable backend.

// ── Model ───────────────────────────────────────────────────────────────────
export type {
  AnimDoc,
  AnimFrame,
  AnimInfo,
  AnimSource,
  ApngEncodeOptions,
  Blend,
  CommonEncodeOptions,
  DecodeOptions,
  Disposal,
  DitherKind,
  EncodePhase,
  FormatCaps,
  GifEncodeOptions,
  Palette,
  PaletteMode,
  QuantizerKind,
  Rect,
  RgbaImage,
  WebpEncodeOptions,
} from './types.ts'
export { APNG_CAPS, GIF_CAPS, WEBP_CAPS, animDurationMs, emptyRect, playbackDelayMs } from './types.ts'

// ── Compositing ─────────────────────────────────────────────────────────────
export {
  clipRect,
  cloneImage,
  composite,
  compositeIter,
  createCanvas,
  drawFrame,
  flatten,
} from './compositor.ts'
export { applyCommonOptions, normaliseLoop, resolveForTarget } from './resolve.ts'
export { alignRect, diffRect, planFrames, unionRect, type FramePlan } from './optimize.ts'

// ── Decoding ────────────────────────────────────────────────────────────────
export { decodeAnimation, probeAnimation, sniffFormat, toBytes, type DecodeDeps, type SniffedFormat } from './decode.ts'
export { decodeGif, probeGif, isGif } from './gif/index.ts'
export { decodeApng, probeApng, isPng } from './apng/index.ts'
export { decodeWebp, probeWebp, isWebp, parseWebpContainer, type StillDecoder } from './webp/index.ts'

// ── Encoding ────────────────────────────────────────────────────────────────
export { encodeGif } from './gif/index.ts'
export { encodeApng } from './apng/index.ts'
export { encodeWebpAnim, probeWebpEncoding, type StillEncoder } from './webp/index.ts'
export { encodeAnimation, encodeAnimationBytes, MIME, type EncodeOptions } from './encode.ts'

// ── Quantisation (exposed for previews and tests) ───────────────────────────
export {
  BAYER8,
  buildHistogram,
  buildPalette,
  ditherToIndices,
  exactColors,
  ExactMapper,
  medianCutPalette,
  NearestCache,
  octreePalette,
  paletteError,
  type BuiltPalette,
  type ColorMapper,
  type PaletteBuildOptions,
} from './quantize/index.ts'

// ── Runtime capabilities ────────────────────────────────────────────────────
export { animCaps, canDecodeNatively, resetAnimCaps, type AnimCaps } from './caps.ts'
export { setZlibCodec, type ZlibCodec } from './apng/zlib.ts'
