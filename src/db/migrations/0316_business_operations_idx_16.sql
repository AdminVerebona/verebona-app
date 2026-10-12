-- Migration 0316 (index 16/16) : Rapprochement M1 sur référence exacte (C6.1, C7), borné par compte.
-- UNE instruction par fichier : `CREATE INDEX CONCURRENTLY` ne s'exécute pas
-- dans une transaction. Idempotente ; un index laissé INVALIDE est reconstruit
-- (`migration-index.ts`).
--
-- INDEX OPTIONNEL : sans lui, la requête parcourt davantage de lignes — plus
-- lente, jamais fausse.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS business_operation_references_lookup_idx
  ON business_operation_references (account_id, reference_kind, normalized_value)
  WHERE active;
