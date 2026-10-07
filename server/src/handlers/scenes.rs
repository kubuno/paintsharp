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
    models::scene::{CreateSceneDto, UpdateSceneDto},
    services::content_files as cf,
    services::store::scenes as store,
    state::AppState,
};

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
    let scenes = store::list(
        &state.db,
        user.id,
        q.starred.unwrap_or(false),
        q.trashed.unwrap_or(false),
        limit,
        offset,
    )
    .await?;
    Ok(Json(json!({ "scenes": scenes })))
}

pub async fn create(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Json(body): Json<CreateSceneDto>,
) -> Result<Json<Value>> {
    let title = body.title.unwrap_or_else(|| "Sans titre".to_string());

    let id = store::create(&state.db, user.id, &title, body.description.as_deref()).await?;

    // Scène → fichier .kbscn dans files.
    let content = cf::scene_content_from(cf::empty_scene_json());
    let file_id = cf::create_scene_file(&state, user.id, &title, &content).await?;
    store::set_file_id(&state.db, id, file_id).await?;

    Ok(Json(json!({ "id": id, "title": title })))
}

pub async fn get(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let scene = store::get(&state.db, id, user.id)
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
                store::rename(&state.db, id, &stem).await?;
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
    if !store::exists(&state.db, id, user.id).await? {
        return Err(PaintsharpError::NotFound(id.to_string()));
    }

    store::update(&state.db, id, user.id, &body).await?;

    // Contenu de la scène → fichier.
    if let Some(scene_json) = &body.scene_json {
        let file_id = store::file_id(&state.db, id, user.id).await?;
        let content = cf::scene_content_from(scene_json.clone());
        cf::write_content(&state, user.id, file_id, &content).await?;
    }

    // Titre modifié → renommer le fichier .kbscn (titre = nom). Best-effort.
    if let Some(t) = body.title.as_ref() {
        if !t.trim().is_empty() {
            if let Ok(fid) = store::file_id(&state.db, id, user.id).await {
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
    if store::trash(&state.db, id, user.id).await? == 0 {
        return Err(PaintsharpError::NotFound(id.to_string()));
    }
    Ok(Json(json!({ "ok": true })))
}

pub async fn restore(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    store::restore(&state.db, id, user.id).await?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn delete(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    // Take the Drive file with the row: keeping it leaves an orphan the user can
    // still see and click, but which no longer opens onto anything.
    let Some(file_id) =
        crate::services::store::delete_trashed_returning_file_id(&state.db, "paintsharp.scenes", id, user.id).await?
    else {
        return Err(PaintsharpError::NotFound(id.to_string()));
    };
    cf::delete_entity_files(&state, user.id, file_id).await;
    Ok(Json(json!({ "ok": true })))
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
        .ok_or_else(|| PaintsharpError::NotFound(format!("Aucun scène lié au fichier {}", dto.file_id)))?;
    Ok(Json(json!({ "id": id })))
}
