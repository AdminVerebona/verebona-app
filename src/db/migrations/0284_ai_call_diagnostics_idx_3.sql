-- Migration 0284 (index 3/3) : derniers échecs d'un document (rejeu
-- automatique des sorties invalides, tâche `t1-invalid-output-replay`).
-- Partiel : seuls les appels en échec y entrent. UNE instruction par fichier
-- (CONCURRENTLY). Idempotente.
--
-- INDEX OPTIONNEL : le rejeu est borné (LIMIT) et fonctionne sans lui.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS ai_call_diagnostics_failed_sources_idx ON ai_call_diagnostics USING GIN (source_ids) WHERE outcome = 'FAILED';
