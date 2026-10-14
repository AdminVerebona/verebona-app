-- verebona:optional-index
-- Migration 0379 (index 2/2) : documents dont les cartes « À traiter » sont à
-- resynchroniser (lot 54D E05). UNE instruction par fichier.
CREATE INDEX CONCURRENTLY IF NOT EXISTS document_operation_candidates_t3_cards_pending_idx
  ON document_operation_candidates (account_id, file_id) WHERE t3_cards_pending;
