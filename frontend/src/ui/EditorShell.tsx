// `EditorShell` a été généralisé et promu au core sous le nom `WorkspaceShell`,
// partagé par les apps avancées (Office + Paintsharp). Ré-exporté ici sous son nom
// historique pour que les éditeurs Paintsharp restent inchangés. Les props sont les
// mêmes ; `WorkspaceShell` ajoute juste `chromeless` (optionnel, désactivé par
// défaut) et un thème clair/sombre — Paintsharp continue de passer `theme={C}` (sombre).
export { WorkspaceShell as EditorShell } from '@kubuno/sdk'
