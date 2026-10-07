/*
 * PSD/PSB file header (spec §1.2).
 *
 * Derived from the GIMP PSD plug-in (file-psd), Copyright 2007 John Marshall,
 * licensed under the GNU General Public License v3 or later — `read_header()`
 * in psd-load.c — and from Adobe's public "Photoshop File Formats
 * Specification". Independent TypeScript re-implementation; no GIMP source code
 * was copied. Kubuno is AGPLv3, compatible with the GPLv3 (GPLv3 §13).
 */
import type { ByteReader } from '../binary/ByteReader.ts'
import { PsdError } from '../errors.ts'
import {
  COLOR_MODE,
  KNOWN_COLOR_MODES,
  LIMITS,
  MAX_DIMENSION_PSB,
  MAX_DIMENSION_PSD,
  PSD_SIGNATURE,
} from '../constants.ts'
import type { PsdColorMode, PsdDepth, PsdVersion, WarningSink } from '../types.ts'

export interface PsdHeader {
  readonly version: PsdVersion
  readonly channels: number
  readonly height: number
  readonly width: number
  readonly depth: PsdDepth
  readonly colorMode: PsdColorMode
}

/**
 * The header is the ONLY section whose failure is fatal: without it there is
 * nothing to interpret (spec §9.4).
 */
export function readHeader(r: ByteReader, sink: WarningSink): PsdHeader {
  if (r.remaining < 26) throw new PsdError('NOT_A_PSD', { size: r.remaining })
  const sig = r.ascii(4)
  if (sig !== PSD_SIGNATURE) throw new PsdError('NOT_A_PSD', { signature: sig })

  const version = r.u16()
  if (version !== 1 && version !== 2) throw new PsdError('BAD_VERSION', { version })

  // The 6 reserved bytes must be zero; GIMP does not check them, nor do we.
  r.skip(6)

  const channels = r.u16()
  const height = r.u32()
  const width = r.u32()
  const depth = r.u16()
  const colorMode = r.u16()

  if (channels < 1 || channels > LIMITS.MAX_CHANNELS_PER_LAYER) {
    throw new PsdError('BAD_CHANNEL_COUNT', { channels })
  }
  if (depth !== 1 && depth !== 8 && depth !== 16 && depth !== 32) {
    throw new PsdError('BAD_DEPTH', { depth })
  }
  if (!KNOWN_COLOR_MODES.has(colorMode)) throw new PsdError('BAD_COLOR_MODE', { colorMode })
  // CMYK and Lab only ever exist in 8- or 16-bit form.
  if ((colorMode === COLOR_MODE.CMYK || colorMode === COLOR_MODE.LAB) && depth !== 8 && depth !== 16) {
    throw new PsdError('BAD_DEPTH_FOR_MODE', { colorMode, depth })
  }
  if (colorMode === COLOR_MODE.BITMAP && depth !== 1) {
    throw new PsdError('BAD_DEPTH_FOR_MODE', { colorMode, depth })
  }

  if (width < 1 || height < 1) throw new PsdError('BAD_DIMENSIONS', { width, height })

  // Adobe's ceilings are advisory here: refusing a file Photoshop would open is
  // worse than opening it, so we only warn until MAX_PIXELS is exceeded.
  const adobeMax = version === 1 ? MAX_DIMENSION_PSD : MAX_DIMENSION_PSB
  if (width > adobeMax || height > adobeMax) {
    sink.warn('unknown-blocks-preserved', { oversize: `${width}x${height}` }, 'info')
  }
  if (width * height > LIMITS.MAX_PIXELS) {
    throw new PsdError('TOO_LARGE', { width, height, max: LIMITS.MAX_PIXELS })
  }

  return {
    version: version as PsdVersion,
    channels,
    height,
    width,
    depth: depth as PsdDepth,
    colorMode: colorMode as PsdColorMode,
  }
}
