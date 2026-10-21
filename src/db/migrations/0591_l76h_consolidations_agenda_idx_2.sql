-- verebona:optional-index
-- Migration 0591 (index 2/3) : journal par exécution du rattrapage (restauration) — lot 76H.
CREATE INDEX CONCURRENTLY IF NOT EXISTS agenda_intervention_consolidations_run_idx
  ON agenda_intervention_consolidations (run_id) WHERE run_id IS NOT NULL;
