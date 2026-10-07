use anyhow::anyhow;
use axum::{
    body::Body,
    extract::{Multipart, Path, Query, State},
    response::Response,
    Extension, Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use tokio_util::io::ReaderStream;
use uuid::Uuid;

use crate::{
    errors::{PaintsharpError, Result},
    middleware::PaintsharpUser,
    models::video::{CreateRenderJobDto, CreateVideoProjectDto, RenderJob, UpdateVideoProjectDto},
    services::content_files as cf,
    services::store::video as store,
    state::AppState,
};

#[derive(Debug, Deserialize)]
pub struct ListQuery {
    pub trashed: Option<bool>,
    pub limit:   Option<i64>,
    pub offset:  Option<i64>,
}

/// Ensures a project is owned; `NotFound` otherwise.
async fn require_owner(state: &AppState, project_id: Uuid, user_id: Uuid) -> Result<()> {
    if !store::exists(&state.db, project_id, user_id).await? {
        return Err(PaintsharpError::NotFound("Projet vidéo introuvable".into()));
    }
    Ok(())
}

// ── List projects ─────────────────────────────────────────────────────────────

pub async fn list_video_projects(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Query(q): Query<ListQuery>,
) -> Result<Json<Value>> {
    let limit   = q.limit.unwrap_or(50).min(200);
    let offset  = q.offset.unwrap_or(0);
    let projects = store::list_projects(&state.db, user.id, q.trashed.unwrap_or(false), limit, offset).await?;
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

    let id = store::create_project(&state.db, user.id, &title, &composition).await?;

    // Timeline (contenu) → fichier .kbmot.
    let content = cf::motion_content_from(cf::empty_timeline());
    let file_id = cf::create_motion_file(&state, user.id, &title, &content).await?;
    store::set_file_id(&state.db, id, file_id).await?;

    Ok(Json(json!({ "id": id, "title": title })))
}

// ── Get project ───────────────────────────────────────────────────────────────

pub async fn get_video_project(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let project = store::get_project(&state.db, id, user.id)
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
                store::rename_project(&state.db, id, &stem).await?;
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
    require_owner(&state, id, user.id).await?;

    store::update_project(&state.db, id, user.id, &dto).await?;

    // Titre modifié → renommer le fichier .kbmot (titre = nom). Best-effort.
    if let Some(t) = dto.title.as_ref() {
        if !t.trim().is_empty() {
            if let Ok(fid) = store::video_file_id(&state.db, id, user.id).await {
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
    if store::mark_edited(&state.db, id, user.id).await? == 0 {
        return Err(PaintsharpError::NotFound("Projet vidéo introuvable".into()));
    }

    // Timeline → fichier .kbmot.
    let file_id = store::video_file_id(&state.db, id, user.id).await?;
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
    store::trash_project(&state.db, id, user.id).await?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn restore_video_project(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    store::restore_project(&state.db, id, user.id).await?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn delete_video_project(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    // See scenes::delete — the Drive file must go with the row.
    if let Some(file_id) = crate::services::store::delete_trashed_returning_file_id(
        &state.db, "paintsharp.video_projects", id, user.id,
    )
    .await?
    {
        cf::delete_entity_files(&state, user.id, file_id).await;
    }
    Ok(Json(json!({ "ok": true })))
}

pub async fn duplicate_video_project(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let source = store::get_active_project(&state.db, id, user.id)
        .await?
        .ok_or_else(|| PaintsharpError::NotFound("Projet vidéo introuvable".into()))?;

    let new_title = format!("{} (copie)", source.title);
    let new_id = store::create_project_full(
        &state.db, user.id, &new_title, &source.composition, &source.render_settings,
    )
    .await?;

    // Copie le fichier de contenu (timeline).
    let content = match source.file_id {
        Some(fid) => cf::read_content(&state, user.id, fid).await
            .unwrap_or_else(|_| cf::motion_content_from(cf::empty_timeline())),
        None => cf::motion_content_from(cf::empty_timeline()),
    };
    let new_file_id = cf::create_motion_file(&state, user.id, &new_title, &content).await?;
    store::set_file_id(&state.db, new_id, new_file_id).await?;

    Ok(Json(json!({ "id": new_id })))
}

// ── Media import (multipart upload) ──────────────────────────────────────────

pub async fn import_media(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(project_id): Path<Uuid>,
    mut multipart: Multipart,
) -> Result<Json<Value>> {
    require_owner(&state, project_id, user.id).await?;

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

        // Instance ceiling (admin console); falls back to config.toml while the
        // administrator has not moved it off the compiled default.
        let max_bytes = state.instance().max_media_bytes_or(state.settings.paintsharp.max_media_bytes);
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

        store::insert_media(
            &state.db, media_id, project_id, user.id,
            &storage_path, &file_name, &content_type, data.len() as i64,
        )
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
    require_owner(&state, project_id, user.id).await?;

    // Fetch the file content server-to-server via the Files client, which now
    // routes through the core relay (/internal/ipc/drive/...).
    let (info, data) = state.files_client
        .get_file_content(user.id, dto.file_id)
        .await
        .map_err(|e| PaintsharpError::Internal(anyhow!("Appel Files échoué: {e}")))?;
    let file_name = info.name;
    let content_type = info.mime_type;

    // Same ceiling as the multipart upload path above.
    let max_bytes = state.instance().max_media_bytes_or(state.settings.paintsharp.max_media_bytes);
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

    store::insert_media(
        &state.db, media_id, project_id, user.id,
        &storage_path, &file_name, &content_type, data.len() as i64,
    )
    .await?;

    Ok(Json(json!({ "media_ids": [media_id] })))
}

// ── List media ────────────────────────────────────────────────────────────────

pub async fn list_media(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(project_id): Path<Uuid>,
) -> Result<Json<Value>> {
    let media = store::list_media(&state.db, project_id, user.id).await?;
    Ok(Json(json!({ "media": media })))
}

// ── Stream media file ─────────────────────────────────────────────────────────

pub async fn stream_media(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path((project_id, media_id)): Path<(Uuid, Uuid)>,
) -> Result<Response> {
    let (storage_path, mime_type) = store::media_location(&state.db, media_id, project_id, user.id)
        .await?
        .ok_or_else(|| PaintsharpError::NotFound("Média introuvable".into()))?;

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
    require_owner(&state, project_id, user.id).await?;

    let render_options = dto.render_options.unwrap_or(json!({}));
    let frame_total = store::project_frame_total(&state.db, project_id).await?;

    let job_id = store::create_render_job(&state.db, project_id, user.id, &render_options, frame_total).await?;
    Ok(Json(json!({ "job_id": job_id })))
}

pub async fn get_render_job(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path((project_id, job_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<RenderJob>> {
    let job = store::get_render_job(&state.db, job_id, project_id, user.id)
        .await?
        .ok_or_else(|| PaintsharpError::NotFound("Job de rendu introuvable".into()))?;
    Ok(Json(job))
}

pub async fn list_render_jobs(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(project_id): Path<Uuid>,
) -> Result<Json<Value>> {
    let jobs = store::list_render_jobs(&state.db, project_id, user.id).await?;
    Ok(Json(json!({ "jobs": jobs })))
}

#[derive(serde::Deserialize)]
pub struct OpenByFileDto { pub file_id: uuid::Uuid }

/// Ouvre l'entité liée à un fichier (.kb*) — utilisé par StartPage / « ouvrir avec ».
pub async fn open_by_file(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Json(dto): Json<OpenByFileDto>,
) -> Result<Json<Value>> {
    let id = store::find_by_file(&state.db, dto.file_id, user.id)
        .await?
        .ok_or_else(|| PaintsharpError::NotFound(format!("Aucun projet vidéo lié au fichier {}", dto.file_id)))?;
    Ok(Json(json!({ "id": id })))
}
