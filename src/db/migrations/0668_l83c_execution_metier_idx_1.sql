-- Migration 0668 (index 1/2) : appels d'une exécution métier (détail BO,
-- comptage des appels et coûts par exécution) — lot 83C.
-- UNE instruction par fichier (`CREATE INDEX CONCURRENTLY` hors transaction).
-- Idempotente.
CREATE INDEX CONCURRENTLY IF NOT EXISTS ai_usage_event_business_execution_idx ON ai_usage_event (business_execution_id) WHERE business_execution_id IS NOT NULL;
