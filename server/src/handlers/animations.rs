use axum::{extract::{Path, Query, State}, Extension, Json};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    errors::{PaintsharpError, Result},
    middleware::PaintsharpUser,
    models::animation::{CreateAnimationDto, UpdateAnimationDto},
    services::content_files as cf,
    services::store::animations as store,
    state::AppState,
};

#[derive(Debug, Deserialize)]
pub struct ListQuery {
    pub trashed: Option<bool>,
    pub limit:   Option<i64>,
    pub offset:  Option<i64>,
}

// ── Liste ─────────────────────────────────────────────────────────────────────

pub async fn list_animations(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Query(q): Query<ListQuery>,
) -> Result<Json<Value>> {
    let limit   = q.limit.unwrap_or(50).min(200);
    let offset  = q.offset.unwrap_or(0);
    let animations = store::list_animations(
        &state.db, user.id, q.trashed.unwrap_or(false), limit, offset,
    )
    .await?;
    Ok(Json(json!({ "animations": animations })))
}

// ── Créer ─────────────────────────────────────────────────────────────────────

pub async fn create_animation(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Json(body): Json<CreateAnimationDto>,
) -> Result<Json<Value>> {
    let title = body.title.unwrap_or_else(|| "Animation sans titre".to_string());

    let default_composition = json!({
        "width":           720,
        "height":          480,
        "fps":             24,
        "duration_frames": 120,
        "background":      "#1a1a2e",
        "pixelRatio":      1
    });
    let composition = body.composition.unwrap_or(default_composition);

    let bg = composition.get("background")
        .and_then(|v| v.as_str())
        .unwrap_or("#1a1a2e")
        .to_string();

    // Animation de démonstration : un calque solid + un calque shape animé
    let bg_layer_id  = Uuid::new_v4().to_string();
    let rect_id      = Uuid::new_v4().to_string();
    let w = composition.get("width").and_then(|v| v.as_f64()).unwrap_or(720.0);
    let h = composition.get("height").and_then(|v| v.as_f64()).unwrap_or(480.0);
    let dur = composition.get("duration_frames").and_then(|v| v.as_i64()).unwrap_or(120);

    let make_prop_static = |v: f64| json!({ "staticValue": v, "keyframes": [] });
    let make_prop_str    = |v: &str| json!({ "staticValue": v, "keyframes": [] });

    let anim_data = json!({
        "layers": [
            {
                "id":       bg_layer_id,
                "type":     "solid",
                "name":     "Fond",
                "parentId": null,
                "inPoint":  0,
                "outPoint": dur,
                "solo":     false,
                "locked":   false,
                "visible":  true,
                "blendMode":"normal",
                "data":     { "type": "solid", "width": w, "height": h },
                "effects":  [],
                "properties": {
                    "positionX":  make_prop_static(0.0),
                    "positionY":  make_prop_static(0.0),
                    "rotation":   make_prop_static(0.0),
                    "scaleX":     make_prop_static(1.0),
                    "scaleY":     make_prop_static(1.0),
                    "opacity":    make_prop_static(100.0),
                    "anchorX":    make_prop_static(0.0),
                    "anchorY":    make_prop_static(0.0),
                    "fillColor":  make_prop_str(&bg)
                }
            },
            {
                "id":       rect_id,
                "type":     "shape",
                "name":     "Rectangle",
                "parentId": null,
                "inPoint":  0,
                "outPoint": dur,
                "solo":     false,
                "locked":   false,
                "visible":  true,
                "blendMode":"normal",
                "data":     { "type": "shape", "shape": "rect", "width": 120.0, "height": 80.0, "cornerRadius": 8.0 },
                "effects":  [],
                "properties": {
                    "positionX": {
                        "staticValue": w / 2.0 - 60.0,
                        "keyframes": [
                            {
                                "id":            Uuid::new_v4().to_string(),
                                "frame":         0,
                                "value":         80.0,
                                "interpolation": "bezier",
                                "easing":        { "type": "cubic-bezier", "cx1": 0.42, "cy1": 0.0, "cx2": 0.58, "cy2": 1.0 },
                                "handleIn":      { "x": 0.0, "y": 0.0 },
                                "handleOut":     { "x": 0.0, "y": 0.0 }
                            },
                            {
                                "id":            Uuid::new_v4().to_string(),
                                "frame":         dur / 2,
                                "value":         w - 200.0,
                                "interpolation": "bezier",
                                "easing":        { "type": "cubic-bezier", "cx1": 0.42, "cy1": 0.0, "cx2": 0.58, "cy2": 1.0 },
                                "handleIn":      { "x": 0.0, "y": 0.0 },
                                "handleOut":     { "x": 0.0, "y": 0.0 }
                            },
                            {
                                "id":            Uuid::new_v4().to_string(),
                                "frame":         dur,
                                "value":         80.0,
                                "interpolation": "bezier",
                                "easing":        { "type": "linear" },
                                "handleIn":      { "x": 0.0, "y": 0.0 },
                                "handleOut":     { "x": 0.0, "y": 0.0 }
                            }
                        ]
                    },
                    "positionY":  make_prop_static(h / 2.0 - 40.0),
                    "rotation":   make_prop_static(0.0),
                    "scaleX":     make_prop_static(1.0),
                    "scaleY":     make_prop_static(1.0),
                    "opacity":    make_prop_static(100.0),
                    "anchorX":    make_prop_static(0.0),
                    "anchorY":    make_prop_static(0.0),
                    "fillColor":  make_prop_str("#e8824a"),
                    "strokeColor":make_prop_str("transparent"),
                    "strokeWidth":make_prop_static(0.0)
                }
            }
        ],
        "bones": []
    });

    let id = store::create_animation(&state.db, user.id, &title, &composition).await?;

    // anim_data + assets → fichier .kbanm.
    let content = cf::anim_content_from(anim_data, json!([]));
    let file_id = cf::create_anim_file(&state, user.id, &title, &content).await?;
    store::set_file_id(&state.db, id, file_id).await?;

    Ok(Json(json!({ "id": id, "title": title })))
}

// ── Lire ──────────────────────────────────────────────────────────────────────

pub async fn get_animation(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let anim = store::get_animation(&state.db, id, user.id)
        .await?
        .ok_or_else(|| PaintsharpError::NotFound(format!("Animation {id}")))?;

    // anim_data + assets lus depuis le fichier .kbanm.
    let mut val = serde_json::to_value(&anim).unwrap_or_default();
    let content = match anim.file_id {
        Some(fid) => cf::read_content(&state, user.id, fid).await.unwrap_or_else(|_| cf::anim_content_from(cf::empty_anim_data(), json!([]))),
        None => cf::anim_content_from(cf::empty_anim_data(), json!([])),
    };
    val["anim_data"] = content.get("anim_data").cloned().unwrap_or_else(cf::empty_anim_data);
    val["assets"]    = content.get("assets").cloned().unwrap_or_else(|| json!([]));

    // Le nom du fichier .kbanm fait foi pour le titre (géré par `files`).
    if let Some(fid) = anim.file_id {
        if let Some(fname) = cf::file_name(&state, user.id, fid).await {
            let stem = cf::strip_ext(&fname);
            if !stem.is_empty() && stem != anim.title {
                let _ = store::rename_animation(&state.db, id, &stem).await;
                val["title"] = Value::String(stem);
            }
        }
    }
    Ok(Json(val))
}

// ── Sauvegarder les données d'animation ───────────────────────────────────────

pub async fn save_animation_data(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
    Json(body): Json<Value>,
) -> Result<Json<Value>> {
    if store::mark_edited(&state.db, id, user.id).await? == 0 {
        return Err(PaintsharpError::NotFound(format!("Animation {id}")));
    }

    // anim_data → fichier (en conservant les assets existants).
    let file_id = store::anim_file_id(&state.db, id, user.id).await?;
    let mut content = cf::read_content(&state, user.id, file_id).await
        .unwrap_or_else(|_| cf::anim_content_from(cf::empty_anim_data(), json!([])));
    content["anim_data"] = body;
    cf::write_content(&state, user.id, file_id, &content).await?;

    Ok(Json(json!({ "ok": true })))
}

// ── Mettre à jour les métadonnées ─────────────────────────────────────────────

pub async fn update_animation(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
    Json(body): Json<UpdateAnimationDto>,
) -> Result<Json<Value>> {
    if store::update_animation(&state.db, id, user.id, &body).await? == 0 {
        return Err(PaintsharpError::NotFound(format!("Animation {id}")));
    }

    // Renomme le fichier .kbanm pour refléter le nouveau titre.
    if let Some(t) = body.title.as_ref() {
        if !t.trim().is_empty() {
            if let Ok(fid) = store::anim_file_id(&state.db, id, user.id).await {
                cf::rename_content_file(&state, user.id, fid, t, "kbanm").await;
            }
        }
    }

    Ok(Json(json!({ "ok": true })))
}

// ── Corbeille / Restaurer / Supprimer ─────────────────────────────────────────

pub async fn trash_animation(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    if store::trash_animation(&state.db, id, user.id).await? == 0 {
        return Err(PaintsharpError::NotFound(format!("Animation {id}")));
    }
    Ok(Json(json!({ "ok": true })))
}

pub async fn restore_animation(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    if store::restore_animation(&state.db, id, user.id).await? == 0 {
        return Err(PaintsharpError::NotFound(format!("Animation {id}")));
    }
    Ok(Json(json!({ "ok": true })))
}

pub async fn delete_animation(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    // See scenes::delete — the Drive file must go with the row.
    let Some(file_id) = crate::services::store::delete_trashed_returning_file_id(
        &state.db, "paintsharp.animations", id, user.id,
    )
    .await?
    else {
        return Err(PaintsharpError::NotFound(format!("Animation {id}")));
    };
    cf::delete_entity_files(&state, user.id, file_id).await;
    Ok(Json(json!({ "ok": true })))
}

pub async fn duplicate_animation(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let source = store::get_active_animation(&state.db, id, user.id)
        .await?
        .ok_or_else(|| PaintsharpError::NotFound(format!("Animation {id}")))?;

    let new_title = format!("{} (copie)", source.title);
    let new_id = store::create_animation(&state.db, user.id, &new_title, &source.composition).await?;

    // Copie le fichier de contenu.
    let content = match source.file_id {
        Some(fid) => cf::read_content(&state, user.id, fid).await
            .unwrap_or_else(|_| cf::anim_content_from(cf::empty_anim_data(), json!([]))),
        None => cf::anim_content_from(cf::empty_anim_data(), json!([])),
    };
    let new_file_id = cf::create_anim_file(&state, user.id, &new_title, &content).await?;
    store::set_file_id(&state.db, new_id, new_file_id).await?;

    Ok(Json(json!({ "id": new_id })))
}

// ── Export Lottie ─────────────────────────────────────────────────────────────

pub async fn export_lottie(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
) -> Result<axum::response::Response> {
    use axum::response::IntoResponse;
    use axum::http::header;

    let anim = store::get_animation(&state.db, id, user.id)
        .await?
        .ok_or_else(|| PaintsharpError::NotFound(format!("Animation {id}")))?;

    let fps  = anim.composition.get("fps").and_then(|v| v.as_f64()).unwrap_or(24.0);
    let w    = anim.composition.get("width").and_then(|v| v.as_i64()).unwrap_or(720);
    let h    = anim.composition.get("height").and_then(|v| v.as_i64()).unwrap_or(480);
    let dur  = anim.composition.get("duration_frames").and_then(|v| v.as_i64()).unwrap_or(120);

    // anim_data lu depuis le fichier .kbanm.
    let anim_data = match anim.file_id {
        Some(fid) => cf::read_content(&state, user.id, fid).await
            .ok().and_then(|c| c.get("anim_data").cloned())
            .unwrap_or_else(cf::empty_anim_data),
        None => cf::empty_anim_data(),
    };

    let layers = anim_data.get("layers")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let lottie = json!({
        "v":  "5.9.0",
        "fr": fps,
        "ip": 0,
        "op": dur,
        "w":  w,
        "h":  h,
        "nm": &anim.title,
        "ddd": 0,
        "assets": [],
        "layers": layers.iter().enumerate().map(|(i, l)| {
            let name    = l.get("name").and_then(|v| v.as_str()).unwrap_or("Layer");
            let in_pt   = l.get("inPoint").and_then(|v| v.as_i64()).unwrap_or(0);
            let out_pt  = l.get("outPoint").and_then(|v| v.as_i64()).unwrap_or(dur);
            let visible = l.get("visible").and_then(|v| v.as_bool()).unwrap_or(true);
            json!({
                "nm":  name,
                "ind": i + 1,
                "ty":  3,
                "st":  in_pt,
                "ip":  in_pt,
                "op":  out_pt,
                "hd":  !visible,
                "ks":  {
                    "o":  { "a": 0, "k": 100 },
                    "r":  { "a": 0, "k": 0 },
                    "p":  { "a": 0, "k": [0, 0, 0] },
                    "a":  { "a": 0, "k": [0, 0, 0] },
                    "s":  { "a": 0, "k": [100, 100, 100] }
                }
            })
        }).collect::<Vec<_>>()
    });

    let filename = format!(
        "{}.json",
        anim.title.replace(|c: char| !c.is_alphanumeric() && c != '-', "_")
    );

    Ok((
        [(header::CONTENT_TYPE,        "application/json".to_string()),
         (header::CONTENT_DISPOSITION, format!("attachment; filename=\"{filename}\""))],
        serde_json::to_string_pretty(&lottie).unwrap_or_default(),
    ).into_response())
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
        .ok_or_else(|| PaintsharpError::NotFound(format!("Aucun animation lié au fichier {}", dto.file_id)))?;
    Ok(Json(json!({ "id": id })))
}
