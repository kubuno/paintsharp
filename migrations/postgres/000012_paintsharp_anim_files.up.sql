-- Keyframe : anim_data + assets (contenu) → fichier .kbanm (files).
-- composition (réglages) et yjs_state (état collab) restent en base.
ALTER TABLE paintsharp.animations ADD COLUMN IF NOT EXISTS file_id UUID;
ALTER TABLE paintsharp.animations DROP COLUMN IF EXISTS anim_data;
ALTER TABLE paintsharp.animations DROP COLUMN IF EXISTS assets;
