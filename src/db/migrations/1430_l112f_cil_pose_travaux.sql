-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1430 : CIL — matériaux et équipements POSÉS prouvés par une facture
-- ou une attestation de travaux (lot 112F). Service :
-- `src/services/cil/projection/document-projection.ts` (`projectInstalled`).
-- Matrice : `docs/cil/matrice-cil.md` (B5, B6, B7).
--
-- 1. `energy_materials` (B5) :
--      installed_at   date de pose = date de réalisation de l'Opération
--                     d'intervention prouvée (NULL : attestation sans date →
--                     « date de pose » à compléter) ;
--      operation_id   Opération INTERVENTION réalisée et prouvée qui porte la
--                     pose — MÊME identité que B7 (décision PO du 06/11 :
--                     aucune copie dans `energy_works`). Pas de clé étrangère :
--                     une Opération invalidée, fusionnée ou supprimée fait
--                     RETIRER la ligne DOCUMENT par la projection (journal
--                     RETRACTED), jamais l'inverse.
-- 2. `equipment_cil_specs` (B6) :
--      installed_at, installation_operation_id — même règle pour un équipement
--      posé (création ou complément des champs vides seulement).
--
-- Additive, idempotente, rejouable. Retour arrière : colonnes ignorées par le
-- code antérieur (les lignes restent des matériaux / équipements ordinaires).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE energy_materials
  ADD COLUMN IF NOT EXISTS installed_at date,
  ADD COLUMN IF NOT EXISTS operation_id bigint;
CREATE INDEX IF NOT EXISTS energy_materials_operation_idx ON energy_materials (operation_id) WHERE operation_id IS NOT NULL;

ALTER TABLE equipment_cil_specs
  ADD COLUMN IF NOT EXISTS installed_at date,
  ADD COLUMN IF NOT EXISTS installation_operation_id bigint;

COMMENT ON COLUMN energy_materials.installed_at IS 'Lot 112F — date de pose (date de réalisation de l’Opération d’intervention prouvée par facture / attestation).';
COMMENT ON COLUMN energy_materials.operation_id IS 'Lot 112F — Opération INTERVENTION réalisée et prouvée qui porte la pose (même identité que B7 ; aucune copie energy_works).';
COMMENT ON COLUMN equipment_cil_specs.installed_at IS 'Lot 112F — date de pose de l’équipement (Opération d’intervention prouvée).';
COMMENT ON COLUMN equipment_cil_specs.installation_operation_id IS 'Lot 112F — Opération INTERVENTION réalisée et prouvée qui porte la pose.';
