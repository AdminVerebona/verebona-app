-- Migration 0317 (index 10/10) : SET NULL à la suppression du document lié.
-- UNE instruction par fichier : `CREATE INDEX CONCURRENTLY` ne s'exécute pas
-- dans une transaction. Idempotente ; un index laissé INVALIDE est reconstruit
-- (`migration-index.ts`).
--
-- INDEX OPTIONNEL : sans lui, la requête parcourt davantage de lignes — plus
-- lente, jamais fausse.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS business_operation_claim_exchanges_document_idx
  ON business_operation_claim_exchanges (document_file_id)
  WHERE document_file_id IS NOT NULL;
