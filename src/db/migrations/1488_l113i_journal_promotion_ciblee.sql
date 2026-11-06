-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1488 : journal de promotion — événements de la promotion CIBLÉE par
-- traitement (lot 113I, CDC V2 §11, §12, OPS-01). Le journal EXISTANT
-- `ai_promotion_events` (0985) est étendu (aucun journal parallèle) :
--   TARGETED_PROMOTION  fusion du delta d'un traitement + activation (même commit)
--   TARGETED_ROLLBACK   retour arrière du SEUL traitement
--   ROLLBACK_REFUSED    retour arrière refusé (conflit d'empreinte, gel, garde illisible)
--   WATCH_STATE         changement d'état de surveillance (INSUFFICIENT_USAGE, VALIDATED_IN_USAGE…)
--   BUDGET              refus ou anomalie de budget d'amélioration
-- Idempotente (contrainte remplacée seulement si elle ne contient pas déjà les
-- nouvelles valeurs). Retour arrière : remettre la contrainte 0985 après
-- suppression des lignes de ces types.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF to_regclass('ai_promotion_events') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'ai_promotion_events'::regclass
                AND conname = 'ai_promotion_events_kind_chk' AND pg_get_constraintdef(oid) NOT LIKE '%TARGETED_ROLLBACK%') THEN
      ALTER TABLE ai_promotion_events DROP CONSTRAINT ai_promotion_events_kind_chk;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'ai_promotion_events'::regclass AND conname = 'ai_promotion_events_kind_chk') THEN
      ALTER TABLE ai_promotion_events ADD CONSTRAINT ai_promotion_events_kind_chk CHECK (kind IN (
        'ACTIVATION_GATE', 'ACTIVATION_TX', 'A1_BLOCKED', 'A1_RELAUNCH', 'A1_WAITING', 'ACTIVATED',
        'POST_CHECK', 'POST_ALERT', 'ROLLBACK', 'ROLLBACK_FAILED', 'WATCH_END',
        'TARGETED_PROMOTION', 'TARGETED_ROLLBACK', 'ROLLBACK_REFUSED', 'WATCH_STATE', 'BUDGET'));
    END IF;
  END IF;
END $$;
