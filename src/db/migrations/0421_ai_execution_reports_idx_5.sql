-- verebona:optional-index
-- Migration 0421 (index 5/5) : rapports dont les lignes sont portées par un
-- rapport antérieur identique (purge : un rapport désigné est conservé).
-- Idempotente.
CREATE INDEX CONCURRENTLY IF NOT EXISTS ai_execution_reports_entries_ref_idx
  ON ai_execution_reports (entries_report_id) WHERE entries_report_id IS NOT NULL;
