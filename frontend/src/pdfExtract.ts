import * as pdfjsLib from 'pdfjs-dist'
import type { PDFPageProxy } from 'pdfjs-dist'
import type { Annotation } from './api'

// Extrait le CONTENU d'une page PDF en éléments éditables (texte + images), pour
// transformer un PDF importé en objets manipulables (« vrai éditeur »).
//
// Compromis assumé : les graphiques vectoriels (filets, traits) et les polices/mises
// en page exactes ne sont PAS reconstitués — on récupère le texte (par fragment) et
// les images bitmap, positionnés en points PDF, ce qui suffit pour déplacer le logo,
// réécrire le texte livré, etc.

const RASTER = 1.5 // sur-échantillonnage (compromis netteté / poids des données)

function uid() { return (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)) }

export async function extractPageElements(page: PDFPageProxy, pageNum: number): Promise<Annotation[]> {
  const { OPS, Util } = pdfjsLib as unknown as {
    OPS: Record<string, number>
    Util: { transform: (a: number[], b: number[]) => number[]; applyTransform: (p: number[], m: number[]) => number[] }
  }
  void OPS; void Util // (CTM tracking pourrait servir à isoler les images raster ; non requis ici)
  const vp1 = page.getViewport({ scale: 1 })   // espace points (origine haut-gauche, y vers le bas)
  const now = new Date().toISOString()
  const texts: Annotation[] = []
  const boxes: Array<{ x: number; y: number; w: number; h: number }> = []
  const meas = document.createElement('canvas').getContext('2d')!

  // ── Texte (un élément éditable par fragment) ────────────────────────────────
  try {
    const tc = await page.getTextContent()
    for (const item of tc.items as Array<{ str: string; transform: number[]; width: number; fontName?: string }>) {
      const str = item.str
      if (!str || !str.trim()) continue
      const tr = item.transform
      const fontSize = Math.hypot(tr[2], tr[3]) || Math.hypot(tr[0], tr[1]) || 12
      const fs = Math.max(6, Math.round(fontSize))
      const [vx, vy] = vp1.convertToViewportPoint(tr[4], tr[5]) // baseline en points (y vers le bas)
      const origW = item.width || fontSize * 0.6 // largeur d'origine (points)
      const bold   = /bold|black|heavy/i.test(item.fontName ?? '')
      const italic = /italic|oblique/i.test(item.fontName ?? '')
      // Étirement horizontal : on cale la largeur rendue (police web) sur la largeur
      // d'origine du PDF → le bord droit (lignes alignées à droite) coïncide.
      meas.font = `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${fs}px serif`
      const measured = meas.measureText(str).width
      const scaleX = measured > 1 ? Math.min(3, Math.max(0.3, origW / measured)) : 1
      // La ligne de base d'origine est en (vx, vy) ; on remonte de la taille de police.
      const box = { x: vx, y: vy - fs, width: origW + 2, height: fs * 1.3 }
      texts.push({
        id: uid(), type: 'text', page: pageNum,
        x: box.x, y: box.y, width: box.width, height: box.height,
        content: str, fontSize: fs,
        fontFamily: 'serif', color: '#000000', bold, italic, align: 'left',
        scaleX,
        createdAt: now,
      } as Annotation)
      // Boîte d'effacement (un peu plus large) pour couvrir le texte d'origine.
      boxes.push({ x: vx - 1, y: vy - fs - 1, w: origW + 3, h: fs * 1.3 })
    }
  } catch { /* texte non extractible : on continue */ }

  // ── Calque graphique : page rastérisée avec le texte d'origine EFFACÉ (blanc),
  //    ajouté comme image de fond déplaçable/redimensionnable. Préserve logo, filets
  //    et images (vectoriels inclus) tout en laissant le texte éditable par-dessus.
  let background: Annotation | null = null
  try {
    const vpR = page.getViewport({ scale: RASTER })
    const off = document.createElement('canvas')
    off.width = Math.ceil(vpR.width); off.height = Math.ceil(vpR.height)
    const octx = off.getContext('2d')!
    octx.fillStyle = '#ffffff'                      // fond blanc (JPEG sans transparence)
    octx.fillRect(0, 0, off.width, off.height)
    await page.render({ canvas: off, canvasContext: octx, viewport: vpR }).promise
    octx.fillStyle = '#ffffff'
    for (const b of boxes) {
      octx.fillRect(b.x * RASTER - 1, b.y * RASTER - 1, b.w * RASTER + 2, b.h * RASTER + 2)
    }
    background = {
      id: uid(), type: 'image', page: pageNum,
      x: 0, y: 0, width: vp1.width, height: vp1.height,
      // JPEG (qualité 0.82) au lieu de PNG : calque de fond ~10× plus léger → .kbpdf
      // compact, sauvegardes/comparaisons d'autosave bien moins coûteuses.
      src: off.toDataURL('image/jpeg', 0.82), opacity: 1, createdAt: now,
    } as Annotation
  } catch { /* rendu impossible : on garde au moins le texte */ }

  // L'image de fond d'abord (derrière), puis le texte éditable.
  return background ? [background, ...texts] : texts
}
