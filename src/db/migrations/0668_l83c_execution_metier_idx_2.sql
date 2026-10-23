-- Migration 0668 (index 2/2) : captures d'une exécution métier — lot 83C.
-- UNE instruction par fichier. Idempotente.
CREATE INDEX CONCURRENTLY IF NOT EXISTS ai_call_captures_business_execution_idx ON ai_call_captures (business_execution_id) WHERE business_execution_id IS NOT NULL;
