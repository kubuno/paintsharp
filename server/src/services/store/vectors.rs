//! Vector project (Apex) rows: projects and their pages. Pool-only.

use kubuno_db::{new_id, params, DbPool};
use uuid::Uuid;

use crate::errors::{PaintsharpError, Result};
use crate::models::vector::{
    UpdateVectorProjectDto, VectorPage, VectorPageSummary, VectorProject, VectorProjectSummary,
};

const SUMMARY_COLS: &str =
    "id, owner_id, title, thumbnail_path, is_starred, updated_at, created_at";

// ── Projects ──────────────────────────────────────────────────────────────────

pub async fn list_projects(
    db: &DbPool,
    owner: Uuid,
    starred: bool,
    trashed: bool,
    limit: i64,
    offset: i64,
) -> Result<Vec<VectorProjectSummary>> {
    let sql = if starred {
        format!(
            "SELECT {SUMMARY_COLS} FROM paintsharp.vector_projects
             WHERE owner_id = $1 AND is_starred = TRUE AND is_trashed = FALSE
             ORDER BY updated_at DESC LIMIT $2 OFFSET $3"
        )
    } else if trashed {
        format!(
            "SELECT {SUMMARY_COLS} FROM paintsharp.vector_projects
             WHERE owner_id = $1 AND is_trashed = TRUE
             ORDER BY trashed_at DESC LIMIT $2 OFFSET $3"
        )
    } else {
        format!(
            "SELECT {SUMMARY_COLS} FROM paintsharp.vector_projects
             WHERE owner_id = $1 AND is_trashed = FALSE
             ORDER BY updated_at DESC LIMIT $2 OFFSET $3"
        )
    };
    Ok(db.fetch_all_as::<VectorProjectSummary>(&sql, params![owner, limit, offset]).await?)
}

/// Inserts a project plus its first page atomically; returns `(project_id, page_id)`.
pub async fn create_project(db: &DbPool, owner: Uuid, title: &str) -> Result<(Uuid, Uuid)> {
    let project_id = new_id();
    let page_id = new_id();
    let mut tx = db.begin().await?;
    tx.execute(
        "INSERT INTO paintsharp.vector_projects (id, owner_id, title) VALUES ($1, $2, $3)",
        params![project_id, owner, title],
    )
    .await?;
    tx.execute(
        "INSERT INTO paintsharp.vector_pages (id, project_id, name, position)
         VALUES ($1, $2, 'Plan de travail 1', 0)",
        params![page_id, project_id],
    )
    .await?;
    tx.commit().await?;
    Ok((project_id, page_id))
}

/// Inserts a project with an explicit settings blob (used by duplicate).
pub async fn create_project_with_settings(
    db: &DbPool,
    owner: Uuid,
    title: &str,
    settings: &serde_json::Value,
) -> Result<Uuid> {
    let id = new_id();
    db.execute(
        "INSERT INTO paintsharp.vector_projects (id, owner_id, title, settings)
         VALUES ($1, $2, $3, $4)",
        params![id, owner, title, settings.clone()],
    )
    .await?;
    Ok(id)
}

pub async fn set_file_id(db: &DbPool, id: Uuid, file_id: Uuid) -> Result<()> {
    db.execute(
        "UPDATE paintsharp.vector_projects SET file_id = $1 WHERE id = $2",
        params![file_id, id],
    )
    .await?;
    Ok(())
}

pub async fn get_project(db: &DbPool, id: Uuid, owner: Uuid) -> Result<Option<VectorProject>> {
    Ok(db
        .fetch_optional_as::<VectorProject>(
            "SELECT * FROM paintsharp.vector_projects WHERE id = $1 AND owner_id = $2",
            params![id, owner],
        )
        .await?)
}

pub async fn get_active_project(db: &DbPool, id: Uuid, owner: Uuid) -> Result<Option<VectorProject>> {
    Ok(db
        .fetch_optional_as::<VectorProject>(
            "SELECT * FROM paintsharp.vector_projects
             WHERE id = $1 AND owner_id = $2 AND is_trashed = FALSE",
            params![id, owner],
        )
        .await?)
}

pub async fn rename_project(db: &DbPool, id: Uuid, title: &str) -> Result<()> {
    db.execute(
        "UPDATE paintsharp.vector_projects SET title = $1 WHERE id = $2",
        params![title, id],
    )
    .await?;
    Ok(())
}

pub async fn update_project(
    db: &DbPool,
    id: Uuid,
    owner: Uuid,
    body: &UpdateVectorProjectDto,
) -> Result<u64> {
    Ok(db
        .execute(
            "UPDATE paintsharp.vector_projects SET
                title          = COALESCE($1, title),
                settings       = COALESCE($2, settings),
                thumbnail_path = COALESCE($3, thumbnail_path),
                is_starred     = COALESCE($4, is_starred),
                last_edited_by = $5
             WHERE id = $6 AND owner_id = $7",
            params![
                body.title.as_deref(),
                body.settings.clone(),
                body.thumbnail_path.as_deref(),
                body.is_starred,
                owner,
                id,
                owner
            ],
        )
        .await?)
}

/// The content-file id of a project (must be a live, owned project).
pub async fn project_file_id(db: &DbPool, id: Uuid, owner: Uuid) -> Result<Uuid> {
    let fid: Option<Uuid> = db
        .fetch_optional_scalar::<Uuid>(
            "SELECT file_id FROM paintsharp.vector_projects
             WHERE id = $1 AND owner_id = $2 AND is_trashed = FALSE",
            params![id, owner],
        )
        .await?;
    if let Some(f) = fid {
        return Ok(f);
    }
    if check_project_owner(db, id, owner).await? {
        Err(PaintsharpError::Internal(anyhow::anyhow!("projet sans fichier de contenu")))
    } else {
        Err(PaintsharpError::NotFound(id.to_string()))
    }
}

pub async fn trash_project(db: &DbPool, id: Uuid, owner: Uuid) -> Result<u64> {
    Ok(db
        .execute(
            "UPDATE paintsharp.vector_projects SET is_trashed = TRUE, trashed_at = $1
             WHERE id = $2 AND owner_id = $3 AND is_trashed = FALSE",
            params![chrono::Utc::now(), id, owner],
        )
        .await?)
}

pub async fn restore_project(db: &DbPool, id: Uuid, owner: Uuid) -> Result<()> {
    db.execute(
        "UPDATE paintsharp.vector_projects SET is_trashed = FALSE, trashed_at = NULL
         WHERE id = $1 AND owner_id = $2",
        params![id, owner],
    )
    .await?;
    Ok(())
}

pub async fn find_by_file(db: &DbPool, file_id: Uuid, owner: Uuid) -> Result<Option<Uuid>> {
    Ok(db
        .fetch_optional_scalar::<Uuid>(
            "SELECT id FROM paintsharp.vector_projects
             WHERE file_id = $1 AND owner_id = $2 AND is_trashed = FALSE",
            params![file_id, owner],
        )
        .await?)
}

// ── Pages ─────────────────────────────────────────────────────────────────────

pub async fn check_project_owner(db: &DbPool, project_id: Uuid, owner: Uuid) -> Result<bool> {
    Ok(db
        .fetch_optional_scalar::<Uuid>(
            "SELECT id FROM paintsharp.vector_projects
             WHERE id = $1 AND owner_id = $2 AND is_trashed = FALSE LIMIT 1",
            params![project_id, owner],
        )
        .await?
        .is_some())
}

pub async fn list_page_summaries(db: &DbPool, project_id: Uuid) -> Result<Vec<VectorPageSummary>> {
    Ok(db
        .fetch_all_as::<VectorPageSummary>(
            "SELECT id, name, position FROM paintsharp.vector_pages
             WHERE project_id = $1 ORDER BY position",
            params![project_id],
        )
        .await?)
}

pub async fn list_pages(db: &DbPool, project_id: Uuid) -> Result<Vec<VectorPage>> {
    Ok(db
        .fetch_all_as::<VectorPage>(
            "SELECT * FROM paintsharp.vector_pages WHERE project_id = $1 ORDER BY position",
            params![project_id],
        )
        .await?)
}

pub async fn get_page(db: &DbPool, page_id: Uuid, project_id: Uuid) -> Result<Option<VectorPage>> {
    Ok(db
        .fetch_optional_as::<VectorPage>(
            "SELECT * FROM paintsharp.vector_pages WHERE id = $1 AND project_id = $2",
            params![page_id, project_id],
        )
        .await?)
}

/// `MAX(position) + 1` for the next page. The aggregate expression is cast to
/// bigint so it decodes as `i64` uniformly (the three engines disagree on the
/// width of a bare `MAX(int) + 1`), then narrowed in Rust.
pub async fn next_page_position(db: &DbPool, project_id: Uuid) -> Result<i32> {
    use kubuno_db::dialect::SqlType;
    let expr = db.backend().cast("COALESCE(MAX(position), -1) + 1", SqlType::BigInt);
    let sql = format!("SELECT {expr} FROM paintsharp.vector_pages WHERE project_id = $1");
    let next: i64 = db.fetch_scalar::<i64>(&sql, params![project_id]).await?;
    Ok(next as i32)
}

pub async fn create_page(db: &DbPool, project_id: Uuid, name: &str, position: i32) -> Result<Uuid> {
    let id = new_id();
    db.execute(
        "INSERT INTO paintsharp.vector_pages (id, project_id, name, position)
         VALUES ($1, $2, $3, $4)",
        params![id, project_id, name, position],
    )
    .await?;
    Ok(id)
}

/// Marks the project as edited (bumps `last_edited_by`).
pub async fn touch_project(db: &DbPool, project_id: Uuid, editor: Uuid) -> Result<()> {
    db.execute(
        "UPDATE paintsharp.vector_projects SET last_edited_by = $1 WHERE id = $2",
        params![editor, project_id],
    )
    .await?;
    Ok(())
}

pub async fn rename_page(db: &DbPool, page_id: Uuid, project_id: Uuid, name: &str) -> Result<()> {
    db.execute(
        "UPDATE paintsharp.vector_pages SET name = $1 WHERE id = $2 AND project_id = $3",
        params![name, page_id, project_id],
    )
    .await?;
    Ok(())
}

pub async fn page_count(db: &DbPool, project_id: Uuid) -> Result<i64> {
    let backend = db.backend();
    let sql = format!(
        "SELECT {} FROM paintsharp.vector_pages WHERE project_id = $1",
        backend.count_bigint("*")
    );
    Ok(db.fetch_scalar::<i64>(&sql, params![project_id]).await?)
}

pub async fn delete_page(db: &DbPool, page_id: Uuid, project_id: Uuid) -> Result<()> {
    db.execute(
        "DELETE FROM paintsharp.vector_pages WHERE id = $1 AND project_id = $2",
        params![page_id, project_id],
    )
    .await?;
    Ok(())
}
