-- verebona:optional-index
-- Migration 0380 (index 1/1) : forfaits d'usage par bien (lot 54D, TCO).
-- UNE instruction par fichier : CONCURRENTLY hors transaction. Idempotente.
CREATE INDEX CONCURRENTLY IF NOT EXISTS asset_usage_budgets_asset_idx
  ON asset_usage_budgets (asset_id, account_id);
