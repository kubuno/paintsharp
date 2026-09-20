CREATE TABLE paintsharp.vector_projects (
    id              BINARY(16)   NOT NULL PRIMARY KEY,
    owner_id        BINARY(16)   NOT NULL,
    title           VARCHAR(500) NOT NULL DEFAULT 'Projet sans titre',
    settings        JSON         NOT NULL DEFAULT (_utf8mb4'{"snapToGrid":true,"snapToPixel":true,"snapToObjects":true,"gridSize":8,"showGrid":false,"showGuides":true,"showRulers":true}'),
    thumbnail_path  TEXT,
    is_starred      BOOLEAN      NOT NULL DEFAULT FALSE,
    is_trashed      BOOLEAN      NOT NULL DEFAULT FALSE,
    trashed_at      DATETIME(6),
    last_edited_by  BINARY(16),
    file_id         BINARY(16),
    created_at      DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at      DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)
);
CREATE INDEX idx_paintsharp_vp_owner   ON paintsharp.vector_projects(owner_id);
CREATE INDEX idx_paintsharp_vp_starred ON paintsharp.vector_projects(owner_id, is_starred);
CREATE INDEX idx_paintsharp_vp_trashed ON paintsharp.vector_projects(owner_id, trashed_at);
CREATE INDEX idx_paintsharp_vp_updated ON paintsharp.vector_projects(owner_id, updated_at);

CREATE TABLE paintsharp.vector_pages (
    id          BINARY(16)   NOT NULL PRIMARY KEY,
    project_id  BINARY(16)   NOT NULL,
    name        VARCHAR(255) NOT NULL DEFAULT 'Page 1',
    position    INT          NOT NULL DEFAULT 0,
    created_at  DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at  DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    FOREIGN KEY (project_id) REFERENCES paintsharp.vector_projects(id) ON DELETE CASCADE
);
CREATE INDEX idx_paintsharp_vpp_project ON paintsharp.vector_pages(project_id, position);

CREATE TABLE paintsharp.vector_shares (
    id          BINARY(16)  NOT NULL PRIMARY KEY,
    project_id  BINARY(16)  NOT NULL,
    created_by  BINARY(16)  NOT NULL,
    token       VARCHAR(64) NOT NULL UNIQUE,
    shared_with BINARY(16),
    permission  VARCHAR(10) NOT NULL DEFAULT 'read' CHECK (permission IN ('read','edit')),
    expires_at  DATETIME(6),
    is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at  DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    FOREIGN KEY (project_id) REFERENCES paintsharp.vector_projects(id) ON DELETE CASCADE
);
CREATE INDEX idx_paintsharp_vs_token ON paintsharp.vector_shares(token);
