-- Migration 0316 (index 11/16) : Composantes attribuées à un bien (ch. 22.1) ; SET NULL à la suppression du bien.
-- UNE instruction par fichier : `CREATE INDEX CONCURRENTLY` ne s'exécute pas
-- dans une transaction. Idempotente ; un index laissé INVALIDE est reconstruit
-- (`migration-index.ts`).
--
-- INDEX OPTIONNEL : sans lui, la requête parcourt davantage de lignes — plus
-- lente, jamais fausse.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS business_operation_financial_components_target_asset_idx
  ON business_operation_financial_components (target_asset_id)
  WHERE target_asset_id IS NOT NULL;
