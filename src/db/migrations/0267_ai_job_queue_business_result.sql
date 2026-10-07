-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0267 : résultat métier des travaux de file — lot 31C (ticket « T3 —
-- Durcir et formaliser le contrat de la file durable », §10 et §23).
--
-- Un travail T3 peut être parfaitement exécuté sans rien modifier. Le statut
-- technique (`status` : DONE / FAILED) ne le dit pas : il manquait le résultat
-- MÉTIER, écrit à la clôture d'un travail DONE :
--   APPLIED | NO_CHANGE | ABSTAIN | SUPERSEDED | TARGET_GONE.
-- `business_result_detail` porte des compteurs et identifiants (décisions,
-- appliquées, conflits, run, page de balayage…), jamais de valeur métier.
--
-- Les autres colonnes d'observabilité exigées (job, compte, cible, origine,
-- déclencheur, statut, tentatives, reprises, dates, worker, exécution,
-- version, dernière erreur) existent déjà (0132, 0136, 0141) ; la sorte de
-- travail est `payload->>'kind'` (contrat versionné `payloadVersion`).
--
-- Pas de contrainte CHECK sur les codes : la file est commune (T1, T4) et le
-- vocabulaire est défini dans le code (`queue-policy.BUSINESS_RESULTS`).
-- Idempotente (ADD COLUMN IF NOT EXISTS). Retour arrière : colonnes ignorées
-- par l'ancien code.
-- ──────────────────────────────────────────────────────────────────────────────

SET LOCAL lock_timeout = '5s';

ALTER TABLE ai_job_queue ADD COLUMN IF NOT EXISTS business_result        TEXT;
ALTER TABLE ai_job_queue ADD COLUMN IF NOT EXISTS business_result_detail JSONB;

COMMENT ON COLUMN ai_job_queue.business_result IS
  'Résultat métier d''un travail DONE (APPLIED, NO_CHANGE, ABSTAIN, SUPERSEDED, TARGET_GONE) — lot 31C. NULL : non clos, échec technique ou exécutant sans résultat.';
COMMENT ON COLUMN ai_job_queue.business_result_detail IS
  'Compteurs et identifiants du résultat métier (jamais de valeur métier).';
