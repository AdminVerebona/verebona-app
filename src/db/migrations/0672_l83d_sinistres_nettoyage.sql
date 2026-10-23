-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0672 : Sinistres — nettoyage de l'ancien modèle (lot 83D ; CDC
-- « Opérations, Agenda, Timeline, Sinistres v5 » §15 à §18 ; arbitrages PO
-- V-Q1, V-Q2, V-Q8 du 23/10/2026).
--
-- Le code du lot 83D ne lit ni n'écrit plus les structures PROPRES à l'ancien
-- bloc « Sinistres » du bien : actions et échanges de sinistre, intervention
-- enfant (`business_operations.parent_operation_id`), ancien formulaire
-- `asset_additional_infos.claim_json` et repères de sa migration, cartes
-- « À traiter » parent / dissociation. Leurs DONNÉES de préproduction sont
-- purgées par un rattrapage BO (Exploitation › Rattrapages, « Sinistres :
-- nettoyage de l'ancien modèle ») — Simuler / Appliquer / Restaurer — qui
-- REFUSE d'appliquer sans point de restauration de moins de 24 h (C-Q8).
--
-- Cette migration ne supprime RIEN : elle crée seulement
--   claim_legacy_cleanup_runs     — exécutions (mode, motif, auteur, point de
--                                   restauration exigé, compteurs, campagne de
--                                   cohérence demandée, restauration) ;
--   claim_legacy_cleanup_journal  — image AVANT de chaque ligne supprimée ou
--                                   modifiée (et clé de chaque ligne insérée)
--                                   par une application : restauration ligne
--                                   à ligne par identifiant d'exécution.
-- Les deux tables sont conservées telles quelles lors d'une restauration
-- complète de la base (RESTORE_KEEP_CURRENT_TABLES), comme les autres
-- journaux de rattrapage.
--
-- Aucun DROP TABLE dans ce lot : les tables devenues inertes
-- (business_operation_claim_actions, business_operation_claim_exchanges,
-- business_operation_claim_migration_marks) et les colonnes inertes
-- (business_operations.parent_operation_id, asset_additional_infos.claim_json)
-- sont supprimées au lot O-10, après la recette du nettoyage.
-- Index : 0672_..._idx_1 (CONCURRENTLY). Idempotente.
-- Retour arrière : DROP TABLE IF EXISTS claim_legacy_cleanup_journal,
-- claim_legacy_cleanup_runs (aucune autre table touchée).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS claim_legacy_cleanup_runs (
  id                       UUID        PRIMARY KEY,
  mode                     TEXT        NOT NULL,
  account_filter           INTEGER,
  status                   TEXT        NOT NULL DEFAULT 'running',
  reason                   TEXT,
  admin_user_id            INTEGER,
  restore_point_id         TEXT,
  restore_point_at         TIMESTAMPTZ,
  restore_of               UUID,
  counters                 JSONB       NOT NULL DEFAULT '{}'::jsonb,
  accounts                 INTEGER[]   NOT NULL DEFAULT '{}',
  coherence_campaign_id    BIGINT,
  error                    TEXT,
  started_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at              TIMESTAMPTZ,
  CONSTRAINT claim_legacy_cleanup_runs_mode_chk CHECK (mode IN ('SIMULATE', 'APPLY', 'RESTORE', 'REFUSED')),
  CONSTRAINT claim_legacy_cleanup_runs_status_chk CHECK (status IN ('running', 'succeeded', 'failed', 'refused')),
  CONSTRAINT claim_legacy_cleanup_runs_counters_chk CHECK (jsonb_typeof(counters) = 'object')
);

COMMENT ON TABLE claim_legacy_cleanup_runs IS
  'Lot 83D : exécutions du rattrapage BO « Sinistres : nettoyage de l''ancien modèle » (simulation, application, restauration, refus sans point de restauration).';

CREATE TABLE IF NOT EXISTS claim_legacy_cleanup_journal (
  id               BIGSERIAL   PRIMARY KEY,
  run_id           UUID        NOT NULL REFERENCES claim_legacy_cleanup_runs(id) ON DELETE CASCADE,
  account_id       INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  target_table     TEXT        NOT NULL,
  target_key       JSONB       NOT NULL,
  action           TEXT        NOT NULL,
  before_row       JSONB,
  after_row        JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  restored_at      TIMESTAMPTZ,
  restore_run_id   UUID,
  restore_detail   JSONB,
  CONSTRAINT claim_legacy_cleanup_journal_action_chk CHECK (action IN ('DELETE', 'UPDATE', 'INSERT')),
  CONSTRAINT claim_legacy_cleanup_journal_table_chk CHECK (target_table IN (
    'business_operation_claim_actions', 'business_operation_claim_exchanges', 'business_operation_claim_migration_marks',
    'business_operations', 'asset_additional_infos', 'to_process_actions', 'to_process_action_events'
  )),
  CONSTRAINT claim_legacy_cleanup_journal_key_chk CHECK (jsonb_typeof(target_key) = 'object')
);

COMMENT ON TABLE claim_legacy_cleanup_journal IS
  'Lot 83D : image avant de chaque ligne purgée de l''ancien modèle Sinistres (actions, échanges, enfant d''intervention, claim_json, repères, cartes retirées) — restaurable par exécution.';
