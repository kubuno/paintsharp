use crate::state::AppState;
use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};

/// Guard shared by the six real-time editors (Vertex, Apex, Layer, Keyframe,
/// Motion, PdfWriter): when the administrator turned collaborative editing off
/// for the instance, the WebSocket upgrade is refused outright rather than
/// silently accepted and left mute. Returns the refusal to send back, or `None`
/// when collaboration is allowed.
pub fn collaboration_refusal(state: &AppState) -> Option<Response> {
    if state.instance().enable_collaboration {
        return None;
    }
    Some(
        (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({
                "error":   "COLLABORATION_DISABLED",
                "message": "L'édition collaborative est désactivée sur cette instance",
            })),
        )
            .into_response(),
    )
}

pub mod animations;
pub mod assets;
pub mod collab_anim;
pub mod collab_layer;
pub mod collab_pdf;
pub mod collab_scene;
pub mod collab_video;
pub mod collab_vector;
pub mod fonts;
pub mod health;
pub mod layer_docs;
pub mod pdf;
pub mod scenes;
pub mod vectors;
pub mod video;
