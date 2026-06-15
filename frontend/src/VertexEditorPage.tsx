import { useEffect, useRef, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams, useNavigate } from 'react-router-dom'
import { useDebouncedAutosave } from './useAutosave'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Canvas, ThreeEvent } from '@react-three/fiber'
import { OrbitControls, Grid, GizmoHelper, GizmoViewport, TransformControls } from '@react-three/drei'
import * as THREE from 'three'
import {
  Box, Circle, RotateCw, Move, Maximize2,
  Layers, Settings2, ChevronRight, ChevronDown, Eye, EyeOff, Trash2, Sun,
  Brush, Minus, Plus, Pen, Hand, Wind, Minimize2, Scissors,
  FlipHorizontal, Grid3x3,
  MousePointer2, Waypoints, Palette, Weight, Image as ImageIcon, Star,
} from 'lucide-react'
import { paintsharpApi } from './api'
import { C as SHELL_C, EditorShell, DockArea, ColorField, paintsharpMenus, useContextMenu, type CtxItem } from './ui'

// ── Palette (shared Paintsharp theme, mapped to Vertex's legacy key names) ───────────
const C = { ...SHELL_C, bgPanel: SHELL_C.panel, bgToolbar: SHELL_C.toolbar, selected: SHELL_C.accent + '33' }

// ── Types ─────────────────────────────────────────────────────────────────────
type TransformMode = 'translate' | 'rotate' | 'scale'
// Modes façon Blender.
type Mode = 'object' | 'edit' | 'sculpt' | 'vertex_paint' | 'weight_paint' | 'texture_paint'
type SculptBrush  = 'clay' | 'draw' | 'move' | 'smooth' | 'flatten' | 'inflate' | 'pinch' | 'crease'
type PrimType     = 'box' | 'sphere' | 'cylinder' | 'torus'

// Modes qui peignent/déforment au glissé (LMB) → orbite désactivée, curseur pinceau.
const PAINT_MODES: Mode[] = ['sculpt', 'vertex_paint', 'weight_paint', 'texture_paint', 'edit']

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
}

// ── Géométrie haute résolution pour la sculpture ──────────────────────────────
function createGeometry(primType: PrimType): THREE.BufferGeometry {
  switch (primType) {
    case 'sphere':   return new THREE.SphereGeometry(0.8, 48, 48)
    case 'cylinder': return new THREE.CylinderGeometry(0.5, 0.5, 1.5, 32, 12)
    case 'torus':    return new THREE.TorusGeometry(0.7, 0.25, 32, 64)
    default:         return new THREE.BoxGeometry(1, 1, 1, 10, 10, 10)
  }
}

// ── Application d'un pinceau sur les vertices ─────────────────────────────────
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
        // Pousse le long de la normale uniquement côté visible
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

// ── Pinceau Lisser (moyenne des voisins) ──────────────────────────────────────
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

// ── Pinceau Déplacer (glisser les vertices) ───────────────────────────────────
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

// ── Couleurs de sommets : init / pinceau ──────────────────────────────────────
// Garantit un attribut `color` (blanc par défaut → n'altère pas le matériau).
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

// Peinture de couleurs de sommets dans le rayon du pinceau (mélange additif).
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

// Peinture de poids (scalaire 0..1) dans un tableau parallèle.
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

// Rampe de poids façon Blender : bleu(0) → cyan → vert → jaune → rouge(1).
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

// ── Cursor 3D (anneau sur la surface) ────────────────────────────────────────
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

// ── Mesh sélectionnable + sculptable/peignable ───────────────────────────────
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
  onTransformStart:   () => void
  onTransformEnd:     () => void
  onCommit:           (patch: Partial<SceneObject>) => void
  onCursorMove:       (pos: THREE.Vector3, normal: THREE.Vector3) => void
  onCursorClear:      () => void
  symmetry:           boolean
  wireframe:          boolean
}

const TEX_SIZE = 1024

function SelectableMesh({
  obj, selected, mode, transformMode,
  sculptBrush, brushRadius, brushStrength, paintColor, paintWeight,
  onSelect, onTransformStart, onTransformEnd, onCommit,
  onCursorMove, onCursorClear, symmetry, wireframe,
}: SelectableMeshProps) {
  const [meshNode, setMeshNode] = useState<THREE.Mesh | null>(null)
  const transformRef = useRef<any>(null)
  const geoRef       = useRef<THREE.BufferGeometry>(createGeometry(obj.primType))
  const isPainting   = useRef(false)
  const invertRef    = useRef(false)
  const lastHit      = useRef<THREE.Vector3 | null>(null)
  // Données de peinture persistantes par maillage.
  const vColorsRef   = useRef<Float32Array | null>(null)   // couleurs de sommets (vertex paint)
  const weightsRef   = useRef<Float32Array | null>(null)   // poids 0..1 (weight paint)
  const [texture, setTexture] = useState<THREE.CanvasTexture | null>(null)
  const texCtxRef    = useRef<CanvasRenderingContext2D | null>(null)

  const isPaintMode  = selected && PAINT_MODES.includes(mode)

  useEffect(() => () => { geoRef.current.dispose() }, [])

  // (Ré)initialise les buffers de peinture quand la géométrie change.
  useEffect(() => {
    const n = geoRef.current.attributes.position.count
    ensureColorAttr(geoRef.current)
    if (!vColorsRef.current || vColorsRef.current.length !== n * 3) vColorsRef.current = new Float32Array(n * 3).fill(1)
    if (!weightsRef.current || weightsRef.current.length !== n)     weightsRef.current = new Float32Array(n)
  }, [obj.primType])

  // Synchronise le buffer de couleurs affiché selon le mode :
  //  - weight_paint → rampe de poids ; sinon → couleurs de vertex paint.
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

  // Crée paresseusement la texture peignable à la 1re entrée en Texture Paint.
  useEffect(() => {
    if (mode !== 'texture_paint' || texture) return
    const cv = document.createElement('canvas')
    cv.width = cv.height = TEX_SIZE
    const cx = cv.getContext('2d')!
    cx.fillStyle = obj.color ?? '#9aa7c4'
    cx.fillRect(0, 0, TEX_SIZE, TEX_SIZE)
    texCtxRef.current = cx
    const tex = new THREE.CanvasTexture(cv)
    tex.colorSpace = THREE.SRGBColorSpace
    setTexture(tex)
  }, [mode, texture, obj.color])

  // Désactive OrbitControls pendant le gizmo et commite la transformation.
  useEffect(() => {
    const ctrl = transformRef.current
    if (!ctrl || !selected) return
    const handler = (e: { value: boolean }) => {
      if (e.value) { onTransformStart(); return }
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
  }, [selected, onTransformStart, onTransformEnd, onCommit, meshNode])

  const handleClick = useCallback((e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation()
    onSelect()
  }, [onSelect])

  // Applique une « touche » de pinceau au point survolé, selon le mode courant.
  const stroke = useCallback((e: ThreeEvent<PointerEvent>, wn: THREE.Vector3) => {
    if (!meshNode) return
    const M = meshNode.matrixWorld
    const cx = obj.position[0]
    const mirror = (p: THREE.Vector3) => new THREE.Vector3(2 * cx - p.x, p.y, p.z)
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
    } else if (mode === 'edit' && lastHit.current) {
      // « Tweak » de sommets : déplace les sommets sous le curseur (petit rayon).
      const delta = e.point.clone().sub(lastHit.current)
      const r = Math.min(brushRadius, 0.18)
      applyMoveBrush(geoRef.current, M, e.point, delta, r, 1)
      if (symmetry) applyMoveBrush(geoRef.current, M, mirror(e.point), new THREE.Vector3(-delta.x, delta.y, delta.z), r, 1)
      lastHit.current = e.point.clone()
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

  const handlePointerDown = useCallback((e: ThreeEvent<PointerEvent>) => {
    if (!isPaintMode || !meshNode || !e.face) return
    e.stopPropagation()
    isPainting.current = true
    invertRef.current  = e.buttons === 2
    lastHit.current    = e.point.clone()
    const wn = e.face.normal.clone().transformDirection(meshNode.matrixWorld).normalize()
    if (mode === 'sculpt' && sculptBrush === 'move') return  // le déplacement attend le 1er move
    stroke(e, wn)
  }, [isPaintMode, meshNode, mode, sculptBrush, stroke])

  const handlePointerMove = useCallback((e: ThreeEvent<PointerEvent>) => {
    if (!meshNode) return
    const wn = e.face
      ? e.face.normal.clone().transformDirection(meshNode.matrixWorld).normalize()
      : new THREE.Vector3(0, 1, 0)
    if (isPaintMode) onCursorMove(e.point, wn)
    if (!isPainting.current || !isPaintMode) return
    e.stopPropagation()
    stroke(e, wn)
  }, [isPaintMode, meshNode, onCursorMove, stroke])

  const stopPainting = useCallback(() => { isPainting.current = false; lastHit.current = null }, [])

  const showVertexColors = mode === 'vertex_paint' || mode === 'weight_paint'

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
          color={showVertexColors ? '#ffffff' : (obj.color ?? (selected ? '#9dafc8' : '#7c8db5'))}
          map={mode === 'texture_paint' ? texture : null}
          vertexColors={showVertexColors}
          roughness={obj.roughness ?? 0.45}
          metalness={obj.metalness ?? 0.15}
          wireframe={wireframe || mode === 'edit'}
          emissive={selected && mode === 'object' ? C.accent : '#000000'}
          emissiveIntensity={selected && mode === 'object' ? 0.18 : 0}
        />
      </mesh>

      {/* Edit Mode : sommets visibles (points) façon Blender. */}
      {selected && mode === 'edit' && (
        <points geometry={geoRef.current} position={obj.position} rotation={obj.rotation ?? [0,0,0]} scale={obj.scale ?? [1,1,1]}>
          <pointsMaterial size={0.06} color={C.accent} sizeAttenuation depthTest={false} />
        </points>
      )}

      {/* Gizmo de transformation (Object Mode uniquement). */}
      {selected && mode === 'object' && meshNode && (
        <TransformControls ref={transformRef} object={meshNode} mode={transformMode} size={0.8} />
      )}
    </>
  )
}

// ── Viewport 3D ───────────────────────────────────────────────────────────────
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
  onSelect:      (id: string | null) => void
  onCommit:      (id: string, patch: Partial<SceneObject>) => void
  onCursorMove:  (pos: THREE.Vector3, normal: THREE.Vector3) => void
  onCursorClear: () => void
  symmetry:      boolean
  wireframe:     boolean
}

function Viewport({
  objects, selectedId, mode, transformMode,
  sculptBrush, brushRadius, brushStrength, paintColor, paintWeight,
  cursorPos, cursorNormal,
  onSelect, onCommit, onCursorMove, onCursorClear, symmetry, wireframe,
}: ViewportProps) {
  const [orbitEnabled, setOrbitEnabled] = useState(true)

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
          key={obj.id}
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
          onCommit={(patch) => onCommit(obj.id, patch)}
          onTransformStart={() => setOrbitEnabled(false)}
          onTransformEnd={() => setOrbitEnabled(true)}
          onCursorMove={onCursorMove}
          onCursorClear={onCursorClear}
          symmetry={symmetry}
          wireframe={wireframe}
        />
      ))}

      <BrushCursor
        point={cursorPos}
        normal={cursorNormal}
        radius={mode === 'edit' ? Math.min(brushRadius, 0.18) : brushRadius}
        visible={PAINT_MODES.includes(mode) && !!selectedId}
      />

      {/* Orbite à la souris uniquement en Object Mode (les autres modes peignent
          au glissé) ; le zoom molette reste toujours disponible. */}
      <OrbitControls makeDefault enableRotate={orbitEnabled && mode === 'object'} enablePan={mode === 'object'} />

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

// ── Propriétés ────────────────────────────────────────────────────────────────
function PropertiesPanel({ selected, onPatch }: { selected: SceneObject | null; onPatch: (p: Partial<SceneObject>) => void }) {
  const { t } = useTranslation('paintsharp')
  const [open, setOpen] = useState<Record<string, boolean>>({
    object: true, transform: true, material: true,
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
            </Section>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Panneau de pinceaux ───────────────────────────────────────────────────────
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

      {/* Pinceau actif */}
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

        {/* Rayon */}
        <div className="mb-2">
          <div className="flex justify-between mb-0.5">
            <span className="text-[11px]" style={{ color: C.textDim }}>{t('vertex_radius')}</span>
            <span className="text-[11px] font-mono" style={{ color: C.accent }}>{brushRadius.toFixed(2)}</span>
          </div>
          <input type="range" min={0.08} max={2} step={0.01} value={brushRadius}
                 onChange={e => onRadius(parseFloat(e.target.value))}
                 className="w-full h-1.5 rounded appearance-none cursor-pointer"
                 style={{ accentColor: C.accent }} />
        </div>

        {/* Force */}
        <div>
          <div className="flex justify-between mb-0.5">
            <span className="text-[11px]" style={{ color: C.textDim }}>{t('vertex_strength')}</span>
            <span className="text-[11px] font-mono" style={{ color: C.accent }}>{Math.round(brushStrength * 100)}%</span>
          </div>
          <input type="range" min={0.02} max={1} step={0.01} value={brushStrength}
                 onChange={e => onStrength(parseFloat(e.target.value))}
                 className="w-full h-1.5 rounded appearance-none cursor-pointer"
                 style={{ accentColor: C.accent }} />
        </div>
      </div>

      {/* Grille de pinceaux */}
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

      {/* Légende */}
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

// ── Toolbar gauche ────────────────────────────────────────────────────────────
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
      {/* Transformations (Object Mode) */}
      <span className="text-[9px] uppercase tracking-widest mb-0.5" style={{ color: C.textDim }}>{t('vertex_group_object')}</span>
      <Btn active={mode === 'object' && transformMode === 'translate'}
           onClick={() => { onMode('object'); onTransform('translate') }}
           title={t('vertex_tool_move')}>
        <Move size={14} />
      </Btn>
      <Btn active={mode === 'object' && transformMode === 'rotate'}
           onClick={() => { onMode('object'); onTransform('rotate') }}
           title={t('vertex_tool_rotate')}>
        <RotateCw size={14} />
      </Btn>
      <Btn active={mode === 'object' && transformMode === 'scale'}
           onClick={() => { onMode('object'); onTransform('scale') }}
           title={t('vertex_tool_scale')}>
        <Maximize2 size={14} />
      </Btn>

      <Sep />

      {/* Raccourcis de modes (le sélecteur complet est dans la barre d'options) */}
      <Btn active={mode === 'edit'}         onClick={() => onMode('edit')}         title={t('vertex_mode_edit')}><Waypoints size={15} /></Btn>
      <Btn active={mode === 'sculpt'}       onClick={() => onMode('sculpt')}       title={t('vertex_mode_sculpt_m')}><Brush size={15} /></Btn>
      <Btn active={mode === 'vertex_paint'} onClick={() => onMode('vertex_paint')} title={t('vertex_mode_vpaint')}><Palette size={15} /></Btn>
      <Btn active={mode === 'weight_paint'} onClick={() => onMode('weight_paint')} title={t('vertex_mode_wpaint')}><Weight size={15} /></Btn>
      <Btn active={mode === 'texture_paint'}onClick={() => onMode('texture_paint')}title={t('vertex_mode_tpaint')}><ImageIcon size={15} /></Btn>

      <Sep />

      {/* Éclairage rapide */}
      <Btn active={false} onClick={() => {}} title={t('vertex_tool_light')}>
        <Sun size={13} style={{ color: C.textDim }} />
      </Btn>
    </>
  )
}

// ── Sélecteur de mode façon Blender ───────────────────────────────────────────
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

// ── Barre d'ajout de primitives ───────────────────────────────────────────────
function AddPrimitivesToolbar({ onAdd }: { onAdd: (type: PrimType) => void }) {
  const { t } = useTranslation('paintsharp')
  type LIcon = React.ComponentType<{ size?: number; style?: React.CSSProperties }>
  const items: [PrimType, string, LIcon][] = [
    ['box',      t('vertex_prim_box'),      Box      as LIcon],
    ['sphere',   t('vertex_prim_sphere'),   Circle   as LIcon],
    ['cylinder', t('vertex_prim_cylinder'), RotateCw as LIcon],
    ['torus',    t('vertex_prim_torus'),    Maximize2 as LIcon],
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

// ── Page principale Vertex ────────────────────────────────────────────────────
export default function VertexEditorPage() {
  const { t } = useTranslation('paintsharp')
  const { id }   = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [mode,          setMode]          = useState<Mode>('object')
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
  const [objects,       setObjects]       = useState<SceneObject[]>([
    { id: 'default-0', name: t('vertex_prim_sphere'), primType: 'sphere', visible: true, position: [0, 0.8, 0] },
  ])

  const { data: scene, isLoading } = useQuery({
    queryKey: ['paintsharp-scene', id],
    queryFn:  () => id ? paintsharpApi.getScene(id).then(r => r.data) : null,
    enabled:  !!id,
  })

  const qc = useQueryClient()

  // ── Titre éditable (standard WorkspaceShell) — synchronisé depuis la scène ─────
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

  const saveMut = useMutation({
    mutationFn: async (sceneJson: object) => {
      if (!id) return
      await paintsharpApi.updateScene(id, {
        scene_json:   sceneJson,
        vertex_count: objects.length * 100,
        face_count:   objects.length * 50,
      })
    },
  })

  const selectedObj = objects.find(o => o.id === selectedId) ?? null
  const ctx = useContextMenu()

  const addObject = useCallback((primType: PrimType) => {
    const labels: Record<PrimType, string> = {
      box:      t('vertex_prim_box'),
      sphere:   t('vertex_prim_sphere'),
      cylinder: t('vertex_prim_cylinder'),
      torus:    t('vertex_prim_torus'),
    }
    const newObj: SceneObject = {
      id:       `obj-${Date.now()}`,
      name:     labels[primType],
      primType,
      visible:  true,
      position: [(Math.random() - 0.5) * 4, 0.8, (Math.random() - 0.5) * 4],
    }
    setObjects(prev => [...prev, newObj])
    setSelectedId(newObj.id)
  }, [t])

  const toggleVisibility = useCallback((id: string) => {
    setObjects(prev => prev.map(o => o.id === id ? { ...o, visible: !o.visible } : o))
  }, [])

  const deleteObject = useCallback((id: string) => {
    setObjects(prev => prev.filter(o => o.id !== id))
    setSelectedId(prev => prev === id ? null : prev)
  }, [])

  const duplicateObject = useCallback((id: string) => {
    setObjects(prev => {
      const src = prev.find(o => o.id === id)
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
  }, [])

  const updateObject = useCallback((id: string | null, patch: Partial<SceneObject>) => {
    if (!id) return
    setObjects(prev => prev.map(o => o.id === id ? { ...o, ...patch } : o))
  }, [])

  const handleCursorMove = useCallback((pos: THREE.Vector3, normal: THREE.Vector3) => {
    setCursorPos(pos.clone())
    setCursorNormal(normal.clone())
  }, [])

  const handleCursorClear = useCallback(() => {
    setCursorPos(null)
    setCursorNormal(null)
  }, [])

  // Sauvegarde automatique (debounce + flush au démontage/fermeture).
  useDebouncedAutosave(objects, !!id, (d) => saveMut.mutate({ objects: d }))

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
      <PropertiesPanel selected={selectedObj} onPatch={p => updateObject(selectedId, p)} />
    ) },
    brush: { label: t('vertex_brushes_title'), render: () => (
      <BrushPanel sculptBrush={sculptBrush} brushRadius={brushRadius} brushStrength={brushStrength}
        onBrush={setSculptBrush} onRadius={setBrushRadius} onStrength={setBrushStrength} />
    ) },
  }

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
        <ModeDropdown mode={mode} onMode={setMode} />
        <div className="w-px h-5 mx-1" style={{ background: C.border }} />
        <AddPrimitivesToolbar onAdd={addObject} />
        <div className="flex-1" />
        {/* Réglages de pinceau (modes peinture/sculpture/édition) */}
        {PAINT_MODES.includes(mode) && (
          <div className="flex items-center gap-2 mr-1">
            {(mode === 'vertex_paint' || mode === 'texture_paint') && (
              <ColorField t={t} C={C} color={paintColor} onChange={setPaintColor} width={26} height={20} />
            )}
            {mode === 'weight_paint' && (
              <label className="flex items-center gap-1 text-[11px]" style={{ color: C.textDim }}>
                {t('vertex_paint_weight')}
                <input type="range" min={0} max={1} step={0.01} value={paintWeight}
                       onChange={e => setPaintWeight(parseFloat(e.target.value))} style={{ accentColor: C.accent, width: 70 }} />
              </label>
            )}
            <label className="flex items-center gap-1 text-[11px]" style={{ color: C.textDim }}>
              {t('vertex_radius')}
              <input type="range" min={0.08} max={2} step={0.01} value={brushRadius}
                     onChange={e => setBrushRadius(parseFloat(e.target.value))} style={{ accentColor: C.accent, width: 70 }} />
            </label>
            <label className="flex items-center gap-1 text-[11px]" style={{ color: C.textDim }}>
              {t('vertex_strength')}
              <input type="range" min={0.02} max={1} step={0.01} value={brushStrength}
                     onChange={e => setBrushStrength(parseFloat(e.target.value))} style={{ accentColor: C.accent, width: 70 }} />
            </label>
            <div className="w-px h-5" style={{ background: C.border }} />
          </div>
        )}
        <button onClick={() => setSymmetry(v => !v)} title={t('vertex_symmetry')}
                className="flex items-center gap-1 px-2 h-6 rounded text-[11px]"
                style={{ background: symmetry ? C.accent + '33' : 'transparent', color: symmetry ? C.accent : C.textDim, border: `1px solid ${symmetry ? C.accent : C.border}` }}>
          <FlipHorizontal size={12} /> {t('vertex_symmetry')}
        </button>
        <button onClick={() => setWireframe(v => !v)} title={t('vertex_wireframe')}
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
              onSelect={setSelectedId}
              onCommit={(id, patch) => updateObject(id, patch)}
              onCursorMove={handleCursorMove}
              onCursorClear={handleCursorClear}
              symmetry={symmetry}
              wireframe={wireframe}
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
      {ctx.menu}
    </EditorShell>
  )
}