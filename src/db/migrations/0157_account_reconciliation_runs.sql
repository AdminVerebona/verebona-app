-- =============================================================================
-- 0157 — T3 : réconciliation globale au niveau du compte.
--
-- account_reconciliation_runs : une exécution T3 (manuelle, planifiée ou
-- événementielle) sur un compte, avec son résultat consolidé et le détail
-- par objet. Les runs locaux du moteur commun (reconciliation_runs) y sont
-- rattachés par account_run_id : « cette valeur a été modifiée lors du run
-- T3 X, sur la base des preuves Y et Z » se reconstitue par jointure.
--
-- Concurrence : au plus UNE exécution en cours et UNE demande en attente
-- par compte (index uniques partiels). Une demande événementielle attend
-- `not_before` (temporisation) et fusionne les événements rapprochés.
-- =============================================================================
CREATE TABLE IF NOT EXISTS account_reconciliation_runs (
  id                   SERIAL PRIMARY KEY,
  account_id           INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  trigger_type         TEXT        NOT NULL,   -- manual | scheduled | event
  trigger_event        TEXT,                   -- document_linked, arbitration, asset_updated…
  trigger_object_type  TEXT,
  trigger_object_id    INTEGER,
  correlation_id       TEXT        NOT NULL,
  requested_by_user_id INTEGER,
  scope                TEXT        NOT NULL DEFAULT 'full',  -- full | incremental
  status               TEXT        NOT NULL DEFAULT 'queued',
  not_before           TIMESTAMPTZ NOT NULL DEFAULT now(),
  events_json          JSONB       NOT NULL DEFAULT '[]'::jsonb,
  started_at           TIMESTAMPTZ,
  finished_at          TIMESTAMPTZ,
  objects_examined     INTEGER     NOT NULL DEFAULT 0,
  objects_modified     INTEGER     NOT NULL DEFAULT 0,
  decisions_applied    INTEGER     NOT NULL DEFAULT 0,
  conflicts_created    INTEGER     NOT NULL DEFAULT 0,
  arbitrations_needed  INTEGER     NOT NULL DEFAULT 0,
  errors               INTEGER     NOT NULL DEFAULT 0,
  ai_calls             INTEGER     NOT NULL DEFAULT 0,
  details_json         JSONB       NOT NULL DEFAULT '[]'::jsonb,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT account_reconciliation_runs_status_check
    CHECK (status IN ('queued', 'running', 'completed', 'partial', 'failed')),
  CONSTRAINT account_reconciliation_runs_trigger_check
    CHECK (trigger_type IN ('manual', 'scheduled', 'event'))
);
CREATE UNIQUE INDEX IF NOT EXISTS account_reconciliation_runs_one_running
  ON account_reconciliation_runs (account_id) WHERE status = 'running';
CREATE UNIQUE INDEX IF NOT EXISTS account_reconciliation_runs_one_queued
  ON account_reconciliation_runs (account_id) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS account_reconciliation_runs_due_idx
  ON account_reconciliation_runs (status, not_before);

ALTER TABLE reconciliation_runs ADD COLUMN IF NOT EXISTS account_run_id INTEGER;
CREATE INDEX IF NOT EXISTS reconciliation_runs_account_run_idx ON reconciliation_runs (account_run_id);
