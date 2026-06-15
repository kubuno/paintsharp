DROP TABLE IF EXISTS scene_shares;
DROP TABLE IF EXISTS scene_collaborators;
DROP TRIGGER IF EXISTS scenes_updated_at ON scenes;
DROP FUNCTION IF EXISTS paintsharp_set_updated_at();
DROP TABLE IF EXISTS scenes;
