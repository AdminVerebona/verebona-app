-- Migration 0655 (index 2/2) : Opérations d'un document (appartenance active : DocumentDrawer, propagation vers le principal).
-- UNE instruction par fichier : `CREATE INDEX CONCURRENTLY` ne s'exécute pas
-- dans une transaction. Idempotente ; un index laissé INVALIDE est reconstruit
-- (`migration-index.ts`).
--
-- INDEX OPTIONNEL : sans lui, la requête parcourt davantage de lignes — plus
-- lente, jamais fausse.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS business_operation_documents_file_idx
  ON business_operation_documents (account_id, file_id)
  WHERE active;
