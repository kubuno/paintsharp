use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct LayerDocument {
    pub id:               Uuid,
    pub owner_id:         Uuid,
    pub title:            String,
    pub width:            i32,
    pub height:           i32,
    pub color_mode:       String,
    pub bit_depth:        i32,
    pub dpi:              i32,
    pub file_id:          Option<Uuid>,
    pub thumbnail_path:   Option<String>,
    pub layer_count:      i32,
    pub is_starred:       bool,
    pub is_trashed:       bool,
    pub created_at:       DateTime<Utc>,
    pub updated_at:       DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct LayerDocumentSummary {
    pub id:             Uuid,
    pub owner_id:       Uuid,
    pub title:          String,
    pub width:          i32,
    pub height:         i32,
    pub color_mode:     String,
    pub thumbnail_path: Option<String>,
    pub is_starred:     bool,
    pub layer_count:    i32,
    pub updated_at:     DateTime<Utc>,
    pub created_at:     DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct LayerData {
    pub id:              Uuid,
    pub document_id:     Uuid,
    pub layer_id:        String,
    pub storage_path:    String,
    pub size_bytes:      i64,
    pub created_at:      DateTime<Utc>,
    pub updated_at:      DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct CreateLayerDocDto {
    pub title:      Option<String>,
    pub width:      Option<i32>,
    pub height:     Option<i32>,
    pub color_mode: Option<String>,
    pub bit_depth:  Option<i32>,
    pub dpi:        Option<i32>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateLayerDocDto {
    pub title:            Option<String>,
    pub layers_structure: Option<serde_json::Value>,
    pub view_settings:    Option<serde_json::Value>,
    pub thumbnail_path:   Option<String>,
    pub thumbnail_dirty:  Option<bool>,
    pub is_starred:       Option<bool>,
}
