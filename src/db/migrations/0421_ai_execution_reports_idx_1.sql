-- verebona:optional-index
-- Migration 0421 (index 1/5) : rapports d'exécution du compte, du plus récent
-- au plus ancien (liste BO, isolation par compte). UNE instruction par
-- fichier (CONCURRENTLY hors transaction). Idempotente.
CREATE INDEX CONCURRENTLY IF NOT EXISTS ai_execution_reports_account_idx
  ON ai_execution_reports (account_id, created_at DESC);
