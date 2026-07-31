/**
 * Point d'entrée du bundle MODULE paintsharp (suite créative), chargé à
 * l'exécution. Buildé séparément via `vite.module.config.ts` : les specifiers
 * partagés (`@kubuno/sdk`, `@kubuno/drive`, `@ui`, react…) sont externes et
 * résolus au runtime par l'import map du host ; three.js / @react-three /
 * pdfjs-dist + la lib `ui/` locale restent bundlés dans le module (chunks lazy
 * par sous-éditeur). Le host importe ce fichier puis appelle `register()` ;
 * `sdkVersion` permet de rejeter une incompatibilité de contrat.
 */
import { lazy } from 'react'
import {
  RouteRegistry,
  CollapseSidebarRegistry,
  WaffleAppRegistry,
  FileTypeRegistry,
  FaviconRegistry,
  SlotRegistry,
  ModuleSettingsRegistry,
  useSidebarStore,
  useToolbarStore,
  SDK_VERSION,
} from '@kubuno/sdk'
import { Box, Image, PenTool, Clapperboard, Film, FileEdit, Type } from 'lucide-react'
import './index.css'
import './i18n'
import { PaintsharpLogo } from './PaintsharpLogo'
import PaintsharpNewActions from './PaintsharpNewActions'
import PaintsharpSidebarBody from './PaintsharpSidebarBody'
import PaintsharpPdfOpenWithAction, { isPdfFile } from './PaintsharpPdfOpenWithAction'
import { registerDataCardRenderer } from './kubunoData'
import { ApexVectorsCard, renderVectorsStatic } from './ApexVectorsCard'

export const sdkVersion = SDK_VERSION

export function register() {
  // `paintsharp.vectors` JSON envelopes (Apex "Copier pour Kubuno"): consumer
  // modules (chat, office…) resolve this renderer through `core.data-card` —
  // live React card + on-demand static SVG/PNG render of the original JSON.
  registerDataCardRenderer('paintsharp', {
    types: ['paintsharp.vectors'],
    Component: ApexVectorsCard,
    renderStatic: renderVectorsStatic,
  })

  // Kubuno file types owned by each Paintsharp sub-module (declared to `files` —
  // the basis for StartPage filtering, icons and "open with").
  // `open`: resolves the entity via openByFile (returns { id }) then navigates to the editor.
  FileTypeRegistry.register({ moduleId: 'paintsharp-apex', label: 'Apex', icon: 'PenTool',
    mimeTypes: ['application/vnd.kubuno.vector+json', 'image/svg+xml'], extensions: ['kbvec', 'svg'],
    open: (f, nav) => {
      const isSvg = /\.svg$/i.test(f.name) || f.mime_type === 'image/svg+xml'
      if (isSvg) {
        // Plain SVG: imported client-side into a new Apex project.
        import('./apexSvgIO').then(({ openSvgAsApex }) => openSvgAsApex(f).then(id => nav(`/paintsharp/apex/${id}`)).catch(() => {}))
      } else {
        import('./api').then(({ apexApi }) => apexApi.openByFile(f.id).then(({ id }) => nav(`/paintsharp/apex/${id}`)).catch(() => {}))
      }
    } })
  FileTypeRegistry.register({ moduleId: 'paintsharp-layer', label: 'Layer', icon: 'Layers',
    // Native .kblay documents plus standard raster images (imported on the fly).
    mimeTypes: ['application/vnd.kubuno.layer+json', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/avif'],
    extensions: ['kblay', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif'],
    open: (f, nav) => {
      const isRaster = f.mime_type.startsWith('image/') && f.mime_type !== 'image/svg+xml'
      if (isRaster) {
        // Plain image: imported client-side into a new Layer document.
        import('./layerImageIO').then(({ openImageAsLayer }) => openImageAsLayer(f).then(id => nav(`/paintsharp/layer/${id}`)).catch(() => {}))
      } else {
        import('./api').then(({ layerApi }) => layerApi.openByFile(f.id).then(({ id }) => nav(`/paintsharp/layer/${id}`)).catch(() => {}))
      }
    } })
  FileTypeRegistry.register({ moduleId: 'paintsharp-vertex', label: 'Vertex', icon: 'Box',
    mimeTypes: ['application/vnd.kubuno.scene+json'], extensions: ['kbscn'],
    open: (f, nav) => { import('./api').then(({ paintsharpApi }) => paintsharpApi.openByFile(f.id).then(({ id }) => nav(`/paintsharp/scene/${id}`)).catch(() => {})) } })
  FileTypeRegistry.register({ moduleId: 'paintsharp-motion', label: 'Motion', icon: 'Clapperboard',
    mimeTypes: ['application/vnd.kubuno.motion+json'], extensions: ['kbmot'],
    open: (f, nav) => { import('./api').then(({ motionApi }) => motionApi.openByFile(f.id).then(({ id }) => nav(`/paintsharp/motion/${id}`)).catch(() => {})) } })
  FileTypeRegistry.register({ moduleId: 'paintsharp-keyframe', label: 'Keyframe', icon: 'Film',
    mimeTypes: ['application/vnd.kubuno.animation+json'], extensions: ['kbanm'],
    open: (f, nav) => { import('./api').then(({ keyframeApi }) => keyframeApi.openByFile(f.id).then(({ id }) => nav(`/paintsharp/keyframe/${id}`)).catch(() => {})) } })
  FileTypeRegistry.register({ moduleId: 'paintsharp-pdfwriter', label: 'PdfWriter', icon: 'FileText',
    mimeTypes: ['application/vnd.kubuno.pdfdoc+json'], extensions: ['kbpdf'],
    open: (f, nav) => { import('./api').then(({ pdfWriterApi }) => pdfWriterApi.openByFile(f.id).then(({ id }) => nav(`/paintsharp/pdfwriter/${id}`)).catch(() => {})) } })
  FileTypeRegistry.register({ moduleId: 'paintsharp-fonteditor', label: 'FontEditor', icon: 'Type',
    mimeTypes: ['application/vnd.kubuno.font+json', 'font/ttf', 'font/otf', 'font/woff', 'font/woff2',
                'application/x-font-ttf', 'application/vnd.ms-opentype', 'application/font-woff',
                'application/vnd.ms-fontobject'],
    extensions: ['kbfnt', 'ttf', 'otf', 'woff', 'woff2', 'eot'],
    open: (f, nav) => {
      if (/\.kbfnt$/i.test(f.name)) {
        import('./api').then(({ fontApi }) => fontApi.openByFile(f.id).then(({ id }) => nav(`/paintsharp/fonteditor/${id}`)).catch(() => {}))
      } else {
        // Standard font file: import it into a new FontEditor project.
        import('./fontFormats').then(({ openFontFileAsProject }) =>
          openFontFileAsProject(f).then(id => nav(`/paintsharp/fonteditor/${id}`)).catch(() => {}))
      }
    } })

  // PdfWriter can also open raw PDFs (application/pdf): contributed to the Files
  // module's "Open with" menu rather than registered as a file type, so neither the
  // icon nor the double-click behaviour changes. The predicate keeps the item enabled.
  SlotRegistry.register('files-open-with', 'paintsharp', PaintsharpPdfOpenWithAction, (file) => {
    const f = file as { mime_type?: string; name?: string } | undefined
    return !!f && isPdfFile(f.mime_type ?? '', f.name ?? '')
  })

  // Paintsharp apps collapse the core sidebar on open for maximum workspace width.
  CollapseSidebarRegistry.add('/paintsharp')

  // Favicon de l'onglet quand on est dans PaintSharp (sinon favicon Kubuno).
  FaviconRegistry.register('paintsharp', '/paintsharp-logo.svg')

  // The header gear button opens the per-user PaintSharp settings while in /paintsharp.
  ModuleSettingsRegistry.register('paintsharp')

  WaffleAppRegistry.register('paintsharp', 'PaintSharp', [
    { id: 'paintsharp',             label: 'PaintSharp',      Icon: PaintsharpLogo, path: '/paintsharp' },
    { id: 'paintsharp-vertex',      label: 'Vertex',     Icon: Box,       path: '/paintsharp/vertex' },
    { id: 'paintsharp-layer',       label: 'Layer',      Icon: Image,     path: '/paintsharp/layer' },
    { id: 'paintsharp-apex',        label: 'Apex',       Icon: PenTool,   path: '/paintsharp/apex' },
    { id: 'paintsharp-keyframe',    label: 'Keyframe',   Icon: Clapperboard, path: '/paintsharp/keyframe' },
    { id: 'paintsharp-motion',      label: 'Motion',     Icon: Film,      path: '/paintsharp/motion' },
    { id: 'paintsharp-pdfwriter',   label: 'PdfWriter',  Icon: FileEdit,  path: '/paintsharp/pdfwriter' },
    { id: 'paintsharp-fonteditor',  label: 'FontEditor', Icon: Type,      path: '/paintsharp/fonteditor' },
  ])

  useSidebarStore.getState().register({
    moduleId:          'paintsharp',
    routePrefix:       '/paintsharp',
    newButtonLabelKey: 'paintsharp:common_create',
    NewActions:        PaintsharpNewActions,
    SidebarBody:       PaintsharpSidebarBody,
    collapsedBody:     true,
  })

  useToolbarStore.getState().register({
    moduleId:    'paintsharp',
    routePrefix: '/paintsharp',
    noPadding:   true,
  })

  // Routes
  const PaintsharpApp         = lazy(() => import('./PaintsharpApp'))
  const VertexScenesApp       = lazy(() => import('./PaintsharpApp').then(m => ({ default: m.VertexScenesApp })))
  const LayerApp              = lazy(() => import('./PaintsharpApp').then(m => ({ default: m.LayerApp })))
  const ApexApp               = lazy(() => import('./PaintsharpApp').then(m => ({ default: m.ApexApp })))
  const MotionApp             = lazy(() => import('./PaintsharpApp').then(m => ({ default: m.MotionApp })))
  const KeyframeApp           = lazy(() => import('./PaintsharpApp').then(m => ({ default: m.KeyframeApp })))
  const PdfWriterListApp      = lazy(() => import('./PaintsharpApp').then(m => ({ default: m.PdfWriterListApp })))
  const FontApp               = lazy(() => import('./PaintsharpApp').then(m => ({ default: m.FontApp })))
  const VertexEditorPage      = lazy(() => import('./VertexEditorPage'))
  const ApexEditorPage        = lazy(() => import('./ApexEditorPage'))
  const LayerEditorPage       = lazy(() => import('./LayerEditorPage'))
  const KeyframeEditorPage    = lazy(() => import('./KeyframeEditorPage'))
  const MotionEditorPage      = lazy(() => import('./MotionEditorPage'))
  const PdfWriterEditorPage   = lazy(() => import('./PdfWriterEditorPage'))
  const FontEditorPage        = lazy(() => import('./FontEditorPage'))
  const PaintsharpSettingsPage = lazy(() => import('./PaintsharpSettingsPage'))

  RouteRegistry.register('paintsharp',                   PaintsharpApp)
  RouteRegistry.register('paintsharp/vertex',            VertexScenesApp)
  RouteRegistry.register('paintsharp/vertex/starred',    VertexScenesApp, { starred: true })
  RouteRegistry.register('paintsharp/trash',             VertexScenesApp, { trashed: true })
  RouteRegistry.register('paintsharp/scene/:id',         VertexEditorPage)
  RouteRegistry.register('paintsharp/layer',             LayerApp)
  RouteRegistry.register('paintsharp/layer/starred',     LayerApp, { starred: true })
  RouteRegistry.register('paintsharp/layer/trash',       LayerApp, { trashed: true })
  RouteRegistry.register('paintsharp/layer/:id',         LayerEditorPage)
  RouteRegistry.register('paintsharp/apex',              ApexApp)
  RouteRegistry.register('paintsharp/apex/starred',      ApexApp, { starred: true })
  RouteRegistry.register('paintsharp/apex/trash',        ApexApp, { trashed: true })
  RouteRegistry.register('paintsharp/apex/:id',          ApexEditorPage)
  RouteRegistry.register('paintsharp/motion',            MotionApp)
  RouteRegistry.register('paintsharp/motion/trash',      MotionApp, { trashed: true })
  RouteRegistry.register('paintsharp/motion/:id',        MotionEditorPage)
  RouteRegistry.register('paintsharp/settings',          PaintsharpSettingsPage)
  RouteRegistry.register('paintsharp/keyframe',          KeyframeApp)
  RouteRegistry.register('paintsharp/keyframe/trash',    KeyframeApp, { trashed: true })
  RouteRegistry.register('paintsharp/keyframe/:id',      KeyframeEditorPage)
  RouteRegistry.register('paintsharp/pdfwriter',         PdfWriterListApp)
  RouteRegistry.register('paintsharp/pdfwriter/starred', PdfWriterListApp, { starred: true })
  RouteRegistry.register('paintsharp/pdfwriter/trash',   PdfWriterListApp, { trashed: true })
  RouteRegistry.register('paintsharp/pdfwriter/:id',     PdfWriterEditorPage)
  RouteRegistry.register('paintsharp/fonteditor',         FontApp)
  RouteRegistry.register('paintsharp/fonteditor/starred', FontApp, { starred: true })
  RouteRegistry.register('paintsharp/fonteditor/trash',   FontApp, { trashed: true })
  RouteRegistry.register('paintsharp/fonteditor/:id',     FontEditorPage)
}
