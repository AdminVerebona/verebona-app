-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0657 : export complet de recette (lot 82E, décisions PO C-Q5,
-- C-Q8, §4.2 du 23/10).
--
--   admin_export_generations (0632, lot 81C) suit désormais aussi l'EXPORT
--   COMPLET DE RECETTE (tous les comptes, toutes les tables du périmètre),
--   généré EN TÂCHE DE FOND et STOCKÉ (OVH S3) pour un téléchargement
--   ultérieur :
--     kind = 'RECETTE_EXPORT' (contrainte étendue) ;
--     storage_prefix — préfixe des fichiers stockés (parties de données,
--                      dictionnaire, LISEZMOI, manifeste) ;
--     heartbeat_at   — dernier signe de vie de la génération : une génération
--                      RUNNING sans signe de vie depuis 10 minutes est
--                      interrompue (processus arrêté), jamais présentée
--                      comme complète.
--
-- Aucun contenu exporté n'est conservé ici (journal technique, sans
-- `account_id` : hors classement des transferts de biens). Idempotente.
-- ──────────────────────────────────────────────────────────────────────────────
ALTER TABLE admin_export_generations ADD COLUMN IF NOT EXISTS storage_prefix TEXT;
ALTER TABLE admin_export_generations ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ;

ALTER TABLE admin_export_generations DROP CONSTRAINT IF EXISTS admin_export_generations_kind_chk;
ALTER TABLE admin_export_generations ADD CONSTRAINT admin_export_generations_kind_chk
  CHECK (kind IN ('ACCOUNT_DATA', 'TECH_DIAGNOSTIC', 'RECETTE_EXPORT'));

CREATE INDEX IF NOT EXISTS admin_export_generations_kind_idx ON admin_export_generations (kind, started_at DESC);
