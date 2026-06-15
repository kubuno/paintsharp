-- Layer : structure des calques + réglages de vue → fichier .kblay (files).
-- Les pixels sont déjà hors base (layer_data.storage_path). Pas de migration de
-- données — l'existant est jetable.
ALTER TABLE paintsharp.layer_documents ADD COLUMN IF NOT EXISTS file_id UUID;
ALTER TABLE paintsharp.layer_documents DROP COLUMN IF EXISTS layers_structure;
ALTER TABLE paintsharp.layer_documents DROP COLUMN IF EXISTS command_history;
ALTER TABLE paintsharp.layer_documents DROP COLUMN IF EXISTS view_settings;
