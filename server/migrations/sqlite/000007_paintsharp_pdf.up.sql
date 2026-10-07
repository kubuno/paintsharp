CREATE TABLE paintsharp.pdf_documents (
    id              BLOB    NOT NULL PRIMARY KEY,
    owner_id        BLOB    NOT NULL,
    title           TEXT    NOT NULL DEFAULT 'Document sans titre',
    source_path     TEXT,
    page_count      INTEGER NOT NULL DEFAULT 1,
    thumbnail_path  TEXT,
    settings        TEXT    NOT NULL DEFAULT '{}',
    is_starred      BOOLEAN NOT NULL DEFAULT 0,
    is_trashed      BOOLEAN NOT NULL DEFAULT 0,
    trashed_at      TEXT,
    last_edited_by  BLOB,
    file_id         BLOB,
    source_file_id  BLOB,
    created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
    updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
);
CREATE INDEX paintsharp.idx_paintsharp_pdf_owner   ON pdf_documents(owner_id) WHERE is_trashed = 0;
CREATE INDEX paintsharp.idx_paintsharp_pdf_starred ON pdf_documents(owner_id, is_starred) WHERE is_starred = 1 AND is_trashed = 0;
CREATE INDEX paintsharp.idx_paintsharp_pdf_trashed ON pdf_documents(owner_id, trashed_at) WHERE is_trashed = 1;
CREATE INDEX paintsharp.idx_pdf_documents_source_file ON pdf_documents(owner_id, source_file_id) WHERE source_file_id IS NOT NULL;
CREATE TRIGGER paintsharp.pdf_docs_updated_at AFTER UPDATE ON pdf_documents
BEGIN
    UPDATE pdf_documents SET updated_at = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = NEW.id;
END;

CREATE TABLE paintsharp.pdf_pages (
    id              BLOB    NOT NULL PRIMARY KEY,
    document_id     BLOB    NOT NULL REFERENCES pdf_documents(id) ON DELETE CASCADE,
    page_number     INTEGER NOT NULL,
    width           REAL    NOT NULL DEFAULT 595.28,
    height          REAL    NOT NULL DEFAULT 841.89,
    rotation        INTEGER NOT NULL DEFAULT 0 CHECK (rotation IN (0,90,180,270)),
    source_index    INTEGER,
    created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
    updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
    UNIQUE(document_id, page_number)
);
CREATE INDEX paintsharp.idx_paintsharp_pdfp_doc ON pdf_pages(document_id, page_number);
CREATE TRIGGER paintsharp.pdf_pages_updated_at AFTER UPDATE ON pdf_pages
BEGIN
    UPDATE pdf_pages SET updated_at = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = NEW.id;
END;

CREATE TABLE paintsharp.pdf_signatures (
    id          BLOB    NOT NULL PRIMARY KEY,
    owner_id    BLOB    NOT NULL,
    name        TEXT    NOT NULL DEFAULT 'Ma signature',
    sig_type    TEXT    NOT NULL DEFAULT 'draw' CHECK (sig_type IN ('draw','text','image')),
    data        TEXT    NOT NULL,
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now'))
);
CREATE INDEX paintsharp.idx_paintsharp_pdfsig_owner ON pdf_signatures(owner_id);
