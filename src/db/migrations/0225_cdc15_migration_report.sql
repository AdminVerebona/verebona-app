-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0225 : rapport des rattrapages de données du CDC 15 (§14, MIG-01 à
-- MIG-09 ; plan lot 17 volet B ; décisions D-10, D-16).
--
-- `scripts/cdc15-backfill.ts` (lancement MANUEL) écrit ici, par exécution
-- (`run_id`) et par étape, chaque décision prise — ou qui serait prise en
-- simulation — sur une entité :
--
--   decision  APPLIED       écrit (apply) / à écrire (dry_run) ;
--             SKIPPED_USER  valeur USER ou ADMIN : jamais écrasée (MIG-09) ;
--             AMBIGUOUS     non tranché : rapport, et carte « À traiter »
--                           MIG-REVIEW quand l'utilisateur peut arbitrer ;
--             NO_CHANGE     déjà conforme (seulement pour les candidats
--                           examinés, pas pour chaque ligne parcourue).
--   before_value / after_value : valeurs AVANT / APRÈS, les données
--             sensibles MASQUÉES (clés `sensitive` du registre, secrets,
--             pièces d'identité, coordonnées bancaires) ;
--   reason    code stable du motif (ex. ALIAS_CONFLICT, EXACT_EVIDENCE_X100).
--
-- `cdc15_migration_runs` : une ligne par exécution (mode, étapes, compte
-- ciblé, options, curseurs par étape pour la reprise, compteurs, statut).
--
-- Tables nouvelles, aucune donnée existante touchée : création idempotente,
-- sans verrou sur une table en service. Écrites et lues en SQL
-- (`services/migration/cdc15`) ; non déclarées dans Drizzle.
-- Compte supprimé → ses lignes de rapport sont supprimées (cascade).
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS cdc15_migration_runs (
  run_id       UUID PRIMARY KEY,
  run_mode     TEXT NOT NULL,
  steps        TEXT[] NOT NULL,
  account_id   INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
  options      JSONB NOT NULL DEFAULT '{}'::jsonb,
  cursors      JSONB NOT NULL DEFAULT '{}'::jsonb,
  counts       JSONB NOT NULL DEFAULT '{}'::jsonb,
  status       TEXT NOT NULL DEFAULT 'RUNNING',
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ,
  CONSTRAINT cdc15_migration_runs_mode_check CHECK (run_mode IN ('dry_run', 'apply')),
  CONSTRAINT cdc15_migration_runs_status_check CHECK (status IN ('RUNNING', 'DONE', 'FAILED', 'PARTIAL'))
);

CREATE TABLE IF NOT EXISTS cdc15_migration_report (
  id            BIGSERIAL PRIMARY KEY,
  run_id        UUID NOT NULL,
  run_mode      TEXT NOT NULL,
  step          TEXT NOT NULL,
  account_id    INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
  asset_id      INTEGER,
  entity_type   TEXT NOT NULL,
  entity_id     TEXT,
  field_key     TEXT,
  before_value  JSONB,
  after_value   JSONB,
  decision      TEXT NOT NULL,
  reason        TEXT,
  details       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cdc15_migration_report_decision_check
    CHECK (decision IN ('APPLIED', 'SKIPPED_USER', 'AMBIGUOUS', 'NO_CHANGE')),
  CONSTRAINT cdc15_migration_report_mode_check CHECK (run_mode IN ('dry_run', 'apply')),
  CONSTRAINT cdc15_migration_report_step_check
    CHECK (step IN ('MIG-01', 'MIG-02', 'MIG-03', 'MIG-04', 'MIG-05', 'MIG-06', 'MIG-07', 'MIG-08'))
);

CREATE INDEX IF NOT EXISTS cdc15_migration_report_run_idx ON cdc15_migration_report (run_id, step, decision);
CREATE INDEX IF NOT EXISTS cdc15_migration_report_account_idx ON cdc15_migration_report (account_id, created_at);
CREATE INDEX IF NOT EXISTS cdc15_migration_report_ambiguous_idx ON cdc15_migration_report (step, created_at)
  WHERE decision = 'AMBIGUOUS';

COMMENT ON TABLE cdc15_migration_report IS
  'Rapport des rattrapages CDC 15 §14 (MIG-01 à MIG-09) : décision par entité, avant / après masqués.';
COMMENT ON TABLE cdc15_migration_runs IS
  'Exécutions de scripts/cdc15-backfill.ts : mode, étapes, curseurs de reprise, compteurs.';
