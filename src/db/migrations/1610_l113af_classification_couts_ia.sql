-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1610 : classification de l'ORIGINE du coût des appels IA (lot
-- 113AF, carte Trello #730 « Fiabiliser la comptabilisation des coûts
-- fournisseur, métier et techniques (T1–T6) »).
--
-- `ai_usage_event` et `ai_usage_daily_rollup` reçoivent trois colonnes
-- ADDITIVES, écrites par la passerelle à la source (règle partagée
-- `src/services/ai/cost/cost-classification.ts`) ou par le rattrapage BO
-- « IA : origine des coûts » pour l'historique :
--   · cost_origin     ACCOUNT_SERVICE (métier, service du compte, tâches de
--                     fond comprises) | TECHNICAL (sonde, qualification, corpus,
--                     AI_GOVERNANCE, test) | SHADOW (observation) |
--                     UNDETERMINED (historique non classable) ; NULL = pas
--                     encore classée (la même règle est alors appliquée à la
--                     lecture) ;
--   · cost_imputable  le coût entre dans les budgets métier et le plafond du
--                     compte (vrai seulement pour ACCOUNT_SERVICE) ;
--   · cost_class      règle, raison, source (`source` | `backfill`), exécution
--                     du rattrapage (restauration), valeur d'origine
--                     d'`is_billable` — preuve et réversibilité.
--
-- `is_billable` N'EST PAS MODIFIÉ : il garde sa valeur historique (politique
-- commerciale du registre, `op.billable && !shadow`). Aucun coût n'est
-- recalculé ; `cost_micros`, `metadata.pricing` et les corrections de
-- régularisation (1150) restent intacts.
--
-- Additive, idempotente, rejouable ; aucune reprise de données ici (rattrapage
-- BO, simulable et restaurable). Retour arrière : ALTER TABLE … DROP COLUMN
-- cost_origin, cost_imputable, cost_class (la lecture retombe sur la règle).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE ai_usage_event ADD COLUMN IF NOT EXISTS cost_origin TEXT;
ALTER TABLE ai_usage_event ADD COLUMN IF NOT EXISTS cost_imputable BOOLEAN;
ALTER TABLE ai_usage_event ADD COLUMN IF NOT EXISTS cost_class JSONB;

ALTER TABLE ai_usage_daily_rollup ADD COLUMN IF NOT EXISTS cost_origin TEXT;
ALTER TABLE ai_usage_daily_rollup ADD COLUMN IF NOT EXISTS cost_imputable BOOLEAN;
ALTER TABLE ai_usage_daily_rollup ADD COLUMN IF NOT EXISTS cost_class JSONB;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_usage_event_cost_origin_check') THEN
    ALTER TABLE ai_usage_event ADD CONSTRAINT ai_usage_event_cost_origin_check
      CHECK (cost_origin IS NULL OR cost_origin IN ('ACCOUNT_SERVICE', 'TECHNICAL', 'SHADOW', 'UNDETERMINED')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_usage_daily_rollup_cost_origin_check') THEN
    ALTER TABLE ai_usage_daily_rollup ADD CONSTRAINT ai_usage_daily_rollup_cost_origin_check
      CHECK (cost_origin IS NULL OR cost_origin IN ('ACCOUNT_SERVICE', 'TECHNICAL', 'SHADOW', 'UNDETERMINED')) NOT VALID;
  END IF;
END $$;
