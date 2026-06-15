ALTER TABLE scenes ADD COLUMN IF NOT EXISTS scene_json JSONB NOT NULL DEFAULT '{"metadata":{"version":4.6,"type":"Scene"},"object":{"type":"Scene","children":[]}}';
ALTER TABLE scenes DROP COLUMN IF EXISTS file_id;
