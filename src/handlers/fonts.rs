use axum::{extract::{Path, Query, State}, Extension, Json};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    errors::{PaintsharpError, Result},
    middleware::PaintsharpUser,
    models::font::{CreateFontProjectDto, FontProject, FontProjectSummary, UpdateFontProjectDto},
    services::content_files as cf,
    state::AppState,
};

/// file_id of a project's content file (error when missing).
async fn project_file_id(state: &AppState, project_id: Uuid, user_id: Uuid) -> Result<Uuid> {
    let fid: Option<Uuid> = sqlx::query_scalar(
        "SELECT file_id FROM font_projects WHERE id = $1 AND owner_id = $2 AND is_trashed = FALSE",
    )
    .bind(project_id).bind(user_id)
    .fetch_optional(&state.db).await?
    .ok_or_else(|| PaintsharpError::NotFound(project_id.to_string()))?;
    fid.ok_or_else(|| PaintsharpError::Internal(anyhow::anyhow!("projet sans fichier de contenu")))
}

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
    let trashed = q.trashed.unwrap_or(false);
    let starred = q.starred.unwrap_or(false);

    const COLS: &str = "id, owner_id, title, thumbnail_path, glyph_count, is_starred, updated_at, created_at";

    let projects = if starred {
        sqlx::query_as::<_, FontProjectSummary>(&format!(
            "SELECT {COLS} FROM font_projects
             WHERE owner_id = $1 AND is_starred = TRUE AND is_trashed = FALSE
             ORDER BY updated_at DESC LIMIT $2 OFFSET $3",
        ))
        .bind(user.id).bind(limit).bind(offset)
        .fetch_all(&state.db).await?
    } else if trashed {
        sqlx::query_as::<_, FontProjectSummary>(&format!(
            "SELECT {COLS} FROM font_projects
             WHERE owner_id = $1 AND is_trashed = TRUE
             ORDER BY trashed_at DESC LIMIT $2 OFFSET $3",
        ))
        .bind(user.id).bind(limit).bind(offset)
        .fetch_all(&state.db).await?
    } else {
        sqlx::query_as::<_, FontProjectSummary>(&format!(
            "SELECT {COLS} FROM font_projects
             WHERE owner_id = $1 AND is_trashed = FALSE
             ORDER BY updated_at DESC LIMIT $2 OFFSET $3",
        ))
        .bind(user.id).bind(limit).bind(offset)
        .fetch_all(&state.db).await?
    };

    Ok(Json(json!({ "projects": projects })))
}

pub async fn create_project(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Json(body): Json<CreateFontProjectDto>,
) -> Result<Json<Value>> {
    let title = body.title.unwrap_or_else(|| "Police sans titre".to_string());

    let project_id: Uuid = sqlx::query_scalar(
        "INSERT INTO font_projects (owner_id, title) VALUES ($1, $2) RETURNING id",
    )
    .bind(user.id).bind(&title)
    .fetch_one(&state.db).await?;

    // Content (metrics/glyphs/kerning) → .kbfnt file in the files module.
    let content = cf::font_content_from(cf::empty_font_data(&title));
    let file_id = cf::create_font_file(&state, user.id, &title, &content).await?;
    sqlx::query("UPDATE font_projects SET file_id = $1 WHERE id = $2")
        .bind(file_id).bind(project_id).execute(&state.db).await?;

    Ok(Json(json!({ "id": project_id, "title": title })))
}

pub async fn get_project(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let project = sqlx::query_as::<_, FontProject>(
        "SELECT * FROM font_projects WHERE id = $1 AND owner_id = $2",
    )
    .bind(id).bind(user.id)
    .fetch_optional(&state.db).await?
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
                sqlx::query("UPDATE font_projects SET title = $2 WHERE id = $1")
                    .bind(id).bind(&stem).execute(&state.db).await?;
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
    let rows = sqlx::query(
        "UPDATE font_projects SET
            title          = COALESCE($3, title),
            thumbnail_path = COALESCE($4, thumbnail_path),
            is_starred     = COALESCE($5, is_starred),
            last_edited_by = $2
         WHERE id = $1 AND owner_id = $2",
    )
    .bind(id).bind(user.id)
    .bind(&body.title)
    .bind(&body.thumbnail_path)
    .bind(body.is_starred)
    .execute(&state.db).await?.rows_affected();

    if rows == 0 {
        return Err(PaintsharpError::NotFound(id.to_string()));
    }
    // Title changed → rename the .kbfnt file (title = file name). Best-effort.
    if let Some(t) = body.title.as_ref() {
        if !t.trim().is_empty() {
            if let Ok(fid) = project_file_id(&state, id, user.id).await {
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
    let file_id = project_file_id(&state, id, user.id).await?;
    let content = cf::font_content_from(body.data);
    cf::write_content(&state, user.id, file_id, &content).await?;

    sqlx::query(
        "UPDATE font_projects SET glyph_count = COALESCE($3, glyph_count), last_edited_by = $2
         WHERE id = $1 AND owner_id = $2",
    )
    .bind(id).bind(user.id).bind(body.glyph_count)
    .execute(&state.db).await?;

    Ok(Json(json!({ "ok": true })))
}

pub async fn trash_project(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let rows = sqlx::query(
        "UPDATE font_projects SET is_trashed = TRUE, trashed_at = NOW()
         WHERE id = $1 AND owner_id = $2 AND is_trashed = FALSE",
    )
    .bind(id).bind(user.id)
    .execute(&state.db).await?.rows_affected();

    if rows == 0 { return Err(PaintsharpError::NotFound(id.to_string())); }
    Ok(Json(json!({ "ok": true })))
}

pub async fn restore_project(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    sqlx::query(
        "UPDATE font_projects SET is_trashed = FALSE, trashed_at = NULL
         WHERE id = $1 AND owner_id = $2",
    )
    .bind(id).bind(user.id)
    .execute(&state.db).await?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn delete_project(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let rows = sqlx::query(
        "DELETE FROM font_projects WHERE id = $1 AND owner_id = $2 AND is_trashed = TRUE",
    )
    .bind(id).bind(user.id)
    .execute(&state.db).await?.rows_affected();

    if rows == 0 { return Err(PaintsharpError::NotFound(id.to_string())); }
    Ok(Json(json!({ "ok": true })))
}

pub async fn duplicate_project(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let source: FontProject = sqlx::query_as::<_, FontProject>(
        "SELECT * FROM font_projects WHERE id = $1 AND owner_id = $2 AND is_trashed = FALSE",
    )
    .bind(id).bind(user.id)
    .fetch_optional(&state.db).await?
    .ok_or_else(|| PaintsharpError::NotFound(id.to_string()))?;

    let source_content = match source.file_id {
        Some(fid) => cf::read_content(&state, user.id, fid).await
            .unwrap_or_else(|_| cf::font_content_from(cf::empty_font_data(&source.title))),
        None => cf::font_content_from(cf::empty_font_data(&source.title)),
    };

    let new_title = format!("{} (copie)", source.title);
    let new_id: Uuid = sqlx::query_scalar(
        "INSERT INTO font_projects (owner_id, title, glyph_count, thumbnail_path)
         VALUES ($1, $2, $3, $4) RETURNING id",
    )
    .bind(user.id).bind(&new_title).bind(source.glyph_count).bind(&source.thumbnail_path)
    .fetch_one(&state.db).await?;

    let new_file_id = cf::create_font_file(&state, user.id, &new_title, &source_content).await?;
    sqlx::query("UPDATE font_projects SET file_id = $1 WHERE id = $2")
        .bind(new_file_id).bind(new_id).execute(&state.db).await?;

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
    let id: Uuid = sqlx::query_scalar(
        "SELECT id FROM paintsharp.font_projects WHERE file_id = $1 AND owner_id = $2 AND is_trashed = FALSE",
    )
    .bind(dto.file_id).bind(user.id)
    .fetch_optional(&state.db).await?
    .ok_or_else(|| PaintsharpError::NotFound(format!("Aucun projet lié au fichier {}", dto.file_id)))?;
    Ok(Json(json!({ "id": id })))
}
