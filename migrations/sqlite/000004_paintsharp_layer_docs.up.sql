CREATE TABLE paintsharp.layer_documents (
    id               BLOB    NOT NULL PRIMARY KEY,
    owner_id         BLOB    NOT NULL,
    title            TEXT    NOT NULL DEFAULT 'image_sans_titre',
    width            INTEGER NOT NULL DEFAULT 1920,
    height           INTEGER NOT NULL DEFAULT 1080,
    color_mode       TEXT    NOT NULL DEFAULT 'rgba',
    bit_depth        INTEGER NOT NULL DEFAULT 8,
    dpi              INTEGER NOT NULL DEFAULT 72,
    thumbnail_path   TEXT,
    thumbnail_dirty  BOOLEAN NOT NULL DEFAULT 1,
    layer_count      INTEGER NOT NULL DEFAULT 1,
    is_starred       BOOLEAN NOT NULL DEFAULT 0,
    is_trashed       BOOLEAN NOT NULL DEFAULT 0,
    trashed_at       TEXT,
    last_edited_by   BLOB,
    file_id          BLOB,
    created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
    updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
);
CREATE INDEX paintsharp.idx_paintsharp_ld_owner   ON layer_documents(owner_id);
CREATE INDEX paintsharp.idx_paintsharp_ld_updated ON layer_documents(owner_id, updated_at DESC);
CREATE INDEX paintsharp.idx_paintsharp_ld_trashed ON layer_documents(owner_id, trashed_at DESC) WHERE is_trashed = 1;
CREATE INDEX paintsharp.idx_paintsharp_ld_starred ON layer_documents(owner_id) WHERE is_starred = 1 AND is_trashed = 0;
CREATE TRIGGER paintsharp.layer_documents_updated_at AFTER UPDATE ON layer_documents
BEGIN
    UPDATE layer_documents SET updated_at = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = NEW.id;
END;

CREATE TABLE paintsharp.layer_data (
    id              BLOB    NOT NULL PRIMARY KEY,
    document_id     BLOB    NOT NULL REFERENCES layer_documents(id) ON DELETE CASCADE,
    layer_id        TEXT    NOT NULL,
    storage_path    TEXT    NOT NULL,
    checksum_sha256 TEXT,
    size_bytes      INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
    updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
    UNIQUE (document_id, layer_id)
);
CREATE INDEX paintsharp.idx_paintsharp_layer_data_doc ON layer_data(document_id);
CREATE TRIGGER paintsharp.layer_data_updated_at AFTER UPDATE ON layer_data
BEGIN
    UPDATE layer_data SET updated_at = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = NEW.id;
END;
