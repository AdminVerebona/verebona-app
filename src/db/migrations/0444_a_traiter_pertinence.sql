-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0444 : pertinence des cartes « À traiter » et données déductibles
-- (lot 61 — tickets « BUG P1 — À traiter : écarts résiduels du lot 58B » et
-- « [P1] À traiter — Fiabiliser la pertinence des cartes et résoudre
-- automatiquement les informations déductibles »).
--
--   document_field_values (0256) — NATURE de la valeur retenue :
--     value_kind  EXPLICIT (lue dans un document ou saisie), CALCULATED
--                 (calcul déterministe : début effectif + durée → échéance
--                 THÉORIQUE), ESTIMATED (réservé) ; NULL = ligne antérieure
--                 (lue comme EXPLICIT) ;
--     derivation  provenance d'une valeur calculée ou consolidée : méthode,
--                 données sources (valeurs, clés, sources), convention.
--   Une valeur calculée n'est jamais une information contractuelle certaine :
--   elle est recalculée (ou retirée) quand ses sources changent et ne prévaut
--   jamais sur une valeur de l'utilisateur.
--
--   document_rule_evaluations (0418) — décision centrale de pertinence :
--     outcome           AUTO_RESOLVED | NO_ACTION | DEFER | CREATE_ACTION |
--                       KEEP | ERROR ;
--     situation         PAST_DEADLINE | FUTURE_DEADLINE | UNDATED | … ;
--     decision_contract contrat de décision interne versionné (entité,
--                       documents, problème, intervention attendue,
--                       conséquence, insuffisance de la résolution
--                       automatique, temporalité, fiabilité, décision, motif) ;
--     reevaluate_at     réévaluation prévue d'une décision différée ;
--     evidence_fingerprint, knowledge_rev, config_ref — empreintes qui
--                       invalident la mémoire de décision (faits T1/T3,
--                       correction utilisateur, configuration IA T4) ;
--     derivation        calcul déterministe tenté (ou réalisé) ;
--     write_result      résultat de l'écriture (confirmée en base, refusée,
--                       non confirmée) ;
--     action_ids        cartes créées, maintenues, fermées ;
--     passages          derniers passages d'une évaluation dédupliquée
--                       (déclencheur, référence, date — ≤ 20) ;
--     error_kind        READ_FAILED | AI_FAILED | PERSISTENCE_FAILED | … .
--
-- Colonnes ajoutées NULLABLES, sans valeur par défaut coûteuse : aucune
-- réécriture de table. Le code tolère leur absence (lecture du catalogue
-- d'information). Idempotente. Index dans 0444_..._idx_1 (CONCURRENTLY).
-- Retour arrière : ALTER TABLE … DROP COLUMN IF EXISTS … (code tolérant).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE document_field_values ADD COLUMN IF NOT EXISTS value_kind TEXT;
ALTER TABLE document_field_values ADD COLUMN IF NOT EXISTS derivation JSONB;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_field_values_value_kind_chk') THEN
    ALTER TABLE document_field_values ADD CONSTRAINT document_field_values_value_kind_chk
      CHECK (value_kind IS NULL OR value_kind IN ('EXPLICIT', 'CALCULATED', 'ESTIMATED')) NOT VALID;
  END IF;
END $$;

COMMENT ON COLUMN document_field_values.value_kind IS
  'Lot 61 : EXPLICIT (lue / saisie), CALCULATED (échéance théorique calculée), ESTIMATED ; NULL = antérieure (EXPLICIT).';
COMMENT ON COLUMN document_field_values.derivation IS
  'Lot 61 : provenance d''une valeur calculée ou consolidée (méthode, sources, convention).';

DO $$
BEGIN
  IF to_regclass('document_rule_evaluations') IS NOT NULL THEN
    ALTER TABLE document_rule_evaluations ADD COLUMN IF NOT EXISTS outcome TEXT;
    ALTER TABLE document_rule_evaluations ADD COLUMN IF NOT EXISTS situation TEXT;
    ALTER TABLE document_rule_evaluations ADD COLUMN IF NOT EXISTS decision_contract JSONB;
    ALTER TABLE document_rule_evaluations ADD COLUMN IF NOT EXISTS reevaluate_at TIMESTAMPTZ;
    ALTER TABLE document_rule_evaluations ADD COLUMN IF NOT EXISTS evidence_fingerprint TEXT;
    ALTER TABLE document_rule_evaluations ADD COLUMN IF NOT EXISTS knowledge_rev TEXT;
    ALTER TABLE document_rule_evaluations ADD COLUMN IF NOT EXISTS config_ref TEXT;
    ALTER TABLE document_rule_evaluations ADD COLUMN IF NOT EXISTS derivation JSONB;
    ALTER TABLE document_rule_evaluations ADD COLUMN IF NOT EXISTS write_result JSONB;
    ALTER TABLE document_rule_evaluations ADD COLUMN IF NOT EXISTS action_ids JSONB;
    ALTER TABLE document_rule_evaluations ADD COLUMN IF NOT EXISTS passages JSONB;
    ALTER TABLE document_rule_evaluations ADD COLUMN IF NOT EXISTS error_kind TEXT;
    COMMENT ON COLUMN document_rule_evaluations.outcome IS
      'Lot 61 : décision centrale AUTO_RESOLVED | NO_ACTION | DEFER | CREATE_ACTION | KEEP | ERROR.';
  END IF;
END $$;
