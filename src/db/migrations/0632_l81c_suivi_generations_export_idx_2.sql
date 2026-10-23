-- verebona:optional-index
-- Migration 0632 (index 2/2) : passages de réconciliation d'un bien, dans
-- l'ordre d'extraction du BO — lot 81C. UNE instruction par fichier
-- (`CREATE INDEX CONCURRENTLY` hors transaction). Idempotente.
CREATE INDEX CONCURRENTLY IF NOT EXISTS reconciliation_runs_account_asset_started_idx
  ON reconciliation_runs (account_id, asset_id, started_at DESC NULLS LAST, id DESC);
