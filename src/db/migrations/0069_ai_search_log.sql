-- Migration 0069 : Table ai_search_log (CDC Recherche Intelligente V1)
-- Log des requêtes de recherche intelligente — conservation 12 mois (RGPD §24)

CREATE TABLE IF NOT EXISTS ai_search_log (
  id                SERIAL PRIMARY KEY,
  public_id         UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  account_id        INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  query_text        TEXT NOT NULL,
  response_mode     TEXT NOT NULL DEFAULT 'no_result',
  answer_text       TEXT,
  sources_count     INTEGER NOT NULL DEFAULT 0,
  offer_code        TEXT NOT NULL,
  context_type      TEXT,
  context_id        INTEGER,
  cost_micros       INTEGER NOT NULL DEFAULT 0,
  input_tokens      INTEGER NOT NULL DEFAULT 0,
  output_tokens     INTEGER NOT NULL DEFAULT 0,
  duration_ms       INTEGER,
  provider          TEXT,
  model             TEXT,
  business_result   TEXT NOT NULL DEFAULT 'success',
  block_reason      TEXT,
  tracking_id       UUID NOT NULL DEFAULT gen_random_uuid(),
  environment       TEXT NOT NULL DEFAULT 'production',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ai_search_log_account_id_idx    ON ai_search_log(account_id);
CREATE INDEX IF NOT EXISTS ai_search_log_user_id_idx       ON ai_search_log(user_id);
CREATE INDEX IF NOT EXISTS ai_search_log_created_at_idx    ON ai_search_log(created_at);
CREATE INDEX IF NOT EXISTS ai_search_log_response_mode_idx ON ai_search_log(response_mode);
CREATE INDEX IF NOT EXISTS ai_search_log_offer_code_idx    ON ai_search_log(offer_code);
CREATE INDEX IF NOT EXISTS ai_search_log_business_result_idx ON ai_search_log(business_result);
