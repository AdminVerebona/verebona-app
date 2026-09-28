-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0201 : archivage S3 des logs IA > 90 jours et accès restreint au
-- contenu conversationnel T2.
-- CDC BO IA WF-25, WF-45, LOG-UI-08, LOG-UI-09.
--
-- ai_log_archives        : registre des archives (métadonnées d'identification,
--                          WF-25 étape 160). L'archive elle-même est sur S3 ;
--                          elle n'est pas interrogeable depuis le BO (V1).
-- ai_usage_daily_rollup  : agrégats journaliers conservés en base quand les
--                          appels sont archivés — l'écran Coûts reste juste
--                          au-delà de 90 jours sans relire l'archive.
-- ai_t2_content_access_log : chaque consultation du contenu conversationnel T2
--                          (accès restreint, justification obligatoire).
--
-- Idempotente.
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ai_log_archives (
  id            SERIAL      PRIMARY KEY,
  source_table  TEXT        NOT NULL,
  period_day    DATE        NOT NULL,
  part          INTEGER     NOT NULL DEFAULT 0,
  s3_key        TEXT        NOT NULL,
  row_count     INTEGER     NOT NULL,
  min_id        BIGINT,
  max_id        BIGINT,
  bytes         INTEGER     NOT NULL,
  sha256        TEXT        NOT NULL,
  -- WF-45 : le contenu conversationnel T2 n'est JAMAIS archivé en clair.
  t2_content_excluded BOOLEAN NOT NULL DEFAULT TRUE,
  environment   TEXT        NOT NULL DEFAULT 'production',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ai_log_archives_table_check CHECK (source_table IN ('ai_usage_event', 'ai_pipeline_step'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ai_log_archives_unique_part
  ON ai_log_archives (source_table, period_day, part);

CREATE TABLE IF NOT EXISTS ai_usage_daily_rollup (
  id                SERIAL      PRIMARY KEY,
  day               DATE        NOT NULL,
  use_case_code     TEXT,
  account_id        INTEGER,
  config_version_id INTEGER,
  model             TEXT,
  model_rank        TEXT,
  is_billable       BOOLEAN     NOT NULL,
  calls             INTEGER     NOT NULL DEFAULT 0,
  failed_calls      INTEGER     NOT NULL DEFAULT 0,
  unpriced_calls    INTEGER     NOT NULL DEFAULT 0,
  input_tokens      BIGINT      NOT NULL DEFAULT 0,
  output_tokens     BIGINT      NOT NULL DEFAULT 0,
  cost_micros       BIGINT      NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ai_usage_daily_rollup_day_idx ON ai_usage_daily_rollup (day);

CREATE TABLE IF NOT EXISTS ai_t2_content_access_log (
  id             SERIAL      PRIMARY KEY,
  admin_user_id  INTEGER     NOT NULL,
  request_id     TEXT        NOT NULL,
  account_id     INTEGER,
  reason         TEXT        NOT NULL,
  result         TEXT        NOT NULL,   -- GRANTED | DENIED | EXPIRED | NOT_FOUND
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ai_t2_content_access_log_created_idx
  ON ai_t2_content_access_log (created_at DESC);
