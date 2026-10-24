-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0700 : Opérations v5 — purge et reconstruction en préproduction
-- (lot 85A ; CDC « Opérations, Agenda, Timeline, Sinistres v5 » lot O-2, §20,
-- AC41–AC43, E20 ; arbitrages PO V-Q2, V-Q3, C-Q5, C-Q8, C-Q10 du 23/10/2026).
--
-- La purge et la reconstruction sont pilotées depuis le BO (Exploitation ›
-- Rattrapages, « Opérations v5 : purge et reconstruction ») — Simuler /
-- Appliquer / Restaurer —, jamais automatiquement, et l'application est
-- REFUSÉE sans point de restauration de moins de 24 h (C-Q8).
--
-- Cette migration ne supprime ni ne modifie RIEN : elle crée seulement le
-- journal du rattrapage :
--   operations_rebuild_runs       — exécutions (mode, motif, auteur, point de
--                                   restauration exigé, compteurs, comptes
--                                   exclus, campagne de cohérence demandée,
--                                   restauration) ;
--   operations_rebuild_accounts   — rapport PAR COMPTE (statut, empreintes de
--                                   l'état avant / après — idempotence et
--                                   refus de restauration d'un compte modifié
--                                   depuis —, inventaire, reconstruction, TCO
--                                   relu, coût IA mesuré) ;
--   operations_rebuild_snapshots  — image AVANT des lignes du compte de chaque
--                                   table du périmètre (restauration exacte
--                                   par identifiant d'exécution).
-- Aucune colonne bien / document : ces journaux restent au compte (transfert
-- Duo sans objet). Conservées telles quelles lors d'une restauration complète
-- de la base (RESTORE_KEEP_CURRENT_TABLES), comme les autres journaux.
-- Index : 0700_..._idx_1 (CONCURRENTLY). Idempotente.
-- Retour arrière : DROP TABLE IF EXISTS operations_rebuild_snapshots,
-- operations_rebuild_accounts, operations_rebuild_runs (aucune autre table).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS operations_rebuild_runs (
  id                       UUID        PRIMARY KEY,
  mode                     TEXT        NOT NULL,
  account_filter           INTEGER,
  status                   TEXT        NOT NULL DEFAULT 'running',
  reason                   TEXT,
  admin_user_id            INTEGER,
  rebuild_version          TEXT        NOT NULL,
  restore_point_id         TEXT,
  restore_point_at         TIMESTAMPTZ,
  restore_of               UUID,
  counters                 JSONB       NOT NULL DEFAULT '{}'::jsonb,
  accounts                 INTEGER[]   NOT NULL DEFAULT '{}',
  excluded                 JSONB       NOT NULL DEFAULT '[]'::jsonb,
  coherence_campaign_id    BIGINT,
  error                    TEXT,
  started_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at              TIMESTAMPTZ,
  CONSTRAINT operations_rebuild_runs_mode_chk CHECK (mode IN ('SIMULATE', 'APPLY', 'RESTORE', 'REFUSED')),
  CONSTRAINT operations_rebuild_runs_status_chk CHECK (status IN ('running', 'succeeded', 'partial', 'failed', 'refused')),
  CONSTRAINT operations_rebuild_runs_counters_chk CHECK (jsonb_typeof(counters) = 'object'),
  CONSTRAINT operations_rebuild_runs_excluded_chk CHECK (jsonb_typeof(excluded) = 'array')
);

COMMENT ON TABLE operations_rebuild_runs IS
  'Lot 85A : exécutions du rattrapage BO « Opérations v5 : purge et reconstruction » (simulation, application, restauration, refus sans point de restauration).';

CREATE TABLE IF NOT EXISTS operations_rebuild_accounts (
  id               BIGSERIAL   PRIMARY KEY,
  run_id           UUID        NOT NULL REFERENCES operations_rebuild_runs(id) ON DELETE CASCADE,
  account_id       INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  status           TEXT        NOT NULL,
  rebuild_version  TEXT        NOT NULL,
  before_hash      TEXT,
  after_hash       TEXT,
  report           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  restored_at      TIMESTAMPTZ,
  restore_run_id   UUID,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at      TIMESTAMPTZ,
  CONSTRAINT operations_rebuild_accounts_run_account_uq UNIQUE (run_id, account_id),
  CONSTRAINT operations_rebuild_accounts_status_chk CHECK (status IN (
    'PLANNED', 'UP_TO_DATE', 'INELIGIBLE', 'BUSY', 'REBUILT', 'PARTIAL', 'FAILED', 'RESTORED', 'RESTORE_REFUSED')),
  CONSTRAINT operations_rebuild_accounts_report_chk CHECK (jsonb_typeof(report) = 'object')
);

COMMENT ON TABLE operations_rebuild_accounts IS
  'Lot 85A : rapport par compte de la purge et reconstruction des Opérations (statut, empreintes avant / après, inventaire, TCO relu, coût IA).';

CREATE TABLE IF NOT EXISTS operations_rebuild_snapshots (
  run_id      UUID        NOT NULL REFERENCES operations_rebuild_runs(id) ON DELETE CASCADE,
  account_id  INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  table_name  TEXT        NOT NULL,
  row_count   INTEGER     NOT NULL,
  rows        JSONB       NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT operations_rebuild_snapshots_pk PRIMARY KEY (run_id, account_id, table_name),
  CONSTRAINT operations_rebuild_snapshots_rows_chk CHECK (jsonb_typeof(rows) = 'array'),
  CONSTRAINT operations_rebuild_snapshots_table_chk CHECK (table_name ~ '^[a-z_][a-z0-9_]*$')
);

COMMENT ON TABLE operations_rebuild_snapshots IS
  'Lot 85A : image AVANT des lignes d''un compte (tables du périmètre de la reconstruction) — restauration exacte par identifiant d''exécution.';
