-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0354 : T1 — état « vérification incomplète » (lot 53, retour PO D19).
--
-- Une analyse dont la couverture du document original n'est pas vérifiable
-- (image, PDF non sondable ou illisible, pages non vérifiées sans page
-- manquante, couverture reconstruite des documents historiques) était classée
-- COMPLETE_WITH_UNRESOLVED (« complète, part non structurée conservée »). Elle
-- devient VERIFICATION_INCOMPLETE : jamais qualifiée de complète.
--
--   1. contrainte `document_extraction_coverage_quality_chk` élargie à
--      VERIFICATION_INCOMPLETE (ajout NOT VALID puis validation : aucune
--      réécriture de la table, verrou court) ;
--   2. requalification des lignes EXISTANTES concernées (même règle que
--      `buildCompletenessReport`) et anomalie COVERAGE_UNVERIFIED ajoutée ;
--      `updated_at` n'est PAS modifié (l'historique du BO reste daté de
--      l'analyse réelle).
--
-- Idempotente (contrainte supprimée puis recréée, requalification bornée aux
-- lignes encore COMPLETE_WITH_UNRESOLVED). Aucune action d'exploitation.
-- Retour arrière : UPDATE … SET quality_state = 'COMPLETE_WITH_UNRESOLVED'
-- WHERE quality_state = 'VERIFICATION_INCOMPLETE', puis contrainte d'origine.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE document_extraction_coverage DROP CONSTRAINT IF EXISTS document_extraction_coverage_quality_chk;
ALTER TABLE document_extraction_coverage ADD CONSTRAINT document_extraction_coverage_quality_chk
  CHECK (quality_state IN ('COMPLETE', 'COMPLETE_WITH_UNRESOLVED', 'VERIFICATION_INCOMPLETE', 'INCOMPLETE_RETRYABLE', 'INCOMPLETE_FINAL')) NOT VALID;
ALTER TABLE document_extraction_coverage VALIDATE CONSTRAINT document_extraction_coverage_quality_chk;

UPDATE document_extraction_coverage
   SET quality_state = 'VERIFICATION_INCOMPLETE',
       anomalies = CASE WHEN 'COVERAGE_UNVERIFIED' = ANY(anomalies) THEN anomalies
                        ELSE array_append(anomalies, 'COVERAGE_UNVERIFIED') END
 WHERE quality_state = 'COMPLETE_WITH_UNRESOLVED'
   AND (
     source_verification IN ('UNVERIFIABLE', 'RECONSTRUCTED')
     OR (source_verification = 'PARTIAL'
         AND coalesce(jsonb_array_length(CASE WHEN jsonb_typeof(verification -> 'pagesMissing') = 'array'
                                              THEN verification -> 'pagesMissing' END), 0) = 0)
   );
