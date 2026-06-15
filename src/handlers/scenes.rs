use axum::{
    extract::{Path, Query, State},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use axum::Extension;
use crate::{
    errors::{PaintsharpError, Result},
    middleware::PaintsharpUser,
    models::scene::{CreateSceneDto, SceneSummary, UpdateSceneDto},
    services::content_files as cf,
    state::AppState,
};

async fn scene_file_id(state: &AppState, id: Uuid, user_id: Uuid) -> Result<Uuid> {
    let fid: Option<Uuid> = sqlx::query_scalar(
        "SELECT file_id FROM scenes WHERE id = $1 AND owner_id = $2",
    )
    .bind(id).bind(user_id)
    .fetch_optional(&state.db).await?
    .ok_or_else(|| PaintsharpError::NotFound(id.to_string()))?;
    fid.ok_or_else(|| PaintsharpError::Internal(anyhow::anyhow!("scène sans fichier de contenu")))
}

#[derive(Debug, Deserialize)]
pub struct ListQuery {
    pub starred: Option<bool>,
    pub trashed: Option<bool>,
    pub limit:   Option<i64>,
    pub offset:  Option<i64>,
}

pub async fn list(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Query(q): Query<ListQuery>,
) -> Result<Json<Value>> {
    let limit  = q.limit.unwrap_or(50).min(200);
    let offset = q.offset.unwrap_or(0);
    let trashed = q.trashed.unwrap_or(false);
    let starred = q.starred.unwrap_or(false);

    let scenes = if starred {
        sqlx::query_as::<_, SceneSummary>(
            "SELECT id, owner_id, title, description, thumbnail_url, is_starred,
                    vertex_count, face_count, updated_at, created_at
             FROM scenes
             WHERE owner_id = $1 AND is_starred = TRUE AND is_trashed = FALSE
             ORDER BY updated_at DESC
             LIMIT $2 OFFSET $3",
        )
        .bind(user.id).bind(limit).bind(offset)
        .fetch_all(&state.db).await?
    } else if trashed {
        sqlx::query_as::<_, SceneSummary>(
            "SELECT id, owner_id, title, description, thumbnail_url, is_starred,
                    vertex_count, face_count, updated_at, created_at
             FROM scenes
             WHERE owner_id = $1 AND is_trashed = TRUE
             ORDER BY trashed_at DESC
             LIMIT $2 OFFSET $3",
        )
        .bind(user.id).bind(limit).bind(offset)
        .fetch_all(&state.db).await?
    } else {
        sqlx::query_as::<_, SceneSummary>(
            "SELECT id, owner_id, title, description, thumbnail_url, is_starred,
                    vertex_count, face_count, updated_at, created_at
             FROM scenes
             WHERE owner_id = $1 AND is_trashed = FALSE
             ORDER BY updated_at DESC
             LIMIT $2 OFFSET $3",
        )
        .bind(user.id).bind(limit).bind(offset)
        .fetch_all(&state.db).await?
    };

    Ok(Json(json!({ "scenes": scenes })))
}

pub async fn create(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Json(body): Json<CreateSceneDto>,
) -> Result<Json<Value>> {
    let title = body.title.unwrap_or_else(|| "Sans titre".to_string());

    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO scenes (owner_id, title, description)
         VALUES ($1, $2, $3)
         RETURNING id",
    )
    .bind(user.id)
    .bind(&title)
    .bind(&body.description)
    .fetch_one(&state.db)
    .await?;

    // Scène → fichier .kbscn dans files.
    let content = cf::scene_content_from(cf::empty_scene_json());
    let file_id = cf::create_scene_file(&state, user.id, &title, &content).await?;
    sqlx::query("UPDATE scenes SET file_id = $1 WHERE id = $2")
        .bind(file_id).bind(id).execute(&state.db).await?;

    Ok(Json(json!({ "id": id, "title": title })))
}

pub async fn get(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let scene = sqlx::query_as::<_, crate::models::scene::Scene>(
        "SELECT * FROM scenes WHERE id = $1 AND owner_id = $2",
    )
    .bind(id)
    .bind(user.id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| PaintsharpError::NotFound(id.to_string()))?;

    // scene_json lu depuis le fichier .kbscn.
    let mut val = serde_json::to_value(&scene).unwrap_or_default();
    val["scene_json"] = match scene.file_id {
        Some(fid) => cf::read_content(&state, user.id, fid).await.ok()
            .and_then(|c| c.get("scene").cloned()).unwrap_or_else(cf::empty_scene_json),
        None => cf::empty_scene_json(),
    };
    // Titre = nom du fichier .kbscn (sans extension) ; self-heal si renommé ailleurs.
    if let Some(fid) = scene.file_id {
        if let Some(fname) = cf::file_name(&state, user.id, fid).await {
            let stem = cf::strip_ext(&fname);
            if !stem.is_empty() && stem != scene.title {
                sqlx::query("UPDATE scenes SET title = $2 WHERE id = $1")
                    .bind(id).bind(&stem).execute(&state.db).await?;
                val["title"] = Value::String(stem);
            }
        }
    }
    Ok(Json(val))
}

pub async fn update(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
    Json(body): Json<UpdateSceneDto>,
) -> Result<Json<Value>> {
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM scenes WHERE id = $1 AND owner_id = $2)",
    )
    .bind(id).bind(user.id)
    .fetch_one(&state.db).await?;

    if !exists {
        return Err(PaintsharpError::NotFound(id.to_string()));
    }

    sqlx::query(
        "UPDATE scenes SET
            title          = COALESCE($3, title),
            description    = COALESCE($4, description),
            thumbnail_url  = COALESCE($5, thumbnail_url),
            is_starred     = COALESCE($6, is_starred),
            vertex_count   = COALESCE($7, vertex_count),
            face_count     = COALESCE($8, face_count),
            last_editor_id = $2
         WHERE id = $1 AND owner_id = $2",
    )
    .bind(id)
    .bind(user.id)
    .bind(&body.title)
    .bind(&body.description)
    .bind(&body.thumbnail_url)
    .bind(body.is_starred)
    .bind(body.vertex_count)
    .bind(body.face_count)
    .execute(&state.db)
    .await?;

    // Contenu de la scène → fichier.
    if let Some(scene_json) = &body.scene_json {
        let file_id = scene_file_id(&state, id, user.id).await?;
        let content = cf::scene_content_from(scene_json.clone());
        cf::write_content(&state, user.id, file_id, &content).await?;
    }

    // Titre modifié → renommer le fichier .kbscn (titre = nom). Best-effort.
    if let Some(t) = body.title.as_ref() {
        if !t.trim().is_empty() {
            if let Ok(fid) = scene_file_id(&state, id, user.id).await {
                cf::rename_content_file(&state, user.id, fid, t, "kbscn").await;
            }
        }
    }

    Ok(Json(json!({ "ok": true })))
}

pub async fn trash(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let rows = sqlx::query(
        "UPDATE scenes SET is_trashed = TRUE, trashed_at = NOW()
         WHERE id = $1 AND owner_id = $2 AND is_trashed = FALSE",
    )
    .bind(id).bind(user.id)
    .execute(&state.db).await?.rows_affected();

    if rows == 0 {
        return Err(PaintsharpError::NotFound(id.to_string()));
    }
    Ok(Json(json!({ "ok": true })))
}

pub async fn restore(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    sqlx::query(
        "UPDATE scenes SET is_trashed = FALSE, trashed_at = NULL
         WHERE id = $1 AND owner_id = $2",
    )
    .bind(id).bind(user.id)
    .execute(&state.db).await?;

    Ok(Json(json!({ "ok": true })))
}

pub async fn delete(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let rows = sqlx::query(
        "DELETE FROM scenes WHERE id = $1 AND owner_id = $2 AND is_trashed = TRUE",
    )
    .bind(id).bind(user.id)
    .execute(&state.db).await?.rows_affected();

    if rows == 0 {
        return Err(PaintsharpError::NotFound(id.to_string()));
    }
    Ok(Json(json!({ "ok": true })))
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
        "SELECT id FROM paintsharp.scenes WHERE file_id = $1 AND owner_id = $2 AND is_trashed = FALSE",
    )
    .bind(dto.file_id).bind(user.id)
    .fetch_optional(&state.db).await?
    .ok_or_else(|| crate::errors::PaintsharpError::NotFound(format!("Aucun scène lié au fichier {}", dto.file_id)))?;
    Ok(axum::Json(serde_json::json!({ "id": id })))
}
