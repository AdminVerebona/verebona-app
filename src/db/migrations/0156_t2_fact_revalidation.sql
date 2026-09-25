-- =============================================================================
-- 0156 — Revalidation ciblée d'un fait par T2 et réinjection dans la
-- connaissance documentaire.
--
--   · document_facts.provenance : origine du fait (T1_EXTRACTION par défaut,
--     REVALIDATION_T2 pour un fait vérifié par l'assistant) ;
--     document_facts.revalidation_id : revalidation qui l'a produit.
--   · verebona_fact_revalidations : trace ET mémoire des revalidations
--     (déduplication : une preuve n'est pas relue deux fois pour la même
--     question tant que la source et le fait n'ont pas changé).
--   · t1_quality_signals : signal de lacune T1 (information absente, mal
--     structurée, confiance ou preuve insuffisante, conflit), exploitable
--     pour améliorer T1 — sans jamais relancer d'analyse complète.
-- =============================================================================
ALTER TABLE document_facts ADD COLUMN IF NOT EXISTS provenance TEXT NOT NULL DEFAULT 'T1_EXTRACTION';
ALTER TABLE document_facts ADD COLUMN IF NOT EXISTS revalidation_id INTEGER;

CREATE TABLE IF NOT EXISTS verebona_fact_revalidations (
  id                 SERIAL PRIMARY KEY,
  account_id         INTEGER     NOT NULL,
  user_id            INTEGER,
  conversation_id    INTEGER,
  request_id         TEXT,
  file_id            INTEGER     NOT NULL,
  fact_id            BIGINT      NOT NULL,
  extraction_id      INTEGER,
  extraction_version TEXT,                  -- horodatage de l'extraction vérifiée
  fact_key           TEXT        NOT NULL,
  question           TEXT,
  trigger_reason     TEXT        NOT NULL,  -- LOW_CONFIDENCE | CONFLICT | WEAK_EVIDENCE
  initial_value      TEXT,
  initial_confidence TEXT,
  mode               TEXT        NOT NULL,  -- PERSISTED_CONTENT | SOURCE_RECHECK
  status             TEXT        NOT NULL,  -- CONFIRMED | CORRECTED | NOT_FOUND | AMBIGUOUS | FAILED
  new_value          TEXT,
  new_unit           TEXT,
  new_confidence     TEXT,
  excerpt            TEXT,
  page               INTEGER,
  provenance         TEXT        NOT NULL DEFAULT 'REVALIDATION_T2',
  reinjected_fact_id BIGINT,
  signal_id          INTEGER,
  model              TEXT,
  ai_calls           INTEGER     NOT NULL DEFAULT 0,
  cost_micros        INTEGER     NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS verebona_fact_revalidations_fact_idx
  ON verebona_fact_revalidations (fact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS verebona_fact_revalidations_conv_idx
  ON verebona_fact_revalidations (conversation_id);

CREATE TABLE IF NOT EXISTS t1_quality_signals (
  id              SERIAL PRIMARY KEY,
  account_id      INTEGER     NOT NULL,
  file_id         INTEGER     NOT NULL,
  extraction_id   INTEGER,
  analysis_run_id INTEGER,
  fact_key        TEXT,
  information     TEXT,                    -- ce qui était recherché
  problem         TEXT        NOT NULL,    -- MISSING | POORLY_STRUCTURED | LOW_CONFIDENCE | WEAK_EVIDENCE | CONFLICT
  t2_result       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  t1_model        TEXT,
  t1_prompt_version TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS t1_quality_signals_file_idx ON t1_quality_signals (file_id, created_at DESC);
