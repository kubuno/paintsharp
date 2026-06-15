use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum PaintsharpError {
    #[error("Non authentifié")]
    Unauthorized,

    #[error("Accès refusé")]
    Forbidden,

    #[error("Ressource introuvable: {0}")]
    NotFound(String),

    #[error("Données invalides: {0}")]
    Validation(String),

    #[error("Conflit: {0}")]
    Conflict(String),

    #[error("Erreur base de données")]
    Database(#[from] sqlx::Error),

    #[error("Erreur interne")]
    Internal(#[from] anyhow::Error),
}

impl IntoResponse for PaintsharpError {
    fn into_response(self) -> Response {
        let (status, code, message) = match &self {
            PaintsharpError::Unauthorized  => (StatusCode::UNAUTHORIZED,         "UNAUTHORIZED", self.to_string()),
            PaintsharpError::Forbidden     => (StatusCode::FORBIDDEN,            "FORBIDDEN",    self.to_string()),
            PaintsharpError::NotFound(_)   => (StatusCode::NOT_FOUND,            "NOT_FOUND",    self.to_string()),
            PaintsharpError::Validation(_) => (StatusCode::UNPROCESSABLE_ENTITY, "VALIDATION",   self.to_string()),
            PaintsharpError::Conflict(_)   => (StatusCode::CONFLICT,             "CONFLICT",     self.to_string()),
            PaintsharpError::Database(e) => {
                tracing::error!(error = %e, "Database error");
                (StatusCode::INTERNAL_SERVER_ERROR, "DATABASE_ERROR", "Erreur base de données".to_string())
            }
            PaintsharpError::Internal(e) => {
                tracing::error!(error = %e, "Internal error");
                (StatusCode::INTERNAL_SERVER_ERROR, "INTERNAL_ERROR", "Erreur interne".to_string())
            }
        };
        (status, Json(json!({ "error": code, "message": message }))).into_response()
    }
}

pub type Result<T> = std::result::Result<T, PaintsharpError>;
