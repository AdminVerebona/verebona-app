-- verebona:optional-index
-- Migration 0405 (index 5/6) : envois durables par Duo (lot 57A).
-- UNE instruction par fichier : CONCURRENTLY hors transaction. Idempotente.
CREATE INDEX CONCURRENTLY IF NOT EXISTS transactional_email_jobs_duo_idx
  ON transactional_email_jobs (duo_id, kind);
