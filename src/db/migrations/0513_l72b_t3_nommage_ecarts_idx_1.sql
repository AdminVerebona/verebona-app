-- verebona:optional-index
-- Migration 0513 (index 1/1) : écritures de renommage à reprendre d'un lot
-- (harmonisation T3, lot 72B — E6). UNE instruction par fichier
-- (CONCURRENTLY hors transaction). Idempotente.
CREATE INDEX CONCURRENTLY IF NOT EXISTS document_rename_events_retry_idx
  ON document_rename_events (account_id, group_key) WHERE retry_status = 'PENDING';
