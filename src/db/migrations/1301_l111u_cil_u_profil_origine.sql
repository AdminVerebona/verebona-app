-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1301 : CIL — deuxième passe du lot 111U.
--
-- 1. `energy_materials.u_value` : coefficient de transmission thermique U
--    (W/(m²·K)) lu sur un diagnostic ou une fiche technique. Aucune autre
--    colonne ne pouvait le porter ; R n'est JAMAIS déduit de U (ni l'inverse).
-- 2. `asset_cil_profiles` (B2) reçoit sa provenance :
--      origin          USER | ADMIN (protégées) | DOCUMENT (projection T3
--                      déterministe d'un fait explicite) — les lignes
--                      existantes ont été saisies : USER (défaut) ;
--      source_file_id  document qui établit le motif / la date ;
--      evidence        faits sources (identifiants), jamais de contenu.
--
-- Additive, idempotente, rejouable. Retour arrière : colonnes ignorées par le
-- code antérieur.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE energy_materials ADD COLUMN IF NOT EXISTS u_value numeric;
ALTER TABLE energy_materials DROP CONSTRAINT IF EXISTS energy_materials_u_value_check;
ALTER TABLE energy_materials ADD CONSTRAINT energy_materials_u_value_check CHECK (u_value IS NULL OR (u_value > 0 AND u_value < 20));

ALTER TABLE asset_cil_profiles
  ADD COLUMN IF NOT EXISTS origin         text NOT NULL DEFAULT 'USER',
  ADD COLUMN IF NOT EXISTS source_file_id integer REFERENCES asset_files(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS evidence       jsonb;
ALTER TABLE asset_cil_profiles DROP CONSTRAINT IF EXISTS asset_cil_profiles_origin_check;
ALTER TABLE asset_cil_profiles ADD CONSTRAINT asset_cil_profiles_origin_check CHECK (origin IN ('USER', 'ADMIN', 'DOCUMENT'));

COMMENT ON COLUMN energy_materials.u_value IS 'Lot 111U — coefficient U en W/(m²·K) ; jamais converti en R.';
COMMENT ON COLUMN asset_cil_profiles.origin IS 'Lot 111U — USER | ADMIN (protégées) | DOCUMENT (fait explicite d’un document).';
