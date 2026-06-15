use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct PdfDocument {
    pub id:             Uuid,
    pub owner_id:       Uuid,
    pub title:          String,
    pub source_path:    Option<String>,
    pub page_count:     i32,
    pub thumbnail_path: Option<String>,
    pub settings:       serde_json::Value,
    pub file_id:        Option<Uuid>,
    pub is_starred:     bool,
    pub is_trashed:     bool,
    pub trashed_at:     Option<DateTime<Utc>>,
    pub last_edited_by: Option<Uuid>,
    pub created_at:     DateTime<Utc>,
    pub updated_at:     DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct PdfDocumentSummary {
    pub id:             Uuid,
    pub owner_id:       Uuid,
    pub title:          String,
    pub page_count:     i32,
    pub thumbnail_path: Option<String>,
    pub is_starred:     bool,
    pub updated_at:     DateTime<Utc>,
    pub created_at:     DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct PdfPage {
    pub id:          Uuid,
    pub document_id: Uuid,
    pub page_number: i32,
    pub width:       f64,
    pub height:      f64,
    pub rotation:    i32,
    pub created_at:  DateTime<Utc>,
    pub updated_at:  DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct PdfPageSummary {
    pub id:          Uuid,
    pub page_number: i32,
    pub width:       f64,
    pub height:      f64,
    pub rotation:    i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct PdfSignature {
    pub id:         Uuid,
    pub owner_id:   Uuid,
    pub name:       String,
    pub sig_type:   String,
    pub data:       String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct CreatePdfDocumentDto {
    pub title:      Option<String>,
    pub page_count: Option<i32>,
    pub width:      Option<f64>,
    pub height:     Option<f64>,
}

#[derive(Debug, Deserialize)]
pub struct UpdatePdfDocumentDto {
    pub title:          Option<String>,
    pub thumbnail_path: Option<String>,
    pub is_starred:     Option<bool>,
    pub settings:       Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
pub struct SavePageDto {
    pub annotations: serde_json::Value,
    pub form_data:   Option<serde_json::Value>,
    pub rotation:    Option<i32>,
}

#[derive(Debug, Deserialize)]
pub struct CreateSignatureDto {
    pub name:     Option<String>,
    pub sig_type: Option<String>,
    pub data:     String,
}

#[derive(Debug, Deserialize)]
pub struct AddPageDto {
    pub width:  Option<f64>,
    pub height: Option<f64>,
    pub after:  Option<i32>,
}
