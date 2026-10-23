-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0652 : rôle PRINCIPAL / lié d'un élément d'agenda dans son
-- Opération, et intégrité Opération ↔ AgendaItem du même compte
-- (lot 82, chantier 82D — CDC « Opérations, Agenda, Timeline, Sinistres v5 »,
-- lot O-1 : §4.3, §6.1, §11, §27.2, §28 ; E04, E26).
--
--   agenda_items.operation_role         'PRINCIPAL' | 'RELATED' ; NULL quand
--     l'élément n'appartient à aucune Opération. Terme STRICTEMENT interne
--     (jamais affiché, P1). Au plus UN principal par Opération : index unique
--     partiel `agenda_items_operation_principal_uidx` (0652_…_idx_1).
--   agenda_items.operation_role_origin  qui a posé le rôle : T4 (projection
--     Agenda, décision de représentation — V-Q5), USER (geste utilisateur),
--     T3 (consolidation), SYSTEM (reprise déterministe, dont cette migration).
--     NULL : chemin historique sans origine connue.
--
-- DÉCLENCHEUR `agenda_items_operation_role_sync` (filet de la base, quel que
-- soit le chemin d'écriture) : élément détaché → rôle effacé ; élément
-- rattaché sans rôle → RELATED ; élément DÉPLACÉ d'une Opération à une autre
-- hors du service de regroupement → RELATED (jamais un principal hérité). Le
-- service unique de regroupement (`business-operations/grouping`) signale
-- ses écritures par le réglage de transaction `verebona.grouping_write = on`
-- (posé avec le verrou du compte) : son rôle explicite est alors conservé.
-- Le rôle PRINCIPAL n'est jamais déduit par la base : il est posé par ce
-- service sur décision T4 ou utilisateur.
--
-- REPRISE DÉTERMINISTE (aucune décision nouvelle) : sous l'ancien modèle
-- « une Opération = un emplacement d'agenda », l'élément retenu par la
-- projection T4 pour une Opération d'ÉVÉNEMENT (INTERVENTION, CLAIM,
-- ACQUISITION, DISPOSAL — table C16) représente l'événement global : il
-- devient PRINCIPAL, avec le même ordre que la projection (`principal()` de
-- `agenda-projection/model.ts` : saisi avant projeté, touché avant intact,
-- plus ancien). Une échéance de contrat (CONTRACT:END) ou un type non projeté
-- n'a pas de principal (§11.10 : une relation durable n'impose pas
-- d'événement global). Les autres éléments liés deviennent RELATED.
--
-- INTÉGRITÉ COMPTE (E26) : clé étrangère COMPOSÉE
--   (business_operation_id, account_id) → business_operations (id, account_id)
-- DIFFÉRÉE (vérifiée à la validation de la transaction : le déplacement d'un
-- bien entre comptes déplace Opérations et éléments en plusieurs étapes et
-- détache les liens intercomptes avant validation — `asset-account-transfer`
-- étape 9). Aucune action de suppression propre : une Opération n'est jamais
-- supprimée physiquement (hors suppression du compte, où les éléments
-- partent aussi) et l'ancienne clé met déjà la colonne à NULL (syntaxe
-- « SET NULL (colonne) » évitée : PostgreSQL 15+). Posée NOT VALID, validée
-- par 0653. AVANT : les liens intercomptes historiques sont
-- détachés (réparation certaine : un élément ne peut pas appartenir à une
-- Opération d'un autre compte ; l'élément lui-même est conservé).
-- L'ancienne clé `agenda_items_business_operation_fk` est conservée (additif).
--
-- Colonnes nullables sans défaut : ajout instantané. Idempotente (IF NOT
-- EXISTS, CREATE OR REPLACE, reprise limitée aux lignes sans rôle).
-- Retour arrière : DROP TRIGGER agenda_items_operation_role_sync ON
-- agenda_items ; DROP FUNCTION agenda_items_operation_role_sync() ; ALTER
-- TABLE agenda_items DROP CONSTRAINT agenda_items_business_operation_account_fk,
-- DROP COLUMN operation_role, DROP COLUMN operation_role_origin.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE agenda_items ADD COLUMN IF NOT EXISTS operation_role TEXT;
ALTER TABLE agenda_items ADD COLUMN IF NOT EXISTS operation_role_origin TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agenda_items_operation_role_check' AND conrelid = 'agenda_items'::regclass) THEN
    ALTER TABLE agenda_items ADD CONSTRAINT agenda_items_operation_role_check
      CHECK (operation_role IS NULL OR operation_role IN ('PRINCIPAL', 'RELATED')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agenda_items_operation_role_origin_check' AND conrelid = 'agenda_items'::regclass) THEN
    ALTER TABLE agenda_items ADD CONSTRAINT agenda_items_operation_role_origin_check
      CHECK (operation_role_origin IS NULL OR operation_role_origin IN ('T4', 'USER', 'T3', 'SYSTEM')) NOT VALID;
  END IF;
END $$;

-- Filet : rôle toujours cohérent avec l'appartenance.
CREATE OR REPLACE FUNCTION agenda_items_operation_role_sync() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.business_operation_id IS NULL THEN
    NEW.operation_role := NULL;
    NEW.operation_role_origin := NULL;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.business_operation_id IS DISTINCT FROM NEW.business_operation_id
     AND COALESCE(current_setting('verebona.grouping_write', true), '') <> 'on' THEN
    -- Déplacement par un chemin qui n'est pas le service de regroupement :
    -- jamais un principal hérité d'une autre Opération.
    NEW.operation_role := 'RELATED';
    NEW.operation_role_origin := NULL;
  END IF;
  IF NEW.operation_role IS NULL THEN
    NEW.operation_role := 'RELATED';
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS agenda_items_operation_role_sync ON agenda_items;
CREATE TRIGGER agenda_items_operation_role_sync
  BEFORE INSERT OR UPDATE OF business_operation_id, operation_role, operation_role_origin ON agenda_items
  FOR EACH ROW EXECUTE FUNCTION agenda_items_operation_role_sync();

-- Réparation certaine avant la clé composée : aucun élément lié à une Opération d'un autre compte.
UPDATE agenda_items ai SET business_operation_id = NULL, updated_at = now()
  FROM business_operations o
 WHERE o.id = ai.business_operation_id AND o.account_id <> ai.account_id;

-- Reprise des rôles (lignes liées sans rôle seulement : rejouable sans effet).
WITH lies AS (
  SELECT ai.id, ai.business_operation_id AS op, o.type_code,
         row_number() OVER (
           PARTITION BY ai.business_operation_id
           ORDER BY (ai.projection_origin IS NOT NULL),
                    (NOT ai.is_automatic OR COALESCE(ai.is_automatic_modified, false) OR COALESCE(ai.manual_status, '') <> '') DESC,
                    ai.id) AS rang,
         bool_or(ai.operation_role = 'PRINCIPAL') OVER (PARTITION BY ai.business_operation_id) AS deja
    FROM agenda_items ai JOIN business_operations o ON o.id = ai.business_operation_id AND o.account_id = ai.account_id
   WHERE ai.business_operation_id IS NOT NULL
)
UPDATE agenda_items ai
   SET operation_role = CASE WHEN l.rang = 1 AND NOT COALESCE(l.deja, false)
                              AND l.type_code IN ('INTERVENTION', 'CLAIM', 'ACQUISITION', 'DISPOSAL')
                             THEN 'PRINCIPAL' ELSE 'RELATED' END,
       operation_role_origin = 'SYSTEM'
  FROM lies l
 WHERE ai.id = l.id AND ai.operation_role IS NULL;

DO $$
BEGIN
  -- Clé posée autrement (schéma matérialisé sans report de vérification) : reposée différée.
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agenda_items_business_operation_account_fk' AND conrelid = 'agenda_items'::regclass
              AND NOT (condeferrable AND condeferred)) THEN
    ALTER TABLE agenda_items DROP CONSTRAINT agenda_items_business_operation_account_fk;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agenda_items_business_operation_account_fk' AND conrelid = 'agenda_items'::regclass) THEN
    ALTER TABLE agenda_items ADD CONSTRAINT agenda_items_business_operation_account_fk
      FOREIGN KEY (business_operation_id, account_id) REFERENCES business_operations (id, account_id)
      DEFERRABLE INITIALLY DEFERRED NOT VALID;
  END IF;
END $$;
