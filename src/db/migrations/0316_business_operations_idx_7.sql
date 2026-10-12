-- Migration 0316 (index 7/16) : Opérations d'un bien (ch. 22.1) ; cascade de suppression du bien.
-- UNE instruction par fichier : `CREATE INDEX CONCURRENTLY` ne s'exécute pas
-- dans une transaction. Idempotente ; un index laissé INVALIDE est reconstruit
-- (`migration-index.ts`).
--
-- INDEX OPTIONNEL : sans lui, la requête parcourt davantage de lignes — plus
-- lente, jamais fausse.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS business_operation_asset_links_asset_idx
  ON business_operation_asset_links (asset_id, operation_id);
