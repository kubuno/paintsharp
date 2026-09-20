-- SQLite. `paintsharp` is an ATTACHed database file, attached on every pooled
-- connection by kubuno-db, so the qualified names below resolve as they do on
-- the other two engines.
--
-- Differences from the PostgreSQL file, and why:
--   * UUID -> BLOB, TIMESTAMPTZ -> TEXT (`%F %T%.f`, UTC), JSONB -> TEXT.
--   * No DEFAULT on `id`: SQLite has no UUID generator; the process supplies it.
--   * The updated_at trigger is written by hand; it does not recurse because
--     SQLite leaves recursive_triggers off.
--   * The content column (scene_json) is dropped in the PostgreSQL history; on a
--     fresh engine the table is created without it from the start.
CREATE TABLE paintsharp.scenes (
    id              BLOB    NOT NULL PRIMARY KEY,
    owner_id        BLOB    NOT NULL,
    title           TEXT    NOT NULL DEFAULT 'Sans titre',
    description     TEXT,
    thumbnail_url   TEXT,
    is_starred      BOOLEAN NOT NULL DEFAULT 0,
    is_trashed      BOOLEAN NOT NULL DEFAULT 0,
    trashed_at      TEXT,
    vertex_count    INTEGER NOT NULL DEFAULT 0,
    face_count      INTEGER NOT NULL DEFAULT 0,
    last_editor_id  BLOB,
    file_id         BLOB,
    created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
    updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
);
CREATE INDEX paintsharp.idx_paintsharp_scenes_owner   ON scenes(owner_id) WHERE is_trashed = 0;
CREATE INDEX paintsharp.idx_paintsharp_scenes_starred ON scenes(owner_id, is_starred) WHERE is_starred = 1 AND is_trashed = 0;
CREATE INDEX paintsharp.idx_paintsharp_scenes_trashed ON scenes(owner_id, trashed_at) WHERE is_trashed = 1;
CREATE TRIGGER paintsharp.scenes_updated_at AFTER UPDATE ON scenes
BEGIN
    UPDATE scenes SET updated_at = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = NEW.id;
END;

CREATE TABLE paintsharp.scene_collaborators (
    scene_id    BLOB    NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
    user_id     BLOB    NOT NULL,
    permission  TEXT    NOT NULL DEFAULT 'view' CHECK (permission IN ('view','edit')),
    added_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
    PRIMARY KEY (scene_id, user_id)
);

CREATE TABLE paintsharp.scene_shares (
    id          BLOB    NOT NULL PRIMARY KEY,
    scene_id    BLOB    NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
    token       TEXT    NOT NULL UNIQUE,
    permission  TEXT    NOT NULL DEFAULT 'view' CHECK (permission IN ('view','edit')),
    expires_at  TEXT,
    created_by  BLOB    NOT NULL,
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
);
CREATE INDEX paintsharp.idx_paintsharp_shares_scene ON scene_shares(scene_id);
CREATE INDEX paintsharp.idx_paintsharp_shares_token ON scene_shares(token);
