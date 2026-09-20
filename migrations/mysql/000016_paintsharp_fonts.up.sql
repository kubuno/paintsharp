CREATE TABLE paintsharp.font_projects (
    id              BINARY(16)   NOT NULL PRIMARY KEY,
    owner_id        BINARY(16)   NOT NULL,
    title           VARCHAR(500) NOT NULL DEFAULT 'Police sans titre',
    thumbnail_path  TEXT,
    file_id         BINARY(16),
    glyph_count     INT          NOT NULL DEFAULT 0,
    is_starred      BOOLEAN      NOT NULL DEFAULT FALSE,
    is_trashed      BOOLEAN      NOT NULL DEFAULT FALSE,
    trashed_at      DATETIME(6),
    last_edited_by  BINARY(16),
    created_at      DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at      DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)
);
CREATE INDEX idx_paintsharp_fp_owner   ON paintsharp.font_projects(owner_id);
CREATE INDEX idx_paintsharp_fp_starred ON paintsharp.font_projects(owner_id, is_starred);
CREATE INDEX idx_paintsharp_fp_trashed ON paintsharp.font_projects(owner_id, trashed_at);
CREATE INDEX idx_paintsharp_fp_updated ON paintsharp.font_projects(owner_id, updated_at);
CREATE INDEX idx_paintsharp_fp_file    ON paintsharp.font_projects(file_id);
