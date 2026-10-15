-- verebona:optional-index
-- Migration 0421 (index 3/5) : rapports d'un job de file (détail d'une
-- exécution BO) et rétention. Idempotente.
CREATE INDEX CONCURRENTLY IF NOT EXISTS ai_execution_reports_job_idx
  ON ai_execution_reports (job_id) WHERE job_id IS NOT NULL;
