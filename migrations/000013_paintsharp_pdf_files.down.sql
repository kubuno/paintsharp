ALTER TABLE paintsharp.pdf_pages ADD COLUMN IF NOT EXISTS annotations JSONB NOT NULL DEFAULT '[]';
ALTER TABLE paintsharp.pdf_pages ADD COLUMN IF NOT EXISTS form_data JSONB NOT NULL DEFAULT '{}';
ALTER TABLE paintsharp.pdf_documents DROP COLUMN IF EXISTS file_id;
