-- =====================
-- PROJETS DE POLICES (FontEditor)
-- =====================
-- Self-sufficient: (re)create the shared updated_at trigger function — some
-- installs (pre-rename schemas) do not expose it under this name.
CREATE OR REPLACE FUNCTION paintsharp_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

-- Métadonnées seulement : le contenu (glyphes, métriques, crénage) vit dans un
-- fichier Kubuno `.kbfnt` du module files (voir services/content_files.rs).
CREATE TABLE IF NOT EXISTS font_projects (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    owner_id        UUID NOT NULL,
    title           VARCHAR(500) NOT NULL DEFAULT 'Police sans titre',
    thumbnail_path  TEXT,
    file_id         UUID,
    glyph_count     INTEGER NOT NULL DEFAULT 0,
    is_starred      BOOLEAN NOT NULL DEFAULT FALSE,
    is_trashed      BOOLEAN NOT NULL DEFAULT FALSE,
    trashed_at      TIMESTAMPTZ,
    last_edited_by  UUID,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_paintsharp_fp_owner   ON font_projects(owner_id) WHERE is_trashed = FALSE;
CREATE INDEX IF NOT EXISTS idx_paintsharp_fp_starred ON font_projects(owner_id, is_starred) WHERE is_starred = TRUE AND is_trashed = FALSE;
CREATE INDEX IF NOT EXISTS idx_paintsharp_fp_trashed ON font_projects(owner_id, trashed_at) WHERE is_trashed = TRUE;
CREATE INDEX IF NOT EXISTS idx_paintsharp_fp_updated ON font_projects(owner_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_paintsharp_fp_file    ON font_projects(file_id);

CREATE TRIGGER font_projects_updated_at
    BEFORE UPDATE ON font_projects
    FOR EACH ROW EXECUTE FUNCTION paintsharp_set_updated_at();
