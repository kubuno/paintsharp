CREATE TABLE paintsharp.assets (
    id              BINARY(16)   NOT NULL PRIMARY KEY,
    owner_id        BINARY(16)   NOT NULL,
    name            VARCHAR(500) NOT NULL,
    asset_type      VARCHAR(50)  NOT NULL
                        CHECK (asset_type IN ('mesh','texture','material','hdri','other')),
    storage_path    VARCHAR(1000) NOT NULL,
    mime_type       VARCHAR(100),
    size_bytes      BIGINT       NOT NULL DEFAULT 0,
    thumbnail_url   VARCHAR(1000),
    meta            JSON         NOT NULL DEFAULT (_utf8mb4'{}'),
    created_at      DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
);
CREATE INDEX idx_paintsharp_assets_owner ON paintsharp.assets(owner_id);
CREATE INDEX idx_paintsharp_assets_type  ON paintsharp.assets(owner_id, asset_type);

CREATE TABLE paintsharp.scene_assets (
    scene_id    BINARY(16) NOT NULL,
    asset_id    BINARY(16) NOT NULL,
    PRIMARY KEY (scene_id, asset_id),
    FOREIGN KEY (scene_id) REFERENCES paintsharp.scenes(id) ON DELETE CASCADE,
    FOREIGN KEY (asset_id) REFERENCES paintsharp.assets(id) ON DELETE CASCADE
);
