-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0692 : exports des exécutions IA (lot 84D, CDC Pilotage IA V2 P3,
-- EXP-01 à EXP-05, R27, R28, R63, R64).
--
-- AUCUNE NOUVELLE TABLE : le suivi des générations d'export existant
-- `admin_export_generations` (0632, lot 81C ; 0657, lot 82E) suit désormais
-- aussi l'export des exécutions IA (BO › Exécutions & logs) :
--   kind = 'AI_EXECUTIONS_EXPORT' (contrainte étendue) ;
--   resume_state — point de reprise d'une génération longue (curseur de
--                  lecture, parties déjà écrites et leurs totaux) : une
--                  génération interrompue (processus arrêté, erreur) REPREND
--                  à ce point, sans doublon ni perte ; jamais présentée
--                  comme complète tant qu'elle n'est pas terminée.
--
-- Aucun contenu exporté n'est conservé ici (journal technique, sans
-- `account_id`) : la table reste exclue de l'export de recette (motif déjà
-- classé dans recette-catalog.ts) et conservée lors d'une restauration
-- (RESTORE_KEEP_CURRENT_TABLES). Idempotente.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE admin_export_generations ADD COLUMN IF NOT EXISTS resume_state JSONB;

ALTER TABLE admin_export_generations DROP CONSTRAINT IF EXISTS admin_export_generations_kind_chk;
ALTER TABLE admin_export_generations ADD CONSTRAINT admin_export_generations_kind_chk
  CHECK (kind IN ('ACCOUNT_DATA', 'TECH_DIAGNOSTIC', 'RECETTE_EXPORT', 'AI_EXECUTIONS_EXPORT'));
