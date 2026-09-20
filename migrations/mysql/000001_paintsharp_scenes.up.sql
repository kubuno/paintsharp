-- MySQL / MariaDB. The `paintsharp` database is created by kubuno-db's
-- `ensure_schema` before the migrator runs, so there is no CREATE here.
--
-- Differences from the PostgreSQL file, and why:
--   * UUID -> BINARY(16), TIMESTAMPTZ -> DATETIME(6), JSONB -> JSON, BYTEA -> LONGBLOB.
--   * No DEFAULT on `id`: MySQL has no gen_random_uuid(), and the process has to
--     know the key anyway since MySQL has no RETURNING.
--   * The updated_at trigger becomes ON UPDATE CURRENT_TIMESTAMP(6).
--   * Partial indexes (`WHERE ...`) have no MySQL form: the predicate is dropped
--     and the index kept as a plain one.
--   * The content column (scene_json) is dropped in the PostgreSQL history; on a
--     fresh engine the table is created without it from the start.
CREATE TABLE paintsharp.scenes (
    id              BINARY(16)   NOT NULL PRIMARY KEY,
    owner_id        BINARY(16)   NOT NULL,
    title           VARCHAR(500) NOT NULL DEFAULT 'Sans titre',
    description     TEXT,
    thumbnail_url   VARCHAR(1000),
    is_starred      BOOLEAN      NOT NULL DEFAULT FALSE,
    is_trashed      BOOLEAN      NOT NULL DEFAULT FALSE,
    trashed_at      DATETIME(6),
    vertex_count    INT          NOT NULL DEFAULT 0,
    face_count      INT          NOT NULL DEFAULT 0,
    last_editor_id  BINARY(16),
    file_id         BINARY(16),
    created_at      DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at      DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)
);
CREATE INDEX idx_paintsharp_scenes_owner   ON paintsharp.scenes(owner_id);
CREATE INDEX idx_paintsharp_scenes_starred ON paintsharp.scenes(owner_id, is_starred);
CREATE INDEX idx_paintsharp_scenes_trashed ON paintsharp.scenes(owner_id, trashed_at);

CREATE TABLE paintsharp.scene_collaborators (
    scene_id    BINARY(16)  NOT NULL REFERENCES paintsharp.scenes(id) ON DELETE CASCADE,
    user_id     BINARY(16)  NOT NULL,
    permission  VARCHAR(20) NOT NULL DEFAULT 'view' CHECK (permission IN ('view','edit')),
    added_at    DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (scene_id, user_id),
    FOREIGN KEY (scene_id) REFERENCES paintsharp.scenes(id) ON DELETE CASCADE
);

CREATE TABLE paintsharp.scene_shares (
    id          BINARY(16)  NOT NULL PRIMARY KEY,
    scene_id    BINARY(16)  NOT NULL,
    token       VARCHAR(64) NOT NULL UNIQUE,
    permission  VARCHAR(20) NOT NULL DEFAULT 'view' CHECK (permission IN ('view','edit')),
    expires_at  DATETIME(6),
    created_by  BINARY(16)  NOT NULL,
    created_at  DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    FOREIGN KEY (scene_id) REFERENCES paintsharp.scenes(id) ON DELETE CASCADE
);
CREATE INDEX idx_paintsharp_shares_scene ON paintsharp.scene_shares(scene_id);
CREATE INDEX idx_paintsharp_shares_token ON paintsharp.scene_shares(token);
