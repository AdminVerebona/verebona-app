-- Migration 0325 (index 2/6) : BO diagnostic des Opérations (lot 47A, O9) —
-- liste et indicateurs d'UN compte, triés / bornés par date de création.
-- UNE instruction par fichier : `CREATE INDEX CONCURRENTLY` ne s'exécute pas
-- dans une transaction. Idempotente ; un index laissé INVALIDE est reconstruit
-- (`migration-index.ts`).
--
-- INDEX OPTIONNEL : sans lui, la requête parcourt davantage de lignes — plus
-- lente, jamais fausse.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS business_operations_account_created_idx
  ON business_operations (account_id, created_at);
