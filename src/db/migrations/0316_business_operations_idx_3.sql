-- Migration 0316 (index 3/16) : Enfants d'une Opération (profondeur, cycles, PARENT-xxx).
-- UNE instruction par fichier : `CREATE INDEX CONCURRENTLY` ne s'exécute pas
-- dans une transaction. Idempotente ; un index laissé INVALIDE est reconstruit
-- (`migration-index.ts`).
--
-- INDEX OPTIONNEL : sans lui, la requête parcourt davantage de lignes — plus
-- lente, jamais fausse.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS business_operations_parent_idx
  ON business_operations (parent_operation_id)
  WHERE parent_operation_id IS NOT NULL;
