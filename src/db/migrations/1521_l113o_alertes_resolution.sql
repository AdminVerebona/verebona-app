-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1521 : cycle de vie des alertes IA — RÉSOLUTION explicite (lot
-- 113O, carte #713).
--
-- `ai_alerts` ne connaissait que l'acquittement manuel : une alerte tarifaire
-- restait « ouverte » des semaines après la disparition de sa condition, et la
-- clé de déduplication datée créait une alerte par modèle et PAR JOUR.
--   · `condition_key` : condition stable (sans date) ; au plus UNE alerte non
--     résolue par condition (index unique partiel) ; une répétition met à jour
--     `last_seen_at` / `occurrences` au lieu de créer une ligne ;
--   · `resolved_at`, `resolved_by` (NULL = résolution automatique),
--     `resolution_code`, `resolution_reason`, `superseded_by` : résolution
--     TRAÇABLE, distincte de l'acquittement ; aucune ligne supprimée,
--     l'historique reste consultable.
-- Les alertes existantes ne sont PAS modifiées ici : le recontrôle applicatif
-- (`pricing-supervision.ts`) les résout ou les rattache, motif tracé.
-- Additive, idempotente, rejouable.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF to_regclass('ai_alerts') IS NOT NULL THEN
    ALTER TABLE ai_alerts ADD COLUMN IF NOT EXISTS condition_key     TEXT;
    ALTER TABLE ai_alerts ADD COLUMN IF NOT EXISTS last_seen_at      TIMESTAMPTZ;
    ALTER TABLE ai_alerts ADD COLUMN IF NOT EXISTS occurrences       INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE ai_alerts ADD COLUMN IF NOT EXISTS resolved_at       TIMESTAMPTZ;
    ALTER TABLE ai_alerts ADD COLUMN IF NOT EXISTS resolved_by       INTEGER;
    ALTER TABLE ai_alerts ADD COLUMN IF NOT EXISTS resolution_code   TEXT;
    ALTER TABLE ai_alerts ADD COLUMN IF NOT EXISTS resolution_reason TEXT;
    ALTER TABLE ai_alerts ADD COLUMN IF NOT EXISTS superseded_by     INTEGER;
    CREATE UNIQUE INDEX IF NOT EXISTS ai_alerts_open_condition_uq
      ON ai_alerts (condition_key) WHERE condition_key IS NOT NULL AND resolved_at IS NULL;
    CREATE INDEX IF NOT EXISTS ai_alerts_unresolved_code_idx ON ai_alerts (code) WHERE resolved_at IS NULL;
  END IF;
END $$;
