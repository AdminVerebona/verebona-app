-- Migration 0219 (index 1/3) : field_evidence (source, cycle de vie) — CDC 15 §14.4.
-- Sert le supersede à la réanalyse (preuves ACTIVE d'une source).
-- UNE instruction par fichier : `CREATE INDEX CONCURRENTLY` ne peut pas
-- s'exécuter dans une transaction, et une requête à instruction unique n'en
-- ouvre pas (`ensureMigrations` passe le fichier tel quel).
-- Idempotente (IF NOT EXISTS). Index INVALIDE après interruption : le
-- supprimer (DROP INDEX CONCURRENTLY <nom>) puis redémarrer — contrôle :
--   SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
CREATE INDEX CONCURRENTLY IF NOT EXISTS field_evidence_source_lifecycle_idx ON field_evidence (account_id, source_type, source_id) WHERE lifecycle_status IS NULL OR lifecycle_status = 'ACTIVE';
