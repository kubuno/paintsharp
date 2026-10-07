// Declarative definition of the Layer editor menu bar — 9 menus, pure data.
//
// Entries only ever name a COMMAND ID (`cmd`) or a PROVIDER ID (`provider` /
// `dyn`); no function ever appears here. The editor binds the behaviour in its
// own file through `CommandRegistry.register()`, which keeps this file free of
// imports from `LayerEditorPage` and therefore free of merge conflicts.
//
// Fields: `cmd` command id · `key` i18n key · `fr` French fallback passed as
// i18next `defaultValue` (no new key is written to `i18n.ts` in this phase) ·
// `sc` displayed accelerator · `when` visibility predicate · `on` extra enable
// predicate · `check` render as a checkbox · `p` priority from the spec.
//
// State vocabulary used by `when` / `on` (see `commandRegistry.ts`):
//   doc  document open          sel        non-empty selection
//   L    active layer           L.group    active layer is a group
//   L.locked / L.mask           clip       internal clipboard non-empty
//   nLeaves  leaf layer count   embedded   editor embedded in another module
//   nDocs / nSelectedLayers / nVisible / nHidden / nGuides / zoom …
import { FILTER_GROUPS } from '../../layerFilters'
import { SEP, type MenuBarSpec, type MenuSpec } from './commandRegistry'

/* ------------------------------------------------------------ providers ---- */

/** Ids of the dynamic node providers the editor must register. Anything listed
 *  here that is not registered renders as a greyed-out submenu. */
export const MENU_PROVIDERS = {
  recentDocs: 'recent-docs',
  history: 'history-states',
  blendModes: 'blend-modes',
  opacityPresets: 'opacity-presets',
  layerStyles: 'layer-styles',
  rasterize: 'rasterize-targets',
  align: 'align-targets',
  distribute: 'distribute-targets',
  labelColors: 'label-colors',
  colorMode: 'color-modes',
  bitDepth: 'bit-depths',
  savedSelections: 'saved-selections',
  zoomPresets: 'zoom-presets',
  screenMode: 'screen-modes',
  windowLayouts: 'window-layouts',
  openDocuments: 'open-documents',
  /** One provider per filter group, id = `filters:<groupId>`. */
  filterGroup: (groupId: string) => `filters:${groupId}`,
  // Context-menu only providers.
  layersUnderCursor: 'layers-under-cursor',
  brushPresets: 'brush-presets',
  brushSizeWidget: 'brush-size-widget',
  brushDisplaySize: 'brush-display-size',
  toolBlendModes: 'tool-blend-modes',
  sampleSize: 'eyedropper-sample-size',
  sampleSource: 'eyedropper-sample-source',
  cropRatios: 'crop-ratios',
  cropOverlay: 'crop-overlays',
  textFont: 'text-fonts',
  textSize: 'text-sizes',
  textAlign: 'text-aligns',
  transformMode: 'transform-modes',
  thumbSize: 'thumbnail-sizes',
  thumbContent: 'thumbnail-contents',
  rulerUnits: 'ruler-units',
} as const

/* ---------------------------------------------------------- shared groups -- */

/** Layer ordering, reused by the Calque menu and by the layer-row context menu. */
export const ARRANGE_ITEMS: MenuSpec[] = [
  { cmd: 'layer.arrange.front',    key: 'layer_menu_layer_bring_front',   fr: 'Premier plan', sc: 'Ctrl+Maj+]', p: 'P0' },
  { cmd: 'layer.arrange.forward',  key: 'layer_menu_layer_bring_forward', fr: 'Avancer',      sc: 'Ctrl+]',     p: 'P0' },
  { cmd: 'layer.arrange.backward', key: 'layer_menu_layer_send_backward', fr: 'Reculer',      sc: 'Ctrl+[',     p: 'P0' },
  { cmd: 'layer.arrange.back',     key: 'layer_menu_layer_send_back',     fr: 'Arrière-plan', sc: 'Ctrl+Maj+[', p: 'P0' },
  { cmd: 'layer.arrange.reverse',  key: 'layer_menu_layer_reverse',       fr: "Inverser l'ordre", p: 'P2' },
]

/** Layer mask sub-menu. Ajouter / Supprimer are two distinct, mutually greyed
 *  entries — the current single toggling entry keeps the "Ajouter un masque"
 *  label even when clicking removes the mask (spec §12.2, gap #5). */
export const MASK_ITEMS: MenuSpec[] = [
  { cmd: 'layer.mask.add',       key: 'layer_mask_add',                  fr: 'Ajouter (tout faire apparaître)', p: 'P0' },
  { cmd: 'layer.mask.hide_all',  key: 'layer_menu_layer_mask_hide_all',  fr: 'Ajouter (tout masquer)',          p: 'P1' },
  { cmd: 'layer.mask.from_sel',  key: 'layer_menu_layer_mask_from_sel',  fr: 'Ajouter depuis la sélection',     p: 'P0' },
  { cmd: 'layer.mask.remove',    key: 'layer_mask_remove',               fr: 'Supprimer', danger: true,         p: 'P0' },
  { cmd: 'layer.mask.apply',     key: 'layer_menu_layer_mask_apply',     fr: 'Appliquer',                       p: 'P1' },
  SEP,
  { cmd: 'layer.mask.enable',    key: 'layer_menu_layer_mask_enable',    fr: 'Activer le masque', check: true,  p: 'P1' },
  { cmd: 'layer.mask.invert',    key: 'layer_menu_layer_mask_invert',    fr: 'Inverser',                        p: 'P1' },
  { cmd: 'layer.mask.edit',      key: 'layer_mask_edit',                 fr: 'Modifier le masque', sc: '\\', check: true, p: 'P0' },
]

/** Granular locks, reused by the Calque menu and the layer-row context menu. */
export const LOCK_ITEMS: MenuSpec[] = [
  { cmd: 'layer.lock.alpha',    key: 'layer_lock_alpha',    fr: 'Verrouiller les pixels transparents', sc: '/', check: true, when: '!L.group', p: 'P1' },
  { cmd: 'layer.lock.position', key: 'layer_lock_position', fr: 'Verrouiller la position', check: true, p: 'P1' },
  { cmd: 'layer.lock.all',      key: 'layer_lock_all',      fr: 'Tout verrouiller',        check: true, p: 'P1' },
]

/** Selection morphology, reused by the Sélection menu and the marquee menu.
 *  All four open a radius dialog: the current 2 / 2 / 4 px hard-coded values are
 *  the credibility gap called out by the spec (§6). */
export const SELECT_MODIFY_ITEMS: MenuSpec[] = [
  { cmd: 'select.modify.grow',    key: 'layer_select_grow',            fr: 'Dilater…',            p: 'P0' },
  { cmd: 'select.modify.shrink',  key: 'layer_select_shrink',          fr: 'Contracter…',         p: 'P0' },
  { cmd: 'select.modify.border',  key: 'layer_menu_select_border',     fr: 'Contour…',            p: 'P2' },
  { cmd: 'select.modify.smooth',  key: 'layer_menu_select_smooth',     fr: 'Lisser…',             p: 'P2' },
  { cmd: 'select.modify.feather', key: 'layer_select_feather',         fr: 'Contour progressif…', sc: 'Maj+F6', p: 'P0' },
]

/* ------------------------------------------------------- 2. Fichier -------- */

const FILE_MENU: MenuSpec[] = [
  { cmd: 'file.new',  key: 'layer_menu_file_new',  fr: 'Nouveau…', sc: 'Ctrl+N', p: 'P0' },
  { cmd: 'file.open', key: 'layer_menu_file_open', fr: 'Ouvrir…',  sc: 'Ctrl+O', p: 'P0' },
  { sub: 'file.open_recent', key: 'layer_menu_file_open_recent', fr: 'Ouvrir récent', on: 'nRecent > 0',
    provider: MENU_PROVIDERS.recentDocs, p: 'P1' },
  SEP,
  { sub: 'file.import', key: 'layer_menu_file_import', fr: 'Importer', on: 'doc', p: 'P0', items: [
    { cmd: 'file.import.image',     key: 'layer_import_image',              fr: 'Image comme calque…',     sc: 'Ctrl+Maj+P', p: 'P0' },
    { cmd: 'file.import.drive',     key: 'layer_menu_file_import_drive',    fr: 'Depuis Drive…',           p: 'P1' },
    { cmd: 'file.import.url',       key: 'layer_menu_file_import_url',      fr: 'Depuis une URL…',         p: 'P2' },
    { cmd: 'file.import.clipboard', key: 'layer_menu_file_import_clipboard', fr: 'Depuis le presse-papiers', p: 'P1' },
  ] },
  SEP,
  { cmd: 'file.save',      key: 'common_save',                 fr: 'Enregistrer',            sc: 'Ctrl+S',     p: 'P0' },
  { cmd: 'file.save_as',   key: 'layer_menu_file_save_as',     fr: 'Enregistrer sous…',      sc: 'Ctrl+Maj+S', p: 'P0' },
  { cmd: 'file.save_copy', key: 'layer_menu_file_save_copy',   fr: 'Enregistrer une copie…', p: 'P2' },
  { cmd: 'file.revert',    key: 'layer_menu_file_revert',      fr: 'Rétablir la dernière version enregistrée', sc: 'F12', p: 'P1' },
  SEP,
  { sub: 'file.export', key: 'layer_menu_file_export', fr: 'Exporter', on: 'doc', p: 'P0', items: [
    { cmd: 'file.export.png',    key: 'menu_export_png',                fr: 'PNG',                       p: 'P0' },
    { cmd: 'file.export.jpeg',   key: 'menu_export_jpeg',               fr: 'JPEG…',                     p: 'P0' },
    { cmd: 'file.export.webp',   key: 'layer_menu_file_export_webp',    fr: 'WebP…',                     p: 'P1' },
    { cmd: 'file.export.avif',   key: 'layer_menu_file_export_avif',    fr: 'AVIF…',                     p: 'P2' },
    { cmd: 'file.export.gif',    key: 'layer_menu_file_export_gif',     fr: 'GIF…',                      p: 'P2' },
    { cmd: 'file.export.tiff',   key: 'layer_menu_file_export_tiff',    fr: 'TIFF',                      p: 'P2' },
    { cmd: 'file.export.svg',    key: 'layer_menu_file_export_svg',     fr: 'SVG (image incorporée)',    p: 'P2' },
    { cmd: 'file.export.pdf',    key: 'layer_menu_file_export_pdf',     fr: 'PDF…',                      p: 'P2' },
    { cmd: 'file.export.layers', key: 'layer_menu_file_export_layers',  fr: 'Calques comme fichiers…', on: 'nLeaves > 1', p: 'P2' },
  ] },
  { cmd: 'file.export.web', key: 'layer_menu_file_export_web', fr: 'Exporter pour le web…', sc: 'Ctrl+Alt+Maj+S', p: 'P2' },
  SEP,
  { cmd: 'file.props', key: 'layer_menu_file_props', fr: 'Propriétés du document…', p: 'P1' },
  { cmd: 'file.print', key: 'layer_menu_file_print', fr: 'Imprimer…', sc: 'Ctrl+P', p: 'P2' },
  SEP,
  { cmd: 'file.close',     key: 'menu_close',                 fr: 'Fermer',      sc: 'Ctrl+W',     when: '!embedded', p: 'P0' },
  { cmd: 'file.close_all', key: 'layer_menu_file_close_all',  fr: 'Tout fermer', sc: 'Ctrl+Alt+W', when: '!embedded', on: 'nDocs > 1', p: 'P2' },
]

/* -------------------------------------------------------- 3. Édition ------- */

const EDIT_MENU: MenuSpec[] = [
  // Dynamic labels ("Annuler <action>") come from the command definition.
  { cmd: 'edit.undo', key: 'menu_undo', fr: 'Annuler',  sc: 'Ctrl+Z',     p: 'P0' },
  { cmd: 'edit.redo', key: 'menu_redo', fr: 'Rétablir', sc: 'Ctrl+Maj+Z', p: 'P0' },
  { sub: 'edit.history', key: 'layer_menu_edit_history', fr: 'Historique', provider: MENU_PROVIDERS.history, on: 'canUndo || canRedo', p: 'P2' },
  SEP,
  { cmd: 'edit.cut',            key: 'layer_cut',                     fr: 'Couper',            sc: 'Ctrl+X',         p: 'P0' },
  { cmd: 'edit.copy',           key: 'layer_copy',                    fr: 'Copier',            sc: 'Ctrl+C',         p: 'P0' },
  { cmd: 'edit.copy_merged',    key: 'layer_menu_edit_copy_merged',   fr: 'Copier avec fusion', sc: 'Ctrl+Maj+C',    p: 'P1' },
  { cmd: 'edit.paste',          key: 'layer_paste',                   fr: 'Coller',            sc: 'Ctrl+V',         p: 'P0' },
  { cmd: 'edit.paste_into',     key: 'layer_menu_edit_paste_into',    fr: 'Coller dedans',     sc: 'Ctrl+Alt+Maj+V', p: 'P2' },
  { cmd: 'edit.paste_in_place', key: 'layer_menu_edit_paste_in_place', fr: 'Coller au même emplacement', sc: 'Ctrl+Maj+V', p: 'P2' },
  SEP,
  { cmd: 'edit.clear', key: 'layer_clear_sel', fr: 'Effacer', sc: 'Suppr', p: 'P0' },
  { sub: 'edit.fill', key: 'layer_menu_edit_fill', fr: 'Remplir', on: '!L.locked && !L.group', p: 'P0', items: [
    { cmd: 'edit.fill.fg',     key: 'layer_fill_fg',                fr: 'Avec la couleur de premier plan',  sc: 'Alt+⌫',  p: 'P0' },
    { cmd: 'edit.fill.bg',     key: 'layer_menu_edit_fill_bg',      fr: "Avec la couleur d'arrière-plan",   sc: 'Ctrl+⌫', p: 'P1' },
    SEP,
    { cmd: 'edit.fill.white',  key: 'layer_menu_edit_fill_white',   fr: 'Avec du blanc',    p: 'P2' },
    { cmd: 'edit.fill.black',  key: 'layer_menu_edit_fill_black',   fr: 'Avec du noir',     p: 'P2' },
    { cmd: 'edit.fill.gray',   key: 'layer_menu_edit_fill_gray',    fr: 'Avec du gris 50 %', p: 'P2' },
    SEP,
    { cmd: 'edit.fill.custom', key: 'layer_menu_edit_fill_custom',  fr: 'Personnalisé…', sc: 'Maj+F5', p: 'P1' },
  ] },
  { cmd: 'edit.stroke', key: 'layer_menu_edit_stroke', fr: 'Contour…', p: 'P2' },
  SEP,
  { cmd: 'edit.transform.free', key: 'layer_menu_edit_transform_free', fr: 'Transformation manuelle', sc: 'Ctrl+T', p: 'P0' },
  { sub: 'edit.transform', key: 'layer_menu_edit_transform', fr: 'Transformation', on: 'L && !L.locked', p: 'P0', items: [
    { cmd: 'edit.transform.rot90cw',     key: 'layer_menu_edit_rot90cw',        fr: 'Rotation 90° horaire',     p: 'P0' },
    { cmd: 'edit.transform.rot90ccw',    key: 'layer_menu_edit_rot90ccw',       fr: 'Rotation 90° antihoraire', p: 'P0' },
    { cmd: 'edit.transform.rot180',      key: 'layer_layer_rot180',             fr: 'Rotation 180°',            p: 'P0' },
    { cmd: 'edit.transform.rot_free',    key: 'layer_menu_edit_rot_arbitrary',  fr: 'Rotation arbitraire…',     p: 'P1' },
    SEP,
    { cmd: 'edit.transform.flip_h',      key: 'layer_layer_flip_h',             fr: 'Symétrie horizontale',     p: 'P0' },
    { cmd: 'edit.transform.flip_v',      key: 'layer_layer_flip_v',             fr: 'Symétrie verticale',       p: 'P0' },
    SEP,
    { cmd: 'edit.transform.scale',       key: 'layer_menu_edit_scale',          fr: "Mise à l'échelle…",        p: 'P1' },
    { cmd: 'edit.transform.skew',        key: 'layer_menu_edit_skew',           fr: 'Inclinaison',              p: 'P2' },
    { cmd: 'edit.transform.distort',     key: 'layer_menu_edit_distort',        fr: 'Torsion',                  p: 'P2' },
    { cmd: 'edit.transform.perspective', key: 'layer_menu_edit_perspective',    fr: 'Perspective',              p: 'P2' },
    { cmd: 'edit.transform.warp',        key: 'layer_menu_edit_warp',           fr: 'Déformation',              p: 'P2' },
  ] },
  { cmd: 'edit.transform.again', key: 'layer_menu_edit_transform_again', fr: 'Répéter la transformation', sc: 'Ctrl+Maj+T', p: 'P2' },
  SEP,
  { cmd: 'edit.define_pattern', key: 'layer_menu_edit_define_pattern', fr: 'Définir comme motif…',  p: 'P2' },
  { cmd: 'edit.define_brush',   key: 'layer_menu_edit_define_brush',   fr: 'Définir comme forme…',  p: 'P2' },
  SEP,
  { sub: 'edit.colors', key: 'layer_menu_edit_colors', fr: 'Couleurs', p: 'P1', items: [
    { cmd: 'edit.colors.swap',  key: 'layer_menu_edit_swap_colors',  fr: 'Permuter premier plan / arrière-plan', sc: 'X', p: 'P1' },
    { cmd: 'edit.colors.reset', key: 'layer_menu_edit_reset_colors', fr: 'Couleurs par défaut (noir / blanc)',   sc: 'D', p: 'P1' },
  ] },
  // Same command as Aide ▸ Raccourcis clavier…; two accelerators, one id, so no
  // accelerator conflict is produced.
  { cmd: 'help.shortcuts', key: 'layer_menu_edit_shortcuts', fr: 'Raccourcis clavier…', sc: 'Ctrl+Alt+Maj+K', p: 'P2' },
  { cmd: 'edit.prefs',     key: 'layer_menu_edit_prefs',     fr: 'Préférences…',        sc: 'Ctrl+K',         p: 'P1' },
]

/* ---------------------------------------------------------- 4. Image ------- */

const ADJUSTMENT_ITEMS: MenuSpec[] = [
  { cmd: 'image.adj.brightness',    key: 'layer_menu_adj_brightness',     fr: 'Luminosité / Contraste…', p: 'P0' },
  { cmd: 'image.adj.levels',        key: 'layer_menu_adj_levels',         fr: 'Niveaux…',  sc: 'Ctrl+L', p: 'P0' },
  { cmd: 'image.adj.curves',        key: 'layer_menu_adj_curves',         fr: 'Courbes…',  sc: 'Ctrl+M', p: 'P0' },
  { cmd: 'image.adj.exposure',      key: 'layer_menu_adj_exposure',       fr: 'Exposition…', p: 'P1' },
  SEP,
  { cmd: 'image.adj.hue_sat',       key: 'layer_menu_adj_hue_sat',        fr: 'Teinte / Saturation…', sc: 'Ctrl+U', p: 'P0' },
  { cmd: 'image.adj.color_balance', key: 'layer_menu_adj_color_balance',  fr: 'Balance des couleurs…', sc: 'Ctrl+B', p: 'P1' },
  { cmd: 'image.adj.vibrance',      key: 'layer_menu_adj_vibrance',       fr: 'Vibrance…', p: 'P1' },
  { cmd: 'image.adj.bw',            key: 'layer_menu_adj_bw',             fr: 'Noir et blanc…', sc: 'Ctrl+Alt+Maj+B', p: 'P1' },
  { cmd: 'image.adj.photo_filter',  key: 'layer_menu_adj_photo_filter',   fr: 'Filtre photo…', p: 'P2' },
  { cmd: 'image.adj.channel_mixer', key: 'layer_menu_adj_channel_mixer',  fr: 'Mélangeur de couches…', p: 'P2' },
  { cmd: 'image.adj.match_color',   key: 'layer_menu_adj_match_color',    fr: 'Correspondance de couleur…', p: 'P2' },
  SEP,
  { cmd: 'image.adj.invert',        key: 'layer_menu_adj_invert',         fr: 'Négatif', sc: 'Ctrl+I', p: 'P0' },
  { cmd: 'image.adj.posterize',     key: 'layer_menu_adj_posterize',      fr: 'Postérisation…', p: 'P1' },
  { cmd: 'image.adj.threshold',     key: 'layer_menu_adj_threshold',      fr: 'Seuil…', p: 'P1' },
  { cmd: 'image.adj.gradient_map',  key: 'layer_menu_adj_gradient_map',   fr: 'Courbe de transfert de dégradé…', p: 'P2' },
  { cmd: 'image.adj.selective',     key: 'layer_menu_adj_selective_color', fr: 'Correction sélective…', p: 'P2' },
  SEP,
  { cmd: 'image.adj.shadows',       key: 'layer_menu_adj_shadows_highlights', fr: 'Tons foncés / Tons clairs…', p: 'P2' },
  { cmd: 'image.adj.desaturate',    key: 'layer_menu_adj_desaturate',     fr: 'Désaturer', sc: 'Ctrl+Maj+U', p: 'P0' },
  { cmd: 'image.adj.equalize',      key: 'layer_menu_adj_equalize',       fr: 'Égaliser', p: 'P2' },
  SEP,
  { cmd: 'image.adj.auto_tone',     key: 'layer_menu_adj_auto_tone',      fr: 'Tons automatiques',  sc: 'Ctrl+Maj+L',     p: 'P1' },
  { cmd: 'image.adj.auto_contrast', key: 'layer_menu_adj_auto_contrast',  fr: 'Contraste automatique', sc: 'Ctrl+Alt+Maj+L', p: 'P1' },
  { cmd: 'image.adj.auto_color',    key: 'layer_menu_adj_auto_color',     fr: 'Couleur automatique', sc: 'Ctrl+Maj+B',    p: 'P1' },
]

const IMAGE_MENU: MenuSpec[] = [
  { cmd: 'image.size',        key: 'layer_menu_image_size',        fr: "Taille de l'image…",             sc: 'Ctrl+Alt+I', p: 'P0' },
  { cmd: 'image.canvas_size', key: 'layer_menu_image_canvas_size', fr: 'Taille de la zone de travail…',  sc: 'Ctrl+Alt+C', p: 'P0' },
  SEP,
  { sub: 'image.rotate', key: 'layer_menu_image_rotate', fr: "Rotation de l'image", on: 'doc', p: 'P0', items: [
    { cmd: 'image.rotate.cw90',  key: 'layer_image_rot90cw',            fr: '90° horaire',     p: 'P0' },
    { cmd: 'image.rotate.ccw90', key: 'layer_image_rot90ccw',           fr: '90° antihoraire', p: 'P0' },
    { cmd: 'image.rotate.180',   key: 'layer_image_rot180',             fr: '180°',            p: 'P0' },
    { cmd: 'image.rotate.free',  key: 'layer_menu_image_rot_arbitrary', fr: 'Arbitraire…',     p: 'P1' },
    SEP,
    { cmd: 'image.flip_h',       key: 'layer_image_flip_h',             fr: "Symétrie horizontale de l'image", p: 'P0' },
    { cmd: 'image.flip_v',       key: 'layer_image_flip_v',             fr: "Symétrie verticale de l'image",   p: 'P0' },
  ] },
  SEP,
  { cmd: 'image.crop_to_sel', key: 'layer_image_crop_sel',          fr: 'Recadrer sur la sélection', when: '!embedded', p: 'P0' },
  { cmd: 'image.trim',        key: 'layer_menu_image_trim',         fr: 'Rogner…',                p: 'P1' },
  { cmd: 'image.reveal_all',  key: 'layer_menu_image_reveal_all',   fr: 'Tout faire apparaître',  p: 'P2' },
  SEP,
  { sub: 'image.adjustments', key: 'layer_menu_image_adjustments', fr: 'Réglages',
    on: 'L && !L.group && !L.locked', items: ADJUSTMENT_ITEMS, p: 'P0' },
  SEP,
  { sub: 'image.mode',  key: 'layer_menu_image_mode',  fr: 'Mode colorimétrique', on: 'doc', provider: MENU_PROVIDERS.colorMode, p: 'P2' },
  { sub: 'image.depth', key: 'layer_menu_image_depth', fr: 'Profondeur',          on: 'doc', provider: MENU_PROVIDERS.bitDepth,  p: 'P2' },
  SEP,
  // ARBITRAGE Ctrl+Maj+E — the spec assigns it to Aplatir (§4) AND to Fusionner
  // les calques visibles (§5). It goes to merge-visible, the conventional
  // binding users expect; Aplatir keeps no accelerator in either menu.
  { cmd: 'image.flatten',   key: 'layer_flatten',                 fr: "Aplatir l'image", on: 'nLeaves > 1', p: 'P0' },
  { cmd: 'image.histogram', key: 'layer_menu_image_histogram',    fr: 'Histogramme…',    p: 'P2' },
]

/* --------------------------------------------------------- 5. Calque ------- */

const LAYER_MENU: MenuSpec[] = [
  { sub: 'layer.new', key: 'layer_menu_layer_new', fr: 'Nouveau', on: 'doc', p: 'P0', items: [
    { cmd: 'layer.new.raster',     key: 'layer_menu_layer_new_raster',   fr: 'Calque…',                 sc: 'Ctrl+Maj+N',     p: 'P0' },
    { cmd: 'layer.new.quick',      key: 'layer_new_layer',               fr: 'Calque (sans dialogue)',  sc: 'Ctrl+Alt+Maj+N', p: 'P0' },
    { cmd: 'layer.new.group',      key: 'layer_menu_layer_new_group',    fr: 'Groupe…',                 p: 'P1' },
    // Alias of Calque ▸ Grouper les calques: same id, so Ctrl+G is declared once.
    { cmd: 'layer.group',          key: 'layer_menu_layer_group_from',   fr: 'Groupe depuis les calques', sc: 'Ctrl+G',       p: 'P0' },
    SEP,
    // ARBITRAGE Ctrl+J → Calque par copie (what the keyboard already does);
    // Dupliquer le calque moves to Ctrl+Alt+J. Menu and keyboard finally agree.
    { cmd: 'layer.new.via_copy',   key: 'layer_menu_layer_via_copy',     fr: 'Calque par copie',        sc: 'Ctrl+J',     p: 'P0' },
    { cmd: 'layer.new.via_cut',    key: 'layer_menu_layer_via_cut',      fr: 'Calque par découpe',      sc: 'Ctrl+Maj+J', p: 'P1' },
    { cmd: 'layer.new.background', key: 'layer_menu_layer_to_background', fr: 'Arrière-plan depuis le calque', p: 'P2' },
  ] },
  { cmd: 'layer.duplicate', key: 'layer_duplicate', fr: 'Dupliquer le calque…', sc: 'Ctrl+Alt+J', p: 'P0' },
  { sub: 'layer.delete', key: 'layer_menu_layer_delete', fr: 'Supprimer', on: 'L', p: 'P0', items: [
    { cmd: 'layer.delete',        key: 'layer_delete',                    fr: 'Le calque', danger: true, on: 'nLeaves > 1', p: 'P0' },
    { cmd: 'layer.delete.hidden', key: 'layer_menu_layer_delete_hidden',  fr: 'Les calques masqués', danger: true, on: 'nHidden > 0', p: 'P2' },
    { cmd: 'layer.delete.empty',  key: 'layer_menu_layer_delete_empty',   fr: 'Les calques vides',   danger: true, on: 'nEmpty > 0',  p: 'P2' },
  ] },
  SEP,
  { cmd: 'layer.rename',     key: 'layer_rename',                   fr: 'Renommer le calque…', sc: 'F2', p: 'P0' },
  { cmd: 'layer.blend_opts', key: 'layer_menu_layer_blend_opts',    fr: 'Options de fusion…', p: 'P1' },
  { sub: 'layer.blend_mode', key: 'layer_menu_layer_blend_mode', fr: 'Mode de fusion', on: 'L', provider: MENU_PROVIDERS.blendModes, p: 'P0' },
  { sub: 'layer.opacity',    key: 'layer_opacity',               fr: 'Opacité',        on: 'L', provider: MENU_PROVIDERS.opacityPresets, p: 'P2' },
  { sub: 'layer.style',      key: 'layer_menu_layer_style',      fr: 'Style de calque', on: 'L && !L.group', provider: MENU_PROVIDERS.layerStyles, p: 'P2' },
  SEP,
  { sub: 'layer.mask', key: 'layer_menu_layer_mask', fr: 'Masque de fusion', on: 'L && !L.group', items: MASK_ITEMS, p: 'P0' },
  { cmd: 'layer.clipping', key: 'layer_clip', fr: "Masque d'écrêtage", sc: 'Ctrl+Alt+G', check: true, on: 'L && !L.group && !L.first', p: 'P0' },
  SEP,
  { sub: 'layer.arrange',    key: 'layer_menu_layer_arrange',    fr: 'Disposition', on: 'L', items: ARRANGE_ITEMS, p: 'P0' },
  { sub: 'layer.align',      key: 'layer_menu_layer_align',      fr: 'Aligner',     on: 'nSelectedLayers > 1 || sel', provider: MENU_PROVIDERS.align, p: 'P2' },
  { sub: 'layer.distribute', key: 'layer_menu_layer_distribute', fr: 'Répartir',    on: 'nSelectedLayers > 2', provider: MENU_PROVIDERS.distribute, p: 'P2' },
  SEP,
  { sub: 'layer.lock',  key: 'layer_menu_layer_lock',  fr: 'Verrouiller',       on: 'L', items: LOCK_ITEMS, p: 'P1' },
  { sub: 'layer.color', key: 'layer_color_title',      fr: "Couleur d'étiquette", on: 'L', provider: MENU_PROVIDERS.labelColors, p: 'P1' },
  { sub: 'layer.visibility', key: 'layer_menu_layer_visibility', fr: 'Visibilité', on: 'L', p: 'P1', items: [
    { cmd: 'layer.toggle_visible', key: 'layer_menu_layer_toggle_visible', fr: 'Afficher le calque', check: true, p: 'P0' },
    { cmd: 'layer.solo',           key: 'layer_solo',                      fr: 'Isoler le calque',   check: true, p: 'P1' },
    { cmd: 'layer.show_all',       key: 'layer_menu_layer_show_all',       fr: 'Tout afficher', on: 'nHidden > 0', p: 'P2' },
  ] },
  SEP,
  { cmd: 'layer.group',         key: 'layer_group',                     fr: 'Grouper les calques',   sc: 'Ctrl+G',     p: 'P0' },
  { cmd: 'layer.ungroup',       key: 'layer_ungroup',                   fr: 'Dissocier les calques', sc: 'Ctrl+Maj+G', p: 'P0' },
  { cmd: 'layer.merge_down',    key: 'layer_merge_down',                fr: 'Fusionner avec le calque inférieur', sc: 'Ctrl+E', p: 'P0' },
  { cmd: 'layer.merge_visible', key: 'layer_menu_layer_merge_visible',  fr: 'Fusionner les calques visibles',     sc: 'Ctrl+Maj+E', on: 'nVisible > 1', p: 'P0' },
  { cmd: 'layer.stamp_visible', key: 'layer_menu_layer_stamp_visible',  fr: 'Estampiller les calques visibles',   sc: 'Ctrl+Alt+Maj+E', on: 'nVisible > 1', p: 'P1' },
  // Alias of Image ▸ Aplatir l'image — same id, no duplicate accelerator.
  { cmd: 'image.flatten',       key: 'layer_flatten',                   fr: "Aplatir l'image", on: 'nLeaves > 1', p: 'P0' },
  SEP,
  { sub: 'layer.rasterize', key: 'layer_menu_layer_rasterize', fr: 'Pixelliser', on: 'L && !L.raster', provider: MENU_PROVIDERS.rasterize, p: 'P2' },
  { cmd: 'layer.to_smart',  key: 'layer_menu_layer_to_smart',  fr: 'Convertir en objet dynamique', p: 'P2' },
]

/* ------------------------------------------------------- 6. Sélection ------ */

const SELECT_MENU: MenuSpec[] = [
  { cmd: 'select.all',      key: 'layer_select_all',      fr: 'Tout sélectionner', sc: 'Ctrl+A',     p: 'P0' },
  { cmd: 'select.none',     key: 'layer_deselect',        fr: 'Désélectionner',    sc: 'Ctrl+D',     p: 'P0' },
  { cmd: 'select.reselect', key: 'layer_select_reselect', fr: 'Resélectionner',    sc: 'Ctrl+Maj+D', p: 'P1' },
  { cmd: 'select.invert',   key: 'layer_select_invert',   fr: 'Intervertir',       sc: 'Ctrl+Maj+I', p: 'P0' },
  SEP,
  { cmd: 'select.from_alpha', key: 'layer_select_from_alpha', fr: 'Sélectionner les pixels du calque',
    sc: 'Ctrl+clic vignette', bind: false, p: 'P1' },
  { sub: 'select.load', key: 'layer_menu_select_load', fr: 'Charger la sélection', on: 'nSavedSelections > 0',
    provider: MENU_PROVIDERS.savedSelections, p: 'P2' },
  { cmd: 'select.save', key: 'layer_menu_select_save', fr: 'Mémoriser la sélection…', p: 'P2' },
  SEP,
  { cmd: 'select.color_range', key: 'layer_menu_select_color_range', fr: 'Plage de couleurs…', p: 'P1' },
  { cmd: 'select.subject',     key: 'layer_menu_select_subject',     fr: 'Sélection du sujet', p: 'P2' },
  SEP,
  { sub: 'select.modify', key: 'layer_menu_select_modify', fr: 'Modifier', on: 'sel', items: SELECT_MODIFY_ITEMS, p: 'P0' },
  { cmd: 'select.grow_similar', key: 'layer_menu_select_grow_similar', fr: 'Étendre / Généraliser', p: 'P2' },
  SEP,
  { cmd: 'select.transform', key: 'layer_menu_select_transform', fr: 'Transformer la sélection', p: 'P1' },
  // Same toggle as Affichage ▸ Contour de sélection. One id, one accelerator,
  // one truthful label ("coché = liseré visible") instead of two entries whose
  // wording contradicts each other.
  { cmd: 'view.selection_edges', key: 'layer_menu_view_show_selection', fr: 'Contour de sélection', sc: 'Ctrl+H', check: true, p: 'P1' },
]

/* --------------------------------------------------------- 7. Filtre ------- */

const FILTER_MENU: MenuSpec[] = [
  { cmd: 'filter.repeat',        key: 'layer_menu_filter_repeat',        fr: 'Répéter le dernier filtre', sc: 'Ctrl+F',     p: 'P0' },
  { cmd: 'filter.repeat_dialog', key: 'layer_menu_filter_repeat_dialog', fr: 'Rouvrir le dernier filtre…', sc: 'Ctrl+Alt+F', p: 'P1' },
  SEP,
  { cmd: 'filter.gallery', key: 'layer_filter_gallery', fr: 'Galerie de filtres…', p: 'P0' },
  SEP,
  // The ~55-filter catalogue already exists (`layerFilters.ts`); only its
  // PRESENTATION changes: 10 submenus instead of one flat 65-line list with
  // disabled pseudo-headers. No new translation — `filt_group_*` / `filt_*` are
  // already shipped in all 13 languages.
  ...FILTER_GROUPS.map<MenuSpec>(g => ({
    sub: `filter.group.${g.id}`,
    key: g.nameKey,
    on: 'L && !L.group && !L.locked',
    provider: MENU_PROVIDERS.filterGroup(g.id),
    p: 'P1' as const,
  })),
  SEP,
  { cmd: 'filter.smart', key: 'layer_menu_filter_smart', fr: 'Convertir pour filtres dynamiques', p: 'P2' },
]

/* ------------------------------------------------------ 8. Affichage ------- */

const VIEW_MENU: MenuSpec[] = [
  { cmd: 'view.zoom_in',    key: 'menu_zoom_in',                fr: 'Zoom avant',            sc: 'Ctrl++', p: 'P0' },
  { cmd: 'view.zoom_out',   key: 'menu_zoom_out',               fr: 'Zoom arrière',          sc: 'Ctrl+-', p: 'P0' },
  { cmd: 'view.actual',     key: 'layer_zoom_100',              fr: 'Taille réelle (100 %)', sc: 'Ctrl+1', p: 'P0' },
  { cmd: 'view.fit',        key: 'menu_fit',                    fr: 'Ajuster à la fenêtre',  sc: 'Ctrl+0', p: 'P0' },
  { cmd: 'view.fit_width',  key: 'layer_menu_view_fit_width',   fr: 'Ajuster à la largeur',  p: 'P2' },
  { cmd: 'view.fit_height', key: 'layer_menu_view_fit_height',  fr: 'Ajuster à la hauteur',  p: 'P2' },
  { sub: 'view.zoom_presets', key: 'layer_zoom_presets', fr: 'Niveau de zoom', on: 'doc', provider: MENU_PROVIDERS.zoomPresets, p: 'P1' },
  SEP,
  { sub: 'view.rotate', key: 'layer_menu_view_rotate', fr: "Rotation de l'affichage", on: 'doc', p: 'P1', items: [
    { cmd: 'view.rotate.ccw',   key: 'layer_rotate_ccw',   fr: 'Pivoter à gauche', p: 'P1' },
    { cmd: 'view.rotate.cw',    key: 'layer_rotate_cw',    fr: 'Pivoter à droite', p: 'P1' },
    { cmd: 'view.rotate.reset', key: 'layer_rotate_reset', fr: 'Réinitialiser la rotation', sc: 'Maj+R', p: 'P1' },
  ] },
  SEP,
  { cmd: 'view.rulers', key: 'layer_menu_view_rulers', fr: 'Règles', sc: 'Ctrl+R', check: true, p: 'P1' },
  { sub: 'view.guides', key: 'layer_menu_view_guides', fr: 'Repères', on: 'doc', p: 'P1', items: [
    { cmd: 'view.guides.show',   key: 'layer_menu_view_show_guides',  fr: 'Afficher les repères',   sc: 'Ctrl+;',     check: true, p: 'P1' },
    { cmd: 'view.guides.lock',   key: 'layer_menu_view_lock_guides',  fr: 'Verrouiller les repères', sc: 'Ctrl+Alt+;', check: true, p: 'P2' },
    SEP,
    { cmd: 'view.guides.new',    key: 'layer_menu_view_new_guide',    fr: 'Nouveau repère…', p: 'P1' },
    { cmd: 'view.guides.layout', key: 'layer_menu_view_guide_layout', fr: 'Nouvelle disposition de repères…', p: 'P2' },
    { cmd: 'view.guides.clear',  key: 'layer_menu_view_clear_guides', fr: 'Effacer les repères', on: 'nGuides > 0', p: 'P1' },
  ] },
  { cmd: 'view.grid',           key: 'layer_menu_view_grid',          fr: 'Grille', sc: "Ctrl+'", check: true, p: 'P1' },
  // The hard-coded '✓ ' prefix on this entry is exactly what the model removes.
  { cmd: 'view.pixel_grid',     key: 'layer_pixel_grid',              fr: 'Grille de pixels', check: true, p: 'P0' },
  { cmd: 'view.selection_edges', key: 'layer_menu_view_show_selection', fr: 'Contour de sélection', sc: 'Ctrl+H', check: true, p: 'P1' },
  { cmd: 'view.layer_edges',    key: 'layer_menu_view_layer_edges',   fr: 'Bords du calque', check: true, p: 'P2' },
  { cmd: 'view.checkerboard',   key: 'layer_menu_view_checkerboard',  fr: 'Transparence en damier', check: true, p: 'P1' },
  SEP,
  { cmd: 'view.snap', key: 'layer_menu_view_snap', fr: 'Magnétisme', sc: 'Ctrl+Maj+;', check: true, p: 'P1' },
  { sub: 'view.snap_to', key: 'layer_menu_view_snap_to', fr: 'Magnétisme sur', on: 'snap', p: 'P2', items: [
    { cmd: 'view.snap_to.guides',    key: 'layer_menu_view_snap_guides',  fr: 'Repères',           check: true, p: 'P2' },
    { cmd: 'view.snap_to.grid',      key: 'layer_menu_view_snap_grid',    fr: 'Grille',            check: true, p: 'P2' },
    { cmd: 'view.snap_to.doc_edges', key: 'layer_menu_view_snap_doc',     fr: 'Bords du document', check: true, p: 'P2' },
    { cmd: 'view.snap_to.layers',    key: 'layer_menu_view_snap_layers',  fr: 'Calques',           check: true, p: 'P2' },
  ] },
  SEP,
  { sub: 'view.screen_mode', key: 'layer_menu_view_screen_mode', fr: "Mode d'affichage", on: 'doc', provider: MENU_PROVIDERS.screenMode, p: 'P2' },
  { cmd: 'view.hide_panels', key: 'layer_toggle_tabs', fr: 'Masquer les panneaux', sc: 'Tab', check: true, p: 'P1' },
]

/* -------------------------------------------------------- 9. Fenêtre ------- */

const WINDOW_MENU: MenuSpec[] = [
  { sub: 'window.layout', key: 'layer_menu_window_layout', fr: 'Disposition', p: 'P2', items: [
    { dyn: MENU_PROVIDERS.windowLayouts },
    SEP,
    { cmd: 'window.layout.save',  key: 'layer_menu_window_layout_save',  fr: 'Enregistrer la disposition…', p: 'P2' },
    { cmd: 'window.layout.reset', key: 'layer_menu_window_layout_reset', fr: 'Réinitialiser la disposition', p: 'P1' },
  ] },
  SEP,
  { cmd: 'window.panel.layers',    key: 'layer_panel_layers',                  fr: 'Calques',              sc: 'F7', check: true, p: 'P0' },
  { cmd: 'window.panel.adjust',    key: 'layer_panel_adjust',                  fr: 'Réglages',             check: true, p: 'P0' },
  { cmd: 'window.panel.filters',   key: 'layer_panel_filters',                 fr: 'Filtres',              check: true, p: 'P0' },
  { cmd: 'window.panel.toolprops', key: 'layer_menu_window_panel_toolprops',   fr: "Propriétés de l'outil", check: true, p: 'P1' },
  { cmd: 'window.panel.navigator', key: 'layer_panel_navigator',               fr: 'Navigateur',           check: true, p: 'P1' },
  { cmd: 'window.panel.color',     key: 'layer_menu_window_panel_color',       fr: 'Couleur',              sc: 'F6', check: true, p: 'P1' },
  { cmd: 'window.panel.swatches',  key: 'layer_menu_window_panel_swatches',    fr: 'Nuancier',             check: true, p: 'P2' },
  { cmd: 'window.panel.brushes',   key: 'layer_menu_window_panel_brushes',     fr: 'Brosses',              sc: 'F5', check: true, p: 'P1' },
  { cmd: 'window.panel.history',   key: 'layer_menu_window_panel_history',     fr: 'Historique',           check: true, p: 'P2' },
  { cmd: 'window.panel.histogram', key: 'layer_menu_window_panel_histogram',   fr: 'Histogramme',          check: true, p: 'P2' },
  { cmd: 'window.panel.info',      key: 'layer_menu_window_panel_info',        fr: 'Informations',         sc: 'F8', check: true, p: 'P2' },
  SEP,
  { cmd: 'window.toolbar',   key: 'layer_menu_window_toolbar',   fr: "Barre d'outils", check: true, p: 'P1' },
  { cmd: 'window.statusbar', key: 'layer_menu_window_statusbar', fr: "Barre d'état",   check: true, p: 'P2' },
  SEP,
  { cmd: 'window.next_doc', key: 'layer_menu_window_next_doc', fr: 'Document suivant',   sc: 'Ctrl+Tab',     on: 'nDocs > 1', p: 'P1' },
  { cmd: 'window.prev_doc', key: 'layer_menu_window_prev_doc', fr: 'Document précédent', sc: 'Ctrl+Maj+Tab', on: 'nDocs > 1', p: 'P1' },
  SEP,
  { dyn: MENU_PROVIDERS.openDocuments },
]

/* ----------------------------------------------------------- 10. Aide ------ */

const HELP_MENU: MenuSpec[] = [
  { cmd: 'help.docs',      key: 'layer_menu_help_docs',      fr: 'Aide de Paintsharp',     sc: 'F1',     p: 'P1' },
  { cmd: 'help.shortcuts', key: 'layer_menu_help_shortcuts', fr: 'Raccourcis clavier…',    sc: 'Ctrl+/', p: 'P0' },
  { cmd: 'help.tour',      key: 'layer_menu_help_tour',      fr: 'Prise en main',          p: 'P2' },
  SEP,
  { cmd: 'help.changelog', key: 'layer_menu_help_changelog', fr: 'Nouveautés de cette version', p: 'P2' },
  { cmd: 'help.report',    key: 'layer_menu_help_report',    fr: 'Signaler un problème',   p: 'P2' },
  SEP,
  { cmd: 'help.sysinfo',   key: 'layer_menu_help_sysinfo',   fr: 'Informations système',   p: 'P1' },
  { cmd: 'help.about',     key: 'layer_menu_help_about',     fr: 'À propos de Paintsharp', p: 'P0' },
]

/* ------------------------------------------------------------ menu bar ----- */

/** The 9 menus of the Layer editor, in target order. */
export const LAYER_MENU_BAR: MenuBarSpec[] = [
  { id: 'menu.file',   key: 'menu_file',         fr: 'Fichier',   items: FILE_MENU },
  { id: 'menu.edit',   key: 'menu_edit',         fr: 'Édition',   items: EDIT_MENU },
  { id: 'menu.image',  key: 'menu_image',        fr: 'Image',     items: IMAGE_MENU },
  { id: 'menu.layer',  key: 'menu_layer',        fr: 'Calque',    items: LAYER_MENU },
  { id: 'menu.select', key: 'menu_select',       fr: 'Sélection', items: SELECT_MENU },
  { id: 'menu.filter', key: 'menu_filter',       fr: 'Filtre',    items: FILTER_MENU },
  { id: 'menu.view',   key: 'menu_view',         fr: 'Affichage', items: VIEW_MENU },
  { id: 'menu.window', key: 'layer_menu_window', fr: 'Fenêtre',   items: WINDOW_MENU },
  { id: 'menu.help',   key: 'layer_menu_help',   fr: 'Aide',      items: HELP_MENU },
]

export { FILE_MENU, EDIT_MENU, IMAGE_MENU, LAYER_MENU, SELECT_MENU, FILTER_MENU, VIEW_MENU, WINDOW_MENU, HELP_MENU, ADJUSTMENT_ITEMS }
