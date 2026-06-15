use axum::{extract::{Path, Query, State}, Extension, Json};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    errors::{PaintsharpError, Result},
    middleware::PaintsharpUser,
    models::vector::{
        CreateVectorPageDto, CreateVectorProjectDto,
        UpdateVectorPageDto, UpdateVectorProjectDto,
        VectorPage, VectorPageSummary, VectorProject, VectorProjectSummary,
    },
    services::content_files as cf,
    state::AppState,
};

/// file_id du fichier de contenu d'un projet (erreur si absent).
async fn project_file_id(state: &AppState, project_id: Uuid, user_id: Uuid) -> Result<Uuid> {
    let fid: Option<Uuid> = sqlx::query_scalar(
        "SELECT file_id FROM vector_projects WHERE id = $1 AND owner_id = $2 AND is_trashed = FALSE",
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

// ── Projets ───────────────────────────────────────────────────────────────────

pub async fn list_projects(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Query(q): Query<ListQuery>,
) -> Result<Json<Value>> {
    let limit   = q.limit.unwrap_or(50).min(200);
    let offset  = q.offset.unwrap_or(0);
    let trashed = q.trashed.unwrap_or(false);
    let starred = q.starred.unwrap_or(false);

    let projects = if starred {
        sqlx::query_as::<_, VectorProjectSummary>(
            "SELECT id, owner_id, title, thumbnail_path, is_starred, updated_at, created_at
             FROM vector_projects
             WHERE owner_id = $1 AND is_starred = TRUE AND is_trashed = FALSE
             ORDER BY updated_at DESC LIMIT $2 OFFSET $3",
        )
        .bind(user.id).bind(limit).bind(offset)
        .fetch_all(&state.db).await?
    } else if trashed {
        sqlx::query_as::<_, VectorProjectSummary>(
            "SELECT id, owner_id, title, thumbnail_path, is_starred, updated_at, created_at
             FROM vector_projects
             WHERE owner_id = $1 AND is_trashed = TRUE
             ORDER BY trashed_at DESC LIMIT $2 OFFSET $3",
        )
        .bind(user.id).bind(limit).bind(offset)
        .fetch_all(&state.db).await?
    } else {
        sqlx::query_as::<_, VectorProjectSummary>(
            "SELECT id, owner_id, title, thumbnail_path, is_starred, updated_at, created_at
             FROM vector_projects
             WHERE owner_id = $1 AND is_trashed = FALSE
             ORDER BY updated_at DESC LIMIT $2 OFFSET $3",
        )
        .bind(user.id).bind(limit).bind(offset)
        .fetch_all(&state.db).await?
    };

    Ok(Json(json!({ "projects": projects })))
}

pub async fn create_project(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Json(body): Json<CreateVectorProjectDto>,
) -> Result<Json<Value>> {
    let title = body.title.unwrap_or_else(|| "Projet sans titre".to_string());

    let mut tx = state.db.begin().await?;

    let project_id: Uuid = sqlx::query_scalar(
        "INSERT INTO vector_projects (owner_id, title) VALUES ($1, $2) RETURNING id",
    )
    .bind(user.id).bind(&title)
    .fetch_one(&mut *tx).await?;

    // Première page (métadonnée seulement — le contenu va dans le fichier).
    let page_id: Uuid = sqlx::query_scalar(
        "INSERT INTO vector_pages (project_id, name, position)
         VALUES ($1, 'Plan de travail 1', 0) RETURNING id",
    )
    .bind(project_id)
    .fetch_one(&mut *tx).await?;

    tx.commit().await?;

    // Contenu (artboards/elements/guides) → fichier .kbvector dans files.
    let file_id = cf::create_vector_content_file(&state, user.id, &title, page_id, cf::empty_vector_page()).await?;
    sqlx::query("UPDATE vector_projects SET file_id = $1 WHERE id = $2")
        .bind(file_id).bind(project_id).execute(&state.db).await?;

    Ok(Json(json!({ "id": project_id, "title": title })))
}

pub async fn get_project(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let project = sqlx::query_as::<_, crate::models::vector::VectorProject>(
        "SELECT * FROM vector_projects WHERE id = $1 AND owner_id = $2",
    )
    .bind(id).bind(user.id)
    .fetch_optional(&state.db).await?
    .ok_or_else(|| PaintsharpError::NotFound(id.to_string()))?;

    let pages = sqlx::query_as::<_, VectorPageSummary>(
        "SELECT id, name, position FROM vector_pages
         WHERE project_id = $1 ORDER BY position",
    )
    .bind(id)
    .fetch_all(&state.db).await?;

    let mut val = serde_json::to_value(&project).unwrap_or_default();
    val["pages"] = serde_json::to_value(&pages).unwrap_or_default();
    // Titre = nom du fichier .kbvec (sans extension) ; self-heal si renommé ailleurs.
    if let Some(fid) = project.file_id {
        if let Some(fname) = cf::file_name(&state, user.id, fid).await {
            let stem = cf::strip_ext(&fname);
            if !stem.is_empty() && stem != project.title {
                sqlx::query("UPDATE vector_projects SET title = $2 WHERE id = $1")
                    .bind(id).bind(&stem).execute(&state.db).await?;
                val["title"] = Value::String(stem);
            }
        }
    }
    Ok(Json(val))
}

pub async fn update_project(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
    Json(body): Json<UpdateVectorProjectDto>,
) -> Result<Json<Value>> {
    let rows = sqlx::query(
        "UPDATE vector_projects SET
            title          = COALESCE($3, title),
            settings       = COALESCE($4, settings),
            thumbnail_path = COALESCE($5, thumbnail_path),
            is_starred     = COALESCE($6, is_starred),
            last_edited_by = $2
         WHERE id = $1 AND owner_id = $2",
    )
    .bind(id).bind(user.id)
    .bind(&body.title)
    .bind(&body.settings)
    .bind(&body.thumbnail_path)
    .bind(body.is_starred)
    .execute(&state.db).await?.rows_affected();

    if rows == 0 {
        return Err(PaintsharpError::NotFound(id.to_string()));
    }
    // Titre modifié → renommer le fichier .kbvec (titre = nom). Best-effort.
    if let Some(t) = body.title.as_ref() {
        if !t.trim().is_empty() {
            if let Ok(fid) = project_file_id(&state, id, user.id).await {
                cf::rename_content_file(&state, user.id, fid, t, "kbvec").await;
            }
        }
    }
    Ok(Json(json!({ "ok": true })))
}

pub async fn trash_project(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let rows = sqlx::query(
        "UPDATE vector_projects SET is_trashed = TRUE, trashed_at = NOW()
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
        "UPDATE vector_projects SET is_trashed = FALSE, trashed_at = NULL
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
        "DELETE FROM vector_projects WHERE id = $1 AND owner_id = $2 AND is_trashed = TRUE",
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
    let source: VectorProject = sqlx::query_as::<_, VectorProject>(
        "SELECT * FROM vector_projects WHERE id = $1 AND owner_id = $2 AND is_trashed = FALSE",
    )
    .bind(id).bind(user.id)
    .fetch_optional(&state.db).await?
    .ok_or_else(|| PaintsharpError::NotFound(id.to_string()))?;

    let pages: Vec<VectorPage> = sqlx::query_as::<_, VectorPage>(
        "SELECT * FROM vector_pages WHERE project_id = $1 ORDER BY position",
    )
    .bind(id)
    .fetch_all(&state.db).await?;

    // Contenu source (depuis le fichier) pour récupérer les données par page.
    let source_content = match source.file_id {
        Some(fid) => cf::read_content(&state, user.id, fid).await.unwrap_or_else(|_| json!({ "version": 1, "pages": {} })),
        None      => json!({ "version": 1, "pages": {} }),
    };

    let new_title = format!("{} (copie)", source.title);
    let new_id: Uuid = sqlx::query_scalar(
        "INSERT INTO vector_projects (owner_id, title, settings) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(user.id).bind(&new_title).bind(&source.settings)
    .fetch_one(&state.db).await?;

    // Recrée les pages (nouvelles métadonnées) et reconstruit le contenu avec les
    // nouveaux ids.
    let mut new_content = json!({ "version": 1, "pages": {} });
    for page in &pages {
        let new_page_id: Uuid = sqlx::query_scalar(
            "INSERT INTO vector_pages (project_id, name, position) VALUES ($1, $2, $3) RETURNING id",
        )
        .bind(new_id).bind(&page.name).bind(page.position)
        .fetch_one(&state.db).await?;
        let data = cf::get_page_data(&source_content, page.id);
        cf::set_page_data(&mut new_content, new_page_id, data);
    }

    let new_file_id = cf::create_vector_file(&state, user.id, &new_title, &new_content).await?;
    sqlx::query("UPDATE vector_projects SET file_id = $1 WHERE id = $2")
        .bind(new_file_id).bind(new_id).execute(&state.db).await?;

    Ok(Json(json!({ "id": new_id })))
}

// ── Pages ─────────────────────────────────────────────────────────────────────

async fn check_project_owner(
    db: &sqlx::PgPool,
    project_id: Uuid,
    user_id: Uuid,
) -> Result<()> {
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM vector_projects WHERE id = $1 AND owner_id = $2 AND is_trashed = FALSE)",
    )
    .bind(project_id).bind(user_id)
    .fetch_one(db).await?;
    if !exists { return Err(PaintsharpError::NotFound(project_id.to_string())); }
    Ok(())
}

pub async fn list_pages(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(project_id): Path<Uuid>,
) -> Result<Json<Value>> {
    check_project_owner(&state.db, project_id, user.id).await?;

    let pages = sqlx::query_as::<_, VectorPage>(
        "SELECT * FROM vector_pages WHERE project_id = $1 ORDER BY position",
    )
    .bind(project_id)
    .fetch_all(&state.db).await?;

    Ok(Json(json!({ "pages": pages })))
}

pub async fn create_page(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(project_id): Path<Uuid>,
    Json(body): Json<CreateVectorPageDto>,
) -> Result<Json<Value>> {
    check_project_owner(&state.db, project_id, user.id).await?;

    let name = body.name.unwrap_or_else(|| "Plan de travail".to_string());
    // `position` est INTEGER (int4) → décoder en i32 (un i64 provoque un mismatch
    // sqlx → 500 DATABASE_ERROR, qui empêchait l'ajout de plans de travail).
    let pos: i32 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(position), -1) + 1 FROM vector_pages WHERE project_id = $1",
    )
    .bind(project_id)
    .fetch_one(&state.db).await?;

    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO vector_pages (project_id, name, position) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(project_id).bind(&name).bind(pos)
    .fetch_one(&state.db).await?;

    // Contenu par défaut de la nouvelle page → fichier.
    let file_id = project_file_id(&state, project_id, user.id).await?;
    let mut content = cf::read_content(&state, user.id, file_id).await?;
    cf::set_page_data(&mut content, id, cf::empty_vector_page());
    cf::write_content(&state, user.id, file_id, &content).await?;

    Ok(Json(json!({ "id": id, "name": name, "position": pos })))
}

pub async fn get_page(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path((project_id, page_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>> {
    check_project_owner(&state.db, project_id, user.id).await?;

    let page = sqlx::query_as::<_, VectorPage>(
        "SELECT * FROM vector_pages WHERE id = $1 AND project_id = $2",
    )
    .bind(page_id).bind(project_id)
    .fetch_optional(&state.db).await?
    .ok_or_else(|| PaintsharpError::NotFound(page_id.to_string()))?;

    // Contenu lu depuis le fichier .kbvector.
    let file_id = project_file_id(&state, project_id, user.id).await?;
    let content = cf::read_content(&state, user.id, file_id).await?;
    let data    = cf::get_page_data(&content, page_id);

    let mut val = serde_json::to_value(&page).unwrap_or_default();
    val["data"] = data;
    Ok(Json(val))
}

pub async fn save_page_data(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path((project_id, page_id)): Path<(Uuid, Uuid)>,
    Json(data): Json<Value>,
) -> Result<Json<Value>> {
    check_project_owner(&state.db, project_id, user.id).await?;

    // Écrit le contenu de la page dans le fichier.
    let file_id = project_file_id(&state, project_id, user.id).await?;
    let mut content = cf::read_content(&state, user.id, file_id).await?;
    cf::set_page_data(&mut content, page_id, data);
    cf::write_content(&state, user.id, file_id, &content).await?;

    sqlx::query("UPDATE vector_projects SET last_edited_by = $2 WHERE id = $1")
        .bind(project_id).bind(user.id)
        .execute(&state.db).await?;

    Ok(Json(json!({ "ok": true })))
}

pub async fn rename_page(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path((project_id, page_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<UpdateVectorPageDto>,
) -> Result<Json<Value>> {
    check_project_owner(&state.db, project_id, user.id).await?;

    if let Some(name) = &body.name {
        sqlx::query(
            "UPDATE vector_pages SET name = $3 WHERE id = $1 AND project_id = $2",
        )
        .bind(page_id).bind(project_id).bind(name)
        .execute(&state.db).await?;
    }
    Ok(Json(json!({ "ok": true })))
}

pub async fn delete_page(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path((project_id, page_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>> {
    check_project_owner(&state.db, project_id, user.id).await?;

    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM vector_pages WHERE project_id = $1",
    )
    .bind(project_id)
    .fetch_one(&state.db).await?;

    if count <= 1 {
        return Err(PaintsharpError::Validation("Impossible de supprimer la dernière page".into()));
    }

    sqlx::query(
        "DELETE FROM vector_pages WHERE id = $1 AND project_id = $2",
    )
    .bind(page_id).bind(project_id)
    .execute(&state.db).await?;

    // Retire aussi le contenu de la page du fichier.
    if let Ok(file_id) = project_file_id(&state, project_id, user.id).await {
        if let Ok(mut content) = cf::read_content(&state, user.id, file_id).await {
            cf::remove_page_data(&mut content, page_id);
            let _ = cf::write_content(&state, user.id, file_id, &content).await;
        }
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
        "SELECT id FROM paintsharp.vector_projects WHERE file_id = $1 AND owner_id = $2 AND is_trashed = FALSE",
    )
    .bind(dto.file_id).bind(user.id)
    .fetch_optional(&state.db).await?
    .ok_or_else(|| crate::errors::PaintsharpError::NotFound(format!("Aucun projet lié au fichier {}", dto.file_id)))?;
    Ok(axum::Json(serde_json::json!({ "id": id })))
}
