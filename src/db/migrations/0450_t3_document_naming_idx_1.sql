-- verebona:optional-index
-- Migration 0450 (index 1/1) : historique des renommages d'un document
-- (origine du nom en place, délai de stabilité, reporting). UNE instruction
-- par fichier (CONCURRENTLY hors transaction). Idempotente.
CREATE INDEX CONCURRENTLY IF NOT EXISTS document_rename_events_file_idx
  ON document_rename_events (account_id, file_id, id);
