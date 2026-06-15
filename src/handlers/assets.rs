use axum::{
    extract::{Path, Query, State},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use axum::Extension;
use crate::{
    errors::{PaintsharpError, Result},
    middleware::PaintsharpUser,
    models::asset::Asset,
    state::AppState,
};

#[derive(Debug, Deserialize)]
pub struct ListAssetsQuery {
    pub asset_type: Option<String>,
    pub limit:      Option<i64>,
    pub offset:     Option<i64>,
}

pub async fn list(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Query(q): Query<ListAssetsQuery>,
) -> Result<Json<Value>> {
    let limit  = q.limit.unwrap_or(50).min(200);
    let offset = q.offset.unwrap_or(0);

    let assets = if let Some(ref asset_type) = q.asset_type {
        sqlx::query_as::<_, Asset>(
            "SELECT * FROM assets WHERE owner_id = $1 AND asset_type = $2
             ORDER BY created_at DESC LIMIT $3 OFFSET $4",
        )
        .bind(user.id).bind(asset_type).bind(limit).bind(offset)
        .fetch_all(&state.db).await?
    } else {
        sqlx::query_as::<_, Asset>(
            "SELECT * FROM assets WHERE owner_id = $1
             ORDER BY created_at DESC LIMIT $2 OFFSET $3",
        )
        .bind(user.id).bind(limit).bind(offset)
        .fetch_all(&state.db).await?
    };

    Ok(Json(json!({ "assets": assets })))
}

pub async fn delete(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    let rows = sqlx::query(
        "DELETE FROM assets WHERE id = $1 AND owner_id = $2",
    )
    .bind(id).bind(user.id)
    .execute(&state.db).await?.rows_affected();

    if rows == 0 {
        return Err(PaintsharpError::NotFound(id.to_string()));
    }
    Ok(Json(json!({ "ok": true })))
}
