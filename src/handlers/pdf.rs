use std::path::PathBuf;

use anyhow::anyhow;
use axum::{
    body::Body,
    extract::{Multipart, Path, Query, State},
    http::{header, Response, StatusCode},
    Extension, Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    errors::{PaintsharpError, Result},
    middleware::PaintsharpUser,
    models::pdf::{
        AddPageDto, CreatePdfDocumentDto, CreateSignatureDto, SavePageDto, UpdatePdfDocumentDto,
    },
    services::content_files as cf,
    services::store::pdf as store,
    state::AppState,
};

/// Ensures a live document is owned; `NotFound` otherwise.
async fn require_owner(state: &AppState, doc_id: Uuid, user_id: Uuid) -> Result<()> {
    if !store::check_owner(&state.db, doc_id, user_id).await? {
        return Err(PaintsharpError::NotFound(doc_id.to_string()));
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct ListQuery {
    pub starred: Option<bool>,
    pub trashed: Option<bool>,
    pub limit:   Option<i64>,
    pub offset:  Option<i64>,
}

// ── Documents ─────────────────────────────────────────────────────────────────

pub async fn list_documents(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Query(q): Query<ListQuery>,
) -> Result<Json<Value>> {
    let limit   = q.limit.unwrap_or(50).min(200);
    let offset  = q.offset.unwrap_or(0);
    let documents = store::list_documents(
        &state.db,
        user.id,
        q.starred.unwrap_or(false),
        q.trashed.unwrap_or(false),
        limit,
        offset,
    )
    .await?;
    Ok(Json(json!({ "documents": documents })))
}

pub async fn create_document(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Json(body): Json<CreatePdfDocumentDto>,
) -> Result<Json<Value>> {
    let title      = body.title.unwrap_or_else(|| "Document sans titre".to_string());
    let page_count = body.page_count.unwrap_or(1).max(1);
    let width      = body.width.unwrap_or(595.28);
    let height     = body.height.unwrap_or(841.89);

    let (doc_id, page_ids) = store::create_document(&state.db, user.id, &title, page_count, width, height).await?;

    let mut content = json!({ "version": 1, "pages": {} });
    for page_id in page_ids {
        cf::set_pdf_page(&mut content, page_id, cf::empty_pdf_page());
    }

    // Contenu (annotations/form_data) → fichier .kbpdf.
    let file_id = cf::create_pdf_file(&state, user.id, &title, &content).await?;
    store::set_file_id(&state.db, doc_id, file_id).await?;

    Ok(Json(json!({ "id": doc_id, "title": title, "page_count": page_count })))
}

pub async fn get_document(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let doc = store::get_document(&state.db, id, user.id)
        .await?
        .ok_or_else(|| PaintsharpError::NotFound(id.to_string()))?;

    let pages = store::list_page_summaries(&state.db, id).await?;

    let mut val = serde_json::to_value(&doc).unwrap_or_default();
    val["pages"] = serde_json::to_value(&pages).unwrap_or_default();

    // Le nom du fichier .kbpdf fait foi pour le titre (géré par `files`).
    if let Some(fid) = doc.file_id {
        if let Some(fname) = cf::file_name(&state, user.id, fid).await {
            let stem = cf::strip_ext(&fname);
            if !stem.is_empty() && stem != doc.title {
                let _ = store::rename_document(&state.db, id, &stem).await;
                val["title"] = Value::String(stem);
            }
        }
    }
    Ok(Json(val))
}

pub async fn update_document(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
    Json(body): Json<UpdatePdfDocumentDto>,
) -> Result<Json<Value>> {
    let rows = store::update_document(
        &state.db,
        id,
        user.id,
        body.title.as_deref(),
        body.thumbnail_path.as_deref(),
        body.is_starred,
        body.settings.as_ref(),
    )
    .await?;

    if rows == 0 {
        return Err(PaintsharpError::NotFound(id.to_string()));
    }

    // Renomme le fichier .kbpdf pour refléter le nouveau titre.
    if let Some(t) = body.title.as_ref() {
        if !t.trim().is_empty() {
            if let Ok(fid) = store::doc_file_id(&state.db, id, user.id).await {
                cf::rename_content_file(&state, user.id, fid, t, "kbpdf").await;
            }
        }
    }
    Ok(Json(json!({ "ok": true })))
}

pub async fn trash_document(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    if store::trash_document(&state.db, id, user.id).await? == 0 {
        return Err(PaintsharpError::NotFound(id.to_string()));
    }
    Ok(Json(json!({ "ok": true })))
}

pub async fn restore_document(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    store::restore_document(&state.db, id, user.id).await?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn delete_document(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    // `source_file_id` is deliberately NOT collected: that one is the PDF the user
    // imported, which stays theirs. Only the editor's own file goes with the row —
    // keeping it would leave an orphan that no longer opens onto anything.
    let Some((source_path, file_id)) = store::delete_document(&state.db, id, user.id).await? else {
        return Err(PaintsharpError::NotFound(id.to_string()));
    };

    if let Some(path) = source_path {
        let _ = tokio::fs::remove_file(&path).await;
    }
    cf::delete_entity_files(&state, user.id, file_id).await;

    Ok(Json(json!({ "ok": true })))
}

pub async fn duplicate_document(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let source = store::get_active_document(&state.db, id, user.id)
        .await?
        .ok_or_else(|| PaintsharpError::NotFound(id.to_string()))?;

    let pages = store::list_pages(&state.db, id).await?;

    // Contenu source (annotations/form_data par page).
    let src_content = match source.file_id {
        Some(fid) => cf::read_content(&state, user.id, fid).await
            .unwrap_or_else(|_| json!({ "version": 1, "pages": {} })),
        None => json!({ "version": 1, "pages": {} }),
    };

    let new_title = format!("{} (copie)", source.title);
    let new_id = store::create_document_meta(&state.db, user.id, &new_title, source.page_count, &source.settings).await?;

    // Recrée chaque page (nouveaux ids) et remappe le contenu vers ces ids.
    let mut new_content = json!({ "version": 1, "pages": {} });
    for page in &pages {
        let new_page_id = store::create_page_full(
            &state.db,
            new_id,
            page.page_number,
            page.width,
            page.height,
            page.rotation,
            page.source_index,
        )
        .await?;
        cf::set_pdf_page(&mut new_content, new_page_id, cf::get_pdf_page(&src_content, page.id));
    }

    let new_file_id = cf::create_pdf_file(&state, user.id, &new_title, &new_content).await?;
    store::set_file_id(&state.db, new_id, new_file_id).await?;

    Ok(Json(json!({ "id": new_id })))
}

// ── Import PDF ────────────────────────────────────────────────────────────────

pub async fn import_document(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    mut multipart: Multipart,
) -> Result<Json<Value>> {
    let mut file_name = String::from("document.pdf");
    let mut title     = String::from("Document importé");
    let mut data_opt: Option<bytes::Bytes> = None;

    while let Some(field) = multipart.next_field().await.map_err(|e| {
        PaintsharpError::Validation(format!("Erreur multipart: {e}"))
    })? {
        let name = field.name().unwrap_or("").to_string();
        match name.as_str() {
            "title" => {
                title = field.text().await.unwrap_or_else(|_| "Document importé".to_string());
            }
            "file" => {
                file_name = field.file_name().unwrap_or("document.pdf").to_string();
                let data = field.bytes().await.map_err(|e| {
                    PaintsharpError::Validation(format!("Erreur lecture fichier: {e}"))
                })?;
                if data.len() as u64 > 200 * 1024 * 1024 {
                    return Err(PaintsharpError::Validation("Fichier trop volumineux (max 200 MB)".into()));
                }
                data_opt = Some(data);
            }
            _ => {}
        }
    }

    let data = data_opt.ok_or_else(|| PaintsharpError::Validation("Fichier PDF manquant".into()))?;

    if !file_name.ends_with(".pdf") && !file_name.ends_with(".PDF") {
        return Err(PaintsharpError::Validation("Seuls les fichiers PDF sont acceptés".into()));
    }

    let (doc_id, page_count) = import_pdf_bytes(&state, user.id, &title, &data, None).await?;

    Ok(Json(json!({
        "id":         doc_id,
        "title":      title,
        "page_count": page_count,
    })))
}

/// Importe un PDF (octets bruts) en document PdfWriter : écrit le PDF source, lit
/// ses métadonnées, crée le document + ses pages et le fichier `.kbpdf` associé.
/// `source_file_id` mémorise le fichier Files d'origine (None pour un upload direct)
/// afin de pouvoir ré-ouvrir le même document plutôt que de réimporter.
async fn import_pdf_bytes(
    state: &AppState,
    user_id: Uuid,
    title: &str,
    data: &[u8],
    source_file_id: Option<Uuid>,
) -> Result<(Uuid, i32)> {
    let base_dir = PathBuf::from(&state.settings.paintsharp.media_path)
        .join("pdf")
        .join(user_id.to_string());
    tokio::fs::create_dir_all(&base_dir).await.map_err(|e| {
        PaintsharpError::Internal(anyhow!("Impossible de créer le répertoire PDF: {e}"))
    })?;

    let doc_id    = Uuid::new_v4();
    let file_path = base_dir.join(format!("{doc_id}.pdf"));
    let storage_path = file_path.to_string_lossy().to_string();

    tokio::fs::write(&file_path, data).await.map_err(|e| {
        PaintsharpError::Internal(anyhow!("Erreur écriture fichier: {e}"))
    })?;

    // Lire le nombre de pages et dimensions via lopdf
    let (page_count, pages_meta) = read_pdf_metadata(data);

    let page_ids = store::import_document(
        &state.db, doc_id, user_id, title, &storage_path, page_count, source_file_id, &pages_meta,
    )
    .await?;

    let mut content = json!({ "version": 1, "pages": {} });
    for page_id in page_ids {
        cf::set_pdf_page(&mut content, page_id, cf::empty_pdf_page());
    }

    let file_id = cf::create_pdf_file(state, user_id, title, &content).await?;
    store::set_file_id(&state.db, doc_id, file_id).await?;

    Ok((doc_id, page_count))
}

// ── Source file & Export ──────────────────────────────────────────────────────

pub async fn get_source(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
) -> Result<Response<Body>> {
    let (source_path, title) = store::source_of(&state.db, id, user.id)
        .await?
        .ok_or_else(|| PaintsharpError::NotFound(id.to_string()))?;

    let path = source_path.ok_or_else(|| PaintsharpError::NotFound("Pas de fichier source".into()))?;

    let data = tokio::fs::read(&path).await.map_err(|e| {
        PaintsharpError::Internal(anyhow!("Lecture fichier PDF: {e}"))
    })?;

    let safe_name = title.replace('"', "\\\"");
    let response = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/pdf")
        .header(header::CONTENT_DISPOSITION, format!("inline; filename=\"{safe_name}.pdf\""))
        .body(Body::from(data))
        .map_err(|e| PaintsharpError::Internal(anyhow!("Build response: {e}")))?;

    Ok(response)
}

// ── Pages ─────────────────────────────────────────────────────────────────────

pub async fn list_pages(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(doc_id): Path<Uuid>,
) -> Result<Json<Value>> {
    require_owner(&state, doc_id, user.id).await?;

    let pages = store::list_pages(&state.db, doc_id).await?;

    let file_id = store::doc_file_id(&state.db, doc_id, user.id).await?;
    let content = cf::read_content(&state, user.id, file_id).await
        .unwrap_or_else(|_| json!({ "version": 1, "pages": {} }));

    let pages: Vec<Value> = pages.iter().map(|p| {
        let mut v = serde_json::to_value(p).unwrap_or_default();
        let pc = cf::get_pdf_page(&content, p.id);
        v["annotations"] = pc.get("annotations").cloned().unwrap_or_else(|| json!([]));
        v["form_data"]   = pc.get("form_data").cloned().unwrap_or_else(|| json!({}));
        v
    }).collect();

    Ok(Json(json!({ "pages": pages })))
}

pub async fn get_page(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path((doc_id, page_num)): Path<(Uuid, i32)>,
) -> Result<Json<Value>> {
    require_owner(&state, doc_id, user.id).await?;

    let page = store::get_page(&state.db, doc_id, page_num)
        .await?
        .ok_or_else(|| PaintsharpError::NotFound(format!("Page {page_num}")))?;

    let file_id = store::doc_file_id(&state.db, doc_id, user.id).await?;
    let content = cf::read_content(&state, user.id, file_id).await
        .unwrap_or_else(|_| json!({ "version": 1, "pages": {} }));
    let pc = cf::get_pdf_page(&content, page.id);

    let mut v = serde_json::to_value(&page).unwrap_or_default();
    v["annotations"] = pc.get("annotations").cloned().unwrap_or_else(|| json!([]));
    v["form_data"]   = pc.get("form_data").cloned().unwrap_or_else(|| json!({}));
    Ok(Json(v))
}

pub async fn save_page(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path((doc_id, page_num)): Path<(Uuid, i32)>,
    Json(body): Json<SavePageDto>,
) -> Result<Json<Value>> {
    require_owner(&state, doc_id, user.id).await?;

    // Only touch the stored rotation when the client actually sends one:
    // autosaves only carry annotations and must not reset a rotated page.
    let page_id = store::page_id_for(&state.db, doc_id, page_num)
        .await?
        .ok_or_else(|| PaintsharpError::NotFound(format!("Page {page_num}")))?;
    if let Some(rotation) = body.rotation {
        store::set_page_rotation(&state.db, doc_id, page_num, rotation).await?;
    }

    // annotations + form_data → fichier (clé = page_id).
    let file_id = store::doc_file_id(&state.db, doc_id, user.id).await?;
    let mut content = cf::read_content(&state, user.id, file_id).await
        .unwrap_or_else(|_| json!({ "version": 1, "pages": {} }));
    let mut pc = cf::get_pdf_page(&content, page_id);
    pc["annotations"] = body.annotations.clone();
    if let Some(fd) = &body.form_data {
        pc["form_data"] = fd.clone();
    }
    cf::set_pdf_page(&mut content, page_id, pc);
    cf::write_content(&state, user.id, file_id, &content).await?;

    store::touch_document(&state.db, doc_id, user.id).await?;

    Ok(Json(json!({ "ok": true })))
}

pub async fn add_page(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(doc_id): Path<Uuid>,
    Json(body): Json<AddPageDto>,
) -> Result<Json<Value>> {
    require_owner(&state, doc_id, user.id).await?;

    let after     = body.after.unwrap_or(0);
    let width     = body.width.unwrap_or(595.28);
    let height    = body.height.unwrap_or(841.89);

    let (page_id, new_num) = store::add_page(&state.db, doc_id, user.id, after, width, height).await?;

    let file_id = store::doc_file_id(&state.db, doc_id, user.id).await?;
    let mut content = cf::read_content(&state, user.id, file_id).await
        .unwrap_or_else(|_| json!({ "version": 1, "pages": {} }));
    cf::set_pdf_page(&mut content, page_id, cf::empty_pdf_page());
    cf::write_content(&state, user.id, file_id, &content).await?;

    Ok(Json(json!({ "id": page_id, "page_number": new_num })))
}

pub async fn delete_page(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path((doc_id, page_num)): Path<(Uuid, i32)>,
) -> Result<Json<Value>> {
    require_owner(&state, doc_id, user.id).await?;

    if store::page_count(&state.db, doc_id).await? <= 1 {
        return Err(PaintsharpError::Validation("Impossible de supprimer la dernière page".into()));
    }

    let deleted_id = store::delete_page(&state.db, doc_id, user.id, page_num).await?;

    if let Some(pid) = deleted_id {
        let file_id = store::doc_file_id(&state.db, doc_id, user.id).await?;
        let mut content = cf::read_content(&state, user.id, file_id).await
            .unwrap_or_else(|_| json!({ "version": 1, "pages": {} }));
        cf::remove_pdf_page(&mut content, pid);
        cf::write_content(&state, user.id, file_id, &content).await?;
    }

    Ok(Json(json!({ "ok": true })))
}

pub async fn rotate_page(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path((doc_id, page_num)): Path<(Uuid, i32)>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<Value>> {
    require_owner(&state, doc_id, user.id).await?;

    let rotation = body["rotation"].as_i64().unwrap_or(0) as i32 % 360;
    let rotation = if rotation < 0 { rotation + 360 } else { rotation };

    store::set_page_rotation(&state.db, doc_id, page_num, rotation).await?;

    Ok(Json(json!({ "ok": true, "rotation": rotation })))
}

pub async fn reorder_pages(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(doc_id): Path<Uuid>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<Value>> {
    require_owner(&state, doc_id, user.id).await?;

    let order: Vec<i32> = serde_json::from_value(
        body["order"].clone()
    ).map_err(|_| PaintsharpError::Validation("order doit être un tableau d'entiers".into()))?;

    let page_count = store::page_count(&state.db, doc_id).await?;

    if order.len() != page_count as usize {
        return Err(PaintsharpError::Validation(
            format!("order doit contenir exactement {page_count} éléments")
        ));
    }

    store::reorder_pages(&state.db, doc_id, &order).await?;

    Ok(Json(json!({ "ok": true })))
}

// ── Signatures ────────────────────────────────────────────────────────────────

pub async fn list_signatures(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
) -> Result<Json<Value>> {
    let sigs = store::list_signatures(&state.db, user.id).await?;
    Ok(Json(json!({ "signatures": sigs })))
}

pub async fn create_signature(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Json(body): Json<CreateSignatureDto>,
) -> Result<Json<Value>> {
    if body.data.is_empty() {
        return Err(PaintsharpError::Validation("data requis".into()));
    }

    let name     = body.name.unwrap_or_else(|| "Ma signature".to_string());
    let sig_type = body.sig_type.unwrap_or_else(|| "draw".to_string());

    let id = store::create_signature(&state.db, user.id, &name, &sig_type, &body.data).await?;

    Ok(Json(json!({ "id": id, "name": name })))
}

pub async fn delete_signature(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    if store::delete_signature(&state.db, id, user.id).await? == 0 {
        return Err(PaintsharpError::NotFound(id.to_string()));
    }
    Ok(Json(json!({ "ok": true })))
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Extrait le nombre de pages et les dimensions depuis les octets d'un PDF.
/// Retourne (page_count, [(width, height), ...]).
fn read_pdf_metadata(data: &[u8]) -> (i32, Vec<(f64, f64)>) {
    use lopdf::Document;

    let Ok(doc) = Document::load_mem(data) else {
        return (1, vec![(595.28, 841.89)]);
    };

    let pages = doc.get_pages();
    let page_count = pages.len() as i32;
    if page_count == 0 {
        return (1, vec![(595.28, 841.89)]);
    }

    let mut metas: Vec<(f64, f64)> = Vec::with_capacity(pages.len());
    let mut sorted: Vec<_> = pages.iter().collect();
    sorted.sort_by_key(|(n, _)| *n);

    for (_, &page_id) in &sorted {
        let (w, h) = extract_page_size(&doc, page_id);
        metas.push((w, h));
    }

    (page_count, metas)
}

fn extract_page_size(doc: &lopdf::Document, page_id: lopdf::ObjectId) -> (f64, f64) {
    use lopdf::Object;

    let Ok(Object::Dictionary(dict)) = doc.get_object(page_id) else {
        return (595.28, 841.89);
    };

    let media_box = dict.get(b"MediaBox")
        .or_else(|_| dict.get(b"CropBox"))
        .ok()
        .and_then(|obj| {
            let obj = doc.dereference(obj).map(|(_, o)| o).unwrap_or(obj);
            if let Object::Array(arr) = obj {
                let nums: Vec<f64> = arr.iter()
                    .filter_map(|o| match o {
                        Object::Real(f)    => Some(*f as f64),
                        Object::Integer(i) => Some(*i as f64),
                        _ => None,
                    })
                    .collect();
                if nums.len() == 4 {
                    return Some((nums[2] - nums[0], nums[3] - nums[1]));
                }
            }
            None
        });

    media_box.unwrap_or((595.28, 841.89))
}

#[derive(serde::Deserialize)]
pub struct OpenByFileDto { pub file_id: uuid::Uuid }

/// Ouvre l'entité liée à un fichier (.kb*) — utilisé par StartPage / « ouvrir avec ».
pub async fn open_by_file(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Json(dto): Json<OpenByFileDto>,
) -> Result<Json<Value>> {
    // 1. Document déjà connu pour ce fichier : soit le .kbpdf natif (file_id), soit
    //    un PDF brut déjà importé (source_file_id). Évite de réimporter.
    if let Some(id) = store::find_for_file(&state.db, dto.file_id, user.id).await? {
        return Ok(Json(json!({ "id": id })));
    }

    // 2. Sinon : ouvrir un PDF brut du module Files en l'important dans PdfWriter.
    let meta = state.files_client.get_file_meta(user.id, dto.file_id).await
        .map_err(|e| PaintsharpError::NotFound(format!("Fichier {} introuvable: {e}", dto.file_id)))?;
    let is_pdf = meta.mime_type == "application/pdf"
        || meta.name.to_ascii_lowercase().ends_with(".pdf");
    if !is_pdf {
        return Err(PaintsharpError::NotFound(format!("Aucun document lié au fichier {}", dto.file_id)));
    }

    let (_info, data) = state.files_client.get_file_content(user.id, dto.file_id).await
        .map_err(|e| PaintsharpError::Internal(anyhow!("Lecture du PDF source: {e}")))?;
    let title = crate::files_client::strip_ext(&meta.name);
    let (doc_id, _page_count) =
        import_pdf_bytes(&state, user.id, &title, &data, Some(dto.file_id)).await?;

    Ok(Json(json!({ "id": doc_id })))
}
