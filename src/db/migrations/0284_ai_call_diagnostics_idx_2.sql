-- Migration 0284 (index 2/3) : purge par ancienneté (tâche planifiée
-- `ai-call-diagnostics-purge`). UNE instruction par fichier (CONCURRENTLY).
-- Idempotente.
--
-- INDEX OPTIONNEL : la purge fonctionne sans lui, par lots bornés.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS ai_call_diagnostics_created_idx ON ai_call_diagnostics (created_at);
