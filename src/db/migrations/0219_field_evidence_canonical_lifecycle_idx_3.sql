-- Migration 0219 (index 3/3) : field_evidence (cible) — CDC 15 T1-04, T1-05.
-- UNE instruction par fichier (CREATE INDEX CONCURRENTLY hors transaction).
-- Idempotente (IF NOT EXISTS). Index INVALIDE après interruption : le
-- supprimer (DROP INDEX CONCURRENTLY <nom>) puis redémarrer.
CREATE INDEX CONCURRENTLY IF NOT EXISTS field_evidence_target_idx ON field_evidence (target_type, target_entity_id) WHERE target_entity_id IS NOT NULL;
