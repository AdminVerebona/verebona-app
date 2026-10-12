-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0321 : issue T3 des candidats Opération (lot 41, O3a — CDC
-- Opérations V1 C5, C6, C9.1, C24 NFR-OP-004/005).
--
-- T3 consolide les candidats T1 (`document_operation_candidates`) en
-- Opérations. Chaque candidat traité garde la TRACE de la décision de la
-- machine C5, pour le diagnostic et pour la reprise des cas en attente :
--   · `t3_outcome`      : NO_OPERATION | MATCH_AND_ENRICH | CREATE_NEW |
--                         HOLD_UNRESOLVED (ARBITRATION_REQUIRED admis pour le
--                         lot O3b ; en O3a une ambiguïté est un HOLD tracé) ;
--   · `t3_reason`       : motif stable (ex. AMBIGUOUS_MATCH, M3_REQUIRED,
--                         PROBABLE_WITHOUT_MATCH, CONTRADICTORY_REFERENCE) ;
--   · `t3_operation_id` : Opération créée ou enrichie (pas de clé étrangère :
--                         une Opération n'est jamais supprimée physiquement
--                         hors suppression du compte, qui emporte aussi le
--                         candidat) ;
--   · `t3_detail`       : raisons auditables (niveau M0-M2, Opérations
--                         plausibles, hard negatives) — artefact de
--                         diagnostic, jamais une donnée métier.
--
-- Rien n'est visible pour l'utilisateur (P09). Idempotente ; expand seulement.
-- Index partiel des HOLD : fichier `_idx_1` (CONCURRENTLY).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE document_operation_candidates ADD COLUMN IF NOT EXISTS t3_outcome TEXT;
ALTER TABLE document_operation_candidates ADD COLUMN IF NOT EXISTS t3_reason TEXT;
ALTER TABLE document_operation_candidates ADD COLUMN IF NOT EXISTS t3_operation_id BIGINT;
ALTER TABLE document_operation_candidates ADD COLUMN IF NOT EXISTS t3_detail JSONB;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'document_operation_candidates_t3_outcome_chk' AND conrelid = 'document_operation_candidates'::regclass
  ) THEN
    ALTER TABLE document_operation_candidates ADD CONSTRAINT document_operation_candidates_t3_outcome_chk
      CHECK (t3_outcome IS NULL OR t3_outcome IN ('NO_OPERATION', 'MATCH_AND_ENRICH', 'CREATE_NEW', 'HOLD_UNRESOLVED', 'ARBITRATION_REQUIRED'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'document_operation_candidates_t3_detail_chk' AND conrelid = 'document_operation_candidates'::regclass
  ) THEN
    ALTER TABLE document_operation_candidates ADD CONSTRAINT document_operation_candidates_t3_detail_chk
      CHECK (t3_detail IS NULL OR jsonb_typeof(t3_detail) = 'object');
  END IF;
END $$;

COMMENT ON COLUMN document_operation_candidates.t3_outcome IS
  'Lot 41 : issue de la machine de décision T3 (C5) au dernier traitement du candidat.';
COMMENT ON COLUMN document_operation_candidates.t3_reason IS
  'Lot 41 : motif stable de la décision T3 (diagnostic, reprise des HOLD).';
