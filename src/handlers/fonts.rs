use axum::{extract::{Path, Query, State}, Extension, Json};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    errors::{PaintsharpError, Result},
    middleware::PaintsharpUser,
    models::font::{CreateFontProjectDto, UpdateFontProjectDto},
    services::content_files as cf,
    services::store::fonts as store,
    state::AppState,
};

#[derive(Debug, Deserialize)]
pub struct ListQuery {
    pub starred: Option<bool>,
    pub trashed: Option<bool>,
    pub limit:   Option<i64>,
    pub offset:  Option<i64>,
}

// ── Projects ──────────────────────────────────────────────────────────────────

pub async fn list_projects(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Query(q): Query<ListQuery>,
) -> Result<Json<Value>> {
    let limit   = q.limit.unwrap_or(50).min(200);
    let offset  = q.offset.unwrap_or(0);
    let projects = store::list_projects(
        &state.db,
        user.id,
        q.starred.unwrap_or(false),
        q.trashed.unwrap_or(false),
        limit,
        offset,
    )
    .await?;
    Ok(Json(json!({ "projects": projects })))
}

pub async fn create_project(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Json(body): Json<CreateFontProjectDto>,
) -> Result<Json<Value>> {
    let title = body.title.unwrap_or_else(|| "Police sans titre".to_string());

    let project_id = store::create_project(&state.db, user.id, &title).await?;

    // Content (metrics/glyphs/kerning) → .kbfnt file in the files module.
    let content = cf::font_content_from(cf::empty_font_data(&title));
    let file_id = cf::create_font_file(&state, user.id, &title, &content).await?;
    store::set_file_id(&state.db, project_id, file_id).await?;

    Ok(Json(json!({ "id": project_id, "title": title })))
}

pub async fn get_project(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let project = store::get_project(&state.db, id, user.id)
        .await?
        .ok_or_else(|| PaintsharpError::NotFound(id.to_string()))?;

    let mut val = serde_json::to_value(&project).unwrap_or_default();

    // Content is read from the .kbfnt file; a missing/broken file yields defaults
    // so the editor still opens.
    if let Some(fid) = project.file_id {
        let content = cf::read_content(&state, user.id, fid).await
            .unwrap_or_else(|_| cf::font_content_from(cf::empty_font_data(&project.title)));
        val["data"] = content.get("font").cloned()
            .unwrap_or_else(|| cf::empty_font_data(&project.title));

        // Title = .kbfnt file name (without extension); self-heal when renamed elsewhere.
        if let Some(fname) = cf::file_name(&state, user.id, fid).await {
            let stem = cf::strip_ext(&fname);
            if !stem.is_empty() && stem != project.title {
                store::rename_project(&state.db, id, &stem).await?;
                val["title"] = Value::String(stem);
            }
        }
    } else {
        val["data"] = cf::empty_font_data(&project.title);
    }

    Ok(Json(val))
}

pub async fn update_project(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
    Json(body): Json<UpdateFontProjectDto>,
) -> Result<Json<Value>> {
    if store::update_project(&state.db, id, user.id, &body).await? == 0 {
        return Err(PaintsharpError::NotFound(id.to_string()));
    }
    // Title changed → rename the .kbfnt file (title = file name). Best-effort.
    if let Some(t) = body.title.as_ref() {
        if !t.trim().is_empty() {
            if let Ok(fid) = store::project_file_id(&state.db, id, user.id).await {
                cf::rename_content_file(&state, user.id, fid, t, "kbfnt").await;
            }
        }
    }
    Ok(Json(json!({ "ok": true })))
}

#[derive(Debug, Deserialize)]
pub struct SaveFontDataDto {
    pub data:        Value,
    pub glyph_count: Option<i32>,
}

pub async fn save_font_data(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
    Json(body): Json<SaveFontDataDto>,
) -> Result<Json<Value>> {
    if !body.data.is_object() {
        return Err(PaintsharpError::Validation("data doit être un objet".into()));
    }

    // Write the whole font definition into the .kbfnt file.
    let file_id = store::project_file_id(&state.db, id, user.id).await?;
    let content = cf::font_content_from(body.data);
    cf::write_content(&state, user.id, file_id, &content).await?;

    store::save_glyphs(&state.db, id, user.id, body.glyph_count).await?;

    Ok(Json(json!({ "ok": true })))
}

pub async fn trash_project(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    if store::trash_project(&state.db, id, user.id).await? == 0 {
        return Err(PaintsharpError::NotFound(id.to_string()));
    }
    Ok(Json(json!({ "ok": true })))
}

pub async fn restore_project(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    store::restore_project(&state.db, id, user.id).await?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn delete_project(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    // See scenes::delete — the Drive file must go with the row.
    let Some(file_id) = crate::services::store::delete_trashed_returning_file_id(
        &state.db, "paintsharp.font_projects", id, user.id,
    )
    .await?
    else {
        return Err(PaintsharpError::NotFound(id.to_string()));
    };
    cf::delete_entity_files(&state, user.id, file_id).await;
    Ok(Json(json!({ "ok": true })))
}

pub async fn duplicate_project(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let source = store::get_active_project(&state.db, id, user.id)
        .await?
        .ok_or_else(|| PaintsharpError::NotFound(id.to_string()))?;

    let source_content = match source.file_id {
        Some(fid) => cf::read_content(&state, user.id, fid).await
            .unwrap_or_else(|_| cf::font_content_from(cf::empty_font_data(&source.title))),
        None => cf::font_content_from(cf::empty_font_data(&source.title)),
    };

    let new_title = format!("{} (copie)", source.title);
    let new_id = store::create_project_full(
        &state.db,
        user.id,
        &new_title,
        source.glyph_count,
        source.thumbnail_path.as_deref(),
    )
    .await?;

    let new_file_id = cf::create_font_file(&state, user.id, &new_title, &source_content).await?;
    store::set_file_id(&state.db, new_id, new_file_id).await?;

    Ok(Json(json!({ "id": new_id })))
}

#[derive(Debug, Deserialize)]
pub struct OpenByFileDto { pub file_id: Uuid }

/// Opens the entity linked to a .kbfnt file — used by StartPage / "open with".
pub async fn open_by_file(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Json(dto): Json<OpenByFileDto>,
) -> Result<Json<Value>> {
    let id = store::find_by_file(&state.db, dto.file_id, user.id)
        .await?
        .ok_or_else(|| PaintsharpError::NotFound(format!("Aucun projet lié au fichier {}", dto.file_id)))?;
    Ok(Json(json!({ "id": id })))
}
