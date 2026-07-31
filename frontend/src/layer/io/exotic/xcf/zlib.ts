// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Defensive path only: GIMP marks COMPRESS_ZLIB as `/* unused */` and no released
// version writes it. Implementing it costs nothing, so a file produced by a patched or
// future GIMP opens instead of failing.
//
// No npm dependency is needed: the Compression Streams API's `'deflate'` algorithm IS
// the zlib container of RFC 1950 (`'deflate-raw'` would be the bare RFC 1951 stream, and
// XCF stores the former). Available since Chrome 80, Firefox 113 and Safari 16.4 — below
// every target of this project.

/** Cap on one inflated tile: 64×64 pixels × 8 bytes/pixel, with generous headroom. */
const MAX_INFLATED_TILE = 64 * 64 * 8 * 4

export async function inflateZlib(src: Uint8Array): Promise<Uint8Array> {
  const DS = (globalThis as { DecompressionStream?: typeof DecompressionStream }).DecompressionStream
  if (!DS) throw new Error('DecompressionStream is unavailable')
  // `src` is a view into the whole file; copy the slice so the Blob owns exactly it.
  const stream = new Blob([src.slice()]).stream().pipeThrough(new DS('deflate'))
  const buf = await new Response(stream).arrayBuffer()
  if (buf.byteLength > MAX_INFLATED_TILE) {
    throw new Error(`inflated tile of ${buf.byteLength} bytes exceeds the tile ceiling`)
  }
  return new Uint8Array(buf)
}
