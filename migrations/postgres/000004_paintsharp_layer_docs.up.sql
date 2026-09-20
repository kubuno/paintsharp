-- 000004_paintsharp_layer_docs.up.sql
-- Layer : éditeur d'images matricielles

CREATE TABLE paintsharp.layer_documents (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    owner_id         UUID NOT NULL,
    title            VARCHAR(500) NOT NULL DEFAULT 'image_sans_titre',
    width            INTEGER NOT NULL DEFAULT 1920,
    height           INTEGER NOT NULL DEFAULT 1080,
    color_mode       VARCHAR(10) NOT NULL DEFAULT 'rgba',
    bit_depth        INTEGER NOT NULL DEFAULT 8,
    dpi              INTEGER NOT NULL DEFAULT 72,
    layers_structure JSONB NOT NULL DEFAULT '[]',
    command_history  JSONB NOT NULL DEFAULT '[]',
    view_settings    JSONB NOT NULL DEFAULT '{"zoom":1.0,"panX":0,"panY":0,"showGuides":true,"showGrid":false,"gridSize":32}',
    thumbnail_path   TEXT,
    thumbnail_dirty  BOOLEAN NOT NULL DEFAULT TRUE,
    layer_count      INTEGER NOT NULL DEFAULT 1,
    is_starred       BOOLEAN NOT NULL DEFAULT FALSE,
    is_trashed       BOOLEAN NOT NULL DEFAULT FALSE,
    trashed_at       TIMESTAMPTZ,
    last_edited_by   UUID,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_paintsharp_ld_owner   ON paintsharp.layer_documents(owner_id);
CREATE INDEX idx_paintsharp_ld_updated ON paintsharp.layer_documents(owner_id, updated_at DESC);
CREATE INDEX idx_paintsharp_ld_trashed ON paintsharp.layer_documents(owner_id, trashed_at DESC) WHERE is_trashed = TRUE;
CREATE INDEX idx_paintsharp_ld_starred ON paintsharp.layer_documents(owner_id) WHERE is_starred = TRUE AND is_trashed = FALSE;

CREATE TRIGGER layer_documents_updated_at
    BEFORE UPDATE ON paintsharp.layer_documents
    FOR EACH ROW EXECUTE FUNCTION paintsharp_set_updated_at();

CREATE TABLE paintsharp.layer_data (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    document_id     UUID NOT NULL REFERENCES paintsharp.layer_documents(id) ON DELETE CASCADE,
    layer_id        VARCHAR(36) NOT NULL,
    storage_path    TEXT NOT NULL,
    checksum_sha256 VARCHAR(64),
    size_bytes      BIGINT NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (document_id, layer_id)
);

CREATE INDEX idx_paintsharp_layer_data_doc ON paintsharp.layer_data(document_id);

CREATE TRIGGER layer_data_updated_at
    BEFORE UPDATE ON paintsharp.layer_data
    FOR EACH ROW EXECUTE FUNCTION paintsharp_set_updated_at();
