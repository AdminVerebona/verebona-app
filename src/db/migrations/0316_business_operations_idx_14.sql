-- Migration 0316 (index 14/16) : Composantes soutenues par une source (retrait de preuve, INV-056).
-- UNE instruction par fichier : `CREATE INDEX CONCURRENTLY` ne s'exécute pas
-- dans une transaction. Idempotente ; un index laissé INVALIDE est reconstruit
-- (`migration-index.ts`).
--
-- INDEX OPTIONNEL : sans lui, la requête parcourt davantage de lignes — plus
-- lente, jamais fausse.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS business_operation_financial_component_sources_source_idx
  ON business_operation_financial_component_sources (operation_source_id);
