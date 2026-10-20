-- verebona:optional-index
-- Migration 0524 (index 1/1) : réconciliation d'une acceptation incertaine par
-- les webhooks Resend (étiquette de la demande d'origine, lot 72F). UNE
-- instruction par fichier (CONCURRENTLY hors transaction). Idempotente.
CREATE INDEX CONCURRENTLY IF NOT EXISTS email_provider_events_email_job_idx
  ON email_provider_events (email_job_id) WHERE email_job_id IS NOT NULL;
