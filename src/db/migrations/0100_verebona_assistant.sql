-- =============================================================================
-- Verebona Assistant — Modèle de données conversationnel (CDC §28)
-- Appliquée automatiquement par ensureMigrations() (tri lexical des fichiers .sql).
-- Idempotente : IF NOT EXISTS partout.
-- =============================================================================

-- 28.1 — Conversations (1 active max par compte — §28.1)
CREATE TABLE IF NOT EXISTS verebona_conversations (
  id                        SERIAL PRIMARY KEY,
  account_id                INTEGER     NOT NULL,
  status                    TEXT        NOT NULL DEFAULT 'active', -- active | expired | deleted
  machine_state             TEXT        NOT NULL DEFAULT 'IDLE',
  context_json              JSONB       NOT NULL DEFAULT '{}'::jsonb,
  clarification_state_json  JSONB,
  locale                    TEXT        NOT NULL DEFAULT 'fr-FR',
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at                TIMESTAMPTZ NOT NULL
);
-- 1 conversation active par compte (§28.1)
CREATE UNIQUE INDEX IF NOT EXISTS verebona_conversations_active_account_uidx
  ON verebona_conversations (account_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS verebona_conversations_expires_idx
  ON verebona_conversations (expires_at);

-- 28.2 — Messages
CREATE TABLE IF NOT EXISTS verebona_messages (
  id                     SERIAL PRIMARY KEY,
  conversation_id        INTEGER     NOT NULL REFERENCES verebona_conversations(id) ON DELETE CASCADE,
  account_id             INTEGER     NOT NULL,
  author_user_id         INTEGER,
  role                   TEXT        NOT NULL, -- user | assistant | system
  status                 TEXT        NOT NULL DEFAULT 'pending', -- pending | ready | cancelled | error
  content                TEXT,
  intent                 TEXT,
  mode                   TEXT, -- deterministic | classic_search | ai | fallback
  support_level          TEXT,
  request_id             TEXT,
  client_request_id      TEXT,
  parent_message_id      INTEGER,
  intent_catalog_version TEXT,
  action_catalog_version TEXT,
  schema_version         TEXT,
  response_locale        TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at             TIMESTAMPTZ NOT NULL
);
-- Idempotence : unicité account + client_request_id (§28.2, §31.9)
CREATE UNIQUE INDEX IF NOT EXISTS verebona_messages_idempotency_uidx
  ON verebona_messages (account_id, client_request_id)
  WHERE client_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS verebona_messages_conversation_created_idx
  ON verebona_messages (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS verebona_messages_status_idx ON verebona_messages (status);
CREATE INDEX IF NOT EXISTS verebona_messages_expires_idx ON verebona_messages (expires_at);

-- 28.3 — Claims (affirmation ↔ dérivation)
CREATE TABLE IF NOT EXISTS verebona_message_claims (
  id          SERIAL PRIMARY KEY,
  message_id  INTEGER     NOT NULL REFERENCES verebona_messages(id) ON DELETE CASCADE,
  claim_key   TEXT        NOT NULL,
  claim_text  TEXT        NOT NULL,
  derivation  TEXT        NOT NULL, -- direct | calculated | synthesized
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS verebona_message_claims_message_idx ON verebona_message_claims (message_id);

-- 28.4 — Sources (snapshot minimal — §28.4)
CREATE TABLE IF NOT EXISTS verebona_message_sources (
  id                SERIAL PRIMARY KEY,
  message_id        INTEGER     NOT NULL REFERENCES verebona_messages(id) ON DELETE CASCADE,
  source_type       TEXT        NOT NULL,
  source_id         TEXT        NOT NULL,
  source_version    TEXT,
  title_snapshot    TEXT,
  excerpt_snapshot  TEXT,
  rank              INTEGER,
  relevance_score   REAL,
  is_available      BOOLEAN     NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS verebona_message_sources_message_idx ON verebona_message_sources (message_id);
CREATE INDEX IF NOT EXISTS verebona_message_sources_type_id_idx ON verebona_message_sources (source_type, source_id);

-- 28.5 — Mapping claim ↔ source (clé composite)
CREATE TABLE IF NOT EXISTS verebona_claim_sources (
  claim_id          INTEGER NOT NULL REFERENCES verebona_message_claims(id) ON DELETE CASCADE,
  message_source_id INTEGER NOT NULL REFERENCES verebona_message_sources(id) ON DELETE CASCADE,
  PRIMARY KEY (claim_id, message_source_id)
);

-- 28.6 — Actions (jamais d'URL externe libre — §28.6)
CREATE TABLE IF NOT EXISTS verebona_message_actions (
  id                    SERIAL PRIMARY KEY,
  message_id            INTEGER     NOT NULL REFERENCES verebona_messages(id) ON DELETE CASCADE,
  action_type           TEXT        NOT NULL,
  target_type           TEXT,
  target_id             TEXT,
  label                 TEXT        NOT NULL,
  payload_json          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  resolved_href         TEXT,       -- ou jeton interne signé
  requires_confirmation BOOLEAN     NOT NULL DEFAULT false,
  analytics_code        TEXT,
  expires_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS verebona_message_actions_message_idx ON verebona_message_actions (message_id);
CREATE INDEX IF NOT EXISTS verebona_message_actions_expires_idx ON verebona_message_actions (expires_at);

-- 28.7 — Trace générique par demande (avec ou sans IA)
CREATE TABLE IF NOT EXISTS verebona_request_runs (
  id                     SERIAL PRIMARY KEY,
  request_id             TEXT        NOT NULL,
  client_request_id      TEXT,
  conversation_id        INTEGER,
  account_id             INTEGER     NOT NULL,
  user_id                INTEGER,
  intent                 TEXT,
  intent_catalog_version TEXT,
  mode                   TEXT,
  machine_final_state    TEXT,
  retrieval_methods_json JSONB,
  candidate_count        INTEGER,
  source_count           INTEGER,
  cache_hit              BOOLEAN,
  latency_ms             INTEGER,
  status                 TEXT,
  error_code             TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS verebona_request_runs_account_idx ON verebona_request_runs (account_id, created_at);
CREATE INDEX IF NOT EXISTS verebona_request_runs_request_idx ON verebona_request_runs (request_id);

-- 28.8 — Trace des appels IA (prompts/extraits NON stockés par défaut — §28.8)
CREATE TABLE IF NOT EXISTS verebona_ai_runs (
  id                     SERIAL PRIMARY KEY,
  request_id             TEXT        NOT NULL,
  account_id             INTEGER     NOT NULL,
  message_id             INTEGER,
  provider               TEXT,
  model_alias            TEXT,
  resolved_model_id      TEXT,
  route_reason           TEXT,
  prompt_id              TEXT,
  prompt_version         TEXT,
  prompt_hash            TEXT,
  schema_version         TEXT,
  intent_catalog_version TEXT,
  action_catalog_version TEXT,
  input_tokens           INTEGER,
  output_tokens          INTEGER,
  estimated_cost_micros  INTEGER,
  latency_ms             INTEGER,
  fallback_used          BOOLEAN,
  attempt_number         INTEGER,
  status                 TEXT,
  error_code             TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS verebona_ai_runs_account_idx ON verebona_ai_runs (account_id, created_at);
CREATE INDEX IF NOT EXISTS verebona_ai_runs_model_idx ON verebona_ai_runs (resolved_model_id, created_at);

-- 28.9 — Feedback (Duo : évaluation possible d'un message d'un autre utilisateur)
CREATE TABLE IF NOT EXISTS verebona_feedback (
  id          SERIAL PRIMARY KEY,
  message_id  INTEGER     NOT NULL REFERENCES verebona_messages(id) ON DELETE CASCADE,
  account_id  INTEGER     NOT NULL,
  user_id     INTEGER,
  value       TEXT        NOT NULL, -- helpful | not_helpful
  reason      TEXT,                 -- incorrect_answer | missing_information | wrong_source | wrong_action | too_long | other
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Dernière valeur par (message, user) remplace la précédente (§27.10)
CREATE UNIQUE INDEX IF NOT EXISTS verebona_feedback_message_user_uidx
  ON verebona_feedback (message_id, user_id);

-- 28.10 — Base d'aide versionnée (§10.3)
CREATE TABLE IF NOT EXISTS verebona_help_entries (
  id               SERIAL PRIMARY KEY,
  slug             TEXT        NOT NULL,
  locale           TEXT        NOT NULL DEFAULT 'fr-FR',
  content_version  TEXT        NOT NULL,
  title            TEXT        NOT NULL,
  question_patterns JSONB      NOT NULL DEFAULT '[]'::jsonb,
  short_answer     TEXT        NOT NULL,
  detailed_answer  TEXT,
  plan_scope       JSONB       NOT NULL DEFAULT '[]'::jsonb,
  actions_json     JSONB       NOT NULL DEFAULT '[]'::jsonb,
  app_version      TEXT,
  status           TEXT        NOT NULL DEFAULT 'draft', -- published | draft | archived
  validated_by     TEXT,
  validated_at     TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS verebona_help_entries_slug_locale_uidx
  ON verebona_help_entries (slug, locale);
CREATE INDEX IF NOT EXISTS verebona_help_entries_status_idx
  ON verebona_help_entries (status, locale);
