CREATE TABLE paintsharp.vector_projects (
    id              BLOB    NOT NULL PRIMARY KEY,
    owner_id        BLOB    NOT NULL,
    title           TEXT    NOT NULL DEFAULT 'Projet sans titre',
    settings        TEXT    NOT NULL DEFAULT '{"snapToGrid":true,"snapToPixel":true,"snapToObjects":true,"gridSize":8,"showGrid":false,"showGuides":true,"showRulers":true}',
    thumbnail_path  TEXT,
    is_starred      BOOLEAN NOT NULL DEFAULT 0,
    is_trashed      BOOLEAN NOT NULL DEFAULT 0,
    trashed_at      TEXT,
    last_edited_by  BLOB,
    file_id         BLOB,
    created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
    updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
);
CREATE INDEX paintsharp.idx_paintsharp_vp_owner   ON vector_projects(owner_id) WHERE is_trashed = 0;
CREATE INDEX paintsharp.idx_paintsharp_vp_starred ON vector_projects(owner_id, is_starred) WHERE is_starred = 1 AND is_trashed = 0;
CREATE INDEX paintsharp.idx_paintsharp_vp_trashed ON vector_projects(owner_id, trashed_at) WHERE is_trashed = 1;
CREATE INDEX paintsharp.idx_paintsharp_vp_updated ON vector_projects(owner_id, updated_at DESC);
CREATE TRIGGER paintsharp.vector_projects_updated_at AFTER UPDATE ON vector_projects
BEGIN
    UPDATE vector_projects SET updated_at = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = NEW.id;
END;

CREATE TABLE paintsharp.vector_pages (
    id          BLOB    NOT NULL PRIMARY KEY,
    project_id  BLOB    NOT NULL REFERENCES vector_projects(id) ON DELETE CASCADE,
    name        TEXT    NOT NULL DEFAULT 'Page 1',
    position    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
    updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
);
CREATE INDEX paintsharp.idx_paintsharp_vpp_project ON vector_pages(project_id, position);
CREATE TRIGGER paintsharp.vector_pages_updated_at AFTER UPDATE ON vector_pages
BEGIN
    UPDATE vector_pages SET updated_at = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = NEW.id;
END;

CREATE TABLE paintsharp.vector_shares (
    id          BLOB    NOT NULL PRIMARY KEY,
    project_id  BLOB    NOT NULL REFERENCES vector_projects(id) ON DELETE CASCADE,
    created_by  BLOB    NOT NULL,
    token       TEXT    NOT NULL UNIQUE,
    shared_with BLOB,
    permission  TEXT    NOT NULL DEFAULT 'read' CHECK (permission IN ('read','edit')),
    expires_at  TEXT,
    is_active   BOOLEAN NOT NULL DEFAULT 1,
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
);
CREATE INDEX paintsharp.idx_paintsharp_vs_token ON vector_shares(token) WHERE is_active = 1;
