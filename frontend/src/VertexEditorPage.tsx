import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams, useNavigate } from 'react-router-dom'
import { useDebouncedAutosave } from './useAutosave'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Canvas, ThreeEvent, useThree, useFrame } from '@react-three/fiber'
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
  Magnet, Globe, Combine, ArrowDownToLine, Pill, Infinity as InfinityIcon,
  Cylinder, Torus, Cone, Merge, Boxes, CopyPlus, SunMedium,
  Grab, Spline, Waves, Slice, PaintBucket, Tornado, MoveHorizontal,
  SquareStack, Expand, Droplet, Network, Sparkles, RefreshCcw, Package,
} from 'lucide-react'
import { RangeSlider, MenuDropdown, type MenuItem as UiMenuItem } from '@ui'
import { prompt } from '@kubuno/sdk'
import { paintsharpApi } from './api'
import { C as SHELL_C, EditorShell, DockArea, ColorField, paintsharpMenus, useContextMenu, type CtxItem, type DockController } from './ui'
import {
  applySavedPositions, bakeWorldGeometry, bakeRotationScale, booleanGeometries,
  flipGeometryNormals, geometryToCenteredMesh, groundOffset, joinGeometries,
  weldGeometry, type BooleanOp,
} from './vertexOps'
import {
  DynMesh, refineRegion, collapseRegion, compact, floodRefine,
  applyDab, beginStroke, captureGrab, buildAdjacency,
  collectRegion, buildVertexTris, updateRegionNormals,
  FALLOFFS, DEFAULT_SETTINGS, DRAG_BASES, DYNTOPO_BASES,
  type BrushBase, type BrushDef, type BrushSettings, type FalloffKind, type StrokeState, type VertexTris,
} from './vertexSculpt'


// ── Palette (shared Paintsharp theme, mapped to Vertex's legacy key names) ───────────
const C = { ...SHELL_C, bgPanel: SHELL_C.panel, bgToolbar: SHELL_C.toolbar, selected: SHELL_C.accent + '33' }

// ── Types ─────────────────────────────────────────────────────────────────────
type TransformMode = 'translate' | 'rotate' | 'scale'
// Blender-style interaction modes.
type Mode = 'object' | 'edit' | 'sculpt' | 'vertex_paint' | 'weight_paint' | 'texture_paint'
type PrimType     = 'box' | 'sphere' | 'cylinder' | 'torus' | 'cone' | 'plane' | 'icosphere' | 'capsule' | 'torusknot' | 'custom' | 'container'
// Resolved sculpt brush handed to the viewport: identity + effective settings.
interface ActiveBrush { id: string; base: BrushBase; settings: BrushSettings }
type SymAxes     = { x: boolean; y: boolean; z: boolean }
type DyntopoOpts = { enabled: boolean; detail: number }
// Camera view presets (Blender numpad-style).
type ViewKind     = 'front' | 'right' | 'top' | 'iso'
// Edit Mode selection element (Blender's vertex / edge / face select modes).
type EditElem     = 'vertex' | 'edge' | 'face'
// Highlighted Edit-Mode selection: vertex indices (move target) + derived edges/faces (display).
interface EditSel { v: number[]; e: number[]; f: number[] }
const EMPTY_SEL: EditSel = { v: [], e: [], f: [] }

// Modes that paint/deform on drag (LMB) → orbit disabled, brush cursor shown.
const PAINT_MODES: Mode[] = ['sculpt', 'vertex_paint', 'weight_paint', 'texture_paint', 'edit']

// Pleasant, bright object colours that read well on the dark viewport (#1e1e1e).
// New objects cycle through these instead of a single dull slate.
const OBJECT_PALETTE = ['#6ea8e6', '#57c7b0', '#e6ab52', '#e0785f', '#9a86e6', '#7bc86c', '#54b8d4', '#e084ab']
const DEFAULT_OBJECT_COLOR = '#9fbfe6'   // fallback for legacy objects with no colour

// TRS → Matrix4 (container propagation math).
function composeMatrix(p: [number, number, number], r?: [number, number, number], s?: [number, number, number]): THREE.Matrix4 {
  const rot = r ?? [0, 0, 0], sc = s ?? [1, 1, 1]
  return new THREE.Matrix4().compose(
    new THREE.Vector3(p[0], p[1], p[2]),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rot[0], rot[1], rot[2])),
    new THREE.Vector3(sc[0], sc[1], sc[2]),
  )
}
// Outliner display order: each container immediately followed by its children.
function outlinerOrder(objects: SceneObject[]): SceneObject[] {
  const out: SceneObject[] = []
  const seen = new Set<string>()
  for (const o of objects) {
    if (o.parentId) continue                       // placed under its container
    out.push(o); seen.add(o.id)
    if (o.primType === 'container') for (const c of objects) if (c.parentId === o.id) { out.push(c); seen.add(c.id) }
  }
  for (const o of objects) if (!seen.has(o.id)) out.push(o)   // orphans (dangling parentId)
  return out
}
// All objects nested (transitively) under a container.
function collectDescendants(rootId: string, all: SceneObject[]): Set<string> {
  const kids = new Set<string>()
  let frontier = [rootId]
  while (frontier.length) {
    const next: string[] = []
    for (const o of all) {
      if (o.parentId && frontier.includes(o.parentId) && !kids.has(o.id)) { kids.add(o.id); next.push(o.id) }
    }
    frontier = next
  }
  return kids
}

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
  opacity?:   number             // 1 = opaque (default)
  locked?:    boolean            // outliner lock: not selectable in the viewport
  mesh?:      MeshData            // deformed geometry / paint state (persisted)
  parentId?:  string             // container this object belongs to (proportional group)
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
    case 'capsule':   return new THREE.CapsuleGeometry(0.45, 0.8, 12, 32)
    case 'torusknot': return new THREE.TorusKnotGeometry(0.5, 0.16, 128, 24)
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
  if (obj.primType === 'container') return new THREE.BoxGeometry(1, 1, 1)   // no real mesh
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

// Cached vertex/triangle counts per primitive (their topology never changes),
// so live HUD/status stats never rebuild geometries.
const PRIM_STATS: Partial<Record<PrimType, { v: number; f: number }>> = {}
function objStats(o: SceneObject): { v: number; f: number } {
  if (o.primType === 'container') return { v: 0, f: 0 }
  if (o.primType !== 'custom' && !PRIM_STATS[o.primType]) {
    const g = createBaseGeometry(o.primType)
    const idx = g.getIndex()
    PRIM_STATS[o.primType] = {
      v: g.attributes.position.count,
      f: Math.round((idx ? idx.count : g.attributes.position.count) / 3),
    }
    g.dispose()
  }
  const base = PRIM_STATS[o.primType]
  const v = o.mesh?.positions ? Math.round(o.mesh.positions.length / 3) : (base?.v ?? 0)
  const f = o.mesh?.index ? Math.round(o.mesh.index.length / 3)
    : base ? base.f
    : o.mesh?.positions ? Math.round(o.mesh.positions.length / 9) : 0
  return { v, f }
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

// ── Sculpt brush library (metadata + persistence) ─────────────────────────────
// The deformation algorithms live in vertexSculpt.ts; here we describe the
// built-in brushes (icon, colour, group) and persist user customisation.
type BrushGroup = 'add' | 'surface' | 'deform'
const BRUSH_META: Record<BrushBase, {
  labelKey: string; label: string; Icon: LucideIcon; color: string; group: BrushGroup
}> = {
  draw:      { labelKey: 'vertex_brush_draw',      label: 'Dessiner',    Icon: Pen,            color: '#7c8db5', group: 'add' },
  clay:      { labelKey: 'vertex_brush_clay',      label: 'Argile',      Icon: Layers,         color: '#e8824a', group: 'add' },
  layer:     { labelKey: 'vertex_brush_layer',     label: 'Couche',      Icon: SquareStack,    color: '#c8a24a', group: 'add' },
  inflate:   { labelKey: 'vertex_brush_inflate',   label: 'Gonfler',     Icon: Expand,         color: '#f8c291', group: 'add' },
  crease:    { labelKey: 'vertex_brush_crease',    label: 'Plisser',     Icon: Scissors,       color: '#cf6a87', group: 'add' },
  pinch:     { labelKey: 'vertex_brush_pinch',     label: 'Pincer',      Icon: Minimize2,      color: '#82ccdd', group: 'surface' },
  smooth:    { labelKey: 'vertex_brush_smooth',    label: 'Lisser',      Icon: Waves,          color: '#a8d8ea', group: 'surface' },
  flatten:   { labelKey: 'vertex_brush_flatten',   label: 'Aplatir',     Icon: Minus,          color: '#b8e994', group: 'surface' },
  scrape:    { labelKey: 'vertex_brush_scrape',    label: 'Racler',      Icon: Slice,          color: '#9fd3a8', group: 'surface' },
  fill:      { labelKey: 'vertex_brush_fill',      label: 'Combler',     Icon: PaintBucket,    color: '#7fc9b8', group: 'surface' },
  grab:      { labelKey: 'vertex_brush_grab',      label: 'Saisir',      Icon: Grab,           color: '#4fc3f7', group: 'deform' },
  snakehook: { labelKey: 'vertex_brush_snakehook', label: 'Crochet',     Icon: Spline,         color: '#6f9ff0', group: 'deform' },
  nudge:     { labelKey: 'vertex_brush_nudge',     label: 'Pousser',     Icon: MoveHorizontal, color: '#8fa7e8', group: 'deform' },
  twist:     { labelKey: 'vertex_brush_twist',     label: 'Tordre',      Icon: Tornado,        color: '#b48fe8', group: 'deform' },
}

// Built-in brushes: one per base + curated presets built on existing bases
// (exactly what user-made custom brushes are, showcasing the preset system).
const BUILTIN_BRUSHES: BrushDef[] = [
  ...(Object.keys(BRUSH_META) as BrushBase[]).map<BrushDef>(base => ({
    id: base, base, builtin: true, settings: { ...DEFAULT_SETTINGS[base] },
  })),
  { id: 'preset-blob', base: 'inflate', builtin: true, name: 'Blob',
    settings: { ...DEFAULT_SETTINGS.inflate, falloff: 'sphere', strength: 0.6 } },
]

const LS_CUSTOM   = 'kubuno:vertex:customBrushes'
const LS_OVERRIDE = 'kubuno:vertex:brushSettings'
const LS_SCULPT   = 'kubuno:vertex:sculptPrefs'
function loadLS<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback
  } catch { return fallback }
}
function loadLSArray<T>(key: string, fallback: T[]): T[] {
  try {
    const raw = localStorage.getItem(key)
    const v = raw ? JSON.parse(raw) : fallback
    return Array.isArray(v) ? v : fallback
  } catch { return fallback }
}

// Falloff curve icons — small custom SVG profiles (no lucide equivalent).
const FALLOFF_PATHS: Record<FalloffKind, string> = {
  smooth:   'M1 3 C 5 3, 8 6, 15 13',
  sphere:   'M1 3 C 9 3.5, 13 6, 15 13',
  root:     'M1 3 C 3 8, 8 12, 15 13',
  sharp:    'M1 3 C 2 11, 6 13, 15 13',
  linear:   'M1 3 L 15 13',
  constant: 'M1 3 H 14 V 13',
}
const FALLOFF_KINDS: FalloffKind[] = ['smooth', 'sphere', 'root', 'sharp', 'linear', 'constant']
function FalloffIcon({ kind, color }: { kind: FalloffKind; color: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d={FALLOFF_PATHS[kind]} stroke={color} strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

const brushDisplayName = (t: (k: string, o?: { defaultValue?: string }) => string, b: BrushDef) =>
  b.name ?? t(BRUSH_META[b.base].labelKey, { defaultValue: BRUSH_META[b.base].label })

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
// Reads a mutable ref inside the render loop: hover moves cost ZERO React
// re-renders (the previous setState-per-pointermove re-rendered the whole page).
export interface CursorRef {
  point:  THREE.Vector3
  normal: THREE.Vector3
  has:    boolean
}
function BrushCursor({
  cursorRef, radius, visible,
}: {
  cursorRef: React.MutableRefObject<CursorRef>
  radius:    number
  visible:   boolean
}) {
  const meshRef = useRef<THREE.Mesh>(null)
  const Z = useMemo(() => new THREE.Vector3(0, 0, 1), [])
  useFrame(() => {
    const m = meshRef.current
    if (!m) return
    const c = cursorRef.current
    const show = visible && c.has
    m.visible = show
    if (show) {
      m.position.copy(c.point)
      m.quaternion.setFromUnitVectors(Z, c.normal)
    }
  })
  return (
    <mesh ref={meshRef} visible={false} renderOrder={999}>
      <ringGeometry args={[radius * 0.88, radius, 48]} />
      <meshBasicMaterial color={C.accent} side={THREE.DoubleSide} transparent opacity={0.9} depthTest={false} />
    </mesh>
  )
}

// ── Selectable + sculptable/paintable mesh ────────────────────────────────────
interface SelectableMeshProps {
  obj:                SceneObject
  selected:           boolean        // part of the multi-selection (highlight)
  active:             boolean        // last-selected object (carries the gizmo)
  mode:               Mode
  transformMode:      TransformMode
  brush:              ActiveBrush    // resolved sculpt brush (id + base + settings)
  brushRadius:        number         // paint modes (vertex/weight/texture)
  brushStrength:      number         // paint modes
  paintColor:         string
  paintWeight:        number
  snapping:           boolean        // gizmo snapping (grid / 15° / 0.1)
  transformSpace:     'world' | 'local'
  dyntopo:            DyntopoOpts
  onSelect:           (additive: boolean) => void
  onBeginEdit:        () => void      // record an undo snapshot before mutating
  onTransformStart:   () => void
  onTransformEnd:     () => void
  onCommit:           (patch: Partial<SceneObject>) => void
  onMeshCommit:       (mesh: MeshData, topologyChanged?: boolean) => void
  onCursorMove:       (pos: THREE.Vector3, normal: THREE.Vector3) => void
  onCursorClear:      () => void
  onObjectContextMenu: (e: MouseEvent) => void
  onSculptContextMenu: (e: MouseEvent) => void
  symAxes:            SymAxes
  wireframe:          boolean
  editElem:           EditElem
  // External Edit-Mode selection command (select all / none), sequenced.
  editAction:         { seq: number; kind: 'all' | 'none' } | null
}

const TEX_SIZE = 1024

// Non-empty mirror sign combinations for the enabled symmetry axes
// (X+Y enabled → identity, -X, -Y, -XY).
function mirrorCombosFor(symAxes: SymAxes): [number, number, number][] {
  const out: [number, number, number][] = [[1, 1, 1]]
  const axes: Array<[boolean, number]> = [[symAxes.x, 0], [symAxes.y, 1], [symAxes.z, 2]]
  for (const [on, i] of axes) {
    if (!on) continue
    for (const c of [...out]) {
      const n = [...c] as [number, number, number]
      n[i] = -n[i]
      out.push(n)
    }
  }
  return out
}

function SelectableMesh({
  obj, selected, active, mode, transformMode,
  brush, brushRadius, brushStrength, paintColor, paintWeight,
  snapping, transformSpace, dyntopo,
  onSelect, onBeginEdit, onTransformStart, onTransformEnd, onCommit, onMeshCommit,
  onCursorMove, onCursorClear, onObjectContextMenu, onSculptContextMenu,
  symAxes, wireframe, editElem, editAction,
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

  // External Edit-Mode command: select all vertices / clear the selection.
  const editActionSeen = useRef(editAction?.seq ?? 0)
  useEffect(() => {
    if (!editAction || editAction.seq === editActionSeen.current) return
    editActionSeen.current = editAction.seq
    if (!active || mode !== 'edit') return
    if (editAction.kind === 'none') {
      setEditSel(EMPTY_SEL); editSelRef.current = EMPTY_SEL
      return
    }
    const pos = geoRef.current.getAttribute('position') as THREE.BufferAttribute
    const all = Array.from({ length: pos.count }, (_, i) => i)
    const idx = geoRef.current.getIndex()
    const sel: EditSel = { v: all, e: [], f: idx ? Array.from(idx.array as ArrayLike<number>) : [] }
    setEditSel(sel); editSelRef.current = sel
  }, [editAction, active, mode])

  // Sculpt/paint strokes only land on the active object (Blender behaviour).
  const isPaintMode  = active && PAINT_MODES.includes(mode)

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
      img.onerror = () => { cx.fillStyle = obj.color ?? DEFAULT_OBJECT_COLOR; cx.fillRect(0, 0, TEX_SIZE, TEX_SIZE); finalize() }
      img.src = obj.mesh.texture
    } else {
      cx.fillStyle = obj.color ?? DEFAULT_OBJECT_COLOR
      cx.fillRect(0, 0, TEX_SIZE, TEX_SIZE)
      finalize()
    }
  }, [mode, texture, obj.color, obj.mesh])

  // Disable OrbitControls during the gizmo and commit the transform.
  useEffect(() => {
    const ctrl = transformRef.current
    if (!ctrl || !active) return
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
  }, [active, onBeginEdit, onTransformStart, onTransformEnd, onCommit, meshNode])

  const handleClick = useCallback((e: ThreeEvent<MouseEvent>) => {
    if (obj.locked) return
    e.stopPropagation()
    onSelect(e.nativeEvent.shiftKey || e.nativeEvent.ctrlKey)
  }, [onSelect, obj.locked])

  // ── Sculpt stroke machinery (engine-driven, cf. vertexSculpt.ts) ─────────────
  const sculptRef = useRef<{
    state: StrokeState
    combos: { sign: [number, number, number]; grabbed: StrokeState['grabbed'] }[]
    dyn: DynMesh | null
    dynSynced: number                 // last DynMesh.version pushed into the geometry
    adjacency: Int32Array[] | null    // one-rings for the smooth brush
    v2t: VertexTris | null            // vertex→tris CSR (region normal updates)
    lastLocal: [number, number, number] | null
    attrsStripped: boolean            // color/uv dropped after the first topology change
  } | null>(null)
  const rmbMoved = useRef(false)      // RMB drag = inverted stroke; RMB click = context menu

  const mirrorCombos = useMemo(() => mirrorCombosFor(symAxes), [symAxes])
  const mulSign = (v: [number, number, number], s: [number, number, number]): [number, number, number] =>
    [v[0] * s[0], v[1] * s[1], v[2] * s[2]]
  // Pen pressure (mouse reports a constant → neutral 1.0 factor).
  const pressureOf = (e: ThreeEvent<PointerEvent>) => {
    const pe = e.nativeEvent as PointerEvent
    return pe.pointerType === 'pen' ? Math.max(0.05, pe.pressure || 0.5) : 1
  }
  // Shift held = temporary smooth (Blender standard), except on drag brushes.
  const effectiveBase = (e: ThreeEvent<PointerEvent>, base: BrushBase): BrushBase =>
    (e.nativeEvent as PointerEvent).shiftKey && !DRAG_BASES.includes(base) ? 'smooth' : base

  // Local radius: brush radius is in world units; the mesh may be scaled.
  const localRadiusOf = useCallback((worldRadius: number) => {
    if (!meshNode) return worldRadius
    const scl = new THREE.Vector3()
    meshNode.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), scl)
    return worldRadius / Math.max(scl.x, 0.001)
  }, [meshNode])

  // Lazily create the stroke's DynMesh and keep the live geometry in sync after
  // every topology change (position/index swapped in place, adjacency invalidated).
  const dyntopoPass = useCallback((hit: [number, number, number], localR: number) => {
    const s = sculptRef.current
    if (!s) return
    const geo = geoRef.current
    if (!s.dyn) {
      const attr = geo.attributes.position as THREE.BufferAttribute
      const idx = geo.getIndex()
      if (!idx) return                                     // non-indexed mesh: no dyntopo
      s.dyn = new DynMesh(Float32Array.from(attr.array as Float32Array), attr.count, idx.array as ArrayLike<number>, s.state.snapshot)
      s.dynSynced = 0
      // Point the live geometry at the DynMesh buffers right away so dabs stay visible.
      geo.setAttribute('position', new THREE.BufferAttribute(s.dyn.pos.subarray(0, s.dyn.count * 3), 3))
      s.state.snapshot = s.dyn.tracked!
    }
    const detail = Math.max(0.015, dyntopo.detail)
    refineRegion(s.dyn, hit, localR, detail, 2500)
    collapseRegion(s.dyn, hit, localR, detail * 0.45, 400)
    if (s.dyn.version !== s.dynSynced) {
      s.dynSynced = s.dyn.version
      if (!s.attrsStripped) {
        // Paint layers / UVs can't survive topology changes (Blender drops them too).
        geo.deleteAttribute('color')
        geo.deleteAttribute('uv')
        vColorsRef.current = null
        weightsRef.current = null
        s.attrsStripped = true
      }
      geo.deleteAttribute('normal')
      geo.setAttribute('position', new THREE.BufferAttribute(s.dyn.pos.subarray(0, s.dyn.count * 3), 3))
      geo.setIndex(new THREE.BufferAttribute(s.dyn.idx.subarray(0, s.dyn.idxCount), 1))
      s.state.snapshot = s.dyn.tracked!
      s.adjacency = null
      s.v2t = null
      geo.computeBoundingSphere()
    }
  }, [dyntopo.detail])

  // Emit one dab (and its mirrored twins) at a local-space hit. `candsByCombo`
  // holds the pre-collected candidate vertices per mirror combo (one O(V) scan
  // per pointer event instead of per dab).
  const emitDab = useCallback((
    base: BrushBase, hit: [number, number, number], normal: [number, number, number],
    delta: [number, number, number], localR: number, strength: number,
    candsByCombo?: (Uint32Array | null)[] | null,
  ) => {
    const s = sculptRef.current
    if (!s) return
    const geo = geoRef.current
    for (let c = 0; c < s.combos.length; c++) {
      const combo = s.combos[c]
      const mHit = mulSign(hit, combo.sign), mNor = mulSign(normal, combo.sign), mDelta = mulSign(delta, combo.sign)
      if (dyntopo.enabled && DYNTOPO_BASES.includes(base)) dyntopoPass(mHit, localR)
      const attr = geo.attributes.position as THREE.BufferAttribute
      const pos = (s.dyn ? s.dyn.pos : attr.array) as Float32Array
      const count = s.dyn ? s.dyn.count : attr.count
      if (base === 'smooth' && !s.adjacency) {
        const idx = geo.getIndex()
        s.adjacency = idx ? buildAdjacency(idx.array as ArrayLike<number>, count) : null
      }
      const norAttr = geo.getAttribute('normal') as THREE.BufferAttribute | undefined
      const shim: StrokeState = DRAG_BASES.includes(base)
        ? {
            ...s.state,
            grabbed: combo.grabbed,
            originHit: mulSign(s.state.originHit, combo.sign),
            originNormal: mulSign(s.state.originNormal, combo.sign),
            accum: mulSign(s.state.accum, combo.sign),
          }
        : s.state
      applyDab(pos, count, norAttr && norAttr.count === count ? norAttr.array as Float32Array : null, shim, {
        base, hit: mHit, normal: mNor, delta: mDelta,
        radius: localR, strength, invert: invertRef.current, falloff: brush.settings.falloff,
      }, s.adjacency, candsByCombo?.[c] ?? null)
    }
  }, [brush.settings.falloff, dyntopo.enabled, dyntopoPass])

  // Post-dab normals: recompute only around the moved vertices (full-mesh
  // computeVertexNormals per pointer event was the main sculpt bottleneck).
  const updateStrokeNormals = useCallback((moved: (ArrayLike<number> | null)[] | null, topoChanged: boolean) => {
    const s = sculptRef.current
    const geo = geoRef.current
    const attr = geo.attributes.position as THREE.BufferAttribute
    const idx = geo.getIndex()
    const norAttr = geo.getAttribute('normal') as THREE.BufferAttribute | undefined
    const lists = moved?.filter((m): m is ArrayLike<number> => !!m) ?? []
    if (!s || topoChanged || !idx || !norAttr || norAttr.count !== attr.count || !lists.length) {
      geo.computeVertexNormals()
      if (s) s.v2t = null
      return
    }
    if (!s.v2t) s.v2t = buildVertexTris(idx.array as ArrayLike<number>, attr.count)
    for (const m of lists) {
      updateRegionNormals(attr.array as Float32Array, norAttr.array as Float32Array, idx.array as ArrayLike<number>, s.v2t, m)
    }
    norAttr.needsUpdate = true
  }, [])

  // Sculpt pointer-down: snapshot the stroke, capture grab sets, first dab.
  const sculptDown = useCallback((e: ThreeEvent<PointerEvent>) => {
    if (!meshNode || !e.face) return
    const geo = geoRef.current
    const attr = geo.attributes.position as THREE.BufferAttribute
    const lp = meshNode.worldToLocal(e.point.clone())
    const ln = e.face.normal.clone().normalize()      // face normals are object-space
    const localR = localRadiusOf(brush.settings.radius)
    const state = beginStroke(attr.array as Float32Array, [lp.x, lp.y, lp.z], [ln.x, ln.y, ln.z])
    const combos = mirrorCombos.map(sign => ({ sign, grabbed: null as StrokeState['grabbed'] }))
    if (DRAG_BASES.includes(brush.base)) {
      for (const combo of combos) {
        const shim: StrokeState = { ...state, originHit: mulSign(state.originHit, combo.sign) }
        captureGrab(shim, attr.array as Float32Array, attr.count, localR, FALLOFFS[brush.settings.falloff])
        combo.grabbed = shim.grabbed
      }
    }
    sculptRef.current = {
      state, combos, dyn: null, dynSynced: 0, adjacency: null, v2t: null,
      lastLocal: [lp.x, lp.y, lp.z], attrsStripped: false,
    }
    state.lastDab = [lp.x, lp.y, lp.z]
    rmbMoved.current = false
    // LMB stamps immediately; RMB waits for a drag (an RMB click opens the menu).
    if (e.buttons !== 2 && !DRAG_BASES.includes(brush.base)) {
      const pr = pressureOf(e)
      emitDab(effectiveBase(e, brush.base), [lp.x, lp.y, lp.z], [ln.x, ln.y, ln.z], [0, 0, 0],
        localR * (brush.settings.pressureRadius ? Math.max(0.2, pr) : 1),
        brush.settings.strength * (brush.settings.pressureStrength ? pr : 1))
      dirtyRef.current = true
      attr.needsUpdate = true
      geo.computeVertexNormals()
    }
  }, [meshNode, brush, mirrorCombos, localRadiusOf, emitDab])

  // Sculpt pointer-move: spacing-regulated dab emission / continuous drags.
  const sculptMove = useCallback((e: ThreeEvent<PointerEvent>) => {
    const s = sculptRef.current
    if (!s || !meshNode) return
    const lp = meshNode.worldToLocal(e.point.clone())
    const cur: [number, number, number] = [lp.x, lp.y, lp.z]
    const ln: [number, number, number] = e.face
      ? [e.face.normal.x, e.face.normal.y, e.face.normal.z]
      : s.state.originNormal
    const pr = pressureOf(e)
    const localR = localRadiusOf(brush.settings.radius) * (brush.settings.pressureRadius ? Math.max(0.2, pr) : 1)
    const strength = brush.settings.strength * (brush.settings.pressureStrength ? pr : 1)
    const base = effectiveBase(e, brush.base)
    if ((e.buttons & 2) !== 0) rmbMoved.current = true

    // Candidate collection: one O(V) sweep per pointer event covering every dab
    // of the event (segment sphere), per mirror combo. Skipped when dyntopo may
    // change the topology mid-event (indices would go stale).
    const geo = geoRef.current
    const attr = geo.attributes.position as THREE.BufferAttribute
    const posArr = (s.dyn ? s.dyn.pos : attr.array) as Float32Array
    const posCount = s.dyn ? s.dyn.count : attr.count
    const usesDyntopo = dyntopo.enabled && DYNTOPO_BASES.includes(base) && !!geo.getIndex()
    const dynVersionBefore = s.dyn?.version ?? 0
    const collectAround = (center: [number, number, number], r: number): (Uint32Array | null)[] =>
      s.combos.map(combo => collectRegion(posArr, posCount, mulSign(center, combo.sign), r))

    if (DRAG_BASES.includes(base)) {
      s.state.accum = [
        cur[0] - s.state.originHit[0], cur[1] - s.state.originHit[1], cur[2] - s.state.originHit[2],
      ]
      const delta: [number, number, number] = s.lastLocal
        ? [cur[0] - s.lastLocal[0], cur[1] - s.lastLocal[1], cur[2] - s.lastLocal[2]]
        : [0, 0, 0]
      // Grab/twist displace their captured set; snakehook/nudge scan around the
      // current hit — give the latter a candidate region.
      const cands = (base === 'snakehook' || base === 'nudge')
        ? collectAround(cur, localR * 1.05)
        : null
      emitDab(base, cur, ln, delta, localR, strength, cands)
      // Moved vertices for the incremental normal update.
      const moved = (base === 'grab' || base === 'twist')
        ? s.combos.map(c => c.grabbed?.idx ?? null)
        : cands
      s.lastLocal = cur
      dirtyRef.current = true
      attr.needsUpdate = true
      updateStrokeNormals(moved, false)
      return
    }

    const step = brush.settings.spacing * localR
    const last = s.state.lastDab ?? cur
    const dx = cur[0] - last[0], dy = cur[1] - last[1], dz = cur[2] - last[2]
    const dist = Math.hypot(dx, dy, dz)
    if (dist < step && step > 1e-6) {
      s.lastLocal = cur
      return                       // nothing stamped: skip the normals update
    }
    const segCenter: [number, number, number] = [last[0] + dx / 2, last[1] + dy / 2, last[2] + dz / 2]
    const cands = usesDyntopo ? null : collectAround(segCenter, dist / 2 + localR * 1.15)
    if (step <= 1e-6) {
      emitDab(base, cur, ln, [0, 0, 0], localR, strength, cands)
      s.state.lastDab = cur
    } else {
      // Walk the segment, stamping evenly spaced dabs.
      const n = Math.min(Math.floor(dist / step), 24)
      for (let k = 1; k <= n; k++) {
        const f = (k * step) / dist
        emitDab(base, [last[0] + dx * f, last[1] + dy * f, last[2] + dz * f], ln, [0, 0, 0], localR, strength, cands)
      }
      const f = (n * step) / dist
      s.state.lastDab = [last[0] + dx * f, last[1] + dy * f, last[2] + dz * f]
    }
    s.lastLocal = cur
    dirtyRef.current = true
    const attrNow = geoRef.current.attributes.position as THREE.BufferAttribute
    attrNow.needsUpdate = true
    updateStrokeNormals(cands, (s.dyn?.version ?? 0) !== dynVersionBefore)
  }, [meshNode, brush, dyntopo.enabled, localRadiusOf, emitDab, updateStrokeNormals])

  // Commit a finished sculpt stroke (topology-aware).
  const sculptUp = useCallback(() => {
    const s = sculptRef.current
    sculptRef.current = null
    if (!s || !dirtyRef.current) return
    geoRef.current.computeBoundingSphere()
    if (s.dyn && s.dyn.version > 0) {
      const { positions, index } = compact(s.dyn)
      const mesh: MeshData = { positions: roundArr(positions), index: Array.from(index) }
      meshSeenRef.current = mesh
      onMeshCommit(mesh, true)
    } else {
      const mesh = serializeMesh(geoRef.current, obj.primType, vColorsRef.current, weightsRef.current, texCtxRef.current?.canvas ?? null, obj.mesh)
      meshSeenRef.current = mesh
      onMeshCommit(mesh, false)
    }
  }, [obj.primType, obj.mesh, onMeshCommit])

  // Applies one brush "dab" at the hovered point, per the current mode (paint
  // modes only; sculpt goes through sculptDown/sculptMove above).
  const stroke = useCallback((e: ThreeEvent<PointerEvent>, _wn: THREE.Vector3) => {
    if (!meshNode) return
    const M = meshNode.matrixWorld
    const cx = obj.position[0]
    const mirror = (p: THREE.Vector3) => new THREE.Vector3(2 * cx - p.x, p.y, p.z)
    const mirrorX = symAxes.x
    dirtyRef.current = true
    if (mode === 'vertex_paint' && vColorsRef.current) {
      const c = new THREE.Color(invertRef.current ? '#ffffff' : paintColor)
      applyColorBrush(geoRef.current, M, e.point, brushRadius, [c.r, c.g, c.b], brushStrength)
      if (mirrorX) applyColorBrush(geoRef.current, M, mirror(e.point), brushRadius, [c.r, c.g, c.b], brushStrength)
      ;(vColorsRef.current as Float32Array).set((geoRef.current.getAttribute('color') as THREE.BufferAttribute).array as Float32Array)
    } else if (mode === 'weight_paint' && weightsRef.current) {
      const val = invertRef.current ? 0 : paintWeight
      applyWeightBrush(weightsRef.current, geoRef.current, M, e.point, brushRadius, val, brushStrength)
      if (mirrorX) applyWeightBrush(weightsRef.current, geoRef.current, M, mirror(e.point), brushRadius, val, brushStrength)
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
  }, [meshNode, mode, brushRadius, brushStrength, symAxes.x, obj.position, paintColor, paintWeight, texture])

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
    // Invert with RMB (drag) or Ctrl (Blender-style).
    invertRef.current  = e.buttons === 2 || (e.nativeEvent as PointerEvent).ctrlKey
    lastHit.current    = e.point.clone()
    if (mode === 'sculpt') {
      sculptDown(e)
      return
    }
    const wn = e.face.normal.clone().transformDirection(meshNode.matrixWorld).normalize()
    stroke(e, wn)
  }, [isPaintMode, meshNode, mode, sculptDown, stroke, onBeginEdit])

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
    if (mode === 'sculpt') {
      sculptMove(e)
      return
    }
    stroke(e, wn)
  }, [isPaintMode, meshNode, mode, onCursorMove, sculptMove, stroke])

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
    if (mode === 'sculpt') {
      if (wasDirty) sculptUp()          // topology-aware commit
      else sculptRef.current = null
      dirtyRef.current = false
      return
    }
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
  }, [mode, obj.primType, obj.mesh, onMeshCommit, pickEditElement, sculptUp])

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
        castShadow
        receiveShadow
        onClick={handleClick}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={stopPainting}
        onPointerLeave={() => { stopPainting(); onCursorClear() }}
        onContextMenu={(e) => {
          e.stopPropagation()
          // Object Mode: right-click opens the object context menu.
          if (mode === 'object' && !obj.locked) {
            e.nativeEvent.preventDefault()
            onObjectContextMenu(e.nativeEvent)
            return
          }
          // Sculpt: RMB drag inverts the stroke; a plain RMB click opens the
          // sculpt context menu (brush / dyntopo / symmetry quick access).
          if (mode === 'sculpt' && active) {
            e.nativeEvent.preventDefault()
            if (!rmbMoved.current) onSculptContextMenu(e.nativeEvent)
            return
          }
          // Other paint modes keep RMB for brush inversion (suppress the menu).
          if (PAINT_MODES.includes(mode)) e.nativeEvent.preventDefault()
        }}
      >
        <meshStandardMaterial
          key={`${obj.shadeFlat ? 'flat' : 'smooth'}:${(obj.opacity ?? 1) < 1 ? 'tr' : 'op'}`}
          color={showVertexColors ? '#ffffff' : (obj.color ?? DEFAULT_OBJECT_COLOR)}
          map={mode === 'texture_paint' ? texture : null}
          vertexColors={showVertexColors}
          roughness={obj.roughness ?? 0.45}
          metalness={obj.metalness ?? 0.15}
          flatShading={obj.shadeFlat ?? false}
          transparent={(obj.opacity ?? 1) < 1}
          opacity={obj.opacity ?? 1}
          side={THREE.DoubleSide}
          wireframe={wireframe || mode === 'edit'}
          emissive={selected && mode === 'object' ? C.accent : '#000000'}
          emissiveIntensity={selected && mode === 'object' ? (active ? 0.22 : 0.1) : 0}
        />
      </mesh>

      {/* Edit Mode: all vertices (Blender-style), shown only in vertex select. */}
      {active && mode === 'edit' && editElem === 'vertex' && (
        <points geometry={geoRef.current} position={obj.position} rotation={obj.rotation ?? [0,0,0]} scale={obj.scale ?? [1,1,1]}>
          {/* Screen-space (pixel) handles: constant, discreet size at any zoom / mesh density. */}
          <pointsMaterial size={4} color={C.accent} sizeAttenuation={false} depthTest={false} />
        </points>
      )}

      {/* Edit Mode: highlighted selection (orange) — points / edges / faces. */}
      {active && mode === 'edit' && editHighlight && (
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
              <pointsMaterial size={6} color="#ff8c2b" sizeAttenuation={false} depthTest={false} />
            </points>
          )}
        </group>
      )}

      {/* Transform gizmo (Object Mode, active object only). */}
      {active && mode === 'object' && !obj.locked && meshNode && (
        <TransformControls
          ref={transformRef} object={meshNode} mode={transformMode} size={0.8}
          space={transformSpace}
          translationSnap={snapping ? 0.25 : null}
          rotationSnap={snapping ? THREE.MathUtils.degToRad(15) : null}
          scaleSnap={snapping ? 0.1 : null}
        />
      )}
    </>
  )
}

// ── Container object: a proportional group. Rendered as a pickable translucent
// box + wireframe; its gizmo scales/moves/rotates the whole group, and the parent
// propagates that transform to every child (see commitTransform). ──────────────
interface ContainerObjectProps {
  obj: SceneObject
  selected: boolean
  active: boolean
  mode: Mode
  transformMode: TransformMode
  snapping: boolean
  transformSpace: 'world' | 'local'
  onSelect: (additive: boolean) => void
  onBeginEdit: () => void
  onCommit: (patch: Partial<SceneObject>) => void
  onTransformStart: () => void
  onTransformEnd: () => void
  onObjectContextMenu: (e: MouseEvent) => void
}
function ContainerObject({
  obj, selected, active, mode, transformMode, snapping, transformSpace,
  onSelect, onBeginEdit, onCommit, onTransformStart, onTransformEnd, onObjectContextMenu,
}: ContainerObjectProps) {
  const [node, setNode] = useState<THREE.Mesh | null>(null)
  const transformRef = useRef<any>(null)
  const edges = useMemo(() => new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), [])

  useEffect(() => {
    const ctrl = transformRef.current
    if (!ctrl || !active) return
    const handler = (e: { value: boolean }) => {
      if (e.value) { onBeginEdit(); onTransformStart(); return }
      onTransformEnd()
      if (node) {
        const r = node.rotation
        onCommit({
          position: [node.position.x, node.position.y, node.position.z],
          rotation: [r.x, r.y, r.z],
          scale:    [node.scale.x, node.scale.y, node.scale.z],
        })
      }
    }
    ctrl.addEventListener('dragging-changed', handler)
    return () => ctrl.removeEventListener('dragging-changed', handler)
  }, [active, node, onBeginEdit, onTransformStart, onTransformEnd, onCommit])

  const canGizmo = active && mode === 'object' && !obj.locked
  return (
    <>
      <mesh
        ref={setNode}
        position={obj.position}
        rotation={obj.rotation ?? [0, 0, 0]}
        scale={obj.scale ?? [1, 1, 1]}
        onPointerDown={(e) => { if (mode === 'object' && !obj.locked) { e.stopPropagation(); onSelect(e.nativeEvent.shiftKey || e.nativeEvent.ctrlKey || e.nativeEvent.metaKey) } }}
        onContextMenu={(e) => { if (mode === 'object' && !obj.locked) { e.stopPropagation(); e.nativeEvent.preventDefault(); onObjectContextMenu(e.nativeEvent) } }}>
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial color={C.accent} transparent opacity={selected ? 0.1 : 0.04} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      <lineSegments geometry={edges} position={obj.position} rotation={obj.rotation ?? [0, 0, 0]} scale={obj.scale ?? [1, 1, 1]}>
        <lineBasicMaterial color={selected ? C.accent : '#8aa0c8'} transparent opacity={selected ? 1 : 0.6} />
      </lineSegments>
      {canGizmo && node && (
        <TransformControls
          ref={transformRef} object={node} mode={transformMode} size={0.9}
          space={transformSpace}
          translationSnap={snapping ? 0.25 : null}
          rotationSnap={snapping ? THREE.MathUtils.degToRad(15) : null}
          scaleSnap={snapping ? 0.1 : null}
        />
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

// ── Camera view presets (front / right / top / iso), Blender numpad-style ──────
function ViewPresetRig({ view }: { view: { seq: number; kind: ViewKind } | null }) {
  const { controls, camera } = useThree() as any
  const seen = useRef(view?.seq ?? 0)
  useEffect(() => {
    if (!view || view.seq === seen.current || !controls) return
    seen.current = view.seq
    const t: THREE.Vector3 = controls.target.clone()
    const dist = Math.max(camera.position.distanceTo(controls.target), 2)
    const dirs: Record<ViewKind, THREE.Vector3> = {
      front: new THREE.Vector3(0, 0, 1),
      right: new THREE.Vector3(1, 0, 0),
      top:   new THREE.Vector3(0, 1, 0.0001),
      iso:   new THREE.Vector3(1, 0.8, 1.2).normalize(),
    }
    camera.position.copy(t.clone().add(dirs[view.kind].clone().multiplyScalar(dist)))
    camera.lookAt(t)
    controls.update?.()
  }, [view, controls, camera])
  return null
}

// ── Ctrl+wheel zoom ────────────────────────────────────────────────────────────
// Ctrl+scroll (and trackpad pinch, which browsers report as ctrl+wheel) dollies
// the camera. Captured on the canvas parent BEFORE OrbitControls / the browser
// page-zoom see the event.
function CtrlWheelZoom() {
  const { gl, camera, controls } = useThree() as any
  useEffect(() => {
    const parent = gl.domElement.parentElement as HTMLElement | null
    if (!parent) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      e.stopPropagation()
      const target: THREE.Vector3 = controls?.target ?? new THREE.Vector3()
      const offset = camera.position.clone().sub(target)
      const dist = THREE.MathUtils.clamp(offset.length() * Math.exp(e.deltaY * 0.002), 0.3, 100)
      offset.setLength(dist)
      camera.position.copy(target.clone().add(offset))
      controls?.update?.()
    }
    parent.addEventListener('wheel', onWheel, { passive: false, capture: true })
    return () => parent.removeEventListener('wheel', onWheel, { capture: true })
  }, [gl, camera, controls])
  return null
}

// ── 3D viewport ───────────────────────────────────────────────────────────────
interface ViewportProps {
  objects:       SceneObject[]
  selectedIds:   string[]
  activeId:      string | null
  mode:          Mode
  transformMode: TransformMode
  brush:         ActiveBrush
  brushRadius:   number
  brushStrength: number
  paintColor:    string
  paintWeight:   number
  cursorRef:     React.MutableRefObject<CursorRef>
  focusSignal:   number
  viewSignal:    { seq: number; kind: ViewKind } | null
  snapping:      boolean
  transformSpace: 'world' | 'local'
  dyntopo:       DyntopoOpts
  showGrid:      boolean
  showShadows:   boolean
  onSelect:      (id: string | null, additive: boolean) => void
  onBeginEdit:   () => void
  onCommit:      (id: string, patch: Partial<SceneObject>) => void
  onMeshCommit:  (id: string, mesh: MeshData, topologyChanged?: boolean) => void
  onCursorMove:  (pos: THREE.Vector3, normal: THREE.Vector3) => void
  onCursorClear: () => void
  onObjectContextMenu: (id: string, e: MouseEvent) => void
  onSculptContextMenu: (e: MouseEvent) => void
  symAxes:       SymAxes
  wireframe:     boolean
  editElem:      EditElem
  editAction:    { seq: number; kind: 'all' | 'none' } | null
}

function Viewport({
  objects, selectedIds, activeId, mode, transformMode,
  brush, brushRadius, brushStrength, paintColor, paintWeight,
  cursorRef, focusSignal, viewSignal,
  snapping, transformSpace, dyntopo, showGrid, showShadows,
  onSelect, onBeginEdit, onCommit, onMeshCommit, onCursorMove, onCursorClear,
  onObjectContextMenu, onSculptContextMenu, symAxes, wireframe, editElem, editAction,
}: ViewportProps) {
  const [orbitEnabled, setOrbitEnabled] = useState(true)
  const activeObj = objects.find(o => o.id === activeId) ?? null

  return (
    <>
      {/* Studio-style three-point lighting: key (with shadows), fill, rim. */}
      <ambientLight intensity={0.3} />
      <hemisphereLight args={['#b9c8e6', '#2a2f3a', 0.35]} />
      <directionalLight
        position={[5, 8, 5]} intensity={1.25}
        castShadow={showShadows}
        shadow-mapSize-width={1024} shadow-mapSize-height={1024}
        shadow-camera-near={0.5} shadow-camera-far={30}
        shadow-camera-left={-12} shadow-camera-right={12}
        shadow-camera-top={12} shadow-camera-bottom={-12}
        shadow-bias={-0.0002}
      />
      <directionalLight position={[-6, 3, -2]} intensity={0.35} color="#9db4ff" />
      <pointLight position={[-4, 4, -4]} intensity={0.5} color="#4fc3f7" />

      {/* Ground shadow catcher (invisible plane that only shows cast shadows). */}
      {showShadows && (
        <mesh rotation-x={-Math.PI / 2} position={[0, -0.002, 0]} receiveShadow>
          <planeGeometry args={[60, 60]} />
          <shadowMaterial transparent opacity={0.3} />
        </mesh>
      )}

      {showGrid && (
        <Grid
          args={[20, 20]} cellSize={1} cellThickness={0.5}
          cellColor="#1e3a5f" sectionSize={5} sectionThickness={1}
          sectionColor="#0f3460" fadeDistance={30} fadeStrength={1} infiniteGrid
        />
      )}

      {objects.filter(o => o.visible && o.primType === 'container').map((obj) => (
        <ContainerObject
          key={obj.id}
          obj={obj}
          selected={selectedIds.includes(obj.id)}
          active={obj.id === activeId}
          mode={mode}
          transformMode={transformMode}
          snapping={snapping}
          transformSpace={transformSpace}
          onSelect={(additive) => onSelect(obj.id, additive)}
          onBeginEdit={onBeginEdit}
          onCommit={(patch) => onCommit(obj.id, patch)}
          onTransformStart={() => setOrbitEnabled(false)}
          onTransformEnd={() => setOrbitEnabled(true)}
          onObjectContextMenu={(e) => onObjectContextMenu(obj.id, e)}
        />
      ))}

      {objects.filter(o => o.visible && o.primType !== 'container').map((obj) => (
        <SelectableMesh
          // Remount on topology change (subdivide/decimate/import) so geometry rebuilds;
          // a plain sculpt keeps the vertex count, so the key — and the mesh — stays put.
          key={`${obj.id}:${obj.primType}:${obj.mesh?.positions?.length ?? 0}:${obj.mesh?.index?.length ?? 0}`}
          obj={obj}
          selected={selectedIds.includes(obj.id)}
          active={obj.id === activeId}
          mode={mode}
          transformMode={transformMode}
          brush={brush}
          brushRadius={brushRadius}
          brushStrength={brushStrength}
          paintColor={paintColor}
          paintWeight={paintWeight}
          snapping={snapping}
          transformSpace={transformSpace}
          dyntopo={dyntopo}
          onSelect={(additive) => onSelect(obj.id, additive)}
          onBeginEdit={onBeginEdit}
          onCommit={(patch) => onCommit(obj.id, patch)}
          onMeshCommit={(mesh, topo) => onMeshCommit(obj.id, mesh, topo)}
          onTransformStart={() => setOrbitEnabled(false)}
          onTransformEnd={() => setOrbitEnabled(true)}
          onCursorMove={onCursorMove}
          onCursorClear={onCursorClear}
          onObjectContextMenu={(e) => onObjectContextMenu(obj.id, e)}
          onSculptContextMenu={onSculptContextMenu}
          symAxes={symAxes}
          wireframe={wireframe}
          editElem={editElem}
          editAction={editAction}
        />
      ))}

      <BrushCursor
        cursorRef={cursorRef}
        radius={mode === 'sculpt' ? brush.settings.radius : brushRadius}
        visible={PAINT_MODES.includes(mode) && mode !== 'edit' && !!activeId}
      />

      <FocusRig signal={focusSignal} target={activeObj?.position ?? null} />
      <ViewPresetRig view={viewSignal} />
      <CtrlWheelZoom />

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
type LucideIcon = React.ComponentType<{ size?: number; style?: React.CSSProperties }>
const PRIM_ICONS: Record<PrimType, LucideIcon> = {
  box: Box, sphere: Circle, cylinder: Cylinder, torus: Torus, cone: Cone,
  plane: Square, icosphere: Hexagon, capsule: Pill, torusknot: InfinityIcon, custom: Boxes,
  container: Package,
}

function OutlinerPanel({
  objects, selectedIds, activeId, onSelect, onToggle, onDelete, onRename, onRowContextMenu,
}: {
  objects:     SceneObject[]
  selectedIds: string[]
  activeId:    string | null
  onSelect:    (id: string, additive: boolean) => void
  onToggle:    (id: string) => void
  onDelete:    (id: string) => void
  onRename:    (id: string, name: string) => void
  onRowContextMenu: (e: React.MouseEvent, obj: SceneObject) => void
}) {
  const { t } = useTranslation('paintsharp')
  const [editing, setEditing] = useState<string | null>(null)
  const [draft,   setDraft]   = useState('')

  const commitRename = () => {
    if (editing && draft.trim()) onRename(editing, draft.trim())
    setEditing(null)
  }

  return (
    <div className="flex flex-col h-full" style={{ background: C.bgPanel }}>
      <div className="flex items-center px-3 py-2 border-b" style={{ borderColor: C.border }}>
        <Layers size={13} style={{ color: C.textDim, marginRight: 6 }} />
        <span className="text-xs font-medium" style={{ color: C.text }}>{t('vertex_outliner_title')}</span>
        <span className="ml-auto text-xs" style={{ color: C.textDim }}>
          {selectedIds.length > 1 ? `${selectedIds.length}/${objects.length}` : objects.length}
        </span>
      </div>
      <div className="flex-1 overflow-y-auto">
        {outlinerOrder(objects).map((obj) => {
          const Icon = PRIM_ICONS[obj.primType] ?? Box
          const isSel = selectedIds.includes(obj.id)
          const isActive = obj.id === activeId
          const nested = !!obj.parentId
          return (
            <div
              key={obj.id}
              onClick={(e) => onSelect(obj.id, e.shiftKey || e.ctrlKey)}
              onDoubleClick={() => { setEditing(obj.id); setDraft(obj.name) }}
              onContextMenu={(e) => onRowContextMenu(e, obj)}
              className="group flex items-center gap-1.5 pr-3 py-1 cursor-pointer text-xs select-none"
              style={{
                paddingLeft: nested ? 26 : 12,
                background: isSel ? C.selected : 'transparent',
                boxShadow: isActive ? `inset 2px 0 0 ${C.accent}` : undefined,
                color: obj.visible ? C.text : C.textDim,
              }}
            >
              <Icon size={11} style={{ color: isSel ? C.accent : C.textDim, flexShrink: 0 }} />
              {editing === obj.id ? (
                <input
                  autoFocus value={draft}
                  onChange={e => setDraft(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={e => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setEditing(null) }}
                  onClick={e => e.stopPropagation()}
                  className="flex-1 min-w-0 px-1 py-0 rounded text-xs outline-none"
                  style={{ background: C.bg, color: C.text, border: `1px solid ${C.accent}` }}
                />
              ) : (
                <span className="flex-1 truncate" title={t('vertex_rename_hint', { defaultValue: 'Double-clic pour renommer' })}>
                  {obj.name}
                </span>
              )}
              <span className="text-[10px] font-mono opacity-0 group-hover:opacity-100" style={{ color: C.textDim }}>
                {obj.mesh?.positions ? Math.round(obj.mesh.positions.length / 3) : ''}
              </span>
              <button onClick={(e) => { e.stopPropagation(); onToggle(obj.id) }} style={{ color: C.textDim }}
                      title={obj.visible ? t('vertex_ctx_hide') : t('vertex_ctx_show')}>
                {obj.visible ? <Eye size={11} /> : <EyeOff size={11} />}
              </button>
              <button onClick={(e) => { e.stopPropagation(); onDelete(obj.id) }} style={{ color: C.textDim }}
                      title={t('apex_delete_element')}>
                <Trash2 size={11} />
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Properties ────────────────────────────────────────────────────────────────
// Building blocks live at module scope: defining them inside the panel would
// recreate their component type on every render, remounting inputs/sliders
// mid-interaction (focus loss, broken drags).
function PSection({ title, open, onToggle, children }: {
  title: string; open: boolean; onToggle: () => void; children: React.ReactNode
}) {
  return (
    <div>
      <button onClick={onToggle} className="flex items-center gap-1 w-full mb-1.5">
        {open
          ? <ChevronDown size={11} style={{ color: C.textDim }} />
          : <ChevronRight size={11} style={{ color: C.textDim }} />}
        <span className="text-[11px] font-medium uppercase tracking-wider" style={{ color: C.textDim }}>{title}</span>
      </button>
      {open && <div className="space-y-1">{children}</div>}
    </div>
  )
}
function PRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] w-20 flex-shrink-0" style={{ color: C.textDim }}>{label}</span>
      <div className="flex-1">{children}</div>
    </div>
  )
}
function PNum({ val, step = 0.1, onChange }: { val: number; step?: number; onChange?: (v: number) => void }) {
  return (
    <input type="number" defaultValue={val} step={step}
           onChange={e => onChange?.(Number(e.target.value))}
           className="w-full px-1.5 py-0.5 rounded text-xs outline-none"
           style={{ background: C.bg, color: C.text, border: `1px solid ${C.border}` }} />
  )
}

function PropertiesPanel({ selected, stats, onPatch, onSubdivide, onDecimate, onWeld, onFlipNormals }: {
  selected: SceneObject | null
  stats: { v: number; f: number } | null
  onPatch: (p: Partial<SceneObject>) => void
  onSubdivide: () => void
  onDecimate: () => void
  onWeld: () => void
  onFlipNormals: () => void
}) {
  const { t } = useTranslation('paintsharp')
  const [open, setOpen] = useState<Record<string, boolean>>({
    object: true, transform: true, material: true, mesh: true,
  })
  const toggle = (k: string) => setOpen(p => ({ ...p, [k]: !p[k] }))

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
            <PSection open={!!open.object} onToggle={() => toggle('object')} title={t('vertex_section_object')}>
              <PRow label={t('vertex_field_name')}>
                <input defaultValue={selected.name} key={selected.id + 'n'}
                       onChange={e => onPatch({ name: e.target.value })}
                       className="w-full px-1.5 py-0.5 rounded text-xs outline-none"
                       style={{ background: C.bg, color: C.text, border: `1px solid ${C.border}` }} />
              </PRow>
            </PSection>
            <PSection open={!!open.transform} onToggle={() => toggle('transform')} title={t('vertex_section_transform')}>
              <PRow label={t('vertex_field_position', { defaultValue: 'Position' })}>
                <div className="flex gap-1">
                  {([0, 1, 2] as const).map(ax => (
                    <PNum key={`${selected.id}p${ax}`} val={selected.position[ax]}
                         onChange={v => {
                           const p = [...selected.position] as [number, number, number]
                           p[ax] = v
                           onPatch({ position: p })
                         }} />
                  ))}
                </div>
              </PRow>
              <PRow label={t('vertex_field_rotation', { defaultValue: 'Rotation °' })}>
                <div className="flex gap-1">
                  {([0, 1, 2] as const).map(ax => {
                    const rot = selected.rotation ?? [0, 0, 0]
                    const deg = Math.round(THREE.MathUtils.radToDeg(rot[ax]) * 10) / 10
                    return (
                      <PNum key={`${selected.id}r${ax}`} val={deg} step={5}
                           onChange={v => {
                             const r = [...rot] as [number, number, number]
                             r[ax] = THREE.MathUtils.degToRad(v)
                             onPatch({ rotation: r })
                           }} />
                    )
                  })}
                </div>
              </PRow>
              <PRow label={t('vertex_field_scale', { defaultValue: 'Échelle' })}>
                <div className="flex gap-1">
                  {([0, 1, 2] as const).map(ax => {
                    const sc = selected.scale ?? [1, 1, 1]
                    return (
                      <PNum key={`${selected.id}s${ax}`} val={sc[ax]} step={0.1}
                           onChange={v => {
                             const s = [...sc] as [number, number, number]
                             s[ax] = v
                             onPatch({ scale: s })
                           }} />
                    )
                  })}
                </div>
              </PRow>
            </PSection>
            <PSection open={!!open.material} onToggle={() => toggle('material')} title={t('vertex_section_material')}>
              <PRow label={t('vertex_field_color')}>
                <ColorField t={t} C={C} color={selected.color ?? DEFAULT_OBJECT_COLOR} onChange={hex => onPatch({ color: hex })} height={20} style={{ width: '100%' }} />
              </PRow>
              <PRow label={t('vertex_field_roughness')}>
                <RangeSlider min={0} max={1} step={0.01} value={selected.roughness ?? 0.45}
                             onChange={v => onPatch({ roughness: v })} className="w-full"
                             accent={C.accent} trackColor="rgba(255,255,255,0.15)" aria-label={t('vertex_field_roughness')} />
              </PRow>
              <PRow label={t('vertex_field_metalness')}>
                <RangeSlider min={0} max={1} step={0.01} value={selected.metalness ?? 0.15}
                             onChange={v => onPatch({ metalness: v })} className="w-full"
                             accent={C.accent} trackColor="rgba(255,255,255,0.15)" aria-label={t('vertex_field_metalness')} />
              </PRow>
              <PRow label={t('vertex_field_opacity', { defaultValue: 'Opacité' })}>
                <RangeSlider min={0.05} max={1} step={0.01} value={selected.opacity ?? 1}
                             onChange={v => onPatch({ opacity: v >= 0.995 ? undefined : v } as Partial<SceneObject>)} className="w-full"
                             accent={C.accent} trackColor="rgba(255,255,255,0.15)" aria-label={t('vertex_field_opacity', { defaultValue: 'Opacité' })} />
              </PRow>
              <PRow label={t('vertex_field_shading', { defaultValue: 'Ombrage' })}>
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
              </PRow>
            </PSection>
            <PSection open={!!open.mesh} onToggle={() => toggle('mesh')} title={t('vertex_section_mesh', { defaultValue: 'Maillage' })}>
              {stats && (
                <div className="flex gap-3 mb-1 text-[11px] font-mono" style={{ color: C.textDim }}>
                  <span>{t('vertex_stat_verts', { defaultValue: 'Sommets' })} : <span style={{ color: C.text }}>{stats.v.toLocaleString()}</span></span>
                  <span>{t('vertex_stat_tris',  { defaultValue: 'Triangles' })} : <span style={{ color: C.text }}>{stats.f.toLocaleString()}</span></span>
                </div>
              )}
              <div className="grid grid-cols-2 gap-1">
                <button onClick={onSubdivide}
                        className="flex items-center justify-center gap-1.5 px-2 py-1 rounded text-[11px]"
                        style={{ background: C.bg, color: C.text, border: `1px solid ${C.border}` }}>
                  <Grid3x3 size={12} /> {t('vertex_subdivide', { defaultValue: 'Subdiviser' })}
                </button>
                <button onClick={onDecimate}
                        className="flex items-center justify-center gap-1.5 px-2 py-1 rounded text-[11px]"
                        style={{ background: C.bg, color: C.text, border: `1px solid ${C.border}` }}>
                  <Minimize2 size={12} /> {t('vertex_decimate', { defaultValue: 'Décimer' })}
                </button>
                <button onClick={onWeld}
                        className="flex items-center justify-center gap-1.5 px-2 py-1 rounded text-[11px]"
                        style={{ background: C.bg, color: C.text, border: `1px solid ${C.border}` }}>
                  <Merge size={12} /> {t('vertex_weld', { defaultValue: 'Souder' })}
                </button>
                <button onClick={onFlipNormals}
                        className="flex items-center justify-center gap-1.5 px-2 py-1 rounded text-[11px]"
                        style={{ background: C.bg, color: C.text, border: `1px solid ${C.border}` }}>
                  <FlipHorizontal size={12} /> {t('vertex_flip_normals', { defaultValue: 'Inverser normales' })}
                </button>
              </div>
            </PSection>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Sculpt panel ─────────────────────────────────────────────────────────────
// Full sculpt workstation: active-brush card + per-brush settings (persisted),
// grouped brush library with custom brushes (create / rename / delete), falloff
// curves, X/Y/Z symmetry and the dyntopo section.
// Module-scope building blocks (defining them inside the panel would recreate
// their component type per render, remounting the slider mid-drag).
function SculptSlider({ label, value, min, max, step, fmt, onChange }: {
  label: string; value: number; min: number; max: number; step: number
  fmt: (v: number) => string; onChange: (v: number) => void
}) {
  return (
    <div className="mb-1.5">
      <div className="flex justify-between mb-0.5">
        <span className="text-[11px]" style={{ color: C.textDim }}>{label}</span>
        <span className="text-[11px] font-mono" style={{ color: C.accent }}>{fmt(value)}</span>
      </div>
      <RangeSlider min={min} max={max} step={step} value={value} onChange={onChange}
        className="w-full" accent={C.accent} trackColor="rgba(255,255,255,0.15)" aria-label={label} />
    </div>
  )
}
function SymAxisButton({ axis, symAxes, onSymAxes }: {
  axis: keyof SymAxes; symAxes: SymAxes; onSymAxes: (v: SymAxes) => void
}) {
  return (
    <button onClick={() => onSymAxes({ ...symAxes, [axis]: !symAxes[axis] })}
      className="flex-1 h-6 rounded text-[11px] font-medium uppercase"
      style={{
        background: symAxes[axis] ? C.accent + '33' : C.bg,
        color: symAxes[axis] ? C.accent : C.textDim,
        border: `1px solid ${symAxes[axis] ? C.accent : C.border}`,
      }}>
      {axis}
    </button>
  )
}

interface SculptPanelProps {
  brushes:        BrushDef[]
  activeBrushId:  string
  settingsFor:    (id: string) => BrushSettings
  onSelectBrush:  (id: string) => void
  onPatchBrush:   (id: string, patch: Partial<BrushSettings>) => void
  onCreateBrush:  (fromId: string) => void
  onRenameBrush:  (id: string) => void
  onDeleteBrush:  (id: string) => void
  onResetBrush:   (id: string) => void
  symAxes:        SymAxes
  onSymAxes:      (v: SymAxes) => void
  dyntopo:        DyntopoOpts
  onDyntopo:      (v: DyntopoOpts) => void
  onFloodDetail:  () => void
  canFlood:       boolean
}

function SculptPanel({
  brushes, activeBrushId, settingsFor, onSelectBrush, onPatchBrush,
  onCreateBrush, onRenameBrush, onDeleteBrush, onResetBrush,
  symAxes, onSymAxes, dyntopo, onDyntopo, onFloodDetail, canFlood,
}: SculptPanelProps) {
  const { t } = useTranslation('paintsharp')
  const ctx = useContextMenu()
  const [open, setOpen] = useState<Record<string, boolean>>({ brush: true, lib: true, sym: true, dyn: true })
  const toggle = (k: string) => setOpen(p => ({ ...p, [k]: !p[k] }))

  const active = brushes.find(b => b.id === activeBrushId) ?? brushes[0]
  const meta = BRUSH_META[active.base]
  const s = settingsFor(active.id)

  const groups: Array<{ id: BrushGroup | 'custom'; label: string; list: BrushDef[] }> = [
    { id: 'add',     label: t('vertex_group_add_brushes', { defaultValue: 'Ajouter de la matière' }),
      list: brushes.filter(b => b.builtin && !b.name && BRUSH_META[b.base].group === 'add') },
    { id: 'surface', label: t('vertex_group_surface',     { defaultValue: 'Surface' }),
      list: brushes.filter(b => b.builtin && !b.name && BRUSH_META[b.base].group === 'surface') },
    { id: 'deform',  label: t('vertex_group_deform',      { defaultValue: 'Déformer' }),
      list: brushes.filter(b => b.builtin && !b.name && BRUSH_META[b.base].group === 'deform') },
    { id: 'custom',  label: t('vertex_group_custom',      { defaultValue: 'Personnalisés' }),
      list: brushes.filter(b => !b.builtin || !!b.name) },
  ]

  const brushCtxMenu = (e: React.MouseEvent, b: BrushDef) => {
    const items: CtxItem[] = [
      { label: t('vertex_brush_duplicate', { defaultValue: 'Dupliquer en pinceau perso' }), onClick: () => onCreateBrush(b.id) },
      { label: t('vertex_brush_reset', { defaultValue: 'Réinitialiser les réglages' }), onClick: () => onResetBrush(b.id) },
    ]
    if (!b.builtin) {
      items.push('sep',
        { label: t('vertex_brush_rename', { defaultValue: 'Renommer' }), onClick: () => onRenameBrush(b.id) },
        { label: t('vertex_brush_delete', { defaultValue: 'Supprimer' }), onClick: () => onDeleteBrush(b.id), danger: true })
    }
    ctx.open(e, items)
  }

  return (
    <div className="flex flex-col h-full" style={{ background: C.bgPanel }}>
      <div className="flex items-center px-3 py-2 border-b" style={{ borderColor: C.border }}>
        <Brush size={13} style={{ color: C.textDim, marginRight: 6 }} />
        <span className="text-xs font-medium" style={{ color: C.text }}>{t('vertex_sculpt_panel', { defaultValue: 'Sculpture' })}</span>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {/* Active brush + its persisted settings */}
        <PSection title={t('vertex_active_brush', { defaultValue: 'Pinceau actif' })} open={!!open.brush} onToggle={() => toggle('brush')}>
          <div className="flex items-center gap-2 mb-2">
            <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0"
                 style={{ background: meta.color }}>
              <meta.Icon size={15} style={{ color: '#fff' }} />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-medium truncate" style={{ color: C.text }}>{brushDisplayName(t, active)}</p>
              <p className="text-[10px]" style={{ color: C.textDim }}>
                {active.name ? `${t('vertex_brush_base', { defaultValue: 'Base' })} : ${t(meta.labelKey, { defaultValue: meta.label })}` : t('vertex_brush_builtin', { defaultValue: 'Intégré' })}
              </p>
            </div>
          </div>
          <SculptSlider label={t('vertex_radius')} value={s.radius} min={0.05} max={3} step={0.01}
            fmt={v => v.toFixed(2)} onChange={v => onPatchBrush(active.id, { radius: v })} />
          <SculptSlider label={t('vertex_strength')} value={s.strength} min={0.02} max={1} step={0.01}
            fmt={v => `${Math.round(v * 100)}%`} onChange={v => onPatchBrush(active.id, { strength: v })} />
          {!DRAG_BASES.includes(active.base) && (
            <SculptSlider label={t('vertex_spacing', { defaultValue: 'Espacement' })} value={s.spacing} min={0.05} max={1} step={0.05}
              fmt={v => `${Math.round(v * 100)}%`} onChange={v => onPatchBrush(active.id, { spacing: v })} />
          )}
          {/* Falloff curve */}
          <div className="mb-1.5">
            <span className="text-[11px] block mb-1" style={{ color: C.textDim }}>{t('vertex_falloff', { defaultValue: 'Atténuation' })}</span>
            <div className="flex gap-1">
              {FALLOFF_KINDS.map(k => (
                <button key={k} onClick={() => onPatchBrush(active.id, { falloff: k })}
                  title={t(`vertex_falloff_${k}`, { defaultValue: k })}
                  className="flex-1 h-7 rounded flex items-center justify-center"
                  style={{
                    background: s.falloff === k ? C.accent + '33' : C.bg,
                    border: `1px solid ${s.falloff === k ? C.accent : C.border}`,
                  }}>
                  <FalloffIcon kind={k} color={s.falloff === k ? C.accent : C.textDim} />
                </button>
              ))}
            </div>
          </div>
          {/* Pen pressure */}
          <div className="flex gap-2">
            {([['pressureStrength', t('vertex_pressure_strength', { defaultValue: 'Pression → force' })],
               ['pressureRadius',   t('vertex_pressure_radius',   { defaultValue: 'Pression → rayon' })]] as const).map(([key, label]) => (
              <button key={key} onClick={() => onPatchBrush(active.id, { [key]: !s[key] } as Partial<BrushSettings>)}
                className="flex-1 h-6 rounded text-[10px] px-1"
                style={{
                  background: s[key] ? C.accent + '33' : C.bg,
                  color: s[key] ? C.accent : C.textDim,
                  border: `1px solid ${s[key] ? C.accent : C.border}`,
                }}>
                {label}
              </button>
            ))}
          </div>
        </PSection>

        {/* Brush library */}
        <PSection title={t('vertex_brush_library', { defaultValue: 'Pinceaux' })} open={!!open.lib} onToggle={() => toggle('lib')}>
          {groups.map(g => (g.list.length > 0 || g.id === 'custom') && (
            <div key={g.id} className="mb-2">
              <p className="text-[10px] uppercase tracking-wider mb-1" style={{ color: C.textDim }}>{g.label}</p>
              <div className="grid grid-cols-4 gap-1">
                {g.list.map(b => {
                  const m = BRUSH_META[b.base]
                  const isActive = b.id === activeBrushId
                  return (
                    <button key={b.id}
                      onClick={() => onSelectBrush(b.id)}
                      onContextMenu={(e) => brushCtxMenu(e, b)}
                      title={`${brushDisplayName(t, b)} — ${t('vertex_brush_ctx_hint', { defaultValue: 'clic droit : options' })}`}
                      className="flex flex-col items-center gap-0.5 py-1.5 rounded"
                      style={{
                        background: isActive ? `${m.color}20` : 'transparent',
                        border: `1px solid ${isActive ? m.color : C.border}`,
                      }}>
                      <div className="w-7 h-7 rounded-full flex items-center justify-center relative"
                           style={{ background: isActive ? m.color : C.bg }}>
                        <m.Icon size={13} style={{ color: isActive ? '#fff' : m.color }} />
                        {(!b.builtin || b.name) && (
                          <Sparkles size={8} style={{ position: 'absolute', top: -2, right: -2, color: C.accent }} />
                        )}
                      </div>
                      <span className="text-[10px] leading-tight truncate w-full text-center"
                            style={{ color: isActive ? C.text : C.textDim }}>
                        {brushDisplayName(t, b)}
                      </span>
                    </button>
                  )
                })}
                {g.id === 'custom' && (
                  <button onClick={() => onCreateBrush(activeBrushId)}
                    title={t('vertex_brush_new', { defaultValue: 'Nouveau pinceau à partir de l’actif' })}
                    className="flex flex-col items-center justify-center gap-0.5 py-1.5 rounded"
                    style={{ border: `1px dashed ${C.border}`, color: C.textDim }}>
                    <Plus size={14} />
                    <span className="text-[10px]">{t('vertex_brush_new_short', { defaultValue: 'Nouveau' })}</span>
                  </button>
                )}
              </div>
            </div>
          ))}
        </PSection>

        {/* Symmetry */}
        <PSection title={t('vertex_symmetry')} open={!!open.sym} onToggle={() => toggle('sym')}>
          <div className="flex gap-1">
            <SymAxisButton axis="x" symAxes={symAxes} onSymAxes={onSymAxes} /><SymAxisButton axis="y" symAxes={symAxes} onSymAxes={onSymAxes} /><SymAxisButton axis="z" symAxes={symAxes} onSymAxes={onSymAxes} />
          </div>
        </PSection>

        {/* Dyntopo */}
        <PSection title="Dyntopo" open={!!open.dyn} onToggle={() => toggle('dyn')}>
          <button onClick={() => onDyntopo({ ...dyntopo, enabled: !dyntopo.enabled })}
            className="flex items-center justify-center gap-1.5 w-full h-7 rounded text-[11px] mb-1.5"
            style={{
              background: dyntopo.enabled ? C.accent + '33' : C.bg,
              color: dyntopo.enabled ? C.accent : C.textDim,
              border: `1px solid ${dyntopo.enabled ? C.accent : C.border}`,
            }}>
            <Network size={12} />
            {dyntopo.enabled
              ? t('vertex_dyntopo_on',  { defaultValue: 'Topologie dynamique : ON' })
              : t('vertex_dyntopo_off', { defaultValue: 'Topologie dynamique : OFF' })}
          </button>
          <SculptSlider label={t('vertex_dyntopo_detail', { defaultValue: 'Détail (taille d’arête)' })}
            value={dyntopo.detail} min={0.02} max={0.4} step={0.005}
            fmt={v => v.toFixed(3)} onChange={v => onDyntopo({ ...dyntopo, detail: v })} />
          <button onClick={onFloodDetail} disabled={!canFlood}
            className="flex items-center justify-center gap-1.5 w-full h-7 rounded text-[11px] disabled:opacity-40"
            style={{ background: C.bg, color: C.text, border: `1px solid ${C.border}` }}>
            <RefreshCcw size={12} /> {t('vertex_dyntopo_flood', { defaultValue: 'Détail uniforme (tout le maillage)' })}
          </button>
          <p className="text-[10px] leading-snug mt-1.5" style={{ color: C.textDim }}>
            {t('vertex_dyntopo_hint', { defaultValue: 'Raffine la topologie sous le pinceau pendant le trait. Les couleurs/poids/UV de l’objet sont abandonnés au premier changement de topologie.' })}
          </p>
        </PSection>

        {/* Shortcuts legend */}
        <p className="text-[10px] leading-snug" style={{ color: C.textDim }}>
          {t('vertex_sculpt_legend', { defaultValue: 'Maj = lisser · Ctrl / clic droit = inverser · [ ] = rayon · clic droit (sans glisser) = menu' })}
        </p>
      </div>
      {ctx.menu}
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
      <span className="text-[10px] uppercase tracking-widest mb-0.5" style={{ color: C.textDim }}>{t('vertex_group_object')}</span>
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
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const cur = MODE_LIST.find(m => m.id === mode)!
  return (
    <div style={{ minWidth: 150 }}>
      <button
        onClick={e => {
          const r = e.currentTarget.getBoundingClientRect()
          setPos(p => p ? null : { top: r.bottom + 4, left: r.left })
        }}
        className="flex items-center gap-2 px-2.5 h-7 rounded text-xs w-full"
        style={{ background: C.panel, color: C.text, border: `1px solid ${C.border}` }}>
        <cur.Icon size={14} style={{ color: C.accent }} />
        <span className="flex-1 text-left">{t(cur.labelKey)}</span>
        <ChevronDown size={13} style={{ color: C.textDim }} />
      </button>
      {pos && (
        <MenuDropdown theme="dark" pos={{ ...pos, minWidth: 200 }} onClose={() => setPos(null)}
          items={MODE_LIST.map<UiMenuItem>(m => ({
            type: 'action',
            label: t(m.labelKey),
            icon: <m.Icon size={14} />,
            checked: m.id === mode,
            onClick: () => onMode(m.id),
          }))} />
      )}
    </div>
  )
}

// ── Primitive catalogue (shared by the Add menu / dropdown / context menu) ─────
function primCatalog(t: ReturnType<typeof useTranslation>['t']): Array<{ type: PrimType; label: string; Icon: LucideIcon }> {
  return [
    { type: 'box',       label: t('vertex_prim_box'),                                        Icon: Box },
    { type: 'sphere',    label: t('vertex_prim_sphere'),                                     Icon: Circle },
    { type: 'icosphere', label: t('vertex_prim_icosphere', { defaultValue: 'Icosphère' }),   Icon: Hexagon },
    { type: 'cylinder',  label: t('vertex_prim_cylinder'),                                   Icon: Cylinder },
    { type: 'cone',      label: t('vertex_prim_cone', { defaultValue: 'Cône' }),             Icon: Cone },
    { type: 'capsule',   label: t('vertex_prim_capsule', { defaultValue: 'Capsule' }),       Icon: Pill },
    { type: 'torus',     label: t('vertex_prim_torus'),                                      Icon: Torus },
    { type: 'torusknot', label: t('vertex_prim_torusknot', { defaultValue: 'Nœud torique' }), Icon: InfinityIcon },
    { type: 'plane',     label: t('vertex_prim_plane', { defaultValue: 'Plan' }),            Icon: Square },
  ]
}

// Compact "Add" dropdown button for the options bar.
function AddObjectButton({ onAdd, onImport }: { onAdd: (type: PrimType) => void; onImport: () => void }) {
  const { t } = useTranslation('paintsharp')
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  return (
    <>
      <button
        onClick={e => {
          const r = e.currentTarget.getBoundingClientRect()
          setPos(p => p ? null : { top: r.bottom + 4, left: r.left })
        }}
        className="flex items-center gap-1.5 px-2.5 h-7 rounded text-xs"
        style={{ background: C.panel, color: C.text, border: `1px solid ${C.border}` }}>
        <Plus size={14} style={{ color: C.accent }} />
        {t('vertex_add_label')}
        <ChevronDown size={13} style={{ color: C.textDim }} />
      </button>
      {pos && (
        <MenuDropdown theme="dark" pos={{ ...pos, minWidth: 200 }} onClose={() => setPos(null)}
          items={[
            ...primCatalog(t).map<UiMenuItem>(p => ({
              type: 'action', label: p.label, icon: <p.Icon size={14} />, onClick: () => onAdd(p.type),
            })),
            { type: 'separator' },
            { type: 'action', label: t('vertex_import', { defaultValue: 'Importer un maillage…' }), icon: <Upload size={14} />, onClick: onImport },
          ]} />
      )}
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
      color: new THREE.Color(o.color ?? DEFAULT_OBJECT_COLOR),
      roughness: o.roughness ?? 0.45, metalness: o.metalness ?? 0.15,
      transparent: (o.opacity ?? 1) < 1, opacity: o.opacity ?? 1,
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
  const [brushRadius,   setBrushRadius]   = useState(0.55)    // paint modes only
  const [brushStrength, setBrushStrength] = useState(0.5)     // paint modes only
  const [paintColor,    setPaintColor]    = useState('#e8543a')
  const [paintWeight,   setPaintWeight]   = useState(1)
  const [wireframe,     setWireframe]     = useState(false)

  const dockCtrl = useRef<DockController | null>(null)
  // Surface the matching tool panel when a mode is entered (brush panel in
  // sculpt/paint modes) so each mode presents its own options.
  useEffect(() => {
    const c = dockCtrl.current
    if (!c) return
    if (mode === 'sculpt') { c.open('brush'); c.activate('brush') }
  }, [mode])

  // ── Sculpt: brush library (custom brushes + per-brush settings, persisted) ────
  const [activeBrushId, setActiveBrushId] = useState('clay')
  const [customBrushes, setCustomBrushes] = useState<BrushDef[]>(() => loadLSArray<BrushDef>(LS_CUSTOM, []))
  const [brushOverrides, setBrushOverrides] = useState<Record<string, Partial<BrushSettings>>>(() => loadLS(LS_OVERRIDE, {}))
  useEffect(() => { try { localStorage.setItem(LS_CUSTOM, JSON.stringify(customBrushes)) } catch { /* quota */ } }, [customBrushes])
  useEffect(() => { try { localStorage.setItem(LS_OVERRIDE, JSON.stringify(brushOverrides)) } catch { /* quota */ } }, [brushOverrides])
  const brushes = useMemo<BrushDef[]>(() => [...BUILTIN_BRUSHES, ...customBrushes], [customBrushes])
  const settingsFor = useCallback((bid: string): BrushSettings => {
    const def = brushes.find(b => b.id === bid) ?? BUILTIN_BRUSHES[0]
    return { ...def.settings, ...brushOverrides[bid] }
  }, [brushes, brushOverrides])
  const patchBrush = useCallback((bid: string, patch: Partial<BrushSettings>) => {
    setBrushOverrides(prev => ({ ...prev, [bid]: { ...prev[bid], ...patch } }))
  }, [])
  const resetBrush = useCallback((bid: string) => {
    setBrushOverrides(prev => {
      const next = { ...prev }
      delete next[bid]
      return next
    })
  }, [])
  const activeBrush = useMemo<ActiveBrush>(() => {
    const def = brushes.find(b => b.id === activeBrushId) ?? BUILTIN_BRUSHES[0]
    return { id: def.id, base: def.base, settings: settingsFor(def.id) }
  }, [brushes, activeBrushId, settingsFor])

  // ── Sculpt: symmetry + dyntopo (persisted preferences) ────────────────────────
  const [symAxes, setSymAxes] = useState<SymAxes>(() => {
    const p = loadLS(LS_SCULPT, { symX: false, symY: false, symZ: false })
    return { x: !!p.symX, y: !!p.symY, z: !!p.symZ }
  })
  const [dyntopo, setDyntopo] = useState<DyntopoOpts>(() => {
    const p = loadLS(LS_SCULPT, { dyntopo: false, detail: 0.08 })
    return { enabled: !!p.dyntopo, detail: typeof p.detail === 'number' ? p.detail : 0.08 }
  })
  useEffect(() => {
    try {
      localStorage.setItem(LS_SCULPT, JSON.stringify({
        symX: symAxes.x, symY: symAxes.y, symZ: symAxes.z,
        dyntopo: dyntopo.enabled, detail: dyntopo.detail,
      }))
    } catch { /* quota */ }
  }, [symAxes, dyntopo])
  const [snapping,      setSnapping]      = useState(false)
  const [transformSpace, setTransformSpace] = useState<'world' | 'local'>('world')
  const [showGrid,      setShowGrid]      = useState(true)
  const [showShadows,   setShowShadows]   = useState(true)
  const [showStats,     setShowStats]     = useState(true)
  const [selectedIds,   setSelectedIds]   = useState<string[]>([])
  // Brush-cursor position: a mutable ref consumed by the render loop — hover
  // pointermoves must NOT re-render the page (that alone caused visible lag).
  const cursorRef = useRef<CursorRef>({ point: new THREE.Vector3(), normal: new THREE.Vector3(0, 0, 1), has: false })
  const [focusSignal,   setFocusSignal]   = useState(0)
  const [viewSignal,    setViewSignal]    = useState<{ seq: number; kind: ViewKind } | null>(null)
  const [editAction,    setEditAction]    = useState<{ seq: number; kind: 'all' | 'none' } | null>(null)
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
  const HIST_CAP = 50

  // Snapshots are SHALLOW: scene mutations never write into existing objects
  // (every commit rebuilds the changed entry), so history can share references.
  // structuredClone here deep-copied megabytes of mesh data at EVERY stroke
  // start — the single biggest sculpt hitch.
  const record = useCallback(() => {
    past.current.push([...objectsRef.current])
    if (past.current.length > HIST_CAP) past.current.shift()
    future.current = []
    bumpHist(v => v + 1)
  }, [])

  const undo = useCallback(() => {
    if (!past.current.length) return
    future.current.push([...objectsRef.current])
    const prev = past.current.pop()!
    setObjects(prev)
    setSelectedIds(ids => ids.filter(s => prev.some(o => o.id === s)))
    bumpHist(v => v + 1)
  }, [])

  const redo = useCallback(() => {
    if (!future.current.length) return
    past.current.push([...objectsRef.current])
    const next = future.current.pop()!
    setObjects(next)
    setSelectedIds(ids => ids.filter(s => next.some(o => o.id === s)))
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
      setSelectedIds([])
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

  const activeId    = selectedIds.length ? selectedIds[selectedIds.length - 1] : null
  const selectedObj = objects.find(o => o.id === activeId) ?? null
  const ctx = useContextMenu()
  const selectedIdsRef = useRef(selectedIds)
  useEffect(() => { selectedIdsRef.current = selectedIds }, [selectedIds])

  // ── Object selection (multi) ──────────────────────────────────────────────────
  const selectObject = useCallback((id: string | null, additive = false) => {
    if (id === null) { setSelectedIds([]); return }
    setSelectedIds(prev => {
      if (!additive) return [id]
      // Additive toggle; a re-clicked object becomes the active one (moves last).
      return prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    })
  }, [])

  const selectAll    = useCallback(() => setSelectedIds(objectsRef.current.filter(o => o.visible && !o.locked).map(o => o.id)), [])
  const selectNone   = useCallback(() => setSelectedIds([]), [])
  const invertSelect = useCallback(() => {
    setSelectedIds(prev => objectsRef.current.filter(o => o.visible && !o.locked && !prev.includes(o.id)).map(o => o.id))
  }, [])

  const addObject = useCallback((primType: PrimType) => {
    const labels: Record<PrimType, string> = {
      box:       t('vertex_prim_box'),
      sphere:    t('vertex_prim_sphere'),
      cylinder:  t('vertex_prim_cylinder'),
      torus:     t('vertex_prim_torus'),
      cone:      t('vertex_prim_cone',      { defaultValue: 'Cône' }),
      plane:     t('vertex_prim_plane',     { defaultValue: 'Plan' }),
      icosphere: t('vertex_prim_icosphere', { defaultValue: 'Icosphère' }),
      capsule:   t('vertex_prim_capsule',   { defaultValue: 'Capsule' }),
      torusknot: t('vertex_prim_torusknot', { defaultValue: 'Nœud torique' }),
      custom:    t('vertex_prim_custom',    { defaultValue: 'Maillage' }),
      container: t('vertex_container',       { defaultValue: 'Conteneur' }),
    }
    record()
    const newObj: SceneObject = {
      id:       `obj-${Date.now()}`,
      name:     labels[primType],
      primType,
      visible:  true,
      position: [(Math.random() - 0.5) * 4, 0.8, (Math.random() - 0.5) * 4],
      color:    OBJECT_PALETTE[objectsRef.current.length % OBJECT_PALETTE.length],
    }
    setObjects(prev => [...prev, newObj])
    setSelectedIds([newObj.id])
  }, [t, record])

  const toggleVisibility = useCallback((tid: string) => {
    record()
    setObjects(prev => prev.map(o => o.id === tid ? { ...o, visible: !o.visible } : o))
  }, [record])

  // Object ops target the whole selection (or a single explicit id).
  const targetIds = useCallback((tid?: string) => {
    const sel = selectedIdsRef.current
    return tid && !sel.includes(tid) ? [tid] : (sel.length ? sel : (tid ? [tid] : []))
  }, [])

  const deleteObjects = useCallback((tid?: string) => {
    const ids = targetIds(tid)
    if (!ids.length) return
    record()
    setObjects(prev => prev.filter(o => !ids.includes(o.id)))
    setSelectedIds(prev => prev.filter(s => !ids.includes(s)))
  }, [record, targetIds])

  const duplicateObjects = useCallback((tid?: string) => {
    const ids = targetIds(tid)
    if (!ids.length) return
    record()
    setObjects(prev => {
      const copies: SceneObject[] = []
      for (const id of ids) {
        const src = prev.find(o => o.id === id)
        if (!src) continue
        // Shallow copy: the shared mesh payload is immutable (sculpting the
        // copy commits a fresh MeshData), so no deep clone is needed.
        copies.push({
          ...src,
          id:   `obj-${Date.now()}-${copies.length}`,
          name: `${src.name} copy`,
          position: [src.position[0] + 0.6, src.position[1], src.position[2] + 0.6],
        })
      }
      if (copies.length) setSelectedIds(copies.map(c => c.id))
      return [...prev, ...copies]
    })
  }, [record, targetIds])

  const hideSelected = useCallback(() => {
    const ids = targetIds()
    if (!ids.length) return
    record()
    setObjects(prev => prev.map(o => ids.includes(o.id) ? { ...o, visible: false } : o))
    setSelectedIds([])
  }, [record, targetIds])

  const showAll = useCallback(() => {
    record()
    setObjects(prev => prev.map(o => o.visible ? o : { ...o, visible: true }))
  }, [record])

  // Property/transform edits (record an undo step first). Rapid successive edits
  // of the same property (slider drags, typing) coalesce into one undo step —
  // otherwise a single drag would flood the history with full-scene snapshots.
  const lastEditRef = useRef<{ key: string; at: number }>({ key: '', at: 0 })
  const updateObject = useCallback((tid: string | null, patch: Partial<SceneObject>) => {
    if (!tid) return
    const key = `${tid}:${Object.keys(patch).join(',')}`
    const now = performance.now()
    if (key !== lastEditRef.current.key || now - lastEditRef.current.at > 1200) record()
    lastEditRef.current = { key, at: now }
    setObjects(prev => prev.map(o => o.id === tid ? { ...o, ...patch } : o))
  }, [record])

  // Patch every selected object (shading, lock…).
  const updateSelected = useCallback((patch: Partial<SceneObject>, tid?: string) => {
    const ids = targetIds(tid)
    if (!ids.length) return
    record()
    setObjects(prev => prev.map(o => ids.includes(o.id) ? { ...o, ...patch } : o))
  }, [record, targetIds])

  // Transform gizmo commit — the snapshot was already taken on drag start.
  // A translation of the active object drags the rest of the selection along.
  const commitTransform = useCallback((tid: string, patch: Partial<SceneObject>) => {
    const all = objectsRef.current
    const old = all.find(o => o.id === tid)
    // Container: carry every descendant along with the group's transform change
    // (proportional resize + reposition + rotation) via a delta matrix.
    if (old && old.primType === 'container' && (patch.position || patch.rotation || patch.scale)) {
      const M0 = composeMatrix(old.position, old.rotation, old.scale)
      const M1 = composeMatrix(patch.position ?? old.position, patch.rotation ?? old.rotation, patch.scale ?? old.scale)
      const delta = M1.clone().multiply(M0.clone().invert())
      const desc = collectDescendants(tid, all)
      const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3()
      setObjects(prev => prev.map(o => {
        if (o.id === tid) return { ...o, ...patch }
        if (!desc.has(o.id)) return o
        composeMatrix(o.position, o.rotation, o.scale).premultiply(delta).decompose(p, q, s)
        const e = new THREE.Euler().setFromQuaternion(q)
        return { ...o, position: [p.x, p.y, p.z], rotation: [e.x, e.y, e.z], scale: [s.x, s.y, s.z] }
      }))
      return
    }
    const sel = selectedIdsRef.current
    const delta: [number, number, number] | null = (old && patch.position && sel.length > 1 && sel.includes(tid))
      ? [patch.position[0] - old.position[0], patch.position[1] - old.position[1], patch.position[2] - old.position[2]]
      : null
    setObjects(prev => prev.map(o => {
      if (o.id === tid) return { ...o, ...patch }
      if (delta && sel.includes(o.id)) {
        return { ...o, position: [o.position[0] + delta[0], o.position[1] + delta[1], o.position[2] + delta[2]] }
      }
      return o
    }))
  }, [])

  // ── Containers (proportional groups) ─────────────────────────────────────────
  // Wrap the selection in a container sized to its world bounding box. Resizing /
  // moving / rotating the container then carries the children (see commitTransform).
  const groupSelected = useCallback(() => {
    const ids = selectedIdsRef.current.filter(id => {
      const o = objectsRef.current.find(x => x.id === id)
      return o && o.primType !== 'container' && !o.parentId
    })
    if (!ids.length) return
    const box = new THREE.Box3()
    const tmp = new THREE.Box3()
    for (const id of ids) {
      const o = objectsRef.current.find(x => x.id === id)!
      const geo = buildGeometry(o)
      applySavedPositions(geo, o.mesh)
      geo.computeBoundingBox()
      if (geo.boundingBox) { tmp.copy(geo.boundingBox).applyMatrix4(composeMatrix(o.position, o.rotation, o.scale)); box.union(tmp) }
      geo.dispose()
    }
    if (box.isEmpty()) return
    const c = box.getCenter(new THREE.Vector3())
    const s = box.getSize(new THREE.Vector3())
    const pad = 1.06
    record()
    const container: SceneObject = {
      id: `obj-${Date.now()}`,
      name: t('vertex_container', { defaultValue: 'Conteneur' }),
      primType: 'container', visible: true,
      position: [c.x, c.y, c.z],
      scale: [Math.max(0.3, s.x) * pad, Math.max(0.3, s.y) * pad, Math.max(0.3, s.z) * pad],
    }
    setObjects(prev => [...prev, container].map(o => ids.includes(o.id) ? { ...o, parentId: container.id } : o))
    setSelectedIds([container.id])
  }, [record, t])

  // Dissolve the selected container(s): free the children, drop the container.
  const ungroupSelected = useCallback(() => {
    const containers = selectedIdsRef.current.filter(id => objectsRef.current.find(x => x.id === id)?.primType === 'container')
    if (!containers.length) return
    record()
    setObjects(prev => prev
      .map(o => o.parentId && containers.includes(o.parentId) ? { ...o, parentId: undefined } : o)
      .filter(o => !containers.includes(o.id)))
    setSelectedIds([])
  }, [record])

  // ── Object operations (mirror / ground / transforms) ─────────────────────────
  const mirrorSelected = useCallback((axis: 0 | 1 | 2) => {
    const ids = targetIds()
    if (!ids.length) return
    record()
    setObjects(prev => prev.map(o => {
      if (!ids.includes(o.id)) return o
      const s = [...(o.scale ?? [1, 1, 1])] as [number, number, number]
      s[axis] = -s[axis]
      return { ...o, scale: s }
    }))
  }, [record, targetIds])

  const snapSelectedToGround = useCallback(() => {
    const ids = targetIds()
    if (!ids.length) return
    record()
    setObjects(prev => prev.map(o => {
      if (!ids.includes(o.id)) return o
      const geo = buildGeometry(o)
      applySavedPositions(geo, o.mesh)
      const dy = groundOffset(geo, o)
      geo.dispose()
      return { ...o, position: [o.position[0], o.position[1] + dy, o.position[2]] }
    }))
  }, [record, targetIds])

  const resetTransforms = useCallback(() => {
    const ids = targetIds()
    if (!ids.length) return
    record()
    setObjects(prev => prev.map(o => ids.includes(o.id)
      ? { ...o, position: [0, o.position[1], 0], rotation: undefined, scale: undefined }
      : o))
  }, [record, targetIds])

  // Bake rotation + scale into the geometry (object becomes 'custom').
  const applyTransforms = useCallback(() => {
    const ids = targetIds()
    if (!ids.length) return
    record()
    setObjects(prev => prev.map(o => {
      if (!ids.includes(o.id)) return o
      const hasRot   = o.rotation && o.rotation.some(v => v !== 0)
      const hasScale = o.scale && o.scale.some(v => v !== 1)
      if (!hasRot && !hasScale) return o
      const geo = buildGeometry(o)
      applySavedPositions(geo, o.mesh)
      const baked = bakeRotationScale(geo, o)
      geo.dispose()
      const { mesh, center } = geometryToCenteredMesh(baked)
      baked.dispose()
      return {
        ...o, primType: 'custom' as PrimType, mesh: mesh as MeshData,
        position: [o.position[0] + center[0], o.position[1] + center[1], o.position[2] + center[2]],
        rotation: undefined, scale: undefined,
      }
    }))
  }, [record, targetIds])

  // ── Merge: join & CSG booleans ────────────────────────────────────────────────
  // Builds world-baked geometries for the given ids (deformations included).
  const bakedSelection = useCallback((ids: string[]) => {
    const geos: THREE.BufferGeometry[] = []
    for (const id of ids) {
      const o = objectsRef.current.find(x => x.id === id)
      if (!o) continue
      const geo = buildGeometry(o)
      applySavedPositions(geo, o.mesh)
      geos.push(bakeWorldGeometry(geo, o))
      geo.dispose()
    }
    return geos
  }, [])

  // Replace the selection with one fused object (keeps the active object's look).
  const replaceSelectionWith = useCallback((ids: string[], mesh: MeshData, center: [number, number, number], name: string) => {
    record()
    const activeSrc = objectsRef.current.find(o => o.id === ids[ids.length - 1])
    const fused: SceneObject = {
      id: `obj-${Date.now()}`,
      name,
      primType: 'custom',
      visible: true,
      position: center,
      color:     activeSrc?.color,
      roughness: activeSrc?.roughness,
      metalness: activeSrc?.metalness,
      shadeFlat: activeSrc?.shadeFlat,
      mesh,
    }
    setObjects(prev => [...prev.filter(o => !ids.includes(o.id)), fused])
    setSelectedIds([fused.id])
  }, [record])

  const joinSelected = useCallback(() => {
    const ids = selectedIdsRef.current
    if (ids.length < 2) return
    const geos = bakedSelection(ids)
    try {
      const { mesh, center } = joinGeometries(geos)
      const name = objectsRef.current.find(o => o.id === ids[ids.length - 1])?.name ?? 'Join'
      replaceSelectionWith(ids, mesh as MeshData, center, name)
    } catch (err) {
      console.error('Vertex join failed', err)
    } finally {
      geos.forEach(g => g.dispose())
    }
  }, [bakedSelection, replaceSelectionWith])

  const booleanSelected = useCallback(async (op: BooleanOp) => {
    const ids = selectedIdsRef.current
    if (ids.length < 2) return
    // Blender-like: the ACTIVE object (last selected) is the primary operand.
    const ordered = [ids[ids.length - 1], ...ids.slice(0, -1)]
    const geos = bakedSelection(ordered)
    try {
      const { mesh, center } = await booleanGeometries(geos, op)
      const names: Record<BooleanOp, string> = {
        union:      t('vertex_bool_union',     { defaultValue: 'Union' }),
        difference: t('vertex_bool_difference', { defaultValue: 'Différence' }),
        intersect:  t('vertex_bool_intersect', { defaultValue: 'Intersection' }),
      }
      replaceSelectionWith(ids, mesh as MeshData, center, names[op])
    } catch (err) {
      console.error('Vertex boolean failed', err)
    } finally {
      geos.forEach(g => g.dispose())
    }
  }, [bakedSelection, replaceSelectionWith, t])

  // Sculpt/paint stroke commit — snapshot already taken on pointer-down.
  // A dyntopo stroke changes the topology: the object bakes into a custom mesh.
  const commitMesh = useCallback((tid: string, mesh: MeshData, topologyChanged?: boolean) => {
    setObjects(prev => prev.map(o => o.id === tid
      ? (topologyChanged ? { ...o, primType: 'custom', mesh } : { ...o, mesh })
      : o))
  }, [])

  // ── Custom brushes (create from an existing one / rename / delete) ───────────
  const createBrush = useCallback(async (fromId: string) => {
    const src = brushes.find(b => b.id === fromId) ?? BUILTIN_BRUSHES[0]
    const name = await prompt({
      title: t('vertex_brush_new', { defaultValue: 'Nouveau pinceau à partir de l’actif' }),
      message: t('vertex_brush_name', { defaultValue: 'Nom du pinceau' }),
      defaultValue: `${brushDisplayName(t, src)} 2`,
    })
    if (!name?.trim()) return
    const nb: BrushDef = {
      id: `custom-${Date.now()}`,
      base: src.base,
      builtin: false,
      name: name.trim(),
      settings: { ...settingsFor(fromId) },      // inherit the source's live settings
    }
    setCustomBrushes(prev => [...prev, nb])
    setActiveBrushId(nb.id)
  }, [brushes, settingsFor, t])

  const renameBrush = useCallback(async (bid: string) => {
    const b = customBrushes.find(x => x.id === bid)
    if (!b) return
    const name = await prompt({
      title: t('vertex_brush_rename', { defaultValue: 'Renommer' }),
      message: t('vertex_brush_name', { defaultValue: 'Nom du pinceau' }),
      defaultValue: b.name ?? '',
    })
    if (!name?.trim()) return
    setCustomBrushes(prev => prev.map(x => x.id === bid ? { ...x, name: name.trim() } : x))
  }, [customBrushes, t])

  const deleteBrush = useCallback((bid: string) => {
    setCustomBrushes(prev => prev.filter(x => x.id !== bid))
    setBrushOverrides(prev => {
      const next = { ...prev }
      delete next[bid]
      return next
    })
    setActiveBrushId(cur => cur === bid ? 'clay' : cur)
  }, [])

  // ── Dyntopo: uniform detail over the whole active mesh ("flood fill") ─────────
  const floodDetail = useCallback((tid?: string) => {
    const targetId = tid ?? (selectedIdsRef.current.length ? selectedIdsRef.current[selectedIdsRef.current.length - 1] : null)
    if (!targetId) return
    const obj = objectsRef.current.find(o => o.id === targetId)
    if (!obj) return
    const src = buildGeometry(obj)
    applySavedPositions(src, obj.mesh)
    try {
      const welded = src.getIndex() ? src : mergeVertices(src)
      const attr = welded.attributes.position as THREE.BufferAttribute
      const idx = welded.getIndex()
      if (!idx) return
      const r = floodRefine(attr.array as Float32Array, attr.count, idx.array as ArrayLike<number>, Math.max(0.015, dyntopo.detail))
      if (!r.splits) return
      record()
      const mesh: MeshData = { positions: roundArr(r.positions), index: Array.from(r.index) }
      setObjects(prev => prev.map(o => o.id === targetId ? { ...o, primType: 'custom', mesh } : o))
    } finally {
      src.dispose()
    }
  }, [dyntopo.detail, record])

  // Mesh modifiers: rebuild topology, baking the object into a custom mesh. Paint
  // buffers (colors/weights/texture) are dropped since the vertex set changes.
  const remesh = useCallback(async (tid: string, op: 'subdivide' | 'decimate' | 'weld' | 'flip') => {
    const obj = objectsRef.current.find(o => o.id === tid)
    if (!obj) return
    const src = buildGeometry(obj)
    // buildGeometry yields the pristine primitive; re-apply any sculpted positions
    // so the modifier operates on the deformed mesh, not the original shape.
    applySavedPositions(src, obj.mesh)
    try {
      const out = op === 'subdivide' ? await subdivideGeometry(src)
        : op === 'decimate'          ? await decimateGeometry(src, 0.4)
        : op === 'weld'              ? weldGeometry(src)
        :                              flipGeometryNormals(src)
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

  // Run a remesh op on every selected object.
  const remeshSelected = useCallback((op: 'subdivide' | 'decimate' | 'weld' | 'flip') => {
    for (const id of selectedIdsRef.current) void remesh(id, op)
  }, [remesh])

  const handleCursorMove = useCallback((pos: THREE.Vector3, normal: THREE.Vector3) => {
    const c = cursorRef.current
    c.point.copy(pos)
    c.normal.copy(normal).normalize()
    c.has = true
  }, [])

  const handleCursorClear = useCallback(() => {
    cursorRef.current.has = false
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
      setSelectedIds(objs.map(o => o.id))
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
        else if (k === 'd') { e.preventDefault(); duplicateObjects() }
        else if (k === 'j') { e.preventDefault(); joinSelected() }
        else if (k === 'g') { e.preventDefault(); e.shiftKey ? ungroupSelected() : groupSelected() }
        else if (k === 'i') { e.preventDefault(); if (mode === 'object') invertSelect() }
        else if (k === 's') { e.preventDefault(); saveMut.mutate({ objects: objectsRef.current }) }
        return
      }
      // Blender numpad views: 1 front · 3 right · 7 top · 5 iso.
      if (e.code === 'Numpad1' || e.code === 'Numpad3' || e.code === 'Numpad7' || e.code === 'Numpad5') {
        const kind: ViewKind = e.code === 'Numpad1' ? 'front' : e.code === 'Numpad3' ? 'right' : e.code === 'Numpad7' ? 'top' : 'iso'
        setViewSignal(s => ({ seq: (s?.seq ?? 0) + 1, kind }))
        return
      }
      // In Edit Mode, 1/2/3 pick the select element (Blender), not the top-level mode.
      if (mode === 'edit' && (e.key === '1' || e.key === '2' || e.key === '3')) {
        setEditElem(e.key === '1' ? 'vertex' : e.key === '2' ? 'edge' : 'face')
        return
      }
      // Select all / none: object selection in Object Mode, vertices in Edit Mode.
      if (k === 'a') {
        e.preventDefault()
        if (mode === 'edit') setEditAction(s => ({ seq: (s?.seq ?? 0) + 1, kind: e.altKey ? 'none' : 'all' }))
        else e.altKey ? selectNone() : selectAll()
        return
      }
      if (k === 'h') {
        e.altKey ? showAll() : hideSelected()
        return
      }
      // Sculpt: [ ] adjust the active brush radius, { } its strength, D dyntopo.
      if (mode === 'sculpt') {
        if (e.key === '[' || e.key === ']') {
          const cur = settingsFor(activeBrushId).radius
          patchBrush(activeBrushId, { radius: Math.min(3, Math.max(0.05, e.key === '[' ? cur / 1.15 : cur * 1.15)) })
          return
        }
        if (e.key === '{' || e.key === '}') {
          const cur = settingsFor(activeBrushId).strength
          patchBrush(activeBrushId, { strength: Math.min(1, Math.max(0.02, e.key === '{' ? cur - 0.1 : cur + 0.1)) })
          return
        }
        if (k === 'd' && !e.shiftKey) {
          setDyntopo(v => ({ ...v, enabled: !v.enabled }))
          return
        }
      }
      switch (e.key) {
        case 'g': setMode('object'); setTransformMode('translate'); break
        case 'r': setMode('object'); setTransformMode('rotate'); break
        case 's': setMode('object'); setTransformMode('scale'); break
        case 'Tab': e.preventDefault(); setMode(m => m === 'edit' ? 'object' : 'edit'); break
        case 'D': if (e.shiftKey) duplicateObjects(); break
        case 'x': case 'Delete': deleteObjects(); break
        case 'm': setSymAxes(v => ({ ...v, x: !v.x })); break
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
  }, [mode, undo, redo, duplicateObjects, deleteObjects, joinSelected, groupSelected, ungroupSelected, invertSelect, selectAll, selectNone, hideSelected, showAll, saveMut, activeBrushId, settingsFor, patchBrush])

  // Autosave (debounced) — armed only once the scene has loaded.
  useDebouncedAutosave(objects, ready && !!id, (d) => saveMut.mutate({ objects: d }))

  // Live scene / selection statistics (cheap: cached per-primitive topology).
  const sceneStats = useMemo(() => {
    let v = 0, f = 0
    for (const o of objects.filter(x => x.visible)) { const s = objStats(o); v += s.v; f += s.f }
    return { v, f }
  }, [objects])
  const selStats = useMemo(() => {
    if (!selectedIds.length) return null
    let v = 0, f = 0
    for (const o of objects.filter(x => selectedIds.includes(x.id))) { const s = objStats(o); v += s.v; f += s.f }
    return { v, f }
  }, [objects, selectedIds])

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full" style={{ background: C.bg }}>
        <p style={{ color: C.textDim }} className="text-sm">{t('common_loading')}</p>
      </div>
    )
  }

  // Shared object context menu (outliner rows + viewport right-click).
  const objectCtxItems = (obj: SceneObject): CtxItem[] => {
    const multi = selectedIds.includes(obj.id) && selectedIds.length > 1
    const items: CtxItem[] = [
      { label: t('apex_duplicate'),     onClick: () => duplicateObjects(obj.id), shortcut: 'Ctrl+D' },
      { label: obj.visible ? t('vertex_ctx_hide') : t('vertex_ctx_show'), onClick: () => toggleVisibility(obj.id) },
      'sep',
    ]
    if (obj.primType === 'container') {
      items.push({ label: t('vertex_ungroup', { defaultValue: 'Dégrouper le conteneur' }), onClick: ungroupSelected, shortcut: 'Ctrl+Maj+G' }, 'sep')
    } else {
      items.push({ label: t('vertex_group', { defaultValue: 'Grouper dans un conteneur' }), onClick: groupSelected, shortcut: 'Ctrl+G' }, 'sep')
    }
    if (multi) {
      items.push(
        { label: t('vertex_join', { defaultValue: 'Joindre' }), onClick: joinSelected, shortcut: 'Ctrl+J' },
        { label: `${t('vertex_bool_union',      { defaultValue: 'Union' })} (CSG)`,        onClick: () => void booleanSelected('union') },
        { label: `${t('vertex_bool_difference', { defaultValue: 'Différence' })} (CSG)`,   onClick: () => void booleanSelected('difference') },
        { label: `${t('vertex_bool_intersect',  { defaultValue: 'Intersection' })} (CSG)`, onClick: () => void booleanSelected('intersect') },
        'sep',
      )
    }
    items.push(
      { label: t('vertex_snap_ground',    { defaultValue: 'Poser au sol' }),         onClick: snapSelectedToGround },
      { label: t('vertex_shade_smooth',   { defaultValue: 'Ombrage lisse' }),        onClick: () => updateSelected({ shadeFlat: false }, obj.id) },
      { label: t('vertex_shade_flat_full', { defaultValue: 'Ombrage plat' }),        onClick: () => updateSelected({ shadeFlat: true }, obj.id) },
      'sep',
      { label: t('apex_delete_element'), onClick: () => deleteObjects(obj.id), danger: true, shortcut: 'Suppr' },
    )
    return items
  }

  const onRowContextMenu = (e: React.MouseEvent, obj: SceneObject) => {
    if (!selectedIds.includes(obj.id)) setSelectedIds([obj.id])
    ctx.open(e, objectCtxItems(obj))
  }

  // Right-click on a mesh in the viewport (Object Mode).
  const onViewportObjectMenu = (oid: string, e: MouseEvent) => {
    const obj = objects.find(o => o.id === oid)
    if (!obj) return
    if (!selectedIds.includes(oid)) setSelectedIds([oid])
    ctx.open({ preventDefault: () => {}, clientX: e.clientX, clientY: e.clientY }, objectCtxItems(obj))
  }

  // Right-click on the empty viewport background: quick "add" menu (Object Mode),
  // sculpt quick menu in Sculpt Mode, nothing in the other paint modes.
  const onViewportBackgroundMenu = (e: React.MouseEvent) => {
    if (e.defaultPrevented) return   // a mesh already opened its own menu
    if (mode === 'sculpt') { e.preventDefault(); openSculptMenu(e.clientX, e.clientY); return }
    if (PAINT_MODES.includes(mode)) { e.preventDefault(); return }
    ctx.open(e, [
      ...primCatalog(t).map<CtxItem>(p => ({ label: `${t('vertex_add_label')} ${p.label}`, onClick: () => addObject(p.type) })),
      'sep',
      { label: t('vertex_import', { defaultValue: 'Importer un maillage…' }), onClick: () => fileInputRef.current?.click() },
    ])
  }

  // Sculpt context menu (RMB click without dragging): quick brush pick + toggles.
  const openSculptMenu = (x: number, y: number) => {
    const items: CtxItem[] = [
      ...brushes.map<CtxItem>(b => ({
        label: `${b.id === activeBrushId ? '✓ ' : ''}${brushDisplayName(t, b)}`,
        onClick: () => setActiveBrushId(b.id),
      })),
      'sep',
      { label: `${dyntopo.enabled ? '✓ ' : ''}Dyntopo`, shortcut: 'D', onClick: () => setDyntopo(v => ({ ...v, enabled: !v.enabled })) },
      { label: t('vertex_dyntopo_flood', { defaultValue: 'Détail uniforme (tout le maillage)' }), onClick: () => floodDetail() },
      'sep',
      { label: `${symAxes.x ? '✓ ' : ''}${t('vertex_symmetry')} X`, shortcut: 'M', onClick: () => setSymAxes(v => ({ ...v, x: !v.x })) },
      { label: `${symAxes.y ? '✓ ' : ''}${t('vertex_symmetry')} Y`, onClick: () => setSymAxes(v => ({ ...v, y: !v.y })) },
      { label: `${symAxes.z ? '✓ ' : ''}${t('vertex_symmetry')} Z`, onClick: () => setSymAxes(v => ({ ...v, z: !v.z })) },
      'sep',
      { label: t('vertex_brush_new', { defaultValue: 'Nouveau pinceau à partir de l’actif' }), onClick: () => void createBrush(activeBrushId) },
    ]
    ctx.open({ preventDefault: () => {}, clientX: x, clientY: y }, items)
  }
  const onSculptContextMenu = (e: MouseEvent) => openSculptMenu(e.clientX, e.clientY)

  const vertexPanels = {
    outliner: { label: t('vertex_outliner_title'), render: () => (
      <OutlinerPanel objects={objects} selectedIds={selectedIds} activeId={activeId}
        onSelect={(oid, additive) => selectObject(oid, additive)}
        onToggle={toggleVisibility} onDelete={(oid) => deleteObjects(oid)}
        onRename={(oid, name) => updateObject(oid, { name })}
        onRowContextMenu={onRowContextMenu} />
    ) },
    properties: { label: t('vertex_properties_title'), render: () => (
      <PropertiesPanel selected={selectedObj} stats={selectedObj ? objStats(selectedObj) : null}
        onPatch={p => updateObject(activeId, p)}
        onSubdivide={() => activeId && remesh(activeId, 'subdivide')}
        onDecimate={() => activeId && remesh(activeId, 'decimate')}
        onWeld={() => activeId && remesh(activeId, 'weld')}
        onFlipNormals={() => activeId && remesh(activeId, 'flip')} />
    ) },
    brush: { label: t('vertex_sculpt_panel', { defaultValue: 'Sculpture' }), render: () => (
      <SculptPanel
        brushes={brushes}
        activeBrushId={activeBrushId}
        settingsFor={settingsFor}
        onSelectBrush={setActiveBrushId}
        onPatchBrush={patchBrush}
        onCreateBrush={(fid) => void createBrush(fid)}
        onRenameBrush={(bid) => void renameBrush(bid)}
        onDeleteBrush={deleteBrush}
        onResetBrush={resetBrush}
        symAxes={symAxes}
        onSymAxes={setSymAxes}
        dyntopo={dyntopo}
        onDyntopo={setDyntopo}
        onFloodDetail={() => floodDetail()}
        canFlood={!!activeId}
      />
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
          label: t('vertex_menu_add', { defaultValue: 'Ajouter' }),
          items: [
            ...primCatalog(t).map(p => ({ label: p.label, onClick: () => addObject(p.type) })),
            'sep' as const,
            { label: t('vertex_import', { defaultValue: 'Importer un maillage…' }), onClick: () => fileInputRef.current?.click() },
          ],
        }, {
          label: t('vertex_menu_select', { defaultValue: 'Sélection' }),
          items: [
            { label: t('vertex_select_all',    { defaultValue: 'Tout sélectionner' }), shortcut: 'A',
              onClick: () => mode === 'edit' ? setEditAction(s => ({ seq: (s?.seq ?? 0) + 1, kind: 'all' })) : selectAll() },
            { label: t('vertex_select_none',   { defaultValue: 'Tout désélectionner' }), shortcut: 'Alt+A',
              onClick: () => mode === 'edit' ? setEditAction(s => ({ seq: (s?.seq ?? 0) + 1, kind: 'none' })) : selectNone() },
            { label: t('vertex_select_invert', { defaultValue: 'Inverser la sélection' }), shortcut: 'Ctrl+I',
              onClick: invertSelect, disabled: mode === 'edit' },
          ],
        }, {
          label: t('vertex_menu_object', { defaultValue: 'Objet' }),
          items: [
            { label: t('apex_duplicate'), onClick: () => duplicateObjects(), disabled: !selectedIds.length, shortcut: 'Ctrl+D' },
            { label: t('vertex_ctx_hide'), onClick: hideSelected, disabled: !selectedIds.length, shortcut: 'H' },
            { label: t('vertex_show_all', { defaultValue: 'Tout afficher' }), onClick: showAll, shortcut: 'Alt+H' },
            'sep',
            { label: t('vertex_group', { defaultValue: 'Grouper dans un conteneur' }), onClick: groupSelected, disabled: !selectedIds.length, shortcut: 'Ctrl+G' },
            { label: t('vertex_ungroup', { defaultValue: 'Dégrouper le conteneur' }), onClick: ungroupSelected, disabled: !selectedIds.some(id => objects.find(o => o.id === id)?.primType === 'container'), shortcut: 'Ctrl+Maj+G' },
            'sep',
            { label: t('vertex_join', { defaultValue: 'Joindre' }), onClick: joinSelected, disabled: selectedIds.length < 2, shortcut: 'Ctrl+J' },
            { label: `${t('vertex_bool_union',      { defaultValue: 'Union' })} (CSG)`,        onClick: () => void booleanSelected('union'),      disabled: selectedIds.length < 2 },
            { label: `${t('vertex_bool_difference', { defaultValue: 'Différence' })} (CSG)`,   onClick: () => void booleanSelected('difference'), disabled: selectedIds.length < 2 },
            { label: `${t('vertex_bool_intersect',  { defaultValue: 'Intersection' })} (CSG)`, onClick: () => void booleanSelected('intersect'),  disabled: selectedIds.length < 2 },
            'sep',
            { label: `${t('vertex_mirror', { defaultValue: 'Miroir' })} X`, onClick: () => mirrorSelected(0), disabled: !selectedIds.length },
            { label: `${t('vertex_mirror', { defaultValue: 'Miroir' })} Y`, onClick: () => mirrorSelected(1), disabled: !selectedIds.length },
            { label: `${t('vertex_mirror', { defaultValue: 'Miroir' })} Z`, onClick: () => mirrorSelected(2), disabled: !selectedIds.length },
            { label: t('vertex_snap_ground', { defaultValue: 'Poser au sol' }), onClick: snapSelectedToGround, disabled: !selectedIds.length },
            'sep',
            { label: t('vertex_apply_transform', { defaultValue: 'Appliquer la transformation' }), onClick: applyTransforms, disabled: !selectedIds.length },
            { label: t('vertex_reset_transform', { defaultValue: 'Réinitialiser la transformation' }), onClick: resetTransforms, disabled: !selectedIds.length },
            'sep',
            { label: t('vertex_shade_smooth',    { defaultValue: 'Ombrage lisse' }), onClick: () => updateSelected({ shadeFlat: false }), disabled: !selectedIds.length },
            { label: t('vertex_shade_flat_full', { defaultValue: 'Ombrage plat' }),  onClick: () => updateSelected({ shadeFlat: true }),  disabled: !selectedIds.length },
            'sep',
            { label: t('apex_delete_element'), onClick: () => deleteObjects(), disabled: !selectedIds.length, shortcut: 'Suppr' },
          ],
        }, {
          label: t('vertex_menu_sculpt', { defaultValue: 'Sculpture' }),
          items: [
            { label: `${dyntopo.enabled ? '✓ ' : ''}${t('vertex_dyntopo', { defaultValue: 'Topologie dynamique (dyntopo)' })}`, shortcut: 'D',
              onClick: () => setDyntopo(v => ({ ...v, enabled: !v.enabled })) },
            { label: t('vertex_dyntopo_flood', { defaultValue: 'Détail uniforme (tout le maillage)' }),
              onClick: () => floodDetail(), disabled: !selectedIds.length },
            'sep',
            { label: `${symAxes.x ? '✓ ' : ''}${t('vertex_symmetry')} X`, shortcut: 'M', onClick: () => setSymAxes(v => ({ ...v, x: !v.x })) },
            { label: `${symAxes.y ? '✓ ' : ''}${t('vertex_symmetry')} Y`, onClick: () => setSymAxes(v => ({ ...v, y: !v.y })) },
            { label: `${symAxes.z ? '✓ ' : ''}${t('vertex_symmetry')} Z`, onClick: () => setSymAxes(v => ({ ...v, z: !v.z })) },
            'sep',
            { label: t('vertex_brush_new', { defaultValue: 'Nouveau pinceau à partir de l’actif' }),
              onClick: () => void createBrush(activeBrushId) },
            { label: t('vertex_brush_reset', { defaultValue: 'Réinitialiser les réglages' }),
              onClick: () => resetBrush(activeBrushId) },
          ],
        }, {
          label: t('vertex_menu_mesh', { defaultValue: 'Maillage' }),
          items: [
            { label: t('vertex_subdivide', { defaultValue: 'Subdiviser' }),        onClick: () => remeshSelected('subdivide'), disabled: !selectedIds.length },
            { label: t('vertex_decimate',  { defaultValue: 'Décimer' }),           onClick: () => remeshSelected('decimate'),  disabled: !selectedIds.length },
            { label: t('vertex_weld',      { defaultValue: 'Souder les sommets' }), onClick: () => remeshSelected('weld'),     disabled: !selectedIds.length },
            { label: t('vertex_flip_normals', { defaultValue: 'Inverser les normales' }), onClick: () => remeshSelected('flip'), disabled: !selectedIds.length },
            'sep',
            { label: t('vertex_import', { defaultValue: 'Importer un maillage…' }), onClick: () => fileInputRef.current?.click() },
            'sep',
            { label: t('vertex_export_obj',  { defaultValue: 'Exporter en OBJ' }),  onClick: () => exportMesh('obj') },
            { label: t('vertex_export_stl',  { defaultValue: 'Exporter en STL' }),  onClick: () => exportMesh('stl') },
            { label: t('vertex_export_gltf', { defaultValue: 'Exporter en glTF' }), onClick: () => exportMesh('gltf') },
          ],
        }],
        viewExtra: [
          { label: t('vertex_view_front', { defaultValue: 'Vue de face' }),   shortcut: 'Pav. 1', onClick: () => setViewSignal(s => ({ seq: (s?.seq ?? 0) + 1, kind: 'front' })) },
          { label: t('vertex_view_right', { defaultValue: 'Vue de droite' }), shortcut: 'Pav. 3', onClick: () => setViewSignal(s => ({ seq: (s?.seq ?? 0) + 1, kind: 'right' })) },
          { label: t('vertex_view_top',   { defaultValue: 'Vue de dessus' }), shortcut: 'Pav. 7', onClick: () => setViewSignal(s => ({ seq: (s?.seq ?? 0) + 1, kind: 'top' })) },
          { label: t('vertex_view_iso',   { defaultValue: 'Vue isométrique' }), shortcut: 'Pav. 5', onClick: () => setViewSignal(s => ({ seq: (s?.seq ?? 0) + 1, kind: 'iso' })) },
          { label: t('vertex_focus', { defaultValue: 'Cadrer la sélection' }), shortcut: 'F', onClick: () => setFocusSignal(s => s + 1), disabled: !selectedObj },
          'sep',
          { label: `${showGrid ? '✓ ' : ''}${t('vertex_toggle_grid', { defaultValue: 'Grille' })}`,          onClick: () => setShowGrid(v => !v) },
          { label: `${showShadows ? '✓ ' : ''}${t('vertex_toggle_shadows', { defaultValue: 'Ombres' })}`,     onClick: () => setShowShadows(v => !v) },
          { label: `${wireframe ? '✓ ' : ''}${t('vertex_wireframe')}`, shortcut: 'Z',                        onClick: () => setWireframe(v => !v) },
          { label: `${showStats ? '✓ ' : ''}${t('vertex_toggle_stats', { defaultValue: 'Statistiques' })}`,   onClick: () => setShowStats(v => !v) },
        ],
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
        <AddObjectButton onAdd={addObject} onImport={() => fileInputRef.current?.click()} />
        <div className="w-px h-5 mx-1" style={{ background: C.border }} />
        {/* Gizmo snapping + transform space (Object Mode) */}
        <button onClick={() => setSnapping(v => !v)} title={t('vertex_snapping', { defaultValue: 'Aimanter (grille / 15° / 0,1)' })}
                className="w-7 h-7 flex items-center justify-center rounded"
                style={{ background: snapping ? C.accent + '33' : 'transparent', color: snapping ? C.accent : C.textDim, border: `1px solid ${snapping ? C.accent : C.border}` }}>
          <Magnet size={13} />
        </button>
        <button onClick={() => setTransformSpace(s => s === 'world' ? 'local' : 'world')}
                title={t('vertex_transform_space', { defaultValue: 'Espace de transformation' })}
                className="flex items-center gap-1 px-2 h-7 rounded text-[11px]"
                style={{ color: C.textDim, border: `1px solid ${C.border}` }}>
          {transformSpace === 'world' ? <Globe size={12} /> : <Box size={12} />}
          {transformSpace === 'world' ? t('vertex_space_world', { defaultValue: 'Monde' }) : t('vertex_space_local', { defaultValue: 'Local' })}
        </button>
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
        {/* Sculpt quick controls: active brush sliders + dyntopo + symmetry axes */}
        {mode === 'sculpt' && (
          <div className="flex items-center gap-2 mr-1">
            <label className="flex items-center gap-1 text-[11px]" style={{ color: C.textDim }}>
              {t('vertex_radius')}
              <RangeSlider min={0.05} max={3} step={0.01} value={activeBrush.settings.radius}
                     onChange={v => patchBrush(activeBrushId, { radius: v })} style={{ width: 70 }} accent={C.accent} trackColor="rgba(255,255,255,0.15)" aria-label={t('vertex_radius')} />
            </label>
            <label className="flex items-center gap-1 text-[11px]" style={{ color: C.textDim }}>
              {t('vertex_strength')}
              <RangeSlider min={0.02} max={1} step={0.01} value={activeBrush.settings.strength}
                     onChange={v => patchBrush(activeBrushId, { strength: v })} style={{ width: 70 }} accent={C.accent} trackColor="rgba(255,255,255,0.15)" aria-label={t('vertex_strength')} />
            </label>
            <button onClick={() => setDyntopo(v => ({ ...v, enabled: !v.enabled }))} title={`Dyntopo (D)`}
                    className="flex items-center gap-1 px-2 h-6 rounded text-[11px]"
                    style={{ background: dyntopo.enabled ? C.accent + '33' : 'transparent', color: dyntopo.enabled ? C.accent : C.textDim, border: `1px solid ${dyntopo.enabled ? C.accent : C.border}` }}>
              <Network size={12} /> Dyntopo
            </button>
            <div className="flex items-center gap-0.5">
              {(['x', 'y', 'z'] as const).map(ax => (
                <button key={ax} onClick={() => setSymAxes(v => ({ ...v, [ax]: !v[ax] }))}
                        title={`${t('vertex_symmetry')} ${ax.toUpperCase()}${ax === 'x' ? ' (M)' : ''}`}
                        className="w-6 h-6 rounded text-[10px] font-medium uppercase"
                        style={{ background: symAxes[ax] ? C.accent + '33' : 'transparent', color: symAxes[ax] ? C.accent : C.textDim, border: `1px solid ${symAxes[ax] ? C.accent : C.border}` }}>
                  {ax}
                </button>
              ))}
            </div>
            <div className="w-px h-5" style={{ background: C.border }} />
          </div>
        )}
        {/* Paint-mode brush settings */}
        {PAINT_MODES.includes(mode) && mode !== 'sculpt' && mode !== 'edit' && (
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
        <button onClick={() => setWireframe(v => !v)} title={`${t('vertex_wireframe')} (Z)`}
                className="flex items-center gap-1 px-2 h-6 rounded text-[11px]"
                style={{ background: wireframe ? C.accent + '33' : 'transparent', color: wireframe ? C.accent : C.textDim, border: `1px solid ${wireframe ? C.accent : C.border}` }}>
          <Grid3x3 size={12} /> {t('vertex_wireframe')}
        </button>
      </>}
      toolRail={<ToolbarLeft mode={mode} transformMode={transformMode} onMode={setMode} onTransform={setTransformMode} />}>
      <DockArea theme={C} storageKey="kubuno:paintsharp:vertexDockLayout" viewportBg={C.bg}
        defaultArrangement={{ right: [['outliner'],['properties'],['brush']] }}
        controllerRef={dockCtrl}
        panels={vertexPanels}>
        <div className="w-full h-full" onContextMenu={onViewportBackgroundMenu}>
          <Canvas
            shadows
            camera={{ position: [4, 4, 6], fov: 50 }}
            onCreated={({ gl }) => { gl.setClearColor(new THREE.Color(C.bg)) }}
            onPointerMissed={(e) => { if (!(e as MouseEvent).shiftKey) selectObject(null) }}
          >
            <Viewport
              objects={objects}
              selectedIds={selectedIds}
              activeId={activeId}
              mode={mode}
              transformMode={transformMode}
              brush={activeBrush}
              brushRadius={brushRadius}
              brushStrength={brushStrength}
              paintColor={paintColor}
              paintWeight={paintWeight}
              cursorRef={cursorRef}
              focusSignal={focusSignal}
              viewSignal={viewSignal}
              snapping={snapping}
              transformSpace={transformSpace}
              dyntopo={dyntopo}
              showGrid={showGrid}
              showShadows={showShadows}
              onSelect={selectObject}
              onBeginEdit={record}
              onCommit={commitTransform}
              onMeshCommit={commitMesh}
              onCursorMove={handleCursorMove}
              onCursorClear={handleCursorClear}
              onObjectContextMenu={onViewportObjectMenu}
              onSculptContextMenu={onSculptContextMenu}
              symAxes={symAxes}
              wireframe={wireframe}
              editElem={editElem}
              editAction={editAction}
            />
          </Canvas>

          {/* HUD info */}
          <div className="absolute top-2 left-2 text-[11px] px-2 py-1 rounded pointer-events-none"
               style={{ background: 'rgba(0,0,0,0.55)', color: C.textDim }}>
            {mode === 'sculpt'
              ? selectedObj
                ? [
                    brushDisplayName(t, brushes.find(b => b.id === activeBrushId) ?? BUILTIN_BRUSHES[0]),
                    `R ${activeBrush.settings.radius.toFixed(2)}`,
                    `F ${Math.round(activeBrush.settings.strength * 100)}%`,
                    dyntopo.enabled ? `Dyntopo ${dyntopo.detail.toFixed(3)}` : null,
                    (symAxes.x || symAxes.y || symAxes.z)
                      ? `Sym ${['x', 'y', 'z'].filter(a => symAxes[a as keyof SymAxes]).join('').toUpperCase()}`
                      : null,
                    selectedObj.name,
                  ].filter(Boolean).join(' · ')
                : t('vertex_hud_sculpt_hint')
              : mode === 'object'
                ? t('vertex_hud_select', { mode: transformMode, name: selectedObj ? ` · ${selectedObj.name}` : '' })
                  + (selectedIds.length > 1 ? ` (+${selectedIds.length - 1})` : '')
                : `${t(MODE_LIST.find(m => m.id === mode)?.labelKey ?? '')}${selectedObj ? ' · ' + selectedObj.name : ` — ${t('vertex_select_object')}`}`}
          </div>

          {showStats && (
            <div className="absolute bottom-2 left-2 text-[11px] px-2 py-1 rounded pointer-events-none font-mono"
                 style={{ background: 'rgba(0,0,0,0.55)', color: C.textDim }}>
              {t('vertex_hud_visible_count', { count: objects.filter(o => o.visible).length })}
              {' · '}{t('vertex_stat_verts', { defaultValue: 'Sommets' })} {sceneStats.v.toLocaleString()}
              {' · '}{t('vertex_stat_tris',  { defaultValue: 'Triangles' })} {sceneStats.f.toLocaleString()}
              {selStats && (
                <span style={{ color: C.accent }}>
                  {'  —  '}{t('vertex_hud_selection', { defaultValue: 'Sélection' })} : {selectedIds.length} obj · {selStats.v.toLocaleString()} v · {selStats.f.toLocaleString()} t
                </span>
              )}
            </div>
          )}
        </div>
      </DockArea>

      {/* Hidden file picker for mesh import */}
      <input ref={fileInputRef} type="file" accept=".obj,.stl,.glb,.gltf" hidden
             onChange={e => { const f = e.target.files?.[0]; if (f) handleImportFile(f); e.target.value = '' }} />

      {ctx.menu}
    </EditorShell>
  )
}
