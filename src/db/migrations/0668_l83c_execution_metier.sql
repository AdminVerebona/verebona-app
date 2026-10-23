-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0668 : identifiant d'exécution métier porté par les appels IA —
-- lot 83C (CDC Pilotage IA V2, phase P2 « exécution métier et issue finale » :
-- SEM-01, SEM-03, SEM-04, OP-04, R22, R56).
--
--   ai_usage_event.business_execution_id
--   ai_call_captures.business_execution_id
--     Exécution MÉTIER à laquelle l'appel (tentative fournisseur, réparation,
--     repli) appartient. CORRÉLATION MINIMALE (SEM-01) : aucune nouvelle table,
--     aucun nouveau statut dans les tables natives, aucun second journal.
--     L'exécution métier elle-même est une PROJECTION recalculée à la lecture
--     depuis les états natifs (`src/services/ai/business-execution/`) :
--       T1  `T1:<uuid>` porté par le travail de file (payload.businessExecution)
--           et le rapport d'exécution (sources.businessExecutionId) ; une
--           reprise (remise en file, reprise serveur, rejeu, reprise ciblée)
--           garde l'identifiant, une nouvelle analyse en reçoit un nouveau ;
--       T2  `T2:<request_id>` (verebona_request_runs) ;
--       T3  `T3:<job_id>`, T4 `T4:<job_id>` (ai_job_queue) ;
--       T6  `T6F:<trace_id>` (génération FORMULATE, home_mascot_generations),
--           `T6E:<agenda_item_id>:<demande>` (évaluation EVALUATE,
--           t6_evaluation_runs) — un appel EVALUATE qui sert plusieurs
--           évaluations porte la liste dans metadata.businessExecutionIds et
--           laisse la colonne vide.
--     NULL : appel technique (sonde, qualification, test du fournisseur) ou
--     appel antérieur au lot 83 (« non déterminable », jamais reconstitué).
--
-- Colonnes écrites À PART par le code (contrôle de présence, comme 0217) :
-- une migration absente ne fait jamais échouer une trace. Aucune donnée
-- personnelle (identifiants techniques). Idempotente.
-- Retour arrière : colonnes ignorées par le code antérieur.
-- ──────────────────────────────────────────────────────────────────────────────

SET LOCAL lock_timeout = '5s';

ALTER TABLE ai_usage_event ADD COLUMN IF NOT EXISTS business_execution_id TEXT;

DO $$
BEGIN
  IF to_regclass('ai_call_captures') IS NOT NULL THEN
    ALTER TABLE ai_call_captures ADD COLUMN IF NOT EXISTS business_execution_id TEXT;
    COMMENT ON COLUMN ai_call_captures.business_execution_id IS
      'Lot 83C : exécution métier de l''appel capturé (même valeur que ai_usage_event.business_execution_id). NULL : technique ou antérieur.';
  END IF;
END $$;

COMMENT ON COLUMN ai_usage_event.business_execution_id IS
  'Lot 83C (Pilotage IA V2 P2) : exécution métier de l''appel (T1:<uuid>, T2:<request_id>, T3:<job>, T4:<job>, T6F:<trace>, T6E:<échéance>:<demande>). NULL : appel technique ou antérieur au lot 83.';
