-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0214 : informations complémentaires structurées (schéma v2).
-- CDC Exports V12 §4, §9 (DOSSIER_COMPLET-PDF-04), §10 (VENTE-PDF-05),
-- §12 (ASSURANCE_SOUSCRIPTION-PDF-05/06), §13 (ASSURANCE_SINISTRE-PDF-04/06/08,
-- RULE-001/002).
--
-- 1. `finance_json` : nouvelle sous-rubrique « Valeur et charges » du dossier
--    complet — valeur retenue (montant, origine, date), frais d'acquisition,
--    charges et taxes (liste). Objet JSON, comme les quatre autres colonnes.
--
-- 2. `schema_version` : 1 = champs simples (0213), 2 = listes structurées
--    écrites par l'application (dommages, actions et échanges du sinistre,
--    points forts de vente, protections et éléments à assurer, charges). Les
--    lignes existantes restent en version 1 : leur contenu est valide tel quel
--    (les listes sont facultatives, le texte libre reste le repli du PDF).
--
-- Les listes vivent DANS les colonnes JSONB de leur sous-rubrique
-- (`claim_json.damages`…), pas dans une table dédiée : elles sont courtes,
-- écrites en bloc avec contrôle optimiste sur `version`, figées telles quelles
-- dans le snapshot de génération, et héritent de la portée compte, des
-- cascades (bien, compte) et du déclencheur de resynchronisation du compte
-- posés par la migration 0213. Les références qu'elles contiennent (pièces,
-- photos, événements) sont des liens souples vérifiés à l'écriture et ignorés
-- à la génération si l'élément a disparu.
--
-- Idempotente : ADD COLUMN IF NOT EXISTS, DROP CONSTRAINT IF EXISTS puis
-- ADD CONSTRAINT.
-- ──────────────────────────────────────────────────────────────────────────────

ALTER TABLE asset_additional_infos ADD COLUMN IF NOT EXISTS finance_json jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE asset_additional_infos ADD COLUMN IF NOT EXISTS schema_version integer NOT NULL DEFAULT 1;

ALTER TABLE asset_additional_infos DROP CONSTRAINT IF EXISTS asset_additional_infos_json_objects_check;
ALTER TABLE asset_additional_infos ADD CONSTRAINT asset_additional_infos_json_objects_check CHECK (
  jsonb_typeof(commercial_json) = 'object'
  AND jsonb_typeof(rental_json) = 'object'
  AND jsonb_typeof(insurance_json) = 'object'
  AND jsonb_typeof(claim_json) = 'object'
  AND jsonb_typeof(finance_json) = 'object'
);

ALTER TABLE asset_additional_infos DROP CONSTRAINT IF EXISTS asset_additional_infos_schema_version_check;
ALTER TABLE asset_additional_infos ADD CONSTRAINT asset_additional_infos_schema_version_check
  CHECK (schema_version BETWEEN 1 AND 2);

COMMENT ON COLUMN asset_additional_infos.finance_json IS
  'Valeur retenue, frais d''acquisition, charges et taxes (dossier complet, section financière). Jamais l''estimation Verebona.';
COMMENT ON COLUMN asset_additional_infos.schema_version IS
  'Schéma des sous-rubriques : 1 = champs simples, 2 = listes structurées (lib/assets/additional-infos.ts).';
