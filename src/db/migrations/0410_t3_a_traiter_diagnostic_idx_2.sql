-- verebona:optional-index
-- Migration 0410 (index 2/2) : diagnostic BO des « À traiter » T3 (lot 57B)
-- — lecture du journal par passage du compte (détail d'une exécution T3
-- globale). Idempotente ; un index laissé INVALIDE est reconstruit.
CREATE INDEX CONCURRENTLY IF NOT EXISTS t3_open_action_evaluations_run_idx
  ON t3_open_action_evaluations (account_run_id) WHERE account_run_id IS NOT NULL;
