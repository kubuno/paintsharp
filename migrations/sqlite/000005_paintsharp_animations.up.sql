CREATE TABLE paintsharp.animations (
    id               BLOB    NOT NULL PRIMARY KEY,
    owner_id         BLOB    NOT NULL,
    title            TEXT    NOT NULL DEFAULT 'Animation sans titre',
    composition      TEXT    NOT NULL DEFAULT '{"width":720,"height":480,"fps":24,"duration_frames":120,"background":"#1a1a2e","pixelRatio":1}',
    yjs_state        BLOB,
    thumbnail_path   TEXT,
    thumbnail_dirty  BOOLEAN NOT NULL DEFAULT 1,
    is_trashed       BOOLEAN NOT NULL DEFAULT 0,
    trashed_at       TEXT,
    last_edited_by   BLOB,
    file_id          BLOB,
    created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
    updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
);
CREATE INDEX paintsharp.idx_paintsharp_anim_owner   ON animations(owner_id);
CREATE INDEX paintsharp.idx_paintsharp_anim_updated ON animations(owner_id, updated_at DESC);
CREATE INDEX paintsharp.idx_paintsharp_anim_trashed ON animations(owner_id, trashed_at DESC) WHERE is_trashed = 1;
CREATE TRIGGER paintsharp.animations_updated_at AFTER UPDATE ON animations
BEGIN
    UPDATE animations SET updated_at = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = NEW.id;
END;

CREATE TABLE paintsharp.animation_shares (
    id           BLOB    NOT NULL PRIMARY KEY,
    animation_id BLOB    NOT NULL REFERENCES animations(id) ON DELETE CASCADE,
    created_by   BLOB    NOT NULL,
    token        TEXT    NOT NULL UNIQUE,
    shared_with  BLOB,
    permission   TEXT    NOT NULL DEFAULT 'read' CHECK (permission IN ('read','edit')),
    allow_export BOOLEAN NOT NULL DEFAULT 0,
    expires_at   TEXT,
    is_active    BOOLEAN NOT NULL DEFAULT 1,
    view_count   INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
);
CREATE INDEX paintsharp.idx_paintsharp_as_token ON animation_shares(token) WHERE is_active = 1;
