-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0213 : informations complémentaires de la fiche bien + codes V12.
-- CDC Exports V12 §1.2, §4 (IC-GEN-001..010), §16.1, DEC-007, EXP-001, EXP-002.
--
-- 1. Table `asset_additional_infos` : une ligne par bien, sous-rubriques en
--    JSONB (montants en centimes, dates ISO). Définition des champs :
--    `src/lib/assets/additional-infos.ts`.
--      - asset_id   : clé primaire ET clé étrangère, ON DELETE CASCADE —
--                     la suppression d'un bien (asset-deletion.service) emporte
--                     la ligne ;
--      - account_id : compte propriétaire, ON DELETE CASCADE — la purge d'un
--                     compte (scheduled-deletion.service) l'emporte aussi, et
--                     le contrôle d'orphelins (`account_id`) la couvre ;
--      - updated_by : auteur de la dernière modification (titulaire ou
--                     co-titulaire Duo), SET NULL si l'utilisateur disparaît :
--                     le contenu suit le bien, pas la personne.
--    Un déclencheur garde `account_id` aligné sur `assets.account_id` si un
--    bien change de compte : sans lui, la purge de l'ancien compte emporterait
--    les informations d'un bien qui ne lui appartient plus.
--
-- 2. Renommage des anciens codes d'export vers les six codes V12 (catalog.ts,
--    LEGACY_EXPORT_CODE_MAP) dans les trois colonnes qui les stockent :
--      export_generation.export_type, export_templates.export_type,
--      document_type_export_associations.export_type.
--    SAV_GARANTIE, AUTRE et EXPORT_BRUT ne sont pas touchés. Les colonnes
--    `export_templates.code` (identifiants de modèle, uniques) ne sont pas
--    renommées. La colonne `export_templates.pdfmonkey_template_id` est
--    CONSERVÉE (MIG-06) : elle n'est simplement plus lue.
--
-- Idempotente : IF NOT EXISTS, CREATE OR REPLACE, DROP ... IF EXISTS, et des
-- UPDATE qui ne trouvent plus rien à la seconde exécution.
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS asset_additional_infos (
  asset_id        integer     PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
  account_id      integer     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  commercial_json jsonb       NOT NULL DEFAULT '{}'::jsonb,
  rental_json     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  insurance_json  jsonb       NOT NULL DEFAULT '{}'::jsonb,
  claim_json      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  version         integer     NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      integer     REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT asset_additional_infos_json_objects_check CHECK (
    jsonb_typeof(commercial_json) = 'object'
    AND jsonb_typeof(rental_json) = 'object'
    AND jsonb_typeof(insurance_json) = 'object'
    AND jsonb_typeof(claim_json) = 'object'
  )
);

-- Table créée par `drizzle-kit push` avant cette migration : sous-rubrique
-- sinistre ajoutée si absente.
ALTER TABLE asset_additional_infos ADD COLUMN IF NOT EXISTS claim_json jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS asset_additional_infos_account_id_idx
  ON asset_additional_infos (account_id);

CREATE OR REPLACE FUNCTION asset_additional_infos_sync_account() RETURNS trigger AS $$
BEGIN
  IF NEW.account_id IS NOT NULL AND NEW.account_id IS DISTINCT FROM OLD.account_id THEN
    UPDATE asset_additional_infos SET account_id = NEW.account_id WHERE asset_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS asset_additional_infos_sync_account_trg ON assets;
CREATE TRIGGER asset_additional_infos_sync_account_trg
  AFTER UPDATE OF account_id ON assets
  FOR EACH ROW EXECUTE FUNCTION asset_additional_infos_sync_account();

-- ── Codes d'export V12 ───────────────────────────────────────────────────────

UPDATE export_generation SET export_type = CASE export_type
    WHEN 'CIL_REGLEMENTAIRE'       THEN 'CIL'
    WHEN 'DOSSIER_VENTE'           THEN 'VENTE'
    WHEN 'DOSSIER_REVENTE'         THEN 'VENTE'
    WHEN 'REVENTE'                 THEN 'VENTE'
    WHEN 'ASSURANCE_ESTIMATION'    THEN 'ASSURANCE_SOUSCRIPTION'
    WHEN 'ASSURANCE_DEVIS'         THEN 'ASSURANCE_SOUSCRIPTION'
    WHEN 'ASSURANCE_INDEMNISATION' THEN 'ASSURANCE_SINISTRE'
  END
 WHERE export_type IN ('CIL_REGLEMENTAIRE', 'DOSSIER_VENTE', 'DOSSIER_REVENTE', 'REVENTE',
                       'ASSURANCE_ESTIMATION', 'ASSURANCE_DEVIS', 'ASSURANCE_INDEMNISATION');

UPDATE export_templates SET export_type = CASE export_type
    WHEN 'CIL_REGLEMENTAIRE'       THEN 'CIL'
    WHEN 'DOSSIER_VENTE'           THEN 'VENTE'
    WHEN 'DOSSIER_REVENTE'         THEN 'VENTE'
    WHEN 'REVENTE'                 THEN 'VENTE'
    WHEN 'ASSURANCE_ESTIMATION'    THEN 'ASSURANCE_SOUSCRIPTION'
    WHEN 'ASSURANCE_DEVIS'         THEN 'ASSURANCE_SOUSCRIPTION'
    WHEN 'ASSURANCE_INDEMNISATION' THEN 'ASSURANCE_SINISTRE'
  END
 WHERE export_type IN ('CIL_REGLEMENTAIRE', 'DOSSIER_VENTE', 'DOSSIER_REVENTE', 'REVENTE',
                       'ASSURANCE_ESTIMATION', 'ASSURANCE_DEVIS', 'ASSURANCE_INDEMNISATION');

UPDATE document_type_export_associations SET export_type = CASE export_type
    WHEN 'CIL_REGLEMENTAIRE'       THEN 'CIL'
    WHEN 'DOSSIER_VENTE'           THEN 'VENTE'
    WHEN 'DOSSIER_REVENTE'         THEN 'VENTE'
    WHEN 'REVENTE'                 THEN 'VENTE'
    WHEN 'ASSURANCE_ESTIMATION'    THEN 'ASSURANCE_SOUSCRIPTION'
    WHEN 'ASSURANCE_DEVIS'         THEN 'ASSURANCE_SOUSCRIPTION'
    WHEN 'ASSURANCE_INDEMNISATION' THEN 'ASSURANCE_SINISTRE'
  END
 WHERE export_type IN ('CIL_REGLEMENTAIRE', 'DOSSIER_VENTE', 'DOSSIER_REVENTE', 'REVENTE',
                       'ASSURANCE_ESTIMATION', 'ASSURANCE_DEVIS', 'ASSURANCE_INDEMNISATION');

COMMENT ON COLUMN export_templates.export_type IS
  'Code dossier V12 : CIL, DOSSIER_COMPLET, VENTE, LOCATION, ASSURANCE_SOUSCRIPTION, ASSURANCE_SINISTRE (ou EXPORT_BRUT, SAV_GARANTIE, AUTRE)';
COMMENT ON COLUMN export_templates.pdfmonkey_template_id IS
  'Legacy PDFMonkey (DEC-001, MIG-06) : conservée, plus lue par l''application.';
