/// The database namespace this module owns: a PostgreSQL schema, a MySQL
/// database, or the SQLite file ATTACHed under that name. Never write outside
/// it.
pub const SCHEMA: &str = "paintsharp";

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
