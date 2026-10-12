-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0337 : visibilité du traitement d'analyse d'un document (lot 50 —
-- ticket « Mascotte : fiabiliser les sujets affichés et le contexte transmis
-- à T6 »).
--
--   asset_files.analysis_visibility
--       USER       analyse attendue par l'utilisateur (dépôt, analyse
--                  demandée, analyse rétroactive) ;
--       TECHNICAL  réanalyse interne (correction, rattachement, déplacement,
--                  montée de référentiel, reprise, réparation) ;
--       NULL       documents antérieurs : traités comme USER.
--   Écrite à la mise en file et au démarrage de l'analyse
--   (`processing-visibility.ts`) ; lue par la mascotte seulement — l'état
--   technique du document (`analysis_state`, file T1) est inchangé.
--
-- Colonne NULLABLE sans défaut : ajout instantané (catalogue seulement),
-- aucune réécriture. Contrainte NOT VALID : contrôle des nouvelles écritures,
-- aucune lecture de la table (toutes les lignes existantes sont nulles).
-- Colonne non déclarée dans Drizzle (même choix que 0223) : le code teste sa
-- présence avant de la lire ou de l'écrire.
-- Idempotente. Retour arrière : ALTER TABLE asset_files DROP COLUMN IF EXISTS
-- analysis_visibility (code tolérant : colonne absente → comportement antérieur).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE asset_files ADD COLUMN IF NOT EXISTS analysis_visibility TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'asset_files_analysis_visibility_check') THEN
    ALTER TABLE asset_files ADD CONSTRAINT asset_files_analysis_visibility_check
      CHECK (analysis_visibility IS NULL OR analysis_visibility IN ('USER', 'TECHNICAL')) NOT VALID;
  END IF;
END $$;
