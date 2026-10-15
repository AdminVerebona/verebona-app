-- verebona:optional-index
-- Migration 0405 (index 6/6) : événements Resend par message (lot 57A).
-- UNE instruction par fichier : CONCURRENTLY hors transaction. Idempotente.
CREATE INDEX CONCURRENTLY IF NOT EXISTS email_provider_events_message_idx
  ON email_provider_events (provider_message_id);
