-- Migration 0317 (index 8/10) : SET NULL à la suppression de la facture liée.
-- UNE instruction par fichier : `CREATE INDEX CONCURRENTLY` ne s'exécute pas
-- dans une transaction. Idempotente ; un index laissé INVALIDE est reconstruit
-- (`migration-index.ts`).
--
-- INDEX OPTIONNEL : sans lui, la requête parcourt davantage de lignes — plus
-- lente, jamais fausse.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS business_operation_claim_actions_invoice_idx
  ON business_operation_claim_actions (invoice_file_id)
  WHERE invoice_file_id IS NOT NULL;
