-- Migration 0325 (index 3/6) : BO diagnostic des Opérations (lot 47A, O9) —
-- Opérations invalidées ou fusionnées (filtres de la liste).
-- UNE instruction par fichier : `CREATE INDEX CONCURRENTLY` ne s'exécute pas
-- dans une transaction. Idempotente ; un index laissé INVALIDE est reconstruit
-- (`migration-index.ts`).
--
-- INDEX OPTIONNEL : sans lui, la requête parcourt davantage de lignes — plus
-- lente, jamais fausse.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS business_operations_invalidated_idx
  ON business_operations (account_id, invalidated_at)
  WHERE invalidated_at IS NOT NULL;
