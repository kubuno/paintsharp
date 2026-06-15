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
        AddPageDto, CreatePdfDocumentDto, CreateSignatureDto, PdfDocument,
        PdfDocumentSummary, PdfPage, PdfPageSummary, PdfSignature, SavePageDto,
        UpdatePdfDocumentDto,
    },
    services::content_files as cf,
    state::AppState,
};

/// Récupère le `file_id` (fichier .kbpdf) d'un document, en garantissant la propriété.
async fn doc_file_id(state: &AppState, doc_id: Uuid, user_id: Uuid) -> Result<Uuid> {
    let fid: Option<Uuid> = sqlx::query_scalar(
        "SELECT file_id FROM paintsharp.pdf_documents WHERE id = $1 AND owner_id = $2",
    )
    .bind(doc_id).bind(user_id)
    .fetch_optional(&state.db).await?
    .ok_or_else(|| PaintsharpError::NotFound(doc_id.to_string()))?;
    fid.ok_or_else(|| PaintsharpError::NotFound(format!("Contenu du document {doc_id}")))
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
    let trashed = q.trashed.unwrap_or(false);

    let documents = if q.starred.unwrap_or(false) {
        sqlx::query_as::<_, PdfDocumentSummary>(
            "SELECT id, owner_id, title, page_count, thumbnail_path, is_starred, updated_at, created_at
             FROM paintsharp.pdf_documents
             WHERE owner_id = $1 AND is_starred = TRUE AND is_trashed = FALSE
             ORDER BY updated_at DESC LIMIT $2 OFFSET $3",
        )
        .bind(user.id).bind(limit).bind(offset)
        .fetch_all(&state.db).await?
    } else if trashed {
        sqlx::query_as::<_, PdfDocumentSummary>(
            "SELECT id, owner_id, title, page_count, thumbnail_path, is_starred, updated_at, created_at
             FROM paintsharp.pdf_documents
             WHERE owner_id = $1 AND is_trashed = TRUE
             ORDER BY trashed_at DESC LIMIT $2 OFFSET $3",
        )
        .bind(user.id).bind(limit).bind(offset)
        .fetch_all(&state.db).await?
    } else {
        sqlx::query_as::<_, PdfDocumentSummary>(
            "SELECT id, owner_id, title, page_count, thumbnail_path, is_starred, updated_at, created_at
             FROM paintsharp.pdf_documents
             WHERE owner_id = $1 AND is_trashed = FALSE
             ORDER BY updated_at DESC LIMIT $2 OFFSET $3",
        )
        .bind(user.id).bind(limit).bind(offset)
        .fetch_all(&state.db).await?
    };

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

    let mut tx = state.db.begin().await?;

    let doc_id: Uuid = sqlx::query_scalar(
        "INSERT INTO paintsharp.pdf_documents (owner_id, title, page_count)
         VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(user.id).bind(&title).bind(page_count)
    .fetch_one(&mut *tx).await?;

    let mut content = json!({ "version": 1, "pages": {} });
    for n in 1..=page_count {
        let page_id: Uuid = sqlx::query_scalar(
            "INSERT INTO paintsharp.pdf_pages (document_id, page_number, width, height)
             VALUES ($1, $2, $3, $4) RETURNING id",
        )
        .bind(doc_id).bind(n).bind(width).bind(height)
        .fetch_one(&mut *tx).await?;
        cf::set_pdf_page(&mut content, page_id, cf::empty_pdf_page());
    }

    tx.commit().await?;

    // Contenu (annotations/form_data) → fichier .kbpdf.
    let file_id = cf::create_pdf_file(&state, user.id, &title, &content).await?;
    sqlx::query("UPDATE paintsharp.pdf_documents SET file_id = $1 WHERE id = $2")
        .bind(file_id).bind(doc_id).execute(&state.db).await?;

    Ok(Json(json!({ "id": doc_id, "title": title, "page_count": page_count })))
}

pub async fn get_document(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let doc = sqlx::query_as::<_, crate::models::pdf::PdfDocument>(
        "SELECT * FROM paintsharp.pdf_documents WHERE id = $1 AND owner_id = $2",
    )
    .bind(id).bind(user.id)
    .fetch_optional(&state.db).await?
    .ok_or_else(|| PaintsharpError::NotFound(id.to_string()))?;

    let pages = sqlx::query_as::<_, PdfPageSummary>(
        "SELECT id, page_number, width, height, rotation FROM paintsharp.pdf_pages
         WHERE document_id = $1 ORDER BY page_number",
    )
    .bind(id)
    .fetch_all(&state.db).await?;

    let mut val = serde_json::to_value(&doc).unwrap_or_default();
    val["pages"] = serde_json::to_value(&pages).unwrap_or_default();

    // Le nom du fichier .kbpdf fait foi pour le titre (géré par `files`).
    if let Some(fid) = doc.file_id {
        if let Some(fname) = cf::file_name(&state, user.id, fid).await {
            let stem = cf::strip_ext(&fname);
            if !stem.is_empty() && stem != doc.title {
                let _ = sqlx::query("UPDATE paintsharp.pdf_documents SET title = $2 WHERE id = $1")
                    .bind(id).bind(&stem).execute(&state.db).await;
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
    let rows = sqlx::query(
        "UPDATE paintsharp.pdf_documents SET
            title          = COALESCE($3, title),
            thumbnail_path = COALESCE($4, thumbnail_path),
            is_starred     = COALESCE($5, is_starred),
            settings       = COALESCE($6, settings),
            last_edited_by = $2
         WHERE id = $1 AND owner_id = $2",
    )
    .bind(id).bind(user.id)
    .bind(&body.title)
    .bind(&body.thumbnail_path)
    .bind(body.is_starred)
    .bind(&body.settings)
    .execute(&state.db).await?.rows_affected();

    if rows == 0 {
        return Err(PaintsharpError::NotFound(id.to_string()));
    }

    // Renomme le fichier .kbpdf pour refléter le nouveau titre.
    if let Some(t) = body.title.as_ref() {
        if !t.trim().is_empty() {
            if let Ok(fid) = doc_file_id(&state, id, user.id).await {
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
    let rows = sqlx::query(
        "UPDATE paintsharp.pdf_documents SET is_trashed = TRUE, trashed_at = NOW()
         WHERE id = $1 AND owner_id = $2 AND is_trashed = FALSE",
    )
    .bind(id).bind(user.id)
    .execute(&state.db).await?.rows_affected();

    if rows == 0 { return Err(PaintsharpError::NotFound(id.to_string())); }
    Ok(Json(json!({ "ok": true })))
}

pub async fn restore_document(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    sqlx::query(
        "UPDATE paintsharp.pdf_documents SET is_trashed = FALSE, trashed_at = NULL
         WHERE id = $1 AND owner_id = $2",
    )
    .bind(id).bind(user.id)
    .execute(&state.db).await?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn delete_document(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let doc: Option<(Option<String>,)> = sqlx::query_as(
        "DELETE FROM paintsharp.pdf_documents WHERE id = $1 AND owner_id = $2 AND is_trashed = TRUE
         RETURNING source_path",
    )
    .bind(id).bind(user.id)
    .fetch_optional(&state.db).await?;

    if doc.is_none() {
        return Err(PaintsharpError::NotFound(id.to_string()));
    }

    if let Some((Some(path),)) = doc {
        let _ = tokio::fs::remove_file(&path).await;
    }

    Ok(Json(json!({ "ok": true })))
}

pub async fn duplicate_document(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let source: PdfDocument = sqlx::query_as::<_, PdfDocument>(
        "SELECT id, owner_id, title, source_path, page_count, thumbnail_path, settings,
                file_id, is_starred, is_trashed, trashed_at, last_edited_by, created_at, updated_at
         FROM paintsharp.pdf_documents WHERE id = $1 AND owner_id = $2 AND is_trashed = FALSE",
    )
    .bind(id).bind(user.id)
    .fetch_optional(&state.db).await?
    .ok_or_else(|| PaintsharpError::NotFound(id.to_string()))?;

    let pages: Vec<PdfPage> = sqlx::query_as::<_, PdfPage>(
        "SELECT id, document_id, page_number, width, height, rotation, created_at, updated_at
         FROM paintsharp.pdf_pages WHERE document_id = $1 ORDER BY page_number",
    )
    .bind(id)
    .fetch_all(&state.db).await?;

    // Contenu source (annotations/form_data par page).
    let src_content = match source.file_id {
        Some(fid) => cf::read_content(&state, user.id, fid).await
            .unwrap_or_else(|_| json!({ "version": 1, "pages": {} })),
        None => json!({ "version": 1, "pages": {} }),
    };

    let new_title = format!("{} (copie)", source.title);
    let new_id: Uuid = sqlx::query_scalar(
        "INSERT INTO paintsharp.pdf_documents (owner_id, title, page_count, settings)
         VALUES ($1, $2, $3, $4) RETURNING id",
    )
    .bind(user.id)
    .bind(&new_title)
    .bind(source.page_count)
    .bind(&source.settings)
    .fetch_one(&state.db).await?;

    // Recrée chaque page (nouveaux ids) et remappe le contenu vers ces ids.
    let mut new_content = json!({ "version": 1, "pages": {} });
    for page in &pages {
        let new_page_id: Uuid = sqlx::query_scalar(
            "INSERT INTO paintsharp.pdf_pages (document_id, page_number, width, height, rotation)
             VALUES ($1, $2, $3, $4, $5) RETURNING id",
        )
        .bind(new_id)
        .bind(page.page_number)
        .bind(page.width)
        .bind(page.height)
        .bind(page.rotation)
        .fetch_one(&state.db).await?;
        cf::set_pdf_page(&mut new_content, new_page_id, cf::get_pdf_page(&src_content, page.id));
    }

    let new_file_id = cf::create_pdf_file(&state, user.id, &new_title, &new_content).await?;
    sqlx::query("UPDATE paintsharp.pdf_documents SET file_id = $1 WHERE id = $2")
        .bind(new_file_id).bind(new_id).execute(&state.db).await?;

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

    let mut tx = state.db.begin().await?;

    sqlx::query(
        "INSERT INTO paintsharp.pdf_documents (id, owner_id, title, source_path, page_count, source_file_id)
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(doc_id).bind(user_id).bind(title)
    .bind(&storage_path).bind(page_count).bind(source_file_id)
    .execute(&mut *tx).await?;

    let mut content = json!({ "version": 1, "pages": {} });
    for (n, (w, h)) in pages_meta.into_iter().enumerate() {
        let page_id: Uuid = sqlx::query_scalar(
            "INSERT INTO paintsharp.pdf_pages (document_id, page_number, width, height)
             VALUES ($1, $2, $3, $4) RETURNING id",
        )
        .bind(doc_id).bind((n + 1) as i32).bind(w).bind(h)
        .fetch_one(&mut *tx).await?;
        cf::set_pdf_page(&mut content, page_id, cf::empty_pdf_page());
    }

    tx.commit().await?;

    let file_id = cf::create_pdf_file(state, user_id, title, &content).await?;
    sqlx::query("UPDATE paintsharp.pdf_documents SET file_id = $1 WHERE id = $2")
        .bind(file_id).bind(doc_id).execute(&state.db).await?;

    Ok((doc_id, page_count))
}

// ── Source file & Export ──────────────────────────────────────────────────────

pub async fn get_source(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
) -> Result<Response<Body>> {
    let row: (Option<String>, String) = sqlx::query_as(
        "SELECT source_path, title FROM paintsharp.pdf_documents WHERE id = $1 AND owner_id = $2",
    )
    .bind(id).bind(user.id)
    .fetch_optional(&state.db).await?
    .ok_or_else(|| PaintsharpError::NotFound(id.to_string()))?;

    let (source_path, title) = row;
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
    check_owner(&state.db, doc_id, user.id).await?;

    let pages = sqlx::query_as::<_, PdfPage>(
        "SELECT * FROM paintsharp.pdf_pages WHERE document_id = $1 ORDER BY page_number",
    )
    .bind(doc_id)
    .fetch_all(&state.db).await?;

    let file_id = doc_file_id(&state, doc_id, user.id).await?;
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
    check_owner(&state.db, doc_id, user.id).await?;

    let page = sqlx::query_as::<_, PdfPage>(
        "SELECT * FROM paintsharp.pdf_pages WHERE document_id = $1 AND page_number = $2",
    )
    .bind(doc_id).bind(page_num)
    .fetch_optional(&state.db).await?
    .ok_or_else(|| PaintsharpError::NotFound(format!("Page {page_num}")))?;

    let file_id = doc_file_id(&state, doc_id, user.id).await?;
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
    check_owner(&state.db, doc_id, user.id).await?;

    let rotation = body.rotation.unwrap_or(0);
    let page_id: Uuid = sqlx::query_scalar(
        "UPDATE paintsharp.pdf_pages SET rotation = $3
         WHERE document_id = $1 AND page_number = $2 RETURNING id",
    )
    .bind(doc_id).bind(page_num).bind(rotation)
    .fetch_optional(&state.db).await?
    .ok_or_else(|| PaintsharpError::NotFound(format!("Page {page_num}")))?;

    // annotations + form_data → fichier (clé = page_id).
    let file_id = doc_file_id(&state, doc_id, user.id).await?;
    let mut content = cf::read_content(&state, user.id, file_id).await
        .unwrap_or_else(|_| json!({ "version": 1, "pages": {} }));
    let mut pc = cf::get_pdf_page(&content, page_id);
    pc["annotations"] = body.annotations.clone();
    if let Some(fd) = &body.form_data {
        pc["form_data"] = fd.clone();
    }
    cf::set_pdf_page(&mut content, page_id, pc);
    cf::write_content(&state, user.id, file_id, &content).await?;

    sqlx::query(
        "UPDATE paintsharp.pdf_documents SET last_edited_by = $2 WHERE id = $1",
    )
    .bind(doc_id).bind(user.id)
    .execute(&state.db).await?;

    Ok(Json(json!({ "ok": true })))
}

pub async fn add_page(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(doc_id): Path<Uuid>,
    Json(body): Json<AddPageDto>,
) -> Result<Json<Value>> {
    check_owner(&state.db, doc_id, user.id).await?;

    let after     = body.after.unwrap_or(0);
    let width     = body.width.unwrap_or(595.28);
    let height    = body.height.unwrap_or(841.89);

    let mut tx = state.db.begin().await?;

    sqlx::query(
        "UPDATE paintsharp.pdf_pages SET page_number = page_number + 1
         WHERE document_id = $1 AND page_number > $2",
    )
    .bind(doc_id).bind(after)
    .execute(&mut *tx).await?;

    let new_num = after + 1;
    let page_id: Uuid = sqlx::query_scalar(
        "INSERT INTO paintsharp.pdf_pages (document_id, page_number, width, height)
         VALUES ($1, $2, $3, $4) RETURNING id",
    )
    .bind(doc_id).bind(new_num).bind(width).bind(height)
    .fetch_one(&mut *tx).await?;

    sqlx::query(
        "UPDATE paintsharp.pdf_documents SET
            page_count = page_count + 1,
            last_edited_by = $2
         WHERE id = $1",
    )
    .bind(doc_id).bind(user.id)
    .execute(&mut *tx).await?;

    tx.commit().await?;

    let file_id = doc_file_id(&state, doc_id, user.id).await?;
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
    check_owner(&state.db, doc_id, user.id).await?;

    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM paintsharp.pdf_pages WHERE document_id = $1",
    )
    .bind(doc_id)
    .fetch_one(&state.db).await?;

    if count <= 1 {
        return Err(PaintsharpError::Validation("Impossible de supprimer la dernière page".into()));
    }

    let mut tx = state.db.begin().await?;

    let deleted_id: Option<Uuid> = sqlx::query_scalar(
        "DELETE FROM paintsharp.pdf_pages WHERE document_id = $1 AND page_number = $2 RETURNING id",
    )
    .bind(doc_id).bind(page_num)
    .fetch_optional(&mut *tx).await?;

    sqlx::query(
        "UPDATE paintsharp.pdf_pages SET page_number = page_number - 1
         WHERE document_id = $1 AND page_number > $2",
    )
    .bind(doc_id).bind(page_num)
    .execute(&mut *tx).await?;

    sqlx::query(
        "UPDATE paintsharp.pdf_documents SET
            page_count = page_count - 1,
            last_edited_by = $2
         WHERE id = $1",
    )
    .bind(doc_id).bind(user.id)
    .execute(&mut *tx).await?;

    tx.commit().await?;

    if let Some(pid) = deleted_id {
        let file_id = doc_file_id(&state, doc_id, user.id).await?;
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
    check_owner(&state.db, doc_id, user.id).await?;

    let rotation = body["rotation"].as_i64().unwrap_or(0) as i32 % 360;
    let rotation = if rotation < 0 { rotation + 360 } else { rotation };

    sqlx::query(
        "UPDATE paintsharp.pdf_pages SET rotation = $3
         WHERE document_id = $1 AND page_number = $2",
    )
    .bind(doc_id).bind(page_num).bind(rotation)
    .execute(&state.db).await?;

    Ok(Json(json!({ "ok": true, "rotation": rotation })))
}

pub async fn reorder_pages(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(doc_id): Path<Uuid>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<Value>> {
    check_owner(&state.db, doc_id, user.id).await?;

    let order: Vec<i32> = serde_json::from_value(
        body["order"].clone()
    ).map_err(|_| PaintsharpError::Validation("order doit être un tableau d'entiers".into()))?;

    let page_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM paintsharp.pdf_pages WHERE document_id = $1",
    )
    .bind(doc_id)
    .fetch_one(&state.db).await?;

    if order.len() != page_count as usize {
        return Err(PaintsharpError::Validation(
            format!("order doit contenir exactement {page_count} éléments")
        ));
    }

    let mut tx = state.db.begin().await?;

    // Utiliser des numéros temporaires négatifs pour éviter les conflits UNIQUE
    for (new_pos, &old_num) in order.iter().enumerate() {
        let tmp = -(new_pos as i32 + 1);
        sqlx::query(
            "UPDATE paintsharp.pdf_pages SET page_number = $3
             WHERE document_id = $1 AND page_number = $2",
        )
        .bind(doc_id).bind(old_num).bind(tmp)
        .execute(&mut *tx).await?;
    }

    for (new_pos, _) in order.iter().enumerate() {
        let tmp = -(new_pos as i32 + 1);
        sqlx::query(
            "UPDATE paintsharp.pdf_pages SET page_number = $3
             WHERE document_id = $1 AND page_number = $2",
        )
        .bind(doc_id).bind(tmp).bind((new_pos + 1) as i32)
        .execute(&mut *tx).await?;
    }

    tx.commit().await?;

    Ok(Json(json!({ "ok": true })))
}

// ── Signatures ────────────────────────────────────────────────────────────────

pub async fn list_signatures(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
) -> Result<Json<Value>> {
    let sigs = sqlx::query_as::<_, PdfSignature>(
        "SELECT * FROM paintsharp.pdf_signatures WHERE owner_id = $1 ORDER BY created_at DESC",
    )
    .bind(user.id)
    .fetch_all(&state.db).await?;

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

    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO paintsharp.pdf_signatures (owner_id, name, sig_type, data)
         VALUES ($1, $2, $3, $4) RETURNING id",
    )
    .bind(user.id).bind(&name).bind(&sig_type).bind(&body.data)
    .fetch_one(&state.db).await?;

    Ok(Json(json!({ "id": id, "name": name })))
}

pub async fn delete_signature(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let rows = sqlx::query(
        "DELETE FROM paintsharp.pdf_signatures WHERE id = $1 AND owner_id = $2",
    )
    .bind(id).bind(user.id)
    .execute(&state.db).await?.rows_affected();

    if rows == 0 { return Err(PaintsharpError::NotFound(id.to_string())); }
    Ok(Json(json!({ "ok": true })))
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async fn check_owner(db: &sqlx::PgPool, doc_id: Uuid, user_id: Uuid) -> Result<()> {
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM paintsharp.pdf_documents WHERE id = $1 AND owner_id = $2 AND is_trashed = FALSE)",
    )
    .bind(doc_id).bind(user_id)
    .fetch_one(db).await?;
    if !exists { return Err(PaintsharpError::NotFound(doc_id.to_string())); }
    Ok(())
}

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
    axum::extract::State(state): axum::extract::State<crate::state::AppState>,
    axum::Extension(user): axum::Extension<crate::middleware::PaintsharpUser>,
    axum::Json(dto): axum::Json<OpenByFileDto>,
) -> crate::errors::Result<axum::Json<serde_json::Value>> {
    // 1. Document déjà connu pour ce fichier : soit le .kbpdf natif (file_id), soit
    //    un PDF brut déjà importé (source_file_id). Évite de réimporter.
    let existing: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM paintsharp.pdf_documents
         WHERE owner_id = $2 AND is_trashed = FALSE AND (file_id = $1 OR source_file_id = $1)",
    )
    .bind(dto.file_id).bind(user.id)
    .fetch_optional(&state.db).await?;
    if let Some(id) = existing {
        return Ok(axum::Json(serde_json::json!({ "id": id })));
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

    Ok(axum::Json(serde_json::json!({ "id": doc_id })))
}
