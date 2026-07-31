# NOTICE — PSD/PSB codec attribution

Kubuno Paintsharp is distributed under the **GNU Affero General Public License
v3** (AGPLv3).

The PSD/PSB codec in this directory is an **independent TypeScript
re-implementation**. Its binary layout knowledge and its decoding/encoding
algorithms were derived from two sources:

1. **The GIMP PSD plug-in** (`plug-ins/file-psd`), Copyright © 2007 John
   Marshall and the GIMP contributors, licensed under the **GNU General Public
   License v3 or later**.
2. **Adobe's public "Photoshop File Formats Specification"** (documentation).

**No GIMP source code was copied.** Every function here was written from scratch
in TypeScript; the GIMP sources were consulted as a reference for the binary
layout, for the quirks the specification does not document, and for the
recovery behaviour on malformed files.

AGPLv3 is compatible with GPLv3 (GPLv3 §13), so a work derived from GPLv3 code
may be distributed under the AGPLv3.

## Per-file attribution

| Kubuno file | GIMP reference |
|---|---|
| `compression/packbits.ts` | `psd-util.c` — `decode_packbits()`, `encode_packbits()` |
| `compression/predictor.ts` | `psd-load.c` — `PSD_COMP_ZIP_PRED` block, `decode_32_bit_predictor()` |
| `compression/zip.ts` | `psd-load.c` — `PSD_COMP_ZIP` block |
| `compression/index.ts` | `psd-load.c` — `read_channel_data()` |
| `binary/ByteReader.ts`, `binary/strings.ts` | `psd-util.c` — `fread_pascal_string()`, `fread_unicode_string()` |
| `binary/ByteWriter.ts` | `psd-export.c` — placeholder/patch positions + `g_seekable_seek` |
| `descriptor/read.ts`, `descriptor/write.ts` | `psd-util.c` — `parse_descriptor()`, `load_descriptor()`, `load_type()`, `load_key()` |
| `map/blendModes.ts` | `psd-util.c` — `layer_mode_map[]`, `descriptor_mode_map[]` |
| `read/header.ts` | `psd-load.c` — `read_header()` |
| `read/imageResources.ts` | `psd-image-res-load.c` — `get_image_resource_header()`, `load_image_resource()` |
| `read/layerAndMask.ts`, `read/layerRecord.ts` | `psd-load.c` — `read_layer_block()`, `read_layer_info()` |
| `read/colorModeData.ts` | `psd-load.c`, `psd.h` — `psd-duotone-data` parasite |
| `read/imageData.ts` | `psd-load.c` — merged-image handling |
| `read/tree.ts`, `additional/common.ts` | `psd-layer-res-load.c` — `load_layer_resource()`, `load_resource_lsct()`; `psd-util.c` — `psd_to_gimp_layer_color_tag()` |
| `color/depth.ts` | `psd-load.c` — `convert_1_bit()` |
| `color/convert.ts` | `psd-load.c` — CMYK/Lab handling |
| `write/*.ts` | `psd-export.c` — `save_header()`, `save_resources()`, `save_layer_and_mask()`, `save_data()` |
| `constants.ts` | `psd.h` — `MAX_CHANNELS`, `PSDCompressMode`, `MaskFlags`; `psd-layer-res-load.c` — 64-bit key list |

## Third-party formats

The 32-bit ZIP predictor is a byte-planar scheme also described in **TIFF
Technical Note 3**.
