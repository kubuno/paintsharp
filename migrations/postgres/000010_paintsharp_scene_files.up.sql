-- Vertex (3D) : la scène (scene_json) part dans un fichier .kbscn (files).
ALTER TABLE scenes ADD COLUMN IF NOT EXISTS file_id UUID;
ALTER TABLE scenes DROP COLUMN IF EXISTS scene_json;
