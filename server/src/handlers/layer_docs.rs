use axum::{extract::{Path, Query, State}, Extension, Json};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    errors::{PaintsharpError, Result},
    middleware::PaintsharpUser,
    models::layer_doc::{CreateLayerDocDto, UpdateLayerDocDto},
    services::content_files as cf,
    services::store::layers as store,
    state::AppState,
};

#[derive(Debug, Deserialize)]
pub struct ListQuery {
    pub starred: Option<bool>,
    pub trashed: Option<bool>,
    pub limit:   Option<i64>,
    pub offset:  Option<i64>,
}

pub async fn list_docs(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Query(q): Query<ListQuery>,
) -> Result<Json<Value>> {
    let limit   = q.limit.unwrap_or(50).min(200);
    let offset  = q.offset.unwrap_or(0);
    let docs = store::list_docs(
        &state.db,
        user.id,
        q.starred.unwrap_or(false),
        q.trashed.unwrap_or(false),
        limit,
        offset,
    )
    .await?;
    Ok(Json(json!({ "documents": docs })))
}

pub async fn create_doc(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Json(body): Json<CreateLayerDocDto>,
) -> Result<Json<Value>> {
    let title      = body.title.unwrap_or_else(|| "image_sans_titre".to_string());
    let width      = body.width.unwrap_or(1920);
    let height     = body.height.unwrap_or(1080);
    let color_mode = body.color_mode.unwrap_or_else(|| "rgba".to_string());
    let bit_depth  = body.bit_depth.unwrap_or(8);
    let dpi        = body.dpi.unwrap_or(72);

    let bg_layer_id = Uuid::new_v4().to_string();
    let layers_structure = json!([{
        "id":       bg_layer_id,
        "type":     "raster",
        "name":     "Fond",
        "visible":  true,
        "locked":   false,
        "opacity":  100,
        "blendMode":"normal",
        "x":        0,
        "y":        0,
        "mask":     null,
        "effects":  []
    }]);

    let id = store::create_doc(&state.db, user.id, &title, width, height, &color_mode, bit_depth, dpi).await?;

    // Structure des calques + réglages → fichier .kblay dans files.
    let content = cf::empty_layer_content(layers_structure);
    let file_id = cf::create_layer_file(&state, user.id, &title, &content).await?;
    store::set_file_id(&state.db, id, file_id).await?;

    Ok(Json(json!({ "id": id, "title": title })))
}

pub async fn get_doc(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let doc = store::get_doc(&state.db, id, user.id)
        .await?
        .ok_or_else(|| PaintsharpError::NotFound(id.to_string()))?;

    // Structure + réglages lus depuis le fichier .kblay.
    let mut val = serde_json::to_value(&doc).unwrap_or_default();
    if let Some(fid) = doc.file_id {
        if let Ok(content) = cf::read_content(&state, user.id, fid).await {
            val["layers_structure"] = content.get("layers_structure").cloned().unwrap_or_else(|| json!([]));
            val["view_settings"]    = content.get("view_settings").cloned().unwrap_or_else(|| json!({}));
        }
        if let Some(fname) = cf::file_name(&state, user.id, fid).await {
            let stem = cf::strip_ext(&fname);
            if !stem.is_empty() && stem != doc.title {
                store::rename_doc(&state.db, id, &stem).await?;
                val["title"] = Value::String(stem);
            }
        }
    }
    Ok(Json(val))
}

pub async fn update_doc(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
    Json(body): Json<UpdateLayerDocDto>,
) -> Result<Json<Value>> {
    // Validate new dimensions (crop / rotation / canvas resize) before touching the DB.
    for dim in [body.width, body.height].into_iter().flatten() {
        if !(1..=16384).contains(&dim) {
            return Err(PaintsharpError::Validation(format!(
                "invalid document dimension: {dim}"
            )));
        }
    }
    if store::update_doc(&state.db, id, user.id, &body).await? == 0 {
        return Err(PaintsharpError::NotFound(id.to_string()));
    }

    // Contenu (structure / réglages de vue) → fichier.
    if body.layers_structure.is_some() || body.view_settings.is_some() {
        let file_id = store::doc_file_id(&state.db, id, user.id).await?;
        let mut content = cf::read_content(&state, user.id, file_id).await?;
        if let Some(ls) = &body.layers_structure { content["layers_structure"] = ls.clone(); }
        if let Some(vs) = &body.view_settings    { content["view_settings"]    = vs.clone(); }
        cf::write_content(&state, user.id, file_id, &content).await?;
    }
    // Titre modifié → renommer le fichier .kblay (titre = nom). Best-effort.
    if let Some(t) = body.title.as_ref() {
        if !t.trim().is_empty() {
            if let Ok(fid) = store::doc_file_id(&state.db, id, user.id).await {
                cf::rename_content_file(&state, user.id, fid, t, "kblay").await;
            }
        }
    }
    Ok(Json(json!({ "ok": true })))
}

pub async fn trash_doc(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    if store::trash_doc(&state.db, id, user.id).await? == 0 {
        return Err(PaintsharpError::NotFound(id.to_string()));
    }
    Ok(Json(json!({ "ok": true })))
}

pub async fn restore_doc(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    store::restore_doc(&state.db, id, user.id).await?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn delete_doc(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    // See scenes::delete — the Drive file must go with the row.
    let Some(file_id) = crate::services::store::delete_trashed_returning_file_id(
        &state.db, "paintsharp.layer_documents", id, user.id,
    )
    .await?
    else {
        return Err(PaintsharpError::NotFound(id.to_string()));
    };
    cf::delete_entity_files(&state, user.id, file_id).await;
    Ok(Json(json!({ "ok": true })))
}

pub async fn duplicate_doc(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let source = store::get_active_doc(&state.db, id, user.id)
        .await?
        .ok_or_else(|| PaintsharpError::NotFound(id.to_string()))?;

    let new_title = format!("{} (copie)", source.title);
    let new_id = store::create_doc(
        &state.db,
        user.id,
        &new_title,
        source.width,
        source.height,
        &source.color_mode,
        source.bit_depth,
        source.dpi,
    )
    .await?;

    // Copie le fichier de contenu.
    let content = match source.file_id {
        Some(fid) => cf::read_content(&state, user.id, fid).await.unwrap_or_else(|_| cf::empty_layer_content(json!([]))),
        None      => cf::empty_layer_content(json!([])),
    };
    let new_file_id = cf::create_layer_file(&state, user.id, &new_title, &content).await?;
    store::set_file_id(&state.db, new_id, new_file_id).await?;

    Ok(Json(json!({ "id": new_id })))
}

// ── Structure des calques ─────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct SaveStructureDto {
    pub layers_structure: serde_json::Value,
    pub layer_count:      Option<i32>,
}

pub async fn save_structure(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
    Json(body): Json<SaveStructureDto>,
) -> Result<Json<Value>> {
    let count = body.layer_count.unwrap_or_else(|| {
        body.layers_structure.as_array().map(|a| a.len() as i32).unwrap_or(1)
    });

    if store::save_structure(&state.db, id, user.id, count).await? == 0 {
        return Err(PaintsharpError::NotFound(id.to_string()));
    }

    // Structure des calques → fichier .kblay.
    let file_id = store::doc_file_id(&state.db, id, user.id).await?;
    let mut content = cf::read_content(&state, user.id, file_id).await?;
    content["layers_structure"] = body.layers_structure;
    cf::write_content(&state, user.id, file_id, &content).await?;

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
        .ok_or_else(|| PaintsharpError::NotFound(format!("Aucun document lié au fichier {}", dto.file_id)))?;
    Ok(Json(json!({ "id": id })))
}
