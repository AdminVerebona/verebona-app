-- verebona:optional-index
-- Migration 0591 (index 1/3) : journal des consolidations par compte (diagnostic BO) —
-- lot 76H. UNE instruction par fichier (`CREATE INDEX CONCURRENTLY` hors transaction). Idempotente.
CREATE INDEX CONCURRENTLY IF NOT EXISTS agenda_intervention_consolidations_account_idx
  ON agenda_intervention_consolidations (account_id, created_at);
