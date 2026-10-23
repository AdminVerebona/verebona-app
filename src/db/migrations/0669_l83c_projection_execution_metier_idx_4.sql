-- Migration 0669 (index 4/7) : rapports T1 d'une exécution métier
-- (sources.businessExecutionId) — lot 83C. UNE instruction. Idempotente.
CREATE INDEX CONCURRENTLY IF NOT EXISTS ai_execution_reports_business_execution_idx ON ai_execution_reports ((sources->>'businessExecutionId')) WHERE sources ? 'businessExecutionId';
