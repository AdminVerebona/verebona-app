-- verebona:optional-index
-- Migration 0405 (index 2/6) : recherche BO par type de message et date (lot 57A).
-- UNE instruction par fichier : CONCURRENTLY hors transaction. Idempotente.
CREATE INDEX CONCURRENTLY IF NOT EXISTS email_logs_template_sent_at_idx
  ON email_logs (template_code, sent_at DESC);
