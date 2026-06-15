//! Stockage du CONTENU des éditeurs Paintsharp dans le module `files` (plus en base).
//!
//! Format Kubuno (JSON) propre à chaque app — MIME `application/vnd.kubuno.<app>+json`,
//! extension `.kb<app>`. Le fichier porte tout le contenu ; la base ne garde que la
//! métadonnée (entité, pages/calques : nom, position…).

use anyhow::Result;
use bytes::Bytes;
use serde_json::{json, Value};
use std::io::{Read, Write};
use uuid::Uuid;

use crate::{errors::PaintsharpError, state::AppState};

// ── Compression (gzip) ─────────────────────────────────────────────────────────
// Les formats Kubuno compressent leur JSON pour éviter des fichiers volumineux.
// En lecture on détecte la signature gzip (0x1f 0x8b) pour rester tolérant à un
// contenu non compressé.

fn gzip(raw: &[u8]) -> Result<Vec<u8>, PaintsharpError> {
    let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    enc.write_all(raw).map_err(|e| PaintsharpError::Internal(anyhow::anyhow!(e)))?;
    enc.finish().map_err(|e| PaintsharpError::Internal(anyhow::anyhow!(e)))
}

fn gunzip(raw: &[u8]) -> Result<Vec<u8>, PaintsharpError> {
    if raw.len() >= 2 && raw[0] == 0x1f && raw[1] == 0x8b {
        let mut dec = flate2::read::GzDecoder::new(raw);
        let mut out = Vec::new();
        dec.read_to_end(&mut out).map_err(|e| PaintsharpError::Internal(anyhow::anyhow!(e)))?;
        Ok(out)
    } else {
        Ok(raw.to_vec()) // déjà en clair
    }
}

// ── Lecture / écriture génériques ──────────────────────────────────────────────

pub async fn read_content(state: &AppState, user_id: Uuid, file_id: Uuid) -> Result<Value, PaintsharpError> {
    let (_info, raw) = state.files_client.get_file_content(user_id, file_id).await
        .map_err(PaintsharpError::Internal)?;
    let json = gunzip(&raw)?;
    serde_json::from_slice::<Value>(&json)
        .map_err(|e| PaintsharpError::Internal(anyhow::anyhow!("contenu illisible: {e}")))
}

pub async fn write_content(state: &AppState, user_id: Uuid, file_id: Uuid, content: &Value) -> Result<(), PaintsharpError> {
    let raw = serde_json::to_vec(content).map_err(|e| PaintsharpError::Internal(anyhow::anyhow!(e)))?;
    let gz  = gzip(&raw)?;
    state.files_client.update_file_content(user_id, file_id, Bytes::from(gz)).await
        .map_err(PaintsharpError::Internal).map(|_| ())
}

fn content_file_name(title: &str, ext: &str) -> String {
    let base = std::path::Path::new(title).file_stem().and_then(|s| s.to_str()).unwrap_or(title);
    let base = if base.trim().is_empty() { "Sans titre" } else { base.trim() };
    format!("{base}.{ext}")
}

/// Icône Lucide du dossier feuille d'un sous-module Paintsharp.
fn subtype_icon(subtype: &str) -> &'static str {
    match subtype {
        "vector"    => "PenTool",      // Apex
        "layer"     => "Layers",       // Layer
        "scene"     => "Box",          // Vertex
        "motion"    => "Clapperboard", // Motion
        "animation" => "Film",         // Keyframe
        "pdf"       => "FileText",     // PdfWriter
        _            => "Folder",
    }
}

/// Crée un fichier de contenu Kubuno (JSON gzippé) dans `Paintsharp/<App>/`.
/// Le dossier `Paintsharp` (module) et le dossier feuille (sous-module) reçoivent
/// une icône Lucide et sont protégés (non supprimables).
async fn create_kubuno_file(
    state: &AppState, user_id: Uuid, folder_path: &str, title: &str, ext: &str,
    mime: &str, subtype: &str, content: &Value,
) -> Result<Uuid, PaintsharpError> {
    // Dossier racine du module (icône Paintsharp).
    let _ = state.files_client.ensure_folder_path(user_id, "PaintSharp", true, Some("Hammer")).await
        .map_err(PaintsharpError::Internal)?;
    let folder = state.files_client.ensure_folder_path(user_id, folder_path, true, Some(subtype_icon(subtype))).await
        .map_err(PaintsharpError::Internal)?;
    let raw = serde_json::to_vec(content).map_err(|e| PaintsharpError::Internal(anyhow::anyhow!(e)))?;
    let gz  = gzip(&raw)?;
    let name = content_file_name(title, ext);
    let file = state.files_client.create_file_with_content(
        user_id, Some(folder.id), &name, mime, Bytes::from(gz),
        Some(json!({ "module": "paintsharp", "subtype": subtype })), false,
    ).await.map_err(PaintsharpError::Internal)?;
    Ok(file.id)
}

// ── Apex (vectoriel) — `.kbvec` ─────────────────────────────────────────────

pub const VECTOR_MIME: &str = "application/vnd.kubuno.vector+json";

pub fn empty_vector_page() -> Value {
    json!({
        "artboards": [{ "id": Uuid::new_v4(), "name": "Artboard 1", "x": 80, "y": 80, "width": 1920, "height": 1080, "background": "white" }],
        "elements": [],
        "guides":   []
    })
}

pub fn get_page_data(content: &Value, page_id: Uuid) -> Value {
    content.get("pages").and_then(|p| p.get(page_id.to_string())).cloned().unwrap_or_else(empty_vector_page)
}

pub fn set_page_data(content: &mut Value, page_id: Uuid, data: Value) {
    match content.get_mut("pages").and_then(|p| p.as_object_mut()) {
        Some(pages) => { pages.insert(page_id.to_string(), data); }
        None        => { content["pages"] = json!({ page_id.to_string(): data }); }
    }
}

pub fn remove_page_data(content: &mut Value, page_id: Uuid) {
    if let Some(pages) = content.get_mut("pages").and_then(|p| p.as_object_mut()) {
        pages.remove(&page_id.to_string());
    }
}

/// Crée un fichier de contenu vectoriel (Paintsharp/Apex/<titre>.kbvec) à partir
/// d'un contenu complet déjà formé `{version, pages}`.
pub async fn create_vector_file(
    state: &AppState, user_id: Uuid, title: &str, content: &Value,
) -> Result<Uuid, PaintsharpError> {
    create_kubuno_file(state, user_id, "PaintSharp/Apex", title, "kbvec", VECTOR_MIME, "vector", content).await
}

/// Crée le fichier de contenu d'un nouveau projet (une page).
pub async fn create_vector_content_file(
    state: &AppState, user_id: Uuid, title: &str, page_id: Uuid, page_data: Value,
) -> Result<Uuid, PaintsharpError> {
    let content = json!({ "version": 1, "pages": { page_id.to_string(): page_data } });
    create_vector_file(state, user_id, title, &content).await
}

// ── Layer (raster) — `.kblay` ───────────────────────────────────────────────
// Le contenu = structure des calques + réglages de vue (les pixels sont stockés
// à part via layer_data.storage_path, donc déjà hors base).

pub const LAYER_MIME: &str = "application/vnd.kubuno.layer+json";

pub fn empty_layer_content(layers_structure: Value) -> Value {
    json!({
        "version": 1,
        "layers_structure": layers_structure,
        "view_settings": { "zoom": 1.0, "panX": 0, "panY": 0, "showGuides": true, "showGrid": false, "gridSize": 32 },
        "command_history": []
    })
}

pub async fn create_layer_file(
    state: &AppState, user_id: Uuid, title: &str, content: &Value,
) -> Result<Uuid, PaintsharpError> {
    create_kubuno_file(state, user_id, "PaintSharp/Layer", title, "kblay", LAYER_MIME, "layer", content).await
}

// ── Vertex (3D) — `.kbscn` ──────────────────────────────────────────────────
// Contenu = scène Three.js (scene_json). Les assets binaires (textures, modèles)
// sont stockés à part (scene_assets), donc déjà hors base.

pub const SCENE_MIME: &str = "application/vnd.kubuno.scene+json";

pub fn empty_scene_json() -> Value {
    json!({ "metadata": { "version": 4.6, "type": "Scene" }, "object": { "type": "Scene", "children": [] } })
}

pub fn scene_content_from(scene_json: Value) -> Value {
    json!({ "version": 1, "scene": scene_json })
}

pub async fn create_scene_file(
    state: &AppState, user_id: Uuid, title: &str, content: &Value,
) -> Result<Uuid, PaintsharpError> {
    create_kubuno_file(state, user_id, "PaintSharp/Vertex", title, "kbscn", SCENE_MIME, "scene", content).await
}

// ── Motion (vidéo) — `.kbmot` ───────────────────────────────────────────────
// Contenu d'édition = timeline (tracks/clips). Les médias et réglages
// (composition, render_settings) restent des métadonnées en base.

pub const MOTION_MIME: &str = "application/vnd.kubuno.motion+json";

pub fn empty_timeline() -> Value {
    json!({ "tracks": [], "markers": [] })
}

pub fn motion_content_from(timeline: Value) -> Value {
    json!({ "version": 1, "timeline_data": timeline })
}

pub async fn create_motion_file(
    state: &AppState, user_id: Uuid, title: &str, content: &Value,
) -> Result<Uuid, PaintsharpError> {
    create_kubuno_file(state, user_id, "PaintSharp/Motion", title, "kbmot", MOTION_MIME, "motion", content).await
}

// ── Keyframe (animation 2D) — `.kbanm` ──────────────────────────────────────
// Contenu = anim_data (layers/bones) + assets. La composition (réglages) et
// yjs_state (état CRDT collab, fréquemment écrit) restent en base.

pub const ANIM_MIME: &str = "application/vnd.kubuno.animation+json";

pub fn empty_anim_data() -> Value {
    json!({ "layers": [], "bones": [] })
}

pub fn anim_content_from(anim_data: Value, assets: Value) -> Value {
    json!({ "version": 1, "anim_data": anim_data, "assets": assets })
}

pub async fn create_anim_file(
    state: &AppState, user_id: Uuid, title: &str, content: &Value,
) -> Result<Uuid, PaintsharpError> {
    create_kubuno_file(state, user_id, "PaintSharp/Keyframe", title, "kbanm", ANIM_MIME, "animation", content).await
}

// ── PdfWriter (annotation PDF) — `.kbpdf` ────────────────────────────────────
// Contenu = annotations + form_data par page (clé = page_id). Le PDF source
// importé reste sur disque (source_path) ; la métadonnée de page
// (numéro, dimensions, rotation) reste en base.

pub const PDFDOC_MIME: &str = "application/vnd.kubuno.pdfdoc+json";

pub fn empty_pdf_page() -> Value {
    json!({ "annotations": [], "form_data": {} })
}

pub fn get_pdf_page(content: &Value, page_id: Uuid) -> Value {
    content.get("pages").and_then(|p| p.get(page_id.to_string())).cloned().unwrap_or_else(empty_pdf_page)
}

pub fn set_pdf_page(content: &mut Value, page_id: Uuid, data: Value) {
    match content.get_mut("pages").and_then(|p| p.as_object_mut()) {
        Some(pages) => { pages.insert(page_id.to_string(), data); }
        None        => { content["pages"] = json!({ page_id.to_string(): data }); }
    }
}

pub fn remove_pdf_page(content: &mut Value, page_id: Uuid) {
    if let Some(pages) = content.get_mut("pages").and_then(|p| p.as_object_mut()) {
        pages.remove(&page_id.to_string());
    }
}

pub async fn create_pdf_file(
    state: &AppState, user_id: Uuid, title: &str, content: &Value,
) -> Result<Uuid, PaintsharpError> {
    create_kubuno_file(state, user_id, "PaintSharp/PdfWriter", title, "kbpdf", PDFDOC_MIME, "pdf", content).await
}


// ── Noms de fichiers : DÉLÉGUÉS à la face client du module `files` ────────────
pub fn strip_ext(name: &str) -> String { crate::files_client::strip_ext(name) }
/// Nom complet du fichier .kb*** (best-effort).
pub async fn file_name(state: &crate::state::AppState, owner_id: uuid::Uuid, file_id: uuid::Uuid) -> Option<String> {
    state.files_client.get_file_meta(owner_id, file_id).await.ok().map(|i| i.name)
}
/// Renomme le fichier .kb*** pour qu'il porte `<title>.<ext>` (titre = nom). Best-effort.
pub async fn rename_content_file(state: &crate::state::AppState, owner_id: uuid::Uuid, file_id: uuid::Uuid, title: &str, ext: &str) {
    crate::files_client::set_title(&state.files_client, owner_id, file_id, title, ext).await
}
