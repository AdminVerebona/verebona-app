-- verebona:optional-index
-- Migration 0638 (index 1/1) : lots dont le résultat reste à notifier (lot 81E).
-- UNE instruction par fichier : CONCURRENTLY hors transaction. Idempotente.
CREATE INDEX CONCURRENTLY IF NOT EXISTS document_lots_notification_awaiting_idx
  ON document_lots (created_at) WHERE notification_state = 'awaiting';
