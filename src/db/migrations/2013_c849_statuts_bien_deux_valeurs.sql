-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 2013 : statuts d'un bien — DEUX valeurs (carte Trello #849,
-- arbitrages PO du 25/11/2026) : EN_SERVICE et TRANSMIS, rien d'autre.
--
-- VENDU et ARCHIVED (0278, lot 32) sont retirés du référentiel métier. La
-- vente reste une Opération de cession (date / prix / justificatifs si
-- connus), sans statut distinct ; aucun bouton Archiver.
--
-- 1. Déclencheur `assets_operations_data_touch` : un passage VENDU / ARCHIVED
--    / DETRUIT → TRANSMIS (cette conversion) CONSERVE `status_changed_at` —
--    aucune fausse date de sortie n'est fabriquée ; tout autre changement de
--    statut la date comme avant. À la création, seul TRANSMIS est daté.
-- 2. TRACE idempotente, AVANT conversion, dans le journal existant des
--    écritures de la fiche (`canonical_field_writes`, origine SYSTEM_RULE,
--    source MIGRATION `2013_c849_statuts_bien`) : ancien statut, ancien
--    `archived_reason`, ancienne date de statut. Une seule trace par bien
--    (NOT EXISTS) : rejouable sans doublon. Bien sans compte (historique) :
--    converti sans trace (le journal exige un compte).
-- 3. Conversion VENDU, ARCHIVED, DETRUIT → TRANSMIS. Rien d'autre n'est
--    touché : `archived_reason`, `key_characteristics` (date et prix de vente
--    `saleDate` / `salePrice`), documents, historiques et `updated_at` restent
--    tels quels. AUCUN destinataire, acte de transmission, événement, date ou
--    notification n'est créé (un ancien ARCHIVED converti n'établit pas de
--    cession : `assetDataFacts`, drapeau `c849_legacy_archived`).
-- 4. Contrainte `assets_status_check` = EN_SERVICE, TRANSMIS (même liste que
--    `src/lib/asset-status.ts`). Posée NOT VALID puis validée.
--
-- Recensement avant / après (exploitation) :
--   SELECT status, count(*) FROM assets GROUP BY 1 ORDER BY 1;
--   SELECT old_value->>'status' AS ancien, count(*) FROM canonical_field_writes
--    WHERE source_type = 'MIGRATION' AND source_id = '2013_c849_statuts_bien' GROUP BY 1;
--
-- Retour arrière (documenté, manuel) :
--   ALTER TABLE assets DROP CONSTRAINT IF EXISTS assets_status_check;
--   UPDATE assets a SET status = w.old_value->>'status'
--     FROM canonical_field_writes w
--    WHERE w.asset_id = a.id AND w.source_type = 'MIGRATION' AND w.source_id = '2013_c849_statuts_bien'
--      AND a.status = 'TRANSMIS' AND w.old_value->>'status' IN ('VENDU', 'ARCHIVED');
--   ALTER TABLE assets ADD CONSTRAINT assets_status_check
--     CHECK (status IN ('EN_SERVICE', 'VENDU', 'TRANSMIS', 'ARCHIVED')) NOT VALID;
--   (puis redéployer le code antérieur ; les anciens DETRUIT restent ARCHIVED, comme après 0278.)
-- Idempotente : fonction remplacée, trace conditionnelle, conversions ciblées,
-- contrainte supprimée / recréée.
-- ──────────────────────────────────────────────────────────────────────────────

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION assets_operations_data_touch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IN ('VENDU', 'TRANSMIS') AND NEW.status_changed_at IS NULL THEN
      NEW.status_changed_at := now();
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status IN ('VENDU', 'ARCHIVED', 'DETRUIT') AND NEW.status = 'TRANSMIS') THEN
    NEW.status_changed_at := now();
  END IF;
  NEW.operations_data_changed_at := now();
  RETURN NEW;
END;
$$;

INSERT INTO canonical_field_writes
  (account_id, asset_id, canonical_key, old_value, new_value, origin, source_type, source_id, outcome, dry_run, created_at)
SELECT a.account_id, a.id, 'status',
       jsonb_build_object('status', a.status, 'archivedReason', a.archived_reason, 'statusChangedAt', a.status_changed_at),
       to_jsonb('TRANSMIS'::text), 'SYSTEM_RULE', 'MIGRATION', '2013_c849_statuts_bien', 'written', false, now()
  FROM assets a
 WHERE a.status IN ('VENDU', 'ARCHIVED', 'DETRUIT')
   AND a.account_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM canonical_field_writes w
                    WHERE w.asset_id = a.id AND w.source_type = 'MIGRATION' AND w.source_id = '2013_c849_statuts_bien');

ALTER TABLE assets DROP CONSTRAINT IF EXISTS assets_status_check;

UPDATE assets SET status = 'TRANSMIS' WHERE status IN ('VENDU', 'ARCHIVED', 'DETRUIT');

UPDATE assets SET status = 'EN_SERVICE' WHERE status IS NULL OR status NOT IN ('EN_SERVICE', 'TRANSMIS');

ALTER TABLE assets
  ADD CONSTRAINT assets_status_check
    CHECK (status IN ('EN_SERVICE', 'TRANSMIS')) NOT VALID;

ALTER TABLE assets VALIDATE CONSTRAINT assets_status_check;
