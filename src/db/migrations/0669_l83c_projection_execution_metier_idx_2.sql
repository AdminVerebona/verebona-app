-- Migration 0669 (index 2/7) : travaux T1 d'une exécution métier
-- (payload.businessExecution.id : reprises comprises) — lot 83C.
-- UNE instruction. Idempotente.
CREATE INDEX CONCURRENTLY IF NOT EXISTS ai_job_queue_business_execution_idx ON ai_job_queue ((payload->'businessExecution'->>'id')) WHERE payload ? 'businessExecution';
