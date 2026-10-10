-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0288 : historique des tentatives d'un job de file IA — lot 34C
-- (ticket « ne plus exposer les erreurs techniques IA aux utilisateurs et
-- fiabiliser leur suivi dans BO › Exécutions IA »).
--
-- Une entrée par exécution terminée du job (succès, échec, report,
-- interruption, abandon) : numéro de tentative, début / fin, issue, motif
-- TECHNIQUE (borné, BO seulement), retry réellement prévu après cette
-- tentative et date de la prochaine tentative, statut du job après coup.
-- Permet à BO › Exécutions IA d'afficher « Tentative job #1 / #2 » avec la
-- cascade de modèles de chacune (les appels portent `metadata.jobAttempt`),
-- au lieu d'un simple « 2 tentative(s) ».
--
-- Écrite uniquement par le serveur (boucleur de file, reprise des exécutions
-- abandonnées). Jamais lue par l'application utilisateur. Idempotente.
-- ──────────────────────────────────────────────────────────────────────────────

SET LOCAL lock_timeout = '5s';

ALTER TABLE ai_job_queue ADD COLUMN IF NOT EXISTS attempt_history JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN ai_job_queue.attempt_history IS
  'Historique des tentatives du job (lot 34C) : [{attempt, startedAt, endedAt, outcome, businessResult, error, retryScheduled, nextAttemptAt, statusAfter}] — BO › Exécutions IA uniquement.';
