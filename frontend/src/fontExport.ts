// OTF (CFF) build for FontEditor projects, built on opentype.js. The editor's
// cubic Bézier contours map 1:1 onto CFF charstrings — no quadratic conversion
// needed. Upload/download orchestration lives in fontFormats.ts.
import { Font, Glyph, Path } from 'opentype.js'
import type { FontContour, FontData } from './api'
import { normalizeWindings, segmentControls } from './fontGeometry'

// Minimal AGLFN naming for ASCII; anything else falls back to uniXXXX.
const ASCII_NAMES: Record<number, string> = {
  32: 'space', 33: 'exclam', 34: 'quotedbl', 35: 'numbersign', 36: 'dollar',
  37: 'percent', 38: 'ampersand', 39: 'quotesingle', 40: 'parenleft',
  41: 'parenright', 42: 'asterisk', 43: 'plus', 44: 'comma', 45: 'hyphen',
  46: 'period', 47: 'slash', 58: 'colon', 59: 'semicolon', 60: 'less',
  61: 'equal', 62: 'greater', 63: 'question', 64: 'at', 91: 'bracketleft',
  92: 'backslash', 93: 'bracketright', 94: 'asciicircum', 95: 'underscore',
  96: 'grave', 123: 'braceleft', 124: 'bar', 125: 'braceright', 126: 'asciitilde',
  48: 'zero', 49: 'one', 50: 'two', 51: 'three', 52: 'four', 53: 'five',
  54: 'six', 55: 'seven', 56: 'eight', 57: 'nine',
}

function glyphName(cp: number): string {
  if (ASCII_NAMES[cp]) return ASCII_NAMES[cp]
  if ((cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122)) return String.fromCodePoint(cp)
  return `uni${cp.toString(16).toUpperCase().padStart(4, '0')}`
}

function contoursToPath(contours: FontContour[]): Path {
  const path = new Path()
  for (const contour of normalizeWindings(contours)) {
    if (contour.length < 2) continue
    const first = contour[0]
    path.moveTo(first.x, first.y)
    for (let i = 0; i < contour.length; i++) {
      const a = contour[i], b = contour[(i + 1) % contour.length]
      const { c1, c2, curved } = segmentControls(a, b)
      if (curved) path.curveTo(c1[0], c1[1], c2[0], c2[1], b.x, b.y)
      else path.lineTo(b.x, b.y)
    }
    path.close()
  }
  return path
}

/** Simple hollow-rectangle .notdef, scaled to the font's metrics. */
function notdefPath(upem: number, capHeight: number): Path {
  const p = new Path()
  const w = Math.round(upem * 0.5), m = Math.round(upem * 0.06)
  // Outer counter-clockwise, inner clockwise (nonzero fill).
  p.moveTo(m, 0); p.lineTo(w - m, 0); p.lineTo(w - m, capHeight); p.lineTo(m, capHeight); p.close()
  p.moveTo(2 * m, m); p.lineTo(2 * m, capHeight - m); p.lineTo(w - 2 * m, capHeight - m); p.lineTo(w - 2 * m, m); p.close()
  return p
}

export function buildOtfFont(data: FontData): Font {
  const upem      = Math.max(16, Math.round(data.unitsPerEm) || 1000)
  const ascender  = Math.max(1, Math.round(data.ascender) || Math.round(upem * 0.8))
  const descender = Math.min(-1, Math.round(data.descender) || -Math.round(upem * 0.2))

  const glyphs: Glyph[] = [
    new Glyph({
      name: '.notdef', unicode: 0,
      advanceWidth: Math.round(upem * 0.5),
      path: notdefPath(upem, Math.round(data.capHeight) || Math.round(upem * 0.7)),
    }),
  ]

  const entries = Object.values(data.glyphs)
    .filter(g => g.contours.length > 0 || g.unicode === 32)
    .sort((a, b) => a.unicode - b.unicode)

  // Always ship a space glyph so exported fonts are usable out of the box.
  if (!entries.some(g => g.unicode === 32)) {
    glyphs.push(new Glyph({ name: 'space', unicode: 32, advanceWidth: Math.round(upem * 0.3), path: new Path() }))
  }

  for (const g of entries) {
    glyphs.push(new Glyph({
      name:         glyphName(g.unicode),
      unicode:      g.unicode,
      advanceWidth: Math.max(0, Math.round(g.advance)),
      path:         contoursToPath(g.contours),
    }))
  }

  return new Font({
    familyName: (data.familyName || 'Sans titre').trim() || 'Sans titre',
    styleName:  (data.styleName || 'Regular').trim() || 'Regular',
    unitsPerEm: upem,
    ascender,
    descender,
    glyphs,
  })
}
