-- Migration 0316 (index 4/16) : Opérations absorbées vers leur canonique (redirection, C20.1).
-- UNE instruction par fichier : `CREATE INDEX CONCURRENTLY` ne s'exécute pas
-- dans une transaction. Idempotente ; un index laissé INVALIDE est reconstruit
-- (`migration-index.ts`).
--
-- INDEX OPTIONNEL : sans lui, la requête parcourt davantage de lignes — plus
-- lente, jamais fausse.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS business_operations_merged_into_idx
  ON business_operations (merged_into_operation_id)
  WHERE merged_into_operation_id IS NOT NULL;
