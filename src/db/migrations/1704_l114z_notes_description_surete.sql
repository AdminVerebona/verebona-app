-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1704 : filet de sûreté des colonnes « Notes / Description » de la
-- migration 1580 (lot 114Z, carte Trello #767, écart E05).
--
-- Le code refuse désormais d'enregistrer une prise en main, une modification ou
-- un effacement de « Notes / Description », et d'inclure ce texte dans une
-- transmission ou un dossier tiers, quand ces colonnes sont absentes. Cette
-- migration rejoue, à l'identique et sans rien d'autre, les ajouts de la 1580 :
-- sur un environnement où la 1580 est tracée mais dont les colonnes manquent
-- (retour arrière, restauration), le déploiement les rétablit.
--
-- AUCUNE donnée n'est écrite : aucun `notes = NULL` historique n'est converti en
-- choix de l'utilisateur, aucune provenance n'est supposée. Environnement où la
-- 1580 est en place : aucun effet (IF NOT EXISTS partout).
-- Additive, idempotente, rejouable.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE asset_files ADD COLUMN IF NOT EXISTS notes_user_owned BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE asset_files ADD COLUMN IF NOT EXISTS notes_updated_at TIMESTAMPTZ;
ALTER TABLE asset_files ADD COLUMN IF NOT EXISTS description_source TEXT;
ALTER TABLE asset_files ADD COLUMN IF NOT EXISTS description_t1_status TEXT;
ALTER TABLE asset_files ADD COLUMN IF NOT EXISTS description_t1_status_at TIMESTAMPTZ;
ALTER TABLE asset_files ADD COLUMN IF NOT EXISTS description_t1_run_id INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'asset_files_description_source_check') THEN
    ALTER TABLE asset_files ADD CONSTRAINT asset_files_description_source_check
      CHECK (description_source IS NULL OR description_source IN ('T1')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'asset_files_description_t1_status_check') THEN
    ALTER TABLE asset_files ADD CONSTRAINT asset_files_description_t1_status_check
      CHECK (description_t1_status IS NULL OR description_t1_status IN (
        'PRODUCED', 'ABSENT', 'REMOVED_AT_VALIDATION', 'PERSIST_FAILED', 'KEPT_UNKNOWN_ORIGIN', 'KEPT_USER_LOCKED', 'RECOVERED')) NOT VALID;
  END IF;
END $$;
