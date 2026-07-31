/*
 * Public PSD/PSB API for Paintsharp Layer.
 *
 * The binary layout and the decoding/encoding algorithms implemented in this
 * directory were derived from the GIMP PSD plug-in (file-psd), Copyright 2007
 * John Marshall, licensed under the GNU General Public License v3 or later, and
 * from Adobe's public "Photoshop File Formats Specification". This is an
 * independent TypeScript re-implementation; no GIMP source code was copied.
 * Kubuno is distributed under the AGPLv3, which is compatible with the GPLv3.
 *
 * See NOTICE.md for the per-file attribution table.
 *
 * ⚠️ This directory must stay PURELY ALGORITHMIC so it can run inside a Web
 * Worker: no React, no `@ui`, no `@kubuno/sdk`, no `t()`. Warnings travel as
 * machine codes and are localised by the page.
 *
 * ⚠️ `readPsd` / `writePsd` are ASYNCHRONOUS, on purpose and unavoidably:
 * `DecompressionStream` / `CompressionStream` are the only zlib available in a
 * browser and they are stream-based. `readPsdStructure()` is the synchronous
 * complement — it parses everything except the pixels.
 */

export { readPsd, readPsdStructure } from './read/readPsd.ts'
export { writePsd } from './write/writePsd.ts'
export { psdToKubuno, type KubunoImport, type PlacedPixels } from './map/psdToKubuno.ts'
export { kubunoToPsd, type KubunoExport } from './map/kubunoToPsd.ts'

export {
  PSD_TO_KUBUNO,
  KUBUNO_TO_PSD,
  psdBlendToKubuno,
  kubunoBlendToPsd,
} from './map/blendModes.ts'

export { buildLayerTree, walkLayers, countLayers } from './read/tree.ts'
export { alphaBounds, maskBounds, cropRgba, cropGray, splitRgba } from './write/bounds.ts'
export { placeIntoCanvas, channelsToRgba8, planesToRgba8 } from './color/convert.ts'
export { expandTo8 } from './color/depth.ts'

export { readDescriptor, readKey } from './descriptor/read.ts'
export { writeDescriptor, writeKey } from './descriptor/write.ts'
export type { Descriptor, DescriptorValue, RefItem, UnitId } from './descriptor/types.ts'

export { ByteReader } from './binary/ByteReader.ts'
export { ByteWriter } from './binary/ByteWriter.ts'

export { decodePackBits, encodePackBits, packBitsWorstCase } from './compression/packbits.ts'
export {
  undoPredictor,
  undoPredictor8,
  undoPredictor16,
  undoPredictor32,
} from './compression/predictor.ts'
export { inflateZlib, deflateZlib, zipAvailable, deflateAvailable } from './compression/zip.ts'
export { decodeChannel, encodeChannelRle, rowBytesFor } from './compression/index.ts'

export { PsdError, isPsdError, type PsdErrorCode } from './errors.ts'
export { LIMITS, PSB_64BIT_KEYS, PSD_COLOR_TAGS, COLOR_MODE, CHANNEL_ID } from './constants.ts'

export type {
  PsdDocument,
  PsdLayer,
  PsdMask,
  PsdChannel,
  PsdRect,
  PsdImage,
  PsdImageResource,
  PsdRawBlock,
  PsdGlobalMask,
  PsdWarning,
  PsdWarningCode,
  PsdColorMode,
  PsdDepth,
  PsdVersion,
  ReadOptions,
  WriteOptions,
  ReadPhase,
  WritePhase,
} from './types.ts'

export { rectWidth, rectHeight } from './types.ts'
