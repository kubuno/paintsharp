/**
 * Entrées/sorties SVG pour Apex, branchées sur le module files (@kubuno/drive).
 *  - openSvgAsApex : récupère un .svg du drive, le parse en VectorPageData,
 *    crée un projet Apex, y charge les données, et mémorise le fichier source
 *    pour permettre la ré-écriture SVG.
 *  - saveApexAsSvg : sérialise la page courante en SVG et l'écrit dans le drive
 *    (écrase le .svg source si le projet en provient, sinon crée un nouveau .svg).
 */
import { filesApi, type FileItem } from '@kubuno/drive'
import { apexApi, type VectorPageData } from './api'
import { pageDataToSvg, svgToPageData } from './apexSvg'

/** Cible minimale d'ouverture (cf. FileOpenTarget : id + name, sans folder_id). */
interface OpenTarget { id: string; name: string }

interface SvgSource { fileId: string; name: string; folderId: string | null }

const SRC_KEY = (projectId: string) => `apex:svg-src:${projectId}`

export function getSvgSource(projectId: string): SvgSource | null {
  try { const v = sessionStorage.getItem(SRC_KEY(projectId)); return v ? JSON.parse(v) as SvgSource : null }
  catch { return null }
}
function setSvgSource(projectId: string, src: SvgSource) {
  try { sessionStorage.setItem(SRC_KEY(projectId), JSON.stringify(src)) } catch { /* quota */ }
}

async function fetchText(url: string): Promise<string> {
  const r = await fetch(url, { credentials: 'include' })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.text()
}

/** Ouvre un fichier .svg du drive dans un nouveau projet Apex. Renvoie l'id du projet. */
export async function openSvgAsApex(file: OpenTarget): Promise<string> {
  const svgText = await fetchText(filesApi.downloadUrl(file.id))
  const data = svgToPageData(svgText)
  const title = file.name.replace(/\.svg$/i, '')
  const { id } = (await apexApi.createProject({ title })).data
  const pages = (await apexApi.listPages(id)).data.pages
  const pageId = pages[0]?.id
  if (pageId) await apexApi.savePage(id, pageId, data)
  setSvgSource(id, { fileId: file.id, name: file.name, folderId: null })
  return id
}

/**
 * Écrit la page Apex en SVG dans le drive. Si le projet provient d'un .svg,
 * écrase le fichier source ; sinon crée `<titre>.svg` dans le dossier racine.
 */
export async function saveApexAsSvg(projectId: string, pd: VectorPageData, fallbackName = 'dessin'): Promise<FileItem> {
  const svg = pageDataToSvg(pd)
  const src = getSvgSource(projectId)
  const name = src?.name ?? `${fallbackName}.svg`
  const blob = new Blob([svg], { type: 'image/svg+xml' })
  const f = new File([blob], name, { type: 'image/svg+xml' })
  const res = await filesApi.uploadFile(f, src?.folderId ?? null, undefined, /* overwrite */ !!src)
  return res.file
}
