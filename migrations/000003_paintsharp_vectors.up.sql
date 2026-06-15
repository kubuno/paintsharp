-- =====================
-- PROJETS VECTORIELS (Apex)
-- =====================
CREATE TABLE IF NOT EXISTS vector_projects (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    owner_id        UUID NOT NULL,
    title           VARCHAR(500) NOT NULL DEFAULT 'Projet sans titre',
    settings        JSONB NOT NULL DEFAULT '{
        "snapToGrid":    true,
        "snapToPixel":   true,
        "snapToObjects": true,
        "gridSize":      8,
        "showGrid":      false,
        "showGuides":    true,
        "showRulers":    true
    }',
    thumbnail_path  TEXT,
    is_starred      BOOLEAN NOT NULL DEFAULT FALSE,
    is_trashed      BOOLEAN NOT NULL DEFAULT FALSE,
    trashed_at      TIMESTAMPTZ,
    last_edited_by  UUID,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_paintsharp_vp_owner   ON vector_projects(owner_id) WHERE is_trashed = FALSE;
CREATE INDEX IF NOT EXISTS idx_paintsharp_vp_starred ON vector_projects(owner_id, is_starred) WHERE is_starred = TRUE AND is_trashed = FALSE;
CREATE INDEX IF NOT EXISTS idx_paintsharp_vp_trashed ON vector_projects(owner_id, trashed_at) WHERE is_trashed = TRUE;
CREATE INDEX IF NOT EXISTS idx_paintsharp_vp_updated ON vector_projects(owner_id, updated_at DESC);

CREATE TRIGGER vector_projects_updated_at
    BEFORE UPDATE ON vector_projects
    FOR EACH ROW EXECUTE FUNCTION paintsharp_set_updated_at();

-- =====================
-- PAGES D'UN PROJET
-- =====================
CREATE TABLE IF NOT EXISTS vector_pages (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id  UUID NOT NULL REFERENCES vector_projects(id) ON DELETE CASCADE,
    name        VARCHAR(255) NOT NULL DEFAULT 'Page 1',
    position    INTEGER NOT NULL DEFAULT 0,
    -- { "artboards": [...], "elements": [...], "guides": [] }
    data        JSONB NOT NULL DEFAULT '{"artboards":[],"elements":[],"guides":[]}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_paintsharp_vpp_project ON vector_pages(project_id, position);

CREATE TRIGGER vector_pages_updated_at
    BEFORE UPDATE ON vector_pages
    FOR EACH ROW EXECUTE FUNCTION paintsharp_set_updated_at();

-- =====================
-- PARTAGE
-- =====================
CREATE TABLE IF NOT EXISTS vector_shares (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id  UUID NOT NULL REFERENCES vector_projects(id) ON DELETE CASCADE,
    created_by  UUID NOT NULL,
    token       VARCHAR(64) UNIQUE NOT NULL DEFAULT (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')),
    shared_with UUID,
    permission  VARCHAR(10) NOT NULL DEFAULT 'read'
                    CHECK (permission IN ('read', 'edit')),
    expires_at  TIMESTAMPTZ,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_paintsharp_vs_token ON vector_shares(token) WHERE is_active = TRUE;
