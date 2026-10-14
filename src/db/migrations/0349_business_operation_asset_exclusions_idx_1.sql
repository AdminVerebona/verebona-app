-- Migration 0349 (index 1/1) : exclusions de biens d'un sinistre (lot 53C,
-- retour PO Q17) — une seule exclusion ACTIVE par (Opération, bien), lue par
-- la consolidation T3 de l'Opération.
-- UNE instruction par fichier : `CREATE INDEX CONCURRENTLY` ne s'exécute pas
-- dans une transaction. Idempotente ; un index laissé INVALIDE est reconstruit
-- (`migration-index.ts`).
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS business_operation_asset_exclusions_active_uidx
  ON business_operation_asset_exclusions (operation_id, asset_id) WHERE active;
