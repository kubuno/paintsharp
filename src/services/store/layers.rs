//! Layer document (Layer / raster editor) rows. Pool-only.

use kubuno_db::{new_id, params, DbPool};
use uuid::Uuid;

use crate::errors::{PaintsharpError, Result};
use crate::models::layer_doc::{LayerDocument, LayerDocumentSummary, UpdateLayerDocDto};

const SUMMARY_COLS: &str = "id, owner_id, title, width, height, color_mode, thumbnail_path, \
                            is_starred, layer_count, updated_at, created_at";

// The columns the `LayerDocument` model reads (the content columns were moved to
// the .kblay file, so `SELECT *` would over-read; the list is explicit).
const DOC_COLS: &str = "id, owner_id, title, width, height, color_mode, bit_depth, dpi, \
                        file_id, thumbnail_path, layer_count, is_starred, is_trashed, \
                        created_at, updated_at";

pub async fn list_docs(
    db: &DbPool,
    owner: Uuid,
    starred: bool,
    trashed: bool,
    limit: i64,
    offset: i64,
) -> Result<Vec<LayerDocumentSummary>> {
    let sql = if starred {
        format!(
            "SELECT {SUMMARY_COLS} FROM paintsharp.layer_documents
             WHERE owner_id = $1 AND is_starred = TRUE AND is_trashed = FALSE
             ORDER BY updated_at DESC LIMIT $2 OFFSET $3"
        )
    } else if trashed {
        format!(
            "SELECT {SUMMARY_COLS} FROM paintsharp.layer_documents
             WHERE owner_id = $1 AND is_trashed = TRUE
             ORDER BY trashed_at DESC LIMIT $2 OFFSET $3"
        )
    } else {
        format!(
            "SELECT {SUMMARY_COLS} FROM paintsharp.layer_documents
             WHERE owner_id = $1 AND is_trashed = FALSE
             ORDER BY updated_at DESC LIMIT $2 OFFSET $3"
        )
    };
    Ok(db.fetch_all_as::<LayerDocumentSummary>(&sql, params![owner, limit, offset]).await?)
}

#[allow(clippy::too_many_arguments)]
pub async fn create_doc(
    db: &DbPool,
    owner: Uuid,
    title: &str,
    width: i32,
    height: i32,
    color_mode: &str,
    bit_depth: i32,
    dpi: i32,
) -> Result<Uuid> {
    let id = new_id();
    db.execute(
        "INSERT INTO paintsharp.layer_documents
            (id, owner_id, title, width, height, color_mode, bit_depth, dpi)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        params![id, owner, title, width, height, color_mode, bit_depth, dpi],
    )
    .await?;
    Ok(id)
}

pub async fn set_file_id(db: &DbPool, id: Uuid, file_id: Uuid) -> Result<()> {
    db.execute(
        "UPDATE paintsharp.layer_documents SET file_id = $1 WHERE id = $2",
        params![file_id, id],
    )
    .await?;
    Ok(())
}

pub async fn get_doc(db: &DbPool, id: Uuid, owner: Uuid) -> Result<Option<LayerDocument>> {
    let sql = format!(
        "SELECT {DOC_COLS} FROM paintsharp.layer_documents WHERE id = $1 AND owner_id = $2"
    );
    Ok(db.fetch_optional_as::<LayerDocument>(&sql, params![id, owner]).await?)
}

pub async fn get_active_doc(db: &DbPool, id: Uuid, owner: Uuid) -> Result<Option<LayerDocument>> {
    let sql = format!(
        "SELECT {DOC_COLS} FROM paintsharp.layer_documents
         WHERE id = $1 AND owner_id = $2 AND is_trashed = FALSE"
    );
    Ok(db.fetch_optional_as::<LayerDocument>(&sql, params![id, owner]).await?)
}

pub async fn rename_doc(db: &DbPool, id: Uuid, title: &str) -> Result<()> {
    db.execute(
        "UPDATE paintsharp.layer_documents SET title = $1 WHERE id = $2",
        params![title, id],
    )
    .await?;
    Ok(())
}

pub async fn update_doc(
    db: &DbPool,
    id: Uuid,
    owner: Uuid,
    body: &UpdateLayerDocDto,
) -> Result<u64> {
    Ok(db
        .execute(
            "UPDATE paintsharp.layer_documents SET
                title            = COALESCE($1, title),
                thumbnail_path   = COALESCE($2, thumbnail_path),
                thumbnail_dirty  = COALESCE($3, thumbnail_dirty),
                is_starred       = COALESCE($4, is_starred),
                width            = COALESCE($5, width),
                height           = COALESCE($6, height),
                last_edited_by   = $7
             WHERE id = $8 AND owner_id = $9",
            params![
                body.title.as_deref(),
                body.thumbnail_path.as_deref(),
                body.thumbnail_dirty,
                body.is_starred,
                body.width,
                body.height,
                owner,
                id,
                owner
            ],
        )
        .await?)
}

/// Saves the layer count and marks the thumbnail dirty (structure save).
pub async fn save_structure(db: &DbPool, id: Uuid, owner: Uuid, layer_count: i32) -> Result<u64> {
    Ok(db
        .execute(
            "UPDATE paintsharp.layer_documents SET
                layer_count      = $1,
                thumbnail_dirty  = $2,
                last_edited_by   = $3
             WHERE id = $4 AND owner_id = $5",
            params![layer_count, true, owner, id, owner],
        )
        .await?)
}

pub async fn exists(db: &DbPool, id: Uuid, owner: Uuid) -> Result<bool> {
    Ok(db
        .fetch_optional_scalar::<Uuid>(
            "SELECT id FROM paintsharp.layer_documents WHERE id = $1 AND owner_id = $2 LIMIT 1",
            params![id, owner],
        )
        .await?
        .is_some())
}

pub async fn doc_file_id(db: &DbPool, id: Uuid, owner: Uuid) -> Result<Uuid> {
    let fid: Option<Uuid> = db
        .fetch_optional_scalar::<Uuid>(
            "SELECT file_id FROM paintsharp.layer_documents WHERE id = $1 AND owner_id = $2",
            params![id, owner],
        )
        .await?;
    if let Some(f) = fid {
        return Ok(f);
    }
    if exists(db, id, owner).await? {
        Err(PaintsharpError::Internal(anyhow::anyhow!("document sans fichier de contenu")))
    } else {
        Err(PaintsharpError::NotFound(id.to_string()))
    }
}

pub async fn trash_doc(db: &DbPool, id: Uuid, owner: Uuid) -> Result<u64> {
    Ok(db
        .execute(
            "UPDATE paintsharp.layer_documents SET is_trashed = TRUE, trashed_at = $1
             WHERE id = $2 AND owner_id = $3 AND is_trashed = FALSE",
            params![chrono::Utc::now(), id, owner],
        )
        .await?)
}

pub async fn restore_doc(db: &DbPool, id: Uuid, owner: Uuid) -> Result<()> {
    db.execute(
        "UPDATE paintsharp.layer_documents SET is_trashed = FALSE, trashed_at = NULL
         WHERE id = $1 AND owner_id = $2",
        params![id, owner],
    )
    .await?;
    Ok(())
}

pub async fn find_by_file(db: &DbPool, file_id: Uuid, owner: Uuid) -> Result<Option<Uuid>> {
    Ok(db
        .fetch_optional_scalar::<Uuid>(
            "SELECT id FROM paintsharp.layer_documents
             WHERE file_id = $1 AND owner_id = $2 AND is_trashed = FALSE",
            params![file_id, owner],
        )
        .await?)
}
