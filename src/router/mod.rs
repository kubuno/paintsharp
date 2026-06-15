use axum::{
    middleware,
    routing::{delete, get, post, put},
    Router,
};
use tower_http::{cors::CorsLayer, trace::TraceLayer};

use crate::{
    handlers::{
        animations, assets, collab_anim, collab_layer, collab_pdf, collab_scene, collab_vector,
        collab_video, health, layer_docs, pdf, scenes, vectors, video,
    },
    middleware::require_auth,
    state::AppState,
};

pub fn build(state: AppState) -> Router {
    let authed = Router::new()
        // ── Vertex : scènes 3D ────────────────────────────────────────────────
        .route("/scenes",                  get(scenes::list).post(scenes::create))
        .route("/scenes/open-by-file",     post(scenes::open_by_file))
        .route("/scenes/:id",              get(scenes::get).patch(scenes::update))
        .route("/scenes/:id/trash",        post(scenes::trash))
        .route("/scenes/:id/restore",      post(scenes::restore))
        .route("/scenes/:id/delete",       delete(scenes::delete))
        .route("/scenes/:id/collab",       get(collab_scene::ws_handler))
        // Assets 3D
        .route("/assets",                  get(assets::list))
        .route("/assets/:id",              delete(assets::delete))
        // ── Apex : projets vectoriels ─────────────────────────────────────────
        .route("/vectors",                 get(vectors::list_projects).post(vectors::create_project))
        .route("/vectors/open-by-file",    post(vectors::open_by_file))
        .route("/vectors/:id",             get(vectors::get_project).patch(vectors::update_project))
        .route("/vectors/:id/trash",       post(vectors::trash_project))
        .route("/vectors/:id/restore",     post(vectors::restore_project))
        .route("/vectors/:id/delete",      delete(vectors::delete_project))
        .route("/vectors/:id/duplicate",   post(vectors::duplicate_project))
        .route("/vectors/:id/pages",       get(vectors::list_pages).post(vectors::create_page))
        .route("/vectors/:id/pages/:pid",  get(vectors::get_page).patch(vectors::rename_page).delete(vectors::delete_page))
        .route("/vectors/:id/pages/:pid/data", put(vectors::save_page_data))
        .route("/collab/vector/:page_id",  get(collab_vector::ws_handler))
        // ── Layer : documents raster ──────────────────────────────────────────
        .route("/layer-docs",                   get(layer_docs::list_docs).post(layer_docs::create_doc))
        .route("/layer-docs/open-by-file",     post(layer_docs::open_by_file))
        .route("/layer-docs/:id",               get(layer_docs::get_doc).patch(layer_docs::update_doc))
        .route("/layer-docs/:id/trash",         post(layer_docs::trash_doc))
        .route("/layer-docs/:id/restore",       post(layer_docs::restore_doc))
        .route("/layer-docs/:id/delete",        delete(layer_docs::delete_doc))
        .route("/layer-docs/:id/duplicate",     post(layer_docs::duplicate_doc))
        .route("/layer-docs/:id/structure",     put(layer_docs::save_structure))
        .route("/collab/layer/:doc_id",         get(collab_layer::ws_handler))
        // ── Keyframe : animations 2D ──────────────────────────────────────────
        .route("/animations",                   get(animations::list_animations).post(animations::create_animation))
        .route("/animations/open-by-file",     post(animations::open_by_file))
        .route("/animations/:id",               get(animations::get_animation).patch(animations::update_animation))
        .route("/animations/:id/data",          put(animations::save_animation_data))
        .route("/animations/:id/trash",         post(animations::trash_animation))
        .route("/animations/:id/restore",       post(animations::restore_animation))
        .route("/animations/:id/delete",        delete(animations::delete_animation))
        .route("/animations/:id/duplicate",     post(animations::duplicate_animation))
        .route("/animations/:id/export/lottie", get(animations::export_lottie))
        .route("/collab/animation/:anim_id",    get(collab_anim::ws_handler))
        // ── Motion : projets vidéo ────────────────────────────────────────────
        .route("/video-projects",                               get(video::list_video_projects).post(video::create_video_project))
        .route("/video-projects/open-by-file",                 post(video::open_by_file))
        .route("/video-projects/:id",                           get(video::get_video_project).patch(video::update_video_project))
        .route("/video-projects/:id/timeline",                  put(video::save_timeline_data))
        .route("/video-projects/:id/trash",                     post(video::trash_video_project))
        .route("/video-projects/:id/restore",                   post(video::restore_video_project))
        .route("/video-projects/:id/delete",                    delete(video::delete_video_project))
        .route("/video-projects/:id/duplicate",                 post(video::duplicate_video_project))
        .route("/video-projects/:id/media",                     get(video::list_media).post(video::import_media))
        .route("/video-projects/:id/media/from-file",           post(video::import_media_from_file))
        .route("/video-projects/:id/media/:mid/stream",         get(video::stream_media))
        .route("/video-projects/:id/render-jobs",               get(video::list_render_jobs).post(video::create_render_job))
        .route("/video-projects/:id/render-jobs/:jid",          get(video::get_render_job))
        .route("/collab/video/:project_id",                     get(collab_video::ws_handler))
        // ── PdfWriter : documents PDF ─────────────────────────────────────────
        .route("/pdf-docs",                              get(pdf::list_documents).post(pdf::create_document))
        .route("/pdf-docs/open-by-file",                post(pdf::open_by_file))
        .route("/pdf-docs/import",                       post(pdf::import_document))
        .route("/pdf-docs/:id",                          get(pdf::get_document).patch(pdf::update_document))
        .route("/pdf-docs/:id/trash",                    post(pdf::trash_document))
        .route("/pdf-docs/:id/restore",                  post(pdf::restore_document))
        .route("/pdf-docs/:id/delete",                   delete(pdf::delete_document))
        .route("/pdf-docs/:id/duplicate",                post(pdf::duplicate_document))
        .route("/pdf-docs/:id/source",                   get(pdf::get_source))
        .route("/pdf-docs/:id/pages",                    get(pdf::list_pages))
        .route("/pdf-docs/:id/pages/:page_num",          get(pdf::get_page).put(pdf::save_page).delete(pdf::delete_page))
        .route("/pdf-docs/:id/pages/:page_num/rotate",   post(pdf::rotate_page))
        .route("/pdf-docs/:id/pages/add",                post(pdf::add_page))
        .route("/pdf-docs/:id/pages/reorder",            post(pdf::reorder_pages))
        .route("/pdf-signatures",                        get(pdf::list_signatures).post(pdf::create_signature))
        .route("/pdf-signatures/:id",                    delete(pdf::delete_signature))
        .route("/collab/pdf/:doc_id",                    get(collab_pdf::ws_handler))
        // Paramètres du module
        .route("/settings",                get(settings_handler))
        .layer(middleware::from_fn(require_auth));

    Router::new()
        .route("/health", get(health::health))
        .nest("/", authed)
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

async fn settings_handler() -> axum::Json<serde_json::Value> {
    axum::Json(serde_json::json!({
        "module":     "paintsharp",
        "version":    env!("CARGO_PKG_VERSION"),
        "submodules": ["vertex", "apex", "layer", "keyframe", "motion", "pdfwriter"]
    }))
}
