// `MenuBar` a été promu au core (avec le WorkspaceShell), partagé par Office et
// Paintsharp. Ré-exporté ici sous son nom historique pour compat. Le type est
// exposé par le SDK sous `WorkspaceMenuItem` (le nom `MenuItem` est déjà pris par
// `@ui` dans le chunk partagé) ; on lui redonne son nom local ici.
export { MenuBar } from '@kubuno/sdk'
export type { WorkspaceMenuItem as MenuItem } from '@kubuno/sdk'
