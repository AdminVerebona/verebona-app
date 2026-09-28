-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0204 : assistant Verebona — traçabilité et observabilité
-- CDC Assistant §15.11, §15.13, §28.8, §28.12, §31.3.
--
--  · §28.12 : index « alias + date » sur verebona_ai_runs et « intention +
--    date » sur verebona_request_runs (tableaux de bord et alertes) ;
--  · §28.8 : index sur verebona_ai_runs(request_id), pour rattacher chaque
--    appel modèle au message assistant enregistré (message_id) ;
--  · §15.11, §31.3 : modèle ATTENDU pour l'alias au moment de l'appel
--    (expected_model_id) — l'alerte « modèle résolu différent du modèle
--    attendu » le compare au modèle réellement appelé ;
--  · §15.13 : date de fin annoncée d'un modèle (deprecation_date) dans le
--    catalogue du fournisseur, lue par l'alerte quotidienne de dépréciation.
--
-- Idempotente.
-- ──────────────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS verebona_ai_runs_alias_idx
  ON verebona_ai_runs (model_alias, created_at);

CREATE INDEX IF NOT EXISTS verebona_request_runs_intent_idx
  ON verebona_request_runs (intent, created_at);

CREATE INDEX IF NOT EXISTS verebona_ai_runs_request_idx
  ON verebona_ai_runs (request_id);

ALTER TABLE verebona_ai_runs ADD COLUMN IF NOT EXISTS expected_model_id TEXT;

DO $$
BEGIN
  IF to_regclass('ai_model_catalog') IS NOT NULL THEN
    ALTER TABLE ai_model_catalog ADD COLUMN IF NOT EXISTS deprecation_date DATE;
  END IF;
END $$;
