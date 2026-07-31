// Minimal GPU surface the tiling stage depends on.
//
// The tiling stage (stage 2) must never talk to WebGL directly: stage 4
// (`renderer/gl/GLDevice`) owns every `gl.*` call. This file therefore declares
// only the four things tiles actually need — allocate a texture, free it, write
// a rect of pixels into it, bind it as a render target — plus a scissor hook so
// a tile rebuild can be restricted to its dirty chunks.
//
// Two consequences, both intentional:
//   1. The real `GLDevice` satisfies this interface structurally; nothing here
//      needs to import it, so both stages can be written in parallel.
//   2. Every class in this folder is unit-testable under plain Node against a
//      test double, with no WebGL context and no DOM.

import type { Rect } from './geometry'

/**
 * Opaque GPU texture handle. In production this is a `WebGLTexture` (an object);
 * in tests it is any object identity. Declared as `object` rather than `any` so
 * that no property can be read from it outside the device.
 */
export type DeviceTexture = object

export interface TextureDesc {
  width: number
  height: number
  /** Optional debug label; devices may ignore it. */
  label?: string
}

/** The subset of the GPU device that the tiling stage is allowed to use. */
export interface GLDeviceLike {
  /** Bytes occupied by one texel in the working format (8 for RGBA16F, 4 for RGBA8). */
  readonly bytesPerTexel: number

  /** Allocate a texture. Implementations may recycle internally. */
  createTexture(desc: TextureDesc): DeviceTexture

  /** Release a texture. Must tolerate being called once per texture, never twice. */
  deleteTexture(tex: DeviceTexture): void

  /**
   * Upload pixels into `rect` of `tex`. `pixels === null` means "clear this rect
   * to fully transparent", which is how a freshly allocated tile is initialised
   * without allocating a document-sized zero buffer on the CPU.
   */
  writeTextureRect(tex: DeviceTexture, rect: Rect, pixels: ArrayBufferView | null): void

  /** Bind `tex` as the current render target; `null` restores the default one. */
  bindRenderTarget(tex: DeviceTexture | null): void

  /** Restrict subsequent writes to `rect` (in target texel space); `null` disables. */
  setScissor(rect: Rect | null): void
}

/** Monotonic millisecond clock. Injectable so tests are deterministic. */
export type Clock = () => number

export const defaultClock: Clock = () =>
  (typeof performance !== 'undefined' && typeof performance.now === 'function')
    ? performance.now()
    : Date.now()
