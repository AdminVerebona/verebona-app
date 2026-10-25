-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0776 : reclassement PROUVABLE de l'historique des appels IA —
-- lot 89A (CDC Pilotage IA V2, phase P8 : MIG-03, BO-05, LOG-08, R23, R59).
--
--   ai_usage_event.history_execution_id
--     Exécution métier ÉTABLIE PAR LE RECLASSEMENT pour un appel antérieur à
--     la corrélation à la source (lot 83C, migration 0668). Distincte de
--     `business_execution_id` (écrite par le nouveau chemin, jamais modifiée
--     par le reclassement) : on sait toujours qui a établi le rattachement.
--   ai_usage_event.history_class
--     Classement de l'appel et sa PREUVE, une ligne par appel :
--     { rule, runId, nature (BUSINESS / TECHNICAL / UNDETERMINED), treatment,
--       executionId, outcome (issue de l'exécution lue par la projection P2
--       au reclassement), evidence [{ source, ref, proves }], reason (motif du
--       « non déterminable »), classifiedAt, previous }.
--     Aucune donnée métier ni contenu : codes, tables et identifiants.
--
-- Écrites par la tâche interne `ai-history-reclassification` (AI_PILOTAGE_V2=on)
-- ou par le rattrapage du BO (Exploitation › Rattrapages), jamais par une
-- commande. Lecture tolérante (colonnes absentes : rien n'est reclassé).
-- Additive, idempotente, aucune donnée existante modifiée.
-- Retour arrière : « Restaurer » du rattrapage remet les deux colonnes à vide ;
-- colonnes ignorées par le code antérieur.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE ai_usage_event ADD COLUMN IF NOT EXISTS history_execution_id TEXT;
ALTER TABLE ai_usage_event ADD COLUMN IF NOT EXISTS history_class JSONB;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_usage_event_history_class_chk') THEN
    ALTER TABLE ai_usage_event ADD CONSTRAINT ai_usage_event_history_class_chk
      CHECK (history_class IS NULL OR jsonb_typeof(history_class) = 'object') NOT VALID;
  END IF;
END $$;

COMMENT ON COLUMN ai_usage_event.history_execution_id IS
  'Lot 89A (Pilotage IA V2 P8, MIG-03) : exécution métier établie par le reclassement de l''historique (preuve dans history_class). NULL : appel du nouveau chemin, technique ou non déterminable.';
COMMENT ON COLUMN ai_usage_event.history_class IS
  'Lot 89A (Pilotage IA V2 P8, MIG-03) : classement versionné d''un appel historique (règle, nature, traitement, exécution, issue, preuves, motif du non déterminable).';
