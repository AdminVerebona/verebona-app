-- Migration 0219 (index 2/3) : field_evidence (compte, clé canonique) — CDC 15 T1-01.
-- UNE instruction par fichier (CREATE INDEX CONCURRENTLY hors transaction).
-- Idempotente (IF NOT EXISTS). Index INVALIDE après interruption : le
-- supprimer (DROP INDEX CONCURRENTLY <nom>) puis redémarrer.
CREATE INDEX CONCURRENTLY IF NOT EXISTS field_evidence_account_canonical_idx ON field_evidence (account_id, canonical_key) WHERE canonical_key IS NOT NULL;
