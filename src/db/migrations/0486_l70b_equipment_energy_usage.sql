-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0486 : usage énergétique déclaré d'un équipement (lot 70B,
-- décision PO du 19/10 — champ « Usage énergétique » du tiroir équipement).
--
-- `equipments.energy_usage` : choix FERMÉ saisi dans le tiroir (création et
-- modification), lu EN PRIORITÉ par la règle unique B6
-- `classifyCilEnergyEquipment` (src/lib/cil/energy-equipment.ts) — donc même
-- résultat dans la complétude CIL, la préparation, le mappeur et le PDF.
--
-- Valeurs : les usages du référentiel CIL déjà employés par la règle et par
-- `energy_works.category` (chauffage, refroidissement, ecs, ventilation, enr),
-- plus `aucun` (« Aucun usage énergétique » : exclut explicitement
-- l'équipement, même si son type le suggère). NULL = « Non renseigné » : la
-- règle historique (catégorie, type, caractéristiques CIL) s'applique.
--
-- Colonne dédiée plutôt que `equipments.category` : `category` porte déjà
-- d'autres natures (« MOBILIER » lu par l'export instantané) qu'un choix
-- « Aucun » écraserait.
--
-- Idempotente. Ajout de colonne NULL sans défaut : métadonnées seules (aucune
-- réécriture de table). Contrainte posée NOT VALID puis validée (toutes les
-- lignes sont NULL). Retour arrière : l'ancien code ignore la colonne.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE equipments ADD COLUMN IF NOT EXISTS energy_usage text;

DO $l70b$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'equipments_energy_usage_check') THEN
    ALTER TABLE equipments ADD CONSTRAINT equipments_energy_usage_check
      CHECK (energy_usage IS NULL OR energy_usage IN ('chauffage', 'refroidissement', 'ecs', 'ventilation', 'enr', 'aucun')) NOT VALID;
  END IF;
END
$l70b$;

ALTER TABLE equipments VALIDATE CONSTRAINT equipments_energy_usage_check;

COMMENT ON COLUMN equipments.energy_usage IS
  'Usage énergétique déclaré (lot 70B) : chauffage | refroidissement | ecs | ventilation | enr | aucun ; NULL = non renseigné (le type décide). Lu en priorité par la règle B6 du CIL.';
