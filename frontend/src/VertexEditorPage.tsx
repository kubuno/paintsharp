import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams, useNavigate } from 'react-router-dom'
import { useDebouncedAutosave } from './useAutosave'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Canvas, ThreeEvent, useThree } from '@react-three/fiber'
import { OrbitControls, Grid, GizmoHelper, GizmoViewport, TransformControls } from '@react-three/drei'
import * as THREE from 'three'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import {
  Box, Circle, RotateCw, Move, Maximize2,
  Layers, Settings2, ChevronRight, ChevronDown, Eye, EyeOff, Trash2, Sun,
  Brush, Minus, Plus, Pen, Hand, Wind, Minimize2, Scissors,
  FlipHorizontal, Grid3x3, Triangle, Square, Hexagon, Undo2, Redo2,
  Download, Upload, Crosshair,
  MousePointer2, Waypoints, Palette, Weight, Image as ImageIcon, Star,
} from 'lucide-react'
import { RangeSlider } from '@ui'
import { paintsharpApi } from './api'
import { C as SHELL_C, EditorShell, DockArea, ColorField, paintsharpMenus, useContextMenu, type CtxItem } from './ui'

// ── Palette (shared Paintsharp theme, mapped to Vertex's legacy key names) ───────────
const C = { ...SHELL_C, bgPanel: SHELL_C.panel, bgToolbar: SHELL_C.toolbar, selected: SHELL_C.accent + '33' }

// ── Types ─────────────────────────────────────────────────────────────────────
type TransformMode = 'translate' | 'rotate' | 'scale'
// Blender-style interaction modes.
type Mode = 'object' | 'edit' | 'sculpt' | 'vertex_paint' | 'weight_paint' | 'texture_paint'
type SculptBrush  = 'clay' | 'draw' | 'move' | 'smooth' | 'flatten' | 'inflate' | 'pinch' | 'crease'
type PrimType     = 'box' | 'sphere' | 'cylinder' | 'torus' | 'cone' | 'plane' | 'icosphere' | 'custom'
// Edit Mode selection element (Blender's vertex / edge / face select modes).
type EditElem     = 'vertex' | 'edge' | 'face'
// Highlighted Edit-Mode selection: vertex indices (move target) + derived edges/faces (display).
interface EditSel { v: number[]; e: number[]; f: number[] }
const EMPTY_SEL: EditSel = { v: [], e: [], f: [] }

// Modes that paint/deform on drag (LMB) → orbit disabled, brush cursor shown.
const PAINT_MODES: Mode[] = ['sculpt', 'vertex_paint', 'weight_paint', 'texture_paint', 'edit']

// Persisted per-mesh data. For primitives only deformed positions / paint buffers
// are stored (topology is regenerated from `primType`); custom meshes also carry
// their full topology (index + uvs).
interface MeshData {
  positions: number[]            // flat xyz, deformed vertices
  index?:    number[]            // custom topology only
  uvs?:      number[]            // custom topology only
  colors?:   number[]            // vertex-paint colors (flat rgb)
  weights?:  number[]            // weight-paint values 0..1
  texture?:  string             // texture-paint canvas as a data URL
}

interface SceneObject {
  id:       string
  name:     string
  primType: PrimType
  visible:  boolean
  position: [number, number, number]
  color?:     string
  roughness?: number
  metalness?: number
  rotation?:  [number, number, number]
  scale?:     [number, number, number]
  shadeFlat?: boolean            // flat (faceted) vs smooth shading
  mesh?:      MeshData            // deformed geometry / paint state (persisted)
}

// ── Geometry ──────────────────────────────────────────────────────────────────
// High-resolution base primitives so sculpting has vertices to move.
function createBaseGeometry(primType: PrimType): THREE.BufferGeometry {
  switch (primType) {
    case 'sphere':    return new THREE.SphereGeometry(0.8, 48, 48)
    case 'cylinder':  return new THREE.CylinderGeometry(0.5, 0.5, 1.5, 32, 12)
    case 'torus':     return new THREE.TorusGeometry(0.7, 0.25, 32, 64)
    case 'cone':      return new THREE.ConeGeometry(0.6, 1.4, 36, 16)
    case 'plane':     return new THREE.PlaneGeometry(1.6, 1.6, 28, 28)
    case 'icosphere': {
      // Icosahedron faces don't share vertices → merge so sculpting stays watertight.
      const g = mergeVertices(new THREE.IcosahedronGeometry(0.85, 4))
      g.computeVertexNormals()
      return g
    }
    default:          return new THREE.BoxGeometry(1, 1, 1, 12, 12, 12)
  }
}

// Builds the live geometry for an object, including imported (custom) topology.
function buildGeometry(obj: SceneObject): THREE.BufferGeometry {
  if (obj.primType === 'custom' && obj.mesh) {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(obj.mesh.positions, 3))
    if (obj.mesh.index) g.setIndex(obj.mesh.index)
    if (obj.mesh.uvs)   g.setAttribute('uv', new THREE.Float32BufferAttribute(obj.mesh.uvs, 2))
    g.computeVertexNormals()
    return g
  }
  return createBaseGeometry(obj.primType)
}

// Round a numeric buffer to keep serialized scenes compact.
function roundArr(arr: ArrayLike<number>, prec = 1e4): number[] {
  const out = new Array<number>(arr.length)
  for (let i = 0; i < arr.length; i++) out[i] = Math.round(arr[i] * prec) / prec
  return out
}

// Snapshot a mesh's deformed geometry + paint buffers into a serializable payload.
function serializeMesh(
  geo: THREE.BufferGeometry, primType: PrimType,
  vColors: Float32Array | null, weights: Float32Array | null,
  texCanvas: HTMLCanvasElement | null, prev?: MeshData,
): MeshData {
  const pos = geo.attributes.position as THREE.BufferAttribute
  const out: MeshData = { positions: roundArr(pos.array as ArrayLike<number>) }
  if (primType === 'custom') {
    const idx = geo.getIndex()
    if (idx) out.index = Array.from(idx.array as ArrayLike<number>)
    const uv = geo.getAttribute('uv') as THREE.BufferAttribute | undefined
    if (uv) out.uvs = roundArr(uv.array as ArrayLike<number>)
  }
  if (vColors && vColors.some(v => v !== 1)) out.colors = roundArr(vColors, 1e3)
  if (weights && weights.some(w => w > 0)) out.weights = roundArr(weights, 1e3)
  const tex = texCanvas ? texCanvas.toDataURL('image/png') : prev?.texture
  if (tex) out.texture = tex
  return out
}

// ── Mesh modifiers (Blender-style) ──────────────────────────────────────────────
// Snapshot a welded geometry into custom-topology MeshData (positions + index + uvs).
function geometryToMeshData(geo: THREE.BufferGeometry): MeshData {
  const pos = geo.attributes.position as THREE.BufferAttribute
  const out: MeshData = { positions: roundArr(pos.array as ArrayLike<number>) }
  const idx = geo.getIndex()
  if (idx) out.index = Array.from(idx.array as ArrayLike<number>)
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute | undefined
  if (uv) out.uvs = roundArr(uv.array as ArrayLike<number>)
  return out
}

// Mean triangle edge length of a non-indexed geometry (drives subdivision density).
function meanEdgeLength(geo: THREE.BufferGeometry): number {
  const pos = geo.attributes.position as THREE.BufferAttribute
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
  let sum = 0, n = 0
  for (let i = 0; i + 2 < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, i + 1); c.fromBufferAttribute(pos, i + 2)
    sum += a.distanceTo(b) + b.distanceTo(c) + c.distanceTo(a); n += 3
  }
  return n ? sum / n : 0.1
}

// Subdivide: split faces (one level) then weld coincident vertices so the result
// stays watertight for sculpting. Returns a fresh welded geometry.
async function subdivideGeometry(src: THREE.BufferGeometry): Promise<THREE.BufferGeometry> {
  const { TessellateModifier } = await import('three/examples/jsm/modifiers/TessellateModifier.js')
  const ni = src.index ? src.toNonIndexed() : src.clone()
  const target = meanEdgeLength(ni) * 0.6      // < mean edge → every face splits at least once
  const tess = new (TessellateModifier as any)(target, 1)
  const out: THREE.BufferGeometry = tess.modify(ni)
  out.deleteAttribute('normal')                // interpolated normals would block welding
  const welded = mergeVertices(out)
  welded.computeVertexNormals()
  ni.dispose(); out.dispose()
  return welded
}

// Decimate: weld, drop a fraction of vertices via quadric simplification, re-weld.
async function decimateGeometry(src: THREE.BufferGeometry, ratio: number): Promise<THREE.BufferGeometry> {
  const { SimplifyModifier } = await import('three/examples/jsm/modifiers/SimplifyModifier.js')
  const ni = src.index ? src.toNonIndexed() : src.clone()
  ni.deleteAttribute('normal')
  const welded = mergeVertices(ni)
  const remove = Math.max(1, Math.floor(welded.attributes.position.count * ratio))
  const simplified: THREE.BufferGeometry = new (SimplifyModifier as any)().modify(welded, remove)
  const reweld = mergeVertices(simplified.index ? simplified.toNonIndexed() : simplified)
  reweld.computeVertexNormals()
  ni.dispose(); welded.dispose(); simplified.dispose()
  return reweld
}

// ── Brush application on vertices ─────────────────────────────────────────────
function applyBrush(
  geo:         THREE.BufferGeometry,
  worldMatrix: THREE.Matrix4,
  worldHit:    THREE.Vector3,
  worldNormal: THREE.Vector3,
  brush:       SculptBrush,
  radius:      number,
  strength:    number,
  invert:      boolean,
) {
  const pos    = geo.attributes.position as THREE.BufferAttribute
  const nor    = geo.attributes.normal   as THREE.BufferAttribute | undefined
  const invMat = new THREE.Matrix4().copy(worldMatrix).invert()

  const scl = new THREE.Vector3()
  worldMatrix.decompose(new THREE.Vector3(), new THREE.Quaternion(), scl)
  const localRadius = radius / Math.max(scl.x, 0.001)

  const localHit    = worldHit.clone().applyMatrix4(invMat)
  const localNormal = worldNormal.clone().transformDirection(invMat).normalize()

  const sign  = invert ? -1 : 1
  const SPEED = 0.011

  if (brush === 'smooth') {
    applySmoothBrush(pos, localHit, localRadius, strength * SPEED * 5)
    geo.computeVertexNormals()
    return
  }

  for (let i = 0; i < pos.count; i++) {
    const vx = pos.getX(i), vy = pos.getY(i), vz = pos.getZ(i)
    const dx = vx - localHit.x, dy = vy - localHit.y, dz = vz - localHit.z
    const dist2 = dx * dx + dy * dy + dz * dz
    if (dist2 >= localRadius * localRadius) continue

    const t       = Math.sqrt(dist2) / localRadius
    const falloff = (1 - t * t) * (1 - t * t)     // quartic
    const s       = strength * falloff * SPEED * sign

    let nx = vx, ny = vy, nz = vz

    switch (brush) {
      case 'clay': {
        // Push along the normal only on the visible side.
        const dp = dx * localNormal.x + dy * localNormal.y + dz * localNormal.z
        if (sign > 0 ? dp >= 0 : dp <= 0) {
          nx += localNormal.x * s
          ny += localNormal.y * s
          nz += localNormal.z * s
        }
        break
      }
      case 'draw': {
        nx += localNormal.x * s
        ny += localNormal.y * s
        nz += localNormal.z * s
        break
      }
      case 'inflate': {
        const nnx = nor ? nor.getX(i) : localNormal.x
        const nny = nor ? nor.getY(i) : localNormal.y
        const nnz = nor ? nor.getZ(i) : localNormal.z
        nx += nnx * s
        ny += nny * s
        nz += nnz * s
        break
      }
      case 'flatten': {
        const proj = dx * localNormal.x + dy * localNormal.y + dz * localNormal.z
        const rate = falloff * strength * 0.4
        nx -= localNormal.x * proj * rate
        ny -= localNormal.y * proj * rate
        nz -= localNormal.z * proj * rate
        break
      }
      case 'pinch': {
        const mag = falloff * strength * 0.15 * sign
        nx += -dx * mag
        ny += -dy * mag
        nz += -dz * mag
        break
      }
      case 'crease': {
        const pmag = falloff * strength * 0.08
        nx += -dx * pmag + localNormal.x * s * 0.4
        ny += -dy * pmag + localNormal.y * s * 0.4
        nz += -dz * pmag + localNormal.z * s * 0.4
        break
      }
    }

    pos.setXYZ(i, nx, ny, nz)
  }

  pos.needsUpdate = true
  geo.computeVertexNormals()
}

// ── Smooth brush (average of neighbours) ──────────────────────────────────────
function applySmoothBrush(
  pos:      THREE.BufferAttribute,
  localHit: THREE.Vector3,
  radius:   number,
  strength: number,
) {
  const count = pos.count
  const snap  = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    snap[i * 3] = pos.getX(i); snap[i * 3 + 1] = pos.getY(i); snap[i * 3 + 2] = pos.getZ(i)
  }

  const r2  = radius * radius
  const nr2 = (radius * 0.4) * (radius * 0.4)

  for (let i = 0; i < count; i++) {
    const vx = snap[i * 3], vy = snap[i * 3 + 1], vz = snap[i * 3 + 2]
    const d2 = (vx - localHit.x) ** 2 + (vy - localHit.y) ** 2 + (vz - localHit.z) ** 2
    if (d2 >= r2) continue

    const t       = Math.sqrt(d2) / radius
    const falloff = (1 - t * t) * (1 - t * t)

    let ax = 0, ay = 0, az = 0, cnt = 0
    for (let j = 0; j < count; j++) {
      const jd2 = (snap[j*3]-vx)**2 + (snap[j*3+1]-vy)**2 + (snap[j*3+2]-vz)**2
      if (jd2 < nr2) { ax += snap[j*3]; ay += snap[j*3+1]; az += snap[j*3+2]; cnt++ }
    }
    if (cnt > 1) {
      ax /= cnt; ay /= cnt; az /= cnt
      const s = Math.min(strength * falloff, 0.85)
      pos.setXYZ(i, vx + (ax - vx) * s, vy + (ay - vy) * s, vz + (az - vz) * s)
    }
  }
}

// ── Move brush (drag vertices) ────────────────────────────────────────────────
function applyMoveBrush(
  geo:         THREE.BufferGeometry,
  worldMatrix: THREE.Matrix4,
  worldHit:    THREE.Vector3,
  worldDelta:  THREE.Vector3,
  radius:      number,
  strength:    number,
) {
  const pos    = geo.attributes.position as THREE.BufferAttribute
  const invMat = new THREE.Matrix4().copy(worldMatrix).invert()
  const scl    = new THREE.Vector3()
  worldMatrix.decompose(new THREE.Vector3(), new THREE.Quaternion(), scl)

  const localRadius = radius / Math.max(scl.x, 0.001)
  const localHit    = worldHit.clone().applyMatrix4(invMat)
  const localDelta  = worldDelta.clone().transformDirection(invMat)

  for (let i = 0; i < pos.count; i++) {
    const vx = pos.getX(i), vy = pos.getY(i), vz = pos.getZ(i)
    const dx = vx - localHit.x, dy = vy - localHit.y, dz = vz - localHit.z
    const dist2 = dx*dx + dy*dy + dz*dz
    if (dist2 >= localRadius * localRadius) continue

    const t       = Math.sqrt(dist2) / localRadius
    const falloff = (1 - t * t) * (1 - t * t)

    pos.setXYZ(i,
      vx + localDelta.x * falloff * strength * 1.8,
      vy + localDelta.y * falloff * strength * 1.8,
      vz + localDelta.z * falloff * strength * 1.8,
    )
  }

  pos.needsUpdate = true
  geo.computeVertexNormals()
}

// ── Vertex colors: init / brush ───────────────────────────────────────────────
// Ensures a `color` attribute (white by default → doesn't alter the material).
function ensureColorAttr(geo: THREE.BufferGeometry): THREE.BufferAttribute {
  let attr = geo.getAttribute('color') as THREE.BufferAttribute | undefined
  if (!attr || attr.count !== geo.attributes.position.count) {
    const n = geo.attributes.position.count
    const arr = new Float32Array(n * 3).fill(1)
    attr = new THREE.BufferAttribute(arr, 3)
    geo.setAttribute('color', attr)
  }
  return attr
}

// Paints vertex colors within the brush radius (additive blend).
function applyColorBrush(
  geo: THREE.BufferGeometry, worldMatrix: THREE.Matrix4, worldHit: THREE.Vector3,
  radius: number, rgb: [number, number, number], strength: number,
) {
  const pos = geo.attributes.position as THREE.BufferAttribute
  const col = ensureColorAttr(geo)
  const invMat = new THREE.Matrix4().copy(worldMatrix).invert()
  const scl = new THREE.Vector3()
  worldMatrix.decompose(new THREE.Vector3(), new THREE.Quaternion(), scl)
  const lr = radius / Math.max(scl.x, 0.001)
  const lh = worldHit.clone().applyMatrix4(invMat)
  for (let i = 0; i < pos.count; i++) {
    const dx = pos.getX(i) - lh.x, dy = pos.getY(i) - lh.y, dz = pos.getZ(i) - lh.z
    const d2 = dx * dx + dy * dy + dz * dz
    if (d2 >= lr * lr) continue
    const tt = Math.sqrt(d2) / lr
    const a = ((1 - tt * tt) ** 2) * strength
    col.setXYZ(i,
      col.getX(i) + (rgb[0] - col.getX(i)) * a,
      col.getY(i) + (rgb[1] - col.getY(i)) * a,
      col.getZ(i) + (rgb[2] - col.getZ(i)) * a)
  }
  col.needsUpdate = true
}

// Paints weights (scalar 0..1) into a parallel array.
function applyWeightBrush(
  weights: Float32Array, geo: THREE.BufferGeometry, worldMatrix: THREE.Matrix4,
  worldHit: THREE.Vector3, radius: number, value: number, strength: number,
) {
  const pos = geo.attributes.position as THREE.BufferAttribute
  const invMat = new THREE.Matrix4().copy(worldMatrix).invert()
  const scl = new THREE.Vector3()
  worldMatrix.decompose(new THREE.Vector3(), new THREE.Quaternion(), scl)
  const lr = radius / Math.max(scl.x, 0.001)
  const lh = worldHit.clone().applyMatrix4(invMat)
  for (let i = 0; i < pos.count; i++) {
    const dx = pos.getX(i) - lh.x, dy = pos.getY(i) - lh.y, dz = pos.getZ(i) - lh.z
    const d2 = dx * dx + dy * dy + dz * dz
    if (d2 >= lr * lr) continue
    const tt = Math.sqrt(d2) / lr
    const a = ((1 - tt * tt) ** 2) * strength
    weights[i] += (value - weights[i]) * a
  }
}

// Blender-style weight ramp: blue(0) → cyan → green → yellow → red(1).
function weightColor(w: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, w))
  if (x < 0.25) return [0, x / 0.25, 1]
  if (x < 0.5)  return [0, 1, 1 - (x - 0.25) / 0.25]
  if (x < 0.75) return [(x - 0.5) / 0.25, 1, 0]
  return [1, 1 - (x - 0.75) / 0.25, 0]
}
function writeWeightColors(geo: THREE.BufferGeometry, weights: Float32Array) {
  const col = ensureColorAttr(geo)
  for (let i = 0; i < weights.length; i++) {
    const [r, g, b] = weightColor(weights[i])
    col.setXYZ(i, r, g, b)
  }
  col.needsUpdate = true
}

// ── 3D cursor (ring on the surface) ───────────────────────────────────────────
function BrushCursor({
  point, normal, radius, visible,
}: {
  point:   THREE.Vector3 | null
  normal:  THREE.Vector3 | null
  radius:  number
  visible: boolean
}) {
  if (!visible || !point || !normal) return null

  const q = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 0, 1),
    normal.clone().normalize(),
  )

  return (
    <mesh position={point} quaternion={q} renderOrder={999}>
      <ringGeometry args={[radius * 0.88, radius, 48]} />
      <meshBasicMaterial color={C.accent} side={THREE.DoubleSide} transparent opacity={0.9} depthTest={false} />
    </mesh>
  )
}

// ── Selectable + sculptable/paintable mesh ────────────────────────────────────
interface SelectableMeshProps {
  obj:                SceneObject
  selected:           boolean
  mode:               Mode
  transformMode:      TransformMode
  sculptBrush:        SculptBrush
  brushRadius:        number
  brushStrength:      number
  paintColor:         string
  paintWeight:        number
  onSelect:           () => void
  onBeginEdit:        () => void      // record an undo snapshot before mutating
  onTransformStart:   () => void
  onTransformEnd:     () => void
  onCommit:           (patch: Partial<SceneObject>) => void
  onMeshCommit:       (mesh: MeshData) => void
  onCursorMove:       (pos: THREE.Vector3, normal: THREE.Vector3) => void
  onCursorClear:      () => void
  symmetry:           boolean
  wireframe:          boolean
  editElem:           EditElem
}

const TEX_SIZE = 1024

function SelectableMesh({
  obj, selected, mode, transformMode,
  sculptBrush, brushRadius, brushStrength, paintColor, paintWeight,
  onSelect, onBeginEdit, onTransformStart, onTransformEnd, onCommit, onMeshCommit,
  onCursorMove, onCursorClear, symmetry, wireframe, editElem,
}: SelectableMeshProps) {
  const [meshNode, setMeshNode] = useState<THREE.Mesh | null>(null)
  const transformRef = useRef<any>(null)
  const geoRef       = useRef<THREE.BufferGeometry>(buildGeometry(obj))
  const baseRef      = useRef<Float32Array | null>(null)   // pristine positions (reset target)
  const isPainting   = useRef(false)
  const dirtyRef     = useRef(false)                        // geometry/paint changed this stroke
  const invertRef    = useRef(false)
  const lastHit      = useRef<THREE.Vector3 | null>(null)
  // Persistent paint data per mesh.
  const vColorsRef   = useRef<Float32Array | null>(null)   // vertex paint colors
  const weightsRef   = useRef<Float32Array | null>(null)   // weights 0..1 (weight paint)
  const meshSeenRef  = useRef<MeshData | undefined>(obj.mesh)
  const [texture, setTexture] = useState<THREE.CanvasTexture | null>(null)
  const texCtxRef    = useRef<CanvasRenderingContext2D | null>(null)
  // Edit Mode element selection (vertex/edge/face) + drag-grab bookkeeping.
  const [editSel, setEditSel] = useState<EditSel>(EMPTY_SEL)
  const editSelRef   = useRef<EditSel>(EMPTY_SEL)
  const editElemRef  = useRef<EditElem>(editElem)
  const downFace     = useRef<{ a: number; b: number; c: number; point: THREE.Vector3; shift: boolean } | null>(null)
  const editMoved    = useRef(false)
  useEffect(() => { editSelRef.current = editSel }, [editSel])
  useEffect(() => { editElemRef.current = editElem }, [editElem])
  // Clear the selection when the object changes or we leave Edit Mode.
  useEffect(() => { setEditSel(EMPTY_SEL); editSelRef.current = EMPTY_SEL }, [obj.id, mode])

  const isPaintMode  = selected && PAINT_MODES.includes(mode)

  // Applies saved (or pristine) geometry + paint buffers to the live geometry.
  const applyMeshState = useCallback((mesh?: MeshData) => {
    const geo = geoRef.current
    const pos = geo.attributes.position as THREE.BufferAttribute
    if (mesh?.positions && mesh.positions.length === pos.count * 3) {
      (pos.array as Float32Array).set(mesh.positions)
      pos.needsUpdate = true
      geo.computeVertexNormals()
    } else if (!mesh?.positions && baseRef.current) {
      (pos.array as Float32Array).set(baseRef.current)
      pos.needsUpdate = true
      geo.computeVertexNormals()
    }
    const n = pos.count
    const col = ensureColorAttr(geo)
    vColorsRef.current = mesh?.colors && mesh.colors.length === n * 3
      ? Float32Array.from(mesh.colors) : new Float32Array(n * 3).fill(1)
    weightsRef.current = mesh?.weights && mesh.weights.length === n
      ? Float32Array.from(mesh.weights) : new Float32Array(n)
    if (mode === 'weight_paint') writeWeightColors(geo, weightsRef.current)
    else { (col.array as Float32Array).set(vColorsRef.current); col.needsUpdate = true }
  }, [mode])

  // Mount: capture the pristine base and apply any saved mesh state.
  useEffect(() => {
    baseRef.current = Float32Array.from(geoRef.current.attributes.position.array as Float32Array)
    applyMeshState(obj.mesh)
    return () => { geoRef.current.dispose() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Reapply when the mesh payload changes externally (undo/redo) — not mid-stroke.
  useEffect(() => {
    if (meshSeenRef.current === obj.mesh) return
    meshSeenRef.current = obj.mesh
    if (isPainting.current) return
    applyMeshState(obj.mesh)
  }, [obj.mesh, applyMeshState])

  // Switch the displayed color buffer with the mode:
  //  - weight_paint → weight ramp ; otherwise → vertex-paint colors.
  useEffect(() => {
    const geo = geoRef.current
    const col = ensureColorAttr(geo)
    if (mode === 'weight_paint' && weightsRef.current) {
      writeWeightColors(geo, weightsRef.current)
    } else if (vColorsRef.current) {
      ;(col.array as Float32Array).set(vColorsRef.current)
      col.needsUpdate = true
    }
  }, [mode])

  // Lazily create the paintable texture on first entry into Texture Paint,
  // seeding it from any saved texture.
  useEffect(() => {
    if (mode !== 'texture_paint' || texture) return
    const cv = document.createElement('canvas')
    cv.width = cv.height = TEX_SIZE
    const cx = cv.getContext('2d')!
    const finalize = () => {
      texCtxRef.current = cx
      const tex = new THREE.CanvasTexture(cv)
      tex.colorSpace = THREE.SRGBColorSpace
      setTexture(tex)
    }
    if (obj.mesh?.texture) {
      const img = new Image()
      img.onload  = () => { cx.drawImage(img, 0, 0, TEX_SIZE, TEX_SIZE); finalize() }
      img.onerror = () => { cx.fillStyle = obj.color ?? '#9aa7c4'; cx.fillRect(0, 0, TEX_SIZE, TEX_SIZE); finalize() }
      img.src = obj.mesh.texture
    } else {
      cx.fillStyle = obj.color ?? '#9aa7c4'
      cx.fillRect(0, 0, TEX_SIZE, TEX_SIZE)
      finalize()
    }
  }, [mode, texture, obj.color, obj.mesh])

  // Disable OrbitControls during the gizmo and commit the transform.
  useEffect(() => {
    const ctrl = transformRef.current
    if (!ctrl || !selected) return
    const handler = (e: { value: boolean }) => {
      if (e.value) { onBeginEdit(); onTransformStart(); return }
      onTransformEnd()
      if (meshNode) {
        const r = meshNode.rotation
        onCommit({
          position: [meshNode.position.x, meshNode.position.y, meshNode.position.z],
          rotation: [r.x, r.y, r.z],
          scale:    [meshNode.scale.x, meshNode.scale.y, meshNode.scale.z],
        })
      }
    }
    ctrl.addEventListener('dragging-changed', handler)
    return () => ctrl.removeEventListener('dragging-changed', handler)
  }, [selected, onBeginEdit, onTransformStart, onTransformEnd, onCommit, meshNode])

  const handleClick = useCallback((e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation()
    onSelect()
  }, [onSelect])

  // Applies one brush "dab" at the hovered point, per the current mode.
  const stroke = useCallback((e: ThreeEvent<PointerEvent>, wn: THREE.Vector3) => {
    if (!meshNode) return
    const M = meshNode.matrixWorld
    const cx = obj.position[0]
    const mirror = (p: THREE.Vector3) => new THREE.Vector3(2 * cx - p.x, p.y, p.z)
    dirtyRef.current = true
    if (mode === 'sculpt') {
      if (sculptBrush === 'move' && lastHit.current) {
        const delta = e.point.clone().sub(lastHit.current)
        applyMoveBrush(geoRef.current, M, e.point, delta, brushRadius, brushStrength)
        if (symmetry) applyMoveBrush(geoRef.current, M, mirror(e.point), new THREE.Vector3(-delta.x, delta.y, delta.z), brushRadius, brushStrength)
        lastHit.current = e.point.clone()
      } else {
        applyBrush(geoRef.current, M, e.point, wn, sculptBrush, brushRadius, brushStrength, invertRef.current)
        if (symmetry) applyBrush(geoRef.current, M, mirror(e.point), new THREE.Vector3(-wn.x, wn.y, wn.z), sculptBrush, brushRadius, brushStrength, invertRef.current)
      }
    } else if (mode === 'vertex_paint' && vColorsRef.current) {
      const c = new THREE.Color(invertRef.current ? '#ffffff' : paintColor)
      applyColorBrush(geoRef.current, M, e.point, brushRadius, [c.r, c.g, c.b], brushStrength)
      if (symmetry) applyColorBrush(geoRef.current, M, mirror(e.point), brushRadius, [c.r, c.g, c.b], brushStrength)
      ;(vColorsRef.current as Float32Array).set((geoRef.current.getAttribute('color') as THREE.BufferAttribute).array as Float32Array)
    } else if (mode === 'weight_paint' && weightsRef.current) {
      const val = invertRef.current ? 0 : paintWeight
      applyWeightBrush(weightsRef.current, geoRef.current, M, e.point, brushRadius, val, brushStrength)
      if (symmetry) applyWeightBrush(weightsRef.current, geoRef.current, M, mirror(e.point), brushRadius, val, brushStrength)
      writeWeightColors(geoRef.current, weightsRef.current)
    } else if (mode === 'texture_paint' && e.uv && texCtxRef.current && texture) {
      const ctx2 = texCtxRef.current
      const px = e.uv.x * TEX_SIZE, py = (1 - e.uv.y) * TEX_SIZE
      const rad = Math.max(3, brushRadius * 90)
      const g = ctx2.createRadialGradient(px, py, 0, px, py, rad)
      const c = new THREE.Color(paintColor)
      const hex = `rgb(${Math.round(c.r*255)},${Math.round(c.g*255)},${Math.round(c.b*255)})`
      g.addColorStop(0, hex); g.addColorStop(1, `rgba(${Math.round(c.r*255)},${Math.round(c.g*255)},${Math.round(c.b*255)},0)`)
      ctx2.globalAlpha = Math.min(1, brushStrength)
      ctx2.fillStyle = g
      ctx2.beginPath(); ctx2.arc(px, py, rad, 0, Math.PI * 2); ctx2.fill()
      ctx2.globalAlpha = 1
      texture.needsUpdate = true
    }
  }, [meshNode, mode, sculptBrush, brushRadius, brushStrength, symmetry, obj.position, paintColor, paintWeight, texture])

  // ── Edit Mode: pick the clicked element, building a fresh selection (or toggling
  // it with Shift). Vertex → nearest corner; Edge → nearest of the 3 face edges;
  // Face → the whole triangle. Edge/face entries drive the orange overlays.
  const pickEditElement = useCallback((face: { a: number; b: number; c: number; point: THREE.Vector3 }, shift: boolean) => {
    if (!meshNode) return
    const pos = geoRef.current.getAttribute('position') as THREE.BufferAttribute
    const world = (i: number) => new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(meshNode.matrixWorld)
    const corners = [face.a, face.b, face.c]
    let pick: EditSel
    if (editElemRef.current === 'vertex') {
      const nearest = corners.reduce((best, i) => world(i).distanceTo(face.point) < world(best).distanceTo(face.point) ? i : best, corners[0])
      pick = { v: [nearest], e: [], f: [] }
    } else if (editElemRef.current === 'edge') {
      const edges: [number, number][] = [[face.a, face.b], [face.b, face.c], [face.c, face.a]]
      const mid = (e: [number, number]) => world(e[0]).clone().add(world(e[1])).multiplyScalar(0.5)
      const ne = edges.reduce((best, e) => mid(e).distanceTo(face.point) < mid(best).distanceTo(face.point) ? e : best, edges[0])
      pick = { v: [ne[0], ne[1]], e: [ne[0], ne[1]], f: [] }
    } else {
      pick = { v: [face.a, face.b, face.c], e: [], f: [face.a, face.b, face.c] }
    }
    setEditSel(prev => {
      if (!shift) return pick
      // Toggle: drop the element if its first vertex is already selected, else add it.
      const has = pick.v.every(i => prev.v.includes(i))
      const next: EditSel = has
        ? { v: prev.v.filter(i => !pick.v.includes(i)), e: prev.e, f: prev.f }
        : { v: Array.from(new Set([...prev.v, ...pick.v])), e: [...prev.e, ...pick.e], f: [...prev.f, ...pick.f] }
      editSelRef.current = next
      return next
    })
    if (!shift) editSelRef.current = pick
  }, [meshNode])

  // Translate the selected vertices by a world-space delta (converted to local).
  const moveEditSelection = useCallback((worldFrom: THREE.Vector3, worldTo: THREE.Vector3) => {
    if (!meshNode) return
    const sel = editSelRef.current.v
    if (!sel.length) return
    const lf = meshNode.worldToLocal(worldFrom.clone())
    const lt = meshNode.worldToLocal(worldTo.clone())
    const d = lt.sub(lf)
    const pos = geoRef.current.getAttribute('position') as THREE.BufferAttribute
    const arr = pos.array as Float32Array
    for (const i of sel) { arr[i * 3] += d.x; arr[i * 3 + 1] += d.y; arr[i * 3 + 2] += d.z }
    pos.needsUpdate = true
    geoRef.current.computeVertexNormals()
    dirtyRef.current = true
  }, [meshNode])

  const handlePointerDown = useCallback((e: ThreeEvent<PointerEvent>) => {
    if (!isPaintMode || !meshNode || !e.face) return
    e.stopPropagation()
    if (mode === 'edit') {
      // Defer: a click (no drag) selects an element; a drag grabs the selection.
      isPainting.current = true
      editMoved.current  = false
      lastHit.current    = e.point.clone()
      downFace.current   = { a: e.face.a, b: e.face.b, c: e.face.c, point: e.point.clone(), shift: (e.nativeEvent as PointerEvent).shiftKey }
      return
    }
    onBeginEdit()                       // snapshot before the stroke modifies anything
    isPainting.current = true
    dirtyRef.current   = false
    invertRef.current  = e.buttons === 2
    lastHit.current    = e.point.clone()
    const wn = e.face.normal.clone().transformDirection(meshNode.matrixWorld).normalize()
    if (mode === 'sculpt' && sculptBrush === 'move') return  // move waits for the first drag
    stroke(e, wn)
  }, [isPaintMode, meshNode, mode, sculptBrush, stroke, onBeginEdit])

  const handlePointerMove = useCallback((e: ThreeEvent<PointerEvent>) => {
    if (!meshNode) return
    if (mode === 'edit') {
      if (isPainting.current && lastHit.current && editSelRef.current.v.length) {
        e.stopPropagation()
        if (!editMoved.current) { editMoved.current = true; onBeginEdit() }   // record once, at grab start
        moveEditSelection(lastHit.current, e.point)
        lastHit.current = e.point.clone()
      }
      return
    }
    const wn = e.face
      ? e.face.normal.clone().transformDirection(meshNode.matrixWorld).normalize()
      : new THREE.Vector3(0, 1, 0)
    if (isPaintMode) onCursorMove(e.point, wn)
    if (!isPainting.current || !isPaintMode) return
    e.stopPropagation()
    stroke(e, wn)
  }, [isPaintMode, meshNode, onCursorMove, stroke])

  // Commit the deformed mesh / paint buffers into scene state when a stroke ends.
  const stopPainting = useCallback(() => {
    if (mode === 'edit') {
      const moved = editMoved.current && dirtyRef.current
      if (!editMoved.current && downFace.current) {
        pickEditElement(downFace.current, downFace.current.shift)   // click → select element
      } else if (moved) {
        const mesh = serializeMesh(geoRef.current, obj.primType, vColorsRef.current, weightsRef.current, texCtxRef.current?.canvas ?? null, obj.mesh)
        meshSeenRef.current = mesh
        onMeshCommit(mesh)
      }
      isPainting.current = false
      editMoved.current  = false
      downFace.current   = null
      lastHit.current    = null
      dirtyRef.current   = false
      return
    }
    const wasDirty = isPainting.current && dirtyRef.current
    isPainting.current = false
    lastHit.current = null
    if (wasDirty) {
      const mesh = serializeMesh(
        geoRef.current, obj.primType,
        vColorsRef.current, weightsRef.current,
        texCtxRef.current?.canvas ?? null, obj.mesh,
      )
      meshSeenRef.current = mesh        // avoid the reapply effect re-running on our own commit
      onMeshCommit(mesh)
    }
    dirtyRef.current = false
  }, [mode, obj.primType, obj.mesh, onMeshCommit, pickEditElement])

  const showVertexColors = mode === 'vertex_paint' || mode === 'weight_paint'

  // Edit-Mode highlight overlays — geometries share the live position buffer so
  // selected verts/edges/faces follow the mesh as it is grabbed.
  const editHighlight = useMemo(() => {
    if (mode !== 'edit') return null
    const posAttr = geoRef.current.getAttribute('position')
    const mk = (indices: number[]) => {
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', posAttr)
      if (indices.length) g.setIndex(indices)
      g.setDrawRange(0, indices.length)
      return g
    }
    return { pts: mk(editSel.v), lines: mk(editSel.e), faces: mk(editSel.f) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, editSel, meshNode])

  return (
    <>
      <mesh
        ref={setMeshNode}
        geometry={geoRef.current}
        position={obj.position}
        rotation={obj.rotation ?? [0, 0, 0]}
        scale={obj.scale ?? [1, 1, 1]}
        onClick={handleClick}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={stopPainting}
        onPointerLeave={() => { stopPainting(); onCursorClear() }}
        onContextMenu={(e) => e.stopPropagation()}
      >
        <meshStandardMaterial
          key={obj.shadeFlat ? 'flat' : 'smooth'}
          color={showVertexColors ? '#ffffff' : (obj.color ?? (selected ? '#9dafc8' : '#7c8db5'))}
          map={mode === 'texture_paint' ? texture : null}
          vertexColors={showVertexColors}
          roughness={obj.roughness ?? 0.45}
          metalness={obj.metalness ?? 0.15}
          flatShading={obj.shadeFlat ?? false}
          side={THREE.DoubleSide}
          wireframe={wireframe || mode === 'edit'}
          emissive={selected && mode === 'object' ? C.accent : '#000000'}
          emissiveIntensity={selected && mode === 'object' ? 0.18 : 0}
        />
      </mesh>

      {/* Edit Mode: all vertices (Blender-style), shown only in vertex select. */}
      {selected && mode === 'edit' && editElem === 'vertex' && (
        <points geometry={geoRef.current} position={obj.position} rotation={obj.rotation ?? [0,0,0]} scale={obj.scale ?? [1,1,1]}>
          <pointsMaterial size={0.05} color={C.accent} sizeAttenuation depthTest={false} />
        </points>
      )}

      {/* Edit Mode: highlighted selection (orange) — points / edges / faces. */}
      {selected && mode === 'edit' && editHighlight && (
        <group position={obj.position} rotation={obj.rotation ?? [0,0,0]} scale={obj.scale ?? [1,1,1]}>
          {editSel.f.length > 0 && (
            <mesh geometry={editHighlight.faces}>
              <meshBasicMaterial color="#ff8c2b" transparent opacity={0.4} side={THREE.DoubleSide} depthTest={false} />
            </mesh>
          )}
          {editSel.e.length > 0 && (
            <lineSegments geometry={editHighlight.lines}>
              <lineBasicMaterial color="#ff8c2b" depthTest={false} />
            </lineSegments>
          )}
          {editSel.v.length > 0 && (
            <points geometry={editHighlight.pts}>
              <pointsMaterial size={0.11} color="#ff8c2b" sizeAttenuation depthTest={false} />
            </points>
          )}
        </group>
      )}

      {/* Transform gizmo (Object Mode only). */}
      {selected && mode === 'object' && meshNode && (
        <TransformControls ref={transformRef} object={meshNode} mode={transformMode} size={0.8} />
      )}
    </>
  )
}

// ── Focus rig: frames the selected object when the focus signal changes ────────
function FocusRig({ signal, target }: { signal: number; target: [number, number, number] | null }) {
  const { controls, camera } = useThree() as any
  const prev = useRef(signal)
  useEffect(() => {
    if (signal === prev.current) return
    prev.current = signal
    if (!target || !controls) return
    const t = new THREE.Vector3(...target)
    const offset = camera.position.clone().sub(controls.target)
    const dist = Math.max(offset.length(), 0.001)
    offset.normalize().multiplyScalar(Math.min(dist, 5))
    controls.target.copy(t)
    camera.position.copy(t.clone().add(offset))
    controls.update?.()
  }, [signal, target, controls, camera])
  return null
}

// ── 3D viewport ───────────────────────────────────────────────────────────────
interface ViewportProps {
  objects:       SceneObject[]
  selectedId:    string | null
  mode:          Mode
  transformMode: TransformMode
  sculptBrush:   SculptBrush
  brushRadius:   number
  brushStrength: number
  paintColor:    string
  paintWeight:   number
  cursorPos:     THREE.Vector3 | null
  cursorNormal:  THREE.Vector3 | null
  focusSignal:   number
  onSelect:      (id: string | null) => void
  onBeginEdit:   () => void
  onCommit:      (id: string, patch: Partial<SceneObject>) => void
  onMeshCommit:  (id: string, mesh: MeshData) => void
  onCursorMove:  (pos: THREE.Vector3, normal: THREE.Vector3) => void
  onCursorClear: () => void
  symmetry:      boolean
  wireframe:     boolean
  editElem:      EditElem
}

function Viewport({
  objects, selectedId, mode, transformMode,
  sculptBrush, brushRadius, brushStrength, paintColor, paintWeight,
  cursorPos, cursorNormal, focusSignal,
  onSelect, onBeginEdit, onCommit, onMeshCommit, onCursorMove, onCursorClear, symmetry, wireframe, editElem,
}: ViewportProps) {
  const [orbitEnabled, setOrbitEnabled] = useState(true)
  const selectedObj = objects.find(o => o.id === selectedId) ?? null

  return (
    <>
      <ambientLight intensity={0.35} />
      <directionalLight position={[5, 8, 5]} intensity={1.2} castShadow />
      <pointLight position={[-4, 4, -4]} intensity={0.6} color="#4fc3f7" />

      <Grid
        args={[20, 20]} cellSize={1} cellThickness={0.5}
        cellColor="#1e3a5f" sectionSize={5} sectionThickness={1}
        sectionColor="#0f3460" fadeDistance={30} fadeStrength={1} infiniteGrid
      />

      {objects.filter(o => o.visible).map((obj) => (
        <SelectableMesh
          // Remount on topology change (subdivide/decimate/import) so geometry rebuilds;
          // a plain sculpt keeps the vertex count, so the key — and the mesh — stays put.
          key={`${obj.id}:${obj.primType}:${obj.mesh?.positions?.length ?? 0}:${obj.mesh?.index?.length ?? 0}`}
          obj={obj}
          selected={obj.id === selectedId}
          mode={mode}
          transformMode={transformMode}
          sculptBrush={sculptBrush}
          brushRadius={brushRadius}
          brushStrength={brushStrength}
          paintColor={paintColor}
          paintWeight={paintWeight}
          onSelect={() => onSelect(obj.id)}
          onBeginEdit={onBeginEdit}
          onCommit={(patch) => onCommit(obj.id, patch)}
          onMeshCommit={(mesh) => onMeshCommit(obj.id, mesh)}
          onTransformStart={() => setOrbitEnabled(false)}
          onTransformEnd={() => setOrbitEnabled(true)}
          onCursorMove={onCursorMove}
          onCursorClear={onCursorClear}
          symmetry={symmetry}
          wireframe={wireframe}
          editElem={editElem}
        />
      ))}

      <BrushCursor
        point={cursorPos}
        normal={cursorNormal}
        radius={brushRadius}
        visible={PAINT_MODES.includes(mode) && mode !== 'edit' && !!selectedId}
      />

      <FocusRig signal={focusSignal} target={selectedObj?.position ?? null} />

      {/* Orbit: Object Mode uses the default LMB-rotate. Edit Mode frees the LMB
          for select/grab and orbits with the middle button (Blender-style).
          Wheel zoom stays available everywhere. */}
      <OrbitControls makeDefault
        enableRotate={orbitEnabled && (mode === 'object' || mode === 'edit')}
        enablePan={mode === 'object' || mode === 'edit'}
        mouseButtons={mode === 'edit'
          ? { LEFT: undefined as any, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN }
          : undefined} />

      <GizmoHelper alignment="bottom-right" margin={[72, 72]}>
        <GizmoViewport axisColors={['#ff3333', '#33ff33', '#3333ff']} labelColor="white" />
      </GizmoHelper>
    </>
  )
}

// ── Outliner ──────────────────────────────────────────────────────────────────
function OutlinerPanel({
  objects, selectedId, onSelect, onToggle, onDelete, onRowContextMenu,
}: {
  objects:    SceneObject[]
  selectedId: string | null
  onSelect:   (id: string) => void
  onToggle:   (id: string) => void
  onDelete:   (id: string) => void
  onRowContextMenu: (e: React.MouseEvent, obj: SceneObject) => void
}) {
  const { t } = useTranslation('paintsharp')
  return (
    <div className="flex flex-col h-full" style={{ background: C.bgPanel }}>
      <div className="flex items-center px-3 py-2 border-b" style={{ borderColor: C.border }}>
        <Layers size={13} style={{ color: C.textDim, marginRight: 6 }} />
        <span className="text-xs font-medium" style={{ color: C.text }}>{t('vertex_outliner_title')}</span>
        <span className="ml-auto text-xs" style={{ color: C.textDim }}>{objects.length}</span>
      </div>
      <div className="flex-1 overflow-y-auto">
        {objects.map((obj) => (
          <div
            key={obj.id}
            onClick={() => onSelect(obj.id)}
            onContextMenu={(e) => onRowContextMenu(e, obj)}
            className="flex items-center gap-1.5 px-3 py-1 cursor-pointer text-xs select-none"
            style={{
              background: obj.id === selectedId ? C.selected : 'transparent',
              color: obj.visible ? C.text : C.textDim,
            }}
          >
            <ChevronRight size={10} style={{ color: C.textDim, flexShrink: 0 }} />
            <Box size={11} style={{ color: C.accent, flexShrink: 0 }} />
            <span className="flex-1 truncate">{obj.name}</span>
            <button onClick={(e) => { e.stopPropagation(); onToggle(obj.id) }} style={{ color: C.textDim }}>
              {obj.visible ? <Eye size={11} /> : <EyeOff size={11} />}
            </button>
            <button onClick={(e) => { e.stopPropagation(); onDelete(obj.id) }} style={{ color: C.textDim }}>
              <Trash2 size={11} />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Properties ────────────────────────────────────────────────────────────────
function PropertiesPanel({ selected, onPatch, onSubdivide, onDecimate }: {
  selected: SceneObject | null
  onPatch: (p: Partial<SceneObject>) => void
  onSubdivide: () => void
  onDecimate: () => void
}) {
  const { t } = useTranslation('paintsharp')
  const [open, setOpen] = useState<Record<string, boolean>>({
    object: true, transform: true, material: true, mesh: true,
  })
  const toggle = (k: string) => setOpen(p => ({ ...p, [k]: !p[k] }))

  const Section = ({ id, title, children }: { id: string; title: string; children: React.ReactNode }) => (
    <div>
      <button onClick={() => toggle(id)} className="flex items-center gap-1 w-full mb-1.5">
        {open[id]
          ? <ChevronDown size={11} style={{ color: C.textDim }} />
          : <ChevronRight size={11} style={{ color: C.textDim }} />}
        <span className="text-[11px] font-medium uppercase tracking-wider" style={{ color: C.textDim }}>{title}</span>
      </button>
      {open[id] && <div className="space-y-1">{children}</div>}
    </div>
  )
  const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div className="flex items-center gap-2">
      <span className="text-[11px] w-20 flex-shrink-0" style={{ color: C.textDim }}>{label}</span>
      <div className="flex-1">{children}</div>
    </div>
  )
  const Num = ({ val, step = 0.1, onChange }: { val: number; step?: number; onChange?: (v: number) => void }) => (
    <input type="number" defaultValue={val} step={step}
           onChange={e => onChange?.(Number(e.target.value))}
           className="w-full px-1.5 py-0.5 rounded text-xs outline-none"
           style={{ background: C.bg, color: C.text, border: `1px solid ${C.border}` }} />
  )

  return (
    <div className="flex flex-col h-full" style={{ background: C.bgPanel }}>
      <div className="flex items-center px-3 py-2 border-b" style={{ borderColor: C.border }}>
        <Settings2 size={13} style={{ color: C.textDim, marginRight: 6 }} />
        <span className="text-xs font-medium" style={{ color: C.text }}>{t('vertex_properties_title')}</span>
      </div>
      <div className="flex-1 overflow-y-auto p-3">
        {!selected ? (
          <p className="text-xs" style={{ color: C.textDim }}>{t('vertex_select_object')}</p>
        ) : (
          <div className="space-y-3">
            <Section id="object" title={t('vertex_section_object')}>
              <Row label={t('vertex_field_name')}>
                <input defaultValue={selected.name} key={selected.id + 'n'}
                       onChange={e => onPatch({ name: e.target.value })}
                       className="w-full px-1.5 py-0.5 rounded text-xs outline-none"
                       style={{ background: C.bg, color: C.text, border: `1px solid ${C.border}` }} />
              </Row>
            </Section>
            <Section id="transform" title={t('vertex_section_transform')}>
              <Row label={t('vertex_pos_x')}><Num key={selected.id+'x'} val={selected.position[0]} onChange={v => onPatch({ position: [v, selected.position[1], selected.position[2]] })} /></Row>
              <Row label={t('vertex_pos_y')}><Num key={selected.id+'y'} val={selected.position[1]} onChange={v => onPatch({ position: [selected.position[0], v, selected.position[2]] })} /></Row>
              <Row label={t('vertex_pos_z')}><Num key={selected.id+'z'} val={selected.position[2]} onChange={v => onPatch({ position: [selected.position[0], selected.position[1], v] })} /></Row>
            </Section>
            <Section id="material" title={t('vertex_section_material')}>
              <Row label={t('vertex_field_color')}>
                <ColorField t={t} C={C} color={selected.color ?? '#7c8db5'} onChange={hex => onPatch({ color: hex })} height={20} style={{ width: '100%' }} />
              </Row>
              <Row label={t('vertex_field_roughness')}><Num key={selected.id+'r'} val={selected.roughness ?? 0.45} step={0.01} onChange={v => onPatch({ roughness: v })} /></Row>
              <Row label={t('vertex_field_metalness')}><Num key={selected.id+'m'} val={selected.metalness ?? 0.15} step={0.01} onChange={v => onPatch({ metalness: v })} /></Row>
              <Row label={t('vertex_field_shading', { defaultValue: 'Ombrage' })}>
                <div className="flex gap-1">
                  <button onClick={() => onPatch({ shadeFlat: false })}
                          className="flex-1 px-1.5 py-0.5 rounded text-[11px]"
                          style={{ background: !selected.shadeFlat ? C.accent + '33' : C.bg, color: !selected.shadeFlat ? C.accent : C.textDim, border: `1px solid ${!selected.shadeFlat ? C.accent : C.border}` }}>
                    {t('vertex_shade_smooth', { defaultValue: 'Lisse' })}
                  </button>
                  <button onClick={() => onPatch({ shadeFlat: true })}
                          className="flex-1 px-1.5 py-0.5 rounded text-[11px]"
                          style={{ background: selected.shadeFlat ? C.accent + '33' : C.bg, color: selected.shadeFlat ? C.accent : C.textDim, border: `1px solid ${selected.shadeFlat ? C.accent : C.border}` }}>
                    {t('vertex_shade_flat', { defaultValue: 'Plat' })}
                  </button>
                </div>
              </Row>
            </Section>
            <Section id="mesh" title={t('vertex_section_mesh', { defaultValue: 'Maillage' })}>
              <button onClick={onSubdivide}
                      className="flex items-center justify-center gap-1.5 w-full px-2 py-1 rounded text-[11px]"
                      style={{ background: C.bg, color: C.text, border: `1px solid ${C.border}` }}>
                <Grid3x3 size={12} /> {t('vertex_subdivide', { defaultValue: 'Subdiviser' })}
              </button>
              <button onClick={onDecimate}
                      className="flex items-center justify-center gap-1.5 w-full px-2 py-1 rounded text-[11px]"
                      style={{ background: C.bg, color: C.text, border: `1px solid ${C.border}` }}>
                <Minimize2 size={12} /> {t('vertex_decimate', { defaultValue: 'Décimer' })}
              </button>
            </Section>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Brush panel ───────────────────────────────────────────────────────────────
const BRUSH_LIST: Array<{
  id:       SculptBrush
  labelKey: string
  tipKey:   string
  Icon:     React.ComponentType<{ size?: number; style?: React.CSSProperties }>
  color:    string
}> = [
  { id: 'clay',    labelKey: 'vertex_brush_clay',    tipKey: 'vertex_brush_clay_tip',    Icon: Layers,    color: '#e8824a' },
  { id: 'draw',    labelKey: 'vertex_brush_draw',    tipKey: 'vertex_brush_draw_tip',    Icon: Pen,       color: '#7c8db5' },
  { id: 'move',    labelKey: 'vertex_brush_move',    tipKey: 'vertex_brush_move_tip',    Icon: Hand,      color: '#4fc3f7' },
  { id: 'smooth',  labelKey: 'vertex_brush_smooth',  tipKey: 'vertex_brush_smooth_tip',  Icon: Wind,      color: '#a8d8ea' },
  { id: 'flatten', labelKey: 'vertex_brush_flatten', tipKey: 'vertex_brush_flatten_tip', Icon: Minus,     color: '#b8e994' },
  { id: 'inflate', labelKey: 'vertex_brush_inflate', tipKey: 'vertex_brush_inflate_tip', Icon: Plus,      color: '#f8c291' },
  { id: 'pinch',   labelKey: 'vertex_brush_pinch',   tipKey: 'vertex_brush_pinch_tip',   Icon: Minimize2, color: '#82ccdd' },
  { id: 'crease',  labelKey: 'vertex_brush_crease',  tipKey: 'vertex_brush_crease_tip',  Icon: Scissors,  color: '#cf6a87' },
]

function BrushPanel({
  sculptBrush, brushRadius, brushStrength,
  onBrush, onRadius, onStrength,
}: {
  sculptBrush:   SculptBrush
  brushRadius:   number
  brushStrength: number
  onBrush:       (b: SculptBrush) => void
  onRadius:      (v: number) => void
  onStrength:    (v: number) => void
}) {
  const { t } = useTranslation('paintsharp')
  const current = BRUSH_LIST.find(b => b.id === sculptBrush)!

  return (
    <div className="flex flex-col h-full" style={{ background: C.bgPanel }}>
      {/* Header */}
      <div className="flex items-center px-3 py-2 border-b" style={{ borderColor: C.border }}>
        <Brush size={13} style={{ color: C.textDim, marginRight: 6 }} />
        <span className="text-xs font-medium" style={{ color: C.text }}>{t('vertex_brushes_title')}</span>
      </div>

      {/* Active brush */}
      <div className="px-3 py-2 border-b" style={{ borderColor: C.border }}>
        <div className="flex items-center gap-2 mb-2">
          <div className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0"
               style={{ background: current.color }}>
            <current.Icon size={13} style={{ color: '#fff' }} />
          </div>
          <div>
            <p className="text-xs font-medium" style={{ color: C.text }}>{t(current.labelKey)}</p>
            <p className="text-[10px] leading-tight" style={{ color: C.textDim }}>{t(current.tipKey)}</p>
          </div>
        </div>

        {/* Radius */}
        <div className="mb-2">
          <div className="flex justify-between mb-0.5">
            <span className="text-[11px]" style={{ color: C.textDim }}>{t('vertex_radius')}</span>
            <span className="text-[11px] font-mono" style={{ color: C.accent }}>{brushRadius.toFixed(2)}</span>
          </div>
          <RangeSlider min={0.08} max={2} step={0.01} value={brushRadius}
                 onChange={onRadius}
                 className="w-full" accent={C.accent} trackColor="rgba(255,255,255,0.15)" aria-label={t('vertex_radius')} />
        </div>

        {/* Strength */}
        <div>
          <div className="flex justify-between mb-0.5">
            <span className="text-[11px]" style={{ color: C.textDim }}>{t('vertex_strength')}</span>
            <span className="text-[11px] font-mono" style={{ color: C.accent }}>{Math.round(brushStrength * 100)}%</span>
          </div>
          <RangeSlider min={0.02} max={1} step={0.01} value={brushStrength}
                 onChange={onStrength}
                 className="w-full" accent={C.accent} trackColor="rgba(255,255,255,0.15)" aria-label={t('vertex_strength')} />
        </div>
      </div>

      {/* Brush grid */}
      <div className="flex-1 overflow-y-auto p-2">
        <div className="grid grid-cols-2 gap-1.5">
          {BRUSH_LIST.map(({ id, labelKey, Icon, color }) => (
            <button
              key={id}
              onClick={() => onBrush(id)}
              title={t(labelKey)}
              className="flex flex-col items-center gap-1 py-2 rounded transition-all"
              style={{
                background:  sculptBrush === id ? `${color}20` : 'transparent',
                border:      `1px solid ${sculptBrush === id ? color : C.border}`,
                outline:     'none',
              }}
            >
              <div className="w-9 h-9 rounded-full flex items-center justify-center"
                   style={{ background: sculptBrush === id ? color : C.bg }}>
                <Icon size={15} style={{ color: sculptBrush === id ? '#fff' : color }} />
              </div>
              <span className="text-[10px]" style={{ color: sculptBrush === id ? C.text : C.textDim }}>
                {t(labelKey)}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Legend */}
      <div className="px-3 py-2 border-t" style={{ borderColor: C.border }}>
        <p className="text-[10px] leading-snug" style={{ color: C.textDim }}>
          {t('vertex_legend_left_click')}<br />
          {t('vertex_legend_right_click')}<br />
          <span style={{ color: C.accent }}>{t('vertex_legend_select_mode')}</span>
        </p>
      </div>
    </div>
  )
}

// ── Left toolbar ──────────────────────────────────────────────────────────────
function ToolbarLeft({
  mode, transformMode, onMode, onTransform,
}: {
  mode:          Mode
  transformMode: TransformMode
  onMode:        (m: Mode) => void
  onTransform:   (m: TransformMode) => void
}) {
  const { t } = useTranslation('paintsharp')
  const Btn = ({ active, onClick, title, children }: {
    active: boolean; onClick: () => void; title: string; children: React.ReactNode
  }) => (
    <button
      onClick={onClick}
      title={title}
      className="w-8 h-8 flex items-center justify-center rounded transition-colors"
      style={{ background: active ? C.accent : 'transparent', color: active ? '#fff' : C.textDim }}
    >
      {children}
    </button>
  )

  const Sep = () => <div className="w-6 h-px my-1" style={{ background: C.border }} />

  return (
    <>
      {/* Transforms (Object Mode) */}
      <span className="text-[9px] uppercase tracking-widest mb-0.5" style={{ color: C.textDim }}>{t('vertex_group_object')}</span>
      <Btn active={mode === 'object' && transformMode === 'translate'}
           onClick={() => { onMode('object'); onTransform('translate') }}
           title={`${t('vertex_tool_move')} (G)`}>
        <Move size={14} />
      </Btn>
      <Btn active={mode === 'object' && transformMode === 'rotate'}
           onClick={() => { onMode('object'); onTransform('rotate') }}
           title={`${t('vertex_tool_rotate')} (R)`}>
        <RotateCw size={14} />
      </Btn>
      <Btn active={mode === 'object' && transformMode === 'scale'}
           onClick={() => { onMode('object'); onTransform('scale') }}
           title={`${t('vertex_tool_scale')} (S)`}>
        <Maximize2 size={14} />
      </Btn>

      <Sep />

      {/* Mode shortcuts (the full selector lives in the options bar) */}
      <Btn active={mode === 'edit'}         onClick={() => onMode('edit')}         title={`${t('vertex_mode_edit')} (2 / Tab)`}><Waypoints size={15} /></Btn>
      <Btn active={mode === 'sculpt'}       onClick={() => onMode('sculpt')}       title={`${t('vertex_mode_sculpt_m')} (3)`}><Brush size={15} /></Btn>
      <Btn active={mode === 'vertex_paint'} onClick={() => onMode('vertex_paint')} title={`${t('vertex_mode_vpaint')} (4)`}><Palette size={15} /></Btn>
      <Btn active={mode === 'weight_paint'} onClick={() => onMode('weight_paint')} title={`${t('vertex_mode_wpaint')} (5)`}><Weight size={15} /></Btn>
      <Btn active={mode === 'texture_paint'}onClick={() => onMode('texture_paint')}title={`${t('vertex_mode_tpaint')} (6)`}><ImageIcon size={15} /></Btn>

      <Sep />

      {/* Quick lighting */}
      <Btn active={false} onClick={() => {}} title={t('vertex_tool_light')}>
        <Sun size={13} style={{ color: C.textDim }} />
      </Btn>
    </>
  )
}

// ── Blender-style mode selector ───────────────────────────────────────────────
const MODE_LIST: { id: Mode; labelKey: string; Icon: React.ComponentType<{ size?: number; style?: React.CSSProperties }> }[] = [
  { id: 'object',        labelKey: 'vertex_mode_object', Icon: MousePointer2 },
  { id: 'edit',          labelKey: 'vertex_mode_edit',   Icon: Waypoints },
  { id: 'sculpt',        labelKey: 'vertex_mode_sculpt_m', Icon: Brush },
  { id: 'vertex_paint',  labelKey: 'vertex_mode_vpaint', Icon: Palette },
  { id: 'weight_paint',  labelKey: 'vertex_mode_wpaint', Icon: Weight },
  { id: 'texture_paint', labelKey: 'vertex_mode_tpaint', Icon: ImageIcon },
]

function ModeDropdown({ mode, onMode }: { mode: Mode; onMode: (m: Mode) => void }) {
  const { t } = useTranslation('paintsharp')
  const [open, setOpen] = useState(false)
  const cur = MODE_LIST.find(m => m.id === mode)!
  return (
    <div className="relative" style={{ minWidth: 150 }}>
      <button onClick={() => setOpen(v => !v)} onBlur={() => setTimeout(() => setOpen(false), 150)}
        className="flex items-center gap-2 px-2.5 h-7 rounded text-[12px] w-full"
        style={{ background: C.panel, color: C.text, border: `1px solid ${C.border}` }}>
        <cur.Icon size={14} style={{ color: C.accent }} />
        <span className="flex-1 text-left">{t(cur.labelKey)}</span>
        <ChevronDown size={13} style={{ color: C.textDim }} />
      </button>
      {open && (
        <div className="absolute left-0 mt-1 py-1 rounded shadow-2xl"
             style={{ minWidth: 200, zIndex: 60, background: C.panel, border: `1px solid ${C.border}` }}>
          {MODE_LIST.map(m => (
            <button key={m.id}
              onMouseDown={() => { onMode(m.id); setOpen(false) }}
              className="flex items-center gap-2 w-full px-3 h-8 text-left text-[12px]"
              style={{ color: m.id === mode ? C.accent : C.text, background: m.id === mode ? C.accent + '22' : 'transparent' }}
              onMouseEnter={e => { if (m.id !== mode) (e.currentTarget as HTMLElement).style.background = C.selected }}
              onMouseLeave={e => { if (m.id !== mode) (e.currentTarget as HTMLElement).style.background = 'transparent' }}>
              <m.Icon size={14} style={{ color: m.id === mode ? C.accent : C.textDim }} />
              {t(m.labelKey)}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Add-primitive toolbar ─────────────────────────────────────────────────────
function AddPrimitivesToolbar({ onAdd }: { onAdd: (type: PrimType) => void }) {
  const { t } = useTranslation('paintsharp')
  type LIcon = React.ComponentType<{ size?: number; style?: React.CSSProperties }>
  const items: [PrimType, string, LIcon][] = [
    ['box',       t('vertex_prim_box'),      Box       as LIcon],
    ['sphere',    t('vertex_prim_sphere'),   Circle    as LIcon],
    ['cylinder',  t('vertex_prim_cylinder'), RotateCw  as LIcon],
    ['torus',     t('vertex_prim_torus'),    Maximize2 as LIcon],
    ['cone',      t('vertex_prim_cone',      { defaultValue: 'Cône' }),      Triangle as LIcon],
    ['plane',     t('vertex_prim_plane',     { defaultValue: 'Plan' }),      Square   as LIcon],
    ['icosphere', t('vertex_prim_icosphere', { defaultValue: 'Icosphère' }), Hexagon  as LIcon],
  ]

  return (
    <>
      <span className="text-[11px] mr-2 font-medium" style={{ color: C.textDim }}>{t('vertex_add_label')}</span>
      {items.map(([type, label, Icon]) => (
        <button
          key={type}
          onClick={() => onAdd(type)}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs transition-colors"
          style={{ color: C.textDim }}
          onMouseEnter={e => (e.currentTarget.style.background = C.selected)}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
        >
          <Icon size={13} style={{ color: C.accent }} />
          {label}
        </button>
      ))}
      <div className="flex-1" />
    </>
  )
}

// ── Mesh export / import ──────────────────────────────────────────────────────
// Builds a transient THREE.Group from the visible scene objects for exporting.
function buildExportGroup(objects: SceneObject[]): THREE.Group {
  const group = new THREE.Group()
  for (const o of objects.filter(x => x.visible)) {
    const geo = buildGeometry(o)
    if (o.mesh?.positions && o.mesh.positions.length === geo.attributes.position.count * 3) {
      (geo.attributes.position.array as Float32Array).set(o.mesh.positions)
      geo.attributes.position.needsUpdate = true
      geo.computeVertexNormals()
    }
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(o.color ?? '#7c8db5'),
      roughness: o.roughness ?? 0.45, metalness: o.metalness ?? 0.15,
    })
    const m = new THREE.Mesh(geo, mat)
    m.position.set(...o.position)
    if (o.rotation) m.rotation.set(...o.rotation)
    if (o.scale)    m.scale.set(...o.scale)
    m.name = o.name
    group.add(m)
  }
  return group
}

// Loads an imported file into one or more SceneObjects (primType 'custom').
async function importMeshFile(file: File): Promise<SceneObject[]> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  const base = file.name.replace(/\.[^.]+$/, '')

  const toObject = (geo: THREE.BufferGeometry, name: string, i: number): SceneObject => {
    geo = geo.index ? geo.toNonIndexed().clone() : geo
    // Re-index to share vertices so sculpting stays watertight.
    let g = mergeVertices(geo)
    g.computeBoundingBox()
    const bb = g.boundingBox!
    const c = new THREE.Vector3(); bb.getCenter(c)
    const size = new THREE.Vector3(); bb.getSize(size)
    const maxd = Math.max(size.x, size.y, size.z) || 1
    const s = 1.6 / maxd
    g.translate(-c.x, -c.y, -c.z)
    g.scale(s, s, s)
    g.computeVertexNormals()
    const pos = g.attributes.position as THREE.BufferAttribute
    const uv  = g.getAttribute('uv') as THREE.BufferAttribute | undefined
    const idx = g.getIndex()
    return {
      id: `obj-${Date.now()}-${i}`,
      name,
      primType: 'custom',
      visible: true,
      position: [0, (size.y * s) / 2, 0],
      mesh: {
        positions: Array.from(pos.array as ArrayLike<number>),
        index: idx ? Array.from(idx.array as ArrayLike<number>) : undefined,
        uvs: uv ? Array.from(uv.array as ArrayLike<number>) : undefined,
      },
    }
  }

  if (ext === 'obj') {
    const txt = await file.text()
    const mod = await import('three/examples/jsm/loaders/OBJLoader.js')
    const grp = new mod.OBJLoader().parse(txt) as THREE.Group
    const out: SceneObject[] = []
    grp.traverse((n: any) => { if (n.isMesh) out.push(toObject(n.geometry, n.name || base, out.length)) })
    return out
  }
  if (ext === 'stl') {
    const buf = await file.arrayBuffer()
    const mod = await import('three/examples/jsm/loaders/STLLoader.js')
    const geo = new mod.STLLoader().parse(buf) as THREE.BufferGeometry
    return [toObject(geo, base, 0)]
  }
  if (ext === 'glb' || ext === 'gltf') {
    const buf = await file.arrayBuffer()
    const mod = await import('three/examples/jsm/loaders/GLTFLoader.js')
    const loader = new mod.GLTFLoader()
    const gltf: any = await new Promise((resolve, reject) => loader.parse(buf, '', resolve, reject))
    const out: SceneObject[] = []
    gltf.scene.traverse((n: any) => { if (n.isMesh) out.push(toObject(n.geometry, n.name || base, out.length)) })
    return out
  }
  throw new Error(`Unsupported format: ${ext}`)
}

// ── Main Vertex page ──────────────────────────────────────────────────────────
export default function VertexEditorPage() {
  const { t } = useTranslation('paintsharp')
  const { id }   = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [mode,          setMode]          = useState<Mode>('object')
  const [editElem,      setEditElem]      = useState<EditElem>('vertex')
  const [transformMode, setTransformMode] = useState<TransformMode>('translate')
  const [sculptBrush,   setSculptBrush]   = useState<SculptBrush>('clay')
  const [brushRadius,   setBrushRadius]   = useState(0.55)
  const [brushStrength, setBrushStrength] = useState(0.5)
  const [paintColor,    setPaintColor]    = useState('#e8543a')
  const [paintWeight,   setPaintWeight]   = useState(1)
  const [symmetry,      setSymmetry]      = useState(false)
  const [wireframe,     setWireframe]     = useState(false)
  const [selectedId,    setSelectedId]    = useState<string | null>(null)
  const [cursorPos,     setCursorPos]     = useState<THREE.Vector3 | null>(null)
  const [cursorNormal,  setCursorNormal]  = useState<THREE.Vector3 | null>(null)
  const [focusSignal,   setFocusSignal]   = useState(0)
  const [ready,         setReady]         = useState(false)   // scene loaded → autosave armed
  const [objects,       setObjects]       = useState<SceneObject[]>([
    { id: 'default-0', name: t('vertex_prim_sphere'), primType: 'sphere', visible: true, position: [0, 0.8, 0] },
  ])
  const fileInputRef = useRef<HTMLInputElement>(null)

  const { data: scene, isLoading } = useQuery({
    queryKey: ['paintsharp-scene', id],
    queryFn:  () => id ? paintsharpApi.getScene(id).then(r => r.data) : null,
    enabled:  !!id,
  })

  const qc = useQueryClient()

  // ── Undo / redo history ──────────────────────────────────────────────────────
  const objectsRef = useRef(objects)
  useEffect(() => { objectsRef.current = objects }, [objects])
  const past   = useRef<SceneObject[][]>([])
  const future = useRef<SceneObject[][]>([])
  const [, bumpHist] = useState(0)
  const HIST_CAP = 25

  const record = useCallback(() => {
    past.current.push(structuredClone(objectsRef.current))
    if (past.current.length > HIST_CAP) past.current.shift()
    future.current = []
    bumpHist(v => v + 1)
  }, [])

  const undo = useCallback(() => {
    if (!past.current.length) return
    future.current.push(structuredClone(objectsRef.current))
    const prev = past.current.pop()!
    setObjects(prev)
    setSelectedId(s => (s && prev.some(o => o.id === s)) ? s : null)
    bumpHist(v => v + 1)
  }, [])

  const redo = useCallback(() => {
    if (!future.current.length) return
    past.current.push(structuredClone(objectsRef.current))
    const next = future.current.pop()!
    setObjects(next)
    setSelectedId(s => (s && next.some(o => o.id === s)) ? s : null)
    bumpHist(v => v + 1)
  }, [])

  // ── Load the persisted scene once per id ─────────────────────────────────────
  const loadedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!id || loadedRef.current === id) return
    if (isLoading) return
    loadedRef.current = id
    const sj = scene?.scene_json as { objects?: SceneObject[] } | undefined
    if (sj?.objects && Array.isArray(sj.objects) && sj.objects.length) {
      setObjects(sj.objects)
      setSelectedId(null)
    }
    past.current = []
    future.current = []
    setReady(true)
  }, [id, scene, isLoading])

  // ── Editable title (standard WorkspaceShell) — synced from the scene ──────────
  const [titleDraft, setTitleDraft] = useState('')
  useEffect(() => { if (scene?.title != null) setTitleDraft(scene.title) }, [scene?.title])
  const renameMut = useMutation({
    mutationFn: (title: string) => paintsharpApi.updateScene(id!, { title }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['paintsharp-scene', id] }) },
  })
  const starMut = useMutation({
    mutationFn: (is_starred: boolean) => paintsharpApi.updateScene(id!, { is_starred }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['paintsharp-scene', id] }) },
  })
  const trashMut = useMutation({
    mutationFn: () => paintsharpApi.trashScene(id!),
    onSuccess: () => { navigate('/paintsharp') },
  })
  const commitTitle = () => {
    const v = titleDraft.trim()
    if (v && v !== scene?.title) renameMut.mutate(v)
    else if (!v && scene?.title) setTitleDraft(scene.title)
  }

  // Approximate poly counts for the scene summary.
  const countStats = useCallback((objs: SceneObject[]) => {
    let v = 0, f = 0
    for (const o of objs) {
      const g = buildGeometry(o)
      v += g.attributes.position.count
      const idx = g.getIndex()
      f += idx ? idx.count / 3 : g.attributes.position.count / 3
      g.dispose()
    }
    return { v: Math.round(v), f: Math.round(f) }
  }, [])

  const saveMut = useMutation({
    mutationFn: async (sceneJson: { objects: SceneObject[] }) => {
      if (!id) return
      const { v, f } = countStats(sceneJson.objects)
      await paintsharpApi.updateScene(id, {
        scene_json:   sceneJson,
        vertex_count: v,
        face_count:   f,
      })
    },
  })

  const selectedObj = objects.find(o => o.id === selectedId) ?? null
  const ctx = useContextMenu()

  const addObject = useCallback((primType: PrimType) => {
    const labels: Record<PrimType, string> = {
      box:       t('vertex_prim_box'),
      sphere:    t('vertex_prim_sphere'),
      cylinder:  t('vertex_prim_cylinder'),
      torus:     t('vertex_prim_torus'),
      cone:      t('vertex_prim_cone',      { defaultValue: 'Cône' }),
      plane:     t('vertex_prim_plane',     { defaultValue: 'Plan' }),
      icosphere: t('vertex_prim_icosphere', { defaultValue: 'Icosphère' }),
      custom:    t('vertex_prim_custom',    { defaultValue: 'Maillage' }),
    }
    record()
    const newObj: SceneObject = {
      id:       `obj-${Date.now()}`,
      name:     labels[primType],
      primType,
      visible:  true,
      position: [(Math.random() - 0.5) * 4, 0.8, (Math.random() - 0.5) * 4],
    }
    setObjects(prev => [...prev, newObj])
    setSelectedId(newObj.id)
  }, [t, record])

  const toggleVisibility = useCallback((tid: string) => {
    record()
    setObjects(prev => prev.map(o => o.id === tid ? { ...o, visible: !o.visible } : o))
  }, [record])

  const deleteObject = useCallback((tid: string) => {
    record()
    setObjects(prev => prev.filter(o => o.id !== tid))
    setSelectedId(prev => prev === tid ? null : prev)
  }, [record])

  const duplicateObject = useCallback((tid: string) => {
    record()
    setObjects(prev => {
      const src = prev.find(o => o.id === tid)
      if (!src) return prev
      const copy: SceneObject = {
        ...structuredClone(src),
        id:   `obj-${Date.now()}`,
        name: `${src.name} copy`,
        position: [src.position[0] + 0.6, src.position[1], src.position[2] + 0.6],
      }
      setSelectedId(copy.id)
      return [...prev, copy]
    })
  }, [record])

  // Property/transform edits (record an undo step first).
  const updateObject = useCallback((tid: string | null, patch: Partial<SceneObject>) => {
    if (!tid) return
    record()
    setObjects(prev => prev.map(o => o.id === tid ? { ...o, ...patch } : o))
  }, [record])

  // Transform gizmo commit — the snapshot was already taken on drag start.
  const commitTransform = useCallback((tid: string, patch: Partial<SceneObject>) => {
    setObjects(prev => prev.map(o => o.id === tid ? { ...o, ...patch } : o))
  }, [])

  // Sculpt/paint stroke commit — snapshot already taken on pointer-down.
  const commitMesh = useCallback((tid: string, mesh: MeshData) => {
    setObjects(prev => prev.map(o => o.id === tid ? { ...o, mesh } : o))
  }, [])

  // Mesh modifiers: rebuild topology, baking the object into a custom mesh. Paint
  // buffers (colors/weights/texture) are dropped since the vertex set changes.
  const remesh = useCallback(async (tid: string, op: 'subdivide' | 'decimate') => {
    const obj = objectsRef.current.find(o => o.id === tid)
    if (!obj) return
    const src = buildGeometry(obj)
    // buildGeometry yields the pristine primitive; re-apply any sculpted positions
    // so the modifier operates on the deformed mesh, not the original shape.
    if (obj.mesh?.positions) {
      const pos = src.attributes.position as THREE.BufferAttribute
      if (obj.mesh.positions.length === pos.count * 3) {
        (pos.array as Float32Array).set(obj.mesh.positions)
        pos.needsUpdate = true
        src.computeVertexNormals()
      }
    }
    try {
      const out = op === 'subdivide' ? await subdivideGeometry(src) : await decimateGeometry(src, 0.4)
      const mesh = geometryToMeshData(out)
      out.dispose()
      record()
      setObjects(prev => prev.map(o => o.id === tid ? { ...o, primType: 'custom', mesh } : o))
    } catch (err) {
      console.error('Vertex remesh failed', err)
    } finally {
      src.dispose()
    }
  }, [record])

  const handleCursorMove = useCallback((pos: THREE.Vector3, normal: THREE.Vector3) => {
    setCursorPos(pos.clone())
    setCursorNormal(normal.clone())
  }, [])

  const handleCursorClear = useCallback(() => {
    setCursorPos(null)
    setCursorNormal(null)
  }, [])

  // ── Mesh import / export ─────────────────────────────────────────────────────
  const download = useCallback((data: BlobPart, mime: string, ext: string) => {
    const blob = new Blob([data], { type: mime })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${(scene?.title || 'vertex')}${ext}`
    a.click()
    URL.revokeObjectURL(url)
  }, [scene?.title])

  const exportMesh = useCallback(async (format: 'obj' | 'stl' | 'gltf') => {
    const group = buildExportGroup(objectsRef.current)
    if (format === 'obj') {
      const mod = await import('three/examples/jsm/exporters/OBJExporter.js')
      download(new mod.OBJExporter().parse(group), 'text/plain', '.obj')
    } else if (format === 'stl') {
      const mod = await import('three/examples/jsm/exporters/STLExporter.js')
      download(new mod.STLExporter().parse(group), 'model/stl', '.stl')
    } else {
      const mod = await import('three/examples/jsm/exporters/GLTFExporter.js')
      new mod.GLTFExporter().parse(group, (res: any) => {
        download(JSON.stringify(res), 'model/gltf+json', '.gltf')
      }, () => {}, {})
    }
  }, [download])

  const handleImportFile = useCallback(async (file: File) => {
    try {
      const objs = await importMeshFile(file)
      if (!objs.length) return
      record()
      setObjects(prev => [...prev, ...objs])
      setSelectedId(objs[0].id)
    } catch (err) {
      console.error('Vertex import failed', err)
    }
  }, [record])

  // ── Keyboard shortcuts (Blender-style) ───────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      const ctrlKey = e.ctrlKey || e.metaKey
      const k = e.key.toLowerCase()
      if (ctrlKey) {
        if (k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo() }
        else if (k === 'y') { e.preventDefault(); redo() }
        else if (k === 'd') { e.preventDefault(); if (selectedId) duplicateObject(selectedId) }
        else if (k === 's') { e.preventDefault(); saveMut.mutate({ objects: objectsRef.current }) }
        return
      }
      // In Edit Mode, 1/2/3 pick the select element (Blender), not the top-level mode.
      if (mode === 'edit' && (e.key === '1' || e.key === '2' || e.key === '3')) {
        setEditElem(e.key === '1' ? 'vertex' : e.key === '2' ? 'edge' : 'face')
        return
      }
      switch (e.key) {
        case 'g': setMode('object'); setTransformMode('translate'); break
        case 'r': setMode('object'); setTransformMode('rotate'); break
        case 's': setMode('object'); setTransformMode('scale'); break
        case 'Tab': e.preventDefault(); setMode(m => m === 'edit' ? 'object' : 'edit'); break
        case 'x': case 'Delete': if (selectedId) deleteObject(selectedId); break
        case 'm': setSymmetry(v => !v); break
        case 'z': setWireframe(v => !v); break
        case 'f': setFocusSignal(s => s + 1); break
        case '1': setMode('object'); break
        case '2': setMode('edit'); break
        case '3': setMode('sculpt'); break
        case '4': setMode('vertex_paint'); break
        case '5': setMode('weight_paint'); break
        case '6': setMode('texture_paint'); break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mode, selectedId, undo, redo, duplicateObject, deleteObject, saveMut])

  // Autosave (debounced) — armed only once the scene has loaded.
  useDebouncedAutosave(objects, ready && !!id, (d) => saveMut.mutate({ objects: d }))

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full" style={{ background: C.bg }}>
        <p style={{ color: C.textDim }} className="text-sm">{t('common_loading')}</p>
      </div>
    )
  }

  const onRowContextMenu = (e: React.MouseEvent, obj: SceneObject) => {
    setSelectedId(obj.id)
    const items: CtxItem[] = [
      { label: t('apex_duplicate'),     onClick: () => duplicateObject(obj.id), shortcut: 'Ctrl+D' },
      { label: obj.visible ? t('vertex_ctx_hide') : t('vertex_ctx_show'), onClick: () => toggleVisibility(obj.id) },
      'sep',
      { label: t('apex_delete_element'), onClick: () => deleteObject(obj.id), danger: true, shortcut: 'Suppr' },
    ]
    ctx.open(e, items)
  }

  const vertexPanels = {
    outliner: { label: t('vertex_outliner_title'), render: () => (
      <OutlinerPanel objects={objects} selectedId={selectedId} onSelect={setSelectedId} onToggle={toggleVisibility} onDelete={deleteObject} onRowContextMenu={onRowContextMenu} />
    ) },
    properties: { label: t('vertex_properties_title'), render: () => (
      <PropertiesPanel selected={selectedObj} onPatch={p => updateObject(selectedId, p)}
        onSubdivide={() => selectedId && remesh(selectedId, 'subdivide')}
        onDecimate={() => selectedId && remesh(selectedId, 'decimate')} />
    ) },
    brush: { label: t('vertex_brushes_title'), render: () => (
      <BrushPanel sculptBrush={sculptBrush} brushRadius={brushRadius} brushStrength={brushStrength}
        onBrush={setSculptBrush} onRadius={setBrushRadius} onStrength={setBrushStrength} />
    ) },
  }

  const canUndo = past.current.length > 0
  const canRedo = future.current.length > 0

  return (
    <EditorShell theme={C}
      chromeless
      topbarHeight={64}
      onBack={() => navigate('/paintsharp')}
      title={titleDraft}
      onTitleChange={setTitleDraft}
      onTitleCommit={commitTitle}
      titlePlaceholder={t('common_untitled', { defaultValue: 'Sans titre' })}
      saveStatus={saveMut.isPending ? t('vertex_saving') : t('doc_saved', { defaultValue: 'Enregistré' })}
      subtitle="Vertex"
      titleActions={(
        <button
          onClick={() => starMut.mutate(!scene?.is_starred)}
          title={scene?.is_starred ? t('vertex_unstar', { defaultValue: 'Retirer des favoris' }) : t('vertex_star', { defaultValue: 'Ajouter aux favoris' })}
          className="p-1.5 rounded hover:bg-white/10 flex-shrink-0 transition-colors"
          style={{ color: scene?.is_starred ? '#f9ab00' : C.textDim }}>
          <Star size={15} fill={scene?.is_starred ? 'currentColor' : 'none'} />
        </button>
      )}
      onDelete={() => trashMut.mutate()}
      deleteTitle={t('vertex_move_to_trash', { defaultValue: 'Mettre à la corbeille' })}
      deleteConfirm={{
        title: t('vertex_delete_confirm_title', { defaultValue: 'Supprimer cette scène ?' }),
        message: t('vertex_delete_confirm_msg', { defaultValue: 'La scène sera déplacée dans la corbeille.' }),
        confirmLabel: t('common_delete', { defaultValue: 'Supprimer' }),
        variant: 'danger',
      }}
      menus={paintsharpMenus(t, {
        onSave:  () => saveMut.mutate({ objects }),
        onClose: () => navigate('/paintsharp'),
        onUndo:  undo,
        onRedo:  redo,
        canUndo,
        canRedo,
        onExport: () => exportMesh('obj'),
        exportLabel: t('vertex_export_obj', { defaultValue: 'Exporter en OBJ' }),
        extraMenus: [{
          label: t('vertex_menu_mesh', { defaultValue: 'Maillage' }),
          items: [
            { label: t('vertex_subdivide', { defaultValue: 'Subdiviser' }), onClick: () => selectedId && remesh(selectedId, 'subdivide') },
            { label: t('vertex_decimate',  { defaultValue: 'Décimer' }),    onClick: () => selectedId && remesh(selectedId, 'decimate') },
            'sep',
            { label: t('vertex_import', { defaultValue: 'Importer un maillage…' }), onClick: () => fileInputRef.current?.click() },
            'sep',
            { label: t('vertex_export_obj',  { defaultValue: 'Exporter en OBJ' }),  onClick: () => exportMesh('obj') },
            { label: t('vertex_export_stl',  { defaultValue: 'Exporter en STL' }),  onClick: () => exportMesh('stl') },
            { label: t('vertex_export_gltf', { defaultValue: 'Exporter en glTF' }), onClick: () => exportMesh('gltf') },
          ],
        }],
      })}
      topbarActions={<>
        <span className="text-xs px-2 py-0.5 rounded"
              style={{ background: mode !== 'object' ? `${C.accent}22` : C.panel, color: mode !== 'object' ? C.accent : C.textDim }}>
          {t(MODE_LIST.find(m => m.id === mode)?.labelKey ?? 'vertex_mode_object')}
        </span>
        <button onClick={() => saveMut.mutate({ objects })} disabled={saveMut.isPending}
                className="px-3 py-1 text-xs rounded text-white disabled:opacity-50" style={{ background: C.accent }}>
          {saveMut.isPending ? t('vertex_saving') : t('common_save')}
        </button>
      </>}
      optionsBar={<>
        {/* Undo / redo */}
        <button onClick={undo} disabled={!canUndo} title={`${t('menu_undo')} (Ctrl+Z)`}
                className="w-7 h-7 flex items-center justify-center rounded disabled:opacity-30"
                style={{ color: C.textDim }}><Undo2 size={14} /></button>
        <button onClick={redo} disabled={!canRedo} title={`${t('menu_redo')} (Ctrl+Shift+Z)`}
                className="w-7 h-7 flex items-center justify-center rounded disabled:opacity-30"
                style={{ color: C.textDim }}><Redo2 size={14} /></button>
        <div className="w-px h-5 mx-1" style={{ background: C.border }} />
        <ModeDropdown mode={mode} onMode={setMode} />
        <div className="w-px h-5 mx-1" style={{ background: C.border }} />
        <AddPrimitivesToolbar onAdd={addObject} />
        {mode === 'edit' && (
          <>
            <div className="w-px h-5 mx-1" style={{ background: C.border }} />
            <div className="flex items-center gap-0.5">
              {([
                { id: 'vertex' as EditElem, Icon: Circle,   label: t('vertex_elem_vertex', { defaultValue: 'Sommets' }), key: '1' },
                { id: 'edge'   as EditElem, Icon: Minus,    label: t('vertex_elem_edge',   { defaultValue: 'Arêtes' }),  key: '2' },
                { id: 'face'   as EditElem, Icon: Triangle, label: t('vertex_elem_face',   { defaultValue: 'Faces' }),   key: '3' },
              ]).map(({ id, Icon, label, key }) => (
                <button key={id} onClick={() => setEditElem(id)} title={`${label} (${key})`}
                        className="flex items-center gap-1 px-2 h-6 rounded text-[11px]"
                        style={{ background: editElem === id ? C.accent + '33' : 'transparent', color: editElem === id ? C.accent : C.textDim, border: `1px solid ${editElem === id ? C.accent : C.border}` }}>
                  <Icon size={12} /> {label}
                </button>
              ))}
            </div>
          </>
        )}
        <div className="flex-1" />
        {/* Brush settings (paint/sculpt/edit modes) */}
        {PAINT_MODES.includes(mode) && (
          <div className="flex items-center gap-2 mr-1">
            {(mode === 'vertex_paint' || mode === 'texture_paint') && (
              <ColorField t={t} C={C} color={paintColor} onChange={setPaintColor} width={26} height={20} />
            )}
            {mode === 'weight_paint' && (
              <label className="flex items-center gap-1 text-[11px]" style={{ color: C.textDim }}>
                {t('vertex_paint_weight')}
                <RangeSlider min={0} max={1} step={0.01} value={paintWeight}
                       onChange={setPaintWeight} style={{ width: 70 }} accent={C.accent} trackColor="rgba(255,255,255,0.15)" aria-label={t('vertex_paint_weight')} />
              </label>
            )}
            <label className="flex items-center gap-1 text-[11px]" style={{ color: C.textDim }}>
              {t('vertex_radius')}
              <RangeSlider min={0.08} max={2} step={0.01} value={brushRadius}
                     onChange={setBrushRadius} style={{ width: 70 }} accent={C.accent} trackColor="rgba(255,255,255,0.15)" aria-label={t('vertex_radius')} />
            </label>
            <label className="flex items-center gap-1 text-[11px]" style={{ color: C.textDim }}>
              {t('vertex_strength')}
              <RangeSlider min={0.02} max={1} step={0.01} value={brushStrength}
                     onChange={setBrushStrength} style={{ width: 70 }} accent={C.accent} trackColor="rgba(255,255,255,0.15)" aria-label={t('vertex_strength')} />
            </label>
            <div className="w-px h-5" style={{ background: C.border }} />
          </div>
        )}
        <button onClick={() => fileInputRef.current?.click()} title={t('vertex_import', { defaultValue: 'Importer un maillage…' })}
                className="flex items-center gap-1 px-2 h-6 rounded text-[11px]"
                style={{ color: C.textDim, border: `1px solid ${C.border}` }}>
          <Upload size={12} /> {t('vertex_import_short', { defaultValue: 'Importer' })}
        </button>
        <button onClick={() => exportMesh('obj')} title={t('vertex_export_obj', { defaultValue: 'Exporter en OBJ' })}
                className="flex items-center gap-1 px-2 h-6 rounded text-[11px]"
                style={{ color: C.textDim, border: `1px solid ${C.border}` }}>
          <Download size={12} /> {t('vertex_export_short', { defaultValue: 'Exporter' })}
        </button>
        <button onClick={() => setFocusSignal(s => s + 1)} disabled={!selectedObj} title={`${t('vertex_focus', { defaultValue: 'Cadrer la sélection' })} (F)`}
                className="flex items-center gap-1 px-2 h-6 rounded text-[11px] disabled:opacity-30"
                style={{ color: C.textDim, border: `1px solid ${C.border}` }}>
          <Crosshair size={12} />
        </button>
        <button onClick={() => setSymmetry(v => !v)} title={`${t('vertex_symmetry')} (M)`}
                className="flex items-center gap-1 px-2 h-6 rounded text-[11px]"
                style={{ background: symmetry ? C.accent + '33' : 'transparent', color: symmetry ? C.accent : C.textDim, border: `1px solid ${symmetry ? C.accent : C.border}` }}>
          <FlipHorizontal size={12} /> {t('vertex_symmetry')}
        </button>
        <button onClick={() => setWireframe(v => !v)} title={`${t('vertex_wireframe')} (Z)`}
                className="flex items-center gap-1 px-2 h-6 rounded text-[11px]"
                style={{ background: wireframe ? C.accent + '33' : 'transparent', color: wireframe ? C.accent : C.textDim, border: `1px solid ${wireframe ? C.accent : C.border}` }}>
          <Grid3x3 size={12} /> {t('vertex_wireframe')}
        </button>
      </>}
      toolRail={<ToolbarLeft mode={mode} transformMode={transformMode} onMode={setMode} onTransform={setTransformMode} />}>
      <DockArea theme={C} storageKey="kubuno:paintsharp:vertexDockLayout" viewportBg={C.bg}
        defaultArrangement={{ right: [['outliner'],['properties'],['brush']] }}
        panels={vertexPanels}>
        <Canvas
            shadows
            camera={{ position: [4, 4, 6], fov: 50 }}
            onCreated={({ gl }) => { gl.setClearColor(new THREE.Color(C.bg)) }}
            onPointerMissed={() => setSelectedId(null)}
          >
            <Viewport
              objects={objects}
              selectedId={selectedId}
              mode={mode}
              transformMode={transformMode}
              sculptBrush={sculptBrush}
              brushRadius={brushRadius}
              brushStrength={brushStrength}
              paintColor={paintColor}
              paintWeight={paintWeight}
              cursorPos={cursorPos}
              cursorNormal={cursorNormal}
              focusSignal={focusSignal}
              onSelect={setSelectedId}
              onBeginEdit={record}
              onCommit={commitTransform}
              onMeshCommit={commitMesh}
              onCursorMove={handleCursorMove}
              onCursorClear={handleCursorClear}
              symmetry={symmetry}
              wireframe={wireframe}
              editElem={editElem}
            />
          </Canvas>

          {/* HUD info */}
          <div className="absolute top-2 left-2 text-[11px] px-2 py-1 rounded pointer-events-none"
               style={{ background: 'rgba(0,0,0,0.55)', color: C.textDim }}>
            {mode === 'sculpt'
              ? selectedObj
                ? t('vertex_hud_sculpt', {
                    brush:  t(BRUSH_LIST.find(b => b.id === sculptBrush)?.labelKey ?? ''),
                    radius: brushRadius.toFixed(2),
                    name:   selectedObj.name,
                  })
                : t('vertex_hud_sculpt_hint')
              : mode === 'object'
                ? t('vertex_hud_select', { mode: transformMode, name: selectedObj ? ` · ${selectedObj.name}` : '' })
                : `${t(MODE_LIST.find(m => m.id === mode)?.labelKey ?? '')}${selectedObj ? ' · ' + selectedObj.name : ` — ${t('vertex_select_object')}`}`}
          </div>

          <div className="absolute bottom-2 left-2 text-[11px] px-2 py-1 rounded pointer-events-none"
               style={{ background: 'rgba(0,0,0,0.55)', color: C.textDim }}>
            {t('vertex_hud_visible_count', { count: objects.filter(o => o.visible).length })}
          </div>
      </DockArea>

      {/* Hidden file picker for mesh import */}
      <input ref={fileInputRef} type="file" accept=".obj,.stl,.glb,.gltf" hidden
             onChange={e => { const f = e.target.files?.[0]; if (f) handleImportFile(f); e.target.value = '' }} />

      {ctx.menu}
    </EditorShell>
  )
}
