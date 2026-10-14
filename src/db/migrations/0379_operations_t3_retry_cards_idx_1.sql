-- verebona:optional-index
-- Migration 0379 (index 1/2) : candidats dont la reprise T3 est programmée
-- (balayage horaire, lot 54D E01). UNE instruction par fichier.
CREATE INDEX CONCURRENTLY IF NOT EXISTS document_operation_candidates_t3_retry_idx
  ON document_operation_candidates (t3_retry_at, account_id) WHERE t3_retry_at IS NOT NULL;
