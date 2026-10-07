// Selection outline tracing ("marching ants" path).
// Extracted verbatim from LayerEditorPage during the layer/ refactor.

/**
 * Trace the outline of a selection mask (threshold 128) into a doc-space Path2D.
 * Horizontal / vertical boundary edges are merged into runs so the path stays
 * small enough to stroke every ants-animation frame even on large selections.
 */
export function buildSelOutline(m: Uint8Array, w: number, h: number): Path2D {
  const path = new Path2D()
  const inside = (x: number, y: number) => x >= 0 && x < w && y >= 0 && y < h && m[y * w + x] >= 128
  // Horizontal edges (top & bottom of inside cells), merged into runs.
  for (let y = 0; y <= h; y++) {
    let run = -1
    for (let x = 0; x <= w; x++) {
      const edge = x < w && (inside(x, y) !== inside(x, y - 1))
      if (edge && run < 0) run = x
      else if (!edge && run >= 0) { path.moveTo(run, y); path.lineTo(x, y); run = -1 }
    }
  }
  // Vertical edges (left & right of inside cells).
  for (let x = 0; x <= w; x++) {
    let run = -1
    for (let y = 0; y <= h; y++) {
      const edge = y < h && (inside(x, y) !== inside(x - 1, y))
      if (edge && run < 0) run = y
      else if (!edge && run >= 0) { path.moveTo(x, run); path.lineTo(x, y); run = -1 }
    }
  }
  return path
}
