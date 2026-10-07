// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Camera RAW — embedded preview extraction (spec 07 §5.3).
//
// The honest scope, stated once: a RAW file is a container of sensor measurements, and
// turning those into a picture requires decoding a per-manufacturer compressed stream
// (Canon lossless JPEG, Nikon Huffman, Sony ARW2 delta, Fuji X-Trans…). That is the wall,
// and it is not crossable in TypeScript at a maintainable cost — LibRaw carries model
// quirks for 1200+ bodies. NO WebAssembly is used here, by deliberate decision.
//
// What IS crossable, for ~7 KiB and zero dependencies: every RAW embeds at least one
// JPEG preview, and the largest one is very often full resolution — already developed by
// the camera (white balance, colour matrix, tone curve, sharpening), in sRGB, looking
// the way the manufacturer intended. That covers the real use case ("open my photo to
// retouch it") and is what the file browser and the camera's own screen display.

import { ImportWarningSink, importWarn } from '../types'
import { scanJpegStreams } from './jpegScan'
import {
  ifdCandidates,
  perFormatCandidates,
  type PreviewCandidate,
  type RawFormatId,
} from './perFormat'
import { readOrientation, readRawTiffHeader, sensorSize, sweepIfds, type IfdSweep } from './tiff'

export type { RawFormatId, PreviewCandidate }

export interface EmbeddedPreview {
  /** The JPEG payload, ready for `createImageBitmap`. */
  readonly bytes: Uint8Array
  readonly width?: number
  readonly height?: number
  /** Where it was found: `'CR2 IFD0/StripOffsets'`, `'byte scan'`… */
  readonly source: string
  /** EXIF orientation 1..8, to be applied when compositing. */
  readonly orientation: number
  /** Sensor dimensions, when the file advertises them. */
  readonly sensor?: { readonly width: number; readonly height: number }
}

export interface PreviewSearch {
  readonly candidates: readonly PreviewCandidate[]
  readonly orientation: number
  readonly sensor?: { readonly width: number; readonly height: number }
  readonly sweep: IfdSweep | null
}

/**
 * Runs the three passes and returns every candidate, best first.
 *
 * Kept separate from `findLargestPreview` so it is testable without a DOM: no
 * `createImageBitmap`, no canvas, pure bytes in and out.
 */
export function searchPreviews(bytes: Uint8Array, format: RawFormatId): PreviewSearch {
  let sweep: IfdSweep | null = null
  let orientation = 1
  let sensor: { width: number; height: number } | undefined

  const header = readRawTiffHeader(bytes)
  if (header) {
    try {
      sweep = sweepIfds(bytes, header)
      orientation = readOrientation(sweep)
      sensor = sensorSize(sweep)
    } catch {
      sweep = null
    }
  }

  const seen = new Set<number>()
  const all: PreviewCandidate[] = []
  const add = (c: PreviewCandidate): void => {
    if (seen.has(c.offset)) return
    seen.add(c.offset)
    all.push(c)
  }

  // Pass 1: the format-specific shortcut — fast and exact when it applies.
  for (const c of perFormatCandidates(bytes, format, sweep)) add(c)
  // Pass 2: the standard IFD tags, which cover NEF, ARW, DNG and every generic TIFF RAW.
  if (sweep) for (const c of ifdCandidates(bytes, sweep)) add(c)
  // Pass 3: brute-force SOI/EOI scan. Crude, and what rescues an unknown camera body —
  // but strictly a LAST RESORT. A lossy DNG stores its sensor data as baseline-JPEG
  // tiles, and those tiles look exactly like previews to a byte scan; running the scan
  // alongside the declared tags would routinely import a 304×352 sensor tile instead of
  // the real picture (measured on Skia's `sample_1mp.dng`).
  if (all.length === 0) {
    for (const c of scanJpegStreams(bytes)) {
      add({ offset: c.offset, length: c.length, source: 'byte scan', width: c.width, height: c.height })
    }
  }

  // Largest picture first; unknown dimensions fall back to byte length, which correlates
  // well enough to order a thumbnail behind a full-size preview. Candidates whose aspect
  // ratio contradicts the sensor's are pushed to the back rather than dropped: they are
  // almost always sensor tiles, but a cropped in-camera preview is legitimate too.
  const candidates = [...all].sort(
    (a, b) => plausible(b, sensor) - plausible(a, sensor) || area(b) - area(a) || b.length - a.length,
  )
  return { candidates, orientation, sensor, sweep }
}

function area(c: PreviewCandidate): number {
  return c.width && c.height ? c.width * c.height : c.length
}

/** 1 when the candidate's shape is consistent with the sensor, 0 when it contradicts it. */
function plausible(
  c: PreviewCandidate,
  sensor: { width: number; height: number } | undefined,
): number {
  if (!sensor || !c.width || !c.height) return 1
  const want = sensor.width / sensor.height
  const got = c.width / c.height
  // 25 % tolerance absorbs 3:2 vs 16:9 in-camera crops without accepting a transposition.
  return Math.abs(Math.log(got / want)) < 0.25 ? 1 : 0
}

/** Validates a candidate by actually decoding it. `undefined` when no decoder is available. */
export type PreviewValidator = (bytes: Uint8Array) => Promise<boolean>

/**
 * Picks the best usable preview.
 *
 * `validate` really decodes each candidate, largest first: a blob is never handed on
 * unverified, because a wrong offset yields bytes that look like a JPEG and are not one.
 * Callers without a decoder (tests, Node) pass `undefined` and get the best candidate on
 * structural grounds alone.
 */
export async function findLargestPreview(
  bytes: Uint8Array,
  format: RawFormatId,
  warn: ImportWarningSink,
  validate?: PreviewValidator,
): Promise<EmbeddedPreview | null> {
  const search = searchPreviews(bytes, format)
  // Trying every candidate on a pathological file would mean dozens of full decodes.
  const tryable = search.candidates.slice(0, 8)

  for (const c of tryable) {
    const payload = bytes.subarray(c.offset, c.offset + c.length)
    if (validate) {
      let ok = false
      try {
        ok = await validate(payload)
      } catch {
        ok = false
      }
      if (!ok) continue
    }
    const preview: EmbeddedPreview = {
      bytes: payload,
      width: c.width,
      height: c.height,
      source: c.source,
      orientation: search.orientation,
      sensor: search.sensor,
    }
    warnIfSmall(preview, warn)
    return preview
  }
  return null
}

/**
 * A preview covering less than a quarter of the sensor area is a thumbnail, not a
 * picture: the user must be told before they start retouching it.
 */
function warnIfSmall(preview: EmbeddedPreview, warn: ImportWarningSink): void {
  const { width, height, sensor } = preview
  if (!width || !height || !sensor) return
  if (width * height >= sensor.width * sensor.height * 0.25) return
  warn.warn(
    importWarn('raw.preview-smaller-than-sensor', {
      width,
      height,
      sensorWidth: sensor.width,
      sensorHeight: sensor.height,
    }),
  )
}
