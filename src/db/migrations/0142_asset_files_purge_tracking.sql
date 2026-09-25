-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0142 — Suivi des suppressions physiques (cleanup des fichiers
-- supprimés depuis plus de 30 jours).
--
-- Le cleanup supprimait l'enregistrement en base MÊME quand la suppression S3
-- échouait : le fichier restait dans le stockage, sans plus aucune référence
-- pour le retrouver et reprendre l'effacement.
--
-- Désormais la référence est conservée tant que S3 n'a pas confirmé ; ces
-- colonnes tracent les échecs pour suivre les suppressions en retard.
-- Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE asset_files ADD COLUMN IF NOT EXISTS purge_attempts        INTEGER NOT NULL DEFAULT 0;
ALTER TABLE asset_files ADD COLUMN IF NOT EXISTS purge_last_error      TEXT;
ALTER TABLE asset_files ADD COLUMN IF NOT EXISTS purge_last_attempt_at TIMESTAMPTZ;

-- Suppressions en retard (au moins un échec S3).
CREATE INDEX IF NOT EXISTS asset_files_purge_pending_idx
  ON asset_files (purge_last_attempt_at)
  WHERE deleted_at IS NOT NULL AND purge_attempts > 0;
