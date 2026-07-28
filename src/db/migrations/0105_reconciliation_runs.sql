-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0105 : Journal des exécutions de réconciliation
-- CDC Verebona — Refonte 11 → 5 usages IA, §6.1 (entités 7 et 8)
--
-- Sert trois usages : comparer le mode observation au comportement actuel avant
-- bascule (§10.2), expliquer une modification à un utilisateur (§7.1), et
-- alimenter les tableaux de suivi par usage (§7.2).
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS reconciliation_runs (
  id              SERIAL PRIMARY KEY,
  account_id      INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  asset_id        INTEGER     NOT NULL REFERENCES assets(id)   ON DELETE CASCADE,
  triggered_by    TEXT        NOT NULL,
  -- true : décisions produites et journalisées, mais NON appliquées (§10.2)
  shadow          BOOLEAN     NOT NULL DEFAULT FALSE,
  trace_id        UUID,
  status          TEXT        NOT NULL DEFAULT 'running',
  decisions_count INTEGER     NOT NULL DEFAULT 0,
  applied_count   INTEGER     NOT NULL DEFAULT 0,
  conflict_count  INTEGER     NOT NULL DEFAULT 0,
  ai_review_count INTEGER     NOT NULL DEFAULT 0,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at     TIMESTAMPTZ,

  CONSTRAINT reconciliation_runs_status_check
    CHECK (status IN ('running', 'completed', 'failed')),
  CONSTRAINT reconciliation_runs_trigger_check
    CHECK (triggered_by IN ('document_analyzed', 'manual', 'scheduled', 'field_changed'))
);

CREATE INDEX IF NOT EXISTS reconciliation_runs_account_idx ON reconciliation_runs(account_id);
CREATE INDEX IF NOT EXISTS reconciliation_runs_asset_idx   ON reconciliation_runs(asset_id);
CREATE INDEX IF NOT EXISTS reconciliation_runs_shadow_idx  ON reconciliation_runs(shadow);
CREATE INDEX IF NOT EXISTS reconciliation_runs_started_idx ON reconciliation_runs(started_at);

CREATE TABLE IF NOT EXISTS reconciliation_decisions (
  id              SERIAL PRIMARY KEY,
  run_id          INTEGER     NOT NULL REFERENCES reconciliation_runs(id) ON DELETE CASCADE,
  account_id      INTEGER     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  asset_id        INTEGER     NOT NULL REFERENCES assets(id)   ON DELETE CASCADE,
  field_key       TEXT        NOT NULL,
  action          TEXT        NOT NULL,
  reason_code     TEXT        NOT NULL,
  confidence      TEXT        NOT NULL,
  -- false : un modèle a tranché ; true : décision prise par règle
  deterministic   BOOLEAN     NOT NULL DEFAULT TRUE,
  evidence_ids    JSONB       NOT NULL DEFAULT '[]'::jsonb,
  source_priority INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT reconciliation_decisions_action_check
    CHECK (action IN ('apply', 'update', 'keep', 'create_conflict', 'request_ai_review', 'ignore')),
  CONSTRAINT reconciliation_decisions_confidence_check
    CHECK (confidence IN ('certain', 'probable', 'conflictual'))
);

CREATE INDEX IF NOT EXISTS reconciliation_decisions_run_idx    ON reconciliation_decisions(run_id);
CREATE INDEX IF NOT EXISTS reconciliation_decisions_asset_idx  ON reconciliation_decisions(asset_id, field_key);
CREATE INDEX IF NOT EXISTS reconciliation_decisions_action_idx ON reconciliation_decisions(action);
