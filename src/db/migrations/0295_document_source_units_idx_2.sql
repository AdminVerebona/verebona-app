-- Migration 0295 (index 2/2) : documents à reprendre (état INCOMPLETE_RETRYABLE,
-- tâche planifiée `t1-completeness-retry`) et supervision par état de qualité
-- (BO › Exécutions IA). UNE instruction par fichier (CONCURRENTLY). Idempotente.
--
-- INDEX OPTIONNEL : table d'une ligne par document ; sans lui, parcours complet
-- — plus lent, jamais faux.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS document_extraction_coverage_quality_idx
  ON document_extraction_coverage (quality_state, next_retry_at)
  WHERE quality_state <> 'COMPLETE';
