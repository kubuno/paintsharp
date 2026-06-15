use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Animation {
    pub id:              Uuid,
    pub owner_id:        Uuid,
    pub title:           String,
    pub composition:     serde_json::Value,
    pub file_id:         Option<Uuid>,
    pub thumbnail_path:  Option<String>,
    pub thumbnail_dirty: bool,
    pub is_trashed:      bool,
    pub trashed_at:      Option<DateTime<Utc>>,
    pub last_edited_by:  Option<Uuid>,
    pub created_at:      DateTime<Utc>,
    pub updated_at:      DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct AnimationSummary {
    pub id:              Uuid,
    pub owner_id:        Uuid,
    pub title:           String,
    pub composition:     serde_json::Value,
    pub thumbnail_path:  Option<String>,
    pub thumbnail_dirty: bool,
    pub updated_at:      DateTime<Utc>,
    pub created_at:      DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct CreateAnimationDto {
    pub title:       Option<String>,
    pub composition: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateAnimationDto {
    pub title:           Option<String>,
    pub composition:     Option<serde_json::Value>,
    pub thumbnail_path:  Option<String>,
    pub thumbnail_dirty: Option<bool>,
}
