-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0517 : campagne de réévaluation rétroactive MULTI-FAMILLES
-- (lot 72C — ticket « [P1] À traiter — Corriger les écarts résiduels », C6).
--
--   to_process_relevance_campaigns (0445)
--     phase             CARDS (cartes actives, toutes familles) puis
--                       DECISIONS (décisions SANS carte prises par une
--                       version antérieure du moteur) ;
--     cursor_file_id    curseur de la phase DECISIONS (document) — reprise
--                       après interruption ;
--     outcomes_by_rule  bilan par règle et par issue ({règle: {issue: n}}) ;
--                       la famille est le type de cible de la règle.
--
--   to_process_relevance_campaign_items (0445)
--     action_id, file_id deviennent NULLables (décision sans carte, cible
--     agenda / équipement / fournisseur) ; target_type, target_id, phase
--     identifient la cible. Unicité d'une décision sans carte dans
--     0517_..._idx_1 (CONCURRENTLY).
--
-- Colonnes ajoutées avec défaut constant (sans réécriture, PG ≥ 11),
-- DROP NOT NULL : métadonnées seules. Idempotente. Aucune suppression.
-- Retour arrière : colonnes ignorées par le code du lot 71 (la campagne
-- repasse alors aux seules cartes documentaires).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF to_regclass('to_process_relevance_campaigns') IS NOT NULL THEN
    ALTER TABLE to_process_relevance_campaigns
      ADD COLUMN IF NOT EXISTS phase TEXT NOT NULL DEFAULT 'CARDS',
      ADD COLUMN IF NOT EXISTS cursor_file_id INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS outcomes_by_rule JSONB NOT NULL DEFAULT '{}'::jsonb;
  END IF;
  IF to_regclass('to_process_relevance_campaign_items') IS NOT NULL THEN
    ALTER TABLE to_process_relevance_campaign_items
      ALTER COLUMN action_id DROP NOT NULL,
      ALTER COLUMN file_id DROP NOT NULL,
      ADD COLUMN IF NOT EXISTS target_type TEXT,
      ADD COLUMN IF NOT EXISTS target_id INTEGER,
      ADD COLUMN IF NOT EXISTS phase TEXT;
  END IF;
END $$;
