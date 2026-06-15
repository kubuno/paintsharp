use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Scene {
    pub id:             Uuid,
    pub owner_id:       Uuid,
    pub title:          String,
    pub description:    Option<String>,
    pub file_id:        Option<Uuid>,
    pub thumbnail_url:  Option<String>,
    pub is_starred:     bool,
    pub is_trashed:     bool,
    pub trashed_at:     Option<DateTime<Utc>>,
    pub vertex_count:   i32,
    pub face_count:     i32,
    pub last_editor_id: Option<Uuid>,
    pub created_at:     DateTime<Utc>,
    pub updated_at:     DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct SceneSummary {
    pub id:            Uuid,
    pub owner_id:      Uuid,
    pub title:         String,
    pub description:   Option<String>,
    pub thumbnail_url: Option<String>,
    pub is_starred:    bool,
    pub vertex_count:  i32,
    pub face_count:    i32,
    pub updated_at:    DateTime<Utc>,
    pub created_at:    DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct CreateSceneDto {
    pub title:       Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateSceneDto {
    pub title:          Option<String>,
    pub description:    Option<String>,
    pub scene_json:     Option<serde_json::Value>,
    pub thumbnail_url:  Option<String>,
    pub is_starred:     Option<bool>,
    pub vertex_count:   Option<i32>,
    pub face_count:     Option<i32>,
}
