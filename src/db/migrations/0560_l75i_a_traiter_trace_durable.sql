-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0560 : « À traiter » — traçabilité durable et bilan fidèle des
-- balayages (lot 75I — ticket « [P1] À traiter — écarts résiduels de
-- pertinence, fiabiliser le balayage et finaliser la recette T4 », B et E).
--
--   to_process_evaluation_passages — UNE ligne par passage d'une évaluation
--     (règle documentaire `document_rule_evaluations` ou décision de famille
--     `to_process_decisions`), écrite dans la MÊME instruction que la
--     déduplication de l'évaluation (atomique). La colonne `passages` des
--     deux tables reste l'aperçu des 20 derniers ; cette table garde TOUS
--     les passages (déclencheur, référence d'exécution, date) : plus aucune
--     perte silencieuse au-delà de 20 exécutions. Rétention explicite : les
--     passages de plus de 400 jours sont purgés par la tâche planifiée
--     `to-process-relevance-reevaluation` (comme les décisions remplacées) ;
--     une évaluation purgée emporte ses passages (ON DELETE CASCADE).
--
--   to_process_scan_runs (0256)
--     failed_accounts  comptes dont le traitement a échoué SANS résultat
--                      exploitable (statut « error » si tous ont échoué) ;
--     error_details    erreurs détaillées du passage (≤ 50) : compte,
--                      document, règle, étape, nature, cause — dont les
--                      écritures NON CONFIRMÉES, les erreurs de persistance
--                      et de journalisation ;
--     summary          bilan : documents réévalués, issues par décision,
--                      refus normaux (valeur de l'utilisateur protégée),
--                      erreurs de règle, de trace.
--
-- Table neuve (vide), colonnes NULLables : aucune réécriture. Le code sonde
-- leur présence (fenêtre de déploiement sans effet). Idempotente.
-- Index dans 0560_..._idx_1 (CONCURRENTLY).
-- Retour arrière : DROP TABLE IF EXISTS to_process_evaluation_passages ;
-- ALTER TABLE to_process_scan_runs DROP COLUMN IF EXISTS failed_accounts,
-- DROP COLUMN IF EXISTS error_details, DROP COLUMN IF EXISTS summary (code
-- tolérant : comportement du lot 74).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS to_process_evaluation_passages (
  id                BIGSERIAL   PRIMARY KEY,
  account_id        INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- DOCUMENT_RULE (document_rule_evaluations) | FAMILY (to_process_decisions)
  source            TEXT        NOT NULL,
  rule_evaluation_id BIGINT     REFERENCES document_rule_evaluations(id) ON DELETE CASCADE,
  family_decision_id BIGINT     REFERENCES to_process_decisions(id) ON DELETE CASCADE,
  -- INSERTED (nouvelle évaluation) | REPEATED (évaluation identique dédupliquée)
  kind              TEXT        NOT NULL,
  trigger_code      TEXT        NOT NULL,
  run_ref           TEXT,
  seen_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT to_process_evaluation_passages_source_chk CHECK (source IN ('DOCUMENT_RULE', 'FAMILY')),
  CONSTRAINT to_process_evaluation_passages_kind_chk CHECK (kind IN ('INSERTED', 'REPEATED')),
  CONSTRAINT to_process_evaluation_passages_target_chk CHECK (
    (source = 'DOCUMENT_RULE' AND rule_evaluation_id IS NOT NULL AND family_decision_id IS NULL)
    OR (source = 'FAMILY' AND family_decision_id IS NOT NULL AND rule_evaluation_id IS NULL))
);

COMMENT ON TABLE to_process_evaluation_passages IS
  'Lot 75I (E) : chaque passage d''une évaluation « À traiter » (règle documentaire ou décision de famille), sans limite de nombre ; rétention 400 jours.';

DO $$
BEGIN
  IF to_regclass('to_process_scan_runs') IS NOT NULL THEN
    ALTER TABLE to_process_scan_runs ADD COLUMN IF NOT EXISTS failed_accounts INTEGER;
    ALTER TABLE to_process_scan_runs ADD COLUMN IF NOT EXISTS error_details JSONB;
    ALTER TABLE to_process_scan_runs ADD COLUMN IF NOT EXISTS summary JSONB;
    COMMENT ON COLUMN to_process_scan_runs.error_details IS
      'Lot 75I (B) : erreurs détaillées du passage (compte, document, règle, étape, nature, cause), ≤ 50.';
  END IF;
END $$;
