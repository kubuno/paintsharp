CREATE TABLE paintsharp.animations (
    id               BINARY(16)   NOT NULL PRIMARY KEY,
    owner_id         BINARY(16)   NOT NULL,
    title            VARCHAR(500) NOT NULL DEFAULT 'Animation sans titre',
    composition      JSON         NOT NULL DEFAULT (_utf8mb4'{"width":720,"height":480,"fps":24,"duration_frames":120,"background":"#1a1a2e","pixelRatio":1}'),
    yjs_state        LONGBLOB,
    thumbnail_path   TEXT,
    thumbnail_dirty  BOOLEAN      NOT NULL DEFAULT TRUE,
    is_trashed       BOOLEAN      NOT NULL DEFAULT FALSE,
    trashed_at       DATETIME(6),
    last_edited_by   BINARY(16),
    file_id          BINARY(16),
    created_at       DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at       DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)
);
CREATE INDEX idx_paintsharp_anim_owner   ON paintsharp.animations(owner_id);
CREATE INDEX idx_paintsharp_anim_updated ON paintsharp.animations(owner_id, updated_at);
CREATE INDEX idx_paintsharp_anim_trashed ON paintsharp.animations(owner_id, trashed_at);

CREATE TABLE paintsharp.animation_shares (
    id           BINARY(16)  NOT NULL PRIMARY KEY,
    animation_id BINARY(16)  NOT NULL,
    created_by   BINARY(16)  NOT NULL,
    token        VARCHAR(64) NOT NULL UNIQUE,
    shared_with  BINARY(16),
    permission   VARCHAR(10) NOT NULL DEFAULT 'read' CHECK (permission IN ('read','edit')),
    allow_export BOOLEAN     NOT NULL DEFAULT FALSE,
    expires_at   DATETIME(6),
    is_active    BOOLEAN     NOT NULL DEFAULT TRUE,
    view_count   INT         NOT NULL DEFAULT 0,
    created_at   DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    FOREIGN KEY (animation_id) REFERENCES paintsharp.animations(id) ON DELETE CASCADE
);
CREATE INDEX idx_paintsharp_as_token ON paintsharp.animation_shares(token);
