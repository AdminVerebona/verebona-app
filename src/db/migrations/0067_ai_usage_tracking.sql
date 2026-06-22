-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0067 : Suivi de la consommation IA (CDC Verebona V2)
-- 8 objets fonctionnels : compteurs, événements, opérations, étapes pipeline,
--   versions analyse/pipeline, blocages sécurité, audit admin
-- ──────────────────────────────────────────────────────────────────────────────

-- 1. Compteurs agrégés par compte (source rapide d'affichage)
CREATE TABLE IF NOT EXISTS ai_usage_account_counter (
  id                        SERIAL PRIMARY KEY,
  account_id                INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  period_year               INTEGER NOT NULL,                      -- ex. 2026
  documents_analyzed_count  INTEGER NOT NULL DEFAULT 0,            -- incrémenté après workflow terminé
  documents_analyzed_quota  INTEGER NOT NULL DEFAULT 0,            -- quota annuel du plan
  trial_documents_count     INTEGER NOT NULL DEFAULT 0,            -- consommation pendant essai
  trial_documents_quota     INTEGER NOT NULL DEFAULT 0,            -- quota essai du plan
  last_reset_at             TIMESTAMPTZ,
  reset_by_admin_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, period_year)
);

CREATE INDEX IF NOT EXISTS ai_usage_account_counter_account_id_idx ON ai_usage_account_counter(account_id);
CREATE INDEX IF NOT EXISTS ai_usage_account_counter_period_year_idx ON ai_usage_account_counter(period_year);

-- 2. Événement de consommation IA (toute opération, facturable ou non)
CREATE TABLE IF NOT EXISTS ai_usage_event (
  id                  SERIAL PRIMARY KEY,
  account_id          INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id             INTEGER REFERENCES users(id) ON DELETE SET NULL,
  asset_file_id       INTEGER REFERENCES asset_files(id) ON DELETE SET NULL,
  operation_type      TEXT NOT NULL,   -- ocr | extraction | enrichissement | agenda | embedding | reanalyse | fallback | ...
  provider            TEXT,            -- gemini | openai | anthropic | ...
  model               TEXT,            -- gemini-2.0-flash | gemini-2.0-pro | gpt-4o | ...
  is_billable         BOOLEAN NOT NULL DEFAULT true,
  is_fallback         BOOLEAN NOT NULL DEFAULT false,
  input_tokens        INTEGER,
  output_tokens       INTEGER,
  cost_micros         INTEGER,         -- coût en micro-euros (1 EUR = 1 000 000 micros)
  duration_ms         INTEGER,
  environment         TEXT NOT NULL DEFAULT 'production',  -- production | staging | test
  pipeline_version    TEXT,
  status              TEXT NOT NULL DEFAULT 'success',     -- success | error | skipped | blocked_quota | blocked_security
  error_code          TEXT,
  error_message       TEXT,
  metadata            JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ai_usage_event_account_id_idx ON ai_usage_event(account_id);
CREATE INDEX IF NOT EXISTS ai_usage_event_asset_file_id_idx ON ai_usage_event(asset_file_id);
CREATE INDEX IF NOT EXISTS ai_usage_event_operation_type_idx ON ai_usage_event(operation_type);
CREATE INDEX IF NOT EXISTS ai_usage_event_provider_idx ON ai_usage_event(provider);
CREATE INDEX IF NOT EXISTS ai_usage_event_created_at_idx ON ai_usage_event(created_at);
CREATE INDEX IF NOT EXISTS ai_usage_event_status_idx ON ai_usage_event(status);
CREATE INDEX IF NOT EXISTS ai_usage_event_environment_idx ON ai_usage_event(environment);

-- 3. Opération IA métier (niveau document/pipeline)
CREATE TABLE IF NOT EXISTS ai_operation (
  id                    SERIAL PRIMARY KEY,
  public_id             UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  account_id            INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id               INTEGER REFERENCES users(id) ON DELETE SET NULL,
  asset_file_id         INTEGER REFERENCES asset_files(id) ON DELETE SET NULL,
  operation_category    TEXT NOT NULL,  -- document_analysis | agenda_extraction | enrichissement | supplier_detection | ...
  pipeline_version      TEXT,
  started_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at          TIMESTAMPTZ,
  duration_ms           INTEGER,
  business_result       TEXT NOT NULL DEFAULT 'pending',
  -- 7 résultats métier: success | success_with_warning | error | refused_quota | refused_security | incomplete | cancelled
  total_cost_micros     INTEGER NOT NULL DEFAULT 0,
  total_input_tokens    INTEGER NOT NULL DEFAULT 0,
  total_output_tokens   INTEGER NOT NULL DEFAULT 0,
  steps_count           INTEGER NOT NULL DEFAULT 0,
  provider_primary      TEXT,
  provider_fallback     TEXT,
  used_fallback         BOOLEAN NOT NULL DEFAULT false,
  is_reanalysis         BOOLEAN NOT NULL DEFAULT false,
  reanalysis_reason     TEXT,
  origin                TEXT NOT NULL DEFAULT 'upload',  -- upload | reanalyse | daily_enrichment | retroactive | admin
  is_billable           BOOLEAN NOT NULL DEFAULT true,
  environment           TEXT NOT NULL DEFAULT 'production',
  error_code            TEXT,
  error_message         TEXT,
  warning_message       TEXT,
  metadata              JSONB,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ai_operation_account_id_idx ON ai_operation(account_id);
CREATE INDEX IF NOT EXISTS ai_operation_asset_file_id_idx ON ai_operation(asset_file_id);
CREATE INDEX IF NOT EXISTS ai_operation_business_result_idx ON ai_operation(business_result);
CREATE INDEX IF NOT EXISTS ai_operation_operation_category_idx ON ai_operation(operation_category);
CREATE INDEX IF NOT EXISTS ai_operation_started_at_idx ON ai_operation(started_at);
CREATE INDEX IF NOT EXISTS ai_operation_environment_idx ON ai_operation(environment);
CREATE INDEX IF NOT EXISTS ai_operation_origin_idx ON ai_operation(origin);

-- 4. Étape technique de pipeline
CREATE TABLE IF NOT EXISTS ai_pipeline_step (
  id                SERIAL PRIMARY KEY,
  operation_id      INTEGER NOT NULL REFERENCES ai_operation(id) ON DELETE CASCADE,
  step_name         TEXT NOT NULL,       -- ocr | meta_extraction | detail_extraction | agenda_extraction | embedding | ...
  step_order        INTEGER NOT NULL DEFAULT 0,
  provider          TEXT,
  model             TEXT,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at      TIMESTAMPTZ,
  duration_ms       INTEGER,
  status            TEXT NOT NULL DEFAULT 'pending',
  -- 13 statuts: uploaded | queued | ocr_running | ocr_done | extracting | extracted
  --             enriching | enriched | agenda_running | agenda_done | embedding | done | blocked_security | error
  input_tokens      INTEGER,
  output_tokens     INTEGER,
  cost_micros       INTEGER,
  is_fallback       BOOLEAN NOT NULL DEFAULT false,
  fallback_reason   TEXT,
  error_code        TEXT,
  error_message     TEXT,
  prompt_version    TEXT,
  input_hash        TEXT,    -- hash du contenu en entrée (déduplication)
  output_preview    TEXT,    -- aperçu tronqué de la sortie (debug)
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ai_pipeline_step_operation_id_idx ON ai_pipeline_step(operation_id);
CREATE INDEX IF NOT EXISTS ai_pipeline_step_step_name_idx ON ai_pipeline_step(step_name);
CREATE INDEX IF NOT EXISTS ai_pipeline_step_status_idx ON ai_pipeline_step(status);
CREATE INDEX IF NOT EXISTS ai_pipeline_step_provider_idx ON ai_pipeline_step(provider);

-- 5. Version d'analyse d'un document
CREATE TABLE IF NOT EXISTS ai_analysis_version (
  id                SERIAL PRIMARY KEY,
  asset_file_id     INTEGER NOT NULL REFERENCES asset_files(id) ON DELETE CASCADE,
  operation_id      INTEGER REFERENCES ai_operation(id) ON DELETE SET NULL,
  version_number    INTEGER NOT NULL DEFAULT 1,
  analysis_date     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  pipeline_version  TEXT,
  business_result   TEXT NOT NULL DEFAULT 'success',
  total_cost_micros INTEGER NOT NULL DEFAULT 0,
  provider_used     TEXT,
  used_fallback     BOOLEAN NOT NULL DEFAULT false,
  is_current        BOOLEAN NOT NULL DEFAULT true,   -- seule la version courante est active
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ai_analysis_version_asset_file_id_idx ON ai_analysis_version(asset_file_id);
CREATE INDEX IF NOT EXISTS ai_analysis_version_operation_id_idx ON ai_analysis_version(operation_id);
CREATE INDEX IF NOT EXISTS ai_analysis_version_is_current_idx ON ai_analysis_version(is_current);

-- 6. Version de pipeline (configuration routage multi-provider)
CREATE TABLE IF NOT EXISTS ai_pipeline_version (
  id                  SERIAL PRIMARY KEY,
  version_code        TEXT NOT NULL UNIQUE,  -- ex. "v1.2.0"
  description         TEXT,
  is_active           BOOLEAN NOT NULL DEFAULT true,
  routing_config      JSONB NOT NULL DEFAULT '{}',
  -- ex. { "ocr": "gemini-flash", "extraction": "gemini-flash", "enrichissement": "gemini-pro", ... }
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS ai_pipeline_version_is_active_idx ON ai_pipeline_version(is_active);

-- 7. Blocage sécurité IA
CREATE TABLE IF NOT EXISTS ai_security_lock (
  id                SERIAL PRIMARY KEY,
  account_id        INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  asset_file_id     INTEGER REFERENCES asset_files(id) ON DELETE SET NULL,
  lock_type         TEXT NOT NULL,
  -- reanalysis_loop | abnormal_consumption | aberrant_cost | flood | repeated_errors | cost_drift
  triggered_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  trigger_details   TEXT,
  is_resolved       BOOLEAN NOT NULL DEFAULT false,
  resolved_at       TIMESTAMPTZ,
  resolved_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  resolution_notes  TEXT,
  auto_resolved     BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ai_security_lock_account_id_idx ON ai_security_lock(account_id);
CREATE INDEX IF NOT EXISTS ai_security_lock_is_resolved_idx ON ai_security_lock(is_resolved);
CREATE INDEX IF NOT EXISTS ai_security_lock_lock_type_idx ON ai_security_lock(lock_type);
CREATE INDEX IF NOT EXISTS ai_security_lock_triggered_at_idx ON ai_security_lock(triggered_at);

-- 8. Journal d'audit admin IA
CREATE TABLE IF NOT EXISTS ai_admin_audit_log (
  id                SERIAL PRIMARY KEY,
  admin_user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  admin_email       TEXT NOT NULL,
  action_type       TEXT NOT NULL,
  -- modify_quota | reset_counter | unlock_security | change_pipeline | force_reanalysis
  target_account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  target_file_id    INTEGER REFERENCES asset_files(id) ON DELETE SET NULL,
  target_lock_id    INTEGER REFERENCES ai_security_lock(id) ON DELETE SET NULL,
  before_value      JSONB,
  after_value       JSONB,
  reason            TEXT,
  ip_address        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ai_admin_audit_log_admin_user_id_idx ON ai_admin_audit_log(admin_user_id);
CREATE INDEX IF NOT EXISTS ai_admin_audit_log_action_type_idx ON ai_admin_audit_log(action_type);
CREATE INDEX IF NOT EXISTS ai_admin_audit_log_target_account_id_idx ON ai_admin_audit_log(target_account_id);
CREATE INDEX IF NOT EXISTS ai_admin_audit_log_created_at_idx ON ai_admin_audit_log(created_at);
