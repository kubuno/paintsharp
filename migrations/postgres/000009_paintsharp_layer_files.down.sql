ALTER TABLE paintsharp.layer_documents ADD COLUMN IF NOT EXISTS layers_structure JSONB NOT NULL DEFAULT '[]';
ALTER TABLE paintsharp.layer_documents ADD COLUMN IF NOT EXISTS command_history  JSONB NOT NULL DEFAULT '[]';
ALTER TABLE paintsharp.layer_documents ADD COLUMN IF NOT EXISTS view_settings    JSONB NOT NULL DEFAULT '{"zoom":1.0,"panX":0,"panY":0,"showGuides":true,"showGrid":false,"gridSize":32}';
ALTER TABLE paintsharp.layer_documents DROP COLUMN IF EXISTS file_id;
