-- Migration 0649 (index 1/4) : capture d'un appel par son événement d'usage
-- (détail BO, contrôle « appels sans capture » de la Supervision) — lot 82C.
-- UNE instruction par fichier (`CREATE INDEX CONCURRENTLY` hors transaction).
-- Idempotente.
CREATE INDEX CONCURRENTLY IF NOT EXISTS ai_call_captures_usage_idx ON ai_call_captures (usage_event_id);
