-- Immutable index of the page inside the imported source PDF binary. Lets the
-- editor keep rendering the right source page after pages are reordered, and
-- lets the export rebuild the document in the new order. NULL for pages that
-- have no backing source page (blank documents, pages added after import).
ALTER TABLE paintsharp.pdf_pages ADD COLUMN IF NOT EXISTS source_index INTEGER;

-- Backfill: before this migration pages were never reordered, so the source
-- index of an imported document's page is simply its position.
UPDATE paintsharp.pdf_pages p
   SET source_index = p.page_number - 1
  FROM paintsharp.pdf_documents d
 WHERE d.id = p.document_id
   AND d.source_path IS NOT NULL
   AND p.source_index IS NULL;
