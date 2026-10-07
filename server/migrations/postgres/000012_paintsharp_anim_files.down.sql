ALTER TABLE paintsharp.animations ADD COLUMN IF NOT EXISTS anim_data JSONB NOT NULL DEFAULT '{"layers":[],"bones":[]}';
ALTER TABLE paintsharp.animations ADD COLUMN IF NOT EXISTS assets    JSONB NOT NULL DEFAULT '[]';
ALTER TABLE paintsharp.animations DROP COLUMN IF EXISTS file_id;
