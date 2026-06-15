use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Asset {
    pub id:            Uuid,
    pub owner_id:      Uuid,
    pub name:          String,
    pub asset_type:    String,
    pub storage_path:  String,
    pub mime_type:     Option<String>,
    pub size_bytes:    i64,
    pub thumbnail_url: Option<String>,
    pub meta:          serde_json::Value,
    pub created_at:    DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct CreateAssetDto {
    pub name:       String,
    pub asset_type: String,
}
