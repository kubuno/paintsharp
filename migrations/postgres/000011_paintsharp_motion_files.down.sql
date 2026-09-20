ALTER TABLE paintsharp.video_projects ADD COLUMN IF NOT EXISTS timeline_data JSONB NOT NULL DEFAULT '{"tracks":[],"markers":[]}';
ALTER TABLE paintsharp.video_projects DROP COLUMN IF EXISTS file_id;
