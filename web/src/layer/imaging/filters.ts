// Per-layer filters (blur / sharpen / noise) applied on the CPU.
// Extracted verbatim from LayerEditorPage during the layer/ refactor.

export type Filter = { blur: number; sharpen: number; noise: number } // blur 0..20px, sharpen 0..100, noise 0..100

export const FILTER_ZERO: Filter = { blur: 0, sharpen: 0, noise: 0 }

export function filterIsZero(f: Filter): boolean { return f.blur === 0 && f.sharpen === 0 && f.noise === 0 }

/**
 * Premultiplied separable box blur, 3 iterations ≈ Gaussian. Radius-independent
 * cost (running sums) so even large blurs preview instantly. Returns premultiplied
 * RGBA floats (channel 3 = alpha 0..255).
 */
export function boxBlur3(px: Uint8Array, w: number, h: number, radiusPx: number): Float32Array {
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

export function applyFilters(src: Uint8Array, w: number, h: number, f: Filter): Uint8Array {
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
