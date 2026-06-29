// ── OCR (reconnaissance de texte) façon Acrobat « Reconnaître le texte » ──────
//
// 100 % côté navigateur via tesseract.js (WebAssembly) → respecte la règle
// « zéro exécution sur l'hôte » : aucune dépendance à un binaire serveur.
//
// SOUVERAINETÉ : le worker, le cœur WASM et les modèles de langue (traineddata)
// sont AUTO-HÉBERGÉS. On ne tape AUCUN CDN public : les fichiers sont émis par
// Vite (`new URL(..., import.meta.url)`) et servis depuis le frontend du module,
// exactement comme le worker pdf.js. Le host les sert sans authentification (ce
// sont des assets statiques publics), ce que le Web Worker peut donc charger.

import { createWorker, OEM, type Worker } from 'tesseract.js'

// Worker + cœur WASM tesseract, copiés depuis node_modules par Vite.
const WORKER_PATH = new URL('tesseract.js/dist/worker.min.js', import.meta.url).href
const CORE_PATH   = new URL('tesseract.js-core/tesseract-core-simd-lstm.wasm.js', import.meta.url).href
// Référence le .wasm voisin pour forcer Vite à l'émettre à côté du .wasm.js
// (le glue emscripten le charge relativement à l'URL du .wasm.js).
new URL('tesseract.js-core/tesseract-core-simd-lstm.wasm', import.meta.url)

// Modèles de langue (gzip). On déduit le dossier `langPath` de l'URL émise :
// tesseract récupère `${langPath}/${lang}.traineddata.gz`.
const FRA_URL = new URL('./tessdata/fra.traineddata.gz', import.meta.url).href
new URL('./tessdata/eng.traineddata.gz', import.meta.url)
const LANG_PATH = FRA_URL.replace(/\/fra\.traineddata\.gz(\?.*)?$/, '')

export type OcrLang = 'fra' | 'eng' | 'fra+eng'

export interface OcrWord {
  text: string
  /** Boîte en pixels de l'image OCRisée. */
  x0: number; y0: number; x1: number; y1: number
  confidence: number
}

export interface OcrResult {
  words: OcrWord[]
  /** Dimensions (px) de l'image fournie à l'OCR (pour reconvertir en points PDF). */
  width: number
  height: number
}

export type OcrProgress = (status: string, progress: number) => void

let workerPromise: Promise<Worker> | null = null
let workerLangs = ''

// Worker tesseract paresseux + mémorisé (le chargement du cœur WASM est coûteux).
async function getWorker(langs: OcrLang, onProgress?: OcrProgress): Promise<Worker> {
  if (workerPromise && workerLangs === langs) return workerPromise
  if (workerPromise) { try { (await workerPromise).terminate() } catch { /* ignore */ } workerPromise = null }
  workerLangs = langs
  workerPromise = createWorker(langs, OEM.LSTM_ONLY, {
    workerPath: WORKER_PATH,
    corePath:   CORE_PATH,
    langPath:   LANG_PATH,
    gzip:       true,
    logger: (m: { status?: string; progress?: number }) => {
      if (onProgress && m.status) onProgress(m.status, m.progress ?? 0)
    },
  })
  return workerPromise
}

/** Reconnaît le texte d'une image (canvas / dataURL) et renvoie les mots + boîtes. */
export async function recognizeImage(
  image: HTMLCanvasElement | string,
  langs: OcrLang = 'fra+eng',
  onProgress?: OcrProgress,
): Promise<OcrResult> {
  const worker = await getWorker(langs, onProgress)
  const { data } = await worker.recognize(image)
  const width  = image instanceof HTMLCanvasElement ? image.width  : (data as { width?: number }).width  ?? 0
  const height = image instanceof HTMLCanvasElement ? image.height : (data as { height?: number }).height ?? 0
  const words: OcrWord[] = (data.words ?? [])
    .filter(w => (w.text ?? '').trim().length > 0)
    .map(w => ({
      text: w.text.trim(),
      x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1,
      confidence: w.confidence,
    }))
  return { words, width, height }
}

/** Libère le worker (et le cœur WASM) — à appeler au démontage de l'éditeur. */
export async function disposeOcr(): Promise<void> {
  if (!workerPromise) return
  const p = workerPromise
  workerPromise = null; workerLangs = ''
  try { (await p).terminate() } catch { /* ignore */ }
}
