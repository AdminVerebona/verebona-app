-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0175 : alertes IA, budgets et détection d'anomalies de coût
-- CDC BO IA COST-010 à COST-014, CST-UI-08, CST-UI-09, WF-22, WF-44,
-- T1-UI-09, T3-UI-06, T4-UI-05 (garde-fous appliqués), ALT-01.
--
-- ai_alerts : alertes produites par le SYSTÈME (garde-fous, budgets,
-- anomalies). Une alerte n'arrête jamais rien par elle-même (COST-013) ; seul
-- un garde-fou configuré en réaction « suspension » suspend son traitement.
-- `dedupe_key` : une même condition (même garde-fou, même traitement, même
-- fenêtre) ne produit qu'une alerte, pas une par tour d'évaluation.
--
-- ai_cost_settings : budgets MENSUELS (mois calendaire) global et par
-- traitement. Paramètre opérationnel LOCAL à l'environnement (SCR-09 :
-- « Configurer budgets — paramètre opérationnel environnement-local ») : hors
-- configuration versionnée, jamais dans un package. Pas de budget par compte
-- en V1 (COST-010).
--
-- ai_cost_anomaly_settings : activation de la détection (COST-012 : l'admin
-- l'active ou la désactive, il ne règle pas l'algorithme).
--
-- ai_evaluator_runs : dernier passage de chaque évaluateur périodique, pour
-- que plusieurs instances ne réévaluent pas la même fenêtre.
--
-- Idempotente.
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ai_alerts (
  id                SERIAL      PRIMARY KEY,
  kind              TEXT        NOT NULL,
  code              TEXT        NOT NULL,
  treatment         TEXT,
  account_id        INTEGER     REFERENCES accounts(id) ON DELETE SET NULL,
  severity          TEXT        NOT NULL DEFAULT 'warning',
  message           TEXT        NOT NULL,
  details           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  drilldown_href    TEXT,
  dedupe_key        TEXT        NOT NULL,
  config_version_id INTEGER     REFERENCES ai_config_versions(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acknowledged_at   TIMESTAMPTZ,
  acknowledged_by   INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT ai_alerts_kind_check CHECK (kind IN ('guardrail', 'budget', 'anomaly')),
  CONSTRAINT ai_alerts_severity_check CHECK (severity IN ('info', 'warning', 'critical'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_alerts_dedupe_uidx ON ai_alerts(dedupe_key);
CREATE INDEX IF NOT EXISTS ai_alerts_open_idx ON ai_alerts(created_at DESC) WHERE acknowledged_at IS NULL;

COMMENT ON TABLE ai_alerts IS
  'Alertes système du BO IA : garde-fous, budgets, anomalies de coût (CDC BO IA WF-22, WF-44). '
  'Une alerte ne suspend jamais un traitement pour raison budgétaire (COST-013).';

CREATE TABLE IF NOT EXISTS ai_cost_settings (
  scope                 TEXT        PRIMARY KEY,
  monthly_budget_micros BIGINT,
  updated_by            INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ai_cost_settings_scope_check
    CHECK (scope IN ('global', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6')),
  CONSTRAINT ai_cost_settings_budget_check
    CHECK (monthly_budget_micros IS NULL OR monthly_budget_micros >= 0)
);

COMMENT ON TABLE ai_cost_settings IS
  'Budgets IA mensuels, global et par traitement (COST-010). Paramètre local à '
  'l''environnement, hors configuration versionnée. NULL = pas de budget.';

CREATE TABLE IF NOT EXISTS ai_cost_anomaly_settings (
  id          BOOLEAN     PRIMARY KEY DEFAULT TRUE,
  enabled     BOOLEAN     NOT NULL DEFAULT TRUE,
  updated_by  INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ai_cost_anomaly_settings_singleton CHECK (id = TRUE)
);
INSERT INTO ai_cost_anomaly_settings (id, enabled) VALUES (TRUE, TRUE) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS ai_evaluator_runs (
  name         TEXT        PRIMARY KEY,
  last_run_at  TIMESTAMPTZ NOT NULL
);

-- Évaluateur des garde-fous : fenêtres par traitement sur ai_usage_event.
CREATE INDEX IF NOT EXISTS ai_usage_event_use_case_created_idx
  ON ai_usage_event(use_case_code, created_at DESC);
