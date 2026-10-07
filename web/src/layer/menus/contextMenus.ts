// The 18 right-click targets of the Layer editor, as pure data (spec §11).
//
// Same rules as `menuDefs.ts`: entries name command ids only. Context entries
// deliberately REUSE the menu-bar command ids and i18n keys — a right-click
// entry must never be a second, drifting copy of the same action.
//
// Shared layout convention (spec §11, "Principes communs"):
//   1. the two or three most likely actions on that target,
//   2. the structural actions,
//   3. after a separator, the destructive ones, flagged `danger`.
// A context menu never exceeds ~12 top-level entries; beyond that it folds into
// submenus.
import { MENU_PROVIDERS, ARRANGE_ITEMS, MASK_ITEMS, LOCK_ITEMS, SELECT_MODIFY_ITEMS } from './menuDefs'
import { SEP, type ContextMenuSpec, type MenuSpec } from './commandRegistry'

/** Every right-click target of the editor. */
export type LayerContextTarget =
  | 'canvas.move'          // §11.1  selection / move tool
  | 'canvas.selection'     // §11.2  geometric selection tools
  | 'canvas.paint'         // §11.3  brush / eraser / bucket
  | 'canvas.eyedropper'    // §11.4
  | 'canvas.crop'          // §11.5
  | 'canvas.text'          // §11.6
  | 'canvas.transform'     // §11.7
  | 'canvas.navigate'      // §11.8  zoom / hand
  | 'layers.row'           // §11.9  layer row
  | 'layers.group'         // §11.10 group row
  | 'layers.thumbnail'     // §11.11
  | 'layers.mask'          // §11.12 mask thumbnail
  | 'canvas.marquee'       // §11.13 right-click inside the active selection
  | 'ruler'                // §11.14
  | 'guide'                // §11.15
  | 'document.tab'         // §11.16
  | 'brush.preset'         // §11.17
  | 'swatch'               // §11.18

/* --------------------------------------------------- canvas, per tool ------ */

const CANVAS_MOVE: MenuSpec[] = [
  { cmd: 'layer.new.via_copy', key: 'layer_menu_layer_via_copy', fr: 'Calque par copie',   sc: 'Ctrl+J',     when: 'sel && !L.locked', p: 'P0' },
  { cmd: 'layer.new.via_cut',  key: 'layer_menu_layer_via_cut',  fr: 'Calque par découpe', sc: 'Ctrl+Maj+J', when: 'sel && !L.locked', p: 'P0' },
  SEP,
  { cmd: 'edit.transform.free', key: 'layer_menu_edit_transform_free', fr: 'Transformation manuelle', sc: 'Ctrl+T', when: 'L && !L.locked', p: 'P0' },
  { sub: 'layer.align', key: 'layer_menu_layer_align', fr: 'Aligner', when: 'nSelectedLayers > 1', provider: MENU_PROVIDERS.align, p: 'P2' },
  SEP,
  { cmd: 'edit.cut',         key: 'layer_cut',                   fr: 'Couper',             sc: 'Ctrl+X',     p: 'P0' },
  { cmd: 'edit.copy',        key: 'layer_copy',                  fr: 'Copier',             sc: 'Ctrl+C',     p: 'P0' },
  { cmd: 'edit.copy_merged', key: 'layer_menu_edit_copy_merged', fr: 'Copier avec fusion', sc: 'Ctrl+Maj+C', p: 'P1' },
  { cmd: 'edit.paste',       key: 'layer_paste',                 fr: 'Coller',             sc: 'Ctrl+V',     p: 'P0' },
  SEP,
  { sub: 'canvas.pick_layer', key: 'layer_menu_canvas_pick_layer', fr: 'Choisir le calque sous le curseur',
    provider: MENU_PROVIDERS.layersUnderCursor, p: 'P1' },
  { cmd: 'select.none', key: 'layer_deselect', fr: 'Désélectionner', sc: 'Ctrl+D', when: 'sel', p: 'P0' },
]

const CANVAS_SELECTION: MenuSpec[] = [
  { cmd: 'select.none',     key: 'layer_deselect',        fr: 'Désélectionner',  sc: 'Ctrl+D',     when: 'sel', p: 'P0' },
  { cmd: 'select.invert',   key: 'layer_select_invert',   fr: 'Intervertir',     sc: 'Ctrl+Maj+I', when: 'sel', p: 'P0' },
  { cmd: 'select.reselect', key: 'layer_select_reselect', fr: 'Resélectionner',  sc: 'Ctrl+Maj+D', when: 'hasStoredSelection', p: 'P0' },
  SEP,
  ...SELECT_MODIFY_ITEMS.map(s => ({ ...(s as object), when: 'sel' } as MenuSpec)),
  { cmd: 'select.transform', key: 'layer_menu_select_transform', fr: 'Transformer la sélection', when: 'sel', p: 'P1' },
  SEP,
  { cmd: 'edit.fill.custom', key: 'layer_menu_edit_fill_custom', fr: 'Remplir…', when: 'sel && !L.locked', p: 'P1' },
  { cmd: 'edit.stroke',      key: 'layer_menu_edit_stroke',      fr: 'Contour…', when: 'sel && !L.locked', p: 'P1' },
  SEP,
  { cmd: 'layer.new.via_copy',  key: 'layer_menu_layer_via_copy',      fr: 'Calque par copie',   sc: 'Ctrl+J',     when: 'sel && !L.locked', p: 'P0' },
  { cmd: 'layer.new.via_cut',   key: 'layer_menu_layer_via_cut',       fr: 'Calque par découpe', sc: 'Ctrl+Maj+J', when: 'sel && !L.locked', p: 'P0' },
  { cmd: 'layer.mask.from_sel', key: 'layer_menu_layer_mask_from_sel', fr: 'Créer un masque depuis la sélection', when: 'sel && L && !L.group', p: 'P0' },
  { cmd: 'select.save',         key: 'layer_menu_select_save',         fr: 'Mémoriser la sélection…', when: 'sel', p: 'P2' },
]

const CANVAS_PAINT: MenuSpec[] = [
  // Inline widget: two sliders (size, hardness) rendered by the provider.
  { dyn: MENU_PROVIDERS.brushSizeWidget },
  { sub: 'brush.presets', key: 'layer_brush_preset_label', fr: 'Formes prédéfinies', provider: MENU_PROVIDERS.brushPresets, p: 'P0' },
  SEP,
  { sub: 'tool.blend_mode', key: 'layer_menu_tool_blend_mode', fr: "Mode de fusion de l'outil", provider: MENU_PROVIDERS.toolBlendModes, p: 'P2' },
  { cmd: 'brush.studio', key: 'layer_brush_studio', fr: 'Studio de brosse…', when: 'toolBrush', p: 'P1' },
  SEP,
  { cmd: 'layer.mask.edit', key: 'layer_mask_edit',  fr: 'Modifier le masque', sc: '\\', check: true, when: 'L.mask', p: 'P0' },
  { cmd: 'layer.lock.alpha', key: 'layer_lock_alpha', fr: 'Verrouiller les pixels transparents', sc: '/', check: true, when: 'L && !L.group', p: 'P1' },
  SEP,
  { cmd: 'edit.undo', key: 'menu_undo', fr: 'Annuler le trait', sc: 'Ctrl+Z', when: 'canUndo', p: 'P0' },
]

const CANVAS_EYEDROPPER: MenuSpec[] = [
  { sub: 'eyedropper.sample_size',   key: 'layer_menu_eyedropper_size',   fr: 'Taille du prélèvement', provider: MENU_PROVIDERS.sampleSize,   p: 'P1' },
  { sub: 'eyedropper.sample_source', key: 'layer_menu_eyedropper_source', fr: 'Prélever sur',          provider: MENU_PROVIDERS.sampleSource, p: 'P1' },
  SEP,
  { cmd: 'color.copy_hex',    key: 'layer_menu_color_copy_hex',    fr: 'Copier le code couleur', p: 'P1' },
  { cmd: 'color.add_swatch',  key: 'layer_menu_color_add_swatch',  fr: 'Ajouter au nuancier',    p: 'P2' },
  { cmd: 'edit.colors.swap',  key: 'layer_menu_edit_swap_colors',  fr: 'Permuter premier plan / arrière-plan', sc: 'X', p: 'P1' },
]

const CANVAS_CROP: MenuSpec[] = [
  { cmd: 'crop.apply',  key: 'layer_crop_apply',  fr: 'Appliquer le recadrage', when: 'cropRect', p: 'P0' },
  { cmd: 'crop.cancel', key: 'layer_crop_cancel', fr: 'Annuler le recadrage',   when: 'cropRect', p: 'P0' },
  SEP,
  { sub: 'crop.ratio',   key: 'layer_menu_crop_ratio',   fr: 'Proportions',  provider: MENU_PROVIDERS.cropRatios,  p: 'P1' },
  { sub: 'crop.overlay', key: 'layer_menu_crop_overlay', fr: 'Superposition', provider: MENU_PROVIDERS.cropOverlay, p: 'P2' },
  SEP,
  { cmd: 'crop.delete_pixels', key: 'layer_menu_crop_delete_pixels', fr: 'Supprimer les pixels rognés', check: true, p: 'P1' },
]

const CANVAS_TEXT: MenuSpec[] = [
  { cmd: 'text.commit', key: 'layer_menu_text_commit', fr: 'Valider le texte',  when: 'editingText', p: 'P0' },
  { cmd: 'text.cancel', key: 'layer_menu_text_cancel', fr: 'Annuler la saisie', when: 'editingText', p: 'P0' },
  SEP,
  { sub: 'text.font',  key: 'layer_menu_text_font',  fr: 'Police',    when: 'editingText', provider: MENU_PROVIDERS.textFont,  p: 'P1' },
  { sub: 'text.size',  key: 'layer_text_size',       fr: 'Corps',     when: 'editingText', provider: MENU_PROVIDERS.textSize,  p: 'P1' },
  { sub: 'text.align', key: 'layer_menu_text_align', fr: 'Alignement', when: 'editingText', provider: MENU_PROVIDERS.textAlign, p: 'P1' },
  { cmd: 'text.color', key: 'layer_menu_text_color', fr: 'Couleur du texte…', when: 'editingText', p: 'P1' },
  SEP,
  { cmd: 'text.paste', key: 'layer_menu_text_paste', fr: 'Coller le texte', when: 'clipText', p: 'P1' },
]

const CANVAS_TRANSFORM: MenuSpec[] = [
  { cmd: 'transform.apply',  key: 'layer_menu_transform_apply',  fr: 'Appliquer', when: 'transforming', p: 'P0' },
  { cmd: 'transform.cancel', key: 'layer_menu_transform_cancel', fr: 'Annuler',   when: 'transforming', p: 'P0' },
  SEP,
  { cmd: 'edit.transform.flip_h',   key: 'layer_layer_flip_h',       fr: 'Symétrie horizontale',     when: 'transforming', p: 'P0' },
  { cmd: 'edit.transform.flip_v',   key: 'layer_layer_flip_v',       fr: 'Symétrie verticale',       when: 'transforming', p: 'P0' },
  { cmd: 'edit.transform.rot90cw',  key: 'layer_menu_edit_rot90cw',  fr: 'Rotation 90° horaire',     when: 'transforming', p: 'P0' },
  { cmd: 'edit.transform.rot90ccw', key: 'layer_menu_edit_rot90ccw', fr: 'Rotation 90° antihoraire', when: 'transforming', p: 'P0' },
  { cmd: 'edit.transform.rot180',   key: 'layer_layer_rot180',       fr: 'Rotation 180°',            when: 'transforming', p: 'P0' },
  SEP,
  { sub: 'transform.mode', key: 'layer_menu_transform_mode', fr: 'Mode', when: 'transforming', provider: MENU_PROVIDERS.transformMode, p: 'P2' },
  { cmd: 'transform.keep_ratio', key: 'layer_menu_transform_keep_ratio', fr: 'Conserver les proportions', check: true, p: 'P1' },
]

const CANVAS_NAVIGATE: MenuSpec[] = [
  { cmd: 'view.fit',       key: 'menu_fit',                  fr: 'Ajuster à la fenêtre', sc: 'Ctrl+0', p: 'P0' },
  { cmd: 'view.actual',    key: 'layer_zoom_100',            fr: 'Taille réelle',        sc: 'Ctrl+1', p: 'P0' },
  { cmd: 'view.fit_width', key: 'layer_menu_view_fit_width', fr: 'Ajuster à la largeur', p: 'P0' },
  SEP,
  { sub: 'view.zoom_presets', key: 'layer_zoom_presets', fr: 'Niveau de zoom', provider: MENU_PROVIDERS.zoomPresets, p: 'P1' },
  { cmd: 'view.rotate.reset', key: 'layer_rotate_reset', fr: "Réinitialiser la rotation de l'affichage", sc: 'Maj+R', when: 'viewRotated', p: 'P1' },
]

/** §11.13 — right-click inside the marching ants, whatever the active tool. */
const CANVAS_MARQUEE: MenuSpec[] = [
  { cmd: 'select.none',         key: 'layer_deselect',                 fr: 'Désélectionner', sc: 'Ctrl+D',     p: 'P0' },
  { cmd: 'select.invert',       key: 'layer_select_invert',            fr: 'Intervertir',    sc: 'Ctrl+Maj+I', p: 'P0' },
  { cmd: 'select.modify.feather', key: 'layer_select_feather',         fr: 'Contour progressif…', sc: 'Maj+F6', p: 'P0' },
  SEP,
  { cmd: 'layer.new.via_copy',  key: 'layer_menu_layer_via_copy',      fr: 'Calque par copie', sc: 'Ctrl+J', p: 'P0' },
  { cmd: 'layer.mask.from_sel', key: 'layer_menu_layer_mask_from_sel', fr: 'Créer un masque depuis la sélection', when: 'L && !L.group', p: 'P0' },
  { cmd: 'edit.fill.custom',    key: 'layer_menu_edit_fill_custom',    fr: 'Remplir…', when: '!L.locked', p: 'P1' },
  SEP,
  { cmd: 'image.crop_to_sel',   key: 'layer_image_crop_sel',           fr: 'Recadrer sur la sélection', when: '!embedded', p: 'P1' },
]

/* -------------------------------------------------- layers panel targets --- */

/** §11.9 — layer row. Replaces today's flat ~16-entry menu. */
const LAYERS_ROW: MenuSpec[] = [
  { cmd: 'layer.duplicate', key: 'layer_duplicate', fr: 'Dupliquer le calque…', sc: 'Ctrl+Alt+J', p: 'P0' },
  { cmd: 'layer.rename',    key: 'layer_rename',    fr: 'Renommer…',            sc: 'F2',         p: 'P0' },
  SEP,
  { cmd: 'layer.toggle_visible', key: 'layer_menu_layer_toggle_visible', fr: 'Afficher le calque', check: true, p: 'P0' },
  { cmd: 'layer.solo',           key: 'layer_solo',                      fr: 'Isoler le calque',   check: true, p: 'P1' },
  { sub: 'layer.lock',  key: 'layer_menu_layer_lock', fr: 'Verrouiller',        items: LOCK_ITEMS, p: 'P1' },
  { sub: 'layer.color', key: 'layer_color_title',     fr: "Couleur d'étiquette", provider: MENU_PROVIDERS.labelColors, p: 'P1' },
  SEP,
  { sub: 'layer.blend_mode', key: 'layer_menu_layer_blend_mode', fr: 'Mode de fusion', when: '!L.group', provider: MENU_PROVIDERS.blendModes, p: 'P0' },
  { sub: 'layer.opacity',    key: 'layer_opacity',               fr: 'Opacité',        provider: MENU_PROVIDERS.opacityPresets, p: 'P2' },
  { sub: 'layer.mask',       key: 'layer_menu_layer_mask',       fr: 'Masque de fusion', when: '!L.group', items: MASK_ITEMS, p: 'P0' },
  { cmd: 'layer.clipping',   key: 'layer_clip',                  fr: "Masque d'écrêtage", sc: 'Ctrl+Alt+G', check: true, when: '!L.group && !L.first', p: 'P0' },
  SEP,
  // Grouper / Dissocier are two mutually exclusive entries, never one entry with
  // a label that flips (spec §11.9).
  { cmd: 'layer.group',         key: 'layer_group',                    fr: 'Grouper',   sc: 'Ctrl+G',     when: '!L.group', p: 'P0' },
  { cmd: 'layer.ungroup',       key: 'layer_ungroup',                  fr: 'Dissocier', sc: 'Ctrl+Maj+G', when: 'L.group',  p: 'P0' },
  { cmd: 'layer.merge_down',    key: 'layer_merge_down',               fr: 'Fusionner avec le calque inférieur', sc: 'Ctrl+E', when: '!L.group && !L.last', p: 'P0' },
  { cmd: 'layer.merge_visible', key: 'layer_menu_layer_merge_visible', fr: 'Fusionner les visibles',   sc: 'Ctrl+Maj+E',     when: 'nVisible > 1', p: 'P1' },
  { cmd: 'layer.stamp_visible', key: 'layer_menu_layer_stamp_visible', fr: 'Estampiller les visibles', sc: 'Ctrl+Alt+Maj+E', when: 'nVisible > 1', p: 'P1' },
  { cmd: 'image.flatten',       key: 'layer_flatten',                  fr: "Aplatir l'image", when: 'nLeaves > 1', p: 'P1' },
  { sub: 'layer.arrange', key: 'layer_menu_layer_arrange', fr: 'Disposition', items: ARRANGE_ITEMS, p: 'P1' },
  SEP,
  { cmd: 'select.from_alpha', key: 'layer_select_from_alpha',     fr: 'Sélectionner les pixels du calque', when: '!L.group', p: 'P1' },
  { cmd: 'layer.blend_opts',  key: 'layer_menu_layer_blend_opts', fr: 'Options de fusion…', p: 'P1' },
  SEP,
  { cmd: 'layer.delete', key: 'layer_delete', fr: 'Supprimer le calque', danger: true, when: 'nLeaves > 1', p: 'P0' },
]

/** §11.10 — group row: the layer-row menu minus the entries that mean nothing on
 *  a group, plus the group-specific ones. */
const LAYERS_GROUP: MenuSpec[] = [
  { cmd: 'layer.duplicate', key: 'layer_duplicate', fr: 'Dupliquer le groupe…', sc: 'Ctrl+Alt+J', p: 'P0' },
  { cmd: 'layer.rename',    key: 'layer_rename',    fr: 'Renommer…',            sc: 'F2',         p: 'P0' },
  SEP,
  { cmd: 'layer.ungroup',      key: 'layer_ungroup',                fr: 'Dissocier le groupe', sc: 'Ctrl+Maj+G', p: 'P0' },
  { cmd: 'layer.group.merge',  key: 'layer_menu_group_merge',       fr: 'Fusionner le groupe', when: 'groupNotEmpty', p: 'P0' },
  { cmd: 'layer.group.expand', key: 'layer_menu_group_expand',      fr: 'Développer le groupe', check: true, p: 'P1' },
  { cmd: 'layer.group.expand_all', key: 'layer_menu_group_expand_all', fr: 'Tout développer', when: 'hasNestedGroups', p: 'P2' },
  { cmd: 'layer.group.collapse_all', key: 'layer_menu_group_collapse_all', fr: 'Tout réduire', when: 'hasNestedGroups', p: 'P2' },
  { cmd: 'layer.group.select_all', key: 'layer_menu_group_select_all', fr: 'Sélectionner tous les calques du groupe', when: 'groupNotEmpty', p: 'P2' },
  SEP,
  { cmd: 'layer.toggle_visible', key: 'layer_menu_layer_toggle_visible', fr: 'Afficher le groupe', check: true, p: 'P0' },
  { cmd: 'layer.solo',           key: 'layer_solo',                      fr: 'Isoler le groupe',   check: true, p: 'P1' },
  { cmd: 'layer.lock.position',  key: 'layer_lock_position',             fr: 'Verrouiller la position', check: true, p: 'P1' },
  { cmd: 'layer.lock.all',       key: 'layer_lock_all',                  fr: 'Tout verrouiller',        check: true, p: 'P1' },
  { sub: 'layer.color', key: 'layer_color_title', fr: "Couleur d'étiquette", provider: MENU_PROVIDERS.labelColors, p: 'P1' },
  SEP,
  { sub: 'layer.blend_mode', key: 'layer_menu_layer_blend_mode', fr: 'Mode de fusion', provider: MENU_PROVIDERS.blendModes, p: 'P1' },
  { sub: 'layer.opacity',    key: 'layer_opacity',               fr: 'Opacité',        provider: MENU_PROVIDERS.opacityPresets, p: 'P2' },
  { sub: 'layer.arrange',    key: 'layer_menu_layer_arrange',    fr: 'Disposition',    items: ARRANGE_ITEMS, p: 'P1' },
  SEP,
  { cmd: 'layer.delete', key: 'layer_delete', fr: 'Supprimer le groupe', danger: true, when: 'nLeaves > 1', p: 'P0' },
]

/** §11.11 — the thumbnail talks about the CONTENT, not about the layer. */
const LAYERS_THUMBNAIL: MenuSpec[] = [
  { cmd: 'select.from_alpha', key: 'layer_select_from_alpha', fr: 'Sélectionner les pixels du calque', when: '!L.group', p: 'P0' },
  SEP,
  { sub: 'layers.thumb_size',    key: 'layer_menu_thumb_size',    fr: 'Taille de la vignette',  provider: MENU_PROVIDERS.thumbSize,    p: 'P2' },
  { sub: 'layers.thumb_content', key: 'layer_menu_thumb_content', fr: 'Contenu de la vignette', provider: MENU_PROVIDERS.thumbContent, p: 'P2' },
]

/** §11.12 — mask thumbnail. */
const LAYERS_MASK: MenuSpec[] = [
  { cmd: 'layer.mask.edit',   key: 'layer_mask_edit',              fr: 'Modifier le masque',  sc: '\\', check: true, p: 'P0' },
  { cmd: 'layer.mask.enable', key: 'layer_menu_layer_mask_enable', fr: 'Activer le masque',   check: true, p: 'P1' },
  SEP,
  { cmd: 'layer.mask.apply',  key: 'layer_menu_layer_mask_apply',  fr: 'Appliquer le masque', p: 'P1' },
  { cmd: 'layer.mask.remove', key: 'layer_mask_remove',            fr: 'Supprimer le masque', danger: true, p: 'P0' },
  SEP,
  { cmd: 'layer.mask.invert',      key: 'layer_menu_layer_mask_invert',      fr: 'Inverser le masque', p: 'P1' },
  { cmd: 'layer.mask.select',      key: 'layer_menu_layer_mask_select',      fr: 'Sélectionner les pixels du masque', p: 'P1' },
  { cmd: 'layer.mask.sel_add',     key: 'layer_menu_layer_mask_sel_add',     fr: 'Ajouter à la sélection',   when: 'sel', p: 'P2' },
  { cmd: 'layer.mask.sel_subtract', key: 'layer_menu_layer_mask_sel_subtract', fr: 'Soustraire de la sélection', when: 'sel', p: 'P2' },
  { cmd: 'layer.mask.sel_intersect', key: 'layer_menu_layer_mask_sel_intersect', fr: 'Croiser avec la sélection', when: 'sel', p: 'P2' },
]

/* -------------------------------------------------------- chrome targets --- */

const RULER: MenuSpec[] = [
  { sub: 'ruler.units', key: 'layer_menu_ruler_units', fr: 'Unités', provider: MENU_PROVIDERS.rulerUnits, p: 'P1' },
  SEP,
  { cmd: 'view.guides.new',   key: 'layer_menu_view_new_guide_here', fr: 'Nouveau repère ici', when: 'rulers', p: 'P1' },
  { cmd: 'view.guides.clear', key: 'layer_menu_view_clear_guides',   fr: 'Effacer les repères', when: 'nGuides > 0', p: 'P1' },
  { cmd: 'view.guides.lock',  key: 'layer_menu_view_lock_guides',    fr: 'Verrouiller les repères', check: true, p: 'P2' },
  SEP,
  { cmd: 'view.rulers', key: 'layer_menu_view_rulers', fr: 'Règles', sc: 'Ctrl+R', check: true, p: 'P1' },
]

const GUIDE: MenuSpec[] = [
  { cmd: 'guide.delete', key: 'layer_menu_guide_delete', fr: 'Supprimer ce repère', danger: true, p: 'P1' },
  { cmd: 'guide.move',   key: 'layer_menu_guide_move',   fr: 'Modifier la position…', p: 'P2' },
  SEP,
  { cmd: 'view.guides.lock',  key: 'layer_menu_view_lock_guides',  fr: 'Verrouiller les repères', check: true, p: 'P2' },
  { cmd: 'view.guides.clear', key: 'layer_menu_view_clear_guides', fr: 'Effacer tous les repères', when: 'nGuides > 0', p: 'P1' },
]

const DOCUMENT_TAB: MenuSpec[] = [
  { cmd: 'file.save',    key: 'common_save',             fr: 'Enregistrer',       sc: 'Ctrl+S',     when: 'dirty', p: 'P0' },
  { cmd: 'file.save_as', key: 'layer_menu_file_save_as', fr: 'Enregistrer sous…', sc: 'Ctrl+Maj+S', p: 'P0' },
  SEP,
  { cmd: 'file.close',       key: 'menu_close',                fr: 'Fermer',        sc: 'Ctrl+W', when: '!embedded', p: 'P0' },
  { cmd: 'file.close_others', key: 'layer_menu_file_close_others', fr: 'Fermer les autres', when: 'nDocs > 1', p: 'P1' },
  { cmd: 'file.close_all',   key: 'layer_menu_file_close_all', fr: 'Fermer tout',   sc: 'Ctrl+Alt+W', when: 'nDocs > 1', p: 'P1' },
  SEP,
  { cmd: 'file.duplicate', key: 'layer_menu_file_duplicate', fr: 'Dupliquer le document…', p: 'P2' },
  { cmd: 'file.props',     key: 'layer_menu_file_props',     fr: 'Propriétés du document…', p: 'P1' },
  SEP,
  { cmd: 'file.copy_path',    key: 'layer_menu_file_copy_path',    fr: 'Copier le chemin du fichier', when: 'saved', p: 'P2' },
  { cmd: 'file.reveal_drive', key: 'layer_menu_file_reveal_drive', fr: 'Afficher dans Drive',         when: 'saved', p: 'P2' },
]

const BRUSH_PRESET: MenuSpec[] = [
  { cmd: 'brush.use', key: 'layer_menu_brush_use', fr: 'Utiliser cette forme', p: 'P0' },
  SEP,
  { cmd: 'brush.rename',    key: 'common_rename',              fr: 'Renommer…', when: 'customPreset', p: 'P2' },
  { cmd: 'brush.duplicate', key: 'common_duplicate',           fr: 'Dupliquer', p: 'P2' },
  { cmd: 'brush.delete',    key: 'common_delete',              fr: 'Supprimer', danger: true, when: 'customPreset', p: 'P2' },
  SEP,
  { cmd: 'brush.from_sel', key: 'layer_menu_brush_from_sel', fr: 'Nouvelle forme depuis la sélection…', when: 'sel', p: 'P2' },
  SEP,
  { sub: 'brush.display_size', key: 'layer_menu_brush_display', fr: "Taille d'affichage", provider: MENU_PROVIDERS.brushDisplaySize, p: 'P2' },
  { cmd: 'brush.reset', key: 'layer_menu_brush_reset', fr: 'Réinitialiser les formes', danger: true, p: 'P2' },
]

const SWATCH: MenuSpec[] = [
  { cmd: 'color.set_fg',       key: 'layer_menu_color_set_fg',      fr: 'Définir comme couleur de premier plan',  p: 'P1' },
  { cmd: 'color.set_bg',       key: 'layer_menu_color_set_bg',      fr: "Définir comme couleur d'arrière-plan",   p: 'P1' },
  { cmd: 'color.copy_hex',     key: 'layer_menu_color_copy_hex',    fr: 'Copier le code hexadécimal',             p: 'P1' },
  SEP,
  { cmd: 'color.add_swatch',   key: 'layer_menu_color_add_swatch',  fr: 'Ajouter la couleur de premier plan au nuancier', p: 'P2' },
  { cmd: 'color.remove_swatch', key: 'layer_menu_color_remove_swatch', fr: 'Supprimer du nuancier', danger: true, when: 'customSwatch', p: 'P2' },
]

/* -------------------------------------------------------------- registry -- */

export const LAYER_CONTEXT_MENUS: Record<LayerContextTarget, ContextMenuSpec> = {
  'canvas.move':       { id: 'canvas.move',       about: '§11.1 canvas — selection / move tool',   items: CANVAS_MOVE },
  'canvas.selection':  { id: 'canvas.selection',  about: '§11.2 canvas — geometric selection',     items: CANVAS_SELECTION },
  'canvas.paint':      { id: 'canvas.paint',      about: '§11.3 canvas — brush / eraser / bucket', items: CANVAS_PAINT },
  'canvas.eyedropper': { id: 'canvas.eyedropper', about: '§11.4 canvas — eyedropper',              items: CANVAS_EYEDROPPER },
  'canvas.crop':       { id: 'canvas.crop',       about: '§11.5 canvas — crop',                    items: CANVAS_CROP },
  'canvas.text':       { id: 'canvas.text',       about: '§11.6 canvas — text',                    items: CANVAS_TEXT },
  'canvas.transform':  { id: 'canvas.transform',  about: '§11.7 canvas — transform',               items: CANVAS_TRANSFORM },
  'canvas.navigate':   { id: 'canvas.navigate',   about: '§11.8 canvas — zoom / hand',             items: CANVAS_NAVIGATE },
  'layers.row':        { id: 'layers.row',        about: '§11.9 layers panel — layer row',         items: LAYERS_ROW },
  'layers.group':      { id: 'layers.group',      about: '§11.10 layers panel — group row',        items: LAYERS_GROUP },
  'layers.thumbnail':  { id: 'layers.thumbnail',  about: '§11.11 layers panel — layer thumbnail',  items: LAYERS_THUMBNAIL },
  'layers.mask':       { id: 'layers.mask',       about: '§11.12 layers panel — mask thumbnail',   when: 'L.mask', items: LAYERS_MASK },
  'canvas.marquee':    { id: 'canvas.marquee',    about: '§11.13 canvas — inside the active selection', when: 'sel', items: CANVAS_MARQUEE },
  'ruler':             { id: 'ruler',             about: '§11.14 ruler',                           items: RULER },
  'guide':             { id: 'guide',             about: '§11.15 guide',                           items: GUIDE },
  'document.tab':      { id: 'document.tab',      about: '§11.16 document tab',                    items: DOCUMENT_TAB },
  'brush.preset':      { id: 'brush.preset',      about: '§11.17 brush palette — preset tile',     items: BRUSH_PRESET },
  'swatch':            { id: 'swatch',            about: '§11.18 swatches / colour history',       items: SWATCH },
}

/** All right-click target ids, in spec order. */
export const LAYER_CONTEXT_TARGETS = Object.keys(LAYER_CONTEXT_MENUS) as LayerContextTarget[]

/** Maps an active tool id to the canvas context menu it should open. */
export const CANVAS_MENU_FOR_TOOL: Record<string, LayerContextTarget> = {
  select: 'canvas.move',
  move: 'canvas.move',
  rect_sel: 'canvas.selection',
  ellipse_sel: 'canvas.selection',
  lasso: 'canvas.selection',
  magic: 'canvas.selection',
  brush: 'canvas.paint',
  eraser: 'canvas.paint',
  fill: 'canvas.paint',
  eyedrop: 'canvas.eyedropper',
  crop: 'canvas.crop',
  text: 'canvas.text',
  transform: 'canvas.transform',
  hand: 'canvas.navigate',
  zoom: 'canvas.navigate',
  rotate: 'canvas.navigate',
}
