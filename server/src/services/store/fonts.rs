//! Font project (FontEditor) rows. Pool-only.

use kubuno_db::{new_id, params, DbPool};
use uuid::Uuid;

use crate::errors::{PaintsharpError, Result};
use crate::models::font::{FontProject, FontProjectSummary, UpdateFontProjectDto};

const SUMMARY_COLS: &str =
    "id, owner_id, title, thumbnail_path, glyph_count, is_starred, updated_at, created_at";

pub async fn list_projects(
    db: &DbPool,
    owner: Uuid,
    starred: bool,
    trashed: bool,
    limit: i64,
    offset: i64,
) -> Result<Vec<FontProjectSummary>> {
    let sql = if starred {
        format!(
            "SELECT {SUMMARY_COLS} FROM paintsharp.font_projects
             WHERE owner_id = $1 AND is_starred = TRUE AND is_trashed = FALSE
             ORDER BY updated_at DESC LIMIT $2 OFFSET $3"
        )
    } else if trashed {
        format!(
            "SELECT {SUMMARY_COLS} FROM paintsharp.font_projects
             WHERE owner_id = $1 AND is_trashed = TRUE
             ORDER BY trashed_at DESC LIMIT $2 OFFSET $3"
        )
    } else {
        format!(
            "SELECT {SUMMARY_COLS} FROM paintsharp.font_projects
             WHERE owner_id = $1 AND is_trashed = FALSE
             ORDER BY updated_at DESC LIMIT $2 OFFSET $3"
        )
    };
    Ok(db.fetch_all_as::<FontProjectSummary>(&sql, params![owner, limit, offset]).await?)
}

pub async fn create_project(db: &DbPool, owner: Uuid, title: &str) -> Result<Uuid> {
    let id = new_id();
    db.execute(
        "INSERT INTO paintsharp.font_projects (id, owner_id, title) VALUES ($1, $2, $3)",
        params![id, owner, title],
    )
    .await?;
    Ok(id)
}

/// Insert used by duplicate: carries over glyph count and thumbnail.
pub async fn create_project_full(
    db: &DbPool,
    owner: Uuid,
    title: &str,
    glyph_count: i32,
    thumbnail_path: Option<&str>,
) -> Result<Uuid> {
    let id = new_id();
    db.execute(
        "INSERT INTO paintsharp.font_projects (id, owner_id, title, glyph_count, thumbnail_path)
         VALUES ($1, $2, $3, $4, $5)",
        params![id, owner, title, glyph_count, thumbnail_path],
    )
    .await?;
    Ok(id)
}

pub async fn set_file_id(db: &DbPool, id: Uuid, file_id: Uuid) -> Result<()> {
    db.execute(
        "UPDATE paintsharp.font_projects SET file_id = $1 WHERE id = $2",
        params![file_id, id],
    )
    .await?;
    Ok(())
}

pub async fn get_project(db: &DbPool, id: Uuid, owner: Uuid) -> Result<Option<FontProject>> {
    Ok(db
        .fetch_optional_as::<FontProject>(
            "SELECT * FROM paintsharp.font_projects WHERE id = $1 AND owner_id = $2",
            params![id, owner],
        )
        .await?)
}

pub async fn get_active_project(db: &DbPool, id: Uuid, owner: Uuid) -> Result<Option<FontProject>> {
    Ok(db
        .fetch_optional_as::<FontProject>(
            "SELECT * FROM paintsharp.font_projects
             WHERE id = $1 AND owner_id = $2 AND is_trashed = FALSE",
            params![id, owner],
        )
        .await?)
}

pub async fn rename_project(db: &DbPool, id: Uuid, title: &str) -> Result<()> {
    db.execute(
        "UPDATE paintsharp.font_projects SET title = $1 WHERE id = $2",
        params![title, id],
    )
    .await?;
    Ok(())
}

pub async fn update_project(
    db: &DbPool,
    id: Uuid,
    owner: Uuid,
    body: &UpdateFontProjectDto,
) -> Result<u64> {
    Ok(db
        .execute(
            "UPDATE paintsharp.font_projects SET
                title          = COALESCE($1, title),
                thumbnail_path = COALESCE($2, thumbnail_path),
                is_starred     = COALESCE($3, is_starred),
                last_edited_by = $4
             WHERE id = $5 AND owner_id = $6",
            params![
                body.title.as_deref(),
                body.thumbnail_path.as_deref(),
                body.is_starred,
                owner,
                id,
                owner
            ],
        )
        .await?)
}

/// Save the glyph count after a content save.
pub async fn save_glyphs(db: &DbPool, id: Uuid, owner: Uuid, glyph_count: Option<i32>) -> Result<()> {
    db.execute(
        "UPDATE paintsharp.font_projects
         SET glyph_count = COALESCE($1, glyph_count), last_edited_by = $2
         WHERE id = $3 AND owner_id = $4",
        params![glyph_count, owner, id, owner],
    )
    .await?;
    Ok(())
}

pub async fn exists_active(db: &DbPool, id: Uuid, owner: Uuid) -> Result<bool> {
    Ok(db
        .fetch_optional_scalar::<Uuid>(
            "SELECT id FROM paintsharp.font_projects
             WHERE id = $1 AND owner_id = $2 AND is_trashed = FALSE LIMIT 1",
            params![id, owner],
        )
        .await?
        .is_some())
}

pub async fn project_file_id(db: &DbPool, id: Uuid, owner: Uuid) -> Result<Uuid> {
    let fid: Option<Uuid> = db
        .fetch_optional_scalar::<Uuid>(
            "SELECT file_id FROM paintsharp.font_projects
             WHERE id = $1 AND owner_id = $2 AND is_trashed = FALSE",
            params![id, owner],
        )
        .await?;
    if let Some(f) = fid {
        return Ok(f);
    }
    if exists_active(db, id, owner).await? {
        Err(PaintsharpError::Internal(anyhow::anyhow!("projet sans fichier de contenu")))
    } else {
        Err(PaintsharpError::NotFound(id.to_string()))
    }
}

pub async fn trash_project(db: &DbPool, id: Uuid, owner: Uuid) -> Result<u64> {
    Ok(db
        .execute(
            "UPDATE paintsharp.font_projects SET is_trashed = TRUE, trashed_at = $1
             WHERE id = $2 AND owner_id = $3 AND is_trashed = FALSE",
            params![chrono::Utc::now(), id, owner],
        )
        .await?)
}

pub async fn restore_project(db: &DbPool, id: Uuid, owner: Uuid) -> Result<()> {
    db.execute(
        "UPDATE paintsharp.font_projects SET is_trashed = FALSE, trashed_at = NULL
         WHERE id = $1 AND owner_id = $2",
        params![id, owner],
    )
    .await?;
    Ok(())
}

pub async fn find_by_file(db: &DbPool, file_id: Uuid, owner: Uuid) -> Result<Option<Uuid>> {
    Ok(db
        .fetch_optional_scalar::<Uuid>(
            "SELECT id FROM paintsharp.font_projects
             WHERE file_id = $1 AND owner_id = $2 AND is_trashed = FALSE",
            params![file_id, owner],
        )
        .await?)
}
