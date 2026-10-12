-- Migration 0316 (index 12/16) : Composantes attribuées à un équipement ; SET NULL à la suppression de l'équipement.
-- UNE instruction par fichier : `CREATE INDEX CONCURRENTLY` ne s'exécute pas
-- dans une transaction. Idempotente ; un index laissé INVALIDE est reconstruit
-- (`migration-index.ts`).
--
-- INDEX OPTIONNEL : sans lui, la requête parcourt davantage de lignes — plus
-- lente, jamais fausse.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS business_operation_financial_components_target_equipment_idx
  ON business_operation_financial_components (target_equipment_id)
  WHERE target_equipment_id IS NOT NULL;
