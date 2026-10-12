-- Migration 0316 (index 13/16) : Composantes par date économique (C20.1).
-- UNE instruction par fichier : `CREATE INDEX CONCURRENTLY` ne s'exécute pas
-- dans une transaction. Idempotente ; un index laissé INVALIDE est reconstruit
-- (`migration-index.ts`).
--
-- INDEX OPTIONNEL : sans lui, la requête parcourt davantage de lignes — plus
-- lente, jamais fausse.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS business_operation_financial_components_economic_date_idx
  ON business_operation_financial_components (economic_date)
  WHERE economic_date IS NOT NULL;
