use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Debug, Serialize, FromRow)]
pub struct VideoProjectSummary {
    pub id:             Uuid,
    pub owner_id:       Uuid,
    pub title:          String,
    pub composition:    sqlx::types::JsonValue,
    pub thumbnail_path: Option<String>,
    pub thumbnail_dirty: bool,
    pub is_trashed:     bool,
    pub updated_at:     DateTime<Utc>,
    pub created_at:     DateTime<Utc>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct VideoProject {
    pub id:              Uuid,
    pub owner_id:        Uuid,
    pub title:           String,
    pub composition:     sqlx::types::JsonValue,
    pub render_settings: sqlx::types::JsonValue,
    pub file_id:         Option<Uuid>,
    pub thumbnail_path:  Option<String>,
    pub thumbnail_dirty: bool,
    pub is_trashed:      bool,
    pub last_edited_by:  Option<Uuid>,
    pub updated_at:      DateTime<Utc>,
    pub created_at:      DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct CreateVideoProjectDto {
    pub title:       Option<String>,
    pub composition: Option<sqlx::types::JsonValue>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateVideoProjectDto {
    pub title:           Option<String>,
    pub composition:     Option<sqlx::types::JsonValue>,
    pub render_settings: Option<sqlx::types::JsonValue>,
    pub thumbnail_path:  Option<String>,
    pub thumbnail_dirty: Option<bool>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct VideoMedia {
    pub id:             Uuid,
    pub project_id:     Uuid,
    pub owner_id:       Uuid,
    pub storage_path:   String,
    pub original_name:  String,
    pub mime_type:      String,
    pub size_bytes:     i64,
    pub probe_data:     sqlx::types::JsonValue,
    pub thumbnails_path: Option<String>,
    pub waveform_path:  Option<String>,
    pub status:         String,
    pub error_message:  Option<String>,
    pub created_at:     DateTime<Utc>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct RenderJob {
    pub id:            Uuid,
    pub project_id:    Uuid,
    pub owner_id:      Uuid,
    pub render_options: sqlx::types::JsonValue,
    pub output_path:   Option<String>,
    pub output_url:    Option<String>,
    pub status:        String,
    pub progress:      i16,
    pub frame_current: i32,
    pub frame_total:   i32,
    pub error_message: Option<String>,
    pub started_at:    Option<DateTime<Utc>>,
    pub finished_at:   Option<DateTime<Utc>>,
    pub created_at:    DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct CreateRenderJobDto {
    pub render_options: Option<sqlx::types::JsonValue>,
}
