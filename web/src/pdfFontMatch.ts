// Match a PDF's embedded font name onto the closest available family.
//
// pdf.js exposes the real font name via `page.commonObjs.get(fontName).name`,
// e.g. "BAAAAA+LiberationSerif", "ArialMT", "Calibri-BoldItalic",
// "TimesNewRomanPS-BoldMT". We clean it down to a base family + bold/italic
// flags, then fuzzy-match it against the families the editor can actually offer
// (built-in standard-14 aliases + admin-provided System/Fonts). When nothing
// matches we fall back to the generic serif/sans/mono bucket so the text still
// reads sensibly instead of silently becoming Helvetica everywhere.

export interface ResolvedFont {
  family: string
  bold: boolean
  italic: boolean
}

const STYLE_WORDS = /\b(?:extrabold|ultrabold|semibold|demibold|extralight|ultralight|bold|italic|oblique|black|heavy|thin|light|medium|regular|normal|roman|book|condensed|narrow|display|text|caption|subhead|mt|ps|psmt|w\d{1,3}|\d{3})\b/gi

/** Normalize for comparison: lowercase, keep only alphanumerics. */
export function normFamily(s: string): string {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Split a font name into a clean display family + detected bold/italic. */
export function cleanFontName(raw: string): { base: string; bold: boolean; italic: boolean } {
  let s = (raw || '').trim()
  s = s.replace(/^[A-Z]{6}\+/, '')                 // subset prefix "ABCDEF+"
  const probe = s.toLowerCase()
  const bold = /bold|black|heavy|semibold|demibold|extrabold|ultrabold/.test(probe)
  const italic = /italic|oblique/.test(probe)
  // Split camelCase / joined words so tokens are separable ("TimesNewRomanPSMT").
  s = s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[-_,]+/g, ' ')
  s = s.replace(STYLE_WORDS, ' ')                  // drop weight/style/technical tokens
  s = s.replace(/\s+/g, ' ').trim()
  if (!s) s = raw.replace(/^[A-Z]{6}\+/, '').replace(/[-_,].*$/, '').trim()
  return { base: s, bold, italic }
}

function genericToBase(generic: string | undefined): string {
  const g = (generic || '').toLowerCase()
  if (/mono/.test(g)) return 'Courier New'
  if (/serif/.test(g) && !/sans/.test(g)) return 'Times New Roman'
  return 'Helvetica'
}

// Guess serif/sans/mono from the cleaned family NAME itself. pdf.js sometimes
// reports a wrong generic fallback (e.g. a monospace font tagged 'sans-serif'),
// so a keyword in the real name is a more reliable signal when present.
function natureFromName(base: string): string {
  const s = base.toLowerCase()
  if (/mono|courier|consol|typewriter/.test(s)) return 'monospace'
  if (/sans|arial|helvetica|verdana|tahoma|calibri|segoe|roboto|noto sans|open ?sans|frutiger|myriad|futura/.test(s)) return 'sans-serif'
  if (/serif|times|georgia|garamond|roman|minion|caslon|didot|palatino|cambria|baskerville/.test(s)) return 'serif'
  return ''
}

/**
 * Resolve a PDF font onto the closest available family.
 * @param realName   the embedded name (commonObjs `.name`), may be empty
 * @param generic    the CSS fallback bucket (`style.fontFamily`: serif/sans/mono)
 * @param available  families the editor can render/embed (order = priority)
 */
export function resolveFont(realName: string | undefined, generic: string | undefined, available: readonly string[]): ResolvedFont {
  const { base, bold, italic } = cleanFontName(realName || '')
  const target = normFamily(base)

  if (target) {
    // 1. Exact normalized match.
    const exact = available.find(f => normFamily(f) === target)
    if (exact) return { family: exact, bold, italic }
    // 2. One is a prefix of the other (e.g. "Arial" ⊂ "ArialNarrow", "Calibri" ⊂ "CalibriLight").
    //    Prefer the longest available family that still shares a prefix (most specific).
    const partial = available
      .filter(f => { const n = normFamily(f); return n.length >= 3 && (n.startsWith(target) || target.startsWith(n)) })
      .sort((a, b) => normFamily(b).length - normFamily(a).length)[0]
    if (partial) return { family: partial, bold, italic }
  }

  // 3. No name match → the serif/sans/mono bucket, which is always a real
  //    installed family so both the canvas and the export render consistently.
  //    A keyword in the real name overrides pdf.js's (sometimes wrong) generic.
  return { family: genericToBase(natureFromName(base) || generic), bold, italic }
}
