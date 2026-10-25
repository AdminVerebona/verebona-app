-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0753 : NATURE d'une réparation de cohérence (lot 87B, CODE-05,
-- CODE-06).
--
-- `coherence_repairs.reevaluation_kind` distingue, pour chaque tentative :
--   TECHNICAL_REBUILD         reconstruction technique (mêmes décisions
--                             rejouées par le service métier : projection,
--                             recalcul, propagation) ;
--   SEMANTIC_REEVALUATION_T3  nouvelle décision d'IDENTITÉ demandée à T3
--                             (verdict historique écarté) ;
--   SEMANTIC_REEVALUATION_T4  nouvelle décision de REPRÉSENTATION AGENDA
--                             demandée à T4 (plusieurs éléments ensemble).
-- NULL : tentative antérieure au lot 87B, ou contrôle qui ne la déclare pas.
-- Écrite par le moteur du registre (`coherence/engine.ts`) depuis
-- `RepairResult.reevaluation`. Additive, idempotente, aucune reprise.
-- Retour arrière : ALTER TABLE coherence_repairs DROP COLUMN reevaluation_kind.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE coherence_repairs ADD COLUMN IF NOT EXISTS reevaluation_kind TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'coherence_repairs_reevaluation_kind_chk') THEN
    ALTER TABLE coherence_repairs ADD CONSTRAINT coherence_repairs_reevaluation_kind_chk
      CHECK (reevaluation_kind IS NULL OR reevaluation_kind IN ('TECHNICAL_REBUILD', 'SEMANTIC_REEVALUATION_T3', 'SEMANTIC_REEVALUATION_T4'));
  END IF;
END $$;

COMMENT ON COLUMN coherence_repairs.reevaluation_kind IS
  'Lot 87B : reconstruction technique ou nouvelle décision sémantique (T3 identité, T4 représentation Agenda).';
