-- verebona:optional-index
-- Migration 0585 (index 1/1) : demandes neutralisées par le retour aux rappels
-- Stripe (contrôle de la phase « retour arrière en cours », lot 76D). UNE
-- instruction par fichier (CONCURRENTLY hors transaction). Idempotente.
CREATE INDEX CONCURRENTLY IF NOT EXISTS transactional_email_jobs_neutralized_idx
  ON transactional_email_jobs (kind, status) WHERE neutralized_at IS NOT NULL;
