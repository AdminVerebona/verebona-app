-- Migration 0317 (index 5/10) : Cascade de suppression d'un document.
-- UNE instruction par fichier : `CREATE INDEX CONCURRENTLY` ne s'exécute pas
-- dans une transaction. Idempotente ; un index laissé INVALIDE est reconstruit
-- (`migration-index.ts`).
--
-- INDEX OPTIONNEL : sans lui, la requête parcourt davantage de lignes — plus
-- lente, jamais fausse.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS business_operation_claim_damage_documents_file_idx
  ON business_operation_claim_damage_documents (file_id);
