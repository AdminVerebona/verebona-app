-- Migration 0776 (index 1/1) : appels d'une exécution métier établis par le
-- reclassement de l'historique (détail BO, appels et coûts par exécution) —
-- lot 89A. UNE instruction par fichier (`CREATE INDEX CONCURRENTLY` hors
-- transaction). Idempotente.
CREATE INDEX CONCURRENTLY IF NOT EXISTS ai_usage_event_history_execution_idx ON ai_usage_event (history_execution_id) WHERE history_execution_id IS NOT NULL;
