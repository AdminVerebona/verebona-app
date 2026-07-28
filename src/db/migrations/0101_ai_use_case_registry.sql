-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0101 : Référentiel des cinq usages IA et de leurs opérations
-- CDC Verebona — Refonte 11 → 5 usages IA, §5.1
--
-- Principe : les tables de suivi existantes (ai_operation, ai_pipeline_step,
-- ai_usage_event) sont CONSERVÉES ET ÉTENDUES, jamais remplacées. Les
-- événements passés ne sont pas réécrits (CDC §9.7).
-- ──────────────────────────────────────────────────────────────────────────────

-- 1. Les cinq usages — table de référence, contrainte à cinq lignes actives
CREATE TABLE IF NOT EXISTS ai_use_cases (
  code                    TEXT PRIMARY KEY,
  label                   TEXT        NOT NULL,
  purpose                 TEXT        NOT NULL,
  replaces_legacy_usages  JSONB       NOT NULL DEFAULT '[]'::jsonb,
  active                  BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ai_use_cases_code_check CHECK (code IN (
    'SOURCE_ANALYSIS', 'DATA_RECONCILIATION', 'INTELLIGENT_ASSISTANT',
    'AGENDA_INTELLIGENCE', 'AI_GOVERNANCE'
  ))
);

-- 2. Opérations techniques rattachées à un usage
CREATE TABLE IF NOT EXISTS ai_operations (
  operation_code   TEXT PRIMARY KEY,
  use_case_code    TEXT        NOT NULL REFERENCES ai_use_cases(code) ON DELETE RESTRICT,
  label            TEXT        NOT NULL,
  provider         TEXT        NOT NULL,
  primary_model    TEXT        NOT NULL,
  fallback_models  JSONB       NOT NULL DEFAULT '[]'::jsonb,
  prompt_code      TEXT,
  timeout_ms       INTEGER     NOT NULL DEFAULT 30000,
  output_schema    TEXT        NOT NULL DEFAULT 'none',
  active           BOOLEAN     NOT NULL DEFAULT TRUE,
  billable         BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ai_operations_use_case_idx ON ai_operations(use_case_code);
CREATE INDEX IF NOT EXISTS ai_operations_active_idx   ON ai_operations(active);

-- 3. Rattachement des tables de suivi existantes au nouveau référentiel
--    (CDC §5.5 : chaque appel rattaché à un usage et à une opération)
ALTER TABLE ai_operation     ADD COLUMN IF NOT EXISTS use_case_code  TEXT;
ALTER TABLE ai_operation     ADD COLUMN IF NOT EXISTS operation_code TEXT;

ALTER TABLE ai_pipeline_step ADD COLUMN IF NOT EXISTS use_case_code  TEXT;
ALTER TABLE ai_pipeline_step ADD COLUMN IF NOT EXISTS operation_code TEXT;
ALTER TABLE ai_pipeline_step ADD COLUMN IF NOT EXISTS trace_id       UUID;

ALTER TABLE ai_usage_event   ADD COLUMN IF NOT EXISTS use_case_code  TEXT;
ALTER TABLE ai_usage_event   ADD COLUMN IF NOT EXISTS operation_code TEXT;

CREATE INDEX IF NOT EXISTS ai_operation_use_case_idx      ON ai_operation(use_case_code);
CREATE INDEX IF NOT EXISTS ai_pipeline_step_use_case_idx  ON ai_pipeline_step(use_case_code);
CREATE INDEX IF NOT EXISTS ai_pipeline_step_trace_idx     ON ai_pipeline_step(trace_id);
CREATE INDEX IF NOT EXISTS ai_usage_event_use_case_idx    ON ai_usage_event(use_case_code);

-- 4. Cache d'idempotence des appels modèles (CDC §5.7)
CREATE TABLE IF NOT EXISTS ai_operation_idempotency (
  key_hash    TEXT PRIMARY KEY,
  result_json JSONB       NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS ai_operation_idempotency_expires_idx
  ON ai_operation_idempotency(expires_at);
