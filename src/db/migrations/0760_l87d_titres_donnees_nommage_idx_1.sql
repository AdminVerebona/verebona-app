-- Migration 0760 (index 1/1) : groupe canonique d'un titre (lot 87D) — lecture
-- des autres documents de même clé (nature | fournisseur | période) par le
-- service de nommage pour la désambiguïsation déterministe.
-- UNE instruction par fichier : `CREATE INDEX CONCURRENTLY` ne s'exécute pas
-- dans une transaction. Idempotente ; un index laissé INVALIDE est reconstruit
-- (`migration-index.ts`).
CREATE INDEX CONCURRENTLY IF NOT EXISTS asset_files_title_canonical_key_idx
  ON asset_files (account_id, title_canonical_key)
  WHERE title_canonical_key IS NOT NULL AND deleted_at IS NULL;
