import { api } from '@kubuno/sdk'

// ── Vertex ────────────────────────────────────────────────────────────────────

export interface Scene {
  id:            string
  owner_id:      string
  title:         string
  description:   string | null
  scene_json:    object
  thumbnail_url: string | null
  is_starred:    boolean
  is_trashed:    boolean
  vertex_count:  number
  face_count:    number
  updated_at:    string
  created_at:    string
}

export interface SceneSummary {
  id:            string
  owner_id:      string
  title:         string
  description:   string | null
  thumbnail_url: string | null
  is_starred:    boolean
  vertex_count:  number
  face_count:    number
  updated_at:    string
  created_at:    string
}

export interface Asset {
  id:            string
  owner_id:      string
  name:          string
  asset_type:    'mesh' | 'texture' | 'material' | 'hdri' | 'other'
  storage_path:  string
  mime_type:     string | null
  size_bytes:    number
  thumbnail_url: string | null
  meta:          object
  created_at:    string
}

export const paintsharpApi = {
  openByFile: (fileId: string) =>
    api.post<{ id: string }>('/paintsharp/scenes/open-by-file', { file_id: fileId }).then(r => r.data),
  listScenes:   (params?: { starred?: boolean; trashed?: boolean; limit?: number; offset?: number }) =>
    api.get<{ scenes: SceneSummary[] }>('/paintsharp/scenes', { params }),

  getScene:     (id: string) =>
    api.get<Scene>(`/paintsharp/scenes/${id}`),

  createScene:  (data: { title?: string; description?: string }) =>
    api.post<{ id: string; title: string }>('/paintsharp/scenes', data),

  updateScene:  (id: string, data: Partial<Pick<Scene, 'title' | 'description' | 'scene_json' | 'thumbnail_url' | 'is_starred' | 'vertex_count' | 'face_count'>>) =>
    api.patch(`/paintsharp/scenes/${id}`, data),

  trashScene:   (id: string) => api.post(`/paintsharp/scenes/${id}/trash`, {}),
  restoreScene: (id: string) => api.post(`/paintsharp/scenes/${id}/restore`, {}),
  deleteScene:  (id: string) => api.delete(`/paintsharp/scenes/${id}/delete`),

  listAssets:   (params?: { asset_type?: string; limit?: number; offset?: number }) =>
    api.get<{ assets: Asset[] }>('/paintsharp/assets', { params }),

  deleteAsset:  (id: string) => api.delete(`/paintsharp/assets/${id}`),
}

// ── Apex (projets vectoriels) ─────────────────────────────────────────────────

export interface VectorProjectSummary {
  id:             string
  owner_id:       string
  title:          string
  thumbnail_path: string | null
  is_starred:     boolean
  updated_at:     string
  created_at:     string
}

export interface VectorProject extends VectorProjectSummary {
  settings:       object
  is_trashed:     boolean
  pages:          VectorPageSummary[]
}

export interface VectorPageSummary {
  id:       string
  name:     string
  position: number
}

export interface VectorPage extends VectorPageSummary {
  project_id: string
  data:       VectorPageData
  updated_at: string
  created_at: string
}

export interface VectorPageData {
  artboards: Artboard[]
  elements:  VectorElement[]
  guides:    Guide[]
}

export interface Artboard {
  id:         string
  name:       string
  x:          number
  y:          number
  width:      number
  height:     number
  background: string
}

export type FillStyle =
  | { type: 'solid';           color: string; opacity: number }
  | { type: 'linear-gradient'; stops: GradientStop[]; angle: number }
  | { type: 'radial-gradient'; stops: GradientStop[]; angle?: number }
  | { type: 'none' }

export interface GradientStop { color: string; opacity: number; position: number }

export interface StrokeStyle {
  color:    string
  opacity:  number
  width:    number
  dashArray: number[]
  cap?:     'butt' | 'round' | 'square'
  join?:    'miter' | 'round' | 'bevel'
}

export interface PathPoint {
  x:     number
  y:     number
  hIn?:  [number, number]
  hOut?: [number, number]
  // Début d'un nouveau sous-chemin (chemin composé issu d'une fusion d'objets).
  move?: boolean
}

export type VectorElement = RectElement | EllipseElement | PathElement | TextElement

export interface BaseElement {
  id:       string
  type:     string
  name:     string
  x:        number
  y:        number
  w:        number
  h:        number
  rotation: number
  visible:  boolean
  locked:   boolean
  opacity:  number
  zIndex:   number
  fill:     FillStyle
  stroke:   StrokeStyle | null
  groupId?: string
}

export interface RectElement extends BaseElement {
  type:         'rect'
  cornerRadius: number
}

export interface EllipseElement extends BaseElement {
  type: 'ellipse'
}

export interface PathElement extends BaseElement {
  type:   'path'
  points: PathPoint[]
  closed: boolean
  // Parametric shape metadata: when present, the polygon side count / star spike
  // count stays editable (the points are regenerated from these on change).
  shape?:      'polygon' | 'star'
  sides?:      number   // polygon: number of sides (≥3)
  spikes?:     number   // star: number of points (≥3)
  innerRatio?: number   // star: inner/outer radius ratio (0..1)
}

export interface TextElement extends BaseElement {
  type:       'text'
  text:       string
  fontSize:   number
  fontFamily: string
  fontWeight: number          // 400 | 700 …
  italic:     boolean
  align:      'left' | 'center' | 'right'
}

export interface Guide {
  id:        string
  type:      'h' | 'v'
  position:  number
}

// ── Layer (documents raster) ──────────────────────────────────────────────────

export interface LayerDocumentSummary {
  id:             string
  owner_id:       string
  title:          string
  width:          number
  height:         number
  color_mode:     string
  thumbnail_path: string | null
  is_starred:     boolean
  layer_count:    number
  updated_at:     string
  created_at:     string
}

export interface LayerDocument extends LayerDocumentSummary {
  bit_depth:        number
  dpi:              number
  layers_structure: LayerStructureItem[]
  view_settings:    Record<string, unknown>
  is_trashed:       boolean
}

export interface LayerStructureItem {
  id:        string
  type:      'raster' | 'adjustment' | 'text' | 'group'
  name:      string
  visible:   boolean
  locked:    boolean          // lock-all
  opacity:   number
  fill?:     number           // separate fill opacity (×opacity); 100 if absent
  blendMode: string
  x?:        number
  y?:        number
  mask:      null | { enabled: boolean; inverted: boolean; layerId: string }
  effects:   unknown[]
  // granular locks
  lockAlpha?:    boolean      // lock transparent pixels (preserve alpha when painting)
  lockPosition?: boolean      // lock position (block move/transform)
  // adjustment layers
  adjustment?: unknown
  clipping?:   boolean        // clip to the layer below (its alpha)
  // groups
  expanded?: boolean
  children?: LayerStructureItem[]
  // Pixels (PNG data URL) — contenu raster persisté dans le fichier .kblay.
  data?:      string
  mask_data?: string
}

export const layerApi = {
  openByFile: (fileId: string) =>
    api.post<{ id: string }>('/paintsharp/layer-docs/open-by-file', { file_id: fileId }).then(r => r.data),
  listDocs:   (params?: { starred?: boolean; trashed?: boolean }) =>
    api.get<{ documents: LayerDocumentSummary[] }>('/paintsharp/layer-docs', { params }),

  createDoc:  (data: { title?: string; width?: number; height?: number; color_mode?: string; bit_depth?: number; dpi?: number }) =>
    api.post<{ id: string; title: string }>('/paintsharp/layer-docs', data),

  getDoc:     (id: string) =>
    api.get<LayerDocument>(`/paintsharp/layer-docs/${id}`),

  updateDoc:  (id: string, data: { title?: string; is_starred?: boolean; thumbnail_path?: string; layers_structure?: LayerStructureItem[]; view_settings?: Record<string, unknown> }) =>
    api.patch(`/paintsharp/layer-docs/${id}`, data),

  saveStructure: (id: string, layers_structure: LayerStructureItem[], layer_count?: number) =>
    api.put(`/paintsharp/layer-docs/${id}/structure`, { layers_structure, layer_count }),

  trashDoc:   (id: string) => api.post(`/paintsharp/layer-docs/${id}/trash`, {}),
  restoreDoc: (id: string) => api.post(`/paintsharp/layer-docs/${id}/restore`, {}),
  deleteDoc:  (id: string) => api.delete(`/paintsharp/layer-docs/${id}/delete`),
  duplicateDoc: (id: string) => api.post<{ id: string }>(`/paintsharp/layer-docs/${id}/duplicate`).then(r => r.data.id),
}

// ── Keyframe (animations 2D) ──────────────────────────────────────────────────

export interface AnimationComposition {
  width:           number
  height:          number
  fps:             number
  duration_frames: number
  background:      string
  pixelRatio:      number
}

export interface AnimationSummary {
  id:              string
  owner_id:        string
  title:           string
  composition:     AnimationComposition
  thumbnail_path:  string | null
  thumbnail_dirty: boolean
  updated_at:      string
  created_at:      string
}

export interface AnimProperty<T = number> {
  staticValue: T
  keyframes:   AnimKeyframe<T>[]
}

export interface AnimKeyframe<T = number> {
  id:             string
  frame:          number
  value:          T
  interpolation:  'linear' | 'bezier' | 'hold' | 'spring'
  easing:         EasingDef
  handleIn:       { x: number; y: number }
  handleOut:      { x: number; y: number }
}

export type EasingDef =
  | { type: 'linear' }
  | { type: 'hold' }
  | { type: 'cubic-bezier'; cx1: number; cy1: number; cx2: number; cy2: number }
  | { type: 'spring'; tension: number; friction: number; mass: number }

export interface AnimLayerProperties {
  positionX:     AnimProperty
  positionY:     AnimProperty
  rotation:      AnimProperty
  scaleX:        AnimProperty
  scaleY:        AnimProperty
  opacity:       AnimProperty
  anchorX:       AnimProperty
  anchorY:       AnimProperty
  fillColor?:    AnimProperty<string>
  strokeColor?:  AnimProperty<string>
  strokeWidth?:  AnimProperty
  fontSize?:     AnimProperty
  letterSpacing?: AnimProperty
}

export type LayerDataDef =
  | { type: 'shape'; shape: 'rect' | 'ellipse' | 'path'; path?: string; width: number; height: number; cornerRadius?: number }
  | { type: 'image'; assetId: string; width: number; height: number }
  | { type: 'vector'; assetId: string; width: number; height: number }
  | { type: 'text'; content: string; fontFamily: string; fontSize: number; fontWeight: number; textAlign: string }
  | { type: 'solid'; width: number; height: number }
  | { type: 'null' }
  | { type: 'camera'; zoom: number }
  | { type: 'group'; childIds: string[] }

export interface AnimLayer {
  id:         string
  type:       'shape' | 'image' | 'vector' | 'text' | 'group' | 'camera' | 'null' | 'solid'
  name:       string
  parentId:   string | null
  inPoint:    number
  outPoint:   number
  solo:       boolean
  locked:     boolean
  visible:    boolean
  blendMode:  string
  data:       LayerDataDef
  effects:    unknown[]
  properties: AnimLayerProperties
}

export interface AnimData {
  layers: AnimLayer[]
  bones:  unknown[]
}

export interface Animation extends AnimationSummary {
  anim_data:  AnimData
  assets:     unknown[]
  is_trashed: boolean
}

export const keyframeApi = {
  openByFile: (fileId: string) =>
    api.post<{ id: string }>('/paintsharp/animations/open-by-file', { file_id: fileId }).then(r => r.data),
  listAnimations: (params?: { trashed?: boolean }) =>
    api.get<{ animations: AnimationSummary[] }>('/paintsharp/animations', { params }),

  createAnimation: (data?: { title?: string; composition?: Partial<AnimationComposition> }) =>
    api.post<{ id: string; title: string }>('/paintsharp/animations', data ?? {}),

  getAnimation: (id: string) =>
    api.get<Animation>(`/paintsharp/animations/${id}`),

  updateAnimation: (id: string, data: { title?: string; composition?: Partial<AnimationComposition>; thumbnail_path?: string; thumbnail_dirty?: boolean }) =>
    api.patch(`/paintsharp/animations/${id}`, data),

  saveData: (id: string, animData: AnimData) =>
    api.put(`/paintsharp/animations/${id}/data`, animData),

  trashAnimation:      (id: string) => api.post(`/paintsharp/animations/${id}/trash`, {}),
  restoreAnimation:    (id: string) => api.post(`/paintsharp/animations/${id}/restore`, {}),
  deleteAnimation:     (id: string) => api.delete(`/paintsharp/animations/${id}/delete`),
  duplicateAnimation:  (id: string) => api.post<{ id: string }>(`/paintsharp/animations/${id}/duplicate`).then(r => r.data.id),

  exportLottie: (id: string) => `/api/v1/paintsharp/animations/${id}/export/lottie`,
}

// ── Motion (projets vidéo) ────────────────────────────────────────────────────

export interface VideoComposition {
  width:           number
  height:          number
  fps:             number
  duration_frames: number
  sample_rate:     number
  channels:        number
  color_space:     string
}

export interface VideoProjectSummary {
  id:              string
  owner_id:        string
  title:           string
  composition:     VideoComposition
  thumbnail_path:  string | null
  thumbnail_dirty: boolean
  is_trashed:      boolean
  updated_at:      string
  created_at:      string
}

export interface VideoProject extends VideoProjectSummary {
  timeline_data:   TimelineData
  render_settings: RenderSettings
  last_edited_by:  string | null
}

export interface TimelineData {
  tracks:  VideoTrack[]
  markers: TimelineMarker[]
}

export type TrackType = 'video' | 'audio' | 'subtitle' | 'fx'

export interface VideoTrack {
  id:      string
  type:    TrackType
  name:    string
  muted:   boolean
  locked:  boolean
  height:  number
  clips:   VideoClip[]
}

export interface ClipTransform {
  x:        number   // décalage horizontal (px composition)
  y:        number   // décalage vertical
  scale:    number   // zoom (1 = 100 %)
  rotation: number   // degrés
  opacity:  number   // 0..100
  blend:    string   // mode de fusion (source-over, screen, multiply, …)
}

export interface VideoClip {
  id:        string
  mediaId:   string
  trackId:   string
  startFrame: number
  endFrame:   number
  // offset within the source media
  inPoint:   number
  outPoint:  number
  speed:     number
  volume:    number
  effects:   ClipEffect[]
  transform?: ClipTransform
}

export interface ClipEffect {
  type:   string
  params: Record<string, unknown>
}

export interface TimelineMarker {
  id:    string
  frame: number
  label: string
  color: string
}

export interface RenderSettings {
  codec:         string
  preset:        string
  crf:           number
  audio_codec:   string
  audio_bitrate: string
  container:     string
}

export interface VideoMedia {
  id:             string
  project_id:     string
  owner_id:       string
  original_name:  string
  mime_type:      string
  size_bytes:     number
  probe_data:     Record<string, unknown>
  thumbnails_path: string | null
  waveform_path:  string | null
  status:         'pending' | 'processing' | 'ready' | 'error'
  error_message:  string | null
  created_at:     string
}

export interface RenderJob {
  id:            string
  project_id:    string
  status:        'queued' | 'running' | 'done' | 'failed' | 'cancelled'
  progress:      number
  frame_current: number
  frame_total:   number
  output_url:    string | null
  error_message: string | null
  started_at:    string | null
  finished_at:   string | null
  created_at:    string
}

export const motionApi = {
  openByFile: (fileId: string) =>
    api.post<{ id: string }>('/paintsharp/video-projects/open-by-file', { file_id: fileId }).then(r => r.data),
  listProjects: (params?: { trashed?: boolean }) =>
    api.get<{ projects: VideoProjectSummary[] }>('/paintsharp/video-projects', { params }),

  createProject: (data?: { title?: string; composition?: Partial<VideoComposition> }) =>
    api.post<{ id: string; title: string }>('/paintsharp/video-projects', data ?? {}),

  getProject: (id: string) =>
    api.get<VideoProject>(`/paintsharp/video-projects/${id}`),

  updateProject: (id: string, data: { title?: string; composition?: Partial<VideoComposition>; render_settings?: Partial<RenderSettings>; thumbnail_path?: string; thumbnail_dirty?: boolean }) =>
    api.patch(`/paintsharp/video-projects/${id}`, data),

  saveTimeline: (id: string, data: TimelineData) =>
    api.put(`/paintsharp/video-projects/${id}/timeline`, data),

  trashProject:     (id: string) => api.post(`/paintsharp/video-projects/${id}/trash`, {}),
  restoreProject:   (id: string) => api.post(`/paintsharp/video-projects/${id}/restore`, {}),
  deleteProject:    (id: string) => api.delete(`/paintsharp/video-projects/${id}/delete`),
  duplicateProject: (id: string) => api.post<{ id: string }>(`/paintsharp/video-projects/${id}/duplicate`).then(r => r.data.id),

  listMedia: (projectId: string) =>
    api.get<{ media: VideoMedia[] }>(`/paintsharp/video-projects/${projectId}/media`),

  // Importe un fichier déjà présent dans Files par référence : le serveur récupère
  // le contenu via l'IPC Files, sans transit par le navigateur.
  importMediaFromFile: (projectId: string, fileId: string) =>
    api.post<{ media_ids: string[] }>(`/paintsharp/video-projects/${projectId}/media/from-file`, { file_id: fileId }),

  getMediaStreamUrl: (projectId: string, mediaId: string) =>
    `/api/v1/paintsharp/video-projects/${projectId}/media/${mediaId}/stream`,

  listRenderJobs: (projectId: string) =>
    api.get<{ jobs: RenderJob[] }>(`/paintsharp/video-projects/${projectId}/render-jobs`),

  createRenderJob: (projectId: string, renderOptions?: Partial<RenderSettings>) =>
    api.post<{ job_id: string }>(`/paintsharp/video-projects/${projectId}/render-jobs`, { render_options: renderOptions }),

  getRenderJob: (projectId: string, jobId: string) =>
    api.get<RenderJob>(`/paintsharp/video-projects/${projectId}/render-jobs/${jobId}`),
}

export const apexApi = {
  openByFile: (fileId: string) =>
    api.post<{ id: string }>('/paintsharp/vectors/open-by-file', { file_id: fileId }).then(r => r.data),
  listProjects:  (params?: { starred?: boolean; trashed?: boolean; limit?: number; offset?: number }) =>
    api.get<{ projects: VectorProjectSummary[] }>('/paintsharp/vectors', { params }),

  createProject: (data: { title?: string }) =>
    api.post<{ id: string; title: string }>('/paintsharp/vectors', data),

  getProject:    (id: string) =>
    api.get<VectorProject>(`/paintsharp/vectors/${id}`),

  updateProject: (id: string, data: { title?: string; is_starred?: boolean; thumbnail_path?: string }) =>
    api.patch(`/paintsharp/vectors/${id}`, data),

  trashProject:     (id: string) => api.post(`/paintsharp/vectors/${id}/trash`, {}),
  restoreProject:   (id: string) => api.post(`/paintsharp/vectors/${id}/restore`, {}),
  deleteProject:    (id: string) => api.delete(`/paintsharp/vectors/${id}/delete`),
  duplicateProject: (id: string) => api.post<{ id: string }>(`/paintsharp/vectors/${id}/duplicate`).then(r => r.data.id),

  listPages:     (projectId: string) =>
    api.get<{ pages: VectorPage[] }>(`/paintsharp/vectors/${projectId}/pages`),

  createPage:    (projectId: string, data: { name?: string }) =>
    api.post<VectorPageSummary>(`/paintsharp/vectors/${projectId}/pages`, data),

  getPage:       (projectId: string, pageId: string) =>
    api.get<VectorPage>(`/paintsharp/vectors/${projectId}/pages/${pageId}`),

  savePage:      (projectId: string, pageId: string, data: VectorPageData) =>
    api.put(`/paintsharp/vectors/${projectId}/pages/${pageId}/data`, data),

  renamePage:    (projectId: string, pageId: string, name: string) =>
    api.patch(`/paintsharp/vectors/${projectId}/pages/${pageId}`, { name }),

  deletePage:    (projectId: string, pageId: string) =>
    api.delete(`/paintsharp/vectors/${projectId}/pages/${pageId}`),
}

// ── PdfWriter ─────────────────────────────────────────────────────────────────

export interface PdfDocumentSummary {
  id:             string
  owner_id:       string
  title:          string
  page_count:     number
  thumbnail_path: string | null
  is_starred:     boolean
  updated_at:     string
  created_at:     string
}

export interface PdfDocument extends PdfDocumentSummary {
  source_path:    string | null
  settings:       object
  is_trashed:     boolean
  pages:          PdfPageSummary[]
}

export interface PdfPageSummary {
  id:          string
  page_number: number
  width:       number
  height:      number
  rotation:    number
}

export interface PdfPage extends PdfPageSummary {
  document_id: string
  annotations: Annotation[]
  form_data:   Record<string, unknown>
  updated_at:  string
}

export interface PdfSignature {
  id:         string
  owner_id:   string
  name:       string
  sig_type:   'draw' | 'text' | 'image'
  data:       string
  created_at: string
}

// Annotation types
export interface BaseAnnotation {
  id:         string
  type:       string
  page:       number
  x:          number
  y:          number
  createdAt:  string
}

export interface TextAnnotation extends BaseAnnotation {
  type:            'text'
  width:           number
  height:          number
  content:         string
  fontSize:        number
  fontFamily:      string
  color:           string
  bold:            boolean
  italic:          boolean
  align:           'left' | 'center' | 'right'
  backgroundColor?: string
  borderColor?:    string
  /** Étirement horizontal pour coller à la largeur d'origine du PDF (texte extrait). */
  scaleX?:         number
}

export interface MarkupAnnotation extends BaseAnnotation {
  type:    'highlight' | 'underline' | 'strikethrough'
  width:   number
  height:  number
  color:   string
  opacity: number
}

export interface StickyNoteAnnotation extends BaseAnnotation {
  type:    'sticky-note'
  content: string
  color:   string
  isOpen:  boolean
}

export interface FreehandAnnotation extends BaseAnnotation {
  type:        'freehand'
  points:      [number, number][]
  color:       string
  strokeWidth: number
  opacity:     number
}

export interface ShapeAnnotation extends BaseAnnotation {
  type:         'rect' | 'ellipse' | 'line' | 'arrow'
  width:        number
  height:       number
  strokeColor:  string
  strokeWidth:  number
  fillColor?:   string
  fillOpacity?: number
  opacity:      number
}

export interface StampAnnotation extends BaseAnnotation {
  type:      'stamp'
  stampType: 'approved' | 'rejected' | 'confidential' | 'draft' | 'revised' | 'final' | 'not-approved' | 'for-review'
  width:     number
  height:    number
  opacity:   number
}

export interface SignatureAnnotation extends BaseAnnotation {
  type:          'signature'
  signatureData: string
  width:         number
  height:        number
}

export interface ImageAnnotation extends BaseAnnotation {
  type:    'image'
  src:     string   // data URL
  width:   number
  height:  number
  opacity?: number
}

export interface FormFieldAnnotation extends BaseAnnotation {
  type:      'form-text' | 'form-checkbox' | 'form-radio' | 'form-dropdown' | 'form-date'
  width:     number
  height:    number
  fieldName: string
  value:     string | boolean
  options?:  string[]
  required:  boolean
  label?:    string
}

export type Annotation =
  | TextAnnotation
  | MarkupAnnotation
  | StickyNoteAnnotation
  | FreehandAnnotation
  | ShapeAnnotation
  | StampAnnotation
  | SignatureAnnotation
  | ImageAnnotation
  | FormFieldAnnotation

export const pdfWriterApi = {
  openByFile: (fileId: string) =>
    api.post<{ id: string }>('/paintsharp/pdf-docs/open-by-file', { file_id: fileId }).then(r => r.data),
  listDocuments: (params?: { starred?: boolean; trashed?: boolean; limit?: number; offset?: number }) =>
    api.get<{ documents: PdfDocumentSummary[] }>('/paintsharp/pdf-docs', { params }),

  createDocument: (data: { title?: string; page_count?: number; width?: number; height?: number }) =>
    api.post<{ id: string; title: string; page_count: number }>('/paintsharp/pdf-docs', data),

  importDocument: (formData: FormData) =>
    // Ne PAS forcer le Content-Type : axios/le navigateur génère
    // « multipart/form-data; boundary=… » automatiquement pour un FormData. Le fixer à
    // la main supprime la boundary → le parseur multipart du serveur échoue.
    api.post<{ id: string; title: string; page_count: number }>('/paintsharp/pdf-docs/import', formData),

  getDocument: (id: string) =>
    api.get<PdfDocument>(`/paintsharp/pdf-docs/${id}`),

  updateDocument: (id: string, data: { title?: string; thumbnail_path?: string; is_starred?: boolean; settings?: object }) =>
    api.patch(`/paintsharp/pdf-docs/${id}`, data),

  trashDocument:     (id: string) => api.post(`/paintsharp/pdf-docs/${id}/trash`, {}),
  restoreDocument:   (id: string) => api.post(`/paintsharp/pdf-docs/${id}/restore`, {}),
  deleteDocument:    (id: string) => api.delete(`/paintsharp/pdf-docs/${id}/delete`),
  duplicateDocument: (id: string) => api.post<{ id: string }>(`/paintsharp/pdf-docs/${id}/duplicate`).then(r => r.data.id),

  sourceUrl: (id: string) => `/api/v1/paintsharp/pdf-docs/${id}/source`,


  listPages: (docId: string) =>
    api.get<{ pages: PdfPage[] }>(`/paintsharp/pdf-docs/${docId}/pages`),

  getPage: (docId: string, pageNum: number) =>
    api.get<PdfPage>(`/paintsharp/pdf-docs/${docId}/pages/${pageNum}`),

  savePage: (docId: string, pageNum: number, data: { annotations: Annotation[]; form_data?: object; rotation?: number }) =>
    api.put(`/paintsharp/pdf-docs/${docId}/pages/${pageNum}`, data),

  addPage: (docId: string, data: { width?: number; height?: number; after?: number }) =>
    api.post<{ id: string; page_number: number }>(`/paintsharp/pdf-docs/${docId}/pages/add`, data),

  deletePage: (docId: string, pageNum: number) =>
    api.delete(`/paintsharp/pdf-docs/${docId}/pages/${pageNum}`),

  rotatePage: (docId: string, pageNum: number, rotation: number) =>
    api.post(`/paintsharp/pdf-docs/${docId}/pages/${pageNum}/rotate`, { rotation }),

  reorderPages: (docId: string, order: number[]) =>
    api.post(`/paintsharp/pdf-docs/${docId}/pages/reorder`, { order }),

  listSignatures: () =>
    api.get<{ signatures: PdfSignature[] }>('/paintsharp/pdf-signatures'),

  createSignature: (data: { name?: string; sig_type?: string; data: string }) =>
    api.post<{ id: string; name: string }>('/paintsharp/pdf-signatures', data),

  deleteSignature: (id: string) =>
    api.delete(`/paintsharp/pdf-signatures/${id}`),
}
