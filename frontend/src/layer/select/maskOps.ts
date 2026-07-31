// Single-channel (selection mask) morphology & blur.
// Extracted verbatim from LayerEditorPage during the layer/ refactor.

/** Separable box blur on a Uint8 mask (used by "feather"). 3 iterations ≈ Gaussian. */
export function maskBlur(src: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  const r = Math.max(1, Math.round(radius / 2))
  const win = r * 2 + 1
  let a = new Float32Array(src), b = new Float32Array(src.length)
  const pass = (s: Float32Array, d: Float32Array, horiz: boolean) => {
    const outer = horiz ? h : w, inner = horiz ? w : h
    for (let o = 0; o < outer; o++) {
      const at = (i: number) => horiz ? o * w + i : i * w + o
      let sum = 0
      for (let k = -r; k <= r; k++) sum += s[at(Math.max(0, Math.min(inner - 1, k)))]
      for (let i = 0; i < inner; i++) {
        d[at(i)] = sum / win
        const ia = Math.max(0, Math.min(inner - 1, i - r)), ib = Math.max(0, Math.min(inner - 1, i + r + 1))
        sum += s[at(ib)] - s[at(ia)]
      }
    }
  }
  for (let it = 0; it < 3; it++) { pass(a, b, true); pass(b, a, false) }
  const out = new Uint8Array(src.length)
  for (let i = 0; i < out.length; i++) out[i] = Math.round(a[i])
  return out
}

/** Chebyshev dilation (grow) / erosion (shrink) via two separable max/min passes. */
export function maskMorph(src: Uint8Array, w: number, h: number, radius: number, grow: boolean): Uint8Array {
  const r = Math.max(1, Math.round(radius))
  const pick = grow ? Math.max : Math.min
  const pass = (s: Uint8Array, horiz: boolean): Uint8Array => {
    const d = new Uint8Array(s.length)
    const outer = horiz ? h : w, inner = horiz ? w : h
    for (let o = 0; o < outer; o++) {
      const at = (i: number) => horiz ? o * w + i : i * w + o
      for (let i = 0; i < inner; i++) {
        let v = s[at(i)]
        for (let k = 1; k <= r; k++) {
          if (i - k >= 0)      v = pick(v, s[at(i - k)])
          if (i + k < inner)   v = pick(v, s[at(i + k)])
        }
        d[at(i)] = v
      }
    }
    return d
  }
  return pass(pass(src, true), false)
}
