CREATE TABLE IF NOT EXISTS scenes (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    owner_id        UUID NOT NULL,
    title           VARCHAR(500) NOT NULL DEFAULT 'Sans titre',
    description     TEXT,
    -- Scène Three.js sérialisée (scene.toJSON())
    scene_json      JSONB NOT NULL DEFAULT '{"metadata":{"version":4.6,"type":"Scene"},"object":{"type":"Scene","children":[]}}',
    thumbnail_url   VARCHAR(1000),
    is_starred      BOOLEAN NOT NULL DEFAULT FALSE,
    is_trashed      BOOLEAN NOT NULL DEFAULT FALSE,
    trashed_at      TIMESTAMPTZ,
    -- Statistiques
    vertex_count    INTEGER NOT NULL DEFAULT 0,
    face_count      INTEGER NOT NULL DEFAULT 0,
    -- Collaborateurs
    last_editor_id  UUID,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_paintsharp_scenes_owner   ON scenes(owner_id) WHERE is_trashed = FALSE;
CREATE INDEX idx_paintsharp_scenes_starred ON scenes(owner_id, is_starred) WHERE is_starred = TRUE AND is_trashed = FALSE;
CREATE INDEX idx_paintsharp_scenes_trashed ON scenes(owner_id, trashed_at) WHERE is_trashed = TRUE;

CREATE OR REPLACE FUNCTION paintsharp_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER scenes_updated_at
    BEFORE UPDATE ON scenes
    FOR EACH ROW EXECUTE FUNCTION paintsharp_set_updated_at();

CREATE TABLE IF NOT EXISTS scene_collaborators (
    scene_id    UUID NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
    user_id     UUID NOT NULL,
    permission  VARCHAR(20) NOT NULL DEFAULT 'view'
                    CHECK (permission IN ('view', 'edit')),
    added_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (scene_id, user_id)
);

CREATE TABLE IF NOT EXISTS scene_shares (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    scene_id    UUID NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
    token       VARCHAR(64) UNIQUE NOT NULL,
    permission  VARCHAR(20) NOT NULL DEFAULT 'view'
                    CHECK (permission IN ('view', 'edit')),
    expires_at  TIMESTAMPTZ,
    created_by  UUID NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_paintsharp_shares_scene ON scene_shares(scene_id);
CREATE INDEX idx_paintsharp_shares_token ON scene_shares(token);
