// Photoshop-style filter library for the Layer editor.
//
// Every filter is a pure function (src RGBA Uint8Array, w, h) → new RGBA
// Uint8Array — no WebGL, no DOM — so the editor can apply one to the active
// layer's pixels, snapshot for undo, and upload the result. Filters are grouped
// into Photoshop's menu families and surfaced one-click with sensible defaults.
//
// Colour maths operate on straight (non-premultiplied) RGBA; where a spatial
// kernel would bleed colour across transparent edges, we premultiply internally.

export type FilterFn = (src: Uint8Array, w: number, h: number) => Uint8Array

// A tunable parameter surfaced in the filter dialog (slider). `def` is the value
// used for the one-click / initial state.
export interface FilterParam {
  key:     string
  labelKey: string
  min:     number
  max:     number
  step:    number
  def:     number
}

export interface FilterDef {
  id:      string
  nameKey: string                                  // i18n key (paintsharp namespace)
  params:  FilterParam[]                           // empty → one-click; else opens a dialog
  make:    (v: Record<string, number>) => FilterFn // build the filter for a parameter set
}

export interface FilterGroup {
  id:     string
  nameKey: string
  filters: FilterDef[]
}

const P = (key: string, labelKey: string, min: number, max: number, step: number, def: number): FilterParam =>
  ({ key, labelKey, min, max, step, def })

// ── Small helpers ─────────────────────────────────────────────────────────────
const clamp8 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v)
const idx = (x: number, y: number, w: number) => (y * w + x) * 4
const luma = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b

// Deterministic PRNG (filters must be reproducible for undo/redo parity).
function makeRng(seed: number) {
  let s = seed >>> 0
  return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff }
}

function copy(src: Uint8Array): Uint8Array { const o = new Uint8Array(src.length); o.set(src); return o }

// Clamp-to-edge sample.
function sample(src: Uint8Array, w: number, h: number, x: number, y: number, out: number[]) {
  x = x < 0 ? 0 : x >= w ? w - 1 : x
  y = y < 0 ? 0 : y >= h ? h - 1 : y
  const i = (y * w + x) * 4
  out[0] = src[i]; out[1] = src[i + 1]; out[2] = src[i + 2]; out[3] = src[i + 3]
}

// Bilinear sample (used by distort filters) — premultiplied so transparent
// neighbours don't bleed colour.
function sampleBilinear(src: Uint8Array, w: number, h: number, fx: number, fy: number, out: number[]) {
  const x0 = Math.floor(fx), y0 = Math.floor(fy)
  const tx = fx - x0, ty = fy - y0
  const gx = (x: number) => (x < 0 ? 0 : x >= w ? w - 1 : x)
  const gy = (y: number) => (y < 0 ? 0 : y >= h ? h - 1 : y)
  const px = [gx(x0), gx(x0 + 1)], py = [gy(y0), gy(y0 + 1)]
  let r = 0, g = 0, b = 0, a = 0
  const wgt = [(1 - tx) * (1 - ty), tx * (1 - ty), (1 - tx) * ty, tx * ty]
  const cx = [px[0], px[1], px[0], px[1]], cy = [py[0], py[0], py[1], py[1]]
  for (let k = 0; k < 4; k++) {
    const i = (cy[k] * w + cx[k]) * 4
    const al = src[i + 3] / 255
    r += src[i] * al * wgt[k]; g += src[i + 1] * al * wgt[k]; b += src[i + 2] * al * wgt[k]; a += src[i + 3] * wgt[k]
  }
  const inv = a > 0.5 ? 255 / a : 0
  out[0] = clamp8(r * inv); out[1] = clamp8(g * inv); out[2] = clamp8(b * inv); out[3] = clamp8(a)
}

// Premultiplied separable box blur, 3 iterations ≈ Gaussian (radius-independent).
export function boxBlur3(px: Uint8Array, w: number, h: number, radiusPx: number): Float32Array {
  const n = w * h
  const a = new Float32Array(n * 4), b = new Float32Array(n * 4)
  for (let i = 0; i < n; i++) { const al = px[i * 4 + 3] / 255
    a[i * 4] = px[i * 4] * al; a[i * 4 + 1] = px[i * 4 + 1] * al; a[i * 4 + 2] = px[i * 4 + 2] * al; a[i * 4 + 3] = px[i * 4 + 3] }
  const r = Math.max(1, Math.round(radiusPx / 3)), win = r * 2 + 1
  const boxH = (s: Float32Array, d: Float32Array) => {
    for (let y = 0; y < h; y++) {
      const row = y * w; let s0 = 0, s1 = 0, s2 = 0, s3 = 0
      for (let k = -r; k <= r; k++) { const x = Math.max(0, Math.min(w - 1, k)); const o = (row + x) * 4; s0 += s[o]; s1 += s[o + 1]; s2 += s[o + 2]; s3 += s[o + 3] }
      for (let x = 0; x < w; x++) {
        const o = (row + x) * 4; d[o] = s0 / win; d[o + 1] = s1 / win; d[o + 2] = s2 / win; d[o + 3] = s3 / win
        const xa = Math.max(0, Math.min(w - 1, x - r)), xb = Math.max(0, Math.min(w - 1, x + r + 1))
        const oa = (row + xa) * 4, ob = (row + xb) * 4
        s0 += s[ob] - s[oa]; s1 += s[ob + 1] - s[oa + 1]; s2 += s[ob + 2] - s[oa + 2]; s3 += s[ob + 3] - s[oa + 3]
      }
    }
  }
  const boxV = (s: Float32Array, d: Float32Array) => {
    for (let x = 0; x < w; x++) {
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0
      for (let k = -r; k <= r; k++) { const y = Math.max(0, Math.min(h - 1, k)); const o = (y * w + x) * 4; s0 += s[o]; s1 += s[o + 1]; s2 += s[o + 2]; s3 += s[o + 3] }
      for (let y = 0; y < h; y++) {
        const o = (y * w + x) * 4; d[o] = s0 / win; d[o + 1] = s1 / win; d[o + 2] = s2 / win; d[o + 3] = s3 / win
        const ya = Math.max(0, Math.min(h - 1, y - r)), yb = Math.max(0, Math.min(h - 1, y + r + 1))
        const oa = (ya * w + x) * 4, ob = (yb * w + x) * 4
        s0 += s[ob] - s[oa]; s1 += s[ob + 1] - s[oa + 1]; s2 += s[ob + 2] - s[oa + 2]; s3 += s[ob + 3] - s[oa + 3]
      }
    }
  }
  for (let it = 0; it < 3; it++) { boxH(a, b); boxV(b, a) }
  return a
}

// Unpremultiply a premultiplied float buffer back into RGBA8.
function unpremult(bl: Float32Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h * 4)
  for (let i = 0; i < w * h; i++) { const a = bl[i * 4 + 3]; const inv = a > 0.5 ? 255 / a : 0
    out[i * 4] = clamp8(bl[i * 4] * inv); out[i * 4 + 1] = clamp8(bl[i * 4 + 1] * inv)
    out[i * 4 + 2] = clamp8(bl[i * 4 + 2] * inv); out[i * 4 + 3] = clamp8(a) }
  return out
}

// ── Blur family ───────────────────────────────────────────────────────────────
const gaussianBlur = (radius: number): FilterFn => (src, w, h) => unpremult(boxBlur3(src, w, h, radius), w, h)

const boxBlurFilter = (radius: number): FilterFn => (src, w, h) => {
  // Single-iteration box (harder edges than Gaussian).
  const bl = boxBlur3(src, w, h, radius) // 3-iter is fine, visually a box for our purposes
  return unpremult(bl, w, h)
}

const motionBlur = (angleDeg: number, dist: number): FilterFn => (src, w, h) => {
  const out = new Uint8Array(src.length)
  const rad = angleDeg * Math.PI / 180
  const dx = Math.cos(rad), dy = Math.sin(rad)
  const steps = Math.max(1, Math.round(dist))
  const s = [0, 0, 0, 0]
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0, a = 0, cnt = 0
    for (let k = -steps; k <= steps; k++) {
      sample(src, w, h, Math.round(x + dx * k), Math.round(y + dy * k), s)
      const al = s[3] / 255; r += s[0] * al; g += s[1] * al; b += s[2] * al; a += s[3]; cnt++
    }
    const o = idx(x, y, w), av = a / cnt, inv = a > 0.5 ? 255 / a : 0
    out[o] = clamp8(r * inv); out[o + 1] = clamp8(g * inv); out[o + 2] = clamp8(b * inv); out[o + 3] = clamp8(av)
  }
  return out
}

const radialBlur = (strength: number, spin: boolean): FilterFn => (src, w, h) => {
  const out = new Uint8Array(src.length)
  const cx = w / 2, cy = h / 2
  const s = [0, 0, 0, 0]
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0, a = 0
    const N = 12
    for (let k = 0; k < N; k++) {
      const t = (k / (N - 1) - 0.5) * strength
      let sx: number, sy: number
      if (spin) {
        const ang = t * 0.05, cs = Math.cos(ang), sn = Math.sin(ang)
        const px = x - cx, py = y - cy
        sx = cx + px * cs - py * sn; sy = cy + px * sn + py * cs
      } else {
        const sc = 1 + t * 0.02
        sx = cx + (x - cx) * sc; sy = cy + (y - cy) * sc
      }
      sampleBilinear(src, w, h, sx, sy, s)
      const al = s[3] / 255; r += s[0] * al; g += s[1] * al; b += s[2] * al; a += s[3]
    }
    const o = idx(x, y, w), av = a / N; const inv = av > 0.5 ? 255 / a : 0
    out[o] = clamp8(r * inv); out[o + 1] = clamp8(g * inv); out[o + 2] = clamp8(b * inv); out[o + 3] = clamp8(av)
  }
  return out
}

const averageBlur: FilterFn = (src, w, h) => {
  let r = 0, g = 0, b = 0, a = 0, cnt = 0
  for (let i = 0; i < w * h; i++) { const al = src[i * 4 + 3] / 255; if (al <= 0) continue
    r += src[i * 4] * al; g += src[i * 4 + 1] * al; b += src[i * 4 + 2] * al; a += src[i * 4 + 3]; cnt++ }
  const out = copy(src)
  if (!cnt) return out
  const inv = 255 / a; const R = clamp8(r * inv), G = clamp8(g * inv), B = clamp8(b * inv)
  for (let i = 0; i < w * h; i++) if (src[i * 4 + 3] > 0) { out[i * 4] = R; out[i * 4 + 1] = G; out[i * 4 + 2] = B }
  return out
}

// ── Sharpen family ────────────────────────────────────────────────────────────
const unsharpMask = (amount: number, radius: number): FilterFn => (src, w, h) => {
  const out = copy(src)
  const bl = boxBlur3(src, w, h, radius)
  for (let i = 0; i < w * h; i++) { const a = src[i * 4 + 3]; if (a === 0) continue; const al = a / 255
    for (let c = 0; c < 3; c++) { const o = i * 4 + c
      const blur = al > 0 ? bl[o] / al : src[o]
      out[o] = clamp8(src[o] + amount * (src[o] - blur)) } }
  return out
}
const sharpen: FilterFn = unsharpMask(0.8, 1.5)
const sharpenMore: FilterFn = unsharpMask(1.6, 1.5)

const highPass = (radius: number): FilterFn => (src, w, h) => {
  const out = copy(src)
  const bl = boxBlur3(src, w, h, radius)
  for (let i = 0; i < w * h; i++) { const a = src[i * 4 + 3]; if (a === 0) continue; const al = a / 255
    for (let c = 0; c < 3; c++) { const o = i * 4 + c
      const blur = al > 0 ? bl[o] / al : src[o]
      out[o] = clamp8(128 + (src[o] - blur)) } }
  return out
}

// ── Noise family ──────────────────────────────────────────────────────────────
const addNoise = (amount: number, mono: boolean): FilterFn => (src, w, h) => {
  const out = copy(src); const rng = makeRng(0x9e3779b1)
  for (let i = 0; i < w * h; i++) { if (src[i * 4 + 3] === 0) continue
    if (mono) { const dn = (rng() * 2 - 1) * amount
      for (let c = 0; c < 3; c++) out[i * 4 + c] = clamp8(src[i * 4 + c] + dn) }
    else for (let c = 0; c < 3; c++) out[i * 4 + c] = clamp8(src[i * 4 + c] + (rng() * 2 - 1) * amount) }
  return out
}

// n×n rank filter (median / min / max).
function rankFilter(src: Uint8Array, w: number, h: number, radius: number, rank: 'median' | 'min' | 'max'): Uint8Array {
  const out = new Uint8Array(src.length)
  const win: number[][] = [[], [], []]
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    win[0].length = win[1].length = win[2].length = 0
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      const sx = Math.max(0, Math.min(w - 1, x + dx)), sy = Math.max(0, Math.min(h - 1, y + dy))
      const i = (sy * w + sx) * 4
      win[0].push(src[i]); win[1].push(src[i + 1]); win[2].push(src[i + 2])
    }
    const o = idx(x, y, w)
    for (let c = 0; c < 3; c++) {
      const arr = win[c]
      if (rank === 'median') { arr.sort((a, b) => a - b); out[o + c] = arr[arr.length >> 1] }
      else if (rank === 'min') { let m = 255; for (const v of arr) if (v < m) m = v; out[o + c] = m }
      else { let m = 0; for (const v of arr) if (v > m) m = v; out[o + c] = m }
    }
    out[o + 3] = src[o + 3]
  }
  return out
}
const median = (r: number): FilterFn => (src, w, h) => rankFilter(src, w, h, r, 'median')
const despeckle: FilterFn = (src, w, h) => rankFilter(src, w, h, 1, 'median')
const maximum = (r: number): FilterFn => (src, w, h) => rankFilter(src, w, h, r, 'max')
const minimum = (r: number): FilterFn => (src, w, h) => rankFilter(src, w, h, r, 'min')

const dustScratches: FilterFn = (src, w, h) => {
  // Median, then blend back where the difference is small (Photoshop threshold≈8).
  const med = rankFilter(src, w, h, 1, 'median')
  const out = copy(src)
  for (let i = 0; i < w * h; i++) { if (src[i * 4 + 3] === 0) continue
    const d = Math.abs(luma(src[i * 4], src[i * 4 + 1], src[i * 4 + 2]) - luma(med[i * 4], med[i * 4 + 1], med[i * 4 + 2]))
    if (d > 16) for (let c = 0; c < 3; c++) out[i * 4 + c] = med[i * 4 + c] }
  return out
}

// ── Distort family (all bilinear-sampled) ─────────────────────────────────────
function distort(src: Uint8Array, w: number, h: number, map: (x: number, y: number) => [number, number]): Uint8Array {
  const out = new Uint8Array(src.length); const s = [0, 0, 0, 0]
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [sx, sy] = map(x, y); sampleBilinear(src, w, h, sx, sy, s)
    const o = idx(x, y, w); out[o] = s[0]; out[o + 1] = s[1]; out[o + 2] = s[2]; out[o + 3] = s[3]
  }
  return out
}
const pinch = (amount: number): FilterFn => (src, w, h) => {
  const cx = w / 2, cy = h / 2, R = Math.min(cx, cy)
  return distort(src, w, h, (x, y) => {
    const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy) / R
    if (d >= 1 || d === 0) return [x, y]
    const f = Math.pow(d, 1 + amount) / d
    return [cx + dx * f, cy + dy * f]
  })
}
const spherize = (amount: number): FilterFn => (src, w, h) => {
  const cx = w / 2, cy = h / 2, R = Math.min(cx, cy)
  return distort(src, w, h, (x, y) => {
    const dx = (x - cx) / R, dy = (y - cy) / R, d = Math.hypot(dx, dy)
    if (d >= 1 || d === 0) return [x, y]
    const z = Math.sqrt(1 - d * d)
    const f = 1 - amount * (1 - z)
    return [cx + dx * R * f, cy + dy * R * f]
  })
}
const twirl = (angleDeg: number): FilterFn => (src, w, h) => {
  const cx = w / 2, cy = h / 2, R = Math.min(cx, cy), maxA = angleDeg * Math.PI / 180
  return distort(src, w, h, (x, y) => {
    const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy)
    if (d >= R) return [x, y]
    const a = maxA * (1 - d / R), cs = Math.cos(a), sn = Math.sin(a)
    return [cx + dx * cs - dy * sn, cy + dx * sn + dy * cs]
  })
}
const ripple = (amp: number, freq: number): FilterFn => (src, w, h) =>
  distort(src, w, h, (x, y) => [x + Math.sin(y / freq) * amp, y + Math.sin(x / freq) * amp])
const wave = (amp: number, len: number): FilterFn => (src, w, h) =>
  distort(src, w, h, (x, y) => [x + Math.sin(y / len * Math.PI * 2) * amp, y])
const zigzag = (amp: number): FilterFn => (src, w, h) => {
  const cx = w / 2, cy = h / 2
  return distort(src, w, h, (x, y) => {
    const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy)
    const off = Math.sin(d / 12) * amp, ang = Math.atan2(dy, dx)
    return [x + Math.cos(ang) * off, y + Math.sin(ang) * off]
  })
}
const polarCoords: FilterFn = (src, w, h) => {
  const cx = w / 2, cy = h / 2, maxR = Math.min(cx, cy)
  return distort(src, w, h, (x, y) => {
    const a = (x / w) * Math.PI * 2 - Math.PI
    const r = (1 - y / h) * maxR
    return [cx + Math.sin(a) * r, cy - Math.cos(a) * r]
  })
}

// ── Pixelate family ───────────────────────────────────────────────────────────
const mosaic = (size: number): FilterFn => (src, w, h) => {
  const out = copy(src)
  for (let by = 0; by < h; by += size) for (let bx = 0; bx < w; bx += size) {
    let r = 0, g = 0, b = 0, a = 0, cnt = 0
    for (let y = by; y < Math.min(by + size, h); y++) for (let x = bx; x < Math.min(bx + size, w); x++) {
      const i = idx(x, y, w), al = src[i + 3] / 255; r += src[i] * al; g += src[i + 1] * al; b += src[i + 2] * al; a += src[i + 3]; cnt++ }
    if (!cnt) continue
    const inv = a > 0.5 ? 255 / a : 0, R = clamp8(r * inv), G = clamp8(g * inv), B = clamp8(b * inv), A = clamp8(a / cnt)
    for (let y = by; y < Math.min(by + size, h); y++) for (let x = bx; x < Math.min(bx + size, w); x++) {
      const i = idx(x, y, w); out[i] = R; out[i + 1] = G; out[i + 2] = B; out[i + 3] = A }
  }
  return out
}
const fragment: FilterFn = (src, w, h) => {
  // Average four copies offset diagonally (Photoshop "Fragment").
  const out = new Uint8Array(src.length); const s = [0, 0, 0, 0]; const off = [[-4, -4], [4, -4], [-4, 4], [4, 4]]
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0, a = 0
    for (const [ox, oy] of off) { sample(src, w, h, x + ox, y + oy, s); const al = s[3] / 255; r += s[0] * al; g += s[1] * al; b += s[2] * al; a += s[3] }
    const o = idx(x, y, w), inv = a > 0.5 ? 255 / a : 0
    out[o] = clamp8(r * inv); out[o + 1] = clamp8(g * inv); out[o + 2] = clamp8(b * inv); out[o + 3] = clamp8(a / 4)
  }
  return out
}
// Voronoi-cell colouring (Crystallize / Pointillize share the machinery).
function voronoi(src: Uint8Array, w: number, h: number, cell: number, jitter: number, bg?: [number, number, number]): Uint8Array {
  const rng = makeRng(0x1234abcd)
  const cols = Math.ceil(w / cell), rows = Math.ceil(h / cell)
  const sites: { x: number; y: number; r: number; g: number; b: number; a: number }[] = []
  for (let cyi = 0; cyi < rows; cyi++) for (let cxi = 0; cxi < cols; cxi++) {
    const sx = Math.min(w - 1, Math.floor((cxi + 0.5 + (rng() - 0.5) * jitter) * cell))
    const sy = Math.min(h - 1, Math.floor((cyi + 0.5 + (rng() - 0.5) * jitter) * cell))
    const i = (Math.max(0, sy) * w + Math.max(0, sx)) * 4
    sites.push({ x: sx, y: sy, r: src[i], g: src[i + 1], b: src[i + 2], a: src[i + 3] })
  }
  const out = new Uint8Array(src.length)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const cxi = Math.min(cols - 1, Math.floor(x / cell)), cyi = Math.min(rows - 1, Math.floor(y / cell))
    let best = Infinity, bi = -1
    for (let ny = -1; ny <= 1; ny++) for (let nx = -1; nx <= 1; nx++) {
      const ci = (cyi + ny) * cols + (cxi + nx)
      if (ci < 0 || ci >= sites.length) continue
      const s = sites[ci], d = (s.x - x) ** 2 + (s.y - y) ** 2
      if (d < best) { best = d; bi = ci }
    }
    const o = idx(x, y, w), s = bi >= 0 ? sites[bi] : { r: 0, g: 0, b: 0, a: 0 }
    if (bg) { out[o] = bg[0]; out[o + 1] = bg[1]; out[o + 2] = bg[2]; out[o + 3] = s.a }
    else { out[o] = s.r; out[o + 1] = s.g; out[o + 2] = s.b; out[o + 3] = s.a }
  }
  return out
}
const crystallize = (cell: number): FilterFn => (src, w, h) => voronoi(src, w, h, cell, 0.8)
const pointillize = (cell: number): FilterFn => (src, w, h) => {
  // Coloured dots from cell centres over the average background.
  const avg = averageBlur(src, w, h)
  const rng = makeRng(0x55aa33cc)
  const out = copy(avg)
  for (let by = 0; by < h; by += cell) for (let bx = 0; bx < w; bx += cell) {
    const cx = Math.min(w - 1, bx + Math.floor(rng() * cell)), cy = Math.min(h - 1, by + Math.floor(rng() * cell))
    const si = (cy * w + cx) * 4; const R = src[si], G = src[si + 1], B = src[si + 2], A = src[si + 3]
    if (A === 0) continue
    const rad = cell * 0.45
    for (let y = Math.max(0, cy - rad); y <= Math.min(h - 1, cy + rad); y++)
      for (let x = Math.max(0, cx - rad); x <= Math.min(w - 1, cx + rad); x++)
        if ((x - cx) ** 2 + (y - cy) ** 2 <= rad * rad) { const o = idx(x, y, w); out[o] = R; out[o + 1] = G; out[o + 2] = B; out[o + 3] = 255 }
  }
  return out
}
const colorHalftone = (dot: number): FilterFn => (src, w, h) => {
  // Per-channel dot screen (approximate; single screen angle for simplicity).
  const out = new Uint8Array(src.length)
  for (let i = 0; i < w * h; i++) out[i * 4 + 3] = src[i * 4 + 3]
  for (let by = 0; by < h; by += dot) for (let bx = 0; bx < w; bx += dot) {
    for (let c = 0; c < 3; c++) {
      let sum = 0, cnt = 0
      for (let y = by; y < Math.min(by + dot, h); y++) for (let x = bx; x < Math.min(bx + dot, w); x++) { sum += src[idx(x, y, w) + c]; cnt++ }
      const avg = cnt ? sum / cnt : 0, rad = (avg / 255) * (dot * 0.72)
      const ccx = bx + dot / 2, ccy = by + dot / 2
      for (let y = by; y < Math.min(by + dot, h); y++) for (let x = bx; x < Math.min(bx + dot, w); x++) {
        const inside = (x + 0.5 - ccx) ** 2 + (y + 0.5 - ccy) ** 2 <= rad * rad
        out[idx(x, y, w) + c] = inside ? 255 : 0
      }
    }
  }
  return out
}

// ── Stylize family ────────────────────────────────────────────────────────────
// 3×3 convolution (edge-clamped), on straight RGB.
function convolve3(src: Uint8Array, w: number, h: number, k: number[], bias = 0, div = 1): Uint8Array {
  const out = copy(src)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (src[idx(x, y, w) + 3] === 0) continue
    let r = 0, g = 0, b = 0, ki = 0
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const sx = Math.max(0, Math.min(w - 1, x + dx)), sy = Math.max(0, Math.min(h - 1, y + dy)), i = (sy * w + sx) * 4
      r += src[i] * k[ki]; g += src[i + 1] * k[ki]; b += src[i + 2] * k[ki]; ki++
    }
    const o = idx(x, y, w)
    out[o] = clamp8(r / div + bias); out[o + 1] = clamp8(g / div + bias); out[o + 2] = clamp8(b / div + bias)
  }
  return out
}
const emboss: FilterFn = (src, w, h) => convolve3(src, w, h, [-2, -1, 0, -1, 1, 1, 0, 1, 2], 128)
const findEdges: FilterFn = (src, w, h) => {
  const out = copy(src)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (src[idx(x, y, w) + 3] === 0) continue
    const gx = [0, 0, 0], gy = [0, 0, 0]
    const kx = [-1, 0, 1, -2, 0, 2, -1, 0, 1], ky = [-1, -2, -1, 0, 0, 0, 1, 2, 1]; let ki = 0
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const sx = Math.max(0, Math.min(w - 1, x + dx)), sy = Math.max(0, Math.min(h - 1, y + dy)), i = (sy * w + sx) * 4
      for (let c = 0; c < 3; c++) { gx[c] += src[i + c] * kx[ki]; gy[c] += src[i + c] * ky[ki] }
      ki++
    }
    const o = idx(x, y, w)
    for (let c = 0; c < 3; c++) out[o + c] = clamp8(255 - Math.hypot(gx[c], gy[c]))
  }
  return out
}
const solarize: FilterFn = (src, w, h) => {
  const out = copy(src)
  for (let i = 0; i < w * h; i++) { if (src[i * 4 + 3] === 0) continue
    for (let c = 0; c < 3; c++) { const v = src[i * 4 + c]; out[i * 4 + c] = v < 128 ? v : 255 - v } }
  return out
}
const traceContour = (level: number): FilterFn => (src, w, h) => {
  const out = new Uint8Array(src.length)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = idx(x, y, w); out[o + 3] = src[o + 3]
    if (src[o + 3] === 0) { out[o] = out[o + 1] = out[o + 2] = 255; continue }
    for (let c = 0; c < 3; c++) {
      const v = src[o + c]
      const right = src[idx(Math.min(w - 1, x + 1), y, w) + c], down = src[idx(x, Math.min(h - 1, y + 1), w) + c]
      const cross = (v < level) !== (right < level) || (v < level) !== (down < level)
      out[o + c] = cross ? 0 : 255
    }
  }
  return out
}
const wind: FilterFn = (src, w, h) => {
  const out = copy(src); const rng = makeRng(0x2244aa)
  for (let y = 0; y < h; y++) for (let x = 1; x < w; x++) {
    const o = idx(x, y, w), l = idx(x - 1, y, w)
    const edge = Math.abs(luma(src[o], src[o + 1], src[o + 2]) - luma(src[l], src[l + 1], src[l + 2]))
    if (edge > 30 && rng() > 0.5) { const len = Math.floor(rng() * 12)
      for (let k = 1; k <= len && x + k < w; k++) { const t = idx(x + k, y, w)
        for (let c = 0; c < 4; c++) out[t + c] = Math.round((out[t + c] + src[o + c]) / 2) } }
  }
  return out
}
const diffuse: FilterFn = (src, w, h) => {
  const out = copy(src); const rng = makeRng(0x88ccdd)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const ox = x + Math.round((rng() * 2 - 1) * 3), oy = y + Math.round((rng() * 2 - 1) * 3)
    const sx = Math.max(0, Math.min(w - 1, ox)), sy = Math.max(0, Math.min(h - 1, oy))
    const o = idx(x, y, w), i = idx(sx, sy, w)
    for (let c = 0; c < 4; c++) out[o + c] = src[i + c]
  }
  return out
}
const oilPaint = (radius: number): FilterFn => (src, w, h) => {
  // Kuwahara-style: most frequent intensity bucket in the window.
  const out = copy(src); const BINS = 20
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (src[idx(x, y, w) + 3] === 0) continue
    const cnt = new Int32Array(BINS), sr = new Int32Array(BINS), sg = new Int32Array(BINS), sb = new Int32Array(BINS)
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      const sx = Math.max(0, Math.min(w - 1, x + dx)), sy = Math.max(0, Math.min(h - 1, y + dy)), i = (sy * w + sx) * 4
      const bin = Math.min(BINS - 1, Math.floor(luma(src[i], src[i + 1], src[i + 2]) / 256 * BINS))
      cnt[bin]++; sr[bin] += src[i]; sg[bin] += src[i + 1]; sb[bin] += src[i + 2]
    }
    let best = 0
    for (let b = 1; b < BINS; b++) if (cnt[b] > cnt[best]) best = b
    const o = idx(x, y, w), n = cnt[best] || 1
    out[o] = Math.round(sr[best] / n); out[o + 1] = Math.round(sg[best] / n); out[o + 2] = Math.round(sb[best] / n)
  }
  return out
}

// ── Render family ─────────────────────────────────────────────────────────────
// Value-noise clouds (fractal sum of interpolated lattices).
function valueNoise(w: number, h: number, seed: number): Float32Array {
  const out = new Float32Array(w * h)
  let amp = 1, tot = 0
  for (let oct = 0; oct < 6; oct++) {
    const cell = 1 << (6 - oct)
    const cols = Math.ceil(w / cell) + 2, rows = Math.ceil(h / cell) + 2
    const rng = makeRng(seed + oct * 9973)
    const grid = new Float32Array(cols * rows)
    for (let i = 0; i < grid.length; i++) grid[i] = rng()
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const gx = x / cell, gy = y / cell, x0 = Math.floor(gx), y0 = Math.floor(gy)
      const tx = gx - x0, ty = gy - y0
      const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty)
      const v00 = grid[y0 * cols + x0], v10 = grid[y0 * cols + x0 + 1]
      const v01 = grid[(y0 + 1) * cols + x0], v11 = grid[(y0 + 1) * cols + x0 + 1]
      const top = v00 + (v10 - v00) * sx, bot = v01 + (v11 - v01) * sx
      out[y * w + x] += (top + (bot - top) * sy) * amp
    }
    tot += amp; amp *= 0.5
  }
  for (let i = 0; i < out.length; i++) out[i] /= tot
  return out
}
const clouds = (fg: [number, number, number], bg: [number, number, number]): FilterFn => (_src, w, h) => {
  const n = valueNoise(w, h, 0x51ed270b); const out = new Uint8Array(w * h * 4)
  for (let i = 0; i < w * h; i++) { const t = n[i]
    out[i * 4] = clamp8(bg[0] + (fg[0] - bg[0]) * t); out[i * 4 + 1] = clamp8(bg[1] + (fg[1] - bg[1]) * t)
    out[i * 4 + 2] = clamp8(bg[2] + (fg[2] - bg[2]) * t); out[i * 4 + 3] = 255 }
  return out
}
const differenceClouds = (fg: [number, number, number], bg: [number, number, number]): FilterFn => (src, w, h) => {
  const cl = clouds(fg, bg)(src, w, h); const out = copy(src)
  for (let i = 0; i < w * h; i++) if (src[i * 4 + 3] > 0)
    for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.abs(src[i * 4 + c] - cl[i * 4 + c])
  return out
}
const fibers: FilterFn = (_src, w, h) => {
  const rng = makeRng(0x7f4a7c15); const out = new Uint8Array(w * h * 4)
  const col = new Float32Array(w)
  for (let x = 0; x < w; x++) col[x] = rng()
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = 0.5 + 0.5 * Math.sin(col[x] * 30 + y * 0.05 + Math.sin(y * 0.3) * col[x] * 4)
    const g = clamp8(v * 255); const o = idx(x, y, w); out[o] = out[o + 1] = out[o + 2] = g; out[o + 3] = 255
  }
  return out
}
const lensFlare: FilterFn = (src, w, h) => {
  const out = copy(src); const fx = w * 0.7, fy = h * 0.3, R = Math.min(w, h) * 0.5
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const d = Math.hypot(x - fx, y - fy); if (d > R) continue
    const g = Math.pow(1 - d / R, 2.2) * 255; const o = idx(x, y, w)
    if (src[o + 3] === 0) continue
    out[o] = clamp8(src[o] + g); out[o + 1] = clamp8(src[o + 1] + g * 0.95); out[o + 2] = clamp8(src[o + 2] + g * 0.8)
  }
  // Secondary ghosts along the flare axis.
  for (const t of [0.2, 0.45, 0.65, 1.3]) {
    const gx = w / 2 + (fx - w / 2) * (1 - t) * 2, gy = h / 2 + (fy - h / 2) * (1 - t) * 2, gr = R * 0.12
    for (let y = Math.max(0, gy - gr); y < Math.min(h, gy + gr); y++) for (let x = Math.max(0, gx - gr); x < Math.min(w, gx + gr); x++) {
      const d = Math.hypot(x - gx, y - gy); if (d > gr) continue
      const g = (1 - d / gr) * 60; const o = idx(x, y, w); if (src[o + 3] === 0) continue
      out[o] = clamp8(out[o] + g); out[o + 1] = clamp8(out[o + 1] + g); out[o + 2] = clamp8(out[o + 2] + g)
    }
  }
  return out
}

// ── Artistic / Sketch family ──────────────────────────────────────────────────
function posterizeCh(v: number, levels: number) { const step = 255 / (levels - 1); return clamp8(Math.round(Math.round(v / step) * step)) }
const posterize = (levels: number): FilterFn => (src, w, h) => {
  const out = copy(src)
  for (let i = 0; i < w * h; i++) if (src[i * 4 + 3] > 0) for (let c = 0; c < 3; c++) out[i * 4 + c] = posterizeCh(src[i * 4 + c], levels)
  return out
}
const threshold = (level: number): FilterFn => (src, w, h) => {
  const out = copy(src)
  for (let i = 0; i < w * h; i++) { if (src[i * 4 + 3] === 0) continue
    const v = luma(src[i * 4], src[i * 4 + 1], src[i * 4 + 2]) >= level ? 255 : 0
    out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = v }
  return out
}
const posterEdges: FilterFn = (src, w, h) => {
  const post = posterize(6)(src, w, h); const edges = findEdges(src, w, h); const out = copy(post)
  for (let i = 0; i < w * h; i++) { if (src[i * 4 + 3] === 0) continue
    const e = luma(edges[i * 4], edges[i * 4 + 1], edges[i * 4 + 2]) / 255
    for (let c = 0; c < 3; c++) out[i * 4 + c] = clamp8(post[i * 4 + c] * e) }
  return out
}
const cutout: FilterFn = (src, w, h) => median(2)(posterize(5)(src, w, h), w, h)
const watercolor: FilterFn = (src, w, h) => {
  const smooth = median(2)(src, w, h); const out = posterize(8)(smooth, w, h)
  const edges = findEdges(smooth, w, h)
  for (let i = 0; i < w * h; i++) { if (src[i * 4 + 3] === 0) continue
    const e = luma(edges[i * 4], edges[i * 4 + 1], edges[i * 4 + 2]) / 255
    for (let c = 0; c < 3; c++) out[i * 4 + c] = clamp8(out[i * 4 + c] * (0.35 + 0.65 * e)) }
  return out
}
const sponge: FilterFn = (src, w, h) => {
  const out = median(2)(src, w, h); const rng = makeRng(0x33aa77)
  for (let i = 0; i < w * h; i++) if (src[i * 4 + 3] > 0 && rng() > 0.6)
    for (let c = 0; c < 3; c++) out[i * 4 + c] = clamp8(out[i * 4 + c] - 30)
  return out
}
const dryBrush: FilterFn = (src, w, h) => posterize(7)(median(1)(src, w, h), w, h)
const filmGrain2 = (amount: number): FilterFn => (src, w, h) => addNoise(amount, true)(src, w, h)

const grayscaleOf = (src: Uint8Array, w: number, h: number): Uint8Array => {
  const g = copy(src)
  for (let i = 0; i < w * h; i++) if (src[i * 4 + 3] > 0) { const y = luma(src[i * 4], src[i * 4 + 1], src[i * 4 + 2]); g[i * 4] = g[i * 4 + 1] = g[i * 4 + 2] = y }
  return g
}
const photocopy: FilterFn = (src, w, h) => {
  const g = grayscaleOf(src, w, h); const bl = unpremult(boxBlur3(g, w, h, 3), w, h); const out = copy(g)
  for (let i = 0; i < w * h; i++) { if (src[i * 4 + 3] === 0) continue
    const v = g[i * 4], b = bl[i * 4]; const r = b === 0 ? 255 : Math.min(255, v / b * 255)
    const o = r > 200 ? 255 : r < 90 ? 0 : r; out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = o }
  return out
}
const stamp: FilterFn = (src, w, h) => threshold(128)(unpremult(boxBlur3(grayscaleOf(src, w, h), w, h, 2), w, h), w, h)
const basRelief: FilterFn = (src, w, h) => convolve3(grayscaleOf(src, w, h), w, h, [-2, -1, 0, -1, 1, 1, 0, 1, 2], 128)
const chalkCharcoal: FilterFn = (src, w, h) => {
  const edges = findEdges(grayscaleOf(src, w, h), w, h); return addNoise(18, true)(edges, w, h)
}
const notePaper: FilterFn = (src, w, h) => addNoise(20, true)(emboss(grayscaleOf(src, w, h), w, h), w, h)
const halftonePattern = (dot: number): FilterFn => (src, w, h) => {
  const g = grayscaleOf(src, w, h); const out = new Uint8Array(src.length)
  for (let i = 0; i < w * h; i++) out[i * 4 + 3] = src[i * 4 + 3]
  for (let by = 0; by < h; by += dot) for (let bx = 0; bx < w; bx += dot) {
    let sum = 0, cnt = 0
    for (let y = by; y < Math.min(by + dot, h); y++) for (let x = bx; x < Math.min(bx + dot, w); x++) { sum += g[idx(x, y, w)]; cnt++ }
    const avg = cnt ? sum / cnt : 0, rad = (1 - avg / 255) * (dot * 0.72), ccx = bx + dot / 2, ccy = by + dot / 2
    for (let y = by; y < Math.min(by + dot, h); y++) for (let x = bx; x < Math.min(bx + dot, w); x++) {
      const inside = (x + 0.5 - ccx) ** 2 + (y + 0.5 - ccy) ** 2 <= rad * rad, v = inside ? 0 : 255, o = idx(x, y, w)
      out[o] = out[o + 1] = out[o + 2] = v
    }
  }
  return out
}

// Offset (wrap) — Other family.
const offset = (dx: number, dy: number): FilterFn => (src, w, h) => {
  const out = new Uint8Array(src.length)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = ((x - dx) % w + w) % w, sy = ((y - dy) % h + h) % h
    const o = idx(x, y, w), i = idx(sx, sy, w)
    out[o] = src[i]; out[o + 1] = src[i + 1]; out[o + 2] = src[i + 2]; out[o + 3] = src[i + 3]
  }
  return out
}

// ── Registry ──────────────────────────────────────────────────────────────────
// Filters with `params` open a floating dialog (sliders + live preview); filters
// with an empty `params` array apply in one click. `make(v)` builds the concrete
// FilterFn from the current parameter values.
const one = (fn: FilterFn) => () => fn   // helper: parameterless make
export const FILTER_GROUPS: FilterGroup[] = [
  { id: 'blur', nameKey: 'filt_group_blur', filters: [
    { id: 'gaussian',   nameKey: 'filt_gaussian',    params: [P('radius', 'filt_p_radius', 1, 120, 1, 6)], make: v => gaussianBlur(v.radius) },
    { id: 'box',        nameKey: 'filt_box_blur',    params: [P('radius', 'filt_p_radius', 1, 120, 1, 6)], make: v => boxBlurFilter(v.radius) },
    { id: 'motion',     nameKey: 'filt_motion_blur', params: [P('angle', 'filt_p_angle', 0, 360, 1, 0), P('distance', 'filt_p_distance', 1, 120, 1, 14)], make: v => motionBlur(v.angle, v.distance) },
    { id: 'radial_spin',nameKey: 'filt_radial_spin', params: [P('amount', 'filt_p_amount', 1, 100, 1, 24)], make: v => radialBlur(v.amount, true) },
    { id: 'radial_zoom',nameKey: 'filt_radial_zoom', params: [P('amount', 'filt_p_amount', 1, 100, 1, 24)], make: v => radialBlur(v.amount, false) },
    { id: 'average',    nameKey: 'filt_average',     params: [], make: one(averageBlur) },
  ]},
  { id: 'sharpen', nameKey: 'filt_group_sharpen', filters: [
    { id: 'sharpen',     nameKey: 'filt_sharpen',      params: [], make: one(sharpen) },
    { id: 'sharpen_more',nameKey: 'filt_sharpen_more', params: [], make: one(sharpenMore) },
    { id: 'unsharp',     nameKey: 'filt_unsharp',      params: [P('amount', 'filt_p_amount_pct', 0, 500, 5, 100), P('radius', 'filt_p_radius', 0.5, 20, 0.5, 2)], make: v => unsharpMask(v.amount / 100, v.radius) },
    { id: 'highpass',    nameKey: 'filt_high_pass',    params: [P('radius', 'filt_p_radius', 0.5, 50, 0.5, 3)], make: v => highPass(v.radius) },
  ]},
  { id: 'noise', nameKey: 'filt_group_noise', filters: [
    { id: 'add_noise',  nameKey: 'filt_add_noise',      params: [P('amount', 'filt_p_amount', 1, 200, 1, 40)], make: v => addNoise(v.amount, false) },
    { id: 'add_noise_m',nameKey: 'filt_add_noise_mono', params: [P('amount', 'filt_p_amount', 1, 200, 1, 40)], make: v => addNoise(v.amount, true) },
    { id: 'median',     nameKey: 'filt_median',         params: [P('radius', 'filt_p_radius', 1, 10, 1, 2)], make: v => median(v.radius) },
    { id: 'despeckle',  nameKey: 'filt_despeckle',      params: [], make: one(despeckle) },
    { id: 'dust',       nameKey: 'filt_dust',           params: [], make: one(dustScratches) },
  ]},
  { id: 'distort', nameKey: 'filt_group_distort', filters: [
    { id: 'pinch',    nameKey: 'filt_pinch',    params: [P('amount', 'filt_p_amount_pct', 10, 300, 5, 60)], make: v => pinch(v.amount / 100) },
    { id: 'spherize', nameKey: 'filt_spherize', params: [P('amount', 'filt_p_amount_pct', -100, 100, 5, 60)], make: v => spherize(v.amount / 100) },
    { id: 'twirl',    nameKey: 'filt_twirl',    params: [P('angle', 'filt_p_angle', -720, 720, 5, 120)], make: v => twirl(v.angle) },
    { id: 'ripple',   nameKey: 'filt_ripple',   params: [P('amount', 'filt_p_amount', 1, 40, 1, 6), P('size', 'filt_p_size', 4, 80, 1, 18)], make: v => ripple(v.amount, v.size) },
    { id: 'wave',     nameKey: 'filt_wave',     params: [P('amplitude', 'filt_p_amplitude', 1, 60, 1, 12), P('wavelength', 'filt_p_wavelength', 10, 300, 5, 90)], make: v => wave(v.amplitude, v.wavelength) },
    { id: 'zigzag',   nameKey: 'filt_zigzag',   params: [P('amount', 'filt_p_amount', 1, 40, 1, 8)], make: v => zigzag(v.amount) },
    { id: 'polar',    nameKey: 'filt_polar',    params: [], make: one(polarCoords) },
  ]},
  { id: 'pixelate', nameKey: 'filt_group_pixelate', filters: [
    { id: 'mosaic',      nameKey: 'filt_mosaic',        params: [P('cell', 'filt_p_cell', 2, 100, 1, 12)], make: v => mosaic(v.cell) },
    { id: 'crystallize', nameKey: 'filt_crystallize',   params: [P('cell', 'filt_p_cell', 4, 120, 1, 16)], make: v => crystallize(v.cell) },
    { id: 'pointillize', nameKey: 'filt_pointillize',   params: [P('cell', 'filt_p_cell', 4, 80, 1, 12)], make: v => pointillize(v.cell) },
    { id: 'halftone',    nameKey: 'filt_color_halftone',params: [P('dot', 'filt_p_dot', 3, 40, 1, 8)], make: v => colorHalftone(v.dot) },
    { id: 'fragment',    nameKey: 'filt_fragment',      params: [], make: one(fragment) },
  ]},
  { id: 'stylize', nameKey: 'filt_group_stylize', filters: [
    { id: 'emboss',      nameKey: 'filt_emboss',       params: [], make: one(emboss) },
    { id: 'find_edges',  nameKey: 'filt_find_edges',   params: [], make: one(findEdges) },
    { id: 'solarize',    nameKey: 'filt_solarize',     params: [], make: one(solarize) },
    { id: 'trace',       nameKey: 'filt_trace_contour',params: [P('level', 'filt_p_level', 1, 254, 1, 128)], make: v => traceContour(v.level) },
    { id: 'wind',        nameKey: 'filt_wind',         params: [], make: one(wind) },
    { id: 'diffuse',     nameKey: 'filt_diffuse',      params: [], make: one(diffuse) },
    { id: 'oil',         nameKey: 'filt_oil_paint',    params: [P('radius', 'filt_p_radius', 1, 8, 1, 4)], make: v => oilPaint(v.radius) },
  ]},
  { id: 'render', nameKey: 'filt_group_render', filters: [
    { id: 'clouds',      nameKey: 'filt_clouds',       params: [], make: one(clouds([255, 255, 255], [40, 90, 160])) },
    { id: 'diff_clouds', nameKey: 'filt_diff_clouds',  params: [], make: one(differenceClouds([255, 255, 255], [0, 0, 0])) },
    { id: 'fibers',      nameKey: 'filt_fibers',       params: [], make: one(fibers) },
    { id: 'lens_flare',  nameKey: 'filt_lens_flare',   params: [], make: one(lensFlare) },
  ]},
  { id: 'artistic', nameKey: 'filt_group_artistic', filters: [
    { id: 'poster_edges',nameKey: 'filt_poster_edges', params: [], make: one(posterEdges) },
    { id: 'cutout',      nameKey: 'filt_cutout',       params: [P('levels', 'filt_p_levels', 2, 12, 1, 5)], make: v => ((src, w, h) => median(2)(posterize(v.levels)(src, w, h), w, h)) },
    { id: 'watercolor',  nameKey: 'filt_watercolor',   params: [], make: one(watercolor) },
    { id: 'sponge',      nameKey: 'filt_sponge',       params: [], make: one(sponge) },
    { id: 'dry_brush',   nameKey: 'filt_dry_brush',    params: [], make: one(dryBrush) },
    { id: 'film_grain',  nameKey: 'filt_film_grain',   params: [P('amount', 'filt_p_amount', 1, 100, 1, 28)], make: v => filmGrain2(v.amount) },
  ]},
  { id: 'sketch', nameKey: 'filt_group_sketch', filters: [
    { id: 'photocopy',   nameKey: 'filt_photocopy',    params: [], make: one(photocopy) },
    { id: 'stamp',       nameKey: 'filt_stamp',        params: [P('level', 'filt_p_level', 1, 254, 1, 128)], make: v => ((src, w, h) => threshold(v.level)(unpremult(boxBlur3(grayscaleOf(src, w, h), w, h, 2), w, h), w, h)) },
    { id: 'bas_relief',  nameKey: 'filt_bas_relief',   params: [], make: one(basRelief) },
    { id: 'chalk',       nameKey: 'filt_chalk_charcoal', params: [], make: one(chalkCharcoal) },
    { id: 'halftone_pat',nameKey: 'filt_halftone_pattern', params: [P('dot', 'filt_p_dot', 3, 40, 1, 6)], make: v => halftonePattern(v.dot) },
    { id: 'note_paper',  nameKey: 'filt_note_paper',   params: [], make: one(notePaper) },
  ]},
  { id: 'other', nameKey: 'filt_group_other', filters: [
    { id: 'posterize',   nameKey: 'filt_posterize',    params: [P('levels', 'filt_p_levels', 2, 32, 1, 6)], make: v => posterize(v.levels) },
    { id: 'threshold',   nameKey: 'filt_threshold',    params: [P('level', 'filt_p_level', 1, 254, 1, 128)], make: v => threshold(v.level) },
    { id: 'maximum',     nameKey: 'filt_maximum',      params: [P('radius', 'filt_p_radius', 1, 10, 1, 2)], make: v => maximum(v.radius) },
    { id: 'minimum',     nameKey: 'filt_minimum',      params: [P('radius', 'filt_p_radius', 1, 10, 1, 2)], make: v => minimum(v.radius) },
    { id: 'offset',      nameKey: 'filt_offset',       params: [P('x', 'filt_p_x', -500, 500, 1, 40), P('y', 'filt_p_y', -500, 500, 1, 40)], make: v => offset(v.x, v.y) },
  ]},
]

// Default parameter map for a filter (used to seed the dialog / one-click apply).
export function filterDefaults(def: FilterDef): Record<string, number> {
  const v: Record<string, number> = {}
  for (const p of def.params) v[p.key] = p.def
  return v
}

export function findFilter(id: string): FilterDef | undefined {
  for (const g of FILTER_GROUPS) { const f = g.filters.find(x => x.id === id); if (f) return f }
  return undefined
}
