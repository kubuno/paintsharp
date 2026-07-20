// Vertex editor — professional sculpt engine.
// Pure array math (no three.js import): every function works in the mesh's
// LOCAL space on raw position/index buffers, so the whole engine is unit-testable
// headlessly (node --experimental-strip-types) without WebGL.
//
// Provides:
//  - falloff curves (Blender-style)
//  - 14 brush bases (draw/clay/layer/inflate/crease/pinch/smooth/flatten/
//    scrape/fill/grab/snakehook/nudge/twist) driven by one dab dispatcher
//  - a stroke state (origin snapshot, grab sets, spacing accumulator)
//  - dyntopo: local edge-bisection refinement + guarded short-edge collapse,
//    plus whole-mesh flood refine and dead-vertex compaction

// ── Types ─────────────────────────────────────────────────────────────────────
export type BrushBase =
  | 'draw' | 'clay' | 'layer' | 'inflate' | 'crease' | 'pinch'
  | 'smooth' | 'flatten' | 'scrape' | 'fill'
  | 'grab' | 'snakehook' | 'nudge' | 'twist'

export type FalloffKind = 'smooth' | 'sphere' | 'root' | 'sharp' | 'linear' | 'constant'

export interface BrushSettings {
  radius:           number        // world units
  strength:         number        // 0..1
  falloff:          FalloffKind
  spacing:          number        // dab spacing as a fraction of radius (dab brushes)
  pressureRadius:   boolean       // pen pressure scales the radius
  pressureStrength: boolean       // pen pressure scales the strength
}

export interface BrushDef {
  id:       string
  base:     BrushBase
  builtin:  boolean
  name?:    string                // custom brushes carry their own display name
  settings: BrushSettings
}

// Brushes that drag from the initial grab set instead of stamping dabs.
export const DRAG_BASES: BrushBase[] = ['grab', 'snakehook', 'nudge', 'twist']
// Drag brushes and smooth don't trigger dyntopo refinement (Blender behaviour).
export const DYNTOPO_BASES: BrushBase[] = [
  'draw', 'clay', 'layer', 'inflate', 'crease', 'pinch', 'flatten', 'scrape', 'fill',
]

export const DEFAULT_SETTINGS: Record<BrushBase, BrushSettings> = {
  draw:      { radius: 0.55, strength: 0.5,  falloff: 'smooth',  spacing: 0.25, pressureRadius: false, pressureStrength: true },
  clay:      { radius: 0.55, strength: 0.55, falloff: 'smooth',  spacing: 0.25, pressureRadius: false, pressureStrength: true },
  layer:     { radius: 0.55, strength: 0.5,  falloff: 'smooth',  spacing: 0.2,  pressureRadius: false, pressureStrength: true },
  inflate:   { radius: 0.6,  strength: 0.45, falloff: 'smooth',  spacing: 0.3,  pressureRadius: false, pressureStrength: true },
  crease:    { radius: 0.4,  strength: 0.55, falloff: 'sharp',   spacing: 0.2,  pressureRadius: false, pressureStrength: true },
  pinch:     { radius: 0.5,  strength: 0.5,  falloff: 'smooth',  spacing: 0.25, pressureRadius: false, pressureStrength: true },
  smooth:    { radius: 0.65, strength: 0.55, falloff: 'smooth',  spacing: 0.25, pressureRadius: false, pressureStrength: true },
  flatten:   { radius: 0.6,  strength: 0.5,  falloff: 'smooth',  spacing: 0.25, pressureRadius: false, pressureStrength: true },
  scrape:    { radius: 0.6,  strength: 0.5,  falloff: 'smooth',  spacing: 0.25, pressureRadius: false, pressureStrength: true },
  fill:      { radius: 0.6,  strength: 0.5,  falloff: 'smooth',  spacing: 0.25, pressureRadius: false, pressureStrength: true },
  grab:      { radius: 0.75, strength: 0.9,  falloff: 'smooth',  spacing: 0,    pressureRadius: false, pressureStrength: false },
  snakehook: { radius: 0.55, strength: 0.9,  falloff: 'smooth',  spacing: 0,    pressureRadius: false, pressureStrength: false },
  nudge:     { radius: 0.6,  strength: 0.6,  falloff: 'smooth',  spacing: 0,    pressureRadius: false, pressureStrength: true },
  twist:     { radius: 0.8,  strength: 0.7,  falloff: 'smooth',  spacing: 0,    pressureRadius: false, pressureStrength: false },
}

// ── Falloff curves ────────────────────────────────────────────────────────────
// t = normalized distance 0 (center) → 1 (edge); returns weight 1 → 0.
export const FALLOFFS: Record<FalloffKind, (t: number) => number> = {
  smooth:   t => { const u = 1 - t * t; return u * u },                 // quartic (Blender "smooth")
  sphere:   t => Math.sqrt(Math.max(0, 1 - t * t)),
  root:     t => Math.sqrt(Math.max(0, 1 - t)),
  sharp:    t => { const u = 1 - t; return u * u * u },
  linear:   t => 1 - t,
  constant: () => 1,
}

// ── Stroke state ──────────────────────────────────────────────────────────────
export interface StrokeState {
  snapshot:     Float32Array          // positions at stroke start (layer / grab origins)
  grabbed:      { idx: Uint32Array; w: Float32Array } | null  // captured set for drag brushes
  originHit:    [number, number, number]
  originNormal: [number, number, number]
  accum:        [number, number, number]   // total drag delta (grab / twist angle source)
  lastDab:      [number, number, number] | null
  travel:       number                     // distance since the last emitted dab
}

export function beginStroke(
  pos: ArrayLike<number>, hit: [number, number, number], normal: [number, number, number],
): StrokeState {
  return {
    snapshot: Float32Array.from(pos as Float32Array),
    grabbed: null,
    originHit: [...hit] as [number, number, number],
    originNormal: [...normal] as [number, number, number],
    accum: [0, 0, 0],
    lastDab: null,
    travel: 0,
  }
}

// Capture the influence set for drag brushes (call once, at stroke start).
export function captureGrab(
  state: StrokeState, pos: Float32Array, count: number,
  radius: number, fall: (t: number) => number,
) {
  const [hx, hy, hz] = state.originHit
  const r2 = radius * radius
  const idx: number[] = [], w: number[] = []
  for (let i = 0; i < count; i++) {
    const dx = pos[i * 3] - hx, dy = pos[i * 3 + 1] - hy, dz = pos[i * 3 + 2] - hz
    const d2 = dx * dx + dy * dy + dz * dz
    if (d2 >= r2) continue
    idx.push(i)
    w.push(fall(Math.sqrt(d2) / radius))
  }
  state.grabbed = { idx: Uint32Array.from(idx), w: Float32Array.from(w) }
}

// ── Dab application ───────────────────────────────────────────────────────────
export interface DabParams {
  base:     BrushBase
  hit:      [number, number, number]    // local-space dab center
  normal:   [number, number, number]    // local-space surface normal at the dab
  delta:    [number, number, number]    // local-space drag delta since last event (drag brushes)
  radius:   number                      // local-space radius
  strength: number                      // 0..1 (pressure already applied)
  invert:   boolean
  falloff:  FalloffKind
}

// Displacement scale: proportional to the radius so strokes feel consistent
// at any zoom, normalized for dab spacing.
const DAB_SCALE = 0.07

export function applyDab(
  pos: Float32Array, count: number, nor: Float32Array | null,
  state: StrokeState, p: DabParams,
  adjacency: Int32Array[] | null,       // vertex one-rings (smooth brush)
  candidates?: Uint32Array | null,      // pre-collected region (skips the full scan)
) {
  const fall = FALLOFFS[p.falloff]
  const [hx, hy, hz] = p.hit
  const [nx, ny, nz] = p.normal
  const r = p.radius, r2 = r * r
  const sign = p.invert ? -1 : 1
  const amp = p.strength * r * DAB_SCALE * sign
  const N = candidates ? candidates.length : count

  switch (p.base) {
    case 'smooth':
      return smoothDab(pos, count, p, adjacency, candidates)
    case 'grab':
    case 'twist':
      return dragDab(pos, state, p)
    case 'snakehook':
    case 'nudge': {
      // Continuous drag: move verts around the CURRENT hit by the event delta.
      let [dx, dy, dz] = p.delta
      if (p.base === 'nudge') {
        // Tangential component only (slides matter along the surface).
        const dot = dx * nx + dy * ny + dz * nz
        dx -= nx * dot; dy -= ny * dot; dz -= nz * dot
      }
      const k = p.strength * 1.6
      for (let ci = 0; ci < N; ci++) {
        const i = candidates ? candidates[ci] : ci
        const vx = pos[i * 3], vy = pos[i * 3 + 1], vz = pos[i * 3 + 2]
        const ddx = vx - hx, ddy = vy - hy, ddz = vz - hz
        const d2 = ddx * ddx + ddy * ddy + ddz * ddz
        if (d2 >= r2) continue
        const w = fall(Math.sqrt(d2) / r) * k
        pos[i * 3] = vx + dx * w; pos[i * 3 + 1] = vy + dy * w; pos[i * 3 + 2] = vz + dz * w
      }
      return
    }
  }

  // Plane for flatten / scrape / fill: anchored on the dab hit along its normal.
  // Scrape works slightly under the surface (shaves peaks), fill slightly above.
  const planeOff = p.base === 'scrape' ? -0.05 * r : p.base === 'fill' ? 0.02 * r : 0

  for (let ci = 0; ci < N; ci++) {
    const i = candidates ? candidates[ci] : ci
    const vx = pos[i * 3], vy = pos[i * 3 + 1], vz = pos[i * 3 + 2]
    const dx = vx - hx, dy = vy - hy, dz = vz - hz
    const d2 = dx * dx + dy * dy + dz * dz
    if (d2 >= r2) continue
    const w = fall(Math.sqrt(d2) / r)
    let ox = vx, oy = vy, oz = vz

    switch (p.base) {
      case 'draw': {
        ox += nx * amp * w; oy += ny * amp * w; oz += nz * amp * w
        break
      }
      case 'clay': {
        // Push along the normal, gated to the visible side of the brush plane.
        const dp = dx * nx + dy * ny + dz * nz
        if (sign > 0 ? dp >= -0.25 * r : dp <= 0.25 * r) {
          ox += nx * amp * w; oy += ny * amp * w; oz += nz * amp * w
        }
        break
      }
      case 'layer': {
        // Displace along the stroke normal, capped at a fixed height above the
        // surface captured at stroke start.
        const H = 0.4 * r * sign
        const sx = state.snapshot[i * 3] ?? vx, sy = state.snapshot[i * 3 + 1] ?? vy, sz = state.snapshot[i * 3 + 2] ?? vz
        const cur = (vx - sx) * nx + (vy - sy) * ny + (vz - sz) * nz
        const step = amp * w
        const next = sign > 0 ? Math.min(cur + step, H) : Math.max(cur + step, H)
        const d = next - cur
        ox += nx * d; oy += ny * d; oz += nz * d
        break
      }
      case 'inflate': {
        const inx = nor ? nor[i * 3]     : nx
        const iny = nor ? nor[i * 3 + 1] : ny
        const inz = nor ? nor[i * 3 + 2] : nz
        ox += inx * amp * w; oy += iny * amp * w; oz += inz * amp * w
        break
      }
      case 'crease': {
        const pinchK = w * p.strength * 0.12
        ox += -dx * pinchK + nx * amp * w * 0.6
        oy += -dy * pinchK + ny * amp * w * 0.6
        oz += -dz * pinchK + nz * amp * w * 0.6
        break
      }
      case 'pinch': {
        const k = w * p.strength * 0.2 * sign
        ox += -dx * k; oy += -dy * k; oz += -dz * k
        break
      }
      case 'flatten': case 'scrape': case 'fill': {
        const dist = dx * nx + dy * ny + dz * nz - planeOff
        if (p.base === 'scrape' && dist <= 0) break     // only shave what's above
        if (p.base === 'fill'   && dist >= 0) break     // only raise what's below
        const k = w * p.strength * 0.45
        ox -= nx * dist * k; oy -= ny * dist * k; oz -= nz * dist * k
        break
      }
    }
    pos[i * 3] = ox; pos[i * 3 + 1] = oy; pos[i * 3 + 2] = oz
  }
}

// Grab / twist: displace the CAPTURED set from its snapshot positions.
function dragDab(pos: Float32Array, state: StrokeState, p: DabParams) {
  const g = state.grabbed
  if (!g) return
  const snap = state.snapshot
  if (p.base === 'grab') {
    const [ax, ay, az] = state.accum
    const k = p.strength
    for (let j = 0; j < g.idx.length; j++) {
      const i = g.idx[j], w = g.w[j] * k
      pos[i * 3]     = snap[i * 3]     + ax * w
      pos[i * 3 + 1] = snap[i * 3 + 1] + ay * w
      pos[i * 3 + 2] = snap[i * 3 + 2] + az * w
    }
    return
  }
  // Twist: rotate the captured set around (originHit, originNormal); the angle
  // grows with the drag distance projected on the tangent plane.
  const [hx, hy, hz] = state.originHit
  let [nx, ny, nz] = state.originNormal
  const nl = Math.hypot(nx, ny, nz) || 1
  nx /= nl; ny /= nl; nz /= nl
  const [ax, ay, az] = state.accum
  const tangMag = Math.hypot(ax - nx * (ax * nx + ay * ny + az * nz),
                             ay - ny * (ax * nx + ay * ny + az * nz),
                             az - nz * (ax * nx + ay * ny + az * nz))
  // Sign: which side of the normal-aligned frame the drag leans to.
  const sgn = (ax * (ny * az - nz * ay) + ay * (nz * ax - nx * az) + az * (nx * ay - ny * ax)) >= 0 ? 1 : -1
  const angle = sgn * (tangMag / Math.max(p.radius, 1e-4)) * Math.PI * p.strength
  for (let j = 0; j < g.idx.length; j++) {
    const i = g.idx[j], a = angle * g.w[j]
    const cos = Math.cos(a), sin = Math.sin(a)
    // Rodrigues rotation of (v - hit) around n.
    const vx = snap[i * 3] - hx, vy = snap[i * 3 + 1] - hy, vz = snap[i * 3 + 2] - hz
    const dot = vx * nx + vy * ny + vz * nz
    const cx = ny * vz - nz * vy, cy = nz * vx - nx * vz, cz = nx * vy - ny * vx
    pos[i * 3]     = hx + vx * cos + cx * sin + nx * dot * (1 - cos)
    pos[i * 3 + 1] = hy + vy * cos + cy * sin + ny * dot * (1 - cos)
    pos[i * 3 + 2] = hz + vz * cos + cz * sin + nz * dot * (1 - cos)
  }
}

// Laplacian smooth over topological one-rings (fast + crack-free, unlike the
// old O(n²) radius-neighbour average).
function smoothDab(pos: Float32Array, count: number, p: DabParams, adjacency: Int32Array[] | null, candidates?: Uint32Array | null) {
  if (!adjacency) return
  const fall = FALLOFFS[p.falloff]
  const [hx, hy, hz] = p.hit
  const r = p.radius, r2 = r * r
  const touched: number[] = []
  const N = candidates ? candidates.length : count
  for (let ci = 0; ci < N; ci++) {
    const i = candidates ? candidates[ci] : ci
    const dx = pos[i * 3] - hx, dy = pos[i * 3 + 1] - hy, dz = pos[i * 3 + 2] - hz
    const d2 = dx * dx + dy * dy + dz * dz
    if (d2 < r2) touched.push(i)
  }
  const next = new Float32Array(touched.length * 3)
  for (let k = 0; k < touched.length; k++) {
    const i = touched[k]
    const ring = adjacency[i]
    if (!ring || !ring.length) {
      next[k * 3] = pos[i * 3]; next[k * 3 + 1] = pos[i * 3 + 1]; next[k * 3 + 2] = pos[i * 3 + 2]
      continue
    }
    let ax = 0, ay = 0, az = 0
    for (let j = 0; j < ring.length; j++) {
      const v = ring[j]
      ax += pos[v * 3]; ay += pos[v * 3 + 1]; az += pos[v * 3 + 2]
    }
    ax /= ring.length; ay /= ring.length; az /= ring.length
    const dx = pos[i * 3] - hx, dy = pos[i * 3 + 1] - hy, dz = pos[i * 3 + 2] - hz
    const t = Math.sqrt(dx * dx + dy * dy + dz * dz) / r
    const s = Math.min(fall(t) * p.strength * 0.9, 0.9)
    next[k * 3]     = pos[i * 3]     + (ax - pos[i * 3]) * s
    next[k * 3 + 1] = pos[i * 3 + 1] + (ay - pos[i * 3 + 1]) * s
    next[k * 3 + 2] = pos[i * 3 + 2] + (az - pos[i * 3 + 2]) * s
  }
  for (let k = 0; k < touched.length; k++) {
    const i = touched[k]
    pos[i * 3] = next[k * 3]; pos[i * 3 + 1] = next[k * 3 + 1]; pos[i * 3 + 2] = next[k * 3 + 2]
  }
}

// ── Spatial / topological acceleration ─────────────────────────────────────────
// Collect the vertices inside a sphere — one O(V) pass per pointer event, so the
// (up to 24) dabs of that event only touch candidates instead of re-scanning
// the whole mesh each.
export function collectRegion(
  pos: Float32Array, count: number, center: [number, number, number], radius: number,
): Uint32Array {
  const [cx, cy, cz] = center
  const r2 = radius * radius
  const out: number[] = []
  for (let i = 0; i < count; i++) {
    const dx = pos[i * 3] - cx, dy = pos[i * 3 + 1] - cy, dz = pos[i * 3 + 2] - cz
    if (dx * dx + dy * dy + dz * dz < r2) out.push(i)
  }
  return Uint32Array.from(out)
}

// Vertex→triangles adjacency in CSR form (offsets + flat tri-offset list):
// built once per stroke, reused by the region normal updates.
export interface VertexTris { offsets: Uint32Array; tris: Uint32Array }
export function buildVertexTris(index: ArrayLike<number>, vertexCount: number): VertexTris {
  const counts = new Uint32Array(vertexCount)
  for (let i = 0; i < index.length; i++) counts[index[i]]++
  const offsets = new Uint32Array(vertexCount + 1)
  for (let v = 0; v < vertexCount; v++) offsets[v + 1] = offsets[v] + counts[v]
  const tris = new Uint32Array(index.length)
  const cursor = Uint32Array.from(offsets.subarray(0, vertexCount))
  for (let t = 0; t < index.length; t += 3) {
    for (let k = 0; k < 3; k++) tris[cursor[index[t + k]]++] = t
  }
  return { offsets, tris }
}

// Recompute area-weighted vertex normals ONLY around the moved vertices
// (matches three's computeVertexNormals within the affected neighbourhood).
// Affected = every vertex of every triangle that contains a moved vertex.
export function updateRegionNormals(
  pos: Float32Array, nor: Float32Array, index: ArrayLike<number>,
  v2t: VertexTris, moved: ArrayLike<number>,
) {
  // Gather affected vertices (dedup via a stamp set).
  const affected = new Set<number>()
  for (let m = 0; m < moved.length; m++) {
    const v = moved[m]
    for (let j = v2t.offsets[v]; j < v2t.offsets[v + 1]; j++) {
      const t = v2t.tris[j]
      affected.add(index[t]); affected.add(index[t + 1]); affected.add(index[t + 2])
    }
  }
  for (const v of affected) {
    let nx = 0, ny = 0, nz = 0
    for (let j = v2t.offsets[v]; j < v2t.offsets[v + 1]; j++) {
      const t = v2t.tris[j]
      const a = index[t], b = index[t + 1], c = index[t + 2]
      const ux = pos[b * 3] - pos[a * 3], uy = pos[b * 3 + 1] - pos[a * 3 + 1], uz = pos[b * 3 + 2] - pos[a * 3 + 2]
      const vx = pos[c * 3] - pos[a * 3], vy = pos[c * 3 + 1] - pos[a * 3 + 1], vz = pos[c * 3 + 2] - pos[a * 3 + 2]
      nx += uy * vz - uz * vy; ny += uz * vx - ux * vz; nz += ux * vy - uy * vx
    }
    const l = Math.hypot(nx, ny, nz) || 1
    nor[v * 3] = nx / l; nor[v * 3 + 1] = ny / l; nor[v * 3 + 2] = nz / l
  }
}

// Build vertex one-rings from an indexed triangle list.
export function buildAdjacency(index: ArrayLike<number>, vertexCount: number): Int32Array[] {
  const sets: Set<number>[] = Array.from({ length: vertexCount }, () => new Set<number>())
  for (let i = 0; i + 2 < index.length; i += 3) {
    const a = index[i], b = index[i + 1], c = index[i + 2]
    sets[a].add(b); sets[a].add(c)
    sets[b].add(a); sets[b].add(c)
    sets[c].add(a); sets[c].add(b)
  }
  return sets.map(s => Int32Array.from(s))
}

// ── Dyntopo ───────────────────────────────────────────────────────────────────
// Growable mesh living for the duration of a stroke. `tracked` arrays (the
// stroke snapshot) are interpolated on splits / remapped on collapses so
// layer/grab origins stay coherent as topology changes.
export class DynMesh {
  pos:   Float32Array
  count: number
  idx:   Uint32Array
  idxCount: number
  tracked: Float32Array | null
  version = 0                      // bumped on every topology change

  constructor(pos: Float32Array, count: number, idx: ArrayLike<number>, tracked?: Float32Array | null) {
    this.pos = pos; this.count = count
    this.idx = Uint32Array.from(idx); this.idxCount = this.idx.length
    this.tracked = tracked ?? null
  }

  private growVerts(extra: number) {
    if ((this.count + extra) * 3 <= this.pos.length) return
    const cap = Math.max((this.count + extra) * 3, this.pos.length * 2)
    const np = new Float32Array(cap); np.set(this.pos.subarray(0, this.count * 3)); this.pos = np
    if (this.tracked) {
      const nt = new Float32Array(cap); nt.set(this.tracked.subarray(0, this.count * 3)); this.tracked = nt
    }
  }
  // Public: edge-split subdivision (outside the class) appends triangles directly.
  growIdx(extra: number) {
    if (this.idxCount + extra <= this.idx.length) return
    const cap = Math.max(this.idxCount + extra, this.idx.length * 2)
    const ni = new Uint32Array(cap); ni.set(this.idx.subarray(0, this.idxCount)); this.idx = ni
  }

  addMidpoint(a: number, b: number): number {
    this.growVerts(1)
    const i = this.count++
    for (let k = 0; k < 3; k++) {
      this.pos[i * 3 + k] = (this.pos[a * 3 + k] + this.pos[b * 3 + k]) / 2
      if (this.tracked) this.tracked[i * 3 + k] = (this.tracked[a * 3 + k] + this.tracked[b * 3 + k]) / 2
    }
    return i
  }
}

const edgeKey = (a: number, b: number) => a < b ? a * 0x100000000 + b : b * 0x100000000 + a

function dist2(pos: Float32Array, a: number, b: number): number {
  const dx = pos[a * 3] - pos[b * 3], dy = pos[a * 3 + 1] - pos[b * 3 + 1], dz = pos[a * 3 + 2] - pos[b * 3 + 2]
  return dx * dx + dy * dy + dz * dz
}

// Refine: split every region edge longer than `detail` by longest-edge
// bisection (both triangles sharing the edge split together → watertight).
// Returns the number of splits performed.
export function refineRegion(
  m: DynMesh, hit: [number, number, number], radius: number, detail: number, budget = 4000,
): number {
  const [hx, hy, hz] = hit
  const rr = (radius + detail) * (radius + detail)
  const d2max = detail * detail
  let splits = 0

  const inRegion = (v: number) => {
    const dx = m.pos[v * 3] - hx, dy = m.pos[v * 3 + 1] - hy, dz = m.pos[v * 3 + 2] - hz
    return dx * dx + dy * dy + dz * dz < rr
  }

  for (let pass = 0; pass < 12 && splits < budget; pass++) {
    // Pass A: find the long edges of region triangles (pure arithmetic, no maps).
    const longEdges: Array<[number, number]> = []
    const seen = new Set<number>()
    for (let t = 0; t < m.idxCount; t += 3) {
      const a = m.idx[t], b = m.idx[t + 1], c = m.idx[t + 2]
      if (!inRegion(a) && !inRegion(b) && !inRegion(c)) continue
      const pairs: Array<[number, number]> = [[a, b], [b, c], [c, a]]
      for (const [u, v] of pairs) {
        const k = edgeKey(u, v)
        if (!seen.has(k) && dist2(m.pos, u, v) > d2max) {
          seen.add(k)
          longEdges.push([u, v])
        }
      }
    }
    if (!longEdges.length) break
    // Pass B: edge→tris map for the WANTED edges only — a region edge shared
    // with an outside triangle must split both sides (no T-junctions), so this
    // pass scans every triangle but only stores the split candidates.
    const edgeTris = new Map<number, number[]>()      // edgeKey → [triOffset...]
    for (let t = 0; t < m.idxCount; t += 3) {
      const a = m.idx[t], b = m.idx[t + 1], c = m.idx[t + 2]
      const pairs: Array<[number, number]> = [[a, b], [b, c], [c, a]]
      for (const [u, v] of pairs) {
        const k = edgeKey(u, v)
        if (!seen.has(k)) continue
        let arr = edgeTris.get(k)
        if (!arr) { arr = []; edgeTris.set(k, arr) }
        arr.push(t)
      }
    }
    if (!longEdges.length) break
    // Longest first: bisection converges without T-junctions.
    longEdges.sort((e1, e2) => dist2(m.pos, e2[0], e2[1]) - dist2(m.pos, e1[0], e1[1]))

    const deadTris = new Set<number>()
    for (const [u, v] of longEdges) {
      if (splits >= budget) break
      const tris = edgeTris.get(edgeKey(u, v))
      if (!tris) continue
      const live = tris.filter(t => !deadTris.has(t))
      if (!live.length) continue
      // Skip if a neighbour triangle of this edge was already split this pass
      // (its record is stale); it will be caught in the next pass.
      if (live.length !== tris.length) continue
      const mid = m.addMidpoint(u, v)
      for (const t of live) {
        const a = m.idx[t], b = m.idx[t + 1], c = m.idx[t + 2]
        // The corner opposite the split edge.
        const w = (a !== u && a !== v) ? a : (b !== u && b !== v) ? b : c
        // Preserve winding: rewrite (u,v,w order as in the tri) → two tris.
        const order: number[] = [a, b, c]
        const rewritten: number[][] = []
        for (let e = 0; e < 3; e++) {
          const p1 = order[e], p2 = order[(e + 1) % 3]
          if ((p1 === u && p2 === v) || (p1 === v && p2 === u)) {
            rewritten.push([p1, mid, w], [mid, p2, w])
            break
          }
        }
        if (rewritten.length !== 2) continue
        // Replace the original tri with the first half, append the second.
        m.idx[t] = rewritten[0][0]; m.idx[t + 1] = rewritten[0][1]; m.idx[t + 2] = rewritten[0][2]
        m.growIdx(3)
        m.idx[m.idxCount] = rewritten[1][0]; m.idx[m.idxCount + 1] = rewritten[1][1]; m.idx[m.idxCount + 2] = rewritten[1][2]
        m.idxCount += 3
        deadTris.add(t)               // stale for other edges of the same tri this pass
      }
      splits++
    }
    if (!splits) break
  }
  if (splits) m.version++
  return splits
}

// Collapse: merge region edges shorter than `minLen`, with manifold and
// normal-flip guards. Dead vertices are left in place (compact() removes them).
export function collapseRegion(
  m: DynMesh, hit: [number, number, number], radius: number, minLen: number, budget = 800,
): number {
  const [hx, hy, hz] = hit
  const r2 = radius * radius
  const min2 = minLen * minLen
  const inRegion = (v: number) => {
    const dx = m.pos[v * 3] - hx, dy = m.pos[v * 3 + 1] - hy, dz = m.pos[v * 3 + 2] - hz
    return dx * dx + dy * dy + dz * dz < r2
  }

  // Vertex → triangle offsets, restricted to in-region vertices (collapse only
  // ever touches edges whose BOTH endpoints are in the region, but their tri
  // lists must be complete — hence the whole-mesh scan with flagged inserts).
  const flags = new Uint8Array(m.count)
  for (let v = 0; v < m.count; v++) if (inRegion(v)) flags[v] = 1
  const v2t = new Map<number, number[]>()
  for (let t = 0; t < m.idxCount; t += 3) {
    for (let k = 0; k < 3; k++) {
      const v = m.idx[t + k]
      if (!flags[v]) continue
      let arr = v2t.get(v)
      if (!arr) { arr = []; v2t.set(v, arr) }
      arr.push(t)
    }
  }

  const triNormal = (t: number, out: [number, number, number], override?: { v: number; x: number; y: number; z: number }) => {
    const g = (v: number, k: number) => (override && v === override.v)
      ? (k === 0 ? override.x : k === 1 ? override.y : override.z)
      : m.pos[v * 3 + k]
    const a = m.idx[t], b = m.idx[t + 1], c = m.idx[t + 2]
    const ux = g(b, 0) - g(a, 0), uy = g(b, 1) - g(a, 1), uz = g(b, 2) - g(a, 2)
    const vx = g(c, 0) - g(a, 0), vy = g(c, 1) - g(a, 1), vz = g(c, 2) - g(a, 2)
    out[0] = uy * vz - uz * vy; out[1] = uz * vx - ux * vz; out[2] = ux * vy - uy * vx
  }

  const dead = new Set<number>()      // dead triangle offsets
  const gone = new Set<number>()      // collapsed-away vertices
  let collapses = 0
  const n1: [number, number, number] = [0, 0, 0]
  const n2: [number, number, number] = [0, 0, 0]

  outer:
  for (let t = 0; t < m.idxCount && collapses < budget; t += 3) {
    if (dead.has(t)) continue
    for (let e = 0; e < 3; e++) {
      const a = m.idx[t + e], b = m.idx[t + (e + 1) % 3]
      if (a === b || gone.has(a) || gone.has(b)) continue
      if (!inRegion(a) || !inRegion(b)) continue
      if (dist2(m.pos, a, b) > min2) continue

      const trisA = (v2t.get(a) ?? []).filter(x => !dead.has(x))
      const trisB = (v2t.get(b) ?? []).filter(x => !dead.has(x))
      const shared = trisB.filter(x => trisA.includes(x))
      if (shared.length !== 2) continue                  // boundary or non-manifold: skip

      // Manifold guard: the one-rings of a and b may only share the two corners
      // opposite the collapsing edge, otherwise the collapse pinches the mesh.
      const ringOf = (tris: number[], self: number, other: number) => {
        const s = new Set<number>()
        for (const tt of tris) for (let k = 0; k < 3; k++) {
          const v = m.idx[tt + k]
          if (v !== self && v !== other) s.add(v)
        }
        return s
      }
      const ringA = ringOf(trisA, a, b), ringB = ringOf(trisB, b, a)
      let common = 0
      for (const v of ringA) if (ringB.has(v)) common++
      if (common !== 2) continue

      // Normal-flip guard: simulate moving b (and a) to the midpoint.
      const mx = (m.pos[a * 3] + m.pos[b * 3]) / 2
      const my = (m.pos[a * 3 + 1] + m.pos[b * 3 + 1]) / 2
      const mz = (m.pos[a * 3 + 2] + m.pos[b * 3 + 2]) / 2
      for (const tt of [...trisA, ...trisB]) {
        if (shared.includes(tt)) continue
        const v = trisA.includes(tt) ? a : b
        triNormal(tt, n1)
        triNormal(tt, n2, { v, x: mx, y: my, z: mz })
        const dot = n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2]
        const l1 = Math.hypot(...n1), l2 = Math.hypot(...n2)
        if (l1 > 1e-12 && l2 > 1e-12 && dot / (l1 * l2) < 0.2) continue outer
      }

      // Commit: a ← midpoint, b remapped to a, shared tris die.
      m.pos[a * 3] = mx; m.pos[a * 3 + 1] = my; m.pos[a * 3 + 2] = mz
      if (m.tracked) {
        for (let k = 0; k < 3; k++) m.tracked[a * 3 + k] = (m.tracked[a * 3 + k] + m.tracked[b * 3 + k]) / 2
      }
      for (const tt of trisB) {
        if (shared.includes(tt)) { dead.add(tt); continue }
        for (let k = 0; k < 3; k++) if (m.idx[tt + k] === b) m.idx[tt + k] = a
        const arr = v2t.get(a)!
        if (!arr.includes(tt)) arr.push(tt)
      }
      gone.add(b)
      collapses++
      break     // this triangle's edges are stale now
    }
  }

  if (collapses) {
    // Drop dead triangles in place.
    let w = 0
    for (let t = 0; t < m.idxCount; t += 3) {
      if (dead.has(t)) continue
      m.idx[w] = m.idx[t]; m.idx[w + 1] = m.idx[t + 1]; m.idx[w + 2] = m.idx[t + 2]
      w += 3
    }
    m.idxCount = w
    m.version++
  }
  return collapses
}

// Remove unreferenced vertices and remap the index (call at stroke end).
export function compact(m: DynMesh): { positions: Float32Array; index: Uint32Array } {
  const remap = new Int32Array(m.count).fill(-1)
  let next = 0
  for (let i = 0; i < m.idxCount; i++) {
    const v = m.idx[i]
    if (remap[v] === -1) remap[v] = next++
  }
  const positions = new Float32Array(next * 3)
  for (let v = 0; v < m.count; v++) {
    const r = remap[v]
    if (r === -1) continue
    positions[r * 3] = m.pos[v * 3]; positions[r * 3 + 1] = m.pos[v * 3 + 1]; positions[r * 3 + 2] = m.pos[v * 3 + 2]
  }
  const index = new Uint32Array(m.idxCount)
  for (let i = 0; i < m.idxCount; i++) index[i] = remap[m.idx[i]]
  return { positions, index }
}

// Whole-mesh uniform refine ("flood fill detail"): split every edge above
// `detail`, mesh-wide. Iterates to convergence with a global budget.
export function floodRefine(pos: Float32Array, count: number, index: ArrayLike<number>, detail: number, budget = 60000):
  { positions: Float32Array; index: Uint32Array; splits: number } {
  const m = new DynMesh(Float32Array.from(pos.subarray(0, count * 3)), count, index)
  // A "region" that covers everything: huge radius around the origin.
  let total = 0
  for (let i = 0; i < 20; i++) {
    const s = refineRegion(m, [0, 0, 0], 1e6, detail, budget - total)
    total += s
    if (!s || total >= budget) break
  }
  const out = compact(m)
  return { ...out, splits: total }
}

// ── Mesh integrity checks (used by the headless engine tests) ────────────────
export function meshDiagnostics(pos: Float32Array, count: number, idx: ArrayLike<number>) {
  let nan = 0, degenerate = 0, nonManifold = 0, boundary = 0
  for (let i = 0; i < count * 3; i++) if (!Number.isFinite(pos[i])) nan++
  const edges = new Map<number, number>()
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2]
    if (a === b || b === c || c === a) degenerate++
    for (const [u, v] of [[a, b], [b, c], [c, a]] as Array<[number, number]>) {
      const k = edgeKey(u, v)
      edges.set(k, (edges.get(k) ?? 0) + 1)
    }
  }
  for (const n of edges.values()) {
    if (n === 1) boundary++
    else if (n > 2) nonManifold++
  }
  return { nan, degenerate, nonManifold, boundary, edges: edges.size, tris: idx.length / 3, verts: count }
}
