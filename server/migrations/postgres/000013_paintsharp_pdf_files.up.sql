-- ── PdfWriter : contenu (annotations/form_data) déplacé vers le module files ──
-- Le contenu d'annotation vit désormais dans un fichier .kbpdf ; la base ne
-- garde que la métadonnée de page (numéro, dimensions, rotation).

ALTER TABLE paintsharp.pdf_documents ADD COLUMN IF NOT EXISTS file_id UUID;

ALTER TABLE paintsharp.pdf_pages DROP COLUMN IF EXISTS annotations;
ALTER TABLE paintsharp.pdf_pages DROP COLUMN IF EXISTS form_data;
