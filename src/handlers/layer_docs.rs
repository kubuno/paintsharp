use axum::{extract::{Path, Query, State}, Extension, Json};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    errors::{PaintsharpError, Result},
    middleware::PaintsharpUser,
    models::layer_doc::{
        CreateLayerDocDto, LayerDocumentSummary, LayerDocument, UpdateLayerDocDto,
    },
    services::content_files as cf,
    state::AppState,
};

/// file_id du fichier de contenu d'un document Layer.
async fn doc_file_id(state: &AppState, id: Uuid, user_id: Uuid) -> Result<Uuid> {
    let fid: Option<Uuid> = sqlx::query_scalar(
        "SELECT file_id FROM layer_documents WHERE id = $1 AND owner_id = $2",
    )
    .bind(id).bind(user_id)
    .fetch_optional(&state.db).await?
    .ok_or_else(|| PaintsharpError::NotFound(id.to_string()))?;
    fid.ok_or_else(|| PaintsharpError::Internal(anyhow::anyhow!("document sans fichier de contenu")))
}

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
    let trashed = q.trashed.unwrap_or(false);
    let starred = q.starred.unwrap_or(false);

    let docs = if starred {
        sqlx::query_as::<_, LayerDocumentSummary>(
            "SELECT id, owner_id, title, width, height, color_mode, thumbnail_path,
                    is_starred, layer_count, updated_at, created_at
             FROM layer_documents
             WHERE owner_id = $1 AND is_starred = TRUE AND is_trashed = FALSE
             ORDER BY updated_at DESC LIMIT $2 OFFSET $3",
        )
        .bind(user.id).bind(limit).bind(offset)
        .fetch_all(&state.db).await?
    } else if trashed {
        sqlx::query_as::<_, LayerDocumentSummary>(
            "SELECT id, owner_id, title, width, height, color_mode, thumbnail_path,
                    is_starred, layer_count, updated_at, created_at
             FROM layer_documents
             WHERE owner_id = $1 AND is_trashed = TRUE
             ORDER BY trashed_at DESC LIMIT $2 OFFSET $3",
        )
        .bind(user.id).bind(limit).bind(offset)
        .fetch_all(&state.db).await?
    } else {
        sqlx::query_as::<_, LayerDocumentSummary>(
            "SELECT id, owner_id, title, width, height, color_mode, thumbnail_path,
                    is_starred, layer_count, updated_at, created_at
             FROM layer_documents
             WHERE owner_id = $1 AND is_trashed = FALSE
             ORDER BY updated_at DESC LIMIT $2 OFFSET $3",
        )
        .bind(user.id).bind(limit).bind(offset)
        .fetch_all(&state.db).await?
    };

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

    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO layer_documents
            (owner_id, title, width, height, color_mode, bit_depth, dpi)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id",
    )
    .bind(user.id).bind(&title)
    .bind(width).bind(height)
    .bind(&color_mode).bind(bit_depth).bind(dpi)
    .fetch_one(&state.db).await?;

    // Structure des calques + réglages → fichier .kblay dans files.
    let content = cf::empty_layer_content(layers_structure);
    let file_id = cf::create_layer_file(&state, user.id, &title, &content).await?;
    sqlx::query("UPDATE layer_documents SET file_id = $1 WHERE id = $2")
        .bind(file_id).bind(id).execute(&state.db).await?;

    Ok(Json(json!({ "id": id, "title": title })))
}

pub async fn get_doc(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let doc = sqlx::query_as::<_, LayerDocument>(
        "SELECT id, owner_id, title, width, height, color_mode, bit_depth, dpi,
                file_id, thumbnail_path, layer_count,
                is_starred, is_trashed, created_at, updated_at
         FROM layer_documents WHERE id = $1 AND owner_id = $2",
    )
    .bind(id).bind(user.id)
    .fetch_optional(&state.db).await?
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
                sqlx::query("UPDATE layer_documents SET title = $2 WHERE id = $1")
                    .bind(id).bind(&stem).execute(&state.db).await?;
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
    let rows = sqlx::query(
        "UPDATE layer_documents SET
            title            = COALESCE($3, title),
            thumbnail_path   = COALESCE($4, thumbnail_path),
            thumbnail_dirty  = COALESCE($5, thumbnail_dirty),
            is_starred       = COALESCE($6, is_starred),
            last_edited_by   = $2
         WHERE id = $1 AND owner_id = $2",
    )
    .bind(id).bind(user.id)
    .bind(&body.title)
    .bind(&body.thumbnail_path)
    .bind(body.thumbnail_dirty)
    .bind(body.is_starred)
    .execute(&state.db).await?.rows_affected();

    if rows == 0 {
        return Err(PaintsharpError::NotFound(id.to_string()));
    }

    // Contenu (structure / réglages de vue) → fichier.
    if body.layers_structure.is_some() || body.view_settings.is_some() {
        let file_id = doc_file_id(&state, id, user.id).await?;
        let mut content = cf::read_content(&state, user.id, file_id).await?;
        if let Some(ls) = &body.layers_structure { content["layers_structure"] = ls.clone(); }
        if let Some(vs) = &body.view_settings    { content["view_settings"]    = vs.clone(); }
        cf::write_content(&state, user.id, file_id, &content).await?;
    }
    // Titre modifié → renommer le fichier .kblay (titre = nom). Best-effort.
    if let Some(t) = body.title.as_ref() {
        if !t.trim().is_empty() {
            if let Ok(fid) = doc_file_id(&state, id, user.id).await {
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
    let rows = sqlx::query(
        "UPDATE layer_documents SET is_trashed = TRUE, trashed_at = NOW()
         WHERE id = $1 AND owner_id = $2 AND is_trashed = FALSE",
    )
    .bind(id).bind(user.id)
    .execute(&state.db).await?.rows_affected();

    if rows == 0 { return Err(PaintsharpError::NotFound(id.to_string())); }
    Ok(Json(json!({ "ok": true })))
}

pub async fn restore_doc(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    sqlx::query(
        "UPDATE layer_documents SET is_trashed = FALSE, trashed_at = NULL
         WHERE id = $1 AND owner_id = $2",
    )
    .bind(id).bind(user.id)
    .execute(&state.db).await?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn delete_doc(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let rows = sqlx::query(
        "DELETE FROM layer_documents WHERE id = $1 AND owner_id = $2 AND is_trashed = TRUE",
    )
    .bind(id).bind(user.id)
    .execute(&state.db).await?.rows_affected();

    if rows == 0 { return Err(PaintsharpError::NotFound(id.to_string())); }
    Ok(Json(json!({ "ok": true })))
}

pub async fn duplicate_doc(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let source: LayerDocument = sqlx::query_as::<_, LayerDocument>(
        "SELECT id, owner_id, title, width, height, color_mode, bit_depth, dpi,
                file_id, thumbnail_path, layer_count,
                is_starred, is_trashed, created_at, updated_at
         FROM layer_documents WHERE id = $1 AND owner_id = $2 AND is_trashed = FALSE",
    )
    .bind(id).bind(user.id)
    .fetch_optional(&state.db).await?
    .ok_or_else(|| PaintsharpError::NotFound(id.to_string()))?;

    let new_title = format!("{} (copie)", source.title);
    let new_id: Uuid = sqlx::query_scalar(
        "INSERT INTO layer_documents
           (owner_id, title, width, height, color_mode, bit_depth, dpi)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
    )
    .bind(user.id).bind(&new_title)
    .bind(source.width).bind(source.height)
    .bind(&source.color_mode).bind(source.bit_depth).bind(source.dpi)
    .fetch_one(&state.db).await?;

    // Copie le fichier de contenu.
    let content = match source.file_id {
        Some(fid) => cf::read_content(&state, user.id, fid).await.unwrap_or_else(|_| cf::empty_layer_content(json!([]))),
        None      => cf::empty_layer_content(json!([])),
    };
    let new_file_id = cf::create_layer_file(&state, user.id, &new_title, &content).await?;
    sqlx::query("UPDATE layer_documents SET file_id = $1 WHERE id = $2")
        .bind(new_file_id).bind(new_id).execute(&state.db).await?;

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

    let rows = sqlx::query(
        "UPDATE layer_documents SET
            layer_count      = $3,
            thumbnail_dirty  = TRUE,
            last_edited_by   = $2
         WHERE id = $1 AND owner_id = $2",
    )
    .bind(id).bind(user.id)
    .bind(count)
    .execute(&state.db).await?.rows_affected();

    if rows == 0 { return Err(PaintsharpError::NotFound(id.to_string())); }

    // Structure des calques → fichier .kblay.
    let file_id = doc_file_id(&state, id, user.id).await?;
    let mut content = cf::read_content(&state, user.id, file_id).await?;
    content["layers_structure"] = body.layers_structure;
    cf::write_content(&state, user.id, file_id, &content).await?;

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
        "SELECT id FROM paintsharp.layer_documents WHERE file_id = $1 AND owner_id = $2 AND is_trashed = FALSE",
    )
    .bind(dto.file_id).bind(user.id)
    .fetch_optional(&state.db).await?
    .ok_or_else(|| crate::errors::PaintsharpError::NotFound(format!("Aucun document lié au fichier {}", dto.file_id)))?;
    Ok(axum::Json(serde_json::json!({ "id": id })))
}
