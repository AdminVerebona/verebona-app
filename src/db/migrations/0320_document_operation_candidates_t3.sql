-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0320 : candidats Opération de T1 — versionnement et marqueur T3
-- (lot 40, O2 — CDC Opérations V1 C3.2, C4 TRG-001 / TRG-002, C9.1,
-- T1-OP-009).
--
--   · `document_extractions` est un UPSERT par fichier : `extraction_id` n'est
--     PAS une version. La clé locale d'un candidat n'est donc unique que parmi
--     les candidats ACTIFS de l'extraction : l'index unique complet de la 0317
--     (extraction_id, candidate_key) aurait refusé la réanalyse d'un document
--     (même clé « op1 » à chaque passage). Remplacé par l'index unique PARTIEL
--     `document_operation_candidates_active_key_uidx` (fichier _idx_1). La
--     version d'un candidat est portée par `status` + `analysis_run_id`.
--   · Marqueur T3 (aucun branchement dans ce lot) : `t3_pending` vrai = la
--     ligne attend T3 (candidat établi nouvellement actif, ou candidat déjà
--     consolidé puis supersédé : retrait de contribution) ; `t3_processed_at`
--     posé par T3 ; `trigger_code` = déclencheur C4 (source_analyzed /
--     source_reanalyzed).
--
-- La table est vide en exploitation (alimentée à partir de ce lot) : la
-- suppression de l'index 0317 est instantanée. Idempotente ; expand seulement.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE document_operation_candidates ADD COLUMN IF NOT EXISTS t3_pending BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE document_operation_candidates ADD COLUMN IF NOT EXISTS t3_processed_at TIMESTAMPTZ;
ALTER TABLE document_operation_candidates ADD COLUMN IF NOT EXISTS trigger_code TEXT NOT NULL DEFAULT 'source_analyzed';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'document_operation_candidates_trigger_chk' AND conrelid = 'document_operation_candidates'::regclass
  ) THEN
    ALTER TABLE document_operation_candidates ADD CONSTRAINT document_operation_candidates_trigger_chk
      CHECK (trigger_code IN ('source_analyzed', 'source_reanalyzed'));
  END IF;
END $$;

-- Clé locale unique parmi les ACTIFS seulement (index partiel : fichier _idx_1).
DROP INDEX IF EXISTS document_operation_candidates_key_uidx;

COMMENT ON COLUMN document_operation_candidates.t3_pending IS
  'Lot 40 : la ligne attend T3 (candidat établi actif non encore consolidé, ou candidat consolidé puis supersédé).';
COMMENT ON COLUMN document_operation_candidates.trigger_code IS
  'Lot 40 : déclencheur C4 — source_analyzed (1re analyse) ou source_reanalyzed.';
