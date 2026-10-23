-- Migration 0655 (index 1/2) : Opérations d'une Pièce (reconsolidation ciblée, lecture du drawer, transfert du bien).
-- UNE instruction par fichier : `CREATE INDEX CONCURRENTLY` ne s'exécute pas
-- dans une transaction. Idempotente ; un index laissé INVALIDE est reconstruit
-- (`migration-index.ts`).
--
-- INDEX OPTIONNEL : sans lui, la requête parcourt davantage de lignes — plus
-- lente, jamais fausse.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS business_operation_room_links_substructure_idx
  ON business_operation_room_links (substructure_id, operation_id);
