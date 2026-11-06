-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1530 : diagnostic BO — ARCHIVE ZIP DÉFINITIVE (lot 113Q, ticket
-- Trello #714 du 06/11/2026 « Borner la mémoire de génération et produire un
-- ZIP définitif prêt à télécharger »).
--
-- Avant : le ZIP était reconstruit à CHAQUE téléchargement (décompression puis
-- recompression de tous les fichiers dans le processus web). Désormais le
-- worker l'assemble UNE fois après validation, le stocke sur OVH, le relit et
-- le vérifie, puis publie. Ces colonnes décrivent l'archive publiée :
--   archive_key          clé de l'objet (préfixe de la tentative publiée) ;
--   archive_bytes        taille de l'archive (octets) ;
--   archive_sha256       empreinte SHA-256 de l'archive envoyée ;
--   archive_entries      nombre de fichiers de l'archive ;
--   archive_zip64        format ZIP64 utilisé (archive ou fichier > 4 Gio) ;
--   archive_verified_at  fin de la vérification intégrale (relecture).
-- Aucune donnée métier. NULL : publication antérieure au lot 113Q (le
-- téléchargement assemble alors l'archive en flux, sans recompression).
--
-- Additive, idempotente, rejouable. Retour arrière : les colonnes peuvent
-- rester (le code antérieur les ignore).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE admin_export_generations ADD COLUMN IF NOT EXISTS archive_key TEXT;
ALTER TABLE admin_export_generations ADD COLUMN IF NOT EXISTS archive_bytes BIGINT;
ALTER TABLE admin_export_generations ADD COLUMN IF NOT EXISTS archive_sha256 TEXT;
ALTER TABLE admin_export_generations ADD COLUMN IF NOT EXISTS archive_entries INTEGER;
ALTER TABLE admin_export_generations ADD COLUMN IF NOT EXISTS archive_zip64 BOOLEAN;
ALTER TABLE admin_export_generations ADD COLUMN IF NOT EXISTS archive_verified_at TIMESTAMPTZ;
