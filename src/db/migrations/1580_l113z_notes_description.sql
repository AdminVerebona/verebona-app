-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1580 : champ unique « Notes / Description » d'un document — reprise
-- en main par l'utilisateur, provenance de la description, trace T1 (lot 113Z,
-- carte Trello #723 « Documents — Unifier « Notes / Description », sécuriser T1
-- et les dossiers tiers »).
--
--   asset_files.notes_user_owned      REPRISE EN MAIN EXPLICITE : l'utilisateur
--       a enregistré un texte MODIFIÉ dans « Notes / Description ». Le texte est
--       dans `notes` ; `notes` NULL avec ce drapeau = valeur utilisateur
--       VOLONTAIREMENT VIDE (la description T1 ne réapparaît plus). Distingue
--       « aucune saisie » (false) de « saisie vide » (true) sans dépendre de
--       `notes IS NULL`. Jamais posé par une écriture automatique.
--   asset_files.notes_updated_at      dernière écriture utilisateur de `notes`.
--   asset_files.description_source    provenance ÉTABLIE de `description` :
--       'T1' (écrite par l'analyse, ou identique à la sortie T1 persistée) ;
--       NULL = origine inconnue (stock historique : saisie à l'import, ancien
--       tiroir ou T1 — non qualifiée, jamais présentée comme IA).
--   asset_files.description_t1_status dernier constat T1 sur la description :
--       PRODUCED | ABSENT | REMOVED_AT_VALIDATION | PERSIST_FAILED |
--       KEPT_UNKNOWN_ORIGIN | KEPT_USER_LOCKED | RECOVERED (reprise depuis
--       l'extraction persistée, sans IA).
--   asset_files.description_t1_status_at / description_t1_run_id
--       horodatage et run T1 du constat.
--
-- Colonnes NON déclarées dans Drizzle (même choix que 0223 / 0337) : le code
-- teste leur présence (`notes-description/store.ts`) avant de les lire ou de
-- les écrire ; absentes → comportement antérieur. Aucune donnée existante
-- n'est réécrite (aucune migration aveugle des descriptions vers les notes,
-- aucune provenance supposée) : la provenance T1 de l'historique n'est posée
-- que par le contrôle COH-DOC-DESCRIPTION-T1, sur preuve (égalité avec
-- l'extraction T1 persistée).
--
-- `NOT NULL DEFAULT false` : valeur par défaut « rapide » (PostgreSQL ≥ 11,
-- catalogue seulement, aucune réécriture). Contraintes NOT VALID : contrôle
-- des nouvelles écritures sans lecture de la table.
-- Idempotente, rejouable. Retour arrière : ALTER TABLE asset_files DROP COLUMN
-- IF EXISTS … (code tolérant : colonnes absentes → comportement antérieur).
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

COMMENT ON COLUMN asset_files.notes_user_owned IS 'Lot 113Z : reprise en main explicite de « Notes / Description » (notes NULL + true = vide volontaire).';
COMMENT ON COLUMN asset_files.description_source IS 'Lot 113Z : provenance établie de description (T1) ; NULL = origine inconnue.';
COMMENT ON COLUMN asset_files.description_t1_status IS 'Lot 113Z : dernier constat T1 sur la description (trace de diagnostic).';
