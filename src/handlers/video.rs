use anyhow::anyhow;
use axum::{
    body::Body,
    extract::{Multipart, Path, Query, State},
    response::Response,
    Extension, Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;
use std::path::PathBuf;
use tokio_util::io::ReaderStream;
use uuid::Uuid;

use crate::{
    errors::{PaintsharpError, Result},
    middleware::PaintsharpUser,
    models::video::{
        CreateRenderJobDto, CreateVideoProjectDto, RenderJob, UpdateVideoProjectDto,
        VideoMedia, VideoProject, VideoProjectSummary,
    },
    services::content_files as cf,
    state::AppState,
};

async fn video_file_id(state: &AppState, id: Uuid, user_id: Uuid) -> Result<Uuid> {
    let fid: Option<Uuid> = sqlx::query_scalar(
        "SELECT file_id FROM paintsharp.video_projects WHERE id = $1 AND owner_id = $2",
    )
    .bind(id).bind(user_id)
    .fetch_optional(&state.db).await?
    .ok_or_else(|| PaintsharpError::NotFound(id.to_string()))?;
    fid.ok_or_else(|| PaintsharpError::Internal(anyhow!("projet vidéo sans fichier de contenu")))
}

#[derive(Debug, Deserialize)]
pub struct ListQuery {
    pub trashed: Option<bool>,
    pub limit:   Option<i64>,
    pub offset:  Option<i64>,
}

// ── List projects ─────────────────────────────────────────────────────────────

pub async fn list_video_projects(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Query(q): Query<ListQuery>,
) -> Result<Json<Value>> {
    let limit   = q.limit.unwrap_or(50).min(200);
    let offset  = q.offset.unwrap_or(0);
    let trashed = q.trashed.unwrap_or(false);

    let projects = sqlx::query_as::<_, VideoProjectSummary>(
        "SELECT id, owner_id, title, composition, thumbnail_path, thumbnail_dirty,
                is_trashed, updated_at, created_at
         FROM paintsharp.video_projects
         WHERE owner_id = $1 AND is_trashed = $2
         ORDER BY updated_at DESC LIMIT $3 OFFSET $4",
    )
    .bind(user.id)
    .bind(trashed)
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(json!({ "projects": projects })))
}

// ── Create project ────────────────────────────────────────────────────────────

pub async fn create_video_project(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Json(dto): Json<CreateVideoProjectDto>,
) -> Result<Json<Value>> {
    let title       = dto.title.unwrap_or_else(|| "Projet vidéo sans titre".to_string());
    let composition = dto.composition.unwrap_or(json!({
        "width": 1920, "height": 1080, "fps": 25,
        "duration_frames": 750, "sample_rate": 48000, "channels": 2,
        "color_space": "rec709"
    }));
    let row = sqlx::query(
        "INSERT INTO paintsharp.video_projects (owner_id, title, composition)
         VALUES ($1, $2, $3)
         RETURNING id, title",
    )
    .bind(user.id)
    .bind(&title)
    .bind(&composition)
    .fetch_one(&state.db)
    .await?;

    let id:    Uuid   = row.get("id");
    let title: String = row.get("title");

    // Timeline (contenu) → fichier .kbmot.
    let content = cf::motion_content_from(cf::empty_timeline());
    let file_id = cf::create_motion_file(&state, user.id, &title, &content).await?;
    sqlx::query("UPDATE paintsharp.video_projects SET file_id = $1 WHERE id = $2")
        .bind(file_id).bind(id).execute(&state.db).await?;

    Ok(Json(json!({ "id": id, "title": title })))
}

// ── Get project ───────────────────────────────────────────────────────────────

pub async fn get_video_project(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let project = sqlx::query_as::<_, VideoProject>(
        "SELECT id, owner_id, title, composition, render_settings, file_id,
                thumbnail_path, thumbnail_dirty, is_trashed, last_edited_by, updated_at, created_at
         FROM paintsharp.video_projects
         WHERE id = $1 AND owner_id = $2",
    )
    .bind(id)
    .bind(user.id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| PaintsharpError::NotFound("Projet vidéo introuvable".into()))?;

    // timeline_data lu depuis le fichier .kbmot.
    let mut val = serde_json::to_value(&project).unwrap_or_default();
    val["timeline_data"] = match project.file_id {
        Some(fid) => cf::read_content(&state, user.id, fid).await.ok()
            .and_then(|c| c.get("timeline_data").cloned()).unwrap_or_else(cf::empty_timeline),
        None => cf::empty_timeline(),
    };
    if let Some(fid) = project.file_id {
        if let Some(fname) = cf::file_name(&state, user.id, fid).await {
            let stem = cf::strip_ext(&fname);
            if !stem.is_empty() && stem != project.title {
                sqlx::query("UPDATE paintsharp.video_projects SET title = $2 WHERE id = $1")
                    .bind(id).bind(&stem).execute(&state.db).await?;
                val["title"] = Value::String(stem);
            }
        }
    }
    Ok(Json(val))
}

// ── Update project metadata ───────────────────────────────────────────────────

pub async fn update_video_project(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
    Json(dto): Json<UpdateVideoProjectDto>,
) -> Result<Json<Value>> {
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM paintsharp.video_projects WHERE id = $1 AND owner_id = $2",
    )
    .bind(id)
    .bind(user.id)
    .fetch_one(&state.db)
    .await?;

    if count == 0 {
        return Err(PaintsharpError::NotFound("Projet vidéo introuvable".into()));
    }

    if let Some(title) = &dto.title {
        sqlx::query("UPDATE paintsharp.video_projects SET title = $1 WHERE id = $2")
            .bind(title).bind(id)
            .execute(&state.db).await?;
    }
    if let Some(composition) = &dto.composition {
        sqlx::query("UPDATE paintsharp.video_projects SET composition = $1 WHERE id = $2")
            .bind(composition).bind(id)
            .execute(&state.db).await?;
    }
    if let Some(render_settings) = &dto.render_settings {
        sqlx::query("UPDATE paintsharp.video_projects SET render_settings = $1 WHERE id = $2")
            .bind(render_settings).bind(id)
            .execute(&state.db).await?;
    }
    if let Some(thumbnail_path) = &dto.thumbnail_path {
        sqlx::query("UPDATE paintsharp.video_projects SET thumbnail_path = $1 WHERE id = $2")
            .bind(thumbnail_path).bind(id)
            .execute(&state.db).await?;
    }
    if let Some(dirty) = dto.thumbnail_dirty {
        sqlx::query("UPDATE paintsharp.video_projects SET thumbnail_dirty = $1 WHERE id = $2")
            .bind(dirty).bind(id)
            .execute(&state.db).await?;
    }

    // Titre modifié → renommer le fichier .kbmot (titre = nom). Best-effort.
    if let Some(t) = dto.title.as_ref() {
        if !t.trim().is_empty() {
            if let Ok(fid) = video_file_id(&state, id, user.id).await {
                cf::rename_content_file(&state, user.id, fid, t, "kbmot").await;
            }
        }
    }

    Ok(Json(json!({ "ok": true })))
}

// ── Save timeline data (full PUT) ─────────────────────────────────────────────

pub async fn save_timeline_data(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
    Json(body): Json<Value>,
) -> Result<Json<Value>> {
    let rows = sqlx::query(
        "UPDATE paintsharp.video_projects
         SET last_edited_by = $1, thumbnail_dirty = TRUE
         WHERE id = $2 AND owner_id = $3",
    )
    .bind(user.id)
    .bind(id)
    .bind(user.id)
    .execute(&state.db)
    .await?
    .rows_affected();

    if rows == 0 {
        return Err(PaintsharpError::NotFound("Projet vidéo introuvable".into()));
    }

    // Timeline → fichier .kbmot.
    let file_id = video_file_id(&state, id, user.id).await?;
    let content = cf::motion_content_from(body);
    cf::write_content(&state, user.id, file_id, &content).await?;

    Ok(Json(json!({ "ok": true })))
}

// ── Trash / restore / delete ──────────────────────────────────────────────────

pub async fn trash_video_project(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    sqlx::query(
        "UPDATE paintsharp.video_projects SET is_trashed = TRUE, trashed_at = NOW()
         WHERE id = $1 AND owner_id = $2",
    )
    .bind(id).bind(user.id)
    .execute(&state.db).await?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn restore_video_project(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    sqlx::query(
        "UPDATE paintsharp.video_projects SET is_trashed = FALSE, trashed_at = NULL
         WHERE id = $1 AND owner_id = $2",
    )
    .bind(id).bind(user.id)
    .execute(&state.db).await?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn delete_video_project(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    sqlx::query(
        "DELETE FROM paintsharp.video_projects WHERE id = $1 AND owner_id = $2 AND is_trashed = TRUE",
    )
    .bind(id).bind(user.id)
    .execute(&state.db).await?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn duplicate_video_project(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let source: VideoProject = sqlx::query_as::<_, VideoProject>(
        "SELECT id, owner_id, title, composition, render_settings, file_id,
                thumbnail_path, thumbnail_dirty, is_trashed, last_edited_by,
                updated_at, created_at
         FROM paintsharp.video_projects WHERE id = $1 AND owner_id = $2 AND is_trashed = FALSE",
    )
    .bind(id).bind(user.id)
    .fetch_optional(&state.db).await?
    .ok_or_else(|| PaintsharpError::NotFound("Projet vidéo introuvable".into()))?;

    let new_title = format!("{} (copie)", source.title);
    let new_id: Uuid = sqlx::query_scalar(
        "INSERT INTO paintsharp.video_projects (owner_id, title, composition, render_settings)
         VALUES ($1, $2, $3, $4) RETURNING id",
    )
    .bind(user.id)
    .bind(&new_title)
    .bind(&source.composition)
    .bind(&source.render_settings)
    .fetch_one(&state.db).await?;

    // Copie le fichier de contenu (timeline).
    let content = match source.file_id {
        Some(fid) => cf::read_content(&state, user.id, fid).await
            .unwrap_or_else(|_| cf::motion_content_from(cf::empty_timeline())),
        None => cf::motion_content_from(cf::empty_timeline()),
    };
    let new_file_id = cf::create_motion_file(&state, user.id, &new_title, &content).await?;
    sqlx::query("UPDATE paintsharp.video_projects SET file_id = $1 WHERE id = $2")
        .bind(new_file_id).bind(new_id).execute(&state.db).await?;

    Ok(Json(json!({ "id": new_id })))
}

// ── Media import (multipart upload) ──────────────────────────────────────────

pub async fn import_media(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(project_id): Path<Uuid>,
    mut multipart: Multipart,
) -> Result<Json<Value>> {
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM paintsharp.video_projects WHERE id = $1 AND owner_id = $2",
    )
    .bind(project_id)
    .bind(user.id)
    .fetch_one(&state.db)
    .await?;

    if count == 0 {
        return Err(PaintsharpError::NotFound("Projet vidéo introuvable".into()));
    }

    let base_dir = PathBuf::from(&state.settings.paintsharp.media_path)
        .join(user.id.to_string())
        .join(project_id.to_string());
    tokio::fs::create_dir_all(&base_dir).await.map_err(|e| {
        PaintsharpError::Internal(anyhow!("Impossible de créer le répertoire média: {e}"))
    })?;

    let mut media_ids: Vec<Uuid> = Vec::new();

    while let Some(field) = multipart.next_field().await.map_err(|e| {
        PaintsharpError::Validation(format!("Erreur multipart: {e}"))
    })? {
        let file_name    = field.file_name().unwrap_or("untitled").to_string();
        let content_type = field.content_type()
            .unwrap_or("application/octet-stream")
            .to_string();
        let data = field.bytes().await.map_err(|e| {
            PaintsharpError::Validation(format!("Erreur lecture fichier: {e}"))
        })?;

        let max_bytes = state.settings.paintsharp.max_media_bytes;
        if data.len() as u64 > max_bytes {
            return Err(PaintsharpError::Validation(
                format!("Fichier trop volumineux (max {} MB)", max_bytes / 1_048_576)
            ));
        }

        let ext = std::path::Path::new(&file_name)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("bin");

        let media_id  = Uuid::new_v4();
        let file_path = base_dir.join(format!("{}.{}", media_id, ext));
        let storage_path = file_path.to_string_lossy().to_string();

        tokio::fs::write(&file_path, &data).await.map_err(|e| {
            PaintsharpError::Internal(anyhow!("Erreur écriture fichier: {e}"))
        })?;

        sqlx::query(
            "INSERT INTO paintsharp.video_media
             (id, project_id, owner_id, storage_path, original_name, mime_type, size_bytes, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'ready')",
        )
        .bind(media_id)
        .bind(project_id)
        .bind(user.id)
        .bind(&storage_path)
        .bind(&file_name)
        .bind(&content_type)
        .bind(data.len() as i64)
        .execute(&state.db)
        .await?;

        media_ids.push(media_id);
    }

    Ok(Json(json!({ "media_ids": media_ids })))
}

// ── Import média par référence à un fichier Files (sans transit navigateur) ───
// Le navigateur n'a plus à télécharger puis ré-uploader : on récupère le contenu
// côté serveur via l'IPC du module Files (GET /ipc/files/:uid/:id/content).

#[derive(Debug, Deserialize)]
pub struct ImportFromFileDto {
    pub file_id: Uuid,
}

pub async fn import_media_from_file(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(project_id): Path<Uuid>,
    Json(dto): Json<ImportFromFileDto>,
) -> Result<Json<Value>> {
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM paintsharp.video_projects WHERE id = $1 AND owner_id = $2",
    )
    .bind(project_id)
    .bind(user.id)
    .fetch_one(&state.db)
    .await?;
    if count == 0 {
        return Err(PaintsharpError::NotFound("Projet vidéo introuvable".into()));
    }

    // Récupère le fichier directement depuis le module Files (serveur à serveur).
    let url = format!("{}/ipc/files/{}/{}/content", state.settings.core.files_url, user.id, dto.file_id);
    let resp = reqwest::Client::new()
        .get(&url)
        .header("X-Internal-Secret", &state.settings.core.internal_secret)
        .send()
        .await
        .map_err(|e| PaintsharpError::Internal(anyhow!("Appel Files échoué: {e}")))?;
    if !resp.status().is_success() {
        return Err(PaintsharpError::Internal(anyhow!("Files a renvoyé {}", resp.status())));
    }
    let body: Value = resp.json().await
        .map_err(|e| PaintsharpError::Internal(anyhow!("Réponse Files invalide: {e}")))?;
    let file_name = body["file"]["name"].as_str().unwrap_or("untitled").to_string();
    let content_type = body["file"]["mime_type"].as_str().unwrap_or("application/octet-stream").to_string();
    let b64 = body["content"].as_str()
        .ok_or_else(|| PaintsharpError::Internal(anyhow!("Contenu Files manquant")))?;
    use base64::Engine as _;
    let data = base64::engine::general_purpose::STANDARD.decode(b64)
        .map_err(|e| PaintsharpError::Internal(anyhow!("Décodage base64 échoué: {e}")))?;

    let max_bytes = state.settings.paintsharp.max_media_bytes;
    if data.len() as u64 > max_bytes {
        return Err(PaintsharpError::Validation(format!("Fichier trop volumineux (max {} MB)", max_bytes / 1_048_576)));
    }

    let base_dir = PathBuf::from(&state.settings.paintsharp.media_path)
        .join(user.id.to_string())
        .join(project_id.to_string());
    tokio::fs::create_dir_all(&base_dir).await.map_err(|e| {
        PaintsharpError::Internal(anyhow!("Impossible de créer le répertoire média: {e}"))
    })?;

    let ext = std::path::Path::new(&file_name).extension().and_then(|e| e.to_str()).unwrap_or("bin");
    let media_id = Uuid::new_v4();
    let file_path = base_dir.join(format!("{}.{}", media_id, ext));
    let storage_path = file_path.to_string_lossy().to_string();
    tokio::fs::write(&file_path, &data).await.map_err(|e| {
        PaintsharpError::Internal(anyhow!("Erreur écriture fichier: {e}"))
    })?;

    sqlx::query(
        "INSERT INTO paintsharp.video_media
         (id, project_id, owner_id, storage_path, original_name, mime_type, size_bytes, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'ready')",
    )
    .bind(media_id).bind(project_id).bind(user.id)
    .bind(&storage_path).bind(&file_name).bind(&content_type).bind(data.len() as i64)
    .execute(&state.db).await?;

    Ok(Json(json!({ "media_ids": [media_id] })))
}

// ── List media ────────────────────────────────────────────────────────────────

pub async fn list_media(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(project_id): Path<Uuid>,
) -> Result<Json<Value>> {
    let media = sqlx::query_as::<_, VideoMedia>(
        "SELECT id, project_id, owner_id, storage_path, original_name, mime_type,
                size_bytes, probe_data, thumbnails_path, waveform_path, status, error_message, created_at
         FROM paintsharp.video_media
         WHERE project_id = $1 AND owner_id = $2
         ORDER BY created_at ASC",
    )
    .bind(project_id)
    .bind(user.id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(json!({ "media": media })))
}

// ── Stream media file ─────────────────────────────────────────────────────────

pub async fn stream_media(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path((project_id, media_id)): Path<(Uuid, Uuid)>,
) -> Result<Response> {
    let row = sqlx::query(
        "SELECT storage_path, mime_type FROM paintsharp.video_media
         WHERE id = $1 AND project_id = $2 AND owner_id = $3",
    )
    .bind(media_id)
    .bind(project_id)
    .bind(user.id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| PaintsharpError::NotFound("Média introuvable".into()))?;

    let storage_path: String = row.get("storage_path");
    let mime_type:    String = row.get("mime_type");

    let file = tokio::fs::File::open(&storage_path).await.map_err(|e| {
        PaintsharpError::Internal(anyhow!("Fichier introuvable: {e}"))
    })?;

    let stream = ReaderStream::new(file);
    let body   = Body::from_stream(stream);

    Response::builder()
        .header("Content-Type", mime_type)
        .header("Cache-Control", "private, max-age=3600")
        .body(body)
        .map_err(|e| PaintsharpError::Internal(anyhow!(e.to_string())))
}

// ── Render jobs ───────────────────────────────────────────────────────────────

pub async fn create_render_job(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(project_id): Path<Uuid>,
    Json(dto): Json<CreateRenderJobDto>,
) -> Result<Json<Value>> {
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM paintsharp.video_projects WHERE id = $1 AND owner_id = $2",
    )
    .bind(project_id)
    .bind(user.id)
    .fetch_one(&state.db)
    .await?;

    if count == 0 {
        return Err(PaintsharpError::NotFound("Projet vidéo introuvable".into()));
    }

    let render_options = dto.render_options.unwrap_or(json!({}));

    let frame_total: Option<i32> = sqlx::query_scalar(
        "SELECT (composition->>'duration_frames')::int FROM paintsharp.video_projects WHERE id = $1",
    )
    .bind(project_id)
    .fetch_one(&state.db)
    .await?;

    let frame_total = frame_total.unwrap_or(0);

    let row = sqlx::query(
        "INSERT INTO paintsharp.render_jobs (project_id, owner_id, render_options, frame_total)
         VALUES ($1, $2, $3, $4)
         RETURNING id",
    )
    .bind(project_id)
    .bind(user.id)
    .bind(&render_options)
    .bind(frame_total)
    .fetch_one(&state.db)
    .await?;

    let job_id: Uuid = row.get("id");
    Ok(Json(json!({ "job_id": job_id })))
}

pub async fn get_render_job(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path((project_id, job_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<RenderJob>> {
    let job = sqlx::query_as::<_, RenderJob>(
        "SELECT id, project_id, owner_id, render_options, output_path, output_url,
                status, progress, frame_current, frame_total, error_message,
                started_at, finished_at, created_at
         FROM paintsharp.render_jobs
         WHERE id = $1 AND project_id = $2 AND owner_id = $3",
    )
    .bind(job_id)
    .bind(project_id)
    .bind(user.id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| PaintsharpError::NotFound("Job de rendu introuvable".into()))?;

    Ok(Json(job))
}

pub async fn list_render_jobs(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(project_id): Path<Uuid>,
) -> Result<Json<Value>> {
    let jobs = sqlx::query_as::<_, RenderJob>(
        "SELECT id, project_id, owner_id, render_options, output_path, output_url,
                status, progress, frame_current, frame_total, error_message,
                started_at, finished_at, created_at
         FROM paintsharp.render_jobs
         WHERE project_id = $1 AND owner_id = $2
         ORDER BY created_at DESC LIMIT 20",
    )
    .bind(project_id)
    .bind(user.id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(json!({ "jobs": jobs })))
}

#[derive(serde::Deserialize)]
pub struct OpenByFileDto { pub file_id: uuid::Uuid }

/// Ouvre l'entité liée à un fichier (.kb*) — utilisé par StartPage / « ouvrir avec ».
pub async fn open_by_file(
    axum::extract::State(state): axum::extract::State<crate::state::AppState>,
    axum::Extension(user): axum::Extension<crate::middleware::PaintsharpUser>,
    axum::Json(dto): axum::Json<OpenByFileDto>,
) -> crate::errors::Result<axum::Json<serde_json::Value>> {
    let id: uuid::Uuid = sqlx::query_scalar(
        "SELECT id FROM paintsharp.video_projects WHERE file_id = $1 AND owner_id = $2 AND is_trashed = FALSE",
    )
    .bind(dto.file_id).bind(user.id)
    .fetch_optional(&state.db).await?
    .ok_or_else(|| crate::errors::PaintsharpError::NotFound(format!("Aucun projet vidéo lié au fichier {}", dto.file_id)))?;
    Ok(axum::Json(serde_json::json!({ "id": id })))
}
