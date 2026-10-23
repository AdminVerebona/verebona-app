-- Migration 0649 (index 2/4) : captures d'une exécution (trace) dans l'ordre
-- des tentatives — lot 82C. UNE instruction par fichier. Idempotente.
CREATE INDEX CONCURRENTLY IF NOT EXISTS ai_call_captures_trace_idx ON ai_call_captures (trace_id, call_index, id);
