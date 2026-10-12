-- Migration 0316 (index 8/16) : Opérations d'un équipement (ch. 22.1) ; cascade de suppression de l'équipement.
-- UNE instruction par fichier : `CREATE INDEX CONCURRENTLY` ne s'exécute pas
-- dans une transaction. Idempotente ; un index laissé INVALIDE est reconstruit
-- (`migration-index.ts`).
--
-- INDEX OPTIONNEL : sans lui, la requête parcourt davantage de lignes — plus
-- lente, jamais fausse.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS business_operation_equipment_links_equipment_idx
  ON business_operation_equipment_links (equipment_id, operation_id);
