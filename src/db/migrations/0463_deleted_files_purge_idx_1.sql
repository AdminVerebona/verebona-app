-- verebona:optional-index
-- Migration 0463 (index 1/1) : recherche des références à un objet de stockage
-- (lot 65A). Avant toute suppression S3, la purge vérifie qu'aucune autre ligne
-- `asset_files` n'utilise la même clé (copie de transmission en repli, vignette
-- promue…). Facultatif : sans lui, la vérification reste faite (plus lente).
-- UNE instruction par fichier : CONCURRENTLY hors transaction. Idempotente.
CREATE INDEX CONCURRENTLY IF NOT EXISTS asset_files_s3_key_idx
  ON asset_files (s3_key) WHERE s3_key IS NOT NULL;
