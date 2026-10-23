-- Migration 0652 (index 1/1) : au plus UN élément d'agenda principal par Opération (CDC v5 §27.2, invariant INV-O1-PRINCIPAL-UNIQUE).
-- UNE instruction par fichier : `CREATE INDEX CONCURRENTLY` ne s'exécute pas
-- dans une transaction. Idempotente ; un index laissé INVALIDE est reconstruit
-- (`migration-index.ts`). La reprise 0652 ne pose au plus qu'un principal par
-- Opération : la construction ne peut pas rencontrer de doublon.
--
-- INDEX CRITIQUE (contrainte d'unicité métier) : non optionnel.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS agenda_items_operation_principal_uidx
  ON agenda_items (business_operation_id)
  WHERE operation_role = 'PRINCIPAL';
