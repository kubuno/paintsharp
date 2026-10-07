CREATE TABLE paintsharp.layer_documents (
    id               BINARY(16)   NOT NULL PRIMARY KEY,
    owner_id         BINARY(16)   NOT NULL,
    title            VARCHAR(500) NOT NULL DEFAULT 'image_sans_titre',
    width            INT          NOT NULL DEFAULT 1920,
    height           INT          NOT NULL DEFAULT 1080,
    color_mode       VARCHAR(10)  NOT NULL DEFAULT 'rgba',
    bit_depth        INT          NOT NULL DEFAULT 8,
    dpi              INT          NOT NULL DEFAULT 72,
    thumbnail_path   TEXT,
    thumbnail_dirty  BOOLEAN      NOT NULL DEFAULT TRUE,
    layer_count      INT          NOT NULL DEFAULT 1,
    is_starred       BOOLEAN      NOT NULL DEFAULT FALSE,
    is_trashed       BOOLEAN      NOT NULL DEFAULT FALSE,
    trashed_at       DATETIME(6),
    last_edited_by   BINARY(16),
    file_id          BINARY(16),
    created_at       DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at       DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)
);
CREATE INDEX idx_paintsharp_ld_owner   ON paintsharp.layer_documents(owner_id);
CREATE INDEX idx_paintsharp_ld_updated ON paintsharp.layer_documents(owner_id, updated_at);
CREATE INDEX idx_paintsharp_ld_trashed ON paintsharp.layer_documents(owner_id, trashed_at);
CREATE INDEX idx_paintsharp_ld_starred ON paintsharp.layer_documents(owner_id, is_starred);

CREATE TABLE paintsharp.layer_data (
    id              BINARY(16)  NOT NULL PRIMARY KEY,
    document_id     BINARY(16)  NOT NULL,
    layer_id        VARCHAR(36) NOT NULL,
    storage_path    TEXT        NOT NULL,
    checksum_sha256 VARCHAR(64),
    size_bytes      BIGINT      NOT NULL DEFAULT 0,
    created_at      DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at      DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    UNIQUE (document_id, layer_id),
    FOREIGN KEY (document_id) REFERENCES paintsharp.layer_documents(id) ON DELETE CASCADE
);
CREATE INDEX idx_paintsharp_layer_data_doc ON paintsharp.layer_data(document_id);
