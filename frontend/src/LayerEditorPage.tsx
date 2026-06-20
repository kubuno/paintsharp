import { useEffect, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useDebouncedAutosave } from './useAutosave'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import {
  MousePointer2, Square, Circle, Hand, Eraser,
  Pipette, Brush, Type, Crop, ChevronRight,
  Eye, EyeOff, Lock, Unlock, Plus, Trash2,
  SlidersHorizontal, Layers, Undo2, Redo2, Download,
  ZoomIn, ZoomOut, Wand2, Check, RotateCcw, Sun, Contrast,
  Droplet, Palette as PaletteIcon, PenTool,
  Pencil, Wind, Highlighter, PenLine, Sparkles, Fingerprint, PanelRight, Lasso, Wand, Move,
  Copy, Search, FolderClosed, FolderOpen, GripVertical, CornerDownRight, Grid2x2, Star,
} from 'lucide-react'
import { Dropdown, RangeSlider } from '@ui'
import { layerApi, type LayerStructureItem } from './api'
import { C, hexToRgb, rgbToHex, rgbToHsl, hslToRgb, ColorPicker, DockArea, Navigator, OptNum, EditorShell, paintsharpMenus, useContextMenu, type CtxItem, type DockController } from './ui'
import { EmbedShell } from './EmbedShell'

// Palette + colour math now live in the shared Paintsharp UI library (ui/theme.ts).

type Tool = 'select' | 'brush' | 'eraser' | 'eyedrop' | 'fill' | 'hand' | 'crop' | 'text' | 'rect-sel' | 'ellipse-sel' | 'lasso' | 'magic' | 'transform' | 'zoom' | 'rotate'

// ── Brush presets (stamp/dab engine) ───────────────────────────────────────────
// Each preset drives the dab distribution & shape. The user-adjustable size /
// opacity sliders stay authoritative; presets only supply sensible defaults &
// the "character" (hardness, spacing, flow, jitter, shape, pressure dynamics).
type BrushPreset = {
  id:             string
  nameKey:        string  // i18n key
  Icon:           React.ComponentType<{ size?: number; style?: React.CSSProperties }>
  hardness:       number  // 0..100 default edge softness
  spacing:        number  // dab interval as a fraction of the dab radius (>0)
  flow:           number  // 0..1 per-dab alpha (accumulation control)
  sizeJitter:     number  // 0..1 random radius variation per dab
  opacityJitter:  number  // 0..1 random alpha variation per dab
  scatter:        number  // 0..1 random positional offset (× radius)
  angle:          number  // dab rotation in degrees (for elliptical dabs)
  roundness:      number  // 0..1 (1 = circle, <1 = ellipse)
  pressureSize:   boolean // pressure modulates radius
  pressureOpacity:boolean // pressure modulates alpha
  defaultSize:    number  // suggested size (px) applied on first selection
}

const BRUSH_PRESETS: BrushPreset[] = [
  { id:'hard',    nameKey:'layer_brush_preset_hard',   Icon:Circle,      hardness:100, spacing:0.10, flow:1.0,  sizeJitter:0,    opacityJitter:0,    scatter:0,    angle:0,  roundness:1,    pressureSize:true,  pressureOpacity:false, defaultSize:22 },
  { id:'soft',    nameKey:'layer_brush_preset_soft',   Icon:Brush,       hardness:0,   spacing:0.06, flow:0.85, sizeJitter:0,    opacityJitter:0,    scatter:0,    angle:0,  roundness:1,    pressureSize:true,  pressureOpacity:true,  defaultSize:40 },
  { id:'pencil',  nameKey:'layer_brush_preset_pencil', Icon:Pencil,      hardness:92,  spacing:0.05, flow:0.9,  sizeJitter:0.05, opacityJitter:0.12, scatter:0.04, angle:0,  roundness:1,    pressureSize:true,  pressureOpacity:true,  defaultSize:6  },
  { id:'airbrush',nameKey:'layer_brush_preset_airbrush',Icon:Wind,       hardness:0,   spacing:0.04, flow:0.10, sizeJitter:0,    opacityJitter:0.10, scatter:0.25, angle:0,  roundness:1,    pressureSize:false, pressureOpacity:true,  defaultSize:60 },
  { id:'marker',  nameKey:'layer_brush_preset_marker', Icon:Highlighter, hardness:75,  spacing:0.03, flow:1.0,  sizeJitter:0,    opacityJitter:0,    scatter:0,    angle:0,  roundness:1,    pressureSize:false, pressureOpacity:false, defaultSize:30 },
  { id:'calligr', nameKey:'layer_brush_preset_calligraphy', Icon:PenLine, hardness:88, spacing:0.05, flow:1.0,  sizeJitter:0,    opacityJitter:0,    scatter:0,    angle:40, roundness:0.28, pressureSize:true,  pressureOpacity:false, defaultSize:34 },
  { id:'charcoal',nameKey:'layer_brush_preset_charcoal',Icon:Sparkles,   hardness:35,  spacing:0.07, flow:0.55, sizeJitter:0.18, opacityJitter:0.35, scatter:0.45, angle:0,  roundness:0.85, pressureSize:true,  pressureOpacity:true,  defaultSize:46 },
]
const DEFAULT_BRUSH = BRUSH_PRESETS[0]

// Colour tags for organising the layers panel (label dot uses the same colour).
const LAYER_COLORS: { value: string; key: string; dot: string }[] = [
  { value: '#ef4444', key: 'layer_color_red',    dot: '🔴' },
  { value: '#f59e0b', key: 'layer_color_orange', dot: '🟠' },
  { value: '#eab308', key: 'layer_color_yellow', dot: '🟡' },
  { value: '#22c55e', key: 'layer_color_green',  dot: '🟢' },
  { value: '#3b82f6', key: 'layer_color_blue',   dot: '🔵' },
  { value: '#a855f7', key: 'layer_color_purple', dot: '🟣' },
]

// Web-safe font families offered by the text tool.
const FONT_FAMILIES = [
  'Arial', 'Helvetica', 'Times New Roman', 'Georgia', 'Courier New',
  'Verdana', 'Trebuchet MS', 'Tahoma', 'Impact', 'Comic Sans MS',
]

const BLEND_INT: Record<string, number> = {
  // 10 is reserved internally for the eraser stroke compositing.
  normal: 0, multiply: 1, screen: 2, overlay: 3,
  darken: 4, lighten: 5, difference: 6, 'color-dodge': 7, 'color-burn': 8, 'soft-light': 9,
  'hard-light': 11, 'linear-dodge': 12, 'linear-burn': 13, 'vivid-light': 14,
  'linear-light': 15, 'pin-light': 16, exclusion: 17, subtract: 18, divide: 19,
  hue: 20, saturation: 21, color: 22, luminosity: 23,
}
// Grouped like Photoshop's blend-mode menu; separators are inserted by the UI.
const BLEND_KEYS = [
  'normal',
  'darken', 'multiply', 'color-burn', 'linear-burn',
  'lighten', 'screen', 'color-dodge', 'linear-dodge',
  'overlay', 'soft-light', 'hard-light', 'vivid-light', 'linear-light', 'pin-light',
  'difference', 'exclusion', 'subtract', 'divide',
  'hue', 'saturation', 'color', 'luminosity',
] as const
const blendLabel = (t: TFunction, k: string): string => ({
  normal: t('layer_blend_normal'), multiply: t('layer_blend_multiply'),
  screen: t('layer_blend_screen'), overlay: t('layer_blend_overlay'),
  darken: t('layer_blend_darken'), lighten: t('layer_blend_lighten'),
  difference: t('layer_blend_difference'), 'color-dodge': t('layer_blend_color_dodge'),
  'color-burn': t('layer_blend_color_burn'), 'soft-light': t('layer_blend_soft_light'),
  'hard-light': t('layer_blend_hard_light'), 'linear-dodge': t('layer_blend_linear_dodge'),
  'linear-burn': t('layer_blend_linear_burn'), 'vivid-light': t('layer_blend_vivid_light'),
  'linear-light': t('layer_blend_linear_light'), 'pin-light': t('layer_blend_pin_light'),
  exclusion: t('layer_blend_exclusion'), subtract: t('layer_blend_subtract'),
  divide: t('layer_blend_divide'), hue: t('layer_blend_hue'),
  saturation: t('layer_blend_saturation'), color: t('layer_blend_color'),
  luminosity: t('layer_blend_luminosity'),
}[k] ?? k)

function newId() { return crypto.randomUUID() }

// ── Layer-tree helpers (immutable; the layer list is a tree via `children`) ────
function findInTree(nodes: LayerStructureItem[], id: string | null): LayerStructureItem | null {
  if (!id) return null
  for (const n of nodes) {
    if (n.id === id) return n
    if (n.children) { const f = findInTree(n.children, id); if (f) return f }
  }
  return null
}
function mapTree(nodes: LayerStructureItem[], id: string, patch: Partial<LayerStructureItem>): LayerStructureItem[] {
  return nodes.map(n => {
    if (n.id === id) return { ...n, ...patch }
    if (n.children) return { ...n, children: mapTree(n.children, id, patch) }
    return n
  })
}
function removeFromTree(nodes: LayerStructureItem[], id: string): { tree: LayerStructureItem[]; removed: LayerStructureItem | null } {
  let removed: LayerStructureItem | null = null
  const walk = (list: LayerStructureItem[]): LayerStructureItem[] => {
    const out: LayerStructureItem[] = []
    for (const n of list) {
      if (n.id === id) { removed = n; continue }
      out.push(n.children ? { ...n, children: walk(n.children) } : n)
    }
    return out
  }
  return { tree: walk(nodes), removed }
}
// Raster leaves (depth-first) — used for texture management & flat queries.
function leaves(nodes: LayerStructureItem[]): LayerStructureItem[] {
  const out: LayerStructureItem[] = []
  const walk = (list: LayerStructureItem[]) => list.forEach(n => n.children ? walk(n.children) : out.push(n))
  walk(nodes)
  return out
}
// Every node in the subtree (groups + leaves).
function allNodes(nodes: LayerStructureItem[]): LayerStructureItem[] {
  const out: LayerStructureItem[] = []
  const walk = (list: LayerStructureItem[]) => list.forEach(n => { out.push(n); if (n.children) walk(n.children) })
  walk(nodes)
  return out
}
// Insert `node` above (or below) `targetId` in the same parent list; if the
// target is a group and `intoGroup`, insert as its first child instead.
function insertNode(nodes: LayerStructureItem[], node: LayerStructureItem, targetId: string | null, after = false, intoGroup = false): LayerStructureItem[] {
  if (!targetId) return [node, ...nodes]
  let done = false
  const walk = (list: LayerStructureItem[]): LayerStructureItem[] => {
    const out: LayerStructureItem[] = []
    for (const n of list) {
      if (n.id === targetId) {
        if (intoGroup && n.children) { out.push({ ...n, children: [node, ...n.children] }); done = true; continue }
        if (after) { out.push(n); out.push(node) } else { out.push(node); out.push(n) }
        done = true
      } else out.push(n.children ? { ...n, children: walk(n.children) } : n)
    }
    return out
  }
  const r = walk(nodes)
  return done ? r : [node, ...nodes]
}
// Is `id` a descendant of `ancestorId`? (block dropping a group into itself)
function isDescendant(nodes: LayerStructureItem[], ancestorId: string, id: string): boolean {
  const a = findInTree(nodes, ancestorId)
  return !!(a?.children && findInTree(a.children, id))
}

// Display-name translation for default layer names (stored value stays canonical for logic/persistence)
function displayLayerName(t: TFunction, name: string): string {
  if (name === 'Fond') return t('layer_default_background')
  const m = name.match(/^Calque (\d+)$/)
  if (m) return t('layer_default_layer', { n: m[1] })
  return name
}
// Colour math moved to ui/theme.ts (imported above).

// ── Adjustment definitions (filters) ──────────────────────────────────────────
type Adjust = {
  brightness: number // -100..100
  contrast:   number // -100..100
  saturation: number // -100..100
  hue:        number // -180..180
  exposure:   number // -100..100
}
const ADJUST_ZERO: Adjust = { brightness:0, contrast:0, saturation:0, hue:0, exposure:0 }
function adjustIsZero(a: Adjust): boolean {
  return a.brightness===0 && a.contrast===0 && a.saturation===0 && a.hue===0 && a.exposure===0
}

// Apply non-destructive adjustments to a fresh copy of src pixels.
function applyAdjustments(src: Uint8Array, a: Adjust, invert: boolean, grayscale: boolean): Uint8Array {
  const out = new Uint8Array(src.length)
  out.set(src)
  if (adjustIsZero(a) && !invert && !grayscale) return out

  const bright   = a.brightness * 2.55           // additive
  const contrast = (a.contrast/100) + 1           // multiplier around 0.5
  const expGain  = Math.pow(2, a.exposure/100)    // exposure stops-ish
  const satF     = (a.saturation/100) + 1
  const hueShift = a.hue
  const needHsl  = a.saturation !== 0 || a.hue !== 0

  for (let i = 0; i < out.length; i += 4) {
    if (out[i+3] === 0) continue // skip fully transparent
    let r = out[i], g = out[i+1], b = out[i+2]

    // exposure (multiplicative)
    if (a.exposure !== 0) { r *= expGain; g *= expGain; b *= expGain }
    // brightness (additive)
    if (a.brightness !== 0) { r += bright; g += bright; b += bright }
    // contrast (around mid-gray 128)
    if (a.contrast !== 0) {
      r = (r-128)*contrast + 128
      g = (g-128)*contrast + 128
      b = (b-128)*contrast + 128
    }
    // clamp before HSL
    r = r<0?0:r>255?255:r; g = g<0?0:g>255?255:g; b = b<0?0:b>255?255:b
    // saturation + hue via HSL
    if (needHsl) {
      const hsl = rgbToHsl(r, g, b)
      let h = hsl[0] + hueShift
      const s = Math.max(0, Math.min(1, hsl[1] * satF))
      const rgb = hslToRgb(h, s, hsl[2])
      r = rgb[0]; g = rgb[1]; b = rgb[2]
    }
    if (grayscale) {
      const y = 0.299*r + 0.587*g + 0.114*b
      r = g = b = y
    }
    if (invert) { r = 255-r; g = 255-g; b = 255-b }

    out[i]   = r<0?0:r>255?255:r
    out[i+1] = g<0?0:g>255?255:g
    out[i+2] = b<0?0:b>255?255:b
  }
  return out
}

// ── Filters (blur / sharpen / noise) ────────────────────────────────────────────
type Filter = { blur: number; sharpen: number; noise: number } // blur 0..20px, sharpen 0..100, noise 0..100
const FILTER_ZERO: Filter = { blur: 0, sharpen: 0, noise: 0 }
function filterIsZero(f: Filter): boolean { return f.blur === 0 && f.sharpen === 0 && f.noise === 0 }

// Premultiplied separable box blur, 3 iterations ≈ Gaussian. Radius-independent
// cost (running sums) so even large blurs preview instantly. Returns premultiplied
// RGBA floats (channel 3 = alpha 0..255).
function boxBlur3(px: Uint8Array, w: number, h: number, radiusPx: number): Float32Array {
  const n = w * h
  let a = new Float32Array(n * 4), b = new Float32Array(n * 4)
  for (let i = 0; i < n; i++) { const al = px[i*4+3] / 255
    a[i*4] = px[i*4]*al; a[i*4+1] = px[i*4+1]*al; a[i*4+2] = px[i*4+2]*al; a[i*4+3] = px[i*4+3] }
  const r = Math.max(1, Math.round(radiusPx / 3))
  const win = r * 2 + 1
  const boxH = (src: Float32Array, dst: Float32Array) => {
    for (let y = 0; y < h; y++) {
      const row = y * w
      let s0=0,s1=0,s2=0,s3=0
      for (let k = -r; k <= r; k++) { const x = Math.max(0, Math.min(w-1, k)); const o=(row+x)*4; s0+=src[o];s1+=src[o+1];s2+=src[o+2];s3+=src[o+3] }
      for (let x = 0; x < w; x++) {
        const o=(row+x)*4; dst[o]=s0/win; dst[o+1]=s1/win; dst[o+2]=s2/win; dst[o+3]=s3/win
        const xa=Math.max(0,Math.min(w-1,x-r)), xb=Math.max(0,Math.min(w-1,x+r+1))
        const oa=(row+xa)*4, ob=(row+xb)*4
        s0+=src[ob]-src[oa]; s1+=src[ob+1]-src[oa+1]; s2+=src[ob+2]-src[oa+2]; s3+=src[ob+3]-src[oa+3]
      }
    }
  }
  const boxV = (src: Float32Array, dst: Float32Array) => {
    for (let x = 0; x < w; x++) {
      let s0=0,s1=0,s2=0,s3=0
      for (let k = -r; k <= r; k++) { const y = Math.max(0, Math.min(h-1, k)); const o=(y*w+x)*4; s0+=src[o];s1+=src[o+1];s2+=src[o+2];s3+=src[o+3] }
      for (let y = 0; y < h; y++) {
        const o=(y*w+x)*4; dst[o]=s0/win; dst[o+1]=s1/win; dst[o+2]=s2/win; dst[o+3]=s3/win
        const ya=Math.max(0,Math.min(h-1,y-r)), yb=Math.max(0,Math.min(h-1,y+r+1))
        const oa=(ya*w+x)*4, ob=(yb*w+x)*4
        s0+=src[ob]-src[oa]; s1+=src[ob+1]-src[oa+1]; s2+=src[ob+2]-src[oa+2]; s3+=src[ob+3]-src[oa+3]
      }
    }
  }
  for (let it = 0; it < 3; it++) { boxH(a, b); boxV(b, a) }
  return a
}

function applyFilters(src: Uint8Array, w: number, h: number, f: Filter): Uint8Array {
  const out = new Uint8Array(src.length); out.set(src)
  if (filterIsZero(f)) return out
  const n = w * h
  // Gaussian blur (premultiplied → correct transparent edges)
  if (f.blur > 0) {
    const bl = boxBlur3(out, w, h, f.blur)
    for (let i = 0; i < n; i++) { const a = bl[i*4+3]; const inv = a > 0.5 ? 255 / a : 0
      out[i*4]   = Math.round(bl[i*4]  *inv); out[i*4+1] = Math.round(bl[i*4+1]*inv)
      out[i*4+2] = Math.round(bl[i*4+2]*inv); out[i*4+3] = Math.round(a) }
  }
  // Unsharp mask: out + amount·(out − blurred)
  if (f.sharpen > 0) {
    const amt = f.sharpen / 100 * 1.4
    const bl = boxBlur3(out, w, h, 2)
    for (let i = 0; i < n; i++) { const a = out[i*4+3]; if (a === 0) continue; const al = a/255
      for (let c = 0; c < 3; c++) { const o=i*4+c
        const blur = al > 0 ? bl[o] / al : out[o]   // unpremult blurred channel
        let v = out[o] + amt*(out[o] - blur)
        out[o] = v < 0 ? 0 : v > 255 ? 255 : v } }
  }
  // Monochromatic noise
  if (f.noise > 0) {
    const amp = f.noise / 100 * 80
    for (let i = 0; i < n; i++) { if (out[i*4+3] === 0) continue
      const dn = (Math.random()*2 - 1) * amp
      for (let c = 0; c < 3; c++) { const o=i*4+c; let v=out[o]+dn; out[o]=v<0?0:v>255?255:v } }
  }
  return out
}

// ── WebGL Shaders ─────────────────────────────────────────────────────────────

// Composite pass: NO Y-flip. Layer textures store doc-top at t=0.
// Each ping-pong step is consistent → no alternating flip.
const VERT_COMP = `#version 300 es
in vec2 aPos; out vec2 vUv;
void main() { vUv = aPos*.5+.5; gl_Position=vec4(aPos,0,1); }`

// Display pass: Y-flip so that vUv.y=0 maps to screen-top which reads fb-bottom=doc-top.
const VERT_DISP = `#version 300 es
in vec2 aPos; out vec2 vUv;
void main() { vUv = aPos*.5+.5; vUv.y=1.-vUv.y; gl_Position=vec4(aPos,0,1); }`

const FRAG_COMPOSITE = `#version 300 es
precision highp float;
uniform sampler2D uBase, uLayer, uMask, uClip;
uniform float uOpacity;
uniform int uMode;
uniform int uHasMask;
uniform int uHasClip;
in vec2 vUv; out vec4 fragColor;
vec3 fScreen(vec3 b,vec3 l){return b+l-b*l;}
vec3 fOvl(vec3 b,vec3 l){
  return vec3(
    b.r<.5?2.*b.r*l.r:1.-2.*(1.-b.r)*(1.-l.r),
    b.g<.5?2.*b.g*l.g:1.-2.*(1.-b.g)*(1.-l.g),
    b.b<.5?2.*b.b*l.b:1.-2.*(1.-b.b)*(1.-l.b));
}
vec3 fSoft(vec3 b,vec3 l){
  return mix(2.*b*l+b*b*(1.-2.*l), 2.*b*(1.-l)+sqrt(b)*(2.*l-1.), step(.5,l));
}
vec3 fVivid(vec3 b,vec3 l){
  return vec3(
    l.r<.5? 1.-min((1.-b.r)/max(2.*l.r,1e-4),1.) : min(b.r/max(2.*(1.-l.r),1e-4),1.),
    l.g<.5? 1.-min((1.-b.g)/max(2.*l.g,1e-4),1.) : min(b.g/max(2.*(1.-l.g),1e-4),1.),
    l.b<.5? 1.-min((1.-b.b)/max(2.*l.b,1e-4),1.) : min(b.b/max(2.*(1.-l.b),1e-4),1.));
}
vec3 fPin(vec3 b,vec3 l){
  return vec3(
    l.r<.5? min(b.r,2.*l.r) : max(b.r,2.*(l.r-.5)),
    l.g<.5? min(b.g,2.*l.g) : max(b.g,2.*(l.g-.5)),
    l.b<.5? min(b.b,2.*l.b) : max(b.b,2.*(l.b-.5)));
}
// Non-separable (HSL) blends — hue / saturation / color / luminosity.
float bLum(vec3 c){return dot(c,vec3(0.3,0.59,0.11));}
vec3 clipColor(vec3 c){
  float l=bLum(c), n=min(min(c.r,c.g),c.b), x=max(max(c.r,c.g),c.b);
  if(n<0.) c=l+(c-l)*l/max(l-n,1e-5);
  if(x>1.) c=l+(c-l)*(1.-l)/max(x-l,1e-5);
  return c;
}
vec3 setLum(vec3 c,float l){return clipColor(c+(l-bLum(c)));}
float bSat(vec3 c){return max(max(c.r,c.g),c.b)-min(min(c.r,c.g),c.b);}
vec3 setSat(vec3 c,float s){
  float mn=min(min(c.r,c.g),c.b), mx=max(max(c.r,c.g),c.b), rg=mx-mn;
  return rg>0.? (c-mn)/rg*s : vec3(0.);
}
void main(){
  vec4 base=texture(uBase,vUv), lay=texture(uLayer,vUv);
  // Erase mode: reduce base alpha by stroke alpha (opacity already baked into lay.a)
  if(uMode==10){
    float newA=max(0.,base.a-lay.a);
    fragColor=vec4(base.a>.001?base.rgb:vec3(0.),newA); return;
  }
  if(uHasMask==1) lay.a*=texture(uMask,vUv).r; // layer mask: white=visible, black=hidden
  if(uHasClip==1) lay.a*=texture(uClip,vUv).a; // clipping mask: confined to clip base's alpha
  lay.a*=uOpacity;
  vec3 bl;
  if(uMode==1) bl=base.rgb*lay.rgb;
  else if(uMode==2) bl=fScreen(base.rgb,lay.rgb);
  else if(uMode==3) bl=fOvl(base.rgb,lay.rgb);
  else if(uMode==4) bl=min(base.rgb,lay.rgb);
  else if(uMode==5) bl=max(base.rgb,lay.rgb);
  else if(uMode==6) bl=abs(base.rgb-lay.rgb);
  else if(uMode==7) bl=clamp(base.rgb/max(1.-lay.rgb,.001),0.,1.);
  else if(uMode==8) bl=1.-clamp((1.-base.rgb)/max(lay.rgb,.001),0.,1.);
  else if(uMode==9) bl=fSoft(base.rgb,lay.rgb);
  else if(uMode==11) bl=fOvl(lay.rgb,base.rgb);                       // hard light
  else if(uMode==12) bl=min(base.rgb+lay.rgb,1.);                     // linear dodge (add)
  else if(uMode==13) bl=max(base.rgb+lay.rgb-1.,0.);                  // linear burn
  else if(uMode==14) bl=fVivid(base.rgb,lay.rgb);                     // vivid light
  else if(uMode==15) bl=clamp(base.rgb+2.*lay.rgb-1.,0.,1.);          // linear light
  else if(uMode==16) bl=fPin(base.rgb,lay.rgb);                       // pin light
  else if(uMode==17) bl=base.rgb+lay.rgb-2.*base.rgb*lay.rgb;         // exclusion
  else if(uMode==18) bl=max(base.rgb-lay.rgb,0.);                     // subtract
  else if(uMode==19) bl=clamp(base.rgb/max(lay.rgb,vec3(1e-4)),0.,1.);// divide
  else if(uMode==20) bl=setLum(setSat(lay.rgb,bSat(base.rgb)),bLum(base.rgb)); // hue
  else if(uMode==21) bl=setLum(setSat(base.rgb,bSat(lay.rgb)),bLum(base.rgb)); // saturation
  else if(uMode==22) bl=setLum(lay.rgb,bLum(base.rgb));               // color
  else if(uMode==23) bl=setLum(base.rgb,bLum(lay.rgb));               // luminosity
  else bl=lay.rgb;
  float a=lay.a+base.a*(1.-lay.a);
  vec3 c=a<.0001?vec3(0.):(bl*lay.a+base.rgb*base.a*(1.-lay.a))/a;
  fragColor=vec4(c,a);
}`

const FRAG_DISPLAY = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec2 uOffset, uScale, uViewport;
uniform float uRot;
in vec2 vUv; out vec4 fragColor;

// Scale-aware resampler. Benchmarked against bilinear / trilinear+aniso / bicubic
// across a full zoom sweep at 0° and 18°: this is the only one that keeps both
// near-best minification anti-aliasing AND crisp magnification with no ringing.
//  • Magnification (≥1:1): "sharp bilinear" / texel anti-aliasing — the sample is
//    snapped to texel centres but the boundary between two texels is anti-aliased
//    over exactly one screen pixel. Texel interiors stay perfectly crisp (no
//    bicubic/bilinear blur) while edges are smooth (no NEAREST stair-stepping),
//    and it works at any zoom and rotation.
//  • Minification (<1:1): 4×4 footprint supersample (each tap covers a quarter of
//    the footprint via mips) — anti-aliased without the trilinear over-blur.
// dx/dy are dFdx/dFdy(uv), passed from main() so derivatives stay in uniform flow.
vec4 sampleDoc(vec2 uv, vec2 dx, vec2 dy){
  vec2 ts=vec2(textureSize(uTex,0));
  float fp=max(length(dx*ts), length(dy*ts)); // texels covered per device pixel
  if(fp<1.0){
    vec2 px=uv*ts;
    vec2 fl=floor(px)+0.5;
    vec2 w=max((abs(dx)+abs(dy))*ts, vec2(1e-5)); // = fwidth(px), one screen px in texels
    vec2 aa=clamp((px-fl)/w, -0.5, 0.5);
    return textureLod(uTex, (fl+aa)/ts, 0.0);     // LINEAR mag turns the offset into a 1px AA edge
  }
  vec2 sdx=dx*0.25, sdy=dy*0.25;
  vec4 acc=vec4(0.0);
  for(int j=0;j<4;j++) for(int i=0;i<4;i++){
    vec2 o=(vec2(float(i),float(j))+0.5)*0.25-0.5;
    acc+=textureGrad(uTex, uv+dx*o.x+dy*o.y, sdx, sdy);
  }
  return acc*0.0625;
}

void main(){
  vec2 sp=vUv*uViewport;
  // Rotate the screen point about the viewport centre (inverse, to sample the doc).
  vec2 cv=uViewport*0.5;
  float cs=cos(-uRot), sn=sin(-uRot);
  vec2 d=sp-cv;
  vec2 base=cv+vec2(d.x*cs-d.y*sn, d.x*sn+d.y*cs);
  vec2 tc=(base-uOffset)/uScale;
  // Derivatives in uniform control flow (before the edge discard) so the footprint
  // and mip LOD stay defined right up to the doc border.
  vec2 tdx=dFdx(tc), tdy=dFdy(tc);
  if(tc.x<0.||tc.x>1.||tc.y<0.||tc.y>1.){
    float ck=mod(floor(sp.x/14.)+floor(sp.y/14.),2.);
    fragColor=vec4(ck>.5?vec3(.18):vec3(.14),1.); return;
  }
  vec4 col=sampleDoc(tc, tdx, tdy);
  float ck=mod(floor(tc.x*uScale.x/14.)+floor(tc.y*uScale.y/14.),2.);
  vec3 bg=ck>.5?vec3(.7):vec3(.5);
  fragColor=vec4(col.rgb*col.a+bg*(1.-col.a),1.);
}`

// ── WebGL helpers ─────────────────────────────────────────────────────────────
function glShader(gl: WebGL2RenderingContext, type: number, src: string) {
  const s = gl.createShader(type)!
  gl.shaderSource(s, src); gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)!)
  return s
}
function glProg(gl: WebGL2RenderingContext, vs: string, fs: string) {
  const p = gl.createProgram()!
  gl.attachShader(p, glShader(gl, gl.VERTEX_SHADER, vs))
  gl.attachShader(p, glShader(gl, gl.FRAGMENT_SHADER, fs))
  gl.linkProgram(p)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p)!)
  return p
}
function glVAO(gl: WebGL2RenderingContext, prog: WebGLProgram) {
  const vao = gl.createVertexArray()!; gl.bindVertexArray(vao)
  const buf = gl.createBuffer()!; gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,1,1]), gl.STATIC_DRAW)
  const loc = gl.getAttribLocation(prog, 'aPos')
  gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
  gl.bindVertexArray(null); return vao
}
function glFB(gl: WebGL2RenderingContext, w: number, h: number) {
  const tex = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  // Anisotropic filtering: the single biggest quality win when the document is
  // viewed minified AND rotated/oblique (trilinear alone picks one LOD and either
  // blurs or aliases along the stretched axis).
  const aniso = gl.getExtension('EXT_texture_filter_anisotropic')
  if (aniso) {
    const max = gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number
    gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, max))
  }
  const fb = gl.createFramebuffer()!
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  return { tex, fb }
}

// ── Main component ────────────────────────────────────────────────────────────
// Embedded mode: the SAME raster editor mounted inside another app (Keyframe draws
// a cel). Server doc loading/saving is bypassed — seeded from a PNG in memory and
// every edit reported through onCommit — so all of Layer's tools stay available.
export interface LayerEmbed {
  width:    number
  height:   number
  initial:  string | null   // PNG data URL of the current cel, or null
  onCommit: (png: string) => void
  onClose:  () => void
  title?:   string
}

export default function LayerEditorPage({ embed }: { embed?: LayerEmbed } = {}) {
  const embedded = !!embed
  const { t } = useTranslation('paintsharp')
  const { id: routeId } = useParams<{ id: string }>()
  const docId = embedded ? undefined : routeId
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const { data: doc } = useQuery({
    queryKey: ['layer-doc', docId],
    queryFn:  () => layerApi.getDoc(docId!).then(r => r.data),
    enabled:  !!docId,
  })

  // ── Titre éditable (standard WorkspaceShell) — synchronisé depuis le doc ───────
  const [titleDraft, setTitleDraft] = useState('')
  useEffect(() => { if (doc?.title != null) setTitleDraft(doc.title) }, [doc?.title])

  const renameMut = useMutation({
    mutationFn: (title: string) => layerApi.updateDoc(docId!, { title }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['layer-doc', docId] }) },
  })
  const starMut = useMutation({
    mutationFn: (is_starred: boolean) => layerApi.updateDoc(docId!, { is_starred }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['layer-doc', docId] }) },
  })
  const trashMut = useMutation({
    mutationFn: () => layerApi.trashDoc(docId!),
    onSuccess: () => { navigate('/paintsharp/layer') },
  })
  const commitTitle = () => {
    const v = titleDraft.trim()
    if (v && v !== doc?.title) renameMut.mutate(v)
    else if (!v && doc?.title) setTitleDraft(doc.title)
  }

  // ── UI state ──────────────────────────────────────────────────────────────
  const [layers,       setLayers]      = useState<LayerStructureItem[]>([])
  // Bumped on every pixel-level texture write & structural change → drives live
  // Layers-panel thumbnail refresh (no continuous timer; never tied to view state).
  const [thumbNonce,   setThumbNonce]  = useState(0)
  const [activeId,     setActiveId]    = useState<string | null>(null)
  const [tool,         setTool]        = useState<Tool>('brush')
  const [brushSize,    setBrushSize]   = useState(20)
  const [brushHard,    setBrushHard]   = useState(80)
  const [brushOpac,    setBrushOpac]   = useState(100)
  const [brushPreset,  setBrushPreset] = useState<string>(DEFAULT_BRUSH.id)
  const [brushSelOpen, setBrushSelOpen] = useState(false)
  // Track whether the user manually changed the size (so a preset won't clobber it).
  const sizeTouched    = useRef(false)
  const [fgColor,      setFgColor]     = useState('#000000')
  // Text tool: the in-progress text box anchored at a doc-space point (null = none).
  const [textEdit,     setTextEdit]    = useState<{ dx: number; dy: number } | null>(null)
  const [textValue,    setTextValue]   = useState('')
  const [fontFamily,   setFontFamily]  = useState('Arial')
  const [fontSize,     setFontSize]    = useState(120)   // document pixels (docs are hi-DPI)
  const textBoxRef = useRef<HTMLDivElement>(null)
  // Recently used colours (most-recent first, max 30), persisted across sessions.
  const [colorHistory, setColorHistory] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('kubuno:paintsharp:colorHistory') || '[]') } catch { return [] }
  })
  const pushColorHistory = (hex: string) => {
    setColorHistory(prev => {
      const next = [hex.toLowerCase(), ...prev.filter(c => c.toLowerCase() !== hex.toLowerCase())].slice(0, 30)
      try { localStorage.setItem('kubuno:paintsharp:colorHistory', JSON.stringify(next)) } catch { /* ignore */ }
      return next
    })
  }
  const [viewState,    setViewState]   = useState({ zoom: 0.4, panX: 60, panY: 60 })
  const [viewRot,      setViewRot]     = useState(0) // canvas rotation in radians
  const [editLayerId,  setEditLayerId] = useState<string | null>(null)
  const [editName,     setEditName]    = useState('')
  const [undoCount,    setUndoCount]   = useState(0)
  const [redoCount,    setRedoCount]   = useState(0)
  const [webglError,   setWebglError]  = useState<string | null>(null)
  const [selection,    setSelection]   = useState<{x:number;y:number;w:number;h:number}|null>(null)
  const [hasSel,       setHasSel]      = useState(false) // a pixel selection is active
  const [pressureSens, setPressureSens] = useState(true)
  const [stabilizer,   setStabilizer]  = useState(40)   // 0..100 % smoothing
  // Detected input device + its live pressure (pen = stylus/Apple Pencil, touch = finger).
  const [inputKind,    setInputKind]   = useState<'pen'|'touch'|'mouse'|null>(null)
  const [inputPressure,setInputPressure] = useState(0)   // current live pressure 0..1
  const [colorPickerOpen, setColorPickerOpen] = useState(false)
  // Photoshop-style docks: the bottom panel group switches between tabs, and the
  // whole right dock can be hidden (Tab-to-hide) for a full-width canvas.
  const [panelsHidden, setPanelsHidden] = useState(false)
  const dockApi = useRef<DockController | null>(null)   // imperative handle to <DockArea>
  // Dock layout state, drag logic and persistence now live in <DockArea> (ui/Dock.tsx).
  // Mask editing: when on, the brush paints onto the active layer's mask (grayscale)
  // instead of its pixels. Brush hides (black), eraser reveals (white).
  const [editingMask, setEditingMask] = useState(false)
  const maskStroke = useRef<{ maskId: string; hide: boolean } | null>(null)
  const maskBase   = useRef<Uint8Array | null>(null)

  // ── Adjustments / Filters (non-destructive preview on active layer) ─────────
  const [adjust,      setAdjust]      = useState<Adjust>(ADJUST_ZERO)
  const [adjInvert,   setAdjInvert]   = useState(false)
  const [adjGray,     setAdjGray]     = useState(false)
  // Original pixels snapshot for the layer currently being adjusted.
  const adjBaseRef    = useRef<{ id: string; px: Uint8Array } | null>(null)
  // Filters (blur / sharpen / noise) — same non-destructive preview model.
  const [filter,      setFilter]      = useState<Filter>(FILTER_ZERO)
  const filtBaseRef   = useRef<{ id: string; px: Uint8Array } | null>(null)

  // ── Canvas / WebGL refs ───────────────────────────────────────────────────
  const canvasRef   = useRef<HTMLCanvasElement>(null)
  const overlayRef  = useRef<HTMLCanvasElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const glRef       = useRef<WebGL2RenderingContext | null>(null)
  const progComp    = useRef<WebGLProgram | null>(null)
  const progDisp    = useRef<WebGLProgram | null>(null)
  const quadVAO     = useRef<WebGLVertexArrayObject | null>(null)
  const textures    = useRef<Map<string, WebGLTexture>>(new Map())
  const fbPair      = useRef<[ReturnType<typeof glFB>, ReturnType<typeof glFB>] | null>(null)
  // Pool of doc-size FB pairs for isolated group compositing (depth-bounded → frugal).
  const fbPoolAll   = useRef<ReturnType<typeof glFB>[]>([])
  const fbPoolFree  = useRef<ReturnType<typeof glFB>[]>([])
  const docSize     = useRef({ w: 1920, h: 1080 })
  const lastSrc     = useRef(0)

  // Stroke preview: offscreen Canvas 2D + WebGL texture (painted in doc space)
  const strokeCanvasRef  = useRef<HTMLCanvasElement | null>(null)
  const strokeTexRef     = useRef<WebGLTexture | null>(null)
  // null = no stroke in progress; set = show stroke at this layer position
  const strokePreviewRef = useRef<{ layerId: string; isErase: boolean } | null>(null)

  // Refs to avoid stale closures in event handlers
  const vsRef    = useRef(viewState)
  const rotRef   = useRef(viewRot)              // canvas rotation (radians)
  const viewSizeRef = useRef({ w: 1, h: 1 })    // viewport CSS size, kept in sync by render
  const layersRef= useRef(layers)
  const activeRef= useRef(activeId)
  const toolRef  = useRef(tool)
  const bsRef    = useRef(brushSize)
  const bhRef    = useRef(brushHard)
  const boRef    = useRef(brushOpac)
  const fgRef    = useRef(fgColor)
  const brushRef = useRef<BrushPreset>(DEFAULT_BRUSH)
  useEffect(() => {
    brushRef.current = BRUSH_PRESETS.find(b => b.id === brushPreset) ?? DEFAULT_BRUSH
  }, [brushPreset])
  useEffect(() => { vsRef.current     = viewState },  [viewState])
  useEffect(() => { rotRef.current     = viewRot },   [viewRot])
  useEffect(() => { layersRef.current = layers },     [layers])
  useEffect(() => { activeRef.current = activeId },   [activeId])
  useEffect(() => { toolRef.current   = tool },       [tool])
  // Leaving the text tool commits any open text box.
  useEffect(() => { if (tool !== 'text' && textEdit) commitText() }, [tool]) // eslint-disable-line react-hooks/exhaustive-deps
  // Enter free-transform when the tool is selected; commit when leaving it.
  useEffect(() => {
    if (tool === 'transform') { if (!xfActive.current) enterTransform() }
    else if (xfActive.current) commitTransform()
  }, [tool]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { bsRef.current     = brushSize },  [brushSize])
  useEffect(() => { bhRef.current     = brushHard },  [brushHard])
  useEffect(() => { boRef.current     = brushOpac },  [brushOpac])
  useEffect(() => { fgRef.current     = fgColor },    [fgColor])
  // Focus the text box as soon as it opens.
  useEffect(() => {
    if (textEdit && textBoxRef.current) {
      const el = textBoxRef.current
      el.textContent = ''
      el.focus()
    }
  }, [textEdit])
  const pressureSensRef = useRef(pressureSens)
  useEffect(() => { pressureSensRef.current = pressureSens }, [pressureSens])
  const stabilizerRef = useRef(stabilizer)
  useEffect(() => { stabilizerRef.current = stabilizer }, [stabilizer])
  // Smoothed brush position (the lagging end of the stabilizer "string") and the
  // last raw cursor position, both in doc space. rawPt drives the end-of-stroke
  // catch-up so the line always reaches where the user lifted.
  const smoothPt = useRef<{x:number;y:number}|null>(null)
  const rawPt    = useRef<{x:number;y:number}|null>(null)

  // Undo/Redo stacks
  const undoStack = useRef<{id: string; px: Uint8Array}[]>([])
  const redoStack = useRef<{id: string; px: Uint8Array}[]>([])

  // Drawing state
  const isDrawing  = useRef(false)
  const dragPan    = useRef<{sx:number;sy:number;px:number;py:number}|null>(null)
  const selStart   = useRef<{x:number;y:number}|null>(null)
  // Pixel selection: 0=outside, 255=inside (null = no selection → whole layer editable)
  const selMask    = useRef<Uint8Array|null>(null)
  const selCanvas  = useRef<HTMLCanvasElement|null>(null) // cached doc-res tint for the overlay
  const lassoPts   = useRef<{x:number;y:number}[]|null>(null)
  // Free transform of the active layer (move / scale / rotate)
  const xfActive = useRef(false)
  const xfSnap   = useRef<Uint8Array|null>(null)
  const xf       = useRef({ tx:0, ty:0, scale:1, rot:0 })
  const xfDrag   = useRef<null | { mode:'move'|'scale'|'rotate'; downX:number; downY:number; start:{tx:number;ty:number;scale:number;rot:number}; startDist:number; startAng:number }>(null)
  // Rotate-tool drag: pointer angle (rad) about viewport centre at grab + rot then.
  const dragRot    = useRef<{startAngle:number;startRot:number}|null>(null)
  // Zoom-tool scrubby drag: anchor + start zoom; right/up = in, left/down = out.
  const zoomDrag   = useRef<{x0:number;y0:number;startZoom:number;button:number;moved:boolean}|null>(null)
  // Two-finger gesture: every active touch pointer + the transform snapshot at grab.
  const touchPts   = useRef<Map<number,{x:number;y:number}>>(new Map())
  const gesture    = useRef<{
    startDist:number; startAngle:number; startZoom:number; startRot:number;
    docMidX:number; docMidY:number;
  }|null>(null)

  // Brush stroke doc-space points (p = effective pressure 0..1)
  const strokeDocPts = useRef<{x:number;y:number;p:number}[]>([])

  // Incremental stroke-render state (persists across pointermove so we stamp only
  // the dabs for newly-added points instead of redrawing the whole stroke).
  const dabCarry   = useRef(0)               // leftover arc-length since last dab
  const dabSeed    = useRef(0x2545f491)      // PRNG state (continuous across stamps)
  const lastDabIdx = useRef(-1)              // index of the last point already stamped
  // Union of the canvas region touched since the last GPU upload (doc-space px).
  const strokeDirty = useRef<{x0:number;y0:number;x1:number;y1:number}|null>(null)
  const strokeBBox  = useRef<{x0:number;y0:number;x1:number;y1:number}|null>(null)
  const strokeRaf   = useRef<number | null>(null)

  // Save mutation
  const saveMut = useMutation({
    mutationFn: (ls: LayerStructureItem[]) => layerApi.saveStructure(docId!, ls),
  })

  // ── WebGL init (runs once on mount) ──────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, alpha: true, preserveDrawingBuffer: true })
    if (!gl) { setWebglError(t('layer_webgl_unsupported')); return }
    glRef.current = gl
    try {
      progComp.current = glProg(gl, VERT_COMP, FRAG_COMPOSITE)
      progDisp.current = glProg(gl, VERT_DISP, FRAG_DISPLAY)
      quadVAO.current  = glVAO(gl, progDisp.current)
    } catch(e) { setWebglError(String(e)); return }
    const { w, h } = docSize.current
    fbPair.current = [glFB(gl, w, h), glFB(gl, w, h)]
  }, [])

  // ── Init layers + centering when doc loads ────────────────────────────────
  useEffect(() => {
    if (!doc && !embedded) return
    const W = embedded ? embed!.width : doc!.width
    const H = embedded ? embed!.height : doc!.height
    docSize.current = { w: W, h: H }

    const lsRaw = embedded ? [] : ((doc!.layers_structure as LayerStructureItem[]) ?? [])
    // Métadonnée conservée en state (sans les pixels) ; les pixels vont en texture.
    const stripData = (nodes: LayerStructureItem[]): LayerStructureItem[] =>
      nodes.map(({ data: _d, mask_data: _m, children, ...meta }) =>
        children ? { ...meta, children: stripData(children) } : { ...meta })
    const initial: LayerStructureItem[] = lsRaw.length > 0 ? stripData(lsRaw) : [{
      id: newId(), type: 'raster', name: 'Fond',
      visible: true, locked: false, opacity: 100, blendMode: 'normal',
      x: 0, y: 0, mask: null, effects: [],
    }]
    setLayers(initial)
    setActiveId(initial[0].id)

    // Recreate FB pair at correct doc size
    const gl = glRef.current
    if (gl) {
      fbPair.current = [glFB(gl, W, H), glFB(gl, W, H)]
      // Discard the group-isolation pool (stale size); it refills lazily.
      fbPoolAll.current.forEach(f => { gl.deleteFramebuffer(f.fb); gl.deleteTexture(f.tex) })
      fbPoolAll.current = []; fbPoolFree.current = []
      if (embedded) {
        // Single transparent cel layer seeded with the incoming PNG (if any).
        const fond = initial[0]
        if (!textures.current.has(fond.id)) createTex(gl, fond.id, W, H)
        if (embed!.initial) loadPngToTex(fond.id, embed!.initial)
      } else {
        // Ensure textures + restaurer les pixels depuis le fichier (.kblay).
        const src = lsRaw.length > 0 ? lsRaw : initial
        leaves(src).forEach(l => {
          if (l.type !== 'raster') return
          if (!textures.current.has(l.id)) createTex(gl, l.id, W, H, l.name === 'Fond')
          if (l.data) loadPngToTex(l.id, l.data)
          if (l.mask?.enabled && l.mask_data) {
            if (!textures.current.has(maskKey(l.id))) createTex(gl, maskKey(l.id), W, H, true)
            loadPngToTex(maskKey(l.id), l.mask_data)
          }
        })
      }
    }

    // Center canvas after layout
    setTimeout(() => {
      const vp = viewportRef.current
      if (!vp) return
      const { width, height } = vp.getBoundingClientRect()
      if (width === 0 || height === 0) return
      const zoom = Math.max(0.05, Math.min(1.5,
        Math.min((width - 60) / W, (height - 60) / H)
      ))
      setViewState({
        zoom,
        panX: (width  - W * zoom) / 2,
        panY: (height - H * zoom) / 2,
      })
    }, 0)
  }, [doc, embedded]) // eslint-disable-line react-hooks/exhaustive-deps

  // Re-composite the whole layer tree only when the layers themselves change.
  useEffect(() => {
    renderComposite()
    redrawOverlay()
  }, [layers]) // eslint-disable-line react-hooks/exhaustive-deps

  // View-only changes (pan / zoom / rotation) never touch the pixels, so they
  // skip the expensive tree compositing and just re-blit the last composite.
  useEffect(() => {
    renderDisplay()
    redrawOverlay() // keep the selection tint aligned with pan/zoom/rotation
  }, [viewState, viewRot]) // eslint-disable-line react-hooks/exhaustive-deps

  // Structural changes (load, add/delete/reorder…) refresh thumbnails. Keyed on
  // `layers` ONLY — never viewState — so panning/zooming triggers no readbacks.
  useEffect(() => { setThumbNonce(v => v + 1) }, [layers])

  // Sync overlay size
  useEffect(() => {
    const ov = overlayRef.current
    if (!ov) return
    const sync = () => { ov.width = ov.offsetWidth; ov.height = ov.offsetHeight }
    const ro = new ResizeObserver(sync)
    ro.observe(ov)
    sync()
    return () => ro.disconnect()
  }, [])

  // Global pointer listeners for pan (works for mouse AND stylus, survives canvas exit)
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const pan = dragPan.current
      if (!pan) return
      setViewState(prev => ({
        ...prev,
        panX: pan.px + (e.clientX - pan.sx),
        panY: pan.py + (e.clientY - pan.sy),
      }))
    }
    const onUp = () => { dragPan.current = null }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Sauvegarde automatique (debounce + flush au démontage/fermeture).
  // Sauvegarde auto : déclenchée par les changements de structure (`layers`) ET
  // de pixels (`thumbNonce`, incrémenté à chaque writeTex). Sérialise les pixels.
  useDebouncedAutosave(
    { s: layers, p: thumbNonce },
    (embedded || !!docId) && layers.length > 0,
    () => { if (embedded) embed!.onCommit(compositeToPng()); else saveMut.mutate(buildSaveStructure()) },
  )

  // ── WebGL helpers ─────────────────────────────────────────────────────────
  function createTex(gl: WebGL2RenderingContext, id: string, w: number, h: number, white = false) {
    const tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, tex)
    const px = new Uint8Array(w * h * 4)
    if (white) { for (let i = 0; i < px.length; i += 4) { px[i]=255; px[i+1]=255; px[i+2]=255; px[i+3]=255 } }
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, px)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    textures.current.set(id, tex)
  }

  function ensureTex(gl: WebGL2RenderingContext) {
    const { w, h } = docSize.current
    // Walk the whole tree: raster leaves get a colour texture; any node with a
    // mask gets a mask texture.
    allNodes(layersRef.current).forEach(l => {
      if (!l.children && l.type === 'raster' && !textures.current.has(l.id)) {
        createTex(gl, l.id, w, h, l.name === 'Fond')
      }
      if (l.mask?.enabled && !textures.current.has(maskKey(l.id))) {
        createTex(gl, maskKey(l.id), w, h, true) // white = fully visible
      }
    })
  }

  function readTex(id: string): Uint8Array | null {
    const gl = glRef.current
    const tex = textures.current.get(id)
    if (!gl || !tex) return null
    const { w, h } = docSize.current
    const fb = gl.createFramebuffer()!
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
    const px = new Uint8Array(w * h * 4)
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.deleteFramebuffer(fb)
    return px
  }

  function writeTex(id: string, px: Uint8Array) {
    const gl = glRef.current
    const tex = textures.current.get(id)
    if (!gl || !tex) return
    const { w, h } = docSize.current
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px)
    renderComposite()
    setThumbNonce(v => v + 1)   // discrete edit → refresh thumbnails
  }

  // ── Persistance des pixels (.kblay) ──────────────────────────────────────────
  // Les pixels d'un calque raster sont sérialisés en PNG (data URL) et stockés
  // dans `layers_structure`. La lecture/écriture passe par read/writeTex ; la
  // sérialisation est symétrique → round-trip exact (le PNG interne peut être
  // verticalement inversé, sans incidence puisque save/load utilisent le même
  // chemin).
  function texToPng(id: string): string | undefined {
    const px = readTex(id)
    if (!px) return undefined
    const { w, h } = docSize.current
    const c = document.createElement('canvas'); c.width = w; c.height = h
    const ctx = c.getContext('2d'); if (!ctx) return undefined
    ctx.putImageData(new ImageData(new Uint8ClampedArray(px), w, h), 0, 0)
    return c.toDataURL('image/png')
  }

  function loadPngToTex(id: string, dataUrl: string) {
    const img = new Image()
    img.onload = () => {
      const { w, h } = docSize.current
      const c = document.createElement('canvas'); c.width = w; c.height = h
      const ctx = c.getContext('2d'); if (!ctx) return
      ctx.drawImage(img, 0, 0, w, h)
      writeTex(id, new Uint8Array(ctx.getImageData(0, 0, w, h).data.buffer))
    }
    img.src = dataUrl
  }

  // Construit la structure à sauvegarder en y injectant les pixels courants.
  function buildSaveStructure(): LayerStructureItem[] {
    const walk = (nodes: LayerStructureItem[]): LayerStructureItem[] => nodes.map(n => {
      const copy: LayerStructureItem = { ...n }
      if (n.children) {
        copy.children = walk(n.children)
      } else if (n.type === 'raster') {
        copy.data = texToPng(n.id)
      }
      if (n.mask?.enabled) {
        const md = texToPng(maskKey(n.id)); if (md) copy.mask_data = md
      }
      return copy
    })
    return walk(layersRef.current)
  }

  function composeLayer(
    gl: WebGL2RenderingContext, pc: WebGLProgram, w: number, h: number,
    srcTex: WebGLTexture, layerTex: WebGLTexture, dstFb: WebGLFramebuffer,
    opacity: number, mode: number, maskTex?: WebGLTexture | null, clipTex?: WebGLTexture | null,
  ) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, dstFb)
    gl.viewport(0, 0, w, h)
    gl.useProgram(pc)
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, srcTex)
    gl.uniform1i(gl.getUniformLocation(pc, 'uBase'), 0)
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, layerTex)
    gl.uniform1i(gl.getUniformLocation(pc, 'uLayer'), 1)
    gl.uniform1f(gl.getUniformLocation(pc, 'uOpacity'), opacity)
    gl.uniform1i(gl.getUniformLocation(pc, 'uMode'), mode)
    if (maskTex) {
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, maskTex)
      gl.uniform1i(gl.getUniformLocation(pc, 'uMask'), 2)
      gl.uniform1i(gl.getUniformLocation(pc, 'uHasMask'), 1)
    } else {
      gl.uniform1i(gl.getUniformLocation(pc, 'uHasMask'), 0)
    }
    if (clipTex) {
      gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, clipTex)
      gl.uniform1i(gl.getUniformLocation(pc, 'uClip'), 3)
      gl.uniform1i(gl.getUniformLocation(pc, 'uHasClip'), 1)
    } else {
      gl.uniform1i(gl.getUniformLocation(pc, 'uHasClip'), 0)
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }
  const maskKey = (id: string) => `${id}::mask`

  // Display-only pass: re-blit the already-composited document with the current
  // pan / zoom / rotation. This is the ONLY work that has to run when just the
  // view moves — the (potentially expensive) layer-tree compositing done by
  // renderComposite() is skipped entirely, which keeps panning and zooming smooth
  // even on documents with many layers or groups.
  function renderDisplay() {
    const gl  = glRef.current
    const pd  = progDisp.current
    const vao = quadVAO.current
    const fb  = fbPair.current
    const cv  = canvasRef.current
    if (!gl || !pd || !vao || !fb || !cv) return

    const { w, h } = docSize.current
    const dpr = window.devicePixelRatio || 1

    // Only resize canvas when its actual pixel size changes (resizing resets WebGL state)
    const newW = Math.round(cv.clientWidth  * dpr)
    const newH = Math.round(cv.clientHeight * dpr)
    viewSizeRef.current = { w: cv.clientWidth, h: cv.clientHeight }
    if (cv.width !== newW || cv.height !== newH) { cv.width = newW; cv.height = newH }

    const src = lastSrc.current
    const vs = vsRef.current
    gl.bindVertexArray(vao)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, newW, newH)
    gl.clearColor(0.1, 0.1, 0.1, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.useProgram(pd)
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, fb[src].tex)
    // The display shader does the quality resampling (bicubic / footprint
    // supersample). It only needs mipmaps available when the view is minified —
    // judged from the *device-pixel* scale (zoom × dpr), so HiDPI is handled.
    if (vs.zoom * dpr < 1) {
      gl.generateMipmap(gl.TEXTURE_2D)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
    } else {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    }
    gl.uniform1i(gl.getUniformLocation(pd, 'uTex'), 0)
    gl.uniform2f(gl.getUniformLocation(pd, 'uOffset'), vs.panX * dpr, vs.panY * dpr)
    gl.uniform2f(gl.getUniformLocation(pd, 'uScale'),  w * vs.zoom * dpr, h * vs.zoom * dpr)
    gl.uniform2f(gl.getUniformLocation(pd, 'uViewport'), newW, newH)
    gl.uniform1f(gl.getUniformLocation(pd, 'uRot'), rotRef.current)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.bindVertexArray(null)
  }

  function renderComposite() {
    const gl  = glRef.current
    const pc  = progComp.current
    const vao = quadVAO.current
    const fb  = fbPair.current
    const cv  = canvasRef.current
    if (!gl || !pc || !vao || !fb || !cv) return

    ensureTex(gl)

    const { w, h } = docSize.current

    gl.bindVertexArray(vao)

    // Clear the accumulator fb
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb[0].fb)
    gl.viewport(0, 0, w, h)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb[1].fb)
    gl.clear(gl.COLOR_BUFFER_BIT)

    const strokePrev = strokePreviewRef.current
    // Pool helpers for isolated group compositing (doc-size FB pairs, reused).
    const acquireFB = () => fbPoolFree.current.pop() ?? (() => { const n = glFB(gl, w, h); fbPoolAll.current.push(n); return n })()
    const releaseFB = (f: ReturnType<typeof glFB>) => fbPoolFree.current.push(f)
    const clearFB = (f: ReturnType<typeof glFB>) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, f.fb); gl.viewport(0, 0, w, h)
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT)
    }

    // Recursively composite a sibling list (top-to-bottom array) onto pair P at
    // index `src` (the backdrop). Groups are flattened in isolation onto a pooled
    // pair, then blended back with the group's opacity·fill/blend/mask. Returns
    // the pair index now holding the result.
    const compositeInto = (P: ReturnType<typeof glFB>[], nodes: LayerStructureItem[], src: number): number => {
      let dst = src ^ 1
      let clipBase: WebGLTexture | null = null   // alpha source for clipped layers above
      for (let i = nodes.length - 1; i >= 0; i--) {   // bottom → top
        const node = nodes[i]
        if (!node.visible) { if (!node.clipping) clipBase = null; continue }
        const eff = (node.opacity / 100) * ((node.fill ?? 100) / 100)
        const mode = BLEND_INT[node.blendMode] ?? 0
        const mTex = node.mask?.enabled ? (textures.current.get(maskKey(node.id)) ?? null) : null
        const clipTex = node.clipping ? clipBase : null
        if (node.children) {                            // group → isolate then blend
          const A = acquireFB(), B = acquireFB(); clearFB(A); clearFB(B)
          const gp = [A, B]
          const gsrc = compositeInto(gp, node.children, 0)
          composeLayer(gl, pc, w, h, P[src].tex, gp[gsrc].tex, P[dst].fb, eff, mode, mTex, clipTex)
          ;[src, dst] = [dst, src]
          releaseFB(A); releaseFB(B)
          clipBase = null
        } else if (node.type === 'raster') {
          const layerTex = textures.current.get(node.id)
          if (layerTex) {
            composeLayer(gl, pc, w, h, P[src].tex, layerTex, P[dst].fb, eff, mode, mTex, clipTex)
            ;[src, dst] = [dst, src]
            // Live stroke preview directly above the active layer (clipped alike).
            if (strokePrev && node.id === strokePrev.layerId && strokeTexRef.current) {
              composeLayer(gl, pc, w, h, P[src].tex, strokeTexRef.current, P[dst].fb, 1.0, strokePrev.isErase ? 10 : 0, null, clipTex)
              ;[src, dst] = [dst, src]
            }
          }
          if (!node.clipping) clipBase = layerTex ?? null
        } else if (!node.clipping) {
          clipBase = null   // text/adjustment leaves not composited yet
        }
      }
      return src
    }

    const src = compositeInto(fb, layersRef.current, 0)
    lastSrc.current = src
    gl.bindVertexArray(null)

    // Push the freshly composited result to the screen.
    renderDisplay()
  }

  // ── Undo / Redo ───────────────────────────────────────────────────────────
  function pushUndo(targetId?: string) {
    const id = targetId ?? activeRef.current
    if (!id) return
    const px = readTex(id)
    if (!px) return
    undoStack.current.push({ id, px })
    if (undoStack.current.length > 20) undoStack.current.shift()
    redoStack.current = []
    setUndoCount(undoStack.current.length)
    setRedoCount(0)
  }

  function undo() {
    const entry = undoStack.current.pop()
    if (!entry) return
    // Save current state to redo
    const cur = readTex(entry.id)
    if (cur) { redoStack.current.push({ id: entry.id, px: cur }) }
    writeTex(entry.id, entry.px)
    setUndoCount(undoStack.current.length)
    setRedoCount(redoStack.current.length)
  }

  function redo() {
    const entry = redoStack.current.pop()
    if (!entry) return
    const cur = readTex(entry.id)
    if (cur) { undoStack.current.push({ id: entry.id, px: cur }) }
    writeTex(entry.id, entry.px)
    setUndoCount(undoStack.current.length)
    setRedoCount(redoStack.current.length)
  }

  // ── Adjustments / Filters ──────────────────────────────────────────────────
  const activeLayer = findInTree(layers, activeId)
  // Leaving mask editing if the active layer has no mask.
  useEffect(() => { if (!activeLayer?.mask?.enabled && editingMask) setEditingMask(false) }, [activeId, activeLayer?.mask?.enabled]) // eslint-disable-line react-hooks/exhaustive-deps
  const adjustDirty = !adjustIsZero(adjust) || adjInvert || adjGray

  // Capture / refresh the base snapshot for the active layer.
  function ensureAdjBase(): Uint8Array | null {
    const id = activeRef.current
    if (!id) return null
    if (adjBaseRef.current && adjBaseRef.current.id === id) return adjBaseRef.current.px
    const px = readTex(id)
    if (!px) return null
    adjBaseRef.current = { id, px }
    return px
  }

  // Reset adjustment UI + restore original pixels if a preview is live.
  function resetAdjust() {
    const base = adjBaseRef.current
    if (base) {
      // Restore original pixels (copy to avoid mutation of the snapshot)
      const px = new Uint8Array(base.px.length)
      px.set(base.px)
      writeTex(base.id, px)
    }
    adjBaseRef.current = null
    setAdjust(ADJUST_ZERO)
    setAdjInvert(false)
    setAdjGray(false)
  }

  // Commit the current preview as a real edit (undoable).
  function applyAdjust() {
    const id = activeRef.current
    if (!id) return
    const layer = findInTree(layersRef.current, id)
    if (!layer || layer.locked) return
    const base = adjBaseRef.current
    if (!base || base.id !== id) { resetAdjust(); return }
    if (!adjustDirty) { resetAdjust(); return }
    // pushUndo records the *current* (preview) pixels — restore base first so undo
    // captures the original, then write the final result.
    const result = applyAdjustments(base.px, adjust, adjInvert, adjGray)
    const orig = new Uint8Array(base.px.length); orig.set(base.px)
    writeTex(id, orig)          // texture back to original
    pushUndo()                  // snapshot original for undo
    writeTex(id, result)        // commit final
    adjBaseRef.current = null
    setAdjust(ADJUST_ZERO)
    setAdjInvert(false)
    setAdjGray(false)
  }

  // Live preview (debounced) whenever adjustment values change.
  useEffect(() => {
    const id = activeRef.current
    if (!id) return
    const layer = findInTree(layersRef.current, id)
    if (!layer || layer.locked) return
    if (!adjustDirty) {
      // restore base if we had one
      const base = adjBaseRef.current
      if (base && base.id === id) {
        const px = new Uint8Array(base.px.length); px.set(base.px)
        writeTex(id, px)
        adjBaseRef.current = null
      }
      return
    }
    const handle = setTimeout(() => {
      const base = ensureAdjBase()
      if (!base) return
      const out = applyAdjustments(base, adjust, adjInvert, adjGray)
      writeTex(id, out)
    }, 30)
    return () => clearTimeout(handle)
  }, [adjust, adjInvert, adjGray]) // eslint-disable-line react-hooks/exhaustive-deps

  // When the active layer changes, drop any pending preview (restore base).
  useEffect(() => {
    const base = adjBaseRef.current
    if (base && base.id !== activeId) {
      const px = new Uint8Array(base.px.length); px.set(base.px)
      writeTex(base.id, px)
      adjBaseRef.current = null
    }
    setAdjust(ADJUST_ZERO); setAdjInvert(false); setAdjGray(false)
  }, [activeId]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Filters: preview / apply / reset (mirror of adjustments) ────────────────
  const filterDirty = !filterIsZero(filter)
  function ensureFiltBase(): Uint8Array | null {
    const id = activeRef.current
    if (!id) return null
    if (filtBaseRef.current && filtBaseRef.current.id === id) return filtBaseRef.current.px
    const px = readTex(id); if (!px) return null
    filtBaseRef.current = { id, px }
    return px
  }
  function resetFilter() {
    const base = filtBaseRef.current
    if (base) { const px = new Uint8Array(base.px.length); px.set(base.px); writeTex(base.id, px) }
    filtBaseRef.current = null
    setFilter(FILTER_ZERO)
  }
  function applyFilter() {
    const id = activeRef.current; if (!id) return
    const layer = findInTree(layersRef.current, id)
    if (!layer || layer.locked) return
    const base = filtBaseRef.current
    if (!base || base.id !== id || !filterDirty) { resetFilter(); return }
    const { w, h } = docSize.current
    const result = applyFilters(base.px, w, h, filter)
    const orig = new Uint8Array(base.px.length); orig.set(base.px)
    writeTex(id, orig); pushUndo(); writeTex(id, result)
    filtBaseRef.current = null
    setFilter(FILTER_ZERO)
  }
  useEffect(() => {
    const id = activeRef.current; if (!id) return
    const layer = findInTree(layersRef.current, id)
    if (!layer || layer.locked) return
    if (!filterDirty) {
      const base = filtBaseRef.current
      if (base && base.id === id) { const px = new Uint8Array(base.px.length); px.set(base.px); writeTex(id, px); filtBaseRef.current = null }
      return
    }
    const handle = setTimeout(() => {
      const base = ensureFiltBase(); if (!base) return
      const { w, h } = docSize.current
      writeTex(id, applyFilters(base, w, h, filter))
    }, 60)
    return () => clearTimeout(handle)
  }, [filter]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const base = filtBaseRef.current
    if (base && base.id !== activeId) { const px = new Uint8Array(base.px.length); px.set(base.px); writeTex(base.id, px); filtBaseRef.current = null }
    setFilter(FILTER_ZERO)
  }, [activeId]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Screen ↔ Doc coords ───────────────────────────────────────────────────
  // Rotate a screen point about the viewport centre by `ang` radians.
  function rotAround(cx: number, cy: number, ang: number): [number, number] {
    if (!ang) return [cx, cy]
    const { w, h } = viewSizeRef.current
    const cvx = w / 2, cvy = h / 2
    const dx = cx - cvx, dy = cy - cvy
    const cs = Math.cos(ang), sn = Math.sin(ang)
    return [cvx + (dx * cs - dy * sn), cvy + (dx * sn + dy * cs)]
  }

  // Undo the viewport-centre rotation: maps a rotated screen point back to the
  // un-rotated ("base") screen space where pan/zoom are axis-aligned.
  function screenToBase(cx: number, cy: number): [number, number] {
    return rotAround(cx, cy, -rotRef.current)
  }

  function screenToDoc(cx: number, cy: number): [number, number] {
    const vs = vsRef.current
    const [bx, by] = screenToBase(cx, cy)
    return [Math.round((bx - vs.panX) / vs.zoom), Math.round((by - vs.panY) / vs.zoom)]
  }

  // Doc → screen px (forward of screenToDoc; applies pan/zoom then rotation).
  function docToScreen(dx: number, dy: number): [number, number] {
    const vs = vsRef.current, rot = rotRef.current
    const bx = vs.panX + dx * vs.zoom, by = vs.panY + dy * vs.zoom
    if (!rot) return [bx, by]
    const { w, h } = viewSizeRef.current
    const cvx = w / 2, cvy = h / 2
    const ex = bx - cvx, ey = by - cvy
    const cs = Math.cos(rot), sn = Math.sin(rot)
    return [cvx + (ex * cs - ey * sn), cvy + (ex * sn + ey * cs)]
  }

  // Zoom by `factor`, keeping the doc point under (cx,cy) screen px fixed (works
  // under rotation because the maths is done in un-rotated "base" screen space).
  function zoomAtPoint(cx: number, cy: number, factor: number) {
    setViewState(prev => {
      const nz = Math.min(20, Math.max(0.02, prev.zoom * factor))
      const [bx, by] = screenToBase(cx, cy)
      const k = nz / prev.zoom
      return { zoom: nz, panX: bx - (bx - prev.panX) * k, panY: by - (by - prev.panY) * k }
    })
  }
  // Set an absolute zoom while keeping the point under (cx,cy) fixed (scrubby zoom).
  function setZoomAt(cx: number, cy: number, newZoom: number) {
    setViewState(prev => {
      const nz = Math.min(20, Math.max(0.02, newZoom))
      const [bx, by] = screenToBase(cx, cy)
      const k = nz / prev.zoom
      return { zoom: nz, panX: bx - (bx - prev.panX) * k, panY: by - (by - prev.panY) * k }
    })
  }

  // ── Flood fill ────────────────────────────────────────────────────────────
  function floodFill(cx: number, cy: number) {
    const id = activeRef.current
    if (!id) return
    const px = readTex(id)
    if (!px) return
    pushUndo()

    const { w, h } = docSize.current
    const [sx, sy] = screenToDoc(cx, cy)
    if (sx < 0 || sx >= w || sy < 0 || sy >= h) return

    const idx = (x: number, y: number) => (y * w + x) * 4
    const ti   = idx(sx, sy)
    const tR=px[ti], tG=px[ti+1], tB=px[ti+2], tA=px[ti+3]
    const [fR, fG, fB] = hexToRgb(fgRef.current)
    const fA = Math.round(255 * boRef.current / 100)
    if (tR===fR && tG===fG && tB===fB && tA===fA) return

    const TOL = 25
    const match = (i: number) =>
      Math.abs(px[i]-tR)<=TOL && Math.abs(px[i+1]-tG)<=TOL &&
      Math.abs(px[i+2]-tB)<=TOL && Math.abs(px[i+3]-tA)<=TOL

    const sel = selMask.current
    const visited = new Uint8Array(w * h)
    const queue: number[] = [sx + sy * w]
    let head = 0

    while (head < queue.length) {
      const pos  = queue[head++]
      const x    = pos % w
      const y    = Math.floor(pos / w)
      if (visited[pos]) continue
      if (sel && !sel[pos]) continue   // confine fill to the active selection
      const i = pos * 4
      if (!match(i)) continue
      visited[pos] = 1
      px[i]=fR; px[i+1]=fG; px[i+2]=fB; px[i+3]=fA
      if (x+1 < w) queue.push(pos+1)
      if (x-1 >= 0) queue.push(pos-1)
      if (y+1 < h) queue.push(pos+w)
      if (y-1 >= 0) queue.push(pos-w)
    }

    writeTex(id, px)
  }

  // ── Selections (rectangle · ellipse · lasso · magic wand) ───────────────────
  function rebuildSelCanvas() {
    const m = selMask.current
    const { w, h } = docSize.current
    if (!m) { selCanvas.current = null; return }
    const cv = selCanvas.current ?? document.createElement('canvas')
    cv.width = w; cv.height = h
    const ctx = cv.getContext('2d')!
    const img = ctx.createImageData(w, h); const d = img.data
    for (let p = 0; p < m.length; p++) { if (m[p]) { const o=p*4; d[o]=90; d[o+1]=160; d[o+2]=255; d[o+3]=70 } }
    ctx.putImageData(img, 0, 0)
    selCanvas.current = cv
  }
  function setSelectionMask(mask: Uint8Array | null) {
    // empty mask → treat as no selection
    if (mask && !mask.some(v => v)) mask = null
    selMask.current = mask
    rebuildSelCanvas()
    setHasSel(!!mask)
    redrawOverlay()
  }
  function deselect() { setSelectionMask(null); setSelection(null) }

  function commitShapeSelection(rect: {x:number;y:number;w:number;h:number}, ellipse: boolean) {
    const { w, h } = docSize.current
    if (rect.w < 1 || rect.h < 1) { setSelection(null); return }
    const m = new Uint8Array(w*h)
    const x0=Math.max(0,Math.floor(rect.x)), y0=Math.max(0,Math.floor(rect.y))
    const x1=Math.min(w,Math.ceil(rect.x+rect.w)), y1=Math.min(h,Math.ceil(rect.y+rect.h))
    if (ellipse) {
      const cx=rect.x+rect.w/2, cy=rect.y+rect.h/2, rx=rect.w/2, ry=rect.h/2
      for (let y=y0;y<y1;y++) for (let x=x0;x<x1;x++){ const nx=(x+0.5-cx)/rx, ny=(y+0.5-cy)/ry; if(nx*nx+ny*ny<=1) m[y*w+x]=255 }
    } else {
      for (let y=y0;y<y1;y++) for (let x=x0;x<x1;x++) m[y*w+x]=255
    }
    setSelection(null)
    setSelectionMask(m)
  }
  function commitLasso(pts: {x:number;y:number}[]) {
    const { w, h } = docSize.current
    if (pts.length < 3) return
    const m = new Uint8Array(w*h)
    let minY=h, maxY=0; for (const p of pts){ minY=Math.min(minY,p.y); maxY=Math.max(maxY,p.y) }
    minY=Math.max(0,Math.floor(minY)); maxY=Math.min(h-1,Math.ceil(maxY))
    for (let y=minY;y<=maxY;y++){
      const xs:number[]=[]
      for (let i=0;i<pts.length;i++){ const a=pts[i], b=pts[(i+1)%pts.length]
        if ((a.y<=y && b.y>y) || (b.y<=y && a.y>y)){ const t=(y-a.y)/(b.y-a.y); xs.push(a.x+t*(b.x-a.x)) } }
      xs.sort((p,q)=>p-q)
      for (let k=0;k+1<xs.length;k+=2){ const xa=Math.max(0,Math.ceil(xs[k])), xb=Math.min(w-1,Math.floor(xs[k+1])); for(let x=xa;x<=xb;x++) m[y*w+x]=255 }
    }
    setSelectionMask(m)
  }
  function magicSelect(cx: number, cy: number) {
    const id = activeRef.current; if (!id) return
    const px = readTex(id); if (!px) return
    const { w, h } = docSize.current
    const [sx, sy] = screenToDoc(cx, cy)
    if (sx<0||sx>=w||sy<0||sy>=h) return
    const ti=(sy*w+sx)*4, tR=px[ti],tG=px[ti+1],tB=px[ti+2],tA=px[ti+3], TOL=32
    const m = new Uint8Array(w*h), vis = new Uint8Array(w*h)
    const q=[sx+sy*w]; let head=0
    while (head<q.length){ const pos=q[head++]; if(vis[pos])continue; const i=pos*4
      if(Math.abs(px[i]-tR)>TOL||Math.abs(px[i+1]-tG)>TOL||Math.abs(px[i+2]-tB)>TOL||Math.abs(px[i+3]-tA)>TOL) continue
      vis[pos]=1; m[pos]=255; const x=pos%w,y=(pos/w)|0
      if(x+1<w)q.push(pos+1); if(x-1>=0)q.push(pos-1); if(y+1<h)q.push(pos+w); if(y-1>=0)q.push(pos-w)
    }
    setSelectionMask(m)
  }

  // Draw the active selection (translucent tint) onto the overlay, view-transformed.
  function drawSelectionOverlay(ctx: CanvasRenderingContext2D) {
    const cv = selCanvas.current; if (!cv) return
    const vs = vsRef.current, rot = rotRef.current, { w, h } = viewSizeRef.current
    ctx.save()
    ctx.translate(w/2, h/2); ctx.rotate(rot); ctx.translate(-w/2, -h/2)
    ctx.translate(vs.panX, vs.panY); ctx.scale(vs.zoom, vs.zoom)
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(cv, 0, 0)
    ctx.restore()
  }
  function redrawOverlay() {
    const ov = overlayRef.current; if (!ov) return
    const ctx = ov.getContext('2d'); if (!ctx) return
    ctx.clearRect(0,0,ov.width,ov.height)
    drawSelectionOverlay(ctx)
    drawTransformOverlay(ctx)
  }

  // ── Free transform (move / scale / rotate the active layer) ─────────────────
  function xfPoint(dx: number, dy: number): [number,number] {
    const { tx,ty,scale,rot } = xf.current; const { w, h } = docSize.current
    const px=w/2, py=h/2, x=(dx-px)*scale, y=(dy-py)*scale, c=Math.cos(rot), s=Math.sin(rot)
    return [px+tx + x*c - y*s, py+ty + x*s + y*c]
  }
  function xfCornersScreen(): [number,number][] {
    const { w, h } = docSize.current
    return ([[0,0],[w,0],[w,h],[0,h]] as [number,number][]).map(([dx,dy]) => { const [x,y]=xfPoint(dx,dy); return docToScreen(x,y) })
  }
  function applyXf() {
    const id=activeRef.current, snap=xfSnap.current; if(!id||!snap) return
    const { w, h } = docSize.current
    const src=document.createElement('canvas'); src.width=w; src.height=h
    src.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(snap), w, h), 0, 0)
    const dst=document.createElement('canvas'); dst.width=w; dst.height=h
    const c=dst.getContext('2d')!
    const { tx,ty,scale,rot } = xf.current, px=w/2, py=h/2
    c.translate(px+tx, py+ty); c.rotate(rot); c.scale(scale,scale); c.translate(-px,-py)
    c.drawImage(src, 0, 0)
    writeTex(id, new Uint8Array(c.getImageData(0,0,w,h).data.buffer))
  }
  function enterTransform() {
    const id=activeRef.current; if(!id) return
    const lay=findInTree(layersRef.current, id)
    if(lay?.locked || lay?.lockPosition) return   // position locked → no move/transform
    const px=readTex(id); if(!px) return
    xfSnap.current=px; xf.current={tx:0,ty:0,scale:1,rot:0}; xfActive.current=true; redrawOverlay()
  }
  function commitTransform() {
    if(!xfActive.current) return
    const id=activeRef.current, snap=xfSnap.current
    if(id&&snap){ writeTex(id, new Uint8Array(snap)); pushUndo(); applyXf() }
    xfActive.current=false; xfSnap.current=null; xfDrag.current=null; redrawOverlay()
  }
  function cancelTransform() {
    if(!xfActive.current) return
    const id=activeRef.current, snap=xfSnap.current
    if(id&&snap) writeTex(id, new Uint8Array(snap))
    xfActive.current=false; xfSnap.current=null; xfDrag.current=null; redrawOverlay()
  }
  function drawTransformOverlay(ctx: CanvasRenderingContext2D) {
    if(!xfActive.current) return
    const cs=xfCornersScreen()
    ctx.strokeStyle='rgba(90,160,255,0.95)'; ctx.lineWidth=1.5; ctx.setLineDash([])
    ctx.beginPath(); cs.forEach((p,i)=>i?ctx.lineTo(p[0],p[1]):ctx.moveTo(p[0],p[1])); ctx.closePath(); ctx.stroke()
    ctx.fillStyle='#fff'; ctx.strokeStyle='#3a7bd5'
    for(const [x,y] of cs){ ctx.beginPath(); ctx.rect(x-4,y-4,8,8); ctx.fill(); ctx.stroke() }
  }

  // ── Eyedropper ────────────────────────────────────────────────────────────
  function pickColor(cx: number, cy: number) {
    const gl = glRef.current
    const fb = fbPair.current
    if (!gl || !fb) return
    const { w, h } = docSize.current
    const [dx, dy] = screenToDoc(cx, cy)
    if (dx < 0 || dx >= w || dy < 0 || dy >= h) return

    gl.bindFramebuffer(gl.FRAMEBUFFER, fb[lastSrc.current].fb)
    const px = new Uint8Array(4)
    // fb stores doc-top at row 0 (via VERT_COMP convention), so dy maps directly
    gl.readPixels(dx, dy, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    const picked = rgbToHex(px[0], px[1], px[2])
    setFgColor(picked); pushColorHistory(picked)
    setTool('brush')
  }

  // ── Export PNG ────────────────────────────────────────────────────────────
  function exportPng() {
    const gl = glRef.current
    const fb = fbPair.current
    if (!gl || !fb) return
    const { w, h } = docSize.current

    gl.bindFramebuffer(gl.FRAMEBUFFER, fb[lastSrc.current].fb)
    const raw = new Uint8Array(w * h * 4)
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)

    const c2 = document.createElement('canvas')
    c2.width = w; c2.height = h
    const ctx2 = c2.getContext('2d')!
    // readPixels reads from fb-bottom first; with VERT_COMP, fb-bottom = doc-top
    // so raw[0] = doc-top = Canvas2D row 0 → no flip needed
    const imgd = new ImageData(new Uint8ClampedArray(raw.buffer), w, h)
    ctx2.putImageData(imgd, 0, 0)
    const a = document.createElement('a')
    a.download = (doc?.title ?? 'export') + '.png'
    a.href = c2.toDataURL('image/png')
    a.click()
  }

  // Draw a downscaled snapshot of the composited document into the Navigator canvas.
  function drawNavThumb(canvas: HTMLCanvasElement) {
    const gl = glRef.current, fb = fbPair.current; if (!gl || !fb) return
    const { w, h } = docSize.current
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb[lastSrc.current].fb)
    const raw = new Uint8Array(w*h*4)
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    const tmp = document.createElement('canvas'); tmp.width = w; tmp.height = h
    tmp.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(raw.buffer), w, h), 0, 0)
    const ctx = canvas.getContext('2d')!; ctx.clearRect(0,0,canvas.width,canvas.height)
    ctx.imageSmoothingEnabled = true
    ctx.drawImage(tmp, 0, 0, canvas.width, canvas.height)
  }
  // Centre the view on a doc point (used by the Navigator). Rotation pivot = centre.
  function navCenter(docX: number, docY: number) {
    const { w, h } = viewSizeRef.current
    setViewState(prev => ({ ...prev, panX: w/2 - prev.zoom*docX, panY: h/2 - prev.zoom*docY }))
  }

  // Fit the document to the viewport and straighten any rotation.
  function fitToScreen() {
    const vp = viewportRef.current
    if (!vp) return
    const { width, height } = vp.getBoundingClientRect()
    const { w, h } = docSize.current
    const zoom = Math.max(0.05, Math.min(1.5, Math.min((width-60)/w, (height-60)/h)))
    setViewState({ zoom, panX:(width-w*zoom)/2, panY:(height-h*zoom)/2 })
    rotRef.current = 0; setViewRot(0)
  }

  // ── Brush cursor overlay ──────────────────────────────────────────────────
  function drawCursor(cx: number, cy: number) {
    const ov = overlayRef.current
    if (!ov) return
    const ctx = ov.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, ov.width, ov.height)
    drawSelectionOverlay(ctx)   // active pixel selection (always visible)
    // Lasso in-progress polyline (doc points → screen, plus the live cursor segment)
    if (lassoPts.current && lassoPts.current.length) {
      ctx.beginPath()
      lassoPts.current.forEach((p,i)=>{ const [sxp,syp]=docToScreen(p.x,p.y); if(i===0)ctx.moveTo(sxp,syp); else ctx.lineTo(sxp,syp) })
      ctx.lineTo(cx,cy)
      ctx.strokeStyle='rgba(90,160,255,0.95)'; ctx.lineWidth=1; ctx.setLineDash([4,3]); ctx.stroke(); ctx.setLineDash([])
    }

    const t = toolRef.current
    if (t === 'hand' || t === 'eyedrop' || t === 'zoom' || t === 'rotate') return

    if (t === 'brush' || t === 'eraser') {
      const r = Math.max(2, (bsRef.current / 2) * vsRef.current.zoom)
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI*2)
      ctx.strokeStyle = 'rgba(0,0,0,0.7)'; ctx.lineWidth = 1.5; ctx.stroke()
      ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 0.8; ctx.stroke()
      // Crosshair center
      ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 0.8
      ctx.beginPath(); ctx.moveTo(cx-4,cy); ctx.lineTo(cx+4,cy); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(cx,cy-4); ctx.lineTo(cx,cy+4); ctx.stroke()
    } else {
      // Simple crosshair for other tools
      ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(cx-8,cy); ctx.lineTo(cx+8,cy); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(cx,cy-8); ctx.lineTo(cx,cy+8); ctx.stroke()
    }

    // Draw selection rect if active (as a quad so it tracks canvas rotation).
    const sel = selection
    if (sel) {
      const c0 = docToScreen(sel.x, sel.y)
      const c1 = docToScreen(sel.x + sel.w, sel.y)
      const c2 = docToScreen(sel.x + sel.w, sel.y + sel.h)
      const c3 = docToScreen(sel.x, sel.y + sel.h)
      ctx.strokeStyle = 'rgba(100,180,255,0.9)'; ctx.lineWidth = 1
      ctx.setLineDash([5,3])
      ctx.beginPath()
      ctx.moveTo(c0[0], c0[1]); ctx.lineTo(c1[0], c1[1])
      ctx.lineTo(c2[0], c2[1]); ctx.lineTo(c3[0], c3[1]); ctx.closePath()
      ctx.stroke(); ctx.setLineDash([])
    }
  }

  function clearCursor() {
    const ov = overlayRef.current
    if (!ov) return
    ov.getContext('2d')?.clearRect(0, 0, ov.width, ov.height)
  }

  // ── StrokeTex helpers ─────────────────────────────────────────────────────

  function ensureStrokeTex(gl: WebGL2RenderingContext, w: number, h: number): WebGLTexture {
    if (!strokeTexRef.current) {
      const tex = gl.createTexture()!
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      strokeTexRef.current = tex
    }
    if (!strokeCanvasRef.current) {
      strokeCanvasRef.current = document.createElement('canvas')
    }
    const sc = strokeCanvasRef.current
    if (sc.width !== w || sc.height !== h) { sc.width = w; sc.height = h }
    return strokeTexRef.current
  }

  // Upload strokeCanvas pixels to strokeTex (no Y-flip: doc-top at t=0 matches VERT_COMP)
  function uploadStrokeTex(gl: WebGL2RenderingContext, w: number, h: number) {
    const sc = strokeCanvasRef.current
    const tex = strokeTexRef.current
    if (!sc || !tex) return
    const ctx = sc.getContext('2d')!
    const imgd = ctx.getImageData(0, 0, w, h)
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, imgd.data)
  }

  // Upload only the region of the stroke canvas touched since the last call, so a
  // brush dab costs an O(brush-size) readback/upload instead of the full document.
  function uploadStrokeDirty(gl: WebGL2RenderingContext) {
    const sc = strokeCanvasRef.current
    const tex = strokeTexRef.current
    if (!sc || !tex) return
    const { w, h } = docSize.current
    const d = strokeDirty.current
    strokeDirty.current = null
    if (!d) return
    const x0 = Math.max(0, Math.floor(d.x0)), y0 = Math.max(0, Math.floor(d.y0))
    const x1 = Math.min(w, Math.ceil(d.x1)),  y1 = Math.min(h, Math.ceil(d.y1))
    const ww = x1 - x0, hh = y1 - y0
    if (ww <= 0 || hh <= 0) return
    const ctx = sc.getContext('2d')!
    const imgd = ctx.getImageData(x0, y0, ww, hh) // RGBA → 4-byte aligned rows
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x0, y0, ww, hh, gl.RGBA, gl.UNSIGNED_BYTE, imgd.data)
  }

  // Coalesce all stamping done this frame into a single GPU upload + recomposite.
  function scheduleStrokeFlush() {
    if (strokeRaf.current != null) return
    strokeRaf.current = requestAnimationFrame(() => {
      strokeRaf.current = null
      const gl = glRef.current
      if (!gl) return
      uploadStrokeDirty(gl)
      renderComposite()
    })
  }

  // Multi-entry dab-sprite cache, keyed by quantized (radius, hardness, color). A
  // stylus varies the radius on every sample, so a single-entry cache would rebuild
  // the radial gradient for every dab — the Map keeps one sprite per radius bucket
  // and `drawImage` scales it to the exact size, so size variation stays smooth.
  const dabSpriteCache = useRef<Map<string, HTMLCanvasElement>>(new Map())

  function quantizeRadius(r: number): number {
    // Fine steps for small brushes, integer steps for large ones.
    return r < 8 ? Math.round(r * 2) / 2 : Math.round(r)
  }

  function getDabSprite(r: number, hardness: number, color: string, erase: boolean): HTMLCanvasElement {
    const qr = Math.max(0.5, quantizeRadius(r))
    const fill = erase ? '#ffffff' : color
    const key = `${qr}|${hardness}|${fill}`
    const cache = dabSpriteCache.current
    const hit = cache.get(key)
    if (hit) {
      // Mark as most-recently-used (Map keeps insertion order → re-insert moves it last).
      cache.delete(key); cache.set(key, hit)
      return hit
    }
    // LRU eviction: drop the least-recently-used entries instead of clearing the
    // whole cache, so a varied brush stroke doesn't repeatedly rebuild sprites.
    while (cache.size >= 320) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cache.delete(oldest)
    }

    const size = Math.max(1, Math.ceil(qr * 2))
    const cv = document.createElement('canvas')
    cv.width = size; cv.height = size
    const g = cv.getContext('2d')!
    const cx = size / 2, cy = size / 2
    const [cr, cg, cb] = hexToRgb(fill)
    const grad = g.createRadialGradient(cx, cy, 0, cx, cy, qr)
    // hardness 100 → solid almost to the edge (crisp); hardness 0 → fade from center.
    const solid = Math.min(0.98, hardness / 100)
    grad.addColorStop(0, `rgba(${cr},${cg},${cb},1)`)
    if (solid > 0) grad.addColorStop(solid, `rgba(${cr},${cg},${cb},1)`)
    // A mid stop softens the falloff so even hard brushes get a 1px anti-aliased edge.
    grad.addColorStop(Math.min(1, solid + (1 - solid) * 0.5), `rgba(${cr},${cg},${cb},0.55)`)
    grad.addColorStop(1, `rgba(${cr},${cg},${cb},0)`)
    g.fillStyle = grad
    g.beginPath(); g.arc(cx, cy, qr, 0, Math.PI * 2); g.fill()
    cache.set(key, cv)
    return cv
  }

  // Expand the dirty rectangle to cover a dab at (x,y) of the given radius.
  // Two rectangles are tracked: `strokeDirty` (consumed and reset every frame by
  // uploadStrokeDirty) and `strokeBBox` (the union over the *whole* stroke, reset
  // only when the stroke is committed) so the final merge can restrict its pixel
  // loop to the touched region instead of scanning the entire document.
  function markStrokeDirty(x: number, y: number, r: number) {
    const x0 = x - r - 1, y0 = y - r - 1, x1 = x + r + 1, y1 = y + r + 1
    const d = strokeDirty.current
    if (!d) { strokeDirty.current = { x0, y0, x1, y1 } }
    else {
      if (x0 < d.x0) d.x0 = x0
      if (y0 < d.y0) d.y0 = y0
      if (x1 > d.x1) d.x1 = x1
      if (y1 > d.y1) d.y1 = y1
    }
    const b = strokeBBox.current
    if (!b) { strokeBBox.current = { x0, y0, x1, y1 } }
    else {
      if (x0 < b.x0) b.x0 = x0
      if (y0 < b.y0) b.y0 = y0
      if (x1 > b.x1) b.x1 = x1
      if (y1 > b.y1) b.y1 = y1
    }
  }

  // Stamp one dab at (x,y) in doc space with the given radius & alpha.
  function stampDab(
    ctx: CanvasRenderingContext2D, bp: BrushPreset,
    x: number, y: number, radius: number, alpha: number, color: string, erase: boolean,
  ) {
    if (radius < 0.4 || alpha <= 0.002) return
    markStrokeDirty(x, y, radius)
    const sprite = getDabSprite(radius, bp.hardness, color, erase)
    ctx.globalAlpha = Math.min(1, alpha)
    const ellip = bp.roundness < 1 || bp.angle !== 0
    if (ellip) {
      ctx.save()
      ctx.translate(x, y)
      if (bp.angle) ctx.rotate(bp.angle * Math.PI / 180)
      ctx.scale(1, bp.roundness)
      ctx.drawImage(sprite, -radius, -radius, radius * 2, radius * 2)
      ctx.restore()
    } else {
      ctx.drawImage(sprite, x - radius, y - radius, radius * 2, radius * 2)
    }
  }

  // ── Dab/stamp stroke renderer ─────────────────────────────────────────────
  // Distributes soft dabs along the (already-smoothed) path at an interval of
  // `spacing × radius`, interpolating position and pressure between samples.
  // Flow controls per-dab alpha (accumulation); pressure can modulate size/alpha.
  // Stamp dabs onto the offscreen stroke canvas. With `clear`, the canvas and the
  // incremental cursor are reset (stroke start). Otherwise only the dabs for the
  // points added since the last call are stamped, so each pointermove costs
  // O(new points) rather than O(stroke length) — this is what keeps long, fast
  // stylus strokes smooth instead of getting heavier as the stroke grows.
  function stampStroke(erase: boolean, clear: boolean) {
    const sc = strokeCanvasRef.current
    if (!sc) return
    const pts = strokeDocPts.current
    const ctx = sc.getContext('2d')!
    if (clear) {
      ctx.clearRect(0, 0, sc.width, sc.height)
      dabCarry.current = 0
      dabSeed.current  = 0x2545f491
      lastDabIdx.current = -1
    }
    if (pts.length === 0) return
    ctx.globalCompositeOperation = 'source-over'

    const bp        = brushRef.current
    const color     = erase ? '#ffffff' : fgRef.current
    const baseRad   = Math.max(0.5, bsRef.current / 2)
    const strokeOpac= Math.min(1, boRef.current / 100)
    const flow      = bp.flow
    // PRNG state persists across stamps so jitter stays continuous along the stroke.
    const rnd = () => { const s = (dabSeed.current * 1103515245 + 12345) & 0x7fffffff; dabSeed.current = s; return s / 0x7fffffff }

    const radAt = (p: number) => {
      let r = baseRad
      if (bp.pressureSize) r *= (0.15 + 0.85 * p)
      // Apple-Pencil tilt: laying the stylus on its side broadens the dab, like
      // shading with the flat of a pencil. Zero for mouse/finger (no tilt).
      if (penTiltRef.current > 0.02) r *= (1 + penTiltRef.current * 0.9)
      if (bp.sizeJitter)   r *= (1 - bp.sizeJitter * rnd())
      return r
    }
    const alphaAt = (p: number) => {
      let a = flow * strokeOpac
      if (bp.pressureOpacity) a *= (0.1 + 0.9 * p)
      if (bp.opacityJitter)   a *= (1 - bp.opacityJitter * rnd())
      return a
    }
    const place = (x: number, y: number, p: number) => {
      const r = radAt(p)
      let ox = x, oy = y
      if (bp.scatter) {
        const ang = rnd() * Math.PI * 2
        const dist = rnd() * bp.scatter * r
        ox += Math.cos(ang) * dist; oy += Math.sin(ang) * dist
      }
      stampDab(ctx, bp, ox, oy, r, alphaAt(p), color, erase)
    }

    // First dab at the very start of the stroke.
    if (lastDabIdx.current < 0) { place(pts[0].x, pts[0].y, pts[0].p); lastDabIdx.current = 0 }

    // Walk only the segments added since the previous stamp, carrying the leftover
    // arc-length so dab spacing stays uniform across the join.
    for (let i = lastDabIdx.current + 1; i < pts.length; i++) {
      const a = pts[i-1], b = pts[i]
      const dx = b.x - a.x, dy = b.y - a.y
      const segLen = Math.hypot(dx, dy)
      if (segLen < 1e-4) continue
      const avgP    = (a.p + b.p) / 2
      const spacing = Math.max(0.5, bp.spacing * radAt(avgP) * 2) // step in px (radius→diameter scale)
      let dist = dabCarry.current
      while (dist < segLen) {
        if (dist >= 0) {
          const t = dist / segLen
          place(a.x + dx*t, a.y + dy*t, a.p + (b.p - a.p)*t)
        }
        dist += spacing
      }
      dabCarry.current = dist - segLen
    }
    lastDabIdx.current = pts.length - 1
  }

  // ── Input devices (mouse · finger · pen/Apple Pencil) ───────────────────────
  const penEverRef   = useRef(false)              // a real stylus has been seen this session
  const activePtrId  = useRef<number | null>(null) // the single pointer currently drawing
  // Velocity tracking to synthesise pressure for devices without it (finger/mouse).
  const velPrev      = useRef<{ x: number; y: number; t: number } | null>(null)
  const penTiltRef   = useRef(0)                  // latest Apple-Pencil tilt 0..1

  // Apple-Pencil-style tilt → 0 (upright) … 1 (laid flat). Broadens the dab for a
  // "shading with the side of the pencil" effect when the brush opts in.
  function tiltFactor(e: { tiltX?: number; tiltY?: number; altitudeAngle?: number }): number {
    if (typeof e.altitudeAngle === 'number') {
      // altitudeAngle: π/2 = perpendicular (upright), 0 = flat on the surface.
      return Math.max(0, Math.min(1, 1 - e.altitudeAngle / (Math.PI / 2)))
    }
    const tx = e.tiltX ?? 0, ty = e.tiltY ?? 0
    const tilt = Math.min(90, Math.hypot(tx, ty)) // 0..90°
    return Math.max(0, Math.min(1, tilt / 90))
  }

  // Pure pressure mapping for one sample — safe to call per coalesced event.
  // sx/sy are screen px, used only for the finger/mouse velocity fallback.
  function samplePressure(
    pointerType: string, rawPressure: number, sx: number, sy: number, now: number,
  ): number {
    if (pointerType === 'pen') {
      velPrev.current = null
      if (!pressureSensRef.current) return 1.0
      const raw = Math.max(0.05, Math.min(1.0, rawPressure || 0.5))
      // Soft curve (ease) for a more natural taper.
      return Math.max(0.05, Math.pow(raw, 0.85))
    }
    // Finger / mouse: no hardware pressure → synthesise from speed (fast = thin)
    // so strokes still taper. Disabled when pressure sensitivity is off.
    if (!pressureSensRef.current) { velPrev.current = null; return 1.0 }
    const prev = velPrev.current
    velPrev.current = { x: sx, y: sy, t: now }
    if (!prev) return 0.65 // gentle start
    const dist  = Math.hypot(sx - prev.x, sy - prev.y)
    const dt    = Math.max(1, now - prev.t)
    const speed = dist / dt // px per ms
    const target = Math.max(0.25, Math.min(1, 1 - speed * 0.18))
    // Ease toward the target so width changes smoothly, not abruptly.
    return inputPressureRef.current + (target - inputPressureRef.current) * 0.5
  }
  const inputPressureRef = useRef(0.65)

  // Update the on-screen device indicator — once per pointer event, not per
  // coalesced sample, to avoid a burst of React state updates.
  function reportInput(e: React.PointerEvent) {
    const kind = e.pointerType === 'pen' ? 'pen' : e.pointerType === 'touch' ? 'touch' : 'mouse'
    if (inputKindRef.current !== kind) { inputKindRef.current = kind; setInputKind(kind) }
    const p = kind === 'pen'
      ? Math.max(0.05, Math.min(1, e.pressure || 0.5))
      : inputPressureRef.current
    inputPressureRef.current = p
    setInputPressure(p)
  }
  const inputKindRef = useRef<'pen'|'touch'|'mouse'|null>(null)

  // Pressure for the initial pointerdown sample (also primes the indicator).
  function getEffectivePressure(e: React.PointerEvent): number {
    reportInput(e)
    velPrev.current = null
    penTiltRef.current = e.pointerType === 'pen' ? tiltFactor(e.nativeEvent as PointerEvent) : 0
    const now = (e.nativeEvent as PointerEvent).timeStamp || 0
    const rect = canvasRef.current?.getBoundingClientRect()
    const sx = e.clientX - (rect?.left ?? 0), sy = e.clientY - (rect?.top ?? 0)
    return samplePressure(e.pointerType, e.pressure, sx, sy, now)
  }

  function initBrushStroke(cx: number, cy: number, erase: boolean, pressure: number) {
    const gl = glRef.current
    if (!gl) return
    const id = activeRef.current
    if (!id) return
    const { w, h } = docSize.current
    ensureStrokeTex(gl, w, h)
    const [dx, dy] = screenToDoc(cx, cy)
    smoothPt.current = { x: dx, y: dy }
    rawPt.current    = { x: dx, y: dy }
    strokeDocPts.current = [{ x: dx, y: dy, p: pressure }]
    strokePreviewRef.current = { layerId: id, isErase: erase }
    stampStroke(erase, true)      // clear + first dab
    uploadStrokeDirty(gl)          // immediate upload for tap responsiveness
    renderComposite()
  }

  // ── Stroke stabilizer ──────────────────────────────────────────────────────
  // "Pulled-string" model: the brush trails the cursor on a string whose length
  // grows with the stabilizer setting. The brush only advances when the cursor is
  // farther away than that length, so jitter inside the slack is absorbed and the
  // resulting path is far smoother than a per-sample average — yet corners stay
  // crisp because the brush is pulled straight toward the cursor, never overshoots.
  // The length is expressed in *screen* pixels (converted to doc space via zoom)
  // so the lag feels identical at every zoom level. Returns the new brush point,
  // or null when the cursor is still within the slack (no dab needed).
  function stabilizeStep(rawX: number, rawY: number): { x: number; y: number } | null {
    rawPt.current = { x: rawX, y: rawY }
    const s = Math.max(0, Math.min(100, stabilizerRef.current)) / 100
    const b = smoothPt.current
    if (!b) { smoothPt.current = { x: rawX, y: rawY }; return { x: rawX, y: rawY } }
    if (s <= 0) { smoothPt.current = { x: rawX, y: rawY }; return { x: rawX, y: rawY } }
    // s² ramps gently at low settings; ~70px max lag on screen at 100%.
    const pull = (s * s * 70) / Math.max(vsRef.current.zoom, 0.01)
    const dx = rawX - b.x, dy = rawY - b.y
    const dist = Math.hypot(dx, dy)
    if (dist <= pull) return null            // cursor inside the slack → brush holds
    // Advance the brush so it sits exactly `pull` behind the cursor, eased a touch
    // (0.75) so a high setting also damps the residual motion for extra smoothness.
    const move = (dist - pull) * 0.75
    const nx = b.x + (dx / dist) * move
    const ny = b.y + (dy / dist) * move
    smoothPt.current = { x: nx, y: ny }
    return { x: nx, y: ny }
  }

  // At stroke end, walk the brush the rest of the way to the final cursor so the
  // line lands where the user lifted instead of stopping short of it (the classic
  // failing of a lagging stabilizer). Emits intermediate points via `push`.
  function stabilizerCatchUp(push: (x: number, y: number) => void) {
    const raw = rawPt.current, b = smoothPt.current
    if (!raw || !b) return
    const dx = raw.x - b.x, dy = raw.y - b.y
    const dist = Math.hypot(dx, dy)
    if (dist < 0.75) return
    const steps = Math.min(48, Math.max(1, Math.ceil(dist / 18)))
    for (let i = 1; i <= steps; i++) { const f = i / steps; push(b.x + dx * f, b.y + dy * f) }
    smoothPt.current = { x: raw.x, y: raw.y }
  }

  function extendBrushStroke(cx: number, cy: number, pressure: number) {
    const gl = glRef.current
    if (!gl || !strokePreviewRef.current) return
    const [dx, dy] = screenToDoc(cx, cy)
    const pt = stabilizeStep(dx, dy)
    if (!pt) return                          // within the string slack → nothing to draw yet
    strokeDocPts.current.push({ x: pt.x, y: pt.y, p: pressure })
    // Cheap: stamp only the new segment; the GPU upload + recomposite are batched
    // to one per animation frame, so many coalesced samples cost a single redraw.
    stampStroke(strokePreviewRef.current.isErase, false)
    scheduleStrokeFlush()
  }

  function mergeBrushStroke(erase: boolean) {
    const pts = strokeDocPts.current
    const id  = activeRef.current
    if (!erase) pushColorHistory(fgRef.current)   // record the colour actually painted with
    if (!id || pts.length === 0) { clearBrushStroke(); return }
    const activeLayer = findInTree(layersRef.current, id)
    if (!activeLayer || activeLayer.locked) { clearBrushStroke(); return }

    const sc = strokeCanvasRef.current
    if (!sc) { clearBrushStroke(); return }

    // Stabilizer catch-up: extend the lagging line to the final cursor position.
    const lastP = pts[pts.length - 1]?.p ?? 1
    stabilizerCatchUp((x, y) => strokeDocPts.current.push({ x, y, p: lastP }))
    // Cancel any pending frame and stamp whatever tail hasn't been stamped yet, so
    // the offscreen canvas holds the complete stroke before we read it back.
    if (strokeRaf.current != null) { cancelAnimationFrame(strokeRaf.current); strokeRaf.current = null }
    stampStroke(erase, false)

    const { w: docW, h: docH } = docSize.current
    const ctx = sc.getContext('2d')!
    // Canvas2D data is top-to-bottom; with VERT_COMP, textures store doc-top at t=0 → no Y-flip needed
    const rawStroke = ctx.getImageData(0, 0, docW, docH).data
    const strokeImg = new Uint8Array(rawStroke.buffer)

    const currentPx = readTex(id)
    const sel = selMask.current
    const lockA = !!activeLayer.lockAlpha   // lock transparent pixels → preserve alpha
    if (currentPx) {
      // Restrict the blend to the rectangle the stroke actually touched, so a small
      // dab on a large canvas costs O(brush-area) instead of O(document-area).
      const b = strokeBBox.current
      const bx0 = b ? Math.max(0, Math.floor(b.x0)) : 0
      const by0 = b ? Math.max(0, Math.floor(b.y0)) : 0
      const bx1 = b ? Math.min(docW, Math.ceil(b.x1)) : docW
      const by1 = b ? Math.min(docH, Math.ceil(b.y1)) : docH
      if (erase && !lockA) {   // transparency locked → erasing can't change alpha
        for (let y = by0; y < by1; y++) {
          for (let x = bx0; x < bx1; x++) {
            const i = (y * docW + x) << 2
            if (sel && !sel[i>>2]) continue
            const ea = strokeImg[i+3] / 255
            if (ea > 0) currentPx[i+3] = Math.max(0, currentPx[i+3] - Math.round(ea * 255))
          }
        }
      } else if (!erase) {
        for (let y = by0; y < by1; y++) {
          for (let x = bx0; x < bx1; x++) {
            const i = (y * docW + x) << 2
            if (sel && !sel[i>>2]) continue
            const sA = strokeImg[i+3] / 255
            if (sA < 0.001) continue
            const origA = currentPx[i+3]
            if (lockA && origA === 0) continue   // no painting onto transparent areas
            const sR = strokeImg[i], sG = strokeImg[i+1], sB = strokeImg[i+2]
            const dA = origA / 255
            const outA = sA + dA * (1 - sA)
            if (outA < 0.0001) { currentPx[i+3] = 0; continue }
            currentPx[i]   = Math.round((sR*sA + currentPx[i]  *dA*(1-sA))/outA)
            currentPx[i+1] = Math.round((sG*sA + currentPx[i+1]*dA*(1-sA))/outA)
            currentPx[i+2] = Math.round((sB*sA + currentPx[i+2]*dA*(1-sA))/outA)
            currentPx[i+3] = lockA ? origA : Math.round(outA * 255)   // keep alpha when locked
          }
        }
      }
      writeTex(id, currentPx)
    }
    clearBrushStroke()
  }

  function clearBrushStroke() {
    if (strokeRaf.current != null) { cancelAnimationFrame(strokeRaf.current); strokeRaf.current = null }
    strokeDocPts.current = []
    strokePreviewRef.current = null
    lastDabIdx.current = -1
    dabCarry.current   = 0
    strokeDirty.current = null
    strokeBBox.current  = null
    // Clear strokeTex to transparent so it doesn't appear in next renderComposite
    const gl  = glRef.current
    const tex = strokeTexRef.current
    const sc  = strokeCanvasRef.current
    if (gl && tex && sc) {
      const ctx = sc.getContext('2d')!
      ctx.clearRect(0, 0, sc.width, sc.height)
      uploadStrokeTex(gl, sc.width, sc.height)
    }
  }

  // ── Mask painting ───────────────────────────────────────────────────────────
  // Reuses the dab stamping (strokeCanvas) but blends the stroke's coverage onto
  // the mask texture each frame from a base snapshot, so overlapping dabs don't
  // over-accumulate. Brush hides (toward black), eraser reveals (toward white).
  function blendMaskPreview() {
    const sc = strokeCanvasRef.current, ms = maskStroke.current, mb = maskBase.current
    if (!sc || !ms || !mb) return
    const { w, h } = docSize.current
    const stroke = sc.getContext('2d')!.getImageData(0, 0, w, h).data
    const out = new Uint8Array(mb.length)
    for (let i = 0; i < mb.length; i += 4) {
      const a = stroke[i+3] / 255
      let v = mb[i]
      if (a > 0) v = ms.hide ? mb[i]*(1-a) : mb[i] + a*(255-mb[i])
      out[i] = out[i+1] = out[i+2] = v; out[i+3] = 255
    }
    writeTex(ms.maskId, out)
  }
  function initMaskStroke(cx: number, cy: number, erase: boolean, pressure: number) {
    const gl = glRef.current; if (!gl) return
    const id = activeRef.current; if (!id) return
    const { w, h } = docSize.current
    ensureStrokeTex(gl, w, h)
    const base = readTex(maskKey(id)); if (!base) return
    maskBase.current = base
    maskStroke.current = { maskId: maskKey(id), hide: !erase }
    const [dx, dy] = screenToDoc(cx, cy)
    smoothPt.current = { x: dx, y: dy }
    rawPt.current    = { x: dx, y: dy }
    strokeDocPts.current = [{ x: dx, y: dy, p: pressure }]
    stampStroke(false, true)  // stamp on strokeCanvas (color ignored; alpha = coverage)
    blendMaskPreview()
  }
  function extendMaskStroke(cx: number, cy: number, pressure: number) {
    if (!maskStroke.current) return
    const [dx, dy] = screenToDoc(cx, cy)
    const pt = stabilizeStep(dx, dy)
    if (!pt) return
    strokeDocPts.current.push({ x: pt.x, y: pt.y, p: pressure })
    stampStroke(false, false)
    blendMaskPreview()
  }
  function mergeMaskStroke() {
    const ms = maskStroke.current, mb = maskBase.current
    if (ms && mb) {
      // Stabilizer catch-up: complete the line to the final cursor before committing.
      const lastP = strokeDocPts.current[strokeDocPts.current.length - 1]?.p ?? 1
      stabilizerCatchUp((x, y) => strokeDocPts.current.push({ x, y, p: lastP }))
      stampStroke(false, false)
      const orig = new Uint8Array(mb.length); orig.set(mb)
      writeTex(ms.maskId, orig)   // restore base so undo captures the original mask
      pushUndo(ms.maskId)
      blendMaskPreview()          // commit final blended mask
    }
    clearMaskStroke()
  }
  function clearMaskStroke() {
    maskStroke.current = null; maskBase.current = null
    strokeDocPts.current = []; lastDabIdx.current = -1; dabCarry.current = 0; strokeDirty.current = null; strokeBBox.current = null
    const sc = strokeCanvasRef.current
    if (sc) sc.getContext('2d')!.clearRect(0, 0, sc.width, sc.height)
  }

  // Discard an in-progress stroke (e.g. a 2nd finger turned it into a gesture).
  // The layer texture is untouched until merge, so we also drop the undo snapshot
  // that initBrushStroke pushed so it doesn't leave a no-op undo step.
  function abortBrushStroke() {
    clearBrushStroke()
    if (isDrawing.current && undoStack.current.length) {
      undoStack.current.pop()
      setUndoCount(undoStack.current.length)
    }
    isDrawing.current = false
  }

  // ── Two-finger gestures (pinch-zoom · rotate · pan) ──────────────────────────
  function beginGesture() {
    abortBrushStroke()            // a finger may have started drawing first
    activePtrId.current = null
    const pts = [...touchPts.current.values()]
    if (pts.length < 2) return
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return
    const ax = pts[0].x - rect.left, ay = pts[0].y - rect.top
    const bx = pts[1].x - rect.left, by = pts[1].y - rect.top
    const midX = (ax + bx) / 2, midY = (ay + by) / 2
    const vs = vsRef.current
    const [bmx, bmy] = screenToBase(midX, midY)
    gesture.current = {
      startDist:  Math.max(1, Math.hypot(bx - ax, by - ay)),
      startAngle: Math.atan2(by - ay, bx - ax),
      startZoom:  vs.zoom,
      startRot:   rotRef.current,
      docMidX:    (bmx - vs.panX) / vs.zoom,
      docMidY:    (bmy - vs.panY) / vs.zoom,
    }
  }

  function updateGesture() {
    const g = gesture.current
    const pts = [...touchPts.current.values()]
    if (!g || pts.length < 2) return
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return
    const ax = pts[0].x - rect.left, ay = pts[0].y - rect.top
    const bx = pts[1].x - rect.left, by = pts[1].y - rect.top
    const dist = Math.max(1, Math.hypot(bx - ax, by - ay))
    const ang  = Math.atan2(by - ay, bx - ax)
    const midX = (ax + bx) / 2, midY = (ay + by) / 2

    const nz = Math.min(20, Math.max(0.02, g.startZoom * (dist / g.startDist)))
    const nr = g.startRot + (ang - g.startAngle)
    // Re-pan so the doc point under the fingers' midpoint stays anchored. Combined
    // with the centre rotation this reads as zoom+rotate about the midpoint.
    const [bmx, bmy] = rotAround(midX, midY, -nr)
    const panX = bmx - nz * g.docMidX
    const panY = bmy - nz * g.docMidY
    rotRef.current = nr
    setViewRot(nr)
    setViewState({ zoom: nz, panX, panY })
  }

  // ── Pointer handlers (mouse · finger/touch · pen/Apple Pencil) ───────────
  // Rasterise the in-progress text box onto the active raster layer (alpha over),
  // then close the editor. Called on commit (Ctrl/⌘+Enter, blur, or tool switch).
  function commitText() {
    const te = textEdit
    const val = textValue
    setTextEdit(null); setTextValue('')
    if (!te || !val.trim()) return
    const id = activeRef.current
    const layer = id ? findInTree(layersRef.current, id) : null
    if (!id || !layer || layer.locked || layer.children) return
    const { w, h } = docSize.current
    const c = document.createElement('canvas'); c.width = w; c.height = h
    const ctx = c.getContext('2d'); if (!ctx) return
    const fs = fontSize
    ctx.fillStyle = fgRef.current
    ctx.textBaseline = 'top'
    ctx.font = `${fs}px ${fontFamily}, sans-serif`
    const lh = fs * 1.25
    // The contentEditable box adds half-leading above the first glyph; mirror it
    // so the rasterised text lands where the user saw it.
    const pad = (lh - fs) / 2
    val.split('\n').forEach((line, i) => ctx.fillText(line, te.dx, te.dy + pad + i * lh))
    const textPx = new Uint8Array(ctx.getImageData(0, 0, w, h).data.buffer)

    pushUndo(id)
    const base = readTex(id)
    if (base) {
      for (let i = 0; i < base.length; i += 4) {
        const ta = textPx[i + 3] / 255
        if (ta <= 0) continue
        const dA = base[i + 3] / 255
        const outA = ta + dA * (1 - ta)
        if (outA < 0.0001) { base[i + 3] = 0; continue }
        base[i]     = Math.round((textPx[i]     * ta + base[i]     * dA * (1 - ta)) / outA)
        base[i + 1] = Math.round((textPx[i + 1] * ta + base[i + 1] * dA * (1 - ta)) / outA)
        base[i + 2] = Math.round((textPx[i + 2] * ta + base[i + 2] * dA * (1 - ta)) / outA)
        base[i + 3] = Math.round(outA * 255)
      }
      writeTex(id, base)
    }
  }

  function onPointerDown(e: React.PointerEvent) {
    // Track every touch contact; a second finger turns the interaction into a
    // pinch-zoom / rotate / pan gesture (and aborts any single-finger stroke).
    if (e.pointerType === 'touch') {
      touchPts.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (touchPts.current.size >= 2) { e.preventDefault(); beginGesture(); return }
    }

    // Zoom tool — handled before the left-button-only guard so right click works.
    // Click: left = in, right = out. Drag: up/right = in, down/left = out (scrubby).
    if (toolRef.current === 'zoom' && (e.button === 0 || e.button === 2)) {
      e.preventDefault()
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      const rect0 = canvasRef.current?.getBoundingClientRect()
      const zx = e.clientX - (rect0?.left ?? 0), zy = e.clientY - (rect0?.top ?? 0)
      zoomDrag.current = { x0:zx, y0:zy, startZoom:vsRef.current.zoom, button:e.button, moved:false }
      return
    }

    if (e.button !== 0) return
    // Only one pointer draws at a time — a second finger/palm landing mid-stroke
    // must not hijack the active pointer.
    if (activePtrId.current !== null) return

    if (e.pointerType === 'pen') penEverRef.current = true
    // Palm rejection: once a stylus has been used, ignore touch contacts (palm)
    // for drawing so the Apple Pencil stays in control.
    if (e.pointerType === 'touch' && penEverRef.current) return

    e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    activePtrId.current = e.pointerId
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return
    const cx = e.clientX - rect.left, cy = e.clientY - rect.top

    const t = toolRef.current
    if (t === 'hand') {
      dragPan.current = { sx: e.clientX, sy: e.clientY, px: vsRef.current.panX, py: vsRef.current.panY }
      return
    }
    if (t === 'rotate') {
      const { w, h } = viewSizeRef.current
      const startAngle = Math.atan2(cy - h / 2, cx - w / 2)
      dragRot.current = { startAngle, startRot: rotRef.current }
      return
    }
    if (t === 'text') {
      // Commit any open text box, then open a fresh one at the clicked doc point.
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
      activePtrId.current = null
      commitText()
      const [dx, dy] = screenToDoc(cx, cy)
      setTextEdit({ dx, dy }); setTextValue('')
      return
    }
    if (t === 'eyedrop') { pickColor(cx, cy); return }
    if (t === 'fill')    { pushUndo(); floodFill(cx, cy); return }
    if (t === 'magic')   { magicSelect(cx, cy); return }
    if (t === 'transform') {
      if (!xfActive.current) enterTransform()
      const [dxp,dyp] = screenToDoc(cx, cy)
      const cs = xfCornersScreen()
      let near = -1, nd = 14
      cs.forEach((p,i)=>{ const d=Math.hypot(p[0]-cx,p[1]-cy); if(d<nd){nd=d;near=i} })
      const { w, h } = docSize.current, pvx=w/2, pvy=h/2
      const mode: 'move'|'scale'|'rotate' = near>=0 ? 'scale' : (pointInQuad(cx,cy,cs) ? 'move' : 'rotate')
      xfDrag.current = { mode, downX:dxp, downY:dyp, start:{...xf.current},
                         startDist:Math.hypot(dxp-pvx,dyp-pvy)||1, startAng:Math.atan2(dyp-pvy,dxp-pvx) }
      return
    }
    if (t === 'lasso') {
      const [dx, dy] = screenToDoc(cx, cy)
      lassoPts.current = [{ x: dx, y: dy }]
      return
    }
    if (t === 'rect-sel' || t === 'ellipse-sel') {
      const [dx, dy] = screenToDoc(cx, cy)
      selStart.current = { x: dx, y: dy }
      setSelection({ x: dx, y: dy, w: 0, h: 0 })
      return
    }
    if (t === 'brush' || t === 'eraser') {
      const al = findInTree(layersRef.current, activeRef.current!)
      if (editingMask && al?.mask?.enabled) {
        isDrawing.current = true
        initMaskStroke(cx, cy, t === 'eraser', getEffectivePressure(e)) // undo handled on merge
      } else {
        pushUndo()
        isDrawing.current = true
        initBrushStroke(cx, cy, t === 'eraser', getEffectivePressure(e))
      }
    }
  }

  function onPointerMove(e: React.PointerEvent) {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return
    const cx = e.clientX - rect.left, cy = e.clientY - rect.top

    // Two-finger gesture takes priority over everything else.
    if (e.pointerType === 'touch' && touchPts.current.has(e.pointerId)) {
      touchPts.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (gesture.current && touchPts.current.size >= 2) { e.preventDefault(); updateGesture(); return }
    }

    drawCursor(cx, cy)

    // Rotate tool: angle dragged about the viewport centre, Shift snaps to 15°.
    if (dragRot.current) {
      const { w, h } = viewSizeRef.current
      const ang = Math.atan2(cy - h / 2, cx - w / 2)
      let rot = dragRot.current.startRot + (ang - dragRot.current.startAngle)
      if (e.shiftKey) { const step = Math.PI / 12; rot = Math.round(rot / step) * step }
      // Normalise to (-π, π]
      rot = ((rot + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI
      rotRef.current = rot
      setViewRot(rot)
      return
    }

    // Zoom tool scrubby drag: right/up → zoom in, left/down → zoom out
    if (zoomDrag.current) {
      const z = zoomDrag.current
      const delta = (cx - z.x0) + (z.y0 - cy)
      if (Math.abs(delta) > 4) z.moved = true
      setZoomAt(z.x0, z.y0, z.startZoom * Math.exp(delta * 0.01))
      return
    }

    // Pan is handled by global window listener
    if (dragPan.current) return

    if (xfDrag.current && toolRef.current === 'transform') {
      const [dxp,dyp] = screenToDoc(cx, cy)
      const d = xfDrag.current, { w, h } = docSize.current, pvx=w/2, pvy=h/2
      if (d.mode==='move')       xf.current = { ...d.start, tx:d.start.tx+(dxp-d.downX), ty:d.start.ty+(dyp-d.downY) }
      else if (d.mode==='scale') xf.current = { ...d.start, scale:Math.max(0.05, d.start.scale*(Math.hypot(dxp-pvx,dyp-pvy)/d.startDist)) }
      else                       xf.current = { ...d.start, rot:d.start.rot + (Math.atan2(dyp-pvy,dxp-pvx)-d.startAng) }
      applyXf(); redrawOverlay()
      return
    }
    if (selStart.current) {
      const [dx, dy] = screenToDoc(cx, cy)
      const sx = selStart.current.x, sy = selStart.current.y
      setSelection({ x: Math.min(sx,dx), y: Math.min(sy,dy), w: Math.abs(dx-sx), h: Math.abs(dy-sy) })
      return
    }
    if (lassoPts.current) {
      const [dx, dy] = screenToDoc(cx, cy)
      const last = lassoPts.current[lassoPts.current.length-1]
      if (!last || Math.hypot(dx-last.x, dy-last.y) > 2) lassoPts.current.push({ x: dx, y: dy })
      drawCursor(cx, cy)
      return
    }

    const t = toolRef.current
    if (isDrawing.current && e.pointerId === activePtrId.current && (t === 'brush' || t === 'eraser')) {
      e.preventDefault()
      // Stylus/touch devices fire at 120–240 Hz but the browser delivers one
      // pointermove per frame; getCoalescedEvents() recovers the dropped samples
      // so fast curves keep their shape instead of becoming straight chords.
      const ev = e.nativeEvent as PointerEvent
      const coalesced = typeof ev.getCoalescedEvents === 'function' ? ev.getCoalescedEvents() : []
      const samples = coalesced.length ? coalesced : [ev]
      for (const ce of samples) {
        const csx = ce.clientX - rect.left, csy = ce.clientY - rect.top
        penTiltRef.current = ce.pointerType === 'pen' ? tiltFactor(ce) : 0
        if (maskStroke.current) extendMaskStroke(csx, csy, samplePressure(ce.pointerType, ce.pressure, csx, csy, ce.timeStamp))
        else extendBrushStroke(csx, csy, samplePressure(ce.pointerType, ce.pressure, csx, csy, ce.timeStamp))
      }
      reportInput(e) // refresh the device indicator once for the whole batch
    }
  }

  function onPointerUp(e: React.PointerEvent) {
    // Zoom tool: a click without a real drag = single zoom step (in / out by button).
    if (zoomDrag.current) {
      const z = zoomDrag.current; zoomDrag.current = null
      if (!z.moved) zoomAtPoint(z.x0, z.y0, z.button === 2 ? 1/1.4 : 1.4)
      return
    }
    if (e.pointerType === 'touch') {
      touchPts.current.delete(e.pointerId)
      // End the gesture once fewer than two fingers remain. Any leftover finger
      // is left idle (it won't resume drawing) until it too lifts.
      if (touchPts.current.size < 2) gesture.current = null
    }
    if (gesture.current) return
    if (activePtrId.current !== null && e.pointerId !== activePtrId.current) return
    if (isDrawing.current) {
      const t = toolRef.current
      if (t === 'brush' || t === 'eraser') { if (maskStroke.current) mergeMaskStroke(); else mergeBrushStroke(t === 'eraser') }
    }
    // Commit pending selections
    if (selStart.current && selection) commitShapeSelection(selection, toolRef.current === 'ellipse-sel')
    if (lassoPts.current) { commitLasso(lassoPts.current); lassoPts.current = null }
    isDrawing.current = false
    dragPan.current   = null
    dragRot.current   = null
    xfDrag.current    = null
    selStart.current  = null
    activePtrId.current = null
    velPrev.current   = null
    penTiltRef.current = 0
  }

  function onWheel(e: React.WheelEvent) {
    e.preventDefault()
    const rect = canvasRef.current!.getBoundingClientRect()
    const mx = e.clientX - rect.left, my = e.clientY - rect.top

    if (e.ctrlKey || e.metaKey) {
      zoomAtPoint(mx, my, e.deltaY < 0 ? 1.12 : 0.9)
    } else {
      setViewState(prev => ({ ...prev, panX: prev.panX-e.deltaX, panY: prev.panY-e.deltaY }))
    }
  }

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement
          || (e.target instanceof HTMLElement && e.target.isContentEditable)) return
      // Layer-management combos take priority over single-key tool switches.
      const mod = e.ctrlKey || e.metaKey
      const k = e.key.toLowerCase()
      if (mod && !e.shiftKey && k === 'e') { e.preventDefault(); if (activeRef.current) mergeDown(activeRef.current); return }
      if (mod &&  e.shiftKey && k === 'e') { e.preventDefault(); flattenImage(); return }
      if (mod && !e.shiftKey && k === 'g') { e.preventDefault(); if (activeRef.current) groupLayer(activeRef.current); return }
      if (mod &&  e.shiftKey && k === 'g') { e.preventDefault(); if (activeRef.current) ungroupLayer(activeRef.current); return }
      if (e.key === 'Delete' && !mod && !xfActive.current && activeRef.current) {
        e.preventDefault(); deleteLayer(activeRef.current); return
      }
      if (e.key === 'b' || e.key === 'B') setTool('brush')
      if (e.key === 'e' || e.key === 'E') setTool('eraser')
      if (e.key === 'h' || e.key === 'H') setTool('hand')
      if (e.key === 'i' || e.key === 'I') setTool('eyedrop')
      if (e.key === 'g' || e.key === 'G') setTool('fill')
      if (e.key === 'v' || e.key === 'V') setTool('select')
      if (e.key === 'm' || e.key === 'M') setTool('rect-sel')
      if (e.key === 'l' || e.key === 'L') setTool('lasso')
      if (e.key === 'w' || e.key === 'W') setTool('magic')
      if ((e.ctrlKey||e.metaKey) && e.key==='d') { e.preventDefault(); deselect() }
      if (e.key === 'Enter' && xfActive.current)  { e.preventDefault(); commitTransform() }
      if (e.key === 'Escape' && xfActive.current) { e.preventDefault(); cancelTransform() }
      if (e.key === 't' || e.key === 'T') setTool('transform')
      if (e.key === 'z' || e.key === 'Z') setTool('zoom')
      if (e.key === 'r')                  setTool('rotate')
      if (e.key === 'R')                  { rotRef.current = 0; setViewRot(0) } // Shift+R resets
      if ((e.ctrlKey||e.metaKey) && !e.shiftKey && e.key==='z') { e.preventDefault(); undo() }
      if ((e.ctrlKey||e.metaKey) && (e.shiftKey && e.key==='z' || e.key==='y')) { e.preventDefault(); redo() }
      if ((e.ctrlKey||e.metaKey) && e.key==='0') {
        e.preventDefault()
        const vp = viewportRef.current
        if (!vp) return
        const { width, height } = vp.getBoundingClientRect()
        const { w, h } = docSize.current
        const zoom = Math.max(0.05, Math.min(1.5, Math.min((width-60)/w,(height-60)/h)))
        setViewState({ zoom, panX:(width-w*zoom)/2, panY:(height-h*zoom)/2 })
        rotRef.current = 0; setViewRot(0) // fit also straightens the canvas
      }
      if ((e.ctrlKey||e.metaKey) && (e.key==='=' || e.key==='+')) {
        e.preventDefault()
        setViewState(prev => {
          const nz = Math.min(20, prev.zoom * 1.2)
          const vp = viewportRef.current
          if (!vp) return { ...prev, zoom: nz }
          const { width, height } = vp.getBoundingClientRect()
          return { zoom: nz, panX: width/2-(width/2-prev.panX)*(nz/prev.zoom), panY: height/2-(height/2-prev.panY)*(nz/prev.zoom) }
        })
      }
      if ((e.ctrlKey||e.metaKey) && e.key==='-') {
        e.preventDefault()
        setViewState(prev => {
          const nz = Math.max(0.02, prev.zoom * 0.8)
          const vp = viewportRef.current
          if (!vp) return { ...prev, zoom: nz }
          const { width, height } = vp.getBoundingClientRect()
          return { zoom: nz, panX: width/2-(width/2-prev.panX)*(nz/prev.zoom), panY: height/2-(height/2-prev.panY)*(nz/prev.zoom) }
        })
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Layer management ──────────────────────────────────────────────────────
  // Keep the background ("Fond") pinned to the bottom of the root list.
  const pinBackground = (nodes: LayerStructureItem[]): LayerStructureItem[] => {
    const i = nodes.findIndex(n => n.name === 'Fond')
    if (i < 0 || i === nodes.length - 1) return nodes
    const n = [...nodes]; const [bg] = n.splice(i, 1); n.push(bg); return n
  }

  function addLayer() {
    const id = newId()
    const gl = glRef.current
    if (gl) createTex(gl, id, docSize.current.w, docSize.current.h)
    const newL: LayerStructureItem = {
      id, type: 'raster', name: `Calque ${leaves(layersRef.current).length + 1}`,
      visible: true, locked: false, opacity: 100, fill: 100, blendMode: 'normal',
      x: 0, y: 0, mask: null, effects: [],
    }
    // Insert above the active layer (lands in the same group); else at the top.
    setLayers(prev => pinBackground(insertNode(prev, newL, activeRef.current, false)))
    setActiveId(id)
  }

  function deleteLayer(id: string) {
    if (leaves(layersRef.current).length <= 1) return
    const node = findInTree(layersRef.current, id); if (!node) return
    setLayers(prev => {
      const { tree, removed } = removeFromTree(prev, id)
      if (!removed) return prev
      // Free GPU textures for every leaf (and mask) in the removed subtree.
      const gl = glRef.current
      if (gl) [removed, ...allNodes([removed])].forEach(n => {
        const tx = textures.current.get(n.id); if (tx) { gl.deleteTexture(tx); textures.current.delete(n.id) }
        const mx = textures.current.get(maskKey(n.id)); if (mx) { gl.deleteTexture(mx); textures.current.delete(maskKey(n.id)) }
      })
      if (activeRef.current === id || !findInTree(tree, activeRef.current ?? '')) setActiveId(leaves(tree)[0]?.id ?? tree[0]?.id ?? null)
      return tree
    })
  }

  function updateLayer(id: string, patch: Partial<LayerStructureItem>) {
    setLayers(prev => mapTree(prev, id, patch))
  }

  // Deep-clone a subtree: fresh ids + cloned colour/mask textures for every leaf.
  function cloneNode(node: LayerStructureItem): LayerStructureItem {
    const gl = glRef.current!
    const { w, h } = docSize.current
    const nid = newId()
    let mask = null as LayerStructureItem['mask']
    if (node.mask?.enabled) {
      createTex(gl, maskKey(nid), w, h, true)
      const mpx = readTex(maskKey(node.id)); if (mpx) writeTex(maskKey(nid), mpx)
      mask = { enabled: true, inverted: node.mask.inverted, layerId: nid }
    }
    if (node.children) return { ...node, id: nid, mask, children: node.children.map(cloneNode) }
    createTex(gl, nid, w, h)
    const px = readTex(node.id); if (px) writeTex(nid, px)
    return { ...node, id: nid, mask }
  }

  // Duplicate a layer/group just above the source, then select the copy.
  function duplicateLayer(id: string) {
    const src = findInTree(layersRef.current, id); if (!src || !glRef.current) return
    const copy = { ...cloneNode(src), name: `${src.name} ${t('layer_copy_suffix')}` }
    setLayers(prev => pinBackground(insertNode(prev, copy, id, false)))
    setActiveId(copy.id)
    renderComposite()
  }

  // Wrap a layer/group into a new group, in place.
  function groupLayer(id: string) {
    const node = findInTree(layersRef.current, id); if (!node || node.name === 'Fond') return
    const gid = newId()
    const nGroups = allNodes(layersRef.current).filter(n => n.children).length + 1
    setLayers(prev => {
      const wrap = (nodes: LayerStructureItem[]): LayerStructureItem[] => nodes.map(n => {
        if (n.id === id) return {
          id: gid, type: 'group', name: `${t('layer_group_name')} ${nGroups}`,
          visible: true, locked: false, opacity: 100, fill: 100, blendMode: 'normal',
          mask: null, effects: [], expanded: true, children: [n],
        }
        return n.children ? { ...n, children: wrap(n.children) } : n
      })
      return wrap(prev)
    })
    setActiveId(gid)
  }

  // Dissolve a group: splice its children into its parent, in place.
  function ungroupLayer(id: string) {
    const node = findInTree(layersRef.current, id); if (!node?.children) return
    setLayers(prev => {
      const splice = (nodes: LayerStructureItem[]): LayerStructureItem[] => {
        const out: LayerStructureItem[] = []
        for (const n of nodes) {
          if (n.id === id && n.children) out.push(...n.children)
          else out.push(n.children ? { ...n, children: splice(n.children) } : n)
        }
        return out
      }
      return pinBackground(splice(prev))
    })
    setActiveId(node.children[0]?.id ?? null)
  }

  function toggleClip(id: string) {
    const n = findInTree(layersRef.current, id); if (!n) return
    updateLayer(id, { clipping: !n.clipping })
  }

  function setLayerColor(id: string, colorLabel: string | undefined) {
    updateLayer(id, { colorLabel })
  }

  // Locate a node's parent list + index (render order: 0 = top of that list).
  function locate(tree: LayerStructureItem[], id: string): { list: LayerStructureItem[]; index: number } | null {
    for (let i = 0; i < tree.length; i++) {
      if (tree[i].id === id) return { list: tree, index: i }
      const ch = tree[i].children
      if (ch) { const r = locate(ch, id); if (r) return r }
    }
    return null
  }

  // A layer can merge down when the node directly below it (same list) is also a
  // raster leaf — the result is baked into that lower layer.
  function canMergeDown(id: string): boolean {
    const loc = locate(layersRef.current, id); if (!loc) return false
    const upper = loc.list[loc.index], lower = loc.list[loc.index + 1]
    return !!lower && !upper.children && !lower.children && upper.type === 'raster' && lower.type === 'raster'
  }

  // Read the full visible composite (all layers) back to CPU pixels.
  function readCompositePixels(): Uint8Array | null {
    renderComposite()
    const gl = glRef.current, fb = fbPair.current
    if (!gl || !fb) return null
    const { w, h } = docSize.current
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb[lastSrc.current].fb)
    const px = new Uint8Array(w * h * 4)
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    return px
  }

  // Flatten the whole document to a PNG data URL (used by embedded mode to report
  // the cel back to the host). Same top-to-bottom orientation as texToPng.
  function compositeToPng(): string {
    const px = readCompositePixels()
    const { w, h } = docSize.current
    const c = document.createElement('canvas'); c.width = w; c.height = h
    const ctx = c.getContext('2d'); if (!px || !ctx) return ''
    ctx.putImageData(new ImageData(new Uint8ClampedArray(px), w, h), 0, 0)
    return c.toDataURL('image/png')
  }

  // Composite two stacked raster layers in isolation and return the result pixels.
  function bakePair(lower: LayerStructureItem, upper: LayerStructureItem): Uint8Array | null {
    const gl = glRef.current, pc = progComp.current, vao = quadVAO.current
    const loTex = textures.current.get(lower.id), upTex = textures.current.get(upper.id)
    if (!gl || !pc || !vao || !loTex || !upTex) return null
    const { w, h } = docSize.current
    const A = glFB(gl, w, h), B = glFB(gl, w, h)
    gl.bindVertexArray(vao)
    gl.bindFramebuffer(gl.FRAMEBUFFER, A.fb); gl.viewport(0, 0, w, h)
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT)
    const loMask = lower.mask?.enabled ? (textures.current.get(maskKey(lower.id)) ?? null) : null
    const upMask = upper.mask?.enabled ? (textures.current.get(maskKey(upper.id)) ?? null) : null
    composeLayer(gl, pc, w, h, A.tex, loTex, B.fb, (lower.opacity / 100) * ((lower.fill ?? 100) / 100), BLEND_INT[lower.blendMode] ?? 0, loMask, null)
    composeLayer(gl, pc, w, h, B.tex, upTex, A.fb, (upper.opacity / 100) * ((upper.fill ?? 100) / 100), BLEND_INT[upper.blendMode] ?? 0, upMask, upper.clipping ? loTex : null)
    gl.bindFramebuffer(gl.FRAMEBUFFER, A.fb)
    const px = new Uint8Array(w * h * 4)
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.bindVertexArray(null)
    gl.deleteFramebuffer(A.fb); gl.deleteTexture(A.tex); gl.deleteFramebuffer(B.fb); gl.deleteTexture(B.tex)
    return px
  }

  // Merge a layer into the raster layer directly below it (bakes blend/opacity/mask
  // of both). The result keeps the lower layer's id/name/position, reset to normal.
  function mergeDown(id: string) {
    const gl = glRef.current
    if (!gl || !canMergeDown(id)) return
    const loc = locate(layersRef.current, id)!
    const upper = loc.list[loc.index], lower = loc.list[loc.index + 1]
    const px = bakePair(lower, upper); if (!px) return
    // Drop the upper layer's textures and the lower layer's (now-baked) mask.
    const freeTex = (k: string) => { const x = textures.current.get(k); if (x) { gl.deleteTexture(x); textures.current.delete(k) } }
    freeTex(upper.id); freeTex(maskKey(upper.id)); freeTex(maskKey(lower.id))
    setLayers(prev => {
      let tree = mapTree(prev, lower.id, { blendMode: 'normal', opacity: 100, fill: 100, mask: null, clipping: false })
      tree = removeFromTree(tree, upper.id).tree
      return pinBackground(tree)
    })
    setActiveId(lower.id)
    writeTex(lower.id, px)   // upload baked pixels + recomposite
  }

  // Flatten everything into a single opaque background layer.
  function flattenImage() {
    const gl = glRef.current; if (!gl) return
    if (allNodes(layersRef.current).length <= 1) return
    const px = readCompositePixels(); if (!px) return
    const { w, h } = docSize.current
    const id = newId(); createTex(gl, id, w, h)
    allNodes(layersRef.current).forEach(n => {
      const tx = textures.current.get(n.id); if (tx) { gl.deleteTexture(tx); textures.current.delete(n.id) }
      const mx = textures.current.get(maskKey(n.id)); if (mx) { gl.deleteTexture(mx); textures.current.delete(maskKey(n.id)) }
    })
    const flat: LayerStructureItem = {
      id, type: 'raster', name: 'Fond', visible: true, locked: false,
      opacity: 100, fill: 100, blendMode: 'normal', x: 0, y: 0, mask: null, effects: [],
    }
    setLayers([flat]); setActiveId(id)
    writeTex(id, px)
  }

  // Isolate a layer: hide everything except it and its ancestors. Clicking the same
  // layer's solo again restores the previous visibility of every node.
  const soloMemory = useRef<{ map: Map<string, boolean>; id: string } | null>(null)
  function soloLayer(id: string) {
    setLayers(prev => {
      const restore = (list: LayerStructureItem[], mem: Map<string, boolean>): LayerStructureItem[] =>
        list.map(n => n.children
          ? { ...n, visible: mem.get(n.id) ?? n.visible, children: restore(n.children, mem) }
          : { ...n, visible: mem.get(n.id) ?? n.visible })
      if (soloMemory.current && soloMemory.current.id === id) {
        const mem = soloMemory.current.map; soloMemory.current = null
        return restore(prev, mem)
      }
      // (re)isolate — snapshot original visibility only on the first solo.
      const map = soloMemory.current?.map ?? (() => { const m = new Map<string, boolean>(); allNodes(prev).forEach(n => m.set(n.id, n.visible)); return m })()
      const keep = new Set<string>()
      const findPath = (list: LayerStructureItem[], anc: string[]): boolean => {
        for (const n of list) {
          if (n.id === id) { anc.forEach(a => keep.add(a)); keep.add(n.id); return true }
          if (n.children && findPath(n.children, [...anc, n.id])) return true
        }
        return false
      }
      findPath(prev, [])
      soloMemory.current = { map, id }
      const apply = (list: LayerStructureItem[]): LayerStructureItem[] =>
        list.map(n => n.children
          ? { ...n, visible: keep.has(n.id), children: apply(n.children) }
          : { ...n, visible: keep.has(n.id) })
      return apply(prev)
    })
  }

  // Reorder: move `dragId` relative to `targetId` (sibling before/after, or into a
  // group). Blocks dropping a group into its own descendant; keeps "Fond" pinned.
  function reorderLayers(dragId: string, targetId: string, after: boolean, intoGroup = false) {
    if (dragId === targetId) return
    if (isDescendant(layersRef.current, dragId, targetId)) return
    setLayers(prev => {
      const { tree, removed } = removeFromTree(prev, dragId)
      if (!removed || removed.name === 'Fond') return prev
      return pinBackground(insertNode(tree, removed, targetId, after, intoGroup))
    })
    renderComposite()
  }

  // Paint a layer's real pixels (downscaled, over a transparency checkerboard)
  // into a small canvas for the Layers-panel thumbnail.
  function paintLayerThumb(canvas: HTMLCanvasElement, id: string) {
    const ctx = canvas.getContext('2d'); if (!ctx) return
    const cw = canvas.width, ch = canvas.height
    // Checkerboard background (transparency).
    const sq = 5
    for (let y = 0; y < ch; y += sq) for (let x = 0; x < cw; x += sq) {
      ctx.fillStyle = ((x / sq + y / sq) & 1) ? '#3a3a3a' : '#5a5a5a'
      ctx.fillRect(x, y, sq, sq)
    }
    const px = readTex(id); if (!px) return
    const { w, h } = docSize.current
    const tmp = document.createElement('canvas'); tmp.width = w; tmp.height = h
    tmp.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(px), w, h), 0, 0)
    const s = Math.min(cw / w, ch / h)
    const dw = w * s, dh = h * s, dx = (cw - dw) / 2, dy = (ch - dh) / 2
    ctx.imageSmoothingEnabled = true
    ctx.drawImage(tmp, dx, dy, dw, dh)
  }

  // ── Layer masks ─────────────────────────────────────────────────────────────
  function addMask(id: string) {
    const gl = glRef.current; if (!gl) return
    const { w, h } = docSize.current
    if (!textures.current.has(maskKey(id))) createTex(gl, maskKey(id), w, h, true) // all white = visible
    updateLayer(id, { mask: { enabled: true, inverted: false, layerId: id } })
    setEditingMask(true)
    renderComposite()
  }
  function removeMask(id: string) {
    const gl = glRef.current
    const tex = textures.current.get(maskKey(id))
    if (gl && tex) { gl.deleteTexture(tex); textures.current.delete(maskKey(id)) }
    updateLayer(id, { mask: null })
    if (activeRef.current === id) setEditingMask(false)
    renderComposite()
  }

  // ── Brush preset selection ────────────────────────────────────────────────
  function selectBrush(id: string) {
    const preset = BRUSH_PRESETS.find(b => b.id === id)
    if (!preset) return
    setBrushPreset(id)
    setTool('brush')
    // Preset supplies the "character"; we also seed hardness from the preset,
    // and the suggested size *only* if the user hasn't manually tuned it.
    setBrushHard(preset.hardness)
    if (!sizeTouched.current) setBrushSize(preset.defaultSize)
  }

  // Size setter that records a manual user override.
  function handleSetBrushSize(v: number) {
    sizeTouched.current = true
    setBrushSize(v)
  }

  const cursor =
    tool === 'hand'   ? 'grab'     :
    tool === 'zoom'   ? 'zoom-in'  :
    tool === 'rotate' ? 'grab'     : 'none'

  if (!docId && !embedded) return null
  if (webglError) {
    return (
      <div className="h-full flex items-center justify-center" style={{ background: C.bg }}>
        <div className="text-center max-w-sm p-6">
          <Layers size={32} style={{ color: C.accent }} className="mx-auto mb-3" />
          <p className="text-sm" style={{ color: C.textDim }}>{webglError}</p>
        </div>
      </div>
    )
  }

  // Dock panel registry consumed by <DockArea> (label + body for each panel id).
  const dockPanels = {
    navigator: { label: t('layer_panel_navigator'), render: () => (
      <Navigator docW={docSize.current.w} docH={docSize.current.h} refresh={drawNavThumb}
        screenToDoc={(cx,cy)=>{
          // Live transform from render-scope state (vsRef lags one render).
          const { w, h } = viewSizeRef.current
          let bx=cx, by=cy
          if (viewRot) {
            const cvx=w/2, cvy=h/2, dx=cx-cvx, dy=cy-cvy
            const cs=Math.cos(-viewRot), sn=Math.sin(-viewRot)
            bx=cvx+(dx*cs-dy*sn); by=cvy+(dx*sn+dy*cs)
          }
          return [(bx-viewState.panX)/viewState.zoom, (by-viewState.panY)/viewState.zoom]
        }} onCenter={navCenter}
        zoom={viewState.zoom} onZoom={(z)=>setZoomAt(viewSizeRef.current.w/2, viewSizeRef.current.h/2, z)}
        viewW={viewSizeRef.current.w} viewH={viewSizeRef.current.h} C={C} />
    ) },
    layers: { label: t('layer_panel_layers'), render: () => (
      <LayersPanel t={t} bare
        layers={layers} activeId={activeId} editLayerId={editLayerId} editName={editName}
        onSelect={setActiveId}
        onToggleVisible={id => updateLayer(id, { visible: !findInTree(layers, id)?.visible })}
        onToggleLock={id => updateLayer(id, { locked: !findInTree(layers, id)?.locked })}
        onDelete={deleteLayer} onAdd={addLayer}
        onOpacity={(id,v) => updateLayer(id, { opacity: v })}
        onBlend={(id,v) => updateLayer(id, { blendMode: v })}
        onStartRename={(id, name) => { setEditLayerId(id); setEditName(name) }}
        onCommitRename={name => { if(editLayerId) updateLayer(editLayerId, { name }); setEditLayerId(null) }}
        onCancelRename={() => setEditLayerId(null)}
        editingMask={editingMask} onAddMask={addMask} onRemoveMask={removeMask}
        onToggleEditMask={() => setEditingMask(v => !v)}
        onDuplicate={duplicateLayer} onReorder={reorderLayers} paintThumb={paintLayerThumb} thumbVersion={thumbNonce}
        onFill={(id,v) => updateLayer(id, { fill: v })}
        onToggleLockAlpha={id => updateLayer(id, { lockAlpha: !findInTree(layers, id)?.lockAlpha })}
        onToggleLockPosition={id => updateLayer(id, { lockPosition: !findInTree(layers, id)?.lockPosition })}
        onGroup={groupLayer} onUngroup={ungroupLayer} onToggleClip={toggleClip}
        onMergeDown={mergeDown} canMergeDown={canMergeDown} onFlatten={flattenImage}
        onSolo={soloLayer} onSetColor={setLayerColor}
        onToggleExpand={id => updateLayer(id, { expanded: !findInTree(layers, id)?.expanded })} />
    ) },
    brush: { label: t('layer_tab_brush'), render: () => (
      <ToolProps t={t} bare tool={tool}
        brushSize={brushSize} setBrushSize={handleSetBrushSize} brushHard={brushHard} setBrushHard={setBrushHard}
        brushOpac={brushOpac} setBrushOpac={setBrushOpac} pressureSens={pressureSens} setPressureSens={setPressureSens}
        stabilizer={stabilizer} setStabilizer={setStabilizer} inputKind={inputKind} inputPressure={inputPressure}
        brushPreset={brushPreset} onSelectBrush={selectBrush} brushSelOpen={brushSelOpen} setBrushSelOpen={setBrushSelOpen} />
    ) },
    adjust: { label: t('layer_panel_adjust'), render: () => (
      <AdjustmentsPanel t={t} bare adjust={adjust} setAdjust={setAdjust} invert={adjInvert} setInvert={setAdjInvert}
        gray={adjGray} setGray={setAdjGray} dirty={adjustDirty} canEdit={!!activeLayer && !activeLayer.locked}
        onApply={applyAdjust} onReset={resetAdjust} />
    ) },
    filters: { label: t('layer_panel_filters'), render: () => (
      <FiltersPanel t={t} bare filter={filter} setFilter={setFilter} dirty={filterDirty}
        canEdit={!!activeLayer && !activeLayer.locked} onApply={applyFilter} onReset={resetFilter} />
    ) },
  }

  // Embedded inside another editor → bare shell (WorkspaceShell can't be nested).
  const Shell = (embedded ? EmbedShell : EditorShell) as typeof EditorShell

  return (
    <Shell theme={C}
      chromeless
      topbarHeight={64}
      onBack={embedded ? () => { embed!.onCommit(compositeToPng()); embed!.onClose() } : () => { if(docId&&layers.length>0) saveMut.mutate(buildSaveStructure()); navigate('/paintsharp/layer') }}
      title={embedded ? (embed!.title ?? 'Frame') : titleDraft}
      onTitleChange={embedded ? undefined : setTitleDraft}
      onTitleCommit={embedded ? undefined : commitTitle}
      titlePlaceholder={t('common_untitled', { defaultValue: 'Sans titre' })}
      saveStatus={saveMut.isPending ? t('layer_saving') : t('doc_saved', { defaultValue: 'Enregistré' })}
      subtitle="Layer" docInfo={doc ? `${doc.width}×${doc.height}` : undefined}
      titleActions={embedded ? undefined : (
        <button
          onClick={() => starMut.mutate(!doc?.is_starred)}
          title={doc?.is_starred ? t('layer_unstar', { defaultValue: 'Retirer des favoris' }) : t('layer_star', { defaultValue: 'Ajouter aux favoris' })}
          className="p-1.5 rounded hover:bg-white/10 flex-shrink-0 transition-colors"
          style={{ color: doc?.is_starred ? '#f9ab00' : C.textDim }}>
          <Star size={15} fill={doc?.is_starred ? 'currentColor' : 'none'} />
        </button>
      )}
      onDelete={embedded ? undefined : () => trashMut.mutate()}
      deleteTitle={t('layer_move_to_trash', { defaultValue: 'Mettre à la corbeille' })}
      deleteConfirm={{
        title: t('layer_delete_confirm_title', { defaultValue: 'Supprimer ce document ?' }),
        message: t('layer_delete_confirm_msg', { defaultValue: 'Le document sera déplacé dans la corbeille.' }),
        confirmLabel: t('common_delete', { defaultValue: 'Supprimer' }),
        variant: 'danger',
      }}
      topbarActions={<>
        <button onClick={() => setPanelsHidden(v => !v)} title={t('layer_toggle_tabs')}
                className="p-1.5 rounded hover:bg-white/10"
                style={{ color: panelsHidden ? C.accent : C.textDim, background: panelsHidden ? C.accent+'22' : 'transparent' }}>
          <PanelRight size={14} />
        </button>
        <div style={{ width:1, height:20, background:C.border }} />
        <button onClick={undo} disabled={undoCount===0} title={t('layer_undo_title')} className="p-1.5 rounded hover:bg-white/10 disabled:opacity-30"><Undo2 size={14} style={{ color:C.textDim }} /></button>
        <button onClick={redo} disabled={redoCount===0} title={t('layer_redo_title')} className="p-1.5 rounded hover:bg-white/10 disabled:opacity-30"><Redo2 size={14} style={{ color:C.textDim }} /></button>
        <div style={{ width:1, height:20, background:C.border }} />
        <button onClick={exportPng} title={t('layer_export_png')} className="p-1.5 rounded hover:bg-white/10"><Download size={14} style={{ color:C.textDim }} /></button>
        <button onClick={() => { if(docId&&layers.length>0) saveMut.mutate(buildSaveStructure()) }} className="px-3 py-1 rounded text-xs" style={{ background:C.accent, color:'#fff' }}>{saveMut.isPending ? t('layer_saving') : t('common_save')}</button>
      </>}
      menus={paintsharpMenus(t, {
        onSave:   () => { if(docId&&layers.length>0) saveMut.mutate(buildSaveStructure()) },
        onExport: exportPng, exportLabel: t('menu_export_png'),
        onClose:  () => { if(docId&&layers.length>0) saveMut.mutate(buildSaveStructure()); navigate('/paintsharp/layer') },
        onUndo: undo, onRedo: redo, canUndo: undoCount>0, canRedo: redoCount>0,
        editExtra: [{ label: t('layer_deselect'), onClick: deselect, disabled: !hasSel, shortcut:'Ctrl+D' }],
        extraMenus: [
          { label: t('menu_image'), items: [{ label: t('layer_fit_screen'), onClick: fitToScreen }] },
          { label: t('menu_layer'), items: [
            { label: t('layer_new_layer'), onClick: addLayer },
            { label: t('layer_delete'),    onClick: () => activeId && deleteLayer(activeId), disabled: layers.length<=1 },
            'sep',
            { label: t('layer_mask_add'),  onClick: () => activeId && (activeLayer?.mask?.enabled ? removeMask(activeId) : addMask(activeId)) },
          ]},
          { label: t('menu_filter'), items: [
            { label: t('layer_filter_blur'),    onClick: () => { setPanelsHidden(false); dockApi.current?.activate('filters') } },
            { label: t('layer_filter_sharpen'), onClick: () => { setPanelsHidden(false); dockApi.current?.activate('filters') } },
            { label: t('layer_filter_noise'),   onClick: () => { setPanelsHidden(false); dockApi.current?.activate('filters') } },
          ]},
        ],
        onZoomIn:  () => zoomAtPoint((viewportRef.current?.clientWidth??600)/2, (viewportRef.current?.clientHeight??400)/2, 1.2),
        onZoomOut: () => zoomAtPoint((viewportRef.current?.clientWidth??600)/2, (viewportRef.current?.clientHeight??400)/2, 0.8),
        onFit:     fitToScreen,
        viewExtra: [{ label: t('layer_toggle_tabs'), onClick: () => setPanelsHidden(v => !v) }],
      })}
      optionsBar={<>
        <span style={{ color:C.text, minWidth:64 }}>{toolLabel(t, tool)}</span>
        <div style={{ width:1, height:15, background:C.border }} />
        {(tool==='brush' || tool==='eraser') ? (
          <>
            <OptNum label={t('layer_brush_size')}       value={brushSize}  min={1} max={500} suffix="px" onChange={handleSetBrushSize} C={C} />
            <OptNum label={t('layer_brush_hardness')}   value={brushHard}  min={0} max={100} suffix="%"  onChange={setBrushHard}        C={C} />
            <OptNum label={t('layer_brush_opacity')}    value={brushOpac}  min={0} max={100} suffix="%"  onChange={setBrushOpac}        C={C} />
            <OptNum label={t('layer_brush_stabilizer')} value={stabilizer} min={0} max={100} suffix="%"  onChange={setStabilizer}       C={C} />
            {(inputKind==='pen'||inputKind==='touch') && (
              <span className="flex items-center gap-1" style={{ color:C.accent }}>
                {inputKind==='pen' ? <PenTool size={11}/> : <Fingerprint size={11}/>}{Math.round(inputPressure*100)}%
              </span>
            )}
          </>
        ) : (tool==='text') ? (
          <>
            <Dropdown variant="dark" fontSize={11} value={fontFamily} onChange={setFontFamily}
                      options={FONT_FAMILIES.map(f => ({ value: f, label: f }))} />
            <OptNum label={t('layer_text_size')} value={fontSize} min={4} max={2000} suffix="px"
                    onChange={v => setFontSize(Math.max(4, v))} C={C} />
            <span style={{ color:C.textDim }}>{t('layer_text_hint')}</span>
          </>
        ) : (tool==='zoom' || tool==='rotate' || tool==='hand') ? (
          <span style={{ color:C.textDim }}>{Math.round(viewState.zoom*100)}% · {Math.round(viewRot*180/Math.PI)}°</span>
        ) : (
          <span style={{ color:C.textDim }}>{t('layer_adjust_hint')}</span>
        )}</>}
      toolRail={<>
          {([
            { id:'select',      icon:MousePointer2, label:t('layer_tool_select') },
            { id:'brush',       icon:Brush,         label:t('layer_tool_brush') },
            { id:'eraser',      icon:Eraser,        label:t('layer_tool_eraser') },
            { id:'fill',        icon:Square,        label:t('layer_tool_fill') },
            { id:'eyedrop',     icon:Pipette,       label:t('layer_tool_eyedrop') },
            { id:'crop',        icon:Crop,          label:t('layer_tool_crop') },
            { id:'text',        icon:Type,          label:t('layer_tool_text') },
            { id:'rect-sel',    icon:Square,        label:t('layer_tool_rect_sel') },
            { id:'ellipse-sel', icon:Circle,        label:t('layer_tool_ellipse_sel') },
            { id:'lasso',       icon:Lasso,         label:t('layer_tool_lasso') },
            { id:'magic',       icon:Wand,          label:t('layer_tool_magic') },
            { id:'transform',   icon:Move,          label:t('layer_tool_transform') },
            { id:'zoom',        icon:ZoomIn,        label:t('layer_tool_zoom') },
            { id:'rotate',      icon:RotateCcw,     label:t('layer_tool_rotate') },
            { id:'hand',        icon:Hand,          label:t('layer_tool_hand') },
          ] as {id:Tool; icon:React.ComponentType<{size?:number;style?:React.CSSProperties}>; label:string}[]).map(({ id, icon:Icon, label }) => (
            <button key={id} title={label} onClick={() => setTool(id)}
                    className="w-8 h-8 flex items-center justify-center transition-colors"
                    style={{ borderRadius:3, background:tool===id?C.active:'transparent', color:tool===id?'#fff':C.textDim }}>
              <Icon size={16} />
            </button>
          ))}

          <div style={{ flex:1 }} />

          {/* Indicateur du périphérique détecté (stylet / tactile) */}
          {(inputKind === 'pen' || inputKind === 'touch') && (
            <div className="flex flex-col items-center mb-1"
                 title={inputKind === 'pen' ? t('layer_pen_detected') : t('layer_touch_detected')}>
              {inputKind === 'pen'
                ? <PenTool size={13} style={{ color:C.accent }} />
                : <Fingerprint size={13} style={{ color:C.accent }} />}
              <span className="text-[8px] mt-0.5" style={{ color:C.accent }}>
                {Math.round(inputPressure*100)}
              </span>
            </div>
          )}

          {/* Couleur avant-plan */}
          <button onClick={() => setColorPickerOpen(v => !v)} title={t('layer_color_title')}
                  className="relative w-8 h-8 mb-1 flex items-center justify-center rounded hover:bg-white/10"
                  style={{ outline: colorPickerOpen ? `1px solid ${C.accent}` : 'none' }}>
            <div className="w-6 h-6 rounded border"
                 style={{ background:fgColor, borderColor:'#555' }} />
          </button>
          <span className="text-[9px] mb-1" style={{ color:C.textDim }}>
            {Math.round(viewState.zoom*100)}%
          </span></>}
      statusBar={<>
        <span>{t('layer_count', { count: layers.length })}</span>
        <span>{doc?.width}×{doc?.height}</span>
        <span>{doc?.color_mode?.toUpperCase()} · {doc?.dpi} DPI</span>
        <div className="flex-1" />
        {selection && <span>{t('layer_selection_size', { w: selection.w, h: selection.h })}</span>}
        {/* Rotation controls */}
        <div className="flex items-center gap-1">
          <button title={t('layer_rotate_ccw')}
                  onClick={() => { const r = viewRot - Math.PI/12; rotRef.current = r; setViewRot(r) }}
                  className="flex items-center justify-center rounded hover:bg-white/10" style={{ width:14, height:14 }}>
            <RotateCcw size={10} />
          </button>
          <button title={t('layer_rotate_reset')}
                  onClick={() => { rotRef.current = 0; setViewRot(0) }}
                  className="w-9 text-center rounded hover:bg-white/10"
                  style={{ color: Math.abs(viewRot) > 1e-3 ? C.accent : C.textDim }}>
            {Math.round(viewRot * 180 / Math.PI)}°
          </button>
          <button title={t('layer_rotate_cw')}
                  onClick={() => { const r = viewRot + Math.PI/12; rotRef.current = r; setViewRot(r) }}
                  className="flex items-center justify-center rounded hover:bg-white/10"
                  style={{ width:14, height:14, transform:'scaleX(-1)' }}>
            <RotateCcw size={10} />
          </button>
        </div>
        <div style={{ width:1, height:12, background:C.border }} />
        {/* Zoom controls */}
        <div className="flex items-center gap-1">
          <button title={t('layer_zoom_out')}
                  onClick={() => setViewState(prev => {
                    const nz = Math.max(0.02, prev.zoom * 0.8)
                    const vp = viewportRef.current
                    if (!vp) return { ...prev, zoom: nz }
                    const { width, height } = vp.getBoundingClientRect()
                    return { zoom: nz, panX: width/2-(width/2-prev.panX)*(nz/prev.zoom), panY: height/2-(height/2-prev.panY)*(nz/prev.zoom) }
                  })}
                  className="flex items-center justify-center rounded hover:bg-white/10" style={{ width:14, height:14 }}>
            <ZoomOut size={10} />
          </button>
          <span className="w-9 text-center">{Math.round(viewState.zoom*100)}%</span>
          <button title={t('layer_zoom_in')}
                  onClick={() => setViewState(prev => {
                    const nz = Math.min(20, prev.zoom * 1.2)
                    const vp = viewportRef.current
                    if (!vp) return { ...prev, zoom: nz }
                    const { width, height } = vp.getBoundingClientRect()
                    return { zoom: nz, panX: width/2-(width/2-prev.panX)*(nz/prev.zoom), panY: height/2-(height/2-prev.panY)*(nz/prev.zoom) }
                  })}
                  className="flex items-center justify-center rounded hover:bg-white/10" style={{ width:14, height:14 }}>
            <ZoomIn size={10} />
          </button>
          <button title={t('layer_fit_screen')}
                  onClick={() => {
                    const vp = viewportRef.current
                    if (!vp) return
                    const { width, height } = vp.getBoundingClientRect()
                    const { w, h } = docSize.current
                    const zoom = Math.max(0.05, Math.min(1.5, Math.min((width-60)/w,(height-60)/h)))
                    setViewState({ zoom, panX:(width-w*zoom)/2, panY:(height-h*zoom)/2 })
                    rotRef.current = 0; setViewRot(0)
                  }}
                  className="px-1 rounded hover:bg-white/10" style={{ fontSize:8 }}>
            {t('layer_fit_short')}
          </button>
        </div></>}>
        <DockArea
          className="flex flex-1 min-w-0" style={{ order:2 }}
          viewportRef={viewportRef} viewportBg="#141414"
          storageKey="kubuno:paintsharp:dockLayout" hidden={panelsHidden}
          moveTitle={t('layer_dock_move')} controllerRef={dockApi}
          defaultArrangement={{ right: [['navigator'],['layers'],['brush','adjust','filters']] }}
          panels={dockPanels}>
          <canvas ref={canvasRef}
                  className="absolute inset-0 w-full h-full"
                  style={{ cursor, touchAction: 'none',
                           userSelect: 'none', WebkitUserSelect: 'none',
                           WebkitTouchCallout: 'none' } as React.CSSProperties}
                  onPointerDown={onPointerDown}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onPointerCancel={onPointerUp}
                  onPointerLeave={clearCursor}
                  onContextMenu={e => { if (tool === 'zoom') e.preventDefault() }}
                  onWheel={onWheel} />
          <canvas ref={overlayRef}
                  className="absolute inset-0 w-full h-full pointer-events-none" />
          {textEdit && (() => {
            const [sx, sy] = docToScreen(textEdit.dx, textEdit.dy)
            const z = viewState.zoom
            return (
              <div ref={textBoxRef} contentEditable suppressContentEditableWarning
                   onInput={e => setTextValue((e.target as HTMLDivElement).innerText)}
                   onPointerDown={e => e.stopPropagation()}
                   onKeyDown={e => {
                     e.stopPropagation() // don't trigger global tool shortcuts while typing
                     if (e.key === 'Escape') { e.preventDefault(); setTextEdit(null); setTextValue('') }
                     else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commitText() }
                   }}
                   onBlur={commitText}
                   className="absolute z-30 outline-none"
                   style={{ left: sx, top: sy, color: fgColor, fontFamily,
                            fontSize: fontSize * z, lineHeight: 1.25, whiteSpace: 'pre',
                            border: `1px dashed ${C.accent}`, padding: '0 1px', minWidth: 4,
                            cursor: 'text', caretColor: fgColor,
                            transform: viewRot ? `rotate(${viewRot}rad)` : undefined,
                            transformOrigin: 'top left' }} />
            )
          })()}
          {colorPickerOpen && (
            <div className="absolute left-2 bottom-2 z-20">
              <ColorPicker t={t} color={fgColor} onChange={setFgColor}
                onClose={() => { pushColorHistory(fgColor); setColorPickerOpen(false) }}
                history={colorHistory} onPickHistory={setFgColor} C={C} />
            </div>
          )}
        </DockArea>
    </Shell>
  )
}
// ── Layers panel ──────────────────────────────────────────────────────────────
// MenuItem/MenuBar/Navigator/OptNum live in ui/ (imported above).

// Live layer thumbnail: redraws the layer's real pixels whenever `version` bumps
// (driven by texture writes / structural changes — no polling). Raster only;
// other kinds use a glyph supplied by the parent.
function LayerThumb({ paint, id, version }: { paint: (c: HTMLCanvasElement, id: string) => void; id: string; version: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => { const c = ref.current; if (c) paint(c, id) }, [version, id, paint])
  return <canvas ref={ref} width={44} height={32}
                 style={{ width:34, height:25, imageRendering:'auto', display:'block' }} />
}

// Glyph thumbnail for non-raster kinds (text, adjustment, group).
function KindThumb({ kind }: { kind: string }) {
  const Icon = kind === 'text' ? Type : kind === 'adjustment' ? SlidersHorizontal : kind === 'group' ? FolderClosed : Layers
  return (
    <div className="rounded flex items-center justify-center"
         style={{ width:34, height:25, background:'#2a2a2a', border:'1px solid #3a3a3a' }}>
      <Icon size={13} style={{ color:'#9a9a9a' }} />
    </div>
  )
}

function LayersPanel({
  t,
  layers, activeId, editLayerId, editName,
  onSelect, onToggleVisible, onToggleLock, onDelete, onAdd,
  onOpacity, onBlend, onStartRename, onCommitRename, onCancelRename,
  editingMask, onAddMask, onRemoveMask, onToggleEditMask,
  onDuplicate, onReorder, paintThumb, thumbVersion,
  onFill, onToggleLockAlpha, onToggleLockPosition, onGroup, onUngroup, onToggleClip, onToggleExpand,
  onMergeDown, canMergeDown, onFlatten, onSolo, onSetColor, bare,
}: {
  t: TFunction
  layers: LayerStructureItem[]
  activeId: string | null
  editLayerId: string | null
  editName: string
  onSelect: (id: string) => void
  onToggleVisible: (id: string) => void
  onToggleLock: (id: string) => void
  onDelete: (id: string) => void
  onAdd: () => void
  onOpacity: (id: string, v: number) => void
  onBlend: (id: string, v: string) => void
  onStartRename: (id: string, name: string) => void
  onCommitRename: (name: string) => void
  onCancelRename: () => void
  editingMask: boolean
  onAddMask: (id: string) => void
  onRemoveMask: (id: string) => void
  onToggleEditMask: (id: string) => void
  onDuplicate: (id: string) => void
  onReorder: (dragId: string, targetId: string, after: boolean, intoGroup?: boolean) => void
  paintThumb: (c: HTMLCanvasElement, id: string) => void
  thumbVersion: number
  onFill: (id: string, v: number) => void
  onToggleLockAlpha: (id: string) => void
  onToggleLockPosition: (id: string) => void
  onGroup: (id: string) => void
  onUngroup: (id: string) => void
  onToggleClip: (id: string) => void
  onToggleExpand: (id: string) => void
  onMergeDown: (id: string) => void
  canMergeDown: (id: string) => boolean
  onFlatten: () => void
  onSolo: (id: string) => void
  onSetColor: (id: string, color: string | undefined) => void
  bare?: boolean
}) {
  const C2 = C
  const [open, setOpen] = useState(true)
  const isOpen = bare || open
  const [filter, setFilter] = useState('')
  // Drag-and-drop reorder. dragIdRef is synchronous (drag events fire faster
  // than React commits state); dragId/drop states drive only the visuals.
  const dragIdRef = useRef<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [drop, setDrop] = useState<{ id: string; mode: 'before'|'after'|'into' } | null>(null)
  const clearDrag = () => { dragIdRef.current = null; setDragId(null); setDrop(null) }

  const q = filter.trim().toLowerCase()
  const isBg = (l: LayerStructureItem) => l.name === 'Fond'
  const leafCount = leaves(layers).length
  const active = findInTree(layers, activeId)
  const ctx = useContextMenu()

  // Floating right-click menu for a layer/group row.
  const openRowMenu = (e: React.MouseEvent, layer: LayerStructureItem) => {
    onSelect(layer.id)
    const isGroup = !!layer.children
    const items: CtxItem[] = [
      { label: t('layer_duplicate'), onClick: () => onDuplicate(layer.id), shortcut: 'Ctrl+J' },
      { label: t('layer_rename'),    onClick: () => onStartRename(layer.id, layer.name) },
      'sep',
      { label: layer.visible ? t('layer_hide') : t('layer_show'), onClick: () => onToggleVisible(layer.id) },
      { label: t('layer_solo'), onClick: () => onSolo(layer.id) },
      { label: layer.locked ? t('layer_unlock_all') : t('layer_lock_all'), onClick: () => onToggleLock(layer.id) },
      'sep',
      isGroup
        ? { label: t('layer_ungroup'), onClick: () => onUngroup(layer.id), shortcut: 'Ctrl+Shift+G' }
        : { label: t('layer_group'),   onClick: () => onGroup(layer.id), shortcut: 'Ctrl+G' },
      ...(!isGroup ? [{ label: t('layer_merge_down'), onClick: () => onMergeDown(layer.id), disabled: !canMergeDown(layer.id), shortcut: 'Ctrl+E' } as CtxItem] : []),
      { label: t('layer_flatten'), onClick: onFlatten, shortcut: 'Ctrl+Shift+E' },
      ...(!isGroup ? [(layer.mask?.enabled
        ? { label: t('layer_mask_remove'), onClick: () => onRemoveMask(layer.id) }
        : { label: t('layer_mask_add'),    onClick: () => onAddMask(layer.id) }) as CtxItem] : []),
      ...(!isGroup ? [{ label: t('layer_clip'), onClick: () => onToggleClip(layer.id) } as CtxItem] : []),
      'sep',
      // Colour tags.
      ...LAYER_COLORS.map(c => ({
        label: `${c.dot} ${t(c.key)}`, onClick: () => onSetColor(layer.id, c.value),
      } as CtxItem)),
      { label: t('layer_color_none'), onClick: () => onSetColor(layer.id, undefined), disabled: !layer.colorLabel },
      'sep',
      { label: t('layer_delete'), onClick: () => onDelete(layer.id), danger: true, disabled: leafCount <= 1, shortcut: 'Suppr' },
    ]
    ctx.open(e, items)
  }

  // One layer/group row (recursive for groups).
  const renderNode = (layer: LayerStructureItem, depth: number): React.ReactNode => {
    const isActive = layer.id === activeId
    const isEditing = layer.id === editLayerId
    const bg = isBg(layer)
    const isGroup = !!layer.children
    const dropHere = drop?.id === layer.id ? drop.mode : null
    const indent = 4 + depth * 13
    const row = (
      <div key={layer.id}
           draggable={!bg && !q}
           onDragStart={e => { dragIdRef.current = layer.id; setDragId(layer.id)
             e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', layer.id); e.stopPropagation() }}
           onDragOver={e => { const dg = dragIdRef.current; if (!dg || dg === layer.id) return; e.preventDefault()
             const r = e.currentTarget.getBoundingClientRect(); const f = (e.clientY - r.top) / r.height
             const mode = isGroup && f > 0.3 && f < 0.7 ? 'into' : f > 0.5 ? 'after' : 'before'
             setDrop({ id: layer.id, mode }) }}
           onDragLeave={() => setDrop(d => d?.id === layer.id ? null : d)}
           onDrop={e => { e.preventDefault(); e.stopPropagation()
             const dg = e.dataTransfer.getData('text/plain') || dragIdRef.current
             if (dg && dg !== layer.id) {
               const r = e.currentTarget.getBoundingClientRect(); const f = (e.clientY - r.top) / r.height
               const mode = isGroup && f > 0.3 && f < 0.7 ? 'into' : f > 0.5 ? 'after' : 'before'
               onReorder(dg, layer.id, mode === 'after', mode === 'into')
             }
             clearDrag() }}
           onDragEnd={clearDrag}
           onClick={() => onSelect(layer.id)}
           onContextMenu={e => openRowMenu(e, layer)}
           className="cursor-pointer group relative"
           style={{ borderBottom:`1px solid ${C2.border}`,
                    borderTop: dropHere === 'before' ? `2px solid ${C2.accent}` : '2px solid transparent',
                    boxShadow: dropHere === 'after' ? `inset 0 -2px 0 ${C2.accent}` : undefined,
                    borderLeft:`2px solid ${isActive?C2.accent:'transparent'}`,
                    background: dropHere === 'into' ? C2.accent+'33' : isActive ? C2.accent+'18' : isGroup ? '#ffffff08' : 'transparent' }}>
        {/* Colour tag strip (right edge) */}
        {layer.colorLabel && <div className="absolute right-0 top-0 bottom-0 pointer-events-none" style={{ width: 3, background: layer.colorLabel }} />}
        {/* Row 1 */}
        <div className="flex items-center gap-1 pr-2 pt-1.5 pb-0.5" style={{ paddingLeft: indent, opacity: dragId === layer.id ? 0.4 : 1 }}>
          <GripVertical size={11} className="opacity-0 group-hover:opacity-40 flex-shrink-0" style={{ color:C2.textDim, cursor:'grab' }} />
          <button onClick={e=>{e.stopPropagation(); e.altKey ? onSolo(layer.id) : onToggleVisible(layer.id)}}
                  title={t('layer_solo_hint')} className="flex-shrink-0">
            {layer.visible ? <Eye size={11} style={{ color:C2.textDim }} /> : <EyeOff size={11} style={{ color:'#555' }} />}
          </button>
          {isGroup ? (
            <>
              <button onClick={e=>{e.stopPropagation();onToggleExpand(layer.id)}} className="flex-shrink-0">
                <ChevronRight size={12} style={{ color:C2.textDim, transform: layer.expanded ? 'rotate(90deg)' : undefined, transition:'transform .1s' }} />
              </button>
              {layer.expanded ? <FolderOpen size={14} className="flex-shrink-0" style={{ color:'#d4a85a' }} />
                              : <FolderClosed size={14} className="flex-shrink-0" style={{ color:'#d4a85a' }} />}
            </>
          ) : (
            <>
              {layer.clipping && <CornerDownRight size={11} className="flex-shrink-0" style={{ color:C2.accent }} />}
              <div className="flex-shrink-0 rounded overflow-hidden border" style={{ borderColor: isActive ? C2.accent : '#3a3a3a' }}>
                {layer.type === 'raster' || !layer.type
                  ? <LayerThumb paint={paintThumb} id={layer.id} version={thumbVersion} />
                  : <KindThumb kind={layer.type} />}
              </div>
              {layer.mask?.enabled && (
                <button onClick={e=>{e.stopPropagation(); onSelect(layer.id); onToggleEditMask(layer.id)}}
                        title={t('layer_mask_edit')} className="flex-shrink-0 rounded flex items-center justify-center"
                        style={{ width:25, height:25, background:'#fff', border:`2px solid ${isActive && editingMask ? C2.accent : '#777'}` }}>
                  <Circle size={9} style={{ color:'#111' }} />
                </button>
              )}
            </>
          )}
          {isEditing ? (
            <input autoFocus value={editName}
                   onChange={e => onStartRename(layer.id, e.target.value)}
                   onBlur={() => onCommitRename(editName)}
                   onKeyDown={e => { if (e.key==='Enter') onCommitRename(editName); if (e.key==='Escape') onCancelRename(); e.stopPropagation() }}
                   onClick={e => e.stopPropagation()}
                   className="flex-1 text-[11px] px-1 py-0 rounded outline-none"
                   style={{ background:'#111', color:C2.text, border:`1px solid ${C2.accent}` }} />
          ) : (
            <span className="flex-1 truncate text-[11px]"
                  style={{ color:isActive?C2.accent:C2.text, fontStyle: bg ? 'italic' : undefined, fontWeight: isGroup ? 600 : 400 }}
                  onDoubleClick={e => { if (bg) return; e.stopPropagation(); onStartRename(layer.id, layer.name) }}>
              {displayLayerName(t, layer.name)}
            </span>
          )}
          {bg ? <Lock size={10} className="flex-shrink-0" style={{ color:'#777' }} /> : (
            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
              {!isGroup && (layer.mask?.enabled
                ? <button onClick={e=>{e.stopPropagation();onRemoveMask(layer.id)}} title={t('layer_mask_remove')}><Square size={10} style={{ color:'#e0a84a' }} /></button>
                : <button onClick={e=>{e.stopPropagation();onAddMask(layer.id)}} title={t('layer_mask_add')}><Circle size={10} style={{ color:C2.textDim }} /></button>)}
              {!isGroup && depth === 0 && (
                <button onClick={e=>{e.stopPropagation();onToggleClip(layer.id)}} title={t(layer.clipping?'layer_unclip':'layer_clip')}>
                  <CornerDownRight size={10} style={{ color: layer.clipping ? C2.accent : C2.textDim }} />
                </button>
              )}
              {isGroup
                ? <button onClick={e=>{e.stopPropagation();onUngroup(layer.id)}} title={t('layer_ungroup')}><FolderOpen size={10} style={{ color:C2.textDim }} /></button>
                : <button onClick={e=>{e.stopPropagation();onGroup(layer.id)}} title={t('layer_group')}><FolderClosed size={10} style={{ color:C2.textDim }} /></button>}
              <button onClick={e=>{e.stopPropagation();onDuplicate(layer.id)}} title={t('layer_duplicate')}><Copy size={10} style={{ color:C2.textDim }} /></button>
              <button onClick={e=>{e.stopPropagation();onToggleLock(layer.id)}}>
                {layer.locked ? <Lock size={10} style={{ color:C2.accent }} /> : <Unlock size={10} style={{ color:C2.textDim }} />}
              </button>
              {leafCount > 1 && <button onClick={e=>{e.stopPropagation();onDelete(layer.id)}}><Trash2 size={10} style={{ color:'#e84a4a' }} /></button>}
            </div>
          )}
        </div>
        {/* Row 2: blend + opacity + fill */}
        <div className="flex items-center gap-1.5 pr-2 pb-1.5 pt-0.5" style={{ paddingLeft: indent + 16 }} onClick={e => e.stopPropagation()}>
          <Dropdown variant="dark" className="flex-1" fontSize={10} value={layer.blendMode}
                    onChange={v => onBlend(layer.id, v)}
                    options={BLEND_KEYS.map(k => ({ value: k, label: blendLabel(t, k) }))} />
          <span className="text-[8px]" style={{ color:C2.textDim }} title={t('layer_opacity')}>O</span>
          <input type="number" min={0} max={100} value={layer.opacity}
                 onChange={e => onOpacity(layer.id, Math.max(0,Math.min(100,+e.target.value)))}
                 className="w-8 h-4 text-[10px] text-center rounded outline-none"
                 style={{ background:'#2a2a2a', color:C2.text, border:`1px solid #3a3a3a` }} />
          <span className="text-[8px]" style={{ color:C2.textDim }} title={t('layer_fill')}>F</span>
          <input type="number" min={0} max={100} value={layer.fill ?? 100}
                 onChange={e => onFill(layer.id, Math.max(0,Math.min(100,+e.target.value)))}
                 className="w-8 h-4 text-[10px] text-center rounded outline-none"
                 style={{ background:'#2a2a2a', color:C2.text, border:`1px solid #3a3a3a` }} />
        </div>
      </div>
    )
    if (isGroup && layer.expanded && !q) {
      return <div key={layer.id}>{row}{layer.children!.map(c => renderNode(c, depth + 1))}</div>
    }
    return row
  }

  const flat = q ? allNodes(layers).filter(l => displayLayerName(t, l.name).toLowerCase().includes(q)) : null

  const LockBtn = ({ on, title, children, onClick }: { on?: boolean; title: string; children: React.ReactNode; onClick: () => void }) => (
    <button onClick={onClick} title={title} disabled={!active}
            className="p-1 rounded disabled:opacity-30"
            style={{ background: on ? C2.accent+'33' : 'transparent', border:`1px solid ${on ? C2.accent : 'transparent'}` }}>
      {children}
    </button>
  )

  return (
    <div className="flex flex-col flex-1 min-h-0" style={{ borderBottom:`1px solid ${C2.border}` }}>
      {!bare && (
      <div className="flex items-center px-2 flex-shrink-0" style={{ height:28, background:C2.toolbar, borderBottom:`1px solid ${C2.border}` }}>
        <button onClick={() => setOpen(v=>!v)} className="flex items-center gap-1.5 flex-1">
          <Layers size={11} style={{ color:C2.textDim }} />
          <span className="text-[11px] font-medium" style={{ color:'#c0c0c0' }}>{t('layer_panel_layers')}</span>
          <ChevronRight size={10} style={{ color:C2.textDim, transform:open?'rotate(90deg)':undefined, transition:'transform .1s' }} />
        </button>
        <button onClick={onAdd} title={t('layer_new_layer')} className="p-0.5 rounded hover:bg-white/10"><Plus size={11} style={{ color:C2.textDim }} /></button>
      </div>
      )}

      {/* Barre de filtre */}
      {isOpen && (
        <div className="flex items-center gap-1.5 px-2 flex-shrink-0" style={{ height:26, background:C2.toolbar, borderBottom:`1px solid ${C2.border}` }}>
          <Search size={11} style={{ color:C2.textDim }} />
          <input value={filter} onChange={e => setFilter(e.target.value)} placeholder={t('layer_filter_placeholder')}
                 className="flex-1 text-[11px] bg-transparent outline-none" style={{ color:C2.text }} />
          {filter && <button onClick={() => setFilter('')} className="p-0.5 rounded hover:bg-white/10"><Plus size={11} style={{ color:C2.textDim, transform:'rotate(45deg)' }} /></button>}
        </div>
      )}

      {/* Rangée de verrous (calque actif) — façon Photoshop */}
      {isOpen && (
        <div className="flex items-center gap-1 px-2 flex-shrink-0" style={{ height:26, background:C2.toolbar, borderBottom:`1px solid ${C2.border}` }}>
          <span className="text-[10px] mr-1" style={{ color:C2.textDim }}>{t('layer_lock_label')}</span>
          <LockBtn on={!!active?.lockAlpha} title={t('layer_lock_alpha')} onClick={() => active && onToggleLockAlpha(active.id)}><Grid2x2 size={11} style={{ color:C2.text }} /></LockBtn>
          <LockBtn on={!!active?.lockPosition} title={t('layer_lock_position')} onClick={() => active && onToggleLockPosition(active.id)}><Move size={11} style={{ color:C2.text }} /></LockBtn>
          <LockBtn on={!!active?.locked} title={t('layer_lock_all')} onClick={() => active && onToggleLock(active.id)}><Lock size={11} style={{ color:C2.text }} /></LockBtn>
        </div>
      )}

      {isOpen && (
        <div className="overflow-y-auto flex-1">
          {flat ? flat.map(l => renderNode(l, 0)) : layers.map(l => renderNode(l, 0))}
        </div>
      )}

      {/* Barre d'actions : masque · groupe · dupliquer · nouveau · supprimer */}
      {isOpen && (
        <div className="flex items-center justify-end gap-0.5 px-2 flex-shrink-0" style={{ height:26, background:C2.toolbar, borderTop:`1px solid ${C2.border}` }}>
          <button onClick={() => active && !active.children && (active.mask?.enabled ? onRemoveMask(active.id) : onAddMask(active.id))}
                  title={t('layer_mask_add')} className="p-1 rounded hover:bg-white/10"><Circle size={13} style={{ color:C2.textDim }} /></button>
          <button onClick={() => active && (active.children ? onUngroup(active.id) : onGroup(active.id))}
                  title={t(active?.children ? 'layer_ungroup' : 'layer_group')} className="p-1 rounded hover:bg-white/10">
            {active?.children ? <FolderOpen size={13} style={{ color:C2.textDim }} /> : <FolderClosed size={13} style={{ color:C2.textDim }} />}
          </button>
          <button onClick={() => activeId && onDuplicate(activeId)} title={t('layer_duplicate')} className="p-1 rounded hover:bg-white/10"><Copy size={13} style={{ color:C2.textDim }} /></button>
          <button onClick={onAdd} title={t('layer_new_layer')} className="p-1 rounded hover:bg-white/10"><Plus size={14} style={{ color:C2.textDim }} /></button>
          <button onClick={() => activeId && onDelete(activeId)} disabled={leafCount<=1} title={t('layer_delete')} className="p-1 rounded hover:bg-white/10 disabled:opacity-30"><Trash2 size={13} style={{ color:C2.textDim }} /></button>
        </div>
      )}
      {ctx.menu}
    </div>
  )
}

// ── Tool properties ───────────────────────────────────────────────────────────
const toolLabel = (t: TFunction, tool: Tool): string => ({
  select: t('layer_toolname_select'), brush: t('layer_toolname_brush'),
  eraser: t('layer_toolname_eraser'), eyedrop: t('layer_toolname_eyedrop'),
  fill: t('layer_toolname_fill'), hand: t('layer_toolname_hand'),
  crop: t('layer_toolname_crop'), text: t('layer_toolname_text'),
  'rect-sel': t('layer_toolname_rect_sel'), 'ellipse-sel': t('layer_toolname_ellipse_sel'),
  lasso: t('layer_tool_lasso'), magic: t('layer_tool_magic'), transform: t('layer_tool_transform'),
  zoom: t('layer_tool_zoom'), rotate: t('layer_tool_rotate'),
}[tool] ?? '')

function ToolProps({ t, tool, brushSize,setBrushSize, brushHard,setBrushHard, brushOpac,setBrushOpac, pressureSens,setPressureSens, stabilizer,setStabilizer, inputKind, inputPressure, brushPreset, onSelectBrush, brushSelOpen, setBrushSelOpen, bare }: {
  t: TFunction
  tool: Tool; brushSize:number; setBrushSize:(v:number)=>void
  brushHard:number; setBrushHard:(v:number)=>void
  brushOpac:number; setBrushOpac:(v:number)=>void
  pressureSens:boolean; setPressureSens:(v:boolean)=>void
  stabilizer:number; setStabilizer:(v:number)=>void
  inputKind:'pen'|'touch'|'mouse'|null; inputPressure:number
  brushPreset:string; onSelectBrush:(id:string)=>void
  brushSelOpen:boolean; setBrushSelOpen:(v:boolean)=>void
  bare?: boolean
}) {
  const [open, setOpen] = useState(true)
  const isOpen = bare || open
  const C2 = C
  const activePreset = BRUSH_PRESETS.find(b => b.id === brushPreset) ?? DEFAULT_BRUSH

  return (
    <div style={{ borderBottom:`1px solid ${C2.border}` }}>
      {!bare && (
      <div className="flex items-center px-2 flex-shrink-0"
           style={{ height:28, background:C2.toolbar, borderBottom:open?`1px solid ${C2.border}`:'none' }}>
        <button onClick={() => setOpen(v=>!v)} className="flex items-center gap-1.5 flex-1">
          <SlidersHorizontal size={11} style={{ color:C2.textDim }} />
          <span className="text-[11px] font-medium" style={{ color:'#c0c0c0' }}>
            {toolLabel(t, tool)}
          </span>
          <ChevronRight size={10} style={{ color:C2.textDim, transform:open?'rotate(90deg)':undefined, transition:'transform .1s' }} />
        </button>
      </div>
      )}
      {isOpen && (
        <div className="p-3 space-y-2.5">
          {tool==='brush' && (
            <BrushPicker t={t} activeId={brushPreset} active={activePreset}
                         open={brushSelOpen} setOpen={setBrushSelOpen}
                         onSelect={onSelectBrush} C2={C2} />
          )}
          {(tool==='brush'||tool==='eraser') && (
            <>
              <BrushSlider label={t('layer_brush_size')}     value={brushSize}  min={1}   max={500} unit="px" onChange={setBrushSize} accent={C2.accent} />
              <BrushSlider label={t('layer_brush_hardness')} value={brushHard}  min={0}   max={100} unit="%" onChange={setBrushHard} accent={C2.accent} />
              <BrushSlider label={t('layer_brush_opacity')}  value={brushOpac}  min={0}   max={100} unit="%" onChange={setBrushOpac} accent={C2.accent} />
              <BrushSlider label={t('layer_brush_stabilizer')} value={stabilizer} min={0} max={100} unit="%" onChange={setStabilizer} accent={C2.accent} />
              {/* Pressure sensitivity toggle */}
              <div className="flex items-center justify-between pt-0.5">
                <span className="text-[10px] flex items-center gap-1" style={{ color:C2.textDim }}>
                  {t('layer_pen_pressure')}
                  {(inputKind === 'pen' || inputKind === 'touch') && (
                    <span className="flex items-center gap-0.5" style={{ color:C2.accent }}
                          title={inputKind === 'pen' ? t('layer_pen_detected') : t('layer_touch_detected')}>
                      {inputKind === 'pen' ? <PenTool size={9} /> : <Fingerprint size={9} />}
                      <span className="text-[8px]">{Math.round(inputPressure*100)}%</span>
                    </span>
                  )}
                </span>
                <button
                  onClick={() => setPressureSens(!pressureSens)}
                  title={pressureSens ? t('layer_pressure_disable') : t('layer_pressure_enable')}
                  style={{
                    fontSize: 9, fontWeight: 600, letterSpacing: '0.05em',
                    padding: '2px 7px', borderRadius: 4,
                    background: pressureSens ? C2.accent : '#333',
                    color: pressureSens ? '#fff' : C2.textDim,
                    border: `1px solid ${pressureSens ? C2.accent : '#444'}`,
                    cursor: 'pointer', transition: 'all .15s',
                  }}
                >
                  {pressureSens ? t('layer_toggle_on') : t('layer_toggle_off')}
                </button>
              </div>
            </>
          )}
          {(tool==='fill') && (
            <BrushSlider label={t('layer_brush_opacity')} value={brushOpac} min={0} max={100} unit="%" onChange={setBrushOpac} accent={C2.accent} />
          )}
          {(tool==='select'||tool==='rect-sel'||tool==='ellipse-sel') && (
            <p className="text-[11px]" style={{ color:C2.textDim }}>{t('layer_hint_select')}</p>
          )}
          {(tool==='eyedrop') && (
            <p className="text-[11px]" style={{ color:C2.textDim }}>{t('layer_hint_eyedrop')}</p>
          )}
          {(tool==='hand') && (
            <p className="text-[11px]" style={{ color:C2.textDim }}>{t('layer_hint_hand')}</p>
          )}
          {(tool==='text') && (
            <p className="text-[11px]" style={{ color:C2.textDim }}>{t('layer_text_hint')}</p>
          )}
          {(tool==='crop') && (
            <p className="text-[11px]" style={{ color:C2.textDim }}>{t('layer_hint_wip')}</p>
          )}
        </div>
      )}
    </div>
  )
}

// ── Brush preset picker (Procreate-style grid) ────────────────────────────────
function BrushPicker({ t, activeId, active, open, setOpen, onSelect, C2 }: {
  t: TFunction
  activeId: string
  active: BrushPreset
  open: boolean
  setOpen: (v:boolean)=>void
  onSelect: (id:string)=>void
  C2: { toolbar:string; border:string; accent:string; text:string; textDim:string }
}) {
  const ActiveIcon = active.Icon
  return (
    <div>
      {/* Current brush button */}
      <button onClick={() => setOpen(!open)}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded transition-colors"
              style={{ background:'#2c2c2c', border:`1px solid ${open?C2.accent:'#3a3a3a'}` }}>
        <span className="w-6 h-6 rounded flex items-center justify-center flex-shrink-0"
              style={{ background:C2.accent+'22', color:C2.accent }}>
          <ActiveIcon size={13} />
        </span>
        <span className="flex-1 text-left text-[11px]" style={{ color:C2.text }}>
          {t(active.nameKey)}
        </span>
        <ChevronRight size={11}
                      style={{ color:C2.textDim, transform:open?'rotate(90deg)':undefined, transition:'transform .12s' }} />
      </button>

      {/* Grid of presets */}
      {open && (
        <div className="grid grid-cols-3 gap-1.5 mt-2">
          {BRUSH_PRESETS.map(bp => {
            const Icon = bp.Icon
            const isActive = bp.id === activeId
            return (
              <button key={bp.id} onClick={() => onSelect(bp.id)} title={t(bp.nameKey)}
                      className="flex flex-col items-center justify-center gap-1 rounded py-2 transition-colors"
                      style={{
                        background: isActive ? C2.accent+'22' : '#262626',
                        border: `1px solid ${isActive ? C2.accent : '#333'}`,
                        color: isActive ? C2.accent : C2.textDim,
                      }}>
                <Icon size={16} />
                <span className="text-[8px] leading-tight text-center px-0.5"
                      style={{ color: isActive ? C2.accent : C2.textDim }}>
                  {t(bp.nameKey)}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function BrushSlider({ label, value, min, max, unit, onChange, accent }: {
  label:string; value:number; min:number; max:number; unit:string
  onChange:(v:number)=>void; accent:string
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] w-14 flex-shrink-0" style={{ color:'#9e9e9e' }}>{label}</span>
      <RangeSlider min={min} max={max} value={value} onChange={onChange}
             className="flex-1" accent={accent} trackColor="rgba(255,255,255,0.15)" aria-label={label} />
      <input type="number" min={min} max={max} value={value}
             onChange={e => onChange(+e.target.value)}
             className="w-10 h-5 text-[10px] text-center rounded outline-none"
             style={{ background:'#2c2c2c', border:`1px solid #3a3a3a`, color:'#e0e0e0' }} />
      <span className="text-[9px] w-4" style={{ color:'#5a5a5a' }}>{unit}</span>
    </div>
  )
}

// ── Bipolar slider (centered at 0, for adjustments) ───────────────────────────
function AdjSlider({ label, icon:Icon, value, min, max, onChange, accent }: {
  label:string; icon?:React.ComponentType<{size?:number;style?:React.CSSProperties}>
  value:number; min:number; max:number; onChange:(v:number)=>void; accent:string
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="flex items-center gap-1 w-[68px] flex-shrink-0 text-[10px]" style={{ color:'#9e9e9e' }}>
        {Icon && <Icon size={10} style={{ color:'#7a7a7a' }} />}{label}
      </span>
      <RangeSlider min={min} max={max} value={value} onChange={onChange}
             className="flex-1" accent={accent} trackColor="rgba(255,255,255,0.15)" aria-label={label} />
      <input type="number" min={min} max={max} value={value}
             onChange={e => onChange(Math.max(min,Math.min(max,+e.target.value)))}
             className="w-10 h-5 text-[10px] text-center rounded outline-none"
             style={{ background:'#2c2c2c', border:`1px solid #3a3a3a`, color:'#e0e0e0' }} />
    </div>
  )
}

// ── Adjustments / Filters panel ───────────────────────────────────────────────
function AdjustmentsPanel({
  t, adjust, setAdjust, invert, setInvert, gray, setGray, dirty, canEdit, onApply, onReset, bare,
}: {
  t: TFunction
  adjust: Adjust; setAdjust: React.Dispatch<React.SetStateAction<Adjust>>
  invert: boolean; setInvert: (v:boolean)=>void
  gray: boolean; setGray: (v:boolean)=>void
  dirty: boolean; canEdit: boolean
  onApply: ()=>void; onReset: ()=>void
  bare?: boolean
}) {
  const [open, setOpen] = useState(true)
  const isOpen = bare || open
  const C2 = C
  const set = (k: keyof Adjust) => (v: number) => setAdjust(a => ({ ...a, [k]: v }))

  return (
    <div style={{ borderBottom:`1px solid ${C2.border}` }}>
      {!bare && (
      <div className="flex items-center px-2 flex-shrink-0"
           style={{ height:28, background:C2.toolbar, borderBottom:open?`1px solid ${C2.border}`:'none' }}>
        <button onClick={() => setOpen(v=>!v)} className="flex items-center gap-1.5 flex-1">
          <Wand2 size={11} style={{ color:C2.textDim }} />
          <span className="text-[11px] font-medium" style={{ color:'#c0c0c0' }}>{t('layer_panel_adjust')}</span>
          {dirty && <span style={{ width:5, height:5, borderRadius:'50%', background:C2.accent }} />}
          <ChevronRight size={10} style={{ color:C2.textDim, transform:open?'rotate(90deg)':undefined, transition:'transform .1s' }} />
        </button>
      </div>
      )}
      {isOpen && (
        <div className="p-3 space-y-2.5">
          {!canEdit ? (
            <p className="text-[11px]" style={{ color:C2.textDim }}>{t('layer_adjust_no_layer')}</p>
          ) : (
            <>
              <AdjSlider label={t('layer_adjust_brightness')} icon={Sun}        value={adjust.brightness} min={-100} max={100} onChange={set('brightness')} accent={C2.accent} />
              <AdjSlider label={t('layer_adjust_contrast')}   icon={Contrast}   value={adjust.contrast}   min={-100} max={100} onChange={set('contrast')}   accent={C2.accent} />
              <AdjSlider label={t('layer_adjust_saturation')} icon={Droplet}    value={adjust.saturation} min={-100} max={100} onChange={set('saturation')} accent={C2.accent} />
              <AdjSlider label={t('layer_adjust_hue')}        icon={PaletteIcon} value={adjust.hue}        min={-180} max={180} onChange={set('hue')}        accent={C2.accent} />
              <AdjSlider label={t('layer_adjust_exposure')}   icon={Sun}        value={adjust.exposure}   min={-100} max={100} onChange={set('exposure')}   accent={C2.accent} />

              {/* Toggles */}
              <div className="flex gap-1.5 pt-0.5">
                <button onClick={() => setInvert(!invert)}
                        className="flex-1 text-[10px] py-1 rounded transition-colors"
                        style={{ background: invert ? C2.accent : '#2c2c2c', color: invert ? '#fff' : C2.textDim, border:`1px solid ${invert?C2.accent:'#3a3a3a'}` }}>
                  {t('layer_adjust_invert')}
                </button>
                <button onClick={() => setGray(!gray)}
                        className="flex-1 text-[10px] py-1 rounded transition-colors"
                        style={{ background: gray ? C2.accent : '#2c2c2c', color: gray ? '#fff' : C2.textDim, border:`1px solid ${gray?C2.accent:'#3a3a3a'}` }}>
                  {t('layer_adjust_grayscale')}
                </button>
              </div>

              {/* Apply / Reset */}
              <div className="flex gap-1.5 pt-1">
                <button onClick={onApply} disabled={!dirty}
                        className="flex-1 flex items-center justify-center gap-1 text-[10px] py-1.5 rounded font-medium transition-colors disabled:opacity-40"
                        style={{ background:C2.accent, color:'#fff' }}>
                  <Check size={11} /> {t('layer_adjust_apply')}
                </button>
                <button onClick={onReset} disabled={!dirty}
                        className="flex items-center justify-center gap-1 text-[10px] py-1.5 px-2.5 rounded transition-colors disabled:opacity-40"
                        style={{ background:'#2c2c2c', color:C2.textDim, border:'1px solid #3a3a3a' }}>
                  <RotateCcw size={11} /> {t('layer_adjust_reset')}
                </button>
              </div>
              <p className="text-[9px] leading-snug" style={{ color:'#666' }}>{t('layer_adjust_hint')}</p>
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ── Filters panel (blur / sharpen / noise) ────────────────────────────────────
function FiltersPanel({
  t, filter, setFilter, dirty, canEdit, onApply, onReset, bare,
}: {
  t: TFunction
  filter: Filter; setFilter: React.Dispatch<React.SetStateAction<Filter>>
  dirty: boolean; canEdit: boolean
  onApply: ()=>void; onReset: ()=>void
  bare?: boolean
}) {
  const [open, setOpen] = useState(false)
  const isOpen = bare || open
  const C2 = C
  const set = (k: keyof Filter) => (v: number) => setFilter(f => ({ ...f, [k]: v }))
  return (
    <div style={{ borderBottom:`1px solid ${C2.border}` }}>
      {!bare && (
      <div className="flex items-center px-2 flex-shrink-0"
           style={{ height:28, background:C2.toolbar, borderBottom:open?`1px solid ${C2.border}`:'none' }}>
        <button onClick={() => setOpen(v=>!v)} className="flex items-center gap-1.5 flex-1">
          <Sparkles size={11} style={{ color:C2.textDim }} />
          <span className="text-[11px] font-medium" style={{ color:'#c0c0c0' }}>{t('layer_panel_filters')}</span>
          {dirty && <span style={{ width:5, height:5, borderRadius:'50%', background:C2.accent }} />}
          <ChevronRight size={10} style={{ color:C2.textDim, transform:open?'rotate(90deg)':undefined, transition:'transform .1s' }} />
        </button>
      </div>
      )}
      {isOpen && (
        <div className="p-3 space-y-2.5">
          {!canEdit ? (
            <p className="text-[11px]" style={{ color:C2.textDim }}>{t('layer_adjust_no_layer')}</p>
          ) : (
            <>
              <BrushSlider label={t('layer_filter_blur')}    value={filter.blur}    min={0} max={20}  unit="px" onChange={set('blur')}    accent={C2.accent} />
              <BrushSlider label={t('layer_filter_sharpen')} value={filter.sharpen} min={0} max={100} unit="%"  onChange={set('sharpen')} accent={C2.accent} />
              <BrushSlider label={t('layer_filter_noise')}   value={filter.noise}   min={0} max={100} unit="%"  onChange={set('noise')}   accent={C2.accent} />
              <div className="flex gap-1.5 pt-1">
                <button onClick={onApply} disabled={!dirty}
                        className="flex-1 flex items-center justify-center gap-1 text-[10px] py-1.5 rounded font-medium transition-colors disabled:opacity-40"
                        style={{ background:C2.accent, color:'#fff' }}>
                  <Check size={11} /> {t('layer_adjust_apply')}
                </button>
                <button onClick={onReset} disabled={!dirty}
                        className="flex items-center justify-center gap-1 text-[10px] py-1.5 px-2.5 rounded transition-colors disabled:opacity-40"
                        style={{ background:'#2c2c2c', color:C2.textDim, border:'1px solid #3a3a3a' }}>
                  <RotateCcw size={11} /> {t('layer_adjust_reset')}
                </button>
              </div>
              <p className="text-[9px] leading-snug" style={{ color:'#666' }}>{t('layer_adjust_hint')}</p>
            </>
          )}
        </div>
      )}
    </div>
  )
}

// Dock model + drag logic moved to ui/Dock.tsx (<DockArea>).

function pointInQuad(px: number, py: number, q: [number,number][]): boolean {
  let inside = false
  for (let i=0, j=3; i<4; j=i++) {
    const xi=q[i][0], yi=q[i][1], xj=q[j][0], yj=q[j][1]
    if (((yi>py) !== (yj>py)) && (px < (xj-xi)*(py-yi)/(yj-yi)+xi)) inside = !inside
  }
  return inside
}

// ColorPicker (+ SvArea/ColorChan/harmonyColors) moved to ui/ColorPicker.tsx.
