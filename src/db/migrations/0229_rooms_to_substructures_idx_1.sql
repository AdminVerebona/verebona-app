-- Migration 0229 (index 1/3) : une sous-structure au plus par pièce `rooms`
-- reprise (D-G, lot 20). La reprise s'appuie sur cette unicité pour rester
-- relançable sans doublon (elle vérifie que l'index existe et est VALIDE).
-- UNE instruction par fichier (CONCURRENTLY, hors transaction). Idempotente.
-- Verrous : `lock_timeout` posé par `runMigrationSql` ; index invalide
-- reconstruit au démarrage suivant (`repairInvalidMigrationIndexes`).
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS substructures_legacy_room_uidx ON substructures (legacy_room_id) WHERE legacy_room_id IS NOT NULL;
