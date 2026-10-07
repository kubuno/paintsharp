use axum::{extract::{Path, Query, State}, Extension, Json};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    errors::{PaintsharpError, Result},
    middleware::PaintsharpUser,
    models::vector::{
        CreateVectorPageDto, CreateVectorProjectDto, UpdateVectorPageDto, UpdateVectorProjectDto,
    },
    services::content_files as cf,
    services::store::vectors as store,
    state::AppState,
};

#[derive(Debug, Deserialize)]
pub struct ListQuery {
    pub starred: Option<bool>,
    pub trashed: Option<bool>,
    pub limit:   Option<i64>,
    pub offset:  Option<i64>,
}

/// Ensures a project is live and owned; `NotFound` otherwise.
async fn require_project_owner(state: &AppState, project_id: Uuid, user_id: Uuid) -> Result<()> {
    if !store::check_project_owner(&state.db, project_id, user_id).await? {
        return Err(PaintsharpError::NotFound(project_id.to_string()));
    }
    Ok(())
}

// ── Projets ───────────────────────────────────────────────────────────────────

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
    Json(body): Json<CreateVectorProjectDto>,
) -> Result<Json<Value>> {
    let title = body.title.unwrap_or_else(|| "Projet sans titre".to_string());

    let (project_id, page_id) = store::create_project(&state.db, user.id, &title).await?;

    // Contenu (artboards/elements/guides) → fichier .kbvector dans files.
    let file_id = cf::create_vector_content_file(&state, user.id, &title, page_id, cf::empty_vector_page()).await?;
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

    let pages = store::list_page_summaries(&state.db, id).await?;

    let mut val = serde_json::to_value(&project).unwrap_or_default();
    val["pages"] = serde_json::to_value(&pages).unwrap_or_default();
    // Titre = nom du fichier .kbvec (sans extension) ; self-heal si renommé ailleurs.
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

pub async fn update_project(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
    Json(body): Json<UpdateVectorProjectDto>,
) -> Result<Json<Value>> {
    if store::update_project(&state.db, id, user.id, &body).await? == 0 {
        return Err(PaintsharpError::NotFound(id.to_string()));
    }
    // Titre modifié → renommer le fichier .kbvec (titre = nom). Best-effort.
    if let Some(t) = body.title.as_ref() {
        if !t.trim().is_empty() {
            if let Ok(fid) = store::project_file_id(&state.db, id, user.id).await {
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
        &state.db, "paintsharp.vector_projects", id, user.id,
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

    let pages = store::list_pages(&state.db, id).await?;

    // Contenu source (depuis le fichier) pour récupérer les données par page.
    let source_content = match source.file_id {
        Some(fid) => cf::read_content(&state, user.id, fid).await.unwrap_or_else(|_| json!({ "version": 1, "pages": {} })),
        None      => json!({ "version": 1, "pages": {} }),
    };

    let new_title = format!("{} (copie)", source.title);
    let new_id = store::create_project_with_settings(&state.db, user.id, &new_title, &source.settings).await?;

    // Recrée les pages (nouvelles métadonnées) et reconstruit le contenu avec les
    // nouveaux ids.
    let mut new_content = json!({ "version": 1, "pages": {} });
    for page in &pages {
        let new_page_id = store::create_page(&state.db, new_id, &page.name, page.position).await?;
        let data = cf::get_page_data(&source_content, page.id);
        cf::set_page_data(&mut new_content, new_page_id, data);
    }

    let new_file_id = cf::create_vector_file(&state, user.id, &new_title, &new_content).await?;
    store::set_file_id(&state.db, new_id, new_file_id).await?;

    Ok(Json(json!({ "id": new_id })))
}

// ── Pages ─────────────────────────────────────────────────────────────────────

pub async fn list_pages(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(project_id): Path<Uuid>,
) -> Result<Json<Value>> {
    require_project_owner(&state, project_id, user.id).await?;
    let pages = store::list_pages(&state.db, project_id).await?;
    Ok(Json(json!({ "pages": pages })))
}

pub async fn create_page(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(project_id): Path<Uuid>,
    Json(body): Json<CreateVectorPageDto>,
) -> Result<Json<Value>> {
    require_project_owner(&state, project_id, user.id).await?;

    let name = body.name.unwrap_or_else(|| "Plan de travail".to_string());
    let pos = store::next_page_position(&state.db, project_id).await?;
    let id = store::create_page(&state.db, project_id, &name, pos).await?;

    // Contenu par défaut de la nouvelle page → fichier.
    let file_id = store::project_file_id(&state.db, project_id, user.id).await?;
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
    require_project_owner(&state, project_id, user.id).await?;

    let page = store::get_page(&state.db, page_id, project_id)
        .await?
        .ok_or_else(|| PaintsharpError::NotFound(page_id.to_string()))?;

    // Contenu lu depuis le fichier .kbvector.
    let file_id = store::project_file_id(&state.db, project_id, user.id).await?;
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
    require_project_owner(&state, project_id, user.id).await?;

    // Écrit le contenu de la page dans le fichier.
    let file_id = store::project_file_id(&state.db, project_id, user.id).await?;
    let mut content = cf::read_content(&state, user.id, file_id).await?;
    cf::set_page_data(&mut content, page_id, data);
    cf::write_content(&state, user.id, file_id, &content).await?;

    store::touch_project(&state.db, project_id, user.id).await?;

    Ok(Json(json!({ "ok": true })))
}

pub async fn rename_page(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path((project_id, page_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<UpdateVectorPageDto>,
) -> Result<Json<Value>> {
    require_project_owner(&state, project_id, user.id).await?;

    if let Some(name) = &body.name {
        store::rename_page(&state.db, page_id, project_id, name).await?;
    }
    Ok(Json(json!({ "ok": true })))
}

pub async fn delete_page(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path((project_id, page_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<Value>> {
    require_project_owner(&state, project_id, user.id).await?;

    if store::page_count(&state.db, project_id).await? <= 1 {
        return Err(PaintsharpError::Validation("Impossible de supprimer la dernière page".into()));
    }

    store::delete_page(&state.db, page_id, project_id).await?;

    // Retire aussi le contenu de la page du fichier.
    if let Ok(file_id) = store::project_file_id(&state.db, project_id, user.id).await {
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
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Json(dto): Json<OpenByFileDto>,
) -> Result<Json<Value>> {
    let id = store::find_by_file(&state.db, dto.file_id, user.id)
        .await?
        .ok_or_else(|| PaintsharpError::NotFound(format!("Aucun projet lié au fichier {}", dto.file_id)))?;
    Ok(Json(json!({ "id": id })))
}

// ── Raster → vector tracing (visioncortex engine) ─────────────────────────────

#[derive(Debug, Deserialize)]
pub struct TraceDto {
    /// Image as a data URL (`data:image/png;base64,…`) or raw base64.
    pub image: String,
    // VTracer-style knobs; every field optional, defaults = VTracer defaults.
    pub color_mode:       Option<String>,   // "color" | "binary"
    pub hierarchical:     Option<String>,   // "stacked" | "cutout"
    pub mode:             Option<String>,   // "spline" | "polygon" | "pixel"
    pub filter_speckle:   Option<usize>,    // 0..=64
    pub color_precision:  Option<i32>,      // 1..=8
    pub layer_difference: Option<i32>,      // 0..=128
    pub corner_threshold: Option<i32>,      // 0..=180 (deg)
    pub length_threshold: Option<f64>,      // 3.5..=10
    pub splice_threshold: Option<i32>,      // 0..=180 (deg)
}

/// Longest image side the tracer will accept — larger inputs are downscaled by
/// the client; anything bigger than this is a mistake and gets refused instead
/// of pinning a worker thread for minutes.
const TRACE_MAX_SIDE: u32 = 3000;

pub async fn trace_image(
    Extension(_user): Extension<PaintsharpUser>,
    Json(dto): Json<TraceDto>,
) -> Result<Json<Value>> {
    use crate::services::vtrace;

    // Strip a data-URL header if present, then decode.
    let b64 = dto.image.rsplit(',').next().unwrap_or(&dto.image).trim();
    let bytes = {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|_| PaintsharpError::Validation("image: base64 invalide".into()))?
    };

    let mut cfg = vtrace::Config::default();
    if let Some(v) = dto.color_mode.as_deref() {
        cfg.color_mode = match v {
            "color" => vtrace::ColorMode::Color,
            "binary" => vtrace::ColorMode::Binary,
            _ => return Err(PaintsharpError::Validation("color_mode".into())),
        };
    }
    if let Some(v) = dto.hierarchical.as_deref() {
        cfg.hierarchical = match v {
            "stacked" => vtrace::Hierarchical::Stacked,
            "cutout" => vtrace::Hierarchical::Cutout,
            _ => return Err(PaintsharpError::Validation("hierarchical".into())),
        };
    }
    if let Some(v) = dto.mode.as_deref() {
        use visioncortex::PathSimplifyMode as M;
        cfg.mode = match v {
            "spline" => M::Spline,
            "polygon" => M::Polygon,
            "pixel" => M::None,
            _ => return Err(PaintsharpError::Validation("mode".into())),
        };
    }
    if let Some(v) = dto.filter_speckle   { cfg.filter_speckle   = v.min(64); }
    if let Some(v) = dto.color_precision  { cfg.color_precision  = v.clamp(1, 8); }
    if let Some(v) = dto.layer_difference { cfg.layer_difference = v.clamp(0, 128); }
    if let Some(v) = dto.corner_threshold { cfg.corner_threshold = v.clamp(0, 180); }
    if let Some(v) = dto.length_threshold { cfg.length_threshold = v.clamp(3.5, 10.0); }
    if let Some(v) = dto.splice_threshold { cfg.splice_threshold = v.clamp(0, 180); }

    // Decode + trace on a blocking thread: both are CPU-bound.
    let svg = tokio::task::spawn_blocking(move || -> std::result::Result<String, String> {
        let img = image::load_from_memory(&bytes).map_err(|e| format!("image illisible: {e}"))?;
        let (w, h) = (img.width(), img.height());
        if w == 0 || h == 0 {
            return Err("image vide".into());
        }
        if w.max(h) > TRACE_MAX_SIDE {
            return Err(format!("image trop grande ({w}×{h}, max {TRACE_MAX_SIDE}px)"));
        }
        let rgba = img.to_rgba8();
        let color_image = visioncortex::ColorImage {
            pixels: rgba.as_raw().to_vec(),
            width: w as usize,
            height: h as usize,
        };
        Ok(vtrace::convert(color_image, cfg)?.to_svg())
    })
    .await
    .map_err(|e| PaintsharpError::Internal(anyhow::anyhow!("trace: {e}")))?
    .map_err(PaintsharpError::Validation)?;

    Ok(Json(json!({ "svg": svg })))
}
