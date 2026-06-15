ALTER TABLE vector_pages    ADD COLUMN IF NOT EXISTS data JSONB NOT NULL DEFAULT '{"artboards":[],"elements":[],"guides":[]}';
ALTER TABLE vector_projects DROP COLUMN IF EXISTS file_id;
