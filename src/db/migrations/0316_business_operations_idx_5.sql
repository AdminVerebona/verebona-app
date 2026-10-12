-- Migration 0316 (index 5/16) : Opérations prouvées par une source (document supprimé, bien supprimé, rapprochement M2) — bornées par compte.
-- UNE instruction par fichier : `CREATE INDEX CONCURRENTLY` ne s'exécute pas
-- dans une transaction. Idempotente ; un index laissé INVALIDE est reconstruit
-- (`migration-index.ts`).
--
-- INDEX OPTIONNEL : sans lui, la requête parcourt davantage de lignes — plus
-- lente, jamais fausse.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS business_operation_sources_entity_idx
  ON business_operation_sources (account_id, source_kind, source_entity_key)
  WHERE active;
