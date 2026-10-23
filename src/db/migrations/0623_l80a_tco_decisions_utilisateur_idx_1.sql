-- verebona:optional-index
-- Migration 0623 (index 1/1) : journal des décisions TCO par bien (lot 80A).
-- UNE instruction par fichier : CONCURRENTLY hors transaction. Idempotente.
CREATE INDEX CONCURRENTLY IF NOT EXISTS asset_cost_line_decision_events_asset_idx
  ON asset_cost_line_decision_events (asset_id, account_id, created_at DESC);
