-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0516 : écarts résiduels du moteur « À traiter » (lot 72C — ticket
-- « [P1] À traiter — Corriger les écarts résiduels de pertinence, de calcul
-- et de réévaluation », C3, C4, C7).
--
--   document_rule_evaluations (0418, 0444)
--     decision_kind   nature de la décision, pour expliquer une carte créée,
--                     conservée, fermée ou NON créée (C7) : CARD_CREATED,
--                     CARD_KEPT, CARD_CLOSED, AUTO_RESOLVED, NOT_RELEVANT,
--                     MISSING_INFO_NOT_REQUIRED, DEFERRED, USER_REFUSED,
--                     ALREADY_KNOWN, NOT_ELIGIBLE, TECHNICAL_FAILURE.
--                     NULL = ligne antérieure (le BO la déduit).
--
--   to_process_decisions — décisions des familles « état de la base »
--     (agenda DATA-AGENDA-DATE, équipements LINK-EQUIP-ASSET, fournisseurs
--     SUPPLIER-IDENTITY) par le contrôle d'admissibilité commun (C4), Y
--     COMPRIS sans carte (C7) : règle, cible, déclencheur, issue, nature,
--     motif, question décisive, faits utilisés (identifiants, codes, dates —
--     jamais de texte intégral), effet (carte créée / maintenue / fermée,
--     écriture), prochaine réévaluation, erreur. Dédupliquée par signature
--     (une ligne tant que rien ne change, passages ≤ 20) ; rétention : les
--     lignes REMPLACÉES de plus de 400 jours sont purgées par la tâche
--     planifiée, la dernière décision d'une cible est toujours conservée.
--
--   to_process_config_baselines — base de contenu de la configuration T4
--     par référence de version (C3) : une révision SAUVEGARDÉE de la version
--     active (texte, modèle…) change la référence des décisions IA même à
--     numéro de version égal ; le contenu observé au premier passage sert de
--     base (aucune décision mémorisée invalidée au déploiement).
--
-- Colonnes NULLables, tables neuves (vides) : aucune réécriture. Le code
-- sonde leur présence (fenêtre de déploiement sans effet). Idempotente.
-- Index dans 0516_..._idx_1 (CONCURRENTLY).
-- Retour arrière : ALTER TABLE document_rule_evaluations DROP COLUMN IF
-- EXISTS decision_kind ; DROP TABLE IF EXISTS to_process_decisions,
-- to_process_config_baselines (code tolérant : comportement du lot 71).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF to_regclass('document_rule_evaluations') IS NOT NULL THEN
    ALTER TABLE document_rule_evaluations ADD COLUMN IF NOT EXISTS decision_kind TEXT;
    COMMENT ON COLUMN document_rule_evaluations.decision_kind IS
      'Lot 72 (C7) : nature de la décision (carte créée / conservée / fermée, résolution automatique, hors pertinence, report, refus utilisateur, échec technique…).';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS to_process_decisions (
  id              BIGSERIAL   PRIMARY KEY,
  account_id      INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- AGENDA_ITEM | EQUIPMENT | SUPPLIER
  target_type     TEXT        NOT NULL,
  target_id       INTEGER     NOT NULL,
  rule_code       TEXT        NOT NULL,
  data_key        TEXT,
  -- SWEEP | BACKFILL | USER | ANALYSIS
  trigger_code    TEXT        NOT NULL,
  run_ref         TEXT,
  engine_version  TEXT        NOT NULL,
  -- AUTO_RESOLVED | NO_ACTION | DEFER | CREATE_ACTION | ERROR
  outcome         TEXT        NOT NULL,
  decision_kind   TEXT,
  reason_code     TEXT,
  decisive_check  TEXT,
  checks          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  evidence        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  -- CREATED | KEPT | CLOSED | WRITTEN | NONE | ERROR
  effect          TEXT        NOT NULL,
  action_ids      JSONB,
  reevaluate_at   TIMESTAMPTZ,
  error           TEXT,
  signature       TEXT        NOT NULL,
  seen_count      INTEGER     NOT NULL DEFAULT 1,
  passages        JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT to_process_decisions_outcome_chk CHECK (outcome IN ('AUTO_RESOLVED', 'NO_ACTION', 'DEFER', 'CREATE_ACTION', 'ERROR')),
  CONSTRAINT to_process_decisions_effect_chk CHECK (effect IN ('CREATED', 'KEPT', 'CLOSED', 'WRITTEN', 'NONE', 'ERROR'))
);

COMMENT ON TABLE to_process_decisions IS
  'Lot 72 (C4, C7) : décisions du contrôle d''admissibilité « À traiter » des familles agenda / équipements / fournisseurs, y compris sans carte (diagnostic BO).';

CREATE TABLE IF NOT EXISTS to_process_config_baselines (
  base_ref       TEXT        PRIMARY KEY,
  content_hash   TEXT        NOT NULL,
  first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE to_process_config_baselines IS
  'Lot 72 (C3) : contenu de référence de la configuration T4 par version — une révision sauvegardée de la version active invalide les décisions IA dépendantes.';
