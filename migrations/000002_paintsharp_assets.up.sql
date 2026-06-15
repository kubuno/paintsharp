CREATE TABLE IF NOT EXISTS assets (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    owner_id        UUID NOT NULL,
    name            VARCHAR(500) NOT NULL,
    asset_type      VARCHAR(50) NOT NULL
                        CHECK (asset_type IN ('mesh', 'texture', 'material', 'hdri', 'other')),
    -- Chemin dans le storage kubuno (module files ou stockage interne)
    storage_path    VARCHAR(1000) NOT NULL,
    mime_type       VARCHAR(100),
    size_bytes      BIGINT NOT NULL DEFAULT 0,
    thumbnail_url   VARCHAR(1000),
    -- Métadonnées Three.js (format, vertex count, etc.)
    meta            JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_paintsharp_assets_owner ON assets(owner_id);
CREATE INDEX idx_paintsharp_assets_type  ON assets(owner_id, asset_type);

-- Table de liaison scène ↔ assets
CREATE TABLE IF NOT EXISTS scene_assets (
    scene_id    UUID NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
    asset_id    UUID NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    PRIMARY KEY (scene_id, asset_id)
);
