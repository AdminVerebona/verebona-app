-- verebona:optional-index
-- Migration 0421 (index 2/5) : rapports d'une trace d'appel IA (détail d'une
-- exécution BO). Idempotente.
CREATE INDEX CONCURRENTLY IF NOT EXISTS ai_execution_reports_traces_idx
  ON ai_execution_reports USING GIN (trace_ids);
