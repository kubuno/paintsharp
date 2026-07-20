// Vertex editor — mesh object operations (join, CSG booleans, weld, normals,
// transform baking). Kept separate from the page component: everything here is
// pure geometry work on serializable scene data, no React.
import * as THREE from 'three'
import { mergeVertices, mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

// Minimal structural types mirroring VertexEditorPage's scene model (kept local
// to avoid a circular import; the page re-checks shapes at the call sites).
export interface OpMeshData {
  positions: number[]
  index?:    number[]
  uvs?:      number[]
  colors?:   number[]
  weights?:  number[]
  texture?:  string
}
export interface OpSceneObject {
  id:        string
  name:      string
  primType:  string
  visible:   boolean
  position:  [number, number, number]
  rotation?: [number, number, number]
  scale?:    [number, number, number]
  color?:    string
  mesh?:     OpMeshData
}

export type BooleanOp = 'union' | 'difference' | 'intersect'

// Compose an object's TRS into a matrix.
export function objectMatrix(o: OpSceneObject): THREE.Matrix4 {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(...(o.rotation ?? [0, 0, 0])))
  return new THREE.Matrix4().compose(
    new THREE.Vector3(...o.position),
    q,
    new THREE.Vector3(...(o.scale ?? [1, 1, 1])),
  )
}

// Apply saved deformed positions onto a freshly built primitive geometry.
export function applySavedPositions(geo: THREE.BufferGeometry, mesh?: OpMeshData) {
  if (!mesh?.positions) return
  const pos = geo.attributes.position as THREE.BufferAttribute
  if (mesh.positions.length === pos.count * 3) {
    (pos.array as Float32Array).set(mesh.positions)
    pos.needsUpdate = true
    geo.computeVertexNormals()
  }
}

// Bake an object's full world transform into a clone of its geometry.
// The returned geometry lives in world space with an identity transform.
export function bakeWorldGeometry(geo: THREE.BufferGeometry, o: OpSceneObject): THREE.BufferGeometry {
  const g = geo.clone()
  g.applyMatrix4(objectMatrix(o))
  g.computeVertexNormals()
  return g
}

// Snapshot a geometry into custom-topology MeshData (positions + index + uvs),
// re-centred on its bounding-box centre. Returns the payload and the centre
// (which becomes the new object position).
export function geometryToCenteredMesh(geo: THREE.BufferGeometry): { mesh: OpMeshData; center: [number, number, number] } {
  geo.computeBoundingBox()
  const c = new THREE.Vector3()
  geo.boundingBox!.getCenter(c)
  geo.translate(-c.x, -c.y, -c.z)
  const round = (arr: ArrayLike<number>, prec = 1e4) => {
    const out = new Array<number>(arr.length)
    for (let i = 0; i < arr.length; i++) out[i] = Math.round(arr[i] * prec) / prec
    return out
  }
  const pos = geo.attributes.position as THREE.BufferAttribute
  const mesh: OpMeshData = { positions: round(pos.array as ArrayLike<number>) }
  const idx = geo.getIndex()
  if (idx) mesh.index = Array.from(idx.array as ArrayLike<number>)
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute | undefined
  if (uv && uv.count === pos.count) mesh.uvs = round(uv.array as ArrayLike<number>)
  return { mesh, center: [c.x, c.y, c.z] }
}

// Strip a geometry down to a non-indexed position-only clone (uniform attribute
// sets are required before merging heterogeneous geometries).
function positionsOnly(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const ni = geo.index ? geo.toNonIndexed() : geo.clone()
  const out = new THREE.BufferGeometry()
  out.setAttribute('position', ni.getAttribute('position').clone())
  if (ni !== geo) ni.dispose()
  return out
}

// ── Join: concatenate several world-baked geometries into one welded mesh ──────
export function joinGeometries(worldGeos: THREE.BufferGeometry[]): { mesh: OpMeshData; center: [number, number, number] } {
  const parts = worldGeos.map(positionsOnly)
  const merged = mergeGeometries(parts, false)
  parts.forEach(p => p.dispose())
  if (!merged) throw new Error('join failed: mergeGeometries returned null')
  const welded = mergeVertices(merged)
  merged.dispose()
  welded.computeVertexNormals()
  const res = geometryToCenteredMesh(welded)
  welded.dispose()
  return res
}

// ── Boolean CSG (three-bvh-csg, dynamic import to keep the chunk separate) ─────
// Operands are world-baked geometries; the op is folded left-to-right:
// A ∘ B ∘ C … (difference = A − B − C).
export async function booleanGeometries(worldGeos: THREE.BufferGeometry[], op: BooleanOp):
  Promise<{ mesh: OpMeshData; center: [number, number, number] }> {
  const csg = await import('three-bvh-csg')
  const { Brush, Evaluator, ADDITION, SUBTRACTION, INTERSECTION } = csg as any
  const kind = op === 'union' ? ADDITION : op === 'difference' ? SUBTRACTION : INTERSECTION

  const evaluator = new Evaluator()
  evaluator.attributes = ['position']
  evaluator.useGroups = false

  // CSG needs indexed, well-formed solids: weld each operand first.
  const brushes = worldGeos.map(g => {
    const ni = positionsOnly(g)
    const welded = mergeVertices(ni)
    ni.dispose()
    welded.computeVertexNormals()
    const b = new Brush(welded)
    b.updateMatrixWorld(true)
    return b
  })

  let acc = brushes[0]
  for (let i = 1; i < brushes.length; i++) {
    const next = evaluator.evaluate(acc, brushes[i], kind)
    if (acc !== brushes[0]) acc.geometry.dispose()
    acc = next
  }

  let out: THREE.BufferGeometry = acc.geometry
  if (!out.getAttribute('position') || out.getAttribute('position').count === 0) {
    brushes.forEach(b => b.geometry.dispose())
    throw new Error('boolean produced an empty mesh')
  }
  out = mergeVertices(out.index ? out.toNonIndexed() : out)
  out.computeVertexNormals()
  const res = geometryToCenteredMesh(out)
  brushes.forEach(b => b.geometry.dispose())
  out.dispose()
  return res
}

// ── Weld: merge coincident vertices (fix cracks after imports/edits) ──────────
export function weldGeometry(src: THREE.BufferGeometry): THREE.BufferGeometry {
  const ni = src.index ? src.toNonIndexed() : src.clone()
  ni.deleteAttribute('normal')
  const welded = mergeVertices(ni)
  ni.dispose()
  welded.computeVertexNormals()
  return welded
}

// ── Flip normals: reverse triangle winding ─────────────────────────────────────
export function flipGeometryNormals(src: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = src.clone()
  const idx = g.getIndex()
  if (idx) {
    const arr = idx.array as ArrayLike<number>
    const flipped = new (arr.constructor as any)(arr.length)
    for (let i = 0; i + 2 < arr.length; i += 3) {
      flipped[i] = arr[i + 2]; flipped[i + 1] = arr[i + 1]; flipped[i + 2] = arr[i]
    }
    g.setIndex(new THREE.BufferAttribute(flipped, 1))
  } else {
    const pos = g.getAttribute('position') as THREE.BufferAttribute
    const p = pos.array as Float32Array
    for (let i = 0; i + 8 < p.length; i += 9) {
      for (let k = 0; k < 3; k++) { const t = p[i + k]; p[i + k] = p[i + 6 + k]; p[i + 6 + k] = t }
    }
    pos.needsUpdate = true
  }
  g.computeVertexNormals()
  return g
}

// ── Apply transform: bake rotation + scale into the geometry, keep position ───
export function bakeRotationScale(geo: THREE.BufferGeometry, o: OpSceneObject): THREE.BufferGeometry {
  const g = geo.clone()
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(...(o.rotation ?? [0, 0, 0])))
  const m = new THREE.Matrix4().compose(new THREE.Vector3(0, 0, 0), q, new THREE.Vector3(...(o.scale ?? [1, 1, 1])))
  g.applyMatrix4(m)
  g.computeVertexNormals()
  return g
}

// ── Ground snap: vertical offset that puts the world bbox bottom at y = 0 ─────
export function groundOffset(geo: THREE.BufferGeometry, o: OpSceneObject): number {
  const g = bakeWorldGeometry(geo, o)
  g.computeBoundingBox()
  const minY = g.boundingBox!.min.y
  g.dispose()
  return -minY
}
