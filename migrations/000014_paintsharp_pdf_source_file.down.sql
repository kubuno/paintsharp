DROP INDEX IF EXISTS paintsharp.idx_pdf_documents_source_file;
ALTER TABLE paintsharp.pdf_documents DROP COLUMN IF EXISTS source_file_id;
