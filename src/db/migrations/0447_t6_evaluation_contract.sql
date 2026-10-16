-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0447 : contrat de décision IA T6 « t6-evaluation-v1 » (lot 61 —
-- ticket « [P2] T6 — Implémenter le nouveau contrat de décision IA et
-- fiabiliser la composition de la bulle d'accueil »).
--
-- `t6_interpellation_assessments` (0432) devient le CACHE des décisions
-- VALIDES du mode EVALUATE (opération `t6_evaluate`) : une ligne par échéance
-- du compte, réutilisée tant que l'échéance ne change pas de façon
-- significative. Colonnes du contrat :
--   contract_version  't6-evaluation-v1' ; NULL = évaluation R13 du lot 60,
--                     jamais réutilisée (réévaluée par EVALUATE) ;
--   decision          SHOW_NOW / DEFER / SUPPRESS (décision INDICATIVE de
--                     l'IA — le serveur garde la décision d'affichage) ;
--   category          ACTION_NOW / TO_ANTICIPATE / INFORMATION ;
--   reason_code       motif du référentiel fermé (contrôlé par le serveur) ;
--   evidence_refs     références justificatives citées (C1.title…) ;
--   uncertainties     incertitudes identifiées.
-- Les colonnes historiques (interpellation, action_needed…) restent écrites,
-- DÉRIVÉES de la décision (aucune perte de compatibilité).
--
-- Ajouts de colonnes NULLables (ou à défaut constant) : instantanés, sans
-- réécriture. Contraintes posées NOT VALID puis validées (lignes existantes :
-- NULL, conformes). Idempotente, rejouable.
-- Retour arrière : les colonnes peuvent rester (ignorées par le code du
-- lot 60) ; sinon ALTER TABLE … DROP COLUMN IF EXISTS ….
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF to_regclass('t6_interpellation_assessments') IS NULL THEN RETURN; END IF;

  ALTER TABLE t6_interpellation_assessments
    ADD COLUMN IF NOT EXISTS contract_version TEXT,
    ADD COLUMN IF NOT EXISTS decision         TEXT,
    ADD COLUMN IF NOT EXISTS category         TEXT,
    ADD COLUMN IF NOT EXISTS reason_code      TEXT,
    ADD COLUMN IF NOT EXISTS evidence_refs    JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS uncertainties    JSONB NOT NULL DEFAULT '[]'::jsonb;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 't6_interpellation_assessments_decision_check') THEN
    ALTER TABLE t6_interpellation_assessments ADD CONSTRAINT t6_interpellation_assessments_decision_check
      CHECK (decision IS NULL OR decision IN ('SHOW_NOW', 'DEFER', 'SUPPRESS')) NOT VALID;
    ALTER TABLE t6_interpellation_assessments VALIDATE CONSTRAINT t6_interpellation_assessments_decision_check;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 't6_interpellation_assessments_category_check') THEN
    ALTER TABLE t6_interpellation_assessments ADD CONSTRAINT t6_interpellation_assessments_category_check
      CHECK (category IS NULL OR category IN ('ACTION_NOW', 'TO_ANTICIPATE', 'INFORMATION')) NOT VALID;
    ALTER TABLE t6_interpellation_assessments VALIDATE CONSTRAINT t6_interpellation_assessments_category_check;
  END IF;

  -- Une décision du nouveau contrat porte toujours sa décision, sa catégorie et son motif.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 't6_interpellation_assessments_contract_check') THEN
    ALTER TABLE t6_interpellation_assessments ADD CONSTRAINT t6_interpellation_assessments_contract_check
      CHECK (contract_version IS NULL OR (decision IS NOT NULL AND category IS NOT NULL AND reason_code IS NOT NULL)) NOT VALID;
    ALTER TABLE t6_interpellation_assessments VALIDATE CONSTRAINT t6_interpellation_assessments_contract_check;
  END IF;

  COMMENT ON COLUMN t6_interpellation_assessments.contract_version IS
    'Lot 61 : contrat de la décision IA (t6-evaluation-v1). NULL : évaluation R13 du lot 60, jamais réutilisée.';
END $$;
