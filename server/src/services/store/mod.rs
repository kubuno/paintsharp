//! Pool-only database access for PaintSharp's entities.
//!
//! Every function here takes a [`kubuno_db::DbPool`] (or a [`kubuno_db::DbTx`])
//! and speaks only to the database: no HTTP extractors, no `AppState`, no
//! content-file (`services::content_files`) calls. Keeping the SQL isolated this
//! way is what lets `tests/db_portability.rs` exercise the real create / list /
//! update / delete paths against each engine from one binary.
//!
//! The SQL is written in PostgreSQL's `$n` style (the source dialect); kubuno-db
//! rewrites the placeholders and the dialect fragments per engine at run time.
//! Table names are always schema-qualified (`paintsharp.<table>`) because
//! kubuno-db sets no `search_path`.

pub mod animations;
pub mod assets;
pub mod fonts;
pub mod layers;
pub mod pdf;
pub mod scenes;
pub mod vectors;
pub mod video;

use kubuno_db::{params, DbPool};
use uuid::Uuid;

use crate::errors::Result;

/// Deletes a **trashed** row identified by `(id, owner_id)` and returns its
/// `file_id` (which is itself nullable).
///
/// * `Ok(Some(file_id))` — a trashed row was deleted; `file_id` is its content
///   file (or `None` when the row had none).
/// * `Ok(None)` — no trashed row matched, so nothing was deleted and the caller
///   should raise `NotFound`.
///
/// The guard (`is_trashed = TRUE`) is applied to the re-select as well as the
/// delete, so the MySQL path (which re-reads before deleting, having no
/// `RETURNING`) cannot report a live row as deleted. `table` is a `&'static str`
/// — an identifier, never user data.
pub async fn delete_trashed_returning_file_id(
    db: &DbPool,
    table: &'static str,
    id: Uuid,
    owner: Uuid,
) -> Result<Option<Option<Uuid>>> {
    let del = format!("DELETE FROM {table} WHERE id = $1 AND owner_id = $2 AND is_trashed = TRUE");
    let sel = format!("SELECT file_id FROM {table} WHERE id = $1 AND owner_id = $2 AND is_trashed = TRUE");

    let mut tx = db.begin().await?;
    let row = kubuno_db::returning::delete_returning_row(
        &mut tx,
        &del,
        params![id, owner],
        "file_id",
        &sel,
        params![id, owner],
    )
    .await?;
    let out = match row {
        Some(r) => Some(r.try_get::<Option<Uuid>>("file_id")?),
        None => None,
    };
    tx.commit().await?;
    Ok(out)
}
