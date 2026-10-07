//! Asset rows (3D meshes/textures/… attached to scenes). Pool-only.

use kubuno_db::{params, DbPool};
use uuid::Uuid;

use crate::errors::Result;
use crate::models::asset::Asset;

pub async fn list(
    db: &DbPool,
    owner: Uuid,
    asset_type: Option<&str>,
    limit: i64,
    offset: i64,
) -> Result<Vec<Asset>> {
    if let Some(t) = asset_type {
        Ok(db
            .fetch_all_as::<Asset>(
                "SELECT * FROM paintsharp.assets WHERE owner_id = $1 AND asset_type = $2
                 ORDER BY created_at DESC LIMIT $3 OFFSET $4",
                params![owner, t, limit, offset],
            )
            .await?)
    } else {
        Ok(db
            .fetch_all_as::<Asset>(
                "SELECT * FROM paintsharp.assets WHERE owner_id = $1
                 ORDER BY created_at DESC LIMIT $2 OFFSET $3",
                params![owner, limit, offset],
            )
            .await?)
    }
}

pub async fn delete(db: &DbPool, id: Uuid, owner: Uuid) -> Result<u64> {
    Ok(db
        .execute(
            "DELETE FROM paintsharp.assets WHERE id = $1 AND owner_id = $2",
            params![id, owner],
        )
        .await?)
}
