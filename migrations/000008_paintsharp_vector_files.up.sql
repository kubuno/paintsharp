-- Apex (vectoriel) : le contenu des pages (artboards/elements/guides) part dans un
-- fichier du module files (format Kubuno .kbvector). La base ne garde que la
-- métadonnée. Pas de migration des données — l'existant est jetable.
ALTER TABLE vector_projects ADD COLUMN IF NOT EXISTS file_id UUID;
ALTER TABLE vector_pages    DROP COLUMN IF EXISTS data;
