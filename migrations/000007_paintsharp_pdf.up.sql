-- ── PdfWriter sub-module ─────────────────────────────────────────────────────

CREATE TABLE paintsharp.pdf_documents (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    owner_id        UUID NOT NULL,
    title           VARCHAR(500) NOT NULL DEFAULT 'Document sans titre',
    source_path     VARCHAR(1000),           -- fichier PDF source importé
    page_count      INTEGER NOT NULL DEFAULT 1,
    thumbnail_path  VARCHAR(1000),
    settings        JSONB NOT NULL DEFAULT '{}',
    is_starred      BOOLEAN NOT NULL DEFAULT FALSE,
    is_trashed      BOOLEAN NOT NULL DEFAULT FALSE,
    trashed_at      TIMESTAMPTZ,
    last_edited_by  UUID,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_paintsharp_pdf_owner   ON paintsharp.pdf_documents(owner_id) WHERE is_trashed = FALSE;
CREATE INDEX idx_paintsharp_pdf_starred ON paintsharp.pdf_documents(owner_id, is_starred) WHERE is_starred = TRUE AND is_trashed = FALSE;
CREATE INDEX idx_paintsharp_pdf_trashed ON paintsharp.pdf_documents(owner_id, trashed_at) WHERE is_trashed = TRUE;

CREATE TRIGGER pdf_docs_updated_at
    BEFORE UPDATE ON paintsharp.pdf_documents
    FOR EACH ROW EXECUTE FUNCTION paintsharp_set_updated_at();

-- Pages du document (une ligne par page, annotations stockées en JSONB)
CREATE TABLE paintsharp.pdf_pages (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    document_id     UUID NOT NULL REFERENCES paintsharp.pdf_documents(id) ON DELETE CASCADE,
    page_number     INTEGER NOT NULL,
    width           DOUBLE PRECISION NOT NULL DEFAULT 595.28,  -- A4 en points PDF
    height          DOUBLE PRECISION NOT NULL DEFAULT 841.89,
    rotation        INTEGER NOT NULL DEFAULT 0 CHECK (rotation IN (0, 90, 180, 270)),
    annotations     JSONB NOT NULL DEFAULT '[]',
    form_data       JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(document_id, page_number)
);

CREATE INDEX idx_paintsharp_pdfp_doc ON paintsharp.pdf_pages(document_id, page_number);

CREATE TRIGGER pdf_pages_updated_at
    BEFORE UPDATE ON paintsharp.pdf_pages
    FOR EACH ROW EXECUTE FUNCTION paintsharp_set_updated_at();

-- Signatures enregistrées par utilisateur
CREATE TABLE paintsharp.pdf_signatures (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    owner_id    UUID NOT NULL,
    name        VARCHAR(255) NOT NULL DEFAULT 'Ma signature',
    sig_type    VARCHAR(20) NOT NULL DEFAULT 'draw'
                    CHECK (sig_type IN ('draw', 'text', 'image')),
    data        TEXT NOT NULL,   -- SVG path data ou data URI base64
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_paintsharp_pdfsig_owner ON paintsharp.pdf_signatures(owner_id);
