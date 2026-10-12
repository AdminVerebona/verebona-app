-- Migration 0325 (index 4/6) : BO diagnostic des Opérations (lot 47A, O9) —
-- indicateur C26.2 « % candidats certains aboutissant CREATE vs MATCH » sur
-- la période (date du dernier passage T3).
-- UNE instruction par fichier : `CREATE INDEX CONCURRENTLY` ne s'exécute pas
-- dans une transaction. Idempotente ; un index laissé INVALIDE est reconstruit
-- (`migration-index.ts`).
--
-- INDEX OPTIONNEL : sans lui, la requête parcourt davantage de lignes — plus
-- lente, jamais fausse.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS document_operation_candidates_t3_processed_idx
  ON document_operation_candidates (t3_processed_at)
  WHERE t3_outcome IS NOT NULL;
