/*
 * PSD/PSB header writer (spec §8.2 step 1).
 *
 * Derived from the GIMP PSD plug-in (file-psd), Copyright 2007 John Marshall,
 * GPLv3+ — `save_header()` in psd-export.c — and from Adobe's public "Photoshop
 * File Formats Specification". Independent TypeScript re-implementation; no
 * GIMP source was copied. Kubuno is AGPLv3.
 */
import type { ByteWriter } from '../binary/ByteWriter.ts'
import { COLOR_MODE, PSD_SIGNATURE } from '../constants.ts'
import type { PsdVersion } from '../types.ts'

/**
 * Kubuno always writes RGB / 8 bits: it is the mode every tool reads, and it
 * matches the internal model exactly (spec §2.3 "P0").
 */
export function writeHeader(
  w: ByteWriter,
  version: PsdVersion,
  channels: number,
  width: number,
  height: number,
): void {
  w.ascii(PSD_SIGNATURE, 4)
  w.u16(version)
  w.zeros(6) // reserved
  w.u16(channels)
  w.u32(height) // rows first
  w.u32(width)
  w.u16(8) // depth
  w.u16(COLOR_MODE.RGB)
}
