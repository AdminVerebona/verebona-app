-- Migration 0669 (index 3/7) : rapports d'exécution par traitement et date
-- (période des exécutions métier) — lot 83C. UNE instruction. Idempotente.
CREATE INDEX CONCURRENTLY IF NOT EXISTS ai_execution_reports_treatment_created_idx ON ai_execution_reports (treatment, created_at);
