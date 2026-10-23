-- Migration 0650 (index 1/1) : appels d'une exécution par trace — lot 82C.
-- Les traces IA ne sont plus supprimées après 88 jours (décision PO n° 10) :
-- le détail BO d'une exécution (`metadata->>'traceId'`) et la lecture des
-- captures ne doivent pas parcourir toute la table qui grandit désormais.
-- UNE instruction par fichier (`CREATE INDEX CONCURRENTLY` hors transaction).
-- Idempotente.
CREATE INDEX CONCURRENTLY IF NOT EXISTS ai_usage_event_trace_idx ON ai_usage_event ((metadata->>'traceId'));
