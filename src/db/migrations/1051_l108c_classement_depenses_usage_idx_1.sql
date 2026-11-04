-- verebona:optional-index
-- Migration 1051 (index 1/1) : classements « dépense d'usage » par bien (lot 108C).
-- UNE instruction par fichier : CONCURRENTLY hors transaction. Idempotente.
CREATE INDEX CONCURRENTLY IF NOT EXISTS asset_usage_line_assignments_asset_idx
  ON asset_usage_line_assignments (asset_id, account_id);
