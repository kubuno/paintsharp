-- ── PdfWriter : ouvrir un PDF brut depuis Files ──────────────────────────────
-- On mémorise le fichier Files (PDF brut) à partir duquel un document a été
-- importé, afin de ré-ouvrir le même document au lieu de réimporter (dédup).

ALTER TABLE paintsharp.pdf_documents ADD COLUMN IF NOT EXISTS source_file_id UUID;

CREATE INDEX IF NOT EXISTS idx_pdf_documents_source_file
    ON paintsharp.pdf_documents (owner_id, source_file_id)
    WHERE source_file_id IS NOT NULL;
