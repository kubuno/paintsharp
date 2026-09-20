-- 000005_paintsharp_animations.up.sql
-- Keyframe : éditeur d'animation 2D

CREATE TABLE paintsharp.animations (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    owner_id         UUID NOT NULL,
    title            VARCHAR(500) NOT NULL DEFAULT 'Animation sans titre',
    composition      JSONB NOT NULL DEFAULT '{
        "width":           720,
        "height":          480,
        "fps":             24,
        "duration_frames": 120,
        "background":      "#1a1a2e",
        "pixelRatio":      1
    }',
    anim_data        JSONB NOT NULL DEFAULT '{"layers":[],"bones":[]}',
    assets           JSONB NOT NULL DEFAULT '[]',
    yjs_state        BYTEA,
    thumbnail_path   TEXT,
    thumbnail_dirty  BOOLEAN NOT NULL DEFAULT TRUE,
    is_trashed       BOOLEAN NOT NULL DEFAULT FALSE,
    trashed_at       TIMESTAMPTZ,
    last_edited_by   UUID,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_paintsharp_anim_owner   ON paintsharp.animations(owner_id);
CREATE INDEX idx_paintsharp_anim_updated ON paintsharp.animations(owner_id, updated_at DESC);
CREATE INDEX idx_paintsharp_anim_trashed ON paintsharp.animations(owner_id, trashed_at DESC) WHERE is_trashed = TRUE;

CREATE TRIGGER animations_updated_at
    BEFORE UPDATE ON paintsharp.animations
    FOR EACH ROW EXECUTE FUNCTION paintsharp_set_updated_at();

CREATE TABLE paintsharp.animation_shares (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    animation_id UUID NOT NULL REFERENCES paintsharp.animations(id) ON DELETE CASCADE,
    created_by   UUID NOT NULL,
    token        VARCHAR(64) UNIQUE NOT NULL DEFAULT (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')),
    shared_with  UUID,
    permission   VARCHAR(10) NOT NULL DEFAULT 'read'
                     CHECK (permission IN ('read', 'edit')),
    allow_export BOOLEAN NOT NULL DEFAULT FALSE,
    expires_at   TIMESTAMPTZ,
    is_active    BOOLEAN NOT NULL DEFAULT TRUE,
    view_count   INTEGER NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_paintsharp_as_token ON paintsharp.animation_shares(token) WHERE is_active = TRUE;
