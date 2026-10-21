-- verebona:optional-index
-- Migration 0591 (index 3/3) : éléments restaurés (jamais reconsolidés par la projection) — lot 76H.
CREATE INDEX CONCURRENTLY IF NOT EXISTS agenda_intervention_consolidations_restored_idx
  ON agenda_intervention_consolidations (account_id, absorbed_item_id, principal_item_id) WHERE restored_at IS NOT NULL;
