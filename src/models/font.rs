use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct FontProject {
    pub id:             Uuid,
    pub owner_id:       Uuid,
    pub title:          String,
    pub thumbnail_path: Option<String>,
    pub file_id:        Option<Uuid>,
    pub glyph_count:    i32,
    pub is_starred:     bool,
    pub is_trashed:     bool,
    pub trashed_at:     Option<DateTime<Utc>>,
    pub last_edited_by: Option<Uuid>,
    pub created_at:     DateTime<Utc>,
    pub updated_at:     DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct FontProjectSummary {
    pub id:             Uuid,
    pub owner_id:       Uuid,
    pub title:          String,
    pub thumbnail_path: Option<String>,
    pub glyph_count:    i32,
    pub is_starred:     bool,
    pub updated_at:     DateTime<Utc>,
    pub created_at:     DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct CreateFontProjectDto {
    pub title: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateFontProjectDto {
    pub title:          Option<String>,
    pub thumbnail_path: Option<String>,
    pub is_starred:     Option<bool>,
}
