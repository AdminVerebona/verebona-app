-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0650 : archivage S3 des traces IA SANS suppression en base — lot
-- 82C (décision PO n° 10 du 22/10 : suspendre la suppression des traces IA
-- après 88 jours ; les archives gardent leur rôle de sauvegarde).
--
--   ai_log_archives.source_rows_kept — vrai quand les lignes archivées sont
--   restées en base (copie de sauvegarde) ; faux pour les archives
--   antérieures, dont les lignes ont été supprimées (historique : elles ne
--   sont lisibles que dans l'objet S3).
--
-- Idempotente.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE ai_log_archives ADD COLUMN IF NOT EXISTS source_rows_kept BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN ai_log_archives.source_rows_kept IS
  'Lot 82C : lignes source conservées en base après dépôt de l''archive (copie de sauvegarde). Faux : archive antérieure, lignes retirées de la base.';
