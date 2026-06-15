pub mod config;
pub mod errors;
/// FilesClient + noms centralisés : face CLIENT du module `files` (stockage délégué).
/// Alias conservé pour compat.
pub use kubuno_drive::client as files_client;
pub mod handlers;
pub mod middleware;
pub mod models;
pub mod router;
pub mod services;
pub mod state;
