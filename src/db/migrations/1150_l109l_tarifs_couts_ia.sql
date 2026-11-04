-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1150 : fiabilisation des tarifs Gemini et des coûts IA
-- Lot 109L, ticket P1 « Tarifs Gemini non reconnus, 948 appels signalés sans
-- tarif et coûts IA incomplets ». ADDITIVE, idempotente, rejouable.
--
-- 1. ai_usage_event.pricing_status : statut tarifaire EXPLICITE écrit à la
--    création de la trace (applied | zero_or_rounded | missing |
--    insufficient_usage | legacy_undetermined). Les lignes antérieures restent
--    NULL : leur statut est DÉDUIT à la lecture (cost-status.ts), jamais écrit
--    en masse ici (aucune réécriture de l'historique).
--    ai_usage_event.cost_exact_micros : coût exact non arrondi (fraction de
--    micro-dollar) — un appel à 0,3 micro n'est plus confondu avec « sans tarif ».
-- 2. ai_model_price_status : statut STALE (tarif conservé, non confirmé par la
--    dernière lecture) ; motif structuré ; date depuis laquelle le modèle n'est
--    plus confirmé ; retrait seulement après vérification positive.
-- 3. ai_model_pricing : preuve d'une saisie manuelle (URL, date du document,
--    note, opérateur, validation) ; aucune ligne existante modifiée.
-- 4. ai_model_pricing_refresh_log : empreinte / format / URL finale / type de
--    contenu / taille de la page lue, statut tarifaire séparé du catalogue
--    modèles, couverture (connus / inconnus / obsolètes), causes par modèle.
-- 5. ai_cost_regularization_runs / _items / ai_cost_corrections : rattrapage
--    dry-run → export avant/après → application unique → retour arrière. Le
--    coût et la référence tarifaire INITIAUX ne sont jamais modifiés : la
--    correction est stockée à part (une seule correction ACTIVE par cible).
--
-- Ne touche à aucun appel fournisseur, aucun modèle, aucune configuration IA.
-- ──────────────────────────────────────────────────────────────────────────────

-- 1. Statut tarifaire de chaque appel ----------------------------------------
ALTER TABLE ai_usage_event ADD COLUMN IF NOT EXISTS pricing_status    TEXT;
ALTER TABLE ai_usage_event ADD COLUMN IF NOT EXISTS cost_exact_micros NUMERIC(24, 6);

DO $$ BEGIN
  ALTER TABLE ai_usage_event ADD CONSTRAINT ai_usage_event_pricing_status_check
    CHECK (pricing_status IS NULL OR pricing_status IN
      ('applied', 'zero_or_rounded', 'missing', 'insufficient_usage', 'legacy_undetermined'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS ai_usage_event_pricing_status_idx
  ON ai_usage_event (pricing_status, created_at) WHERE pricing_status IS DISTINCT FROM 'applied';

-- 2. STALE et motifs structurés ---------------------------------------------
ALTER TABLE ai_model_price_status DROP CONSTRAINT IF EXISTS ai_model_price_status_check;
ALTER TABLE ai_model_price_status ADD CONSTRAINT ai_model_price_status_check
  CHECK (status IN ('KNOWN', 'UNKNOWN', 'STALE'));
ALTER TABLE ai_model_price_status DROP CONSTRAINT IF EXISTS ai_model_price_status_amounts_check;
ALTER TABLE ai_model_price_status ADD CONSTRAINT ai_model_price_status_amounts_check CHECK (
  (status = 'KNOWN' AND input_per_million IS NOT NULL AND output_per_million IS NOT NULL)
  OR (status = 'UNKNOWN' AND input_per_million IS NULL AND output_per_million IS NULL)
  -- STALE : dernier montant documenté conservé (ou aucun), jamais présenté comme courant.
  OR (status = 'STALE')
);
ALTER TABLE ai_model_price_status ADD COLUMN IF NOT EXISTS reason_code     TEXT;
ALTER TABLE ai_model_price_status ADD COLUMN IF NOT EXISTS stale_since     TIMESTAMPTZ;
ALTER TABLE ai_model_price_status ADD COLUMN IF NOT EXISTS absent_reads    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_model_price_status ADD COLUMN IF NOT EXISTS confirmed_at    TIMESTAMPTZ;
ALTER TABLE ai_model_price_status ADD COLUMN IF NOT EXISTS thinking_included BOOLEAN;
ALTER TABLE ai_model_price_status ADD COLUMN IF NOT EXISTS page_fingerprint TEXT;

ALTER TABLE ai_model_price_changes ADD COLUMN IF NOT EXISTS reason_code      TEXT;
ALTER TABLE ai_model_price_changes ADD COLUMN IF NOT EXISTS page_fingerprint TEXT;
ALTER TABLE ai_model_price_changes ADD COLUMN IF NOT EXISTS actor_user_id    INTEGER;
ALTER TABLE ai_model_price_changes ADD COLUMN IF NOT EXISTS evidence         JSONB;

-- 3. Preuve des saisies manuelles ------------------------------------------
ALTER TABLE ai_model_pricing ADD COLUMN IF NOT EXISTS evidence         JSONB;
ALTER TABLE ai_model_pricing ADD COLUMN IF NOT EXISTS invalidated_reason TEXT;
ALTER TABLE ai_model_pricing ADD COLUMN IF NOT EXISTS invalidated_by   INTEGER;

-- 4. Journal de synchronisation tarifaire ----------------------------------
ALTER TABLE ai_model_pricing_refresh_log ADD COLUMN IF NOT EXISTS source_url       TEXT;
ALTER TABLE ai_model_pricing_refresh_log ADD COLUMN IF NOT EXISTS final_url        TEXT;
ALTER TABLE ai_model_pricing_refresh_log ADD COLUMN IF NOT EXISTS http_status      INTEGER;
ALTER TABLE ai_model_pricing_refresh_log ADD COLUMN IF NOT EXISTS content_type     TEXT;
ALTER TABLE ai_model_pricing_refresh_log ADD COLUMN IF NOT EXISTS page_bytes       INTEGER;
ALTER TABLE ai_model_pricing_refresh_log ADD COLUMN IF NOT EXISTS page_fingerprint TEXT;
ALTER TABLE ai_model_pricing_refresh_log ADD COLUMN IF NOT EXISTS page_format      TEXT;
ALTER TABLE ai_model_pricing_refresh_log ADD COLUMN IF NOT EXISTS page_sample      TEXT;
ALTER TABLE ai_model_pricing_refresh_log ADD COLUMN IF NOT EXISTS models_stale     JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE ai_model_pricing_refresh_log ADD COLUMN IF NOT EXISTS causes           JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE ai_model_pricing_refresh_log ADD COLUMN IF NOT EXISTS failure_code     TEXT;
ALTER TABLE ai_model_pricing_refresh_log ADD COLUMN IF NOT EXISTS trigger_code     TEXT;
ALTER TABLE ai_model_pricing_refresh_log DROP CONSTRAINT IF EXISTS ai_model_pricing_refresh_status_check;
ALTER TABLE ai_model_pricing_refresh_log ADD CONSTRAINT ai_model_pricing_refresh_status_check
  CHECK (status IN ('running', 'completed', 'partial', 'failed', 'stale'));

-- 5. Régularisation contrôlée ----------------------------------------------
CREATE TABLE IF NOT EXISTS ai_cost_regularization_runs (
  id            BIGSERIAL   PRIMARY KEY,
  mode          TEXT        NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'running',
  since         TIMESTAMPTZ NOT NULL,
  until         TIMESTAMPTZ NOT NULL,
  method_version TEXT       NOT NULL,
  plan_fingerprint TEXT,
  dry_run_id    BIGINT REFERENCES ai_cost_regularization_runs(id) ON DELETE SET NULL,
  operator_user_id INTEGER,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at   TIMESTAMPTZ,
  summary       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  error_message TEXT,
  CONSTRAINT ai_cost_regularization_runs_mode_check CHECK (mode IN ('dry_run', 'apply', 'revert')),
  CONSTRAINT ai_cost_regularization_runs_status_check CHECK (status IN ('running', 'completed', 'failed', 'interrupted', 'refused'))
);

CREATE TABLE IF NOT EXISTS ai_cost_regularization_items (
  id               BIGSERIAL PRIMARY KEY,
  run_id           BIGINT    NOT NULL REFERENCES ai_cost_regularization_runs(id) ON DELETE CASCADE,
  target_kind      TEXT      NOT NULL,
  target_id        BIGINT    NOT NULL,
  call_at          TIMESTAMPTZ NOT NULL,
  provider         TEXT,
  model            TEXT,
  use_case_code    TEXT,
  account_id       INTEGER,
  calls            INTEGER   NOT NULL DEFAULT 1,
  input_tokens     BIGINT,
  output_tokens    BIGINT,
  thoughts_tokens  BIGINT,
  initial_cost_micros BIGINT,
  initial_status   TEXT,
  cause            TEXT      NOT NULL,
  decision         TEXT      NOT NULL,
  decision_reason  TEXT,
  price_row_id     INTEGER,
  price_source     TEXT,
  price_ref        JSONB,
  corrected_cost_micros BIGINT,
  corrected_exact_micros NUMERIC(24, 6),
  CONSTRAINT ai_cost_regularization_items_kind_check CHECK (target_kind IN ('event', 'rollup')),
  CONSTRAINT ai_cost_regularization_items_decision_check CHECK (decision IN ('regularize', 'keep_unpriced', 'no_action'))
);
CREATE INDEX IF NOT EXISTS ai_cost_regularization_items_run_idx ON ai_cost_regularization_items (run_id);

CREATE TABLE IF NOT EXISTS ai_cost_corrections (
  id               BIGSERIAL PRIMARY KEY,
  target_kind      TEXT      NOT NULL,
  target_id        BIGINT    NOT NULL,
  run_id           BIGINT    NOT NULL REFERENCES ai_cost_regularization_runs(id),
  dry_run_id       BIGINT    REFERENCES ai_cost_regularization_runs(id),
  call_at          TIMESTAMPTZ NOT NULL,
  -- Valeurs INITIALES recopiées pour l'audit (la trace d'origine n'est jamais modifiée).
  initial_cost_micros BIGINT,
  initial_pricing  JSONB,
  corrected_cost_micros BIGINT NOT NULL,
  corrected_exact_micros NUMERIC(24, 6),
  cause            TEXT      NOT NULL,
  method           TEXT      NOT NULL,
  method_version   TEXT      NOT NULL,
  price_row_id     INTEGER,
  price_source     TEXT,
  price_ref        JSONB     NOT NULL,
  applied_by       INTEGER,
  applied_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reverted_at      TIMESTAMPTZ,
  reverted_by      INTEGER,
  revert_run_id    BIGINT    REFERENCES ai_cost_regularization_runs(id),
  CONSTRAINT ai_cost_corrections_kind_check CHECK (target_kind IN ('event', 'rollup')),
  CONSTRAINT ai_cost_corrections_positive_check CHECK (corrected_cost_micros >= 0)
);
-- Une seule correction ACTIVE par cible : une double application est impossible.
CREATE UNIQUE INDEX IF NOT EXISTS ai_cost_corrections_active_uidx
  ON ai_cost_corrections (target_kind, target_id) WHERE reverted_at IS NULL;
CREATE INDEX IF NOT EXISTS ai_cost_corrections_call_at_idx ON ai_cost_corrections (call_at);

COMMENT ON COLUMN ai_usage_event.pricing_status IS
  'Lot 109L : statut tarifaire écrit à la trace (applied, zero_or_rounded, missing, insufficient_usage, legacy_undetermined). NULL = trace antérieure, statut déduit à la lecture.';
COMMENT ON TABLE ai_cost_corrections IS
  'Lot 109L : corrections de coût IA (régularisation). Le coût initial de la trace reste intact ; coût effectif = correction active sinon coût initial.';
