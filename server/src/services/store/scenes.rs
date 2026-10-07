//! Scene (Vertex / 3D) rows. Pool-only.

use kubuno_db::{new_id, params, DbPool};
use uuid::Uuid;

use crate::errors::{PaintsharpError, Result};
use crate::models::scene::{Scene, SceneSummary, UpdateSceneDto};

const SUMMARY_COLS: &str = "id, owner_id, title, description, thumbnail_url, is_starred, \
                            vertex_count, face_count, updated_at, created_at";

/// The `starred` / `trashed` / default listing.
pub async fn list(
    db: &DbPool,
    owner: Uuid,
    starred: bool,
    trashed: bool,
    limit: i64,
    offset: i64,
) -> Result<Vec<SceneSummary>> {
    let sql = if starred {
        format!(
            "SELECT {SUMMARY_COLS} FROM paintsharp.scenes
             WHERE owner_id = $1 AND is_starred = TRUE AND is_trashed = FALSE
             ORDER BY updated_at DESC LIMIT $2 OFFSET $3"
        )
    } else if trashed {
        format!(
            "SELECT {SUMMARY_COLS} FROM paintsharp.scenes
             WHERE owner_id = $1 AND is_trashed = TRUE
             ORDER BY trashed_at DESC LIMIT $2 OFFSET $3"
        )
    } else {
        format!(
            "SELECT {SUMMARY_COLS} FROM paintsharp.scenes
             WHERE owner_id = $1 AND is_trashed = FALSE
             ORDER BY updated_at DESC LIMIT $2 OFFSET $3"
        )
    };
    Ok(db.fetch_all_as::<SceneSummary>(&sql, params![owner, limit, offset]).await?)
}

/// Inserts a scene and returns its (process-generated) id.
pub async fn create(db: &DbPool, owner: Uuid, title: &str, description: Option<&str>) -> Result<Uuid> {
    let id = new_id();
    db.execute(
        "INSERT INTO paintsharp.scenes (id, owner_id, title, description)
         VALUES ($1, $2, $3, $4)",
        params![id, owner, title, description],
    )
    .await?;
    Ok(id)
}

pub async fn set_file_id(db: &DbPool, id: Uuid, file_id: Uuid) -> Result<()> {
    db.execute(
        "UPDATE paintsharp.scenes SET file_id = $1 WHERE id = $2",
        params![file_id, id],
    )
    .await?;
    Ok(())
}

pub async fn get(db: &DbPool, id: Uuid, owner: Uuid) -> Result<Option<Scene>> {
    Ok(db
        .fetch_optional_as::<Scene>(
            "SELECT * FROM paintsharp.scenes WHERE id = $1 AND owner_id = $2",
            params![id, owner],
        )
        .await?)
}

/// Renames the row (title self-heal from the content file name).
pub async fn rename(db: &DbPool, id: Uuid, title: &str) -> Result<()> {
    db.execute(
        "UPDATE paintsharp.scenes SET title = $1 WHERE id = $2",
        params![title, id],
    )
    .await?;
    Ok(())
}

pub async fn exists(db: &DbPool, id: Uuid, owner: Uuid) -> Result<bool> {
    Ok(db
        .fetch_optional_scalar::<Uuid>(
            "SELECT id FROM paintsharp.scenes WHERE id = $1 AND owner_id = $2 LIMIT 1",
            params![id, owner],
        )
        .await?
        .is_some())
}

/// COALESCE update of the mutable metadata columns.
pub async fn update(db: &DbPool, id: Uuid, owner: Uuid, body: &UpdateSceneDto) -> Result<()> {
    db.execute(
        "UPDATE paintsharp.scenes SET
            title          = COALESCE($1, title),
            description    = COALESCE($2, description),
            thumbnail_url  = COALESCE($3, thumbnail_url),
            is_starred     = COALESCE($4, is_starred),
            vertex_count   = COALESCE($5, vertex_count),
            face_count     = COALESCE($6, face_count),
            last_editor_id = $7
         WHERE id = $8 AND owner_id = $9",
        params![
            body.title.as_deref(),
            body.description.as_deref(),
            body.thumbnail_url.as_deref(),
            body.is_starred,
            body.vertex_count,
            body.face_count,
            owner,
            id,
            owner
        ],
    )
    .await?;
    Ok(())
}

/// The content-file id of a scene: `NotFound` if the scene is missing, `Internal`
/// if the row carries no `file_id`.
pub async fn file_id(db: &DbPool, id: Uuid, owner: Uuid) -> Result<Uuid> {
    let fid: Option<Uuid> = db
        .fetch_optional_scalar::<Uuid>(
            "SELECT file_id FROM paintsharp.scenes WHERE id = $1 AND owner_id = $2",
            params![id, owner],
        )
        .await?;
    if let Some(f) = fid {
        return Ok(f);
    }
    // fetch_optional_scalar folds "no row" and "NULL value" together, so query the
    // existence separately to keep the two errors distinct.
    if exists(db, id, owner).await? {
        Err(PaintsharpError::Internal(anyhow::anyhow!("scène sans fichier de contenu")))
    } else {
        Err(PaintsharpError::NotFound(id.to_string()))
    }
}

pub async fn trash(db: &DbPool, id: Uuid, owner: Uuid) -> Result<u64> {
    Ok(db
        .execute(
            "UPDATE paintsharp.scenes SET is_trashed = TRUE, trashed_at = $1
             WHERE id = $2 AND owner_id = $3 AND is_trashed = FALSE",
            params![chrono::Utc::now(), id, owner],
        )
        .await?)
}

pub async fn restore(db: &DbPool, id: Uuid, owner: Uuid) -> Result<()> {
    db.execute(
        "UPDATE paintsharp.scenes SET is_trashed = FALSE, trashed_at = NULL
         WHERE id = $1 AND owner_id = $2",
        params![id, owner],
    )
    .await?;
    Ok(())
}

pub async fn find_by_file(db: &DbPool, file_id: Uuid, owner: Uuid) -> Result<Option<Uuid>> {
    Ok(db
        .fetch_optional_scalar::<Uuid>(
            "SELECT id FROM paintsharp.scenes
             WHERE file_id = $1 AND owner_id = $2 AND is_trashed = FALSE",
            params![file_id, owner],
        )
        .await?)
}
