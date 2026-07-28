-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0111 : Catalogue tarifaire des modèles
-- CDC Assistant §15.9 — « Les prix sont des données d'exploitation, pas des
-- règles fonctionnelles. » §15.14 — contrôle de présence des prix au démarrage.
--
-- Corrige le défaut n°10 du CDC Refonte : l'ancien barème était codé en dur et
-- ne référençait AUCUN des modèles réellement appelés, rendant faux tous les
-- coûts affichés en administration.
--
-- Les tarifs ne sont plus écrits dans le code : ils sont rafraîchis par un lot
-- planifié depuis la grille du compte Google, et saisissables manuellement en
-- administration lorsque la source automatique n'est pas disponible.
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ai_model_pricing (
  id                 SERIAL PRIMARY KEY,
  provider           TEXT        NOT NULL,
  model              TEXT        NOT NULL,
  -- Micro-unités de devise par token (1 USD = 1 000 000 micros)
  input_micros       NUMERIC(20, 6) NOT NULL,
  output_micros      NUMERIC(20, 6) NOT NULL,
  currency           TEXT        NOT NULL DEFAULT 'USD',
  -- 'billing_api' : relevé automatiquement | 'manual' : saisi en administration
  source             TEXT        NOT NULL,
  -- Référence du SKU fournisseur, pour audit et rapprochement de facture
  source_reference   TEXT,
  effective_from     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fetched_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Un tarif non confirmé n'autorise pas le démarrage en production
  verified           BOOLEAN     NOT NULL DEFAULT FALSE,
  verified_by        INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT ai_model_pricing_source_check CHECK (source IN ('billing_api', 'manual')),
  CONSTRAINT ai_model_pricing_positive_check CHECK (input_micros >= 0 AND output_micros >= 0)
);

-- Historique conservé : un coût passé doit rester explicable avec le tarif en
-- vigueur au moment de l'appel. Seule la ligne la plus récente est active.
CREATE UNIQUE INDEX IF NOT EXISTS ai_model_pricing_unique_idx
  ON ai_model_pricing(provider, model, effective_from);

CREATE INDEX IF NOT EXISTS ai_model_pricing_lookup_idx
  ON ai_model_pricing(provider, model, effective_from DESC);

-- Journal des exécutions du lot de rafraîchissement
CREATE TABLE IF NOT EXISTS ai_model_pricing_refresh_log (
  id             SERIAL PRIMARY KEY,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at    TIMESTAMPTZ,
  status         TEXT        NOT NULL DEFAULT 'running',
  models_found   INTEGER     NOT NULL DEFAULT 0,
  models_updated INTEGER     NOT NULL DEFAULT 0,
  models_missing JSONB       NOT NULL DEFAULT '[]'::jsonb,
  error_message  TEXT,

  CONSTRAINT ai_model_pricing_refresh_status_check
    CHECK (status IN ('running', 'completed', 'partial', 'failed'))
);
