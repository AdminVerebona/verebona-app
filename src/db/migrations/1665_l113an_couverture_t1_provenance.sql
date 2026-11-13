-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1665 : provenance de la COUVERTURE des unités sources T1 et
-- politique explicite des unités restantes (lot 113AN, carte Trello #741
-- « T1 — Corriger les faux UNRESOLVED et reprendre les extractions réellement
-- incomplètes »).
--
--   · `document_source_units.coverage_provenance` (JSONB, NULL par défaut) :
--     requalification d'une unité par la réconciliation de couverture
--     (`source-units/coverage-reconciliation.ts`) — règle appliquée (code
--     stable), sources (FACT, TABLE, METADATA, CANDIDATE, VALUE_DECISION, UNIT,
--     REPAIR), références (`fact:<empreinte|db:id>`, `unit:<id>`,
--     `decision:<…>`, `meta:<champ>`), état AVANT (statut, motif), compteurs
--     de valeurs, étape (ANALYSIS, REPAIR, STORED). Aucun contenu de document.
--   · `document_source_units.residual_policy` (TEXT, NULL par défaut) :
--     politique d'une unité NON couverte (REPAIR_PENDING,
--     REPAIR_RETRY_SCHEDULED, REPAIR_ATTEMPTED_NO_RESULT, REPAIR_EXHAUSTED,
--     REPAIR_NOT_RUN:<motif>, NEEDS_SOURCE, T3_REINTERPRETATION,
--     PRESERVED_UNSTRUCTURED, TECHNICAL_FAILURE_FINAL) ; NULL pour une unité
--     couverte ou non informative.
--
-- La couche A est réécrite à chaque analyse / reprise : aucune reprise de
-- données ici. Documents déjà analysés : BO › Exécutions IA › Complétude T1 ›
-- « Réconcilier (sans IA) », ou la prochaine reprise / réanalyse.
-- Additive, idempotente, rejouable. Le code lit ces colonnes par `to_jsonb`
-- et ne les écrit que si elles existent. Retour arrière :
--   ALTER TABLE document_source_units DROP COLUMN coverage_provenance, DROP COLUMN residual_policy;
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE document_source_units ADD COLUMN IF NOT EXISTS coverage_provenance JSONB;
ALTER TABLE document_source_units ADD COLUMN IF NOT EXISTS residual_policy TEXT;

COMMENT ON COLUMN document_source_units.coverage_provenance IS
  'Lot 113AN : provenance d''une requalification de couverture (règle, sources, références, état d''avant) — aucun contenu.';
COMMENT ON COLUMN document_source_units.residual_policy IS
  'Lot 113AN : politique explicite d''une unité non couverte (réparation, réinterprétation T3/T2, conservation).';
