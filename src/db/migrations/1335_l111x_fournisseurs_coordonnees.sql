-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1335 : coordonnées des fournisseurs issues des documents ACTIFS
-- (lot 111X, ticket « Fournisseurs — coordonnées documentaires, T1 contrat /
-- couverture, T3 seconde chance, protection par champ, conflits sourcés »).
--
-- Aucune nouvelle table fournisseur : colonnes ADDITIVES sur les tables
-- existantes.
--
--   · suppliers.user_field_decisions : protection PAR CHAMP des saisies et
--     effacements volontaires de l'utilisateur ({ "phone": { "action":
--     "CLEARED" | "SET", "at": …, "userId": … } }). Remplace le blocage global
--     « fiche manuelle jamais complétée » : un champ jamais renseigné d'une
--     fiche manuelle peut être complété ; un champ effacé n'est jamais
--     réintroduit.
--   · suppliers.field_provenance : provenance du dernier remplissage
--     automatique d'un champ (document, observation, unité / fait, règle).
--   · supplier_contact_observations.origin / evidence : origine de
--     l'observation (T1_ANALYSIS, T3_SECOND_CHANCE…) et preuves par champ
--     (document, extraction, fait, unité source, confiance).
--   · property_recovery_runs / property_recovery_decisions (journal 0770 de la
--     seconde chance T3) : sujet SUPPLIER admis — l'historique par champ des
--     fournisseurs (source, unité / fait, valeur, confiance, décision, motif,
--     avant / après) réutilise ce journal. `asset_id` devient facultatif pour
--     ce seul sujet (un fournisseur n'a pas de bien porteur).
--
-- Additive, idempotente, rejouable ; aucune reprise de données.
-- Retour arrière : DROP COLUMN des quatre colonnes ; DELETE FROM
-- property_recovery_decisions / _runs WHERE object_type = 'SUPPLIER', puis
-- remettre les contraintes de 0770 et SET NOT NULL sur asset_id.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS user_field_decisions JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS field_provenance JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE supplier_contact_observations ADD COLUMN IF NOT EXISTS origin TEXT;
ALTER TABLE supplier_contact_observations ADD COLUMN IF NOT EXISTS evidence JSONB;

ALTER TABLE property_recovery_runs ALTER COLUMN asset_id DROP NOT NULL;
ALTER TABLE property_recovery_decisions ALTER COLUMN asset_id DROP NOT NULL;

ALTER TABLE property_recovery_runs DROP CONSTRAINT IF EXISTS property_recovery_runs_object_type_chk;
ALTER TABLE property_recovery_runs ADD CONSTRAINT property_recovery_runs_object_type_chk
  CHECK (object_type IN ('ASSET', 'EQUIPMENT', 'SUPPLIER')) NOT VALID;
ALTER TABLE property_recovery_runs VALIDATE CONSTRAINT property_recovery_runs_object_type_chk;

ALTER TABLE property_recovery_decisions DROP CONSTRAINT IF EXISTS property_recovery_decisions_object_type_chk;
ALTER TABLE property_recovery_decisions ADD CONSTRAINT property_recovery_decisions_object_type_chk
  CHECK (object_type IN ('ASSET', 'EQUIPMENT', 'SUPPLIER')) NOT VALID;
ALTER TABLE property_recovery_decisions VALIDATE CONSTRAINT property_recovery_decisions_object_type_chk;

-- Un bien porteur reste obligatoire pour les biens et équipements.
ALTER TABLE property_recovery_runs DROP CONSTRAINT IF EXISTS property_recovery_runs_asset_chk;
ALTER TABLE property_recovery_runs ADD CONSTRAINT property_recovery_runs_asset_chk
  CHECK (object_type = 'SUPPLIER' OR asset_id IS NOT NULL) NOT VALID;
ALTER TABLE property_recovery_runs VALIDATE CONSTRAINT property_recovery_runs_asset_chk;
ALTER TABLE property_recovery_decisions DROP CONSTRAINT IF EXISTS property_recovery_decisions_asset_chk;
ALTER TABLE property_recovery_decisions ADD CONSTRAINT property_recovery_decisions_asset_chk
  CHECK (object_type = 'SUPPLIER' OR asset_id IS NOT NULL) NOT VALID;
ALTER TABLE property_recovery_decisions VALIDATE CONSTRAINT property_recovery_decisions_asset_chk;

COMMENT ON COLUMN suppliers.user_field_decisions IS
  'Lot 111X : décisions de l''utilisateur PAR CHAMP (SET = saisie, CLEARED = effacement volontaire) — jamais remplacées ni réintroduites par un document.';
COMMENT ON COLUMN suppliers.field_provenance IS
  'Lot 111X : provenance du remplissage automatique de chaque champ (document, observation, fait / unité source, règle, date).';
COMMENT ON COLUMN supplier_contact_observations.origin IS
  'Lot 111X : origine de l''observation (T1_ANALYSIS, T3_SECOND_CHANCE).';
COMMENT ON COLUMN supplier_contact_observations.evidence IS
  'Lot 111X : preuves par champ observé (document, extraction, fait, unité source, confiance) ; IBAN jamais en clair.';
