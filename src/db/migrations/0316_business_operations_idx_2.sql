-- Migration 0316 (index 2/16) : Opérations d'un compte par date de réalisation (B21, C20.1).
-- UNE instruction par fichier : `CREATE INDEX CONCURRENTLY` ne s'exécute pas
-- dans une transaction. Idempotente ; un index laissé INVALIDE est reconstruit
-- (`migration-index.ts`).
--
-- INDEX OPTIONNEL : sans lui, la requête parcourt davantage de lignes — plus
-- lente, jamais fausse.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS business_operations_account_realized_idx
  ON business_operations (account_id, realized_date);
