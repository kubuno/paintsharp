-- Motion : la timeline (contenu d'édition) part dans un fichier .kbmot (files).
-- composition/render_settings restent en base (réglages, utilisés par la liste).
ALTER TABLE paintsharp.video_projects ADD COLUMN IF NOT EXISTS file_id UUID;
ALTER TABLE paintsharp.video_projects DROP COLUMN IF EXISTS timeline_data;
