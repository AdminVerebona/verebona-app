-- Migration 0288 (index 1/1) : jobs VIVANTS par cible — statut fonctionnel
-- des documents (lot 34C : « en file d'attente » seulement si un job attend
-- réellement), lu par document et par liste. UNE instruction par fichier :
-- `CREATE INDEX CONCURRENTLY` ne peut pas s'exécuter dans une transaction.
-- Idempotente ; un index laissé INVALIDE est reconstruit (`migration-index.ts`).
--
-- INDEX OPTIONNEL : sans lui, la lecture passe par `ai_job_queue_status_idx`
-- (les jobs vivants sont peu nombreux) — plus lent, jamais faux.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS ai_job_queue_live_target_idx ON ai_job_queue (target_type, target_id) WHERE status IN ('PENDING', 'RUNNING');
