use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct VectorProject {
    pub id:             Uuid,
    pub owner_id:       Uuid,
    pub title:          String,
    pub settings:       serde_json::Value,
    pub thumbnail_path: Option<String>,
    pub file_id:        Option<Uuid>,
    pub is_starred:     bool,
    pub is_trashed:     bool,
    pub trashed_at:     Option<DateTime<Utc>>,
    pub last_edited_by: Option<Uuid>,
    pub created_at:     DateTime<Utc>,
    pub updated_at:     DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct VectorProjectSummary {
    pub id:             Uuid,
    pub owner_id:       Uuid,
    pub title:          String,
    pub thumbnail_path: Option<String>,
    pub is_starred:     bool,
    pub updated_at:     DateTime<Utc>,
    pub created_at:     DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct VectorPage {
    pub id:         Uuid,
    pub project_id: Uuid,
    pub name:       String,
    pub position:   i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct VectorPageSummary {
    pub id:       Uuid,
    pub name:     String,
    pub position: i32,
}

#[derive(Debug, Deserialize)]
pub struct CreateVectorProjectDto {
    pub title: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateVectorProjectDto {
    pub title:          Option<String>,
    pub settings:       Option<serde_json::Value>,
    pub thumbnail_path: Option<String>,
    pub is_starred:     Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct CreateVectorPageDto {
    pub name: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateVectorPageDto {
    pub name: Option<String>,
}
