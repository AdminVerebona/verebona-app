-- verebona:optional-index
-- Migration 0421 (index 4/5) : rapports d'un document (corrélation T1 → T3,
-- historique après réanalyse). Idempotente.
CREATE INDEX CONCURRENTLY IF NOT EXISTS ai_execution_reports_file_idx
  ON ai_execution_reports (account_id, file_id, created_at DESC) WHERE file_id IS NOT NULL;
