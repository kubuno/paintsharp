CREATE TABLE paintsharp.assets (
    id              BLOB    NOT NULL PRIMARY KEY,
    owner_id        BLOB    NOT NULL,
    name            TEXT    NOT NULL,
    asset_type      TEXT    NOT NULL
                        CHECK (asset_type IN ('mesh','texture','material','hdri','other')),
    storage_path    TEXT    NOT NULL,
    mime_type       TEXT,
    size_bytes      INTEGER NOT NULL DEFAULT 0,
    thumbnail_url   TEXT,
    meta            TEXT    NOT NULL DEFAULT '{}',
    created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
);
CREATE INDEX paintsharp.idx_paintsharp_assets_owner ON assets(owner_id);
CREATE INDEX paintsharp.idx_paintsharp_assets_type  ON assets(owner_id, asset_type);

CREATE TABLE paintsharp.scene_assets (
    scene_id    BLOB NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
    asset_id    BLOB NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    PRIMARY KEY (scene_id, asset_id)
);
