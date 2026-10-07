CREATE TABLE paintsharp.pdf_documents (
    id              BINARY(16)    NOT NULL PRIMARY KEY,
    owner_id        BINARY(16)    NOT NULL,
    title           VARCHAR(500)  NOT NULL DEFAULT 'Document sans titre',
    source_path     VARCHAR(1000),
    page_count      INT           NOT NULL DEFAULT 1,
    thumbnail_path  VARCHAR(1000),
    settings        JSON          NOT NULL DEFAULT (_utf8mb4'{}'),
    is_starred      BOOLEAN       NOT NULL DEFAULT FALSE,
    is_trashed      BOOLEAN       NOT NULL DEFAULT FALSE,
    trashed_at      DATETIME(6),
    last_edited_by  BINARY(16),
    file_id         BINARY(16),
    source_file_id  BINARY(16),
    created_at      DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at      DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)
);
CREATE INDEX idx_paintsharp_pdf_owner        ON paintsharp.pdf_documents(owner_id);
CREATE INDEX idx_paintsharp_pdf_starred      ON paintsharp.pdf_documents(owner_id, is_starred);
CREATE INDEX idx_paintsharp_pdf_trashed      ON paintsharp.pdf_documents(owner_id, trashed_at);
CREATE INDEX idx_pdf_documents_source_file   ON paintsharp.pdf_documents(owner_id, source_file_id);

CREATE TABLE paintsharp.pdf_pages (
    id              BINARY(16)  NOT NULL PRIMARY KEY,
    document_id     BINARY(16)  NOT NULL,
    page_number     INT         NOT NULL,
    width           DOUBLE      NOT NULL DEFAULT 595.28,
    height          DOUBLE      NOT NULL DEFAULT 841.89,
    rotation        INT         NOT NULL DEFAULT 0 CHECK (rotation IN (0,90,180,270)),
    source_index    INT,
    created_at      DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at      DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    UNIQUE(document_id, page_number),
    FOREIGN KEY (document_id) REFERENCES paintsharp.pdf_documents(id) ON DELETE CASCADE
);
CREATE INDEX idx_paintsharp_pdfp_doc ON paintsharp.pdf_pages(document_id, page_number);

CREATE TABLE paintsharp.pdf_signatures (
    id          BINARY(16)   NOT NULL PRIMARY KEY,
    owner_id    BINARY(16)   NOT NULL,
    name        VARCHAR(255) NOT NULL DEFAULT 'Ma signature',
    sig_type    VARCHAR(20)  NOT NULL DEFAULT 'draw' CHECK (sig_type IN ('draw','text','image')),
    data        LONGTEXT     NOT NULL,
    created_at  DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
);
CREATE INDEX idx_paintsharp_pdfsig_owner ON paintsharp.pdf_signatures(owner_id);
