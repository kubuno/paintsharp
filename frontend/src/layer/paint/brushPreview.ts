// Brush preview renderer (self-contained, for the Brush Studio).
// Extracted verbatim from LayerEditorPage during the layer/ refactor.
import { hexToRgb } from '../../ui'
import type { BrushPreset } from './brushPresets'

/** A cache-free dab sprite (small previews don't need the painting hot-path LRU). */
export function previewDabSprite(r: number, hardness: number, hex: string): HTMLCanvasElement {
  const qr = Math.max(0.5, r)
  const size = Math.max(1, Math.ceil(qr * 2))
  const cv = document.createElement('canvas'); cv.width = size; cv.height = size
  const g = cv.getContext('2d')!
  const cx = size / 2, cy = size / 2
  const [cr, cg, cb] = hexToRgb(hex)
  const grad = g.createRadialGradient(cx, cy, 0, cx, cy, qr)
  const solid = Math.min(0.98, hardness / 100)
  grad.addColorStop(0, `rgba(${cr},${cg},${cb},1)`)
  if (solid > 0) grad.addColorStop(solid, `rgba(${cr},${cg},${cb},1)`)
  grad.addColorStop(Math.min(1, solid + (1 - solid) * 0.5), `rgba(${cr},${cg},${cb},0.55)`)
  grad.addColorStop(1, `rgba(${cr},${cg},${cb},0)`)
  g.fillStyle = grad
  g.beginPath(); g.arc(cx, cy, qr, 0, Math.PI * 2); g.fill()
  return cv
}

/**
 * Stamp a representative stroke (a tapered S-curve with a synthetic pressure ramp)
 * so the user sees exactly what a brush and its dynamics do. Mirrors the painting
 * engine's dab spacing/jitter/scatter/pressure logic on a plain 2D canvas.
 */
export function paintPreviewStroke(
  canvas: HTMLCanvasElement, b: BrushPreset,
  sizePx: number, opacPct: number, flowPct: number, hex: string,
) {
  const ctx = canvas.getContext('2d'); if (!ctx) return
  const W = canvas.width, H = canvas.height
  ctx.clearRect(0, 0, W, H)
  ctx.globalCompositeOperation = 'source-over'
  const baseRad = Math.max(0.5, Math.min(H * 0.36, sizePx / 2))
  const strokeOpac = Math.min(1, opacPct / 100)
  const flow = Math.max(0.01, flowPct / 100)
  let seed = 0x2545f491
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
  // Pressure ramp: 0 → 1 → 0 across the stroke for a natural taper.
  const press = (t: number) => Math.sin(Math.PI * t) * 0.9 + 0.1
  const pad = baseRad + 4
  const x0 = pad, x1 = W - pad, midY = H / 2, amp = Math.min(H * 0.28, (H - pad * 2) / 2)
  const pt = (t: number): [number, number] => [x0 + (x1 - x0) * t, midY - Math.sin(t * Math.PI * 2) * amp]
  const radAt = (p: number) => { let r = baseRad; if (b.pressureSize) r *= (0.15 + 0.85 * p); if (b.sizeJitter) r *= (1 - b.sizeJitter * rnd()); return r }
  const alphaAt = (p: number) => { let a = flow * strokeOpac; if (b.pressureOpacity) a *= (0.1 + 0.9 * p); if (b.opacityJitter) a *= (1 - b.opacityJitter * rnd()); return a }
  const stamp = (x: number, y: number, p: number) => {
    const r = radAt(p)
    let ox = x, oy = y
    if (b.scatter) { const ang = rnd() * Math.PI * 2, d = rnd() * b.scatter * r; ox += Math.cos(ang) * d; oy += Math.sin(ang) * d }
    if (r < 0.4) return
    const sprite = previewDabSprite(r, b.hardness, hex)
    ctx.globalAlpha = Math.min(1, alphaAt(p))
    if (b.roundness < 1 || b.angle !== 0) {
      ctx.save(); ctx.translate(ox, oy); if (b.angle) ctx.rotate(b.angle * Math.PI / 180); ctx.scale(1, b.roundness)
      ctx.drawImage(sprite, -r, -r, r * 2, r * 2); ctx.restore()
    } else ctx.drawImage(sprite, ox - r, oy - r, r * 2, r * 2)
  }
  // March the curve at the brush's dab spacing.
  const N = 400
  let carry = 0, px = -1, py = -1
  for (let i = 0; i <= N; i++) {
    const t = i / N, p = press(t)
    const [cx, cy] = pt(t)
    if (px < 0) { stamp(cx, cy, p); px = cx; py = cy; continue }
    const dx = cx - px, dy = cy - py, seg = Math.hypot(dx, dy)
    const spacing = Math.max(0.5, b.spacing * radAt(p) * 2)
    let dist = carry
    while (dist < seg) { const f = dist / seg; stamp(px + dx * f, py + dy * f, p); dist += spacing }
    carry = dist - seg
    px = cx; py = cy
  }
  ctx.globalAlpha = 1
}
