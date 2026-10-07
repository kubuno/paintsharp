// Layer editor menu model — public surface.
//
// Wiring recipe for `LayerEditorPage`:
//
//   const registry = useMemo(() => createCommandRegistry().registerAll({ … }), [])
//   const ctx      = { t, flags: { doc: !!docId, sel: hasSel, … } }
//   const menus    = registry.buildMenuBar(LAYER_MENU_BAR, ctx)
//   <MenuBar menus={toWorkspaceMenus(menus)} C={C} />            // legacy bar
//   const accels   = collectAccelerators(menus)                  // keyboard
//   ctxMenu.open(e, registry.buildContextMenu(LAYER_CONTEXT_MENUS['layers.row'], ctx))
export {
  CommandRegistry, createCommandRegistry, radioGroup, evalWhen, compilePredicate,
  SEP, isSeparatorSpec, isHeadingSpec, isEntrySpec, isSubmenuSpec, isDynamicSpec,
} from './commandRegistry'
export type {
  MenuContext, MenuFlags, MenuTranslate, CommandDefinition, CommandKind, MenuNodeProvider,
  MenuSpec, MenuEntrySpec, MenuSubmenuSpec, MenuHeadingSpec, MenuDynamicSpec, MenuSeparatorSpec,
  MenuBarSpec, ContextMenuSpec, MenuPriority, BuildOptions, MissingPolicy, ResolvedState,
} from './commandRegistry'

export {
  LAYER_MENU_BAR, MENU_PROVIDERS,
  ARRANGE_ITEMS, MASK_ITEMS, LOCK_ITEMS, SELECT_MODIFY_ITEMS,
} from './menuDefs'

export { LAYER_CONTEXT_MENUS, LAYER_CONTEXT_TARGETS, CANVAS_MENU_FOR_TOOL } from './contextMenus'
export type { LayerContextTarget } from './contextMenus'

export { useLayerContextMenu } from './LayerContextMenu'
export type { LayerContextMenuHandle } from './LayerContextMenu'
