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
    services::store::assets as store,
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

    let assets = store::list(&state.db, user.id, q.asset_type.as_deref(), limit, offset).await?;

    Ok(Json(json!({ "assets": assets })))
}

pub async fn delete(
    State(state): State<AppState>,
    Extension(user): Extension<PaintsharpUser>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>> {
    if store::delete(&state.db, id, user.id).await? == 0 {
        return Err(PaintsharpError::NotFound(id.to_string()));
    }
    Ok(Json(json!({ "ok": true })))
}
