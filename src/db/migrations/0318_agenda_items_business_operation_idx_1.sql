-- Migration 0318 (index 1/1) : Événements Agenda liés à une Opération (projection T4, C16.1) ; SET NULL de la clé étrangère.
-- UNE instruction par fichier : `CREATE INDEX CONCURRENTLY` ne s'exécute pas
-- dans une transaction. Idempotente ; un index laissé INVALIDE est reconstruit
-- (`migration-index.ts`).
--
-- INDEX OPTIONNEL : sans lui, la requête parcourt davantage de lignes — plus
-- lente, jamais fausse.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS agenda_items_business_operation_idx
  ON agenda_items (business_operation_id)
  WHERE business_operation_id IS NOT NULL;
