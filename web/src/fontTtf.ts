// Native TrueType (.ttf) writer for FontEditor projects — no dependency.
// Converts the editor's cubic Bézier contours to quadratic ones (adaptive
// splitting) and emits the sfnt tables: cmap(4), glyf, head, hhea, hmtx, loca,
// maxp, name, OS/2, post — plus an old-style `kern` table when the project has
// kerning pairs (something the CFF/OTF export path cannot carry).
import type { FontContour, FontData } from './api'
import { flattenContour, normalizeWindings, reverseContour, segmentControls } from './fontGeometry'

// ── Quadratic conversion ────────────────────────────────────────────────────────

interface QPoint { x: number; y: number; on: boolean }

/** Splits one cubic segment into `n` sub-cubics and approximates each by a quad. */
function cubicToQuads(
  p0: [number, number], c1: [number, number], c2: [number, number], p1: [number, number],
  tol: number,
): { cx: number; cy: number; x: number; y: number }[] {
  // Error bound for the single-quad approximation: sqrt(3)/36 · ‖P3 − 3P2 + 3P1 − P0‖.
  const ex = p1[0] - 3 * c2[0] + 3 * c1[0] - p0[0]
  const ey = p1[1] - 3 * c2[1] + 3 * c1[1] - p0[1]
  const err = (Math.sqrt(3) / 36) * Math.hypot(ex, ey)
  const n = Math.max(1, Math.min(8, Math.ceil(Math.cbrt(err / Math.max(tol, 0.1)))))

  const at = (t: number): [number, number] => {
    const mt = 1 - t
    return [
      mt * mt * mt * p0[0] + 3 * mt * mt * t * c1[0] + 3 * mt * t * t * c2[0] + t * t * t * p1[0],
      mt * mt * mt * p0[1] + 3 * mt * mt * t * c1[1] + 3 * mt * t * t * c2[1] + t * t * t * p1[1],
    ]
  }
  const deriv = (t: number): [number, number] => {
    const mt = 1 - t
    return [
      3 * mt * mt * (c1[0] - p0[0]) + 6 * mt * t * (c2[0] - c1[0]) + 3 * t * t * (p1[0] - c2[0]),
      3 * mt * mt * (c1[1] - p0[1]) + 6 * mt * t * (c2[1] - c1[1]) + 3 * t * t * (p1[1] - c2[1]),
    ]
  }

  const quads: { cx: number; cy: number; x: number; y: number }[] = []
  for (let i = 0; i < n; i++) {
    const t0 = i / n, t1 = (i + 1) / n
    const a = at(t0), b = at(t1)
    // Quad control = intersection of the sub-curve's end tangents (fallback midpoint).
    const d0 = deriv(t0), d1 = deriv(t1)
    const den = d0[0] * d1[1] - d0[1] * d1[0]
    let cx: number, cy: number
    if (Math.abs(den) > 1e-6) {
      const s = ((b[0] - a[0]) * d1[1] - (b[1] - a[1]) * d1[0]) / den
      cx = a[0] + d0[0] * s
      cy = a[1] + d0[1] * s
    } else {
      cx = (a[0] + b[0]) / 2
      cy = (a[1] + b[1]) / 2
    }
    quads.push({ cx, cy, x: b[0], y: b[1] })
  }
  return quads
}

/** Cubic contour (y-up font units) → TrueType quadratic point list. */
function contourToQuadPoints(contour: FontContour, tol: number): QPoint[] {
  const pts: QPoint[] = []
  const n = contour.length
  if (n < 2) return pts
  for (let i = 0; i < n; i++) {
    const a = contour[i], b = contour[(i + 1) % n]
    pts.push({ x: Math.round(a.x), y: Math.round(a.y), on: true })
    const { c1, c2, curved } = segmentControls(a, b)
    if (!curved) continue
    const quads = cubicToQuads([a.x, a.y], c1, c2, [b.x, b.y], tol)
    for (let q = 0; q < quads.length; q++) {
      pts.push({ x: Math.round(quads[q].cx), y: Math.round(quads[q].cy), on: false })
      // The last quad's end point IS the next anchor — pushed by the next loop turn.
      if (q < quads.length - 1) pts.push({ x: Math.round(quads[q].x), y: Math.round(quads[q].y), on: true })
    }
  }
  return pts
}

// ── Binary writer ───────────────────────────────────────────────────────────────

class W {
  private a = new Uint8Array(1024)
  private v = new DataView(this.a.buffer)
  len = 0

  private ensure(n: number) {
    if (this.len + n <= this.a.length) return
    const next = new Uint8Array(Math.max(this.a.length * 2, this.len + n))
    next.set(this.a)
    this.a = next
    this.v = new DataView(next.buffer)
  }
  u8(x: number)  { this.ensure(1); this.v.setUint8(this.len, x & 0xFF); this.len += 1 }
  u16(x: number) { this.ensure(2); this.v.setUint16(this.len, x & 0xFFFF); this.len += 2 }
  i16(x: number) { this.ensure(2); this.v.setInt16(this.len, x); this.len += 2 }
  u32(x: number) { this.ensure(4); this.v.setUint32(this.len, x >>> 0); this.len += 4 }
  i32(x: number) { this.ensure(4); this.v.setInt32(this.len, x); this.len += 4 }
  tag(s: string) { for (let i = 0; i < 4; i++) this.u8(s.charCodeAt(i)) }
  raw(b: Uint8Array) { this.ensure(b.length); this.a.set(b, this.len); this.len += b.length }
  padTo(align: number) { while (this.len % align) this.u8(0) }
  bytes(): Uint8Array { return this.a.slice(0, this.len) }
}

function checksum(data: Uint8Array): number {
  let sum = 0
  for (let i = 0; i < data.length; i += 4) {
    const b0 = data[i] ?? 0, b1 = data[i + 1] ?? 0, b2 = data[i + 2] ?? 0, b3 = data[i + 3] ?? 0
    sum = (sum + ((b0 << 24 >>> 0) + (b1 << 16) + (b2 << 8) + b3)) >>> 0
  }
  return sum >>> 0
}

// ── Glyph preparation ───────────────────────────────────────────────────────────

interface TtfGlyph {
  unicode:  number        // 0 for .notdef
  advance:  number
  contours: QPoint[][]
  xMin: number; yMin: number; xMax: number; yMax: number
  empty: boolean
}

function prepGlyph(unicode: number, advance: number, cubic: FontContour[], tol: number): TtfGlyph {
  // TrueType winding: outer contours CLOCKWISE (y-up) — the inverse of CFF.
  const contours = normalizeWindings(cubic.filter(c => c.length >= 2))
    .map(reverseContour)
    .map(c => contourToQuadPoints(c, tol))
    .filter(c => c.length >= 3)
  let xMin = 0, yMin = 0, xMax = 0, yMax = 0
  const flat = contours.flat()
  if (flat.length) {
    xMin = Math.min(...flat.map(p => p.x)); xMax = Math.max(...flat.map(p => p.x))
    yMin = Math.min(...flat.map(p => p.y)); yMax = Math.max(...flat.map(p => p.y))
  }
  return { unicode, advance: Math.max(0, Math.round(advance)), contours, xMin, yMin, xMax, yMax, empty: flat.length === 0 }
}

function notdefContours(upem: number, cap: number): FontContour[] {
  const w = Math.round(upem * 0.5), m = Math.round(upem * 0.06)
  return [
    [{ x: m, y: 0 }, { x: w - m, y: 0 }, { x: w - m, y: cap }, { x: m, y: cap }],
    [{ x: 2 * m, y: m }, { x: 2 * m, y: cap - m }, { x: w - 2 * m, y: cap - m }, { x: w - 2 * m, y: m }],
  ]
}

// ── glyf ────────────────────────────────────────────────────────────────────────

function writeGlyf(glyphs: TtfGlyph[]): { glyf: Uint8Array; loca: number[] } {
  const w = new W()
  const loca: number[] = [0]
  for (const g of glyphs) {
    if (g.empty) { loca.push(w.len); continue }
    w.i16(g.contours.length)
    w.i16(g.xMin); w.i16(g.yMin); w.i16(g.xMax); w.i16(g.yMax)
    const pts = g.contours.flat()
    let end = -1
    for (const c of g.contours) { end += c.length; w.u16(end) }
    w.u16(0) // no instructions

    // Flags + compact coordinate encoding.
    const flags: number[] = []
    const xb: number[] = []   // pending x bytes (mixed u8/i16 encoded later)
    const yb: number[] = []
    const xIsShort: boolean[] = []
    const yIsShort: boolean[] = []
    let px = 0, py = 0
    for (const p of pts) {
      let f = p.on ? 0x01 : 0x00
      const dx = p.x - px, dy = p.y - py
      if (dx === 0) f |= 0x10
      else if (dx >= -255 && dx <= 255) { f |= 0x02; if (dx > 0) f |= 0x10; xb.push(Math.abs(dx)); xIsShort.push(true) }
      else { xb.push(dx); xIsShort.push(false) }
      if (dy === 0) f |= 0x20
      else if (dy >= -255 && dy <= 255) { f |= 0x04; if (dy > 0) f |= 0x20; yb.push(Math.abs(dy)); yIsShort.push(true) }
      else { yb.push(dy); yIsShort.push(false) }
      flags.push(f)
      px = p.x; py = p.y
    }
    for (const f of flags) w.u8(f)
    xb.forEach((v, i) => { if (xIsShort[i]) w.u8(v); else w.i16(v) })
    yb.forEach((v, i) => { if (yIsShort[i]) w.u8(v); else w.i16(v) })
    w.padTo(2)
    loca.push(w.len)
  }
  w.padTo(4)
  return { glyf: w.bytes(), loca }
}

// ── cmap format 4 ───────────────────────────────────────────────────────────────

function writeCmap(glyphs: TtfGlyph[]): Uint8Array {
  // gid = index in `glyphs`; glyphs[0] = .notdef, the rest sorted by unicode.
  const runs: { start: number; end: number; gid: number }[] = []
  for (let i = 1; i < glyphs.length; i++) {
    const u = glyphs[i].unicode
    const last = runs[runs.length - 1]
    if (last && u === last.end + 1 && (last.gid + (last.end - last.start) + 1) === i) last.end = u
    else runs.push({ start: u, end: u, gid: i })
  }
  const segs = [...runs.map(r => ({ start: r.start, end: r.end, delta: (r.gid - r.start) & 0xFFFF })),
                { start: 0xFFFF, end: 0xFFFF, delta: 1 }]
  const segCount = segs.length
  const sub = new W()
  sub.u16(4)                       // format
  sub.u16(16 + segCount * 8)       // length
  sub.u16(0)                       // language
  const segCountX2 = segCount * 2
  const searchRange = 2 ** Math.floor(Math.log2(segCount)) * 2
  sub.u16(segCountX2)
  sub.u16(searchRange)
  sub.u16(Math.log2(searchRange / 2))
  sub.u16(segCountX2 - searchRange)
  for (const s of segs) sub.u16(s.end)
  sub.u16(0)                       // reservedPad
  for (const s of segs) sub.u16(s.start)
  for (const s of segs) sub.u16(s.delta)
  for (let i = 0; i < segCount; i++) sub.u16(0)   // idRangeOffset

  const w = new W()
  w.u16(0)      // version
  w.u16(2)      // two encoding records (Unicode + Windows), same subtable
  w.u16(0); w.u16(3); w.u32(4 + 2 * 8)
  w.u16(3); w.u16(1); w.u32(4 + 2 * 8)
  w.raw(sub.bytes())
  return w.bytes()
}

// ── name ────────────────────────────────────────────────────────────────────────

function writeName(family: string, style: string): Uint8Array {
  const full = style.toLowerCase() === 'regular' ? family : `${family} ${style}`
  const ps = `${family.replace(/[^\x21-\x7E]/g, '')}-${style.replace(/[^\x21-\x7E]/g, '')}`.replace(/\s/g, '')
  const entries: [number, string][] = [
    [1, family], [2, style], [3, `${full};Kubuno FontEditor`], [4, full], [6, ps || 'KubunoFont'],
  ]
  const storage = new W()
  const records: { id: number; off: number; len: number }[] = []
  for (const [id, str] of entries) {
    const off = storage.len
    for (const ch of str) {
      const cp = ch.codePointAt(0)!
      storage.u16(cp > 0xFFFF ? 0xFFFD : cp)   // UTF-16BE, BMP only
    }
    records.push({ id, off, len: storage.len - off })
  }
  const w = new W()
  w.u16(0)                         // format
  w.u16(records.length)
  w.u16(6 + records.length * 12)   // storage offset
  for (const r of records) {
    w.u16(3); w.u16(1); w.u16(0x0409)   // Windows / Unicode BMP / en-US
    w.u16(r.id); w.u16(r.len); w.u16(r.off)
  }
  w.raw(storage.bytes())
  return w.bytes()
}

// ── kern (format 0) ─────────────────────────────────────────────────────────────

function writeKern(pairs: { l: number; r: number; v: number }[]): Uint8Array {
  pairs.sort((a, b) => (a.l - b.l) || (a.r - b.r))
  const n = pairs.length
  const w = new W()
  w.u16(0)    // table version
  w.u16(1)    // nTables
  w.u16(0)    // subtable version
  w.u16(14 + n * 6)
  w.u16(0x0001)   // coverage: horizontal
  w.u16(n)
  const searchRange = 2 ** Math.floor(Math.log2(Math.max(1, n))) * 6
  w.u16(searchRange)
  w.u16(Math.floor(Math.log2(Math.max(1, n))))
  w.u16(n * 6 - searchRange)
  for (const p of pairs) { w.u16(p.l); w.u16(p.r); w.i16(p.v) }
  return w.bytes()
}

// ── Main builder ────────────────────────────────────────────────────────────────

export function buildTtf(data: FontData): ArrayBuffer {
  const upem = Math.max(16, Math.round(data.unitsPerEm) || 1000)
  const ascender = Math.max(1, Math.round(data.ascender) || Math.round(upem * 0.8))
  const descender = Math.min(-1, Math.round(data.descender) || -Math.round(upem * 0.2))
  const capHeight = Math.round(data.capHeight) || Math.round(upem * 0.7)
  const xHeight = Math.round(data.xHeight) || Math.round(upem * 0.5)
  const tol = Math.max(1, upem / 500)   // quad approximation tolerance (font units)

  // Glyph set: .notdef + drawn glyphs (BMP) + a space fallback.
  const entries = Object.values(data.glyphs)
    .filter(g => (g.contours.length > 0 || g.unicode === 32) && g.unicode > 0 && g.unicode <= 0xFFFF)
    .sort((a, b) => a.unicode - b.unicode)
  const glyphs: TtfGlyph[] = [prepGlyph(0, Math.round(upem * 0.5), notdefContours(upem, capHeight), tol)]
  if (!entries.some(g => g.unicode === 32)) {
    glyphs.push(prepGlyph(32, Math.round(upem * 0.3), [], tol))
    // keep unicode order: re-sort below
  }
  for (const g of entries) glyphs.push(prepGlyph(g.unicode, g.advance, g.contours, tol))
  const tail = glyphs.slice(1).sort((a, b) => a.unicode - b.unicode)
  glyphs.splice(1, glyphs.length - 1, ...tail)

  const gidOf = new Map<number, number>()
  glyphs.forEach((g, i) => { if (g.unicode) gidOf.set(g.unicode, i) })

  const drawn = glyphs.filter(g => !g.empty)
  const xMin = drawn.length ? Math.min(...drawn.map(g => g.xMin)) : 0
  const yMin = drawn.length ? Math.min(...drawn.map(g => g.yMin)) : 0
  const xMax = drawn.length ? Math.max(...drawn.map(g => g.xMax)) : 0
  const yMax = drawn.length ? Math.max(...drawn.map(g => g.yMax)) : 0

  const { glyf, loca } = writeGlyf(glyphs)

  // loca (long format)
  const locaW = new W()
  for (const off of loca) locaW.u32(off)

  // hmtx
  const hmtx = new W()
  for (const g of glyphs) { hmtx.u16(g.advance); hmtx.i16(g.empty ? 0 : g.xMin) }

  // head
  const head = new W()
  head.u32(0x00010000)             // version 1.0
  head.u32(0x00010000)             // fontRevision 1.0
  head.u32(0)                      // checkSumAdjustment (patched later)
  head.u32(0x5F0F3CF5)             // magic
  head.u16(0x0003)                 // flags: baseline y=0, lsb x=xMin
  head.u16(upem)
  const now = Math.floor(Date.now() / 1000) + 2082844800   // seconds since 1904
  head.u32(0); head.u32(now)       // created
  head.u32(0); head.u32(now)       // modified
  head.i16(xMin); head.i16(yMin); head.i16(xMax); head.i16(yMax)
  head.u16(0)                      // macStyle
  head.u16(8)                      // lowestRecPPEM
  head.i16(2)                      // fontDirectionHint
  head.i16(1)                      // indexToLocFormat: long
  head.i16(0)                      // glyphDataFormat

  // hhea
  const hhea = new W()
  hhea.u32(0x00010000)
  hhea.i16(ascender)
  hhea.i16(descender)
  hhea.i16(0)                      // lineGap
  hhea.u16(Math.max(...glyphs.map(g => g.advance), 1))
  hhea.i16(drawn.length ? Math.min(...drawn.map(g => g.xMin)) : 0)   // minLSB
  hhea.i16(drawn.length ? Math.min(...drawn.map(g => g.advance - g.xMax)) : 0)
  hhea.i16(xMax)                   // xMaxExtent
  hhea.i16(1); hhea.i16(0)         // caretSlope rise/run
  hhea.i16(0)                      // caretOffset
  hhea.i16(0); hhea.i16(0); hhea.i16(0); hhea.i16(0)   // reserved
  hhea.i16(0)                      // metricDataFormat
  hhea.u16(glyphs.length)          // numberOfHMetrics

  // maxp v1.0
  const maxp = new W()
  maxp.u32(0x00010000)
  maxp.u16(glyphs.length)
  maxp.u16(Math.max(0, ...glyphs.map(g => g.contours.flat().length)))
  maxp.u16(Math.max(0, ...glyphs.map(g => g.contours.length)))
  maxp.u16(0); maxp.u16(0)         // composite points/contours
  maxp.u16(2)                      // maxZones
  maxp.u16(0)                      // maxTwilightPoints
  maxp.u16(0)                      // maxStorage
  maxp.u16(0)                      // maxFunctionDefs
  maxp.u16(0)                      // maxInstructionDefs
  maxp.u16(0)                      // maxStackElements
  maxp.u16(0)                      // maxSizeOfInstructions
  maxp.u16(0); maxp.u16(0)         // component elements/depth

  // OS/2 v4
  const os2 = new W()
  os2.u16(4)
  const avg = Math.round(glyphs.reduce((s, g) => s + g.advance, 0) / glyphs.length) || upem / 2
  os2.i16(avg)
  os2.u16(400); os2.u16(5)         // weight / width
  os2.u16(0)                       // fsType: installable
  os2.i16(Math.round(upem * 0.65)); os2.i16(Math.round(upem * 0.6))
  os2.i16(0); os2.i16(Math.round(upem * 0.075))
  os2.i16(Math.round(upem * 0.65)); os2.i16(Math.round(upem * 0.6))
  os2.i16(0); os2.i16(Math.round(upem * 0.35))
  os2.i16(Math.round(upem * 0.05)); os2.i16(Math.round(xHeight * 0.6))
  os2.i16(0)                       // sFamilyClass
  for (let i = 0; i < 10; i++) os2.u8(0)   // panose
  os2.u32(0x00000003); os2.u32(0); os2.u32(0); os2.u32(0)   // unicode ranges: Basic Latin + Latin-1
  os2.tag('KBNO')
  os2.u16(0x0040)                  // fsSelection: REGULAR
  os2.u16(glyphs[1]?.unicode ?? 32)
  os2.u16(glyphs[glyphs.length - 1]?.unicode ?? 32)
  os2.i16(ascender); os2.i16(descender); os2.i16(0)
  os2.u16(Math.max(yMax, ascender)); os2.u16(Math.max(-Math.min(yMin, descender), 0))
  os2.u32(0x00000001); os2.u32(0)  // codepage: Latin 1
  os2.i16(xHeight); os2.i16(capHeight)
  os2.u16(0); os2.u16(32)          // default/break char
  os2.u16(2)                       // usMaxContext (kern pairs)

  // post v3 (no glyph names)
  const post = new W()
  post.u32(0x00030000)
  post.u32(0)                      // italicAngle
  post.i16(Math.round(-upem * 0.075)); post.i16(Math.round(upem * 0.05))
  post.u32(0)                      // isFixedPitch
  post.u32(0); post.u32(0); post.u32(0); post.u32(0)

  const tables: { tag: string; data: Uint8Array }[] = [
    { tag: 'OS/2', data: os2.bytes() },
    { tag: 'cmap', data: writeCmap(glyphs) },
    { tag: 'glyf', data: glyf },
    { tag: 'head', data: head.bytes() },
    { tag: 'hhea', data: hhea.bytes() },
    { tag: 'hmtx', data: hmtx.bytes() },
    { tag: 'loca', data: locaW.bytes() },
    { tag: 'maxp', data: maxp.bytes() },
    { tag: 'name', data: writeName(data.familyName || 'Sans titre', data.styleName || 'Regular') },
    { tag: 'post', data: post.bytes() },
  ]

  // kern — only pairs whose two glyphs made it into the font.
  const kernPairs = (data.kerning ?? [])
    .filter(k => gidOf.has(k.left) && gidOf.has(k.right) && Math.round(k.value) !== 0)
    .map(k => ({ l: gidOf.get(k.left)!, r: gidOf.get(k.right)!, v: Math.round(k.value) }))
  if (kernPairs.length) tables.push({ tag: 'kern', data: writeKern(kernPairs) })

  tables.sort((a, b) => (a.tag < b.tag ? -1 : 1))

  // sfnt directory
  const numTables = tables.length
  const out = new W()
  out.u32(0x00010000)
  out.u16(numTables)
  const entrySelector = Math.floor(Math.log2(numTables))
  const searchRange = 2 ** entrySelector * 16
  out.u16(searchRange); out.u16(entrySelector); out.u16(numTables * 16 - searchRange)

  let offset = 12 + numTables * 16
  const dir: { tag: string; checksum: number; offset: number; length: number }[] = []
  for (const t of tables) {
    dir.push({ tag: t.tag, checksum: checksum(t.data), offset, length: t.data.length })
    offset += Math.ceil(t.data.length / 4) * 4
  }
  for (const d of dir) { out.tag(d.tag); out.u32(d.checksum); out.u32(d.offset); out.u32(d.length) }
  for (const t of tables) { out.raw(t.data); out.padTo(4) }

  // head.checkSumAdjustment over the whole font.
  const bytes = out.bytes()
  const total = checksum(bytes)
  const adjustment = (0xB1B0AFBA - total) >>> 0
  const headOffset = dir.find(d => d.tag === 'head')!.offset
  new DataView(bytes.buffer, bytes.byteOffset).setUint32(headOffset + 8, adjustment)

  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) as ArrayBuffer
}
