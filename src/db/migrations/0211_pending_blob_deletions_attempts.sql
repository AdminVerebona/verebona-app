-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0211 : compteur de tentatives de la file de purge du stockage.
-- CDC Exports V12 DRH-004 (suppression manuelle = fichier supprimé).
--
-- La purge (`services/storage/blob-purge.service.ts`, tâche quotidienne
-- interne + GET /api/cron/purge-blobs) relisait sans fin les lignes en échec,
-- sans ORDER BY : quelques objets impossibles à supprimer pouvaient occuper
-- tout le lot de 50 et bloquer la file. Chaque échec incrémente désormais
-- `attempt_count` et repousse `scheduled_for` (backoff) ; au-delà du plafond,
-- la ligne est exclue (elle reste visible pour examen, avec `error_message`).
--
-- Index partiel : lignes restant à traiter, dans l'ordre de passage.
--
-- Idempotente.
-- ──────────────────────────────────────────────────────────────────────────────

ALTER TABLE pending_blob_deletions
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS pending_blob_deletions_queue_idx
  ON pending_blob_deletions (scheduled_for, id) WHERE processed_at IS NULL;
