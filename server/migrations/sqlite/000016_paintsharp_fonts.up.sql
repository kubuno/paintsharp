CREATE TABLE paintsharp.font_projects (
    id              BLOB    NOT NULL PRIMARY KEY,
    owner_id        BLOB    NOT NULL,
    title           TEXT    NOT NULL DEFAULT 'Police sans titre',
    thumbnail_path  TEXT,
    file_id         BLOB,
    glyph_count     INTEGER NOT NULL DEFAULT 0,
    is_starred      BOOLEAN NOT NULL DEFAULT 0,
    is_trashed      BOOLEAN NOT NULL DEFAULT 0,
    trashed_at      TEXT,
    last_edited_by  BLOB,
    created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
    updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
);
CREATE INDEX paintsharp.idx_paintsharp_fp_owner   ON font_projects(owner_id) WHERE is_trashed = 0;
CREATE INDEX paintsharp.idx_paintsharp_fp_starred ON font_projects(owner_id, is_starred) WHERE is_starred = 1 AND is_trashed = 0;
CREATE INDEX paintsharp.idx_paintsharp_fp_trashed ON font_projects(owner_id, trashed_at) WHERE is_trashed = 1;
CREATE INDEX paintsharp.idx_paintsharp_fp_updated ON font_projects(owner_id, updated_at DESC);
CREATE INDEX paintsharp.idx_paintsharp_fp_file    ON font_projects(file_id);
CREATE TRIGGER paintsharp.font_projects_updated_at AFTER UPDATE ON font_projects
BEGIN
    UPDATE font_projects SET updated_at = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = NEW.id;
END;
