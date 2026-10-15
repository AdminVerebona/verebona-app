-- verebona:optional-index
-- Migration 0405 (index 1/6) : e-mails par identifiant Resend (webhooks) (lot 57A).
-- UNE instruction par fichier : CONCURRENTLY hors transaction. Idempotente.
CREATE INDEX CONCURRENTLY IF NOT EXISTS email_logs_provider_message_id_idx
  ON email_logs (provider_message_id) WHERE provider_message_id IS NOT NULL;
