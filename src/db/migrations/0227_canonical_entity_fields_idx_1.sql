-- Migration 0227 (index 1/1) : canonical_field_writes (cible) — CDC 15 T1-04, lot 18.
-- Historique d'un champ d'un équipement ou d'une pièce ; index partiel (lignes
-- ciblées seulement). UNE instruction par fichier : `CREATE INDEX
-- CONCURRENTLY` hors transaction, sans bloquer les écritures du journal.
-- Verrous : `runMigrationSql` pose `lock_timeout` (MIGRATION_INDEX_LOCK_TIMEOUT,
-- 10 s) ; index invalide reconstruit au démarrage suivant
-- (`repairInvalidMigrationIndexes`). Idempotente (IF NOT EXISTS).
CREATE INDEX CONCURRENTLY IF NOT EXISTS canonical_field_writes_target_idx ON canonical_field_writes (target_type, target_id, canonical_key, created_at DESC) WHERE target_type IS NOT NULL;
