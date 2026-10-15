-- verebona:optional-index
-- Migration 0405 (index 3/6) : file des envois durables à reprendre (lot 57A).
-- UNE instruction par fichier : CONCURRENTLY hors transaction. Idempotente.
CREATE INDEX CONCURRENTLY IF NOT EXISTS transactional_email_jobs_due_idx
  ON transactional_email_jobs (next_attempt_at) WHERE status IN ('pending', 'sending');
