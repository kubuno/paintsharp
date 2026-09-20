//! Video project (Motion) rows: projects, media, render jobs. Pool-only.

use kubuno_db::{new_id, params, DbPool};
use serde_json::Value;
use uuid::Uuid;

use crate::errors::{PaintsharpError, Result};
use crate::models::video::{
    RenderJob, UpdateVideoProjectDto, VideoMedia, VideoProject, VideoProjectSummary,
};

const SUMMARY_COLS: &str = "id, owner_id, title, composition, thumbnail_path, thumbnail_dirty, \
                            is_trashed, updated_at, created_at";

const PROJECT_COLS: &str = "id, owner_id, title, composition, render_settings, file_id, \
                            thumbnail_path, thumbnail_dirty, is_trashed, last_edited_by, \
                            updated_at, created_at";

const MEDIA_COLS: &str = "id, project_id, owner_id, storage_path, original_name, mime_type, \
                          size_bytes, probe_data, thumbnails_path, waveform_path, status, \
                          error_message, created_at";

const JOB_COLS: &str = "id, project_id, owner_id, render_options, output_path, output_url, \
                        status, progress, frame_current, frame_total, error_message, \
                        started_at, finished_at, created_at";

// ── Projects ──────────────────────────────────────────────────────────────────

pub async fn list_projects(
    db: &DbPool,
    owner: Uuid,
    trashed: bool,
    limit: i64,
    offset: i64,
) -> Result<Vec<VideoProjectSummary>> {
    let sql = format!(
        "SELECT {SUMMARY_COLS} FROM paintsharp.video_projects
         WHERE owner_id = $1 AND is_trashed = $2
         ORDER BY updated_at DESC LIMIT $3 OFFSET $4"
    );
    Ok(db.fetch_all_as::<VideoProjectSummary>(&sql, params![owner, trashed, limit, offset]).await?)
}

pub async fn create_project(db: &DbPool, owner: Uuid, title: &str, composition: &Value) -> Result<Uuid> {
    let id = new_id();
    db.execute(
        "INSERT INTO paintsharp.video_projects (id, owner_id, title, composition)
         VALUES ($1, $2, $3, $4)",
        params![id, owner, title, composition.clone()],
    )
    .await?;
    Ok(id)
}

/// Insert used by duplicate: carries over composition and render settings.
pub async fn create_project_full(
    db: &DbPool,
    owner: Uuid,
    title: &str,
    composition: &Value,
    render_settings: &Value,
) -> Result<Uuid> {
    let id = new_id();
    db.execute(
        "INSERT INTO paintsharp.video_projects (id, owner_id, title, composition, render_settings)
         VALUES ($1, $2, $3, $4, $5)",
        params![id, owner, title, composition.clone(), render_settings.clone()],
    )
    .await?;
    Ok(id)
}

pub async fn set_file_id(db: &DbPool, id: Uuid, file_id: Uuid) -> Result<()> {
    db.execute(
        "UPDATE paintsharp.video_projects SET file_id = $1 WHERE id = $2",
        params![file_id, id],
    )
    .await?;
    Ok(())
}

pub async fn get_project(db: &DbPool, id: Uuid, owner: Uuid) -> Result<Option<VideoProject>> {
    let sql = format!(
        "SELECT {PROJECT_COLS} FROM paintsharp.video_projects WHERE id = $1 AND owner_id = $2"
    );
    Ok(db.fetch_optional_as::<VideoProject>(&sql, params![id, owner]).await?)
}

pub async fn get_active_project(db: &DbPool, id: Uuid, owner: Uuid) -> Result<Option<VideoProject>> {
    let sql = format!(
        "SELECT {PROJECT_COLS} FROM paintsharp.video_projects
         WHERE id = $1 AND owner_id = $2 AND is_trashed = FALSE"
    );
    Ok(db.fetch_optional_as::<VideoProject>(&sql, params![id, owner]).await?)
}

pub async fn exists(db: &DbPool, id: Uuid, owner: Uuid) -> Result<bool> {
    Ok(db
        .fetch_optional_scalar::<Uuid>(
            "SELECT id FROM paintsharp.video_projects WHERE id = $1 AND owner_id = $2 LIMIT 1",
            params![id, owner],
        )
        .await?
        .is_some())
}

pub async fn rename_project(db: &DbPool, id: Uuid, title: &str) -> Result<()> {
    db.execute(
        "UPDATE paintsharp.video_projects SET title = $1 WHERE id = $2",
        params![title, id],
    )
    .await?;
    Ok(())
}

pub async fn update_project(
    db: &DbPool,
    id: Uuid,
    owner: Uuid,
    dto: &UpdateVideoProjectDto,
) -> Result<()> {
    db.execute(
        "UPDATE paintsharp.video_projects SET
            title           = COALESCE($1, title),
            composition     = COALESCE($2, composition),
            render_settings = COALESCE($3, render_settings),
            thumbnail_path  = COALESCE($4, thumbnail_path),
            thumbnail_dirty = COALESCE($5, thumbnail_dirty)
         WHERE id = $6 AND owner_id = $7",
        params![
            dto.title.as_deref(),
            dto.composition.clone(),
            dto.render_settings.clone(),
            dto.thumbnail_path.as_deref(),
            dto.thumbnail_dirty,
            id,
            owner
        ],
    )
    .await?;
    Ok(())
}

/// Marks the project edited (bumps last_edited_by, dirties the thumbnail).
pub async fn mark_edited(db: &DbPool, id: Uuid, owner: Uuid) -> Result<u64> {
    Ok(db
        .execute(
            "UPDATE paintsharp.video_projects
             SET last_edited_by = $1, thumbnail_dirty = $2
             WHERE id = $3 AND owner_id = $4",
            params![owner, true, id, owner],
        )
        .await?)
}

pub async fn video_file_id(db: &DbPool, id: Uuid, owner: Uuid) -> Result<Uuid> {
    let fid: Option<Uuid> = db
        .fetch_optional_scalar::<Uuid>(
            "SELECT file_id FROM paintsharp.video_projects WHERE id = $1 AND owner_id = $2",
            params![id, owner],
        )
        .await?;
    if let Some(f) = fid {
        return Ok(f);
    }
    if exists(db, id, owner).await? {
        Err(PaintsharpError::Internal(anyhow::anyhow!("projet vidéo sans fichier de contenu")))
    } else {
        Err(PaintsharpError::NotFound(id.to_string()))
    }
}

pub async fn trash_project(db: &DbPool, id: Uuid, owner: Uuid) -> Result<()> {
    db.execute(
        "UPDATE paintsharp.video_projects SET is_trashed = TRUE, trashed_at = $1
         WHERE id = $2 AND owner_id = $3",
        params![chrono::Utc::now(), id, owner],
    )
    .await?;
    Ok(())
}

pub async fn restore_project(db: &DbPool, id: Uuid, owner: Uuid) -> Result<()> {
    db.execute(
        "UPDATE paintsharp.video_projects SET is_trashed = FALSE, trashed_at = NULL
         WHERE id = $1 AND owner_id = $2",
        params![id, owner],
    )
    .await?;
    Ok(())
}

pub async fn find_by_file(db: &DbPool, file_id: Uuid, owner: Uuid) -> Result<Option<Uuid>> {
    Ok(db
        .fetch_optional_scalar::<Uuid>(
            "SELECT id FROM paintsharp.video_projects
             WHERE file_id = $1 AND owner_id = $2 AND is_trashed = FALSE",
            params![file_id, owner],
        )
        .await?)
}

/// `composition.duration_frames`, read out of the JSON blob in Rust (the JSON
/// path extraction and `::int` cast are not portable across the three engines).
pub async fn project_frame_total(db: &DbPool, project_id: Uuid) -> Result<i32> {
    let composition: Option<Value> = db
        .fetch_optional_scalar::<Value>(
            "SELECT composition FROM paintsharp.video_projects WHERE id = $1",
            params![project_id],
        )
        .await?;
    Ok(composition
        .as_ref()
        .and_then(|c| c.get("duration_frames"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0) as i32)
}

// ── Media ─────────────────────────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
pub async fn insert_media(
    db: &DbPool,
    media_id: Uuid,
    project_id: Uuid,
    owner: Uuid,
    storage_path: &str,
    original_name: &str,
    mime_type: &str,
    size_bytes: i64,
) -> Result<()> {
    db.execute(
        "INSERT INTO paintsharp.video_media
            (id, project_id, owner_id, storage_path, original_name, mime_type, size_bytes, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'ready')",
        params![media_id, project_id, owner, storage_path, original_name, mime_type, size_bytes],
    )
    .await?;
    Ok(())
}

pub async fn list_media(db: &DbPool, project_id: Uuid, owner: Uuid) -> Result<Vec<VideoMedia>> {
    let sql = format!(
        "SELECT {MEDIA_COLS} FROM paintsharp.video_media
         WHERE project_id = $1 AND owner_id = $2 ORDER BY created_at ASC"
    );
    Ok(db.fetch_all_as::<VideoMedia>(&sql, params![project_id, owner]).await?)
}

/// `(storage_path, mime_type)` for streaming a media file.
pub async fn media_location(
    db: &DbPool,
    media_id: Uuid,
    project_id: Uuid,
    owner: Uuid,
) -> Result<Option<(String, String)>> {
    let row = db
        .fetch_optional_row(
            "SELECT storage_path, mime_type FROM paintsharp.video_media
             WHERE id = $1 AND project_id = $2 AND owner_id = $3",
            params![media_id, project_id, owner],
        )
        .await?;
    match row {
        Some(r) => Ok(Some((r.try_get::<String>("storage_path")?, r.try_get::<String>("mime_type")?))),
        None => Ok(None),
    }
}

// ── Render jobs ───────────────────────────────────────────────────────────────

pub async fn create_render_job(
    db: &DbPool,
    project_id: Uuid,
    owner: Uuid,
    render_options: &Value,
    frame_total: i32,
) -> Result<Uuid> {
    let id = new_id();
    db.execute(
        "INSERT INTO paintsharp.render_jobs (id, project_id, owner_id, render_options, frame_total)
         VALUES ($1, $2, $3, $4, $5)",
        params![id, project_id, owner, render_options.clone(), frame_total],
    )
    .await?;
    Ok(id)
}

pub async fn get_render_job(
    db: &DbPool,
    job_id: Uuid,
    project_id: Uuid,
    owner: Uuid,
) -> Result<Option<RenderJob>> {
    let sql = format!(
        "SELECT {JOB_COLS} FROM paintsharp.render_jobs
         WHERE id = $1 AND project_id = $2 AND owner_id = $3"
    );
    Ok(db.fetch_optional_as::<RenderJob>(&sql, params![job_id, project_id, owner]).await?)
}

pub async fn list_render_jobs(db: &DbPool, project_id: Uuid, owner: Uuid) -> Result<Vec<RenderJob>> {
    let sql = format!(
        "SELECT {JOB_COLS} FROM paintsharp.render_jobs
         WHERE project_id = $1 AND owner_id = $2
         ORDER BY created_at DESC LIMIT 20"
    );
    Ok(db.fetch_all_as::<RenderJob>(&sql, params![project_id, owner]).await?)
}
