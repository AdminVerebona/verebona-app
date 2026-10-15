-- verebona:optional-index
-- Migration 0405 (index 4/6) : envois durables par utilisateur (lot 57A).
-- UNE instruction par fichier : CONCURRENTLY hors transaction. Idempotente.
CREATE INDEX CONCURRENTLY IF NOT EXISTS transactional_email_jobs_user_idx
  ON transactional_email_jobs (user_id, kind);
