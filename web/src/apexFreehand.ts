// Freehand drawing engine for the Apex vector editor: stroke stabilization,
// path fitting (pencil) and velocity-driven calligraphic ribbons (brush).
//
// Everything works in WORLD coordinates; the caller converts screen → world.
import type { PathPoint } from './api'

export interface RawSample {
  x: number
  y: number
  t: number
  // Stylus pressure (0..1) when the stroke comes from a pen pointer; undefined
  // for mouse/touch input (falls back to speed-based dynamics).
  p?: number
}

// ── Stroke stabilizer ──────────────────────────────────────────────────────────
// Two-stage smoothing applied while capturing:
//   1. "Pulled string": the pen only moves when the cursor is further than a
//      dead-zone radius, dragging the tip along the string direction. Kills
//      micro-jitter completely at high strengths.
//   2. Exponential moving average on top for silky curvature.
// `strength` ∈ [0,1] (0 = raw input, 1 = maximum smoothing).
export class StrokeStabilizer {
  private tip: { x: number; y: number } | null = null
  constructor(private strength: number) {}

  reset() { this.tip = null }

  feed(x: number, y: number, zoom: number): { x: number; y: number } {
    if (!this.tip || this.strength <= 0.001) {
      this.tip = { x, y }
      return { x, y }
    }
    const s = Math.max(0, Math.min(1, this.strength))
    // Dead-zone radius grows with strength (in world units, zoom-compensated).
    const radius = (s * 14) / zoom
    const dx = x - this.tip.x, dy = y - this.tip.y
    const d = Math.hypot(dx, dy)
    let nx = this.tip.x, ny = this.tip.y
    if (d > radius) {
      const pull = (d - radius) / d
      nx = this.tip.x + dx * pull
      ny = this.tip.y + dy * pull
    }
    // EMA pass: heavier strength → smaller alpha → smoother.
    const alpha = 1 - s * 0.75
    this.tip = { x: this.tip.x + (nx - this.tip.x) * alpha, y: this.tip.y + (ny - this.tip.y) * alpha }
    return { ...this.tip }
  }
}

// ── Path fitting (pencil) ──────────────────────────────────────────────────────
// Ramer–Douglas–Peucker on an open polyline.
function rdpOpen(pts: { x: number; y: number }[], eps: number): { x: number; y: number }[] {
  if (pts.length < 3) return pts.slice()
  const keep = new Array<boolean>(pts.length).fill(false)
  keep[0] = keep[pts.length - 1] = true
  const stack: [number, number][] = [[0, pts.length - 1]]
  while (stack.length) {
    const [lo, hi] = stack.pop()!
    if (hi - lo < 2) continue
    const a = pts[lo], b = pts[hi]
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1
    let far = -1, fd = eps
    for (let i = lo + 1; i < hi; i++) {
      const d = Math.abs((pts[i].x - a.x) * dy - (pts[i].y - a.y) * dx) / len
      if (d > fd) { fd = d; far = i }
    }
    if (far !== -1) { keep[far] = true; stack.push([lo, far], [far, hi]) }
  }
  return pts.filter((_, i) => keep[i])
}

// Fit a captured freehand polyline into a smooth OPEN bezier path:
// simplify (RDP), then give interior anchors Catmull-Rom-style symmetric
// handles. Endpoints stay handle-free so the stroke starts/ends crisply.
export function fitFreehandPath(raw: { x: number; y: number }[], eps: number): PathPoint[] {
  const simple = rdpOpen(raw, eps)
  const n = simple.length
  if (n < 2) return simple.map(p => ({ x: p.x, y: p.y }))
  const out: PathPoint[] = simple.map(p => ({ x: p.x, y: p.y }))
  for (let i = 1; i < n - 1; i++) {
    const prev = simple[i - 1], next = simple[i + 1]
    const tx = (next.x - prev.x) / 6, ty = (next.y - prev.y) / 6
    out[i].hIn = [-tx, -ty]
    out[i].hOut = [tx, ty]
  }
  return out
}

// ── Calligraphic brush ribbon ──────────────────────────────────────────────────
// Width per sample. With a stylus the recorded pressure drives the width
// directly (natural tapers included); mouse/touch strokes fall back to
// speed-based dynamics.
export function sampleWidths(samples: RawSample[], size: number, dynamics: number, zoom: number): number[] {
  return samples.some(s => s.p !== undefined)
    ? pressureWidths(samples, size)
    : speedWidths(samples, size, dynamics, zoom)
}

// Stylus: width = size × pressure, smoothed both ways so jitters in the
// pressure signal don't scallop the ribbon edge.
function pressureWidths(samples: RawSample[], size: number): number[] {
  const n = samples.length
  const ps = samples.map(s => s.p ?? 0.5)
  let ema = ps[0]
  const sm = ps.map(p => (ema = ema * 0.6 + p * 0.4))
  for (let i = n - 2; i >= 0; i--) sm[i] = sm[i] * 0.6 + sm[i + 1] * 0.4
  return sm.map(p => size * Math.max(0.06, Math.min(1, p)))
}

// Mouse/touch: fast strokes thin out, slow strokes swell — a natural ink feel
// without a pressure device. `dynamics` ∈ [0,1] controls how much speed
// affects width (0 = constant width).
export function speedWidths(samples: RawSample[], size: number, dynamics: number, zoom: number): number[] {
  const n = samples.length
  const widths = new Array<number>(n).fill(size)
  if (n < 2 || dynamics <= 0.001) return widths
  // Speed in screen px/ms so behaviour is zoom-independent.
  const speeds = new Array<number>(n).fill(0)
  for (let i = 1; i < n; i++) {
    const a = samples[i - 1], b = samples[i]
    const dt = Math.max(1, b.t - a.t)
    speeds[i] = (Math.hypot(b.x - a.x, b.y - a.y) * zoom) / dt
  }
  speeds[0] = speeds[1] ?? 0
  // Normalise against a reference speed and smooth (EMA both directions).
  const REF = 1.2   // px/ms considered "fast"
  let ema = speeds[0]
  const sm = speeds.map(s => (ema = ema * 0.7 + s * 0.3))
  for (let i = n - 2; i >= 0; i--) sm[i] = sm[i] * 0.6 + sm[i + 1] * 0.4
  for (let i = 0; i < n; i++) {
    const k = Math.min(1, sm[i] / REF)
    // Slow → full size; fast → down to 25 % of size (scaled by dynamics).
    widths[i] = size * (1 - dynamics * 0.75 * k)
  }
  // Taper the very ends for clean entry/exit.
  const taper = Math.min(4, Math.floor(n / 3))
  for (let i = 0; i < taper; i++) {
    const f = (i + 1) / (taper + 1)
    widths[i] *= f
    widths[n - 1 - i] *= f
  }
  return widths
}

// Build the closed ribbon outline (left side forward + right side back, with a
// rounded start/end cap) from centreline samples + per-sample half-widths.
export function brushRibbon(samples: { x: number; y: number }[], widths: number[]): { x: number; y: number }[] {
  const n = samples.length
  if (n < 2) return []
  // Per-point unit normals from neighbouring segments.
  const normals: { x: number; y: number }[] = []
  for (let i = 0; i < n; i++) {
    const a = samples[Math.max(0, i - 1)], b = samples[Math.min(n - 1, i + 1)]
    const dx = b.x - a.x, dy = b.y - a.y
    const l = Math.hypot(dx, dy) || 1
    normals.push({ x: -dy / l, y: dx / l })
  }
  const left: { x: number; y: number }[] = []
  const right: { x: number; y: number }[] = []
  for (let i = 0; i < n; i++) {
    const hw = Math.max(0.15, widths[i] / 2)
    left.push({ x: samples[i].x + normals[i].x * hw, y: samples[i].y + normals[i].y * hw })
    right.push({ x: samples[i].x - normals[i].x * hw, y: samples[i].y - normals[i].y * hw })
  }
  // Rounded end cap (half circle from left end to right end).
  const cap = (c: { x: number; y: number }, from: { x: number; y: number }, to: { x: number; y: number }): { x: number; y: number }[] => {
    const r = Math.hypot(from.x - c.x, from.y - c.y)
    if (r < 0.01) return []
    const a0 = Math.atan2(from.y - c.y, from.x - c.x)
    let a1 = Math.atan2(to.y - c.y, to.x - c.x)
    while (a1 < a0) a1 += Math.PI * 2
    const steps = 6
    const pts: { x: number; y: number }[] = []
    for (let s = 1; s < steps; s++) {
      const a = a0 + ((a1 - a0) * s) / steps
      pts.push({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r })
    }
    return pts
  }
  return [
    ...left,
    ...cap(samples[n - 1], left[n - 1], right[n - 1]),
    ...right.reverse(),
    ...cap(samples[0], right[right.length - 1] ?? left[0], left[0]),
  ]
}

// Ribbon ring → closed PathPoint outline, lightly simplified so the resulting
// vector object stays editable (not thousands of anchors).
export function ribbonToPathPoints(ring: { x: number; y: number }[], eps: number): PathPoint[] {
  const simple = rdpOpen(ring, eps)
  const out: PathPoint[] = simple.map(p => ({ x: p.x, y: p.y }))
  // Smooth the outline with small Catmull-Rom handles (closed wrap).
  const n = out.length
  for (let i = 0; i < n; i++) {
    const prev = simple[(i - 1 + n) % n], next = simple[(i + 1) % n]
    const tx = (next.x - prev.x) / 6, ty = (next.y - prev.y) / 6
    out[i].hIn = [-tx, -ty]
    out[i].hOut = [tx, ty]
  }
  return out
}
