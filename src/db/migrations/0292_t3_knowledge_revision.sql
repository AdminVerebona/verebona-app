-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0292 : réconciliation T3 CONTINUE — révision de connaissance par
-- compte, contexte d'évaluation des décisions réévaluables (lot 34E, tickets
-- « T3 : rendre la réconciliation globale réellement continue » et « T3 —
-- réconciliation continue des documents non résolus »).
--
-- 1. account_knowledge_changes — JOURNAL des modifications de connaissance
--    susceptibles de changer une décision T3. La RÉVISION de connaissance d'un
--    compte est le plus grand identifiant de ce journal pour ce compte
--    (séquence globale : monotone par compte, sans ligne partagée mise à
--    jour, donc sans attente ni interblocage entre écritures concurrentes).
--    Tenu par déclencheurs, quel que soit le chemin d'écriture (écran, import,
--    T1, T3, assistant, migration) :
--      ASSET        bien créé, supprimé, renommé, catégorie / sous-type,
--                   adresse, immatriculation, Informations (key_characteristics) ;
--      EQUIPMENT    équipement créé / supprimé / renommé / déplacé / archivé,
--                   fiche, marque, modèle, numéro de série ;
--      ROOM         pièce (sous-structure) créée / supprimée / renommée / fiche ;
--      ANALYSIS     nouvelle représentation T1 d'un document ;
--      FACT         fait ajouté, invalidé (superseded), cible ou valeur modifiée ;
--      LINK         rattachement / détachement / rôle / origine d'un lien
--                   document ↔ bien / équipement / pièce ;
--      DOCUMENT_LINK colonne de rattachement d'un document, retrait ou choix
--                   explicite de l'utilisateur, suppression du document ;
--      ARBITRATION  résolution d'un « À traiter ».
--    Une écriture SANS changement des colonnes suivies (statut, vignette,
--    valorisation, `updated_at` seul, réécriture identique d'un lien ou d'un
--    fait…) ne journalise rien : une écriture T3 idempotente n'invalide rien
--    (pas de boucle). Compacté à chaque cycle du balayage T3 (seule la plus
--    récente par compte et par nature est utile).
--
-- 2. document_asset_resolutions — contexte d'évaluation :
--      knowledge_revision   révision du compte LUE au début de l'évaluation ;
--      context_fingerprint  empreinte du contexte RÉELLEMENT pertinent
--                           (connaissance du document, candidats reconstruits
--                           par le Candidate Builder, versions du moteur) —
--                           jamais un hachage de la base du compte ;
--      last_evaluation      monitoring de la dernière évaluation (révisions,
--                           motif de reprise, sources testées, candidats,
--                           appel IA, action « À traiter »).
--
-- 3. t3_reconciliation_states — même contexte d'évaluation pour les autres
--    relations réévaluables (faits sans cible ↔ équipement / bien…) : version
--    du moteur, révision évaluée, empreinte, résultat, raison, date.
--
-- 4. Les déclencheurs 0274 (journal des seuls identifiants de biens) sont
--    retirés : le journal 1 les remplace (il couvre aussi noms, équipements,
--    faits, liens…). La table 0274 reste (lue par l'ancien code pendant un
--    déploiement progressif), plus alimentée.
--
-- Rattrapage des données existantes : aucun SQL ici — la version du moteur
-- DOCUMENT_ASSET passe à 3 (Candidate Builder) : le balayage horaire T3 reprend
-- PROGRESSIVEMENT toutes les abstentions (NO_CANDIDATE, ABSTAINED, MULTI_ASSET)
-- sans décision utilisateur, pages bornées, file durable, sans relancer T1.
--
-- VERROUS : tables neuves (index créés ici) ; ADD COLUMN nullables sans
-- défaut ; déclencheurs : verrou SHARE ROW EXCLUSIVE bref sur chaque table,
-- borné par lock_timeout. Idempotente : IF NOT EXISTS, CREATE OR REPLACE,
-- DROP TRIGGER IF EXISTS.
-- Retour arrière : DROP TRIGGER t3_knowledge_* sur les tables listées ;
-- DROP FUNCTION account_knowledge_changed(), account_knowledge_facts_changed() ;
-- DROP TABLE account_knowledge_changes, t3_reconciliation_states ; les
-- colonnes peuvent rester (l'ancien code les ignore).
-- ──────────────────────────────────────────────────────────────────────────────

SET LOCAL lock_timeout = '5s';

-- Pas de clé étrangère : la suppression d'un compte (cascade) déclenche aussi
-- la journalisation, qui ne doit jamais la faire échouer.
CREATE TABLE IF NOT EXISTS account_knowledge_changes (
  id          BIGSERIAL   PRIMARY KEY,
  account_id  INTEGER     NOT NULL,
  kind        TEXT        NOT NULL,
  object_type TEXT,
  object_id   BIGINT,
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS account_knowledge_changes_account_idx
  ON account_knowledge_changes (account_id, id);

COMMENT ON TABLE account_knowledge_changes IS
  'Journal T3 des modifications de connaissance (lot 34E). Révision du compte = max(id) pour ce compte.';

ALTER TABLE document_asset_resolutions ADD COLUMN IF NOT EXISTS knowledge_revision BIGINT;
ALTER TABLE document_asset_resolutions ADD COLUMN IF NOT EXISTS context_fingerprint TEXT;
ALTER TABLE document_asset_resolutions ADD COLUMN IF NOT EXISTS last_evaluation JSONB;

COMMENT ON COLUMN document_asset_resolutions.knowledge_revision IS
  'Révision de connaissance du compte lue au début de la dernière évaluation T3 (lot 34E).';
COMMENT ON COLUMN document_asset_resolutions.context_fingerprint IS
  'Empreinte du contexte pertinent de la dernière évaluation (document + candidats reconstruits + versions).';

CREATE TABLE IF NOT EXISTS t3_reconciliation_states (
  relation            TEXT        NOT NULL,
  subject_type        TEXT        NOT NULL,
  subject_id          BIGINT      NOT NULL,
  account_id          INTEGER     NOT NULL,
  engine_version      INTEGER     NOT NULL,
  knowledge_revision  BIGINT,
  context_fingerprint TEXT,
  result              TEXT        NOT NULL,
  reason              TEXT,
  detail              JSONB       NOT NULL DEFAULT '{}'::jsonb,
  runs                INTEGER     NOT NULL DEFAULT 0,
  evaluated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (relation, subject_type, subject_id)
);
CREATE INDEX IF NOT EXISTS t3_reconciliation_states_account_idx
  ON t3_reconciliation_states (account_id, relation);

-- ── Déclencheur ligne à ligne (toutes tables sauf les faits) ───────────────
-- TG_ARGV[0] = nature ; TG_ARGV[1] = 'account' si la table porte `account_id`
-- (lu directement, sans convertir la ligne : les extractions portent le texte
-- intégral du document). Sinon : bien parent (équipement, pièce), ou
-- équipement → bien (spécifications), lignes courtes converties en jsonb.
CREATE OR REPLACE FUNCTION account_knowledge_changed() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v       jsonb;
  acc     integer;
  old_acc integer;
  oid     bigint;
BEGIN
  IF TG_ARGV[1] = 'account' THEN
    IF TG_OP = 'DELETE' THEN
      EXECUTE 'SELECT ($1).account_id, ($1).id' INTO acc, oid USING OLD;
    ELSE
      EXECUTE 'SELECT ($1).account_id, ($1).id' INTO acc, oid USING NEW;
      IF TG_OP = 'UPDATE' THEN
        EXECUTE 'SELECT ($1).account_id' INTO old_acc USING OLD;
      END IF;
    END IF;
  ELSE
    IF TG_OP = 'DELETE' THEN v := to_jsonb(OLD); ELSE v := to_jsonb(NEW); END IF;
    IF TG_TABLE_NAME = 'equipment_cil_specs' THEN
      oid := NULLIF(v ->> 'equipment_id', '')::bigint;
      SELECT a.account_id INTO acc FROM equipments e JOIN assets a ON a.id = e.asset_id WHERE e.id = oid;
    ELSE
      oid := NULLIF(v ->> 'id', '')::bigint;
      SELECT a.account_id INTO acc FROM assets a WHERE a.id = NULLIF(v ->> 'asset_id', '')::integer;
    END IF;
  END IF;
  IF acc IS NOT NULL THEN
    INSERT INTO account_knowledge_changes (account_id, kind, object_type, object_id)
    VALUES (acc, TG_ARGV[0], TG_TABLE_NAME, oid);
  END IF;
  -- Objet changé de compte : l'ancien compte perd une connaissance.
  IF old_acc IS NOT NULL AND old_acc IS DISTINCT FROM acc THEN
    INSERT INTO account_knowledge_changes (account_id, kind, object_type, object_id)
    VALUES (old_acc, TG_ARGV[0], TG_TABLE_NAME, oid);
  END IF;
  RETURN NULL;
END
$fn$;

-- ── Faits : déclencheurs PAR INSTRUCTION (une analyse écrit des dizaines de
-- faits ; une ligne de journal par compte et par instruction suffit).
CREATE OR REPLACE FUNCTION account_knowledge_facts_changed() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO account_knowledge_changes (account_id, kind, object_type)
    SELECT DISTINCT n.account_id, 'FACT', 'document_facts' FROM kn_new n WHERE n.account_id IS NOT NULL;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO account_knowledge_changes (account_id, kind, object_type)
    SELECT DISTINCT o.account_id, 'FACT', 'document_facts' FROM kn_old o WHERE o.account_id IS NOT NULL;
  ELSE
    INSERT INTO account_knowledge_changes (account_id, kind, object_type)
    SELECT DISTINCT n.account_id, 'FACT', 'document_facts'
      FROM kn_new n JOIN kn_old o ON o.id = n.id
     WHERE n.account_id IS NOT NULL
       AND (o.status IS DISTINCT FROM n.status
         OR o.target_type IS DISTINCT FROM n.target_type
         OR o.target_entity_id IS DISTINCT FROM n.target_entity_id
         OR o.canonical_key IS DISTINCT FROM n.canonical_key
         OR o.normalized_value IS DISTINCT FROM n.normalized_value
         OR o.value_text IS DISTINCT FROM n.value_text);
  END IF;
  RETURN NULL;
END
$fn$;

-- ── Biens ──────────────────────────────────────────────────────────────────
-- Remplace le journal 0274 (identifiants seuls).
DROP TRIGGER IF EXISTS assets_document_asset_identifier_changes_ins_del ON assets;
DROP TRIGGER IF EXISTS assets_document_asset_identifier_changes_upd ON assets;

DROP TRIGGER IF EXISTS t3_knowledge_assets_ins_del ON assets;
CREATE TRIGGER t3_knowledge_assets_ins_del AFTER INSERT OR DELETE ON assets
  FOR EACH ROW EXECUTE FUNCTION account_knowledge_changed('ASSET', 'account');
DROP TRIGGER IF EXISTS t3_knowledge_assets_upd ON assets;
CREATE TRIGGER t3_knowledge_assets_upd
  AFTER UPDATE OF name, category, subtype, object_category, address, postal_code, city, registration_number,
                  key_characteristics, deleted_at, account_id ON assets
  FOR EACH ROW
  WHEN (OLD.name IS DISTINCT FROM NEW.name
     OR OLD.category IS DISTINCT FROM NEW.category
     OR OLD.subtype IS DISTINCT FROM NEW.subtype
     OR OLD.object_category IS DISTINCT FROM NEW.object_category
     OR OLD.address IS DISTINCT FROM NEW.address
     OR OLD.postal_code IS DISTINCT FROM NEW.postal_code
     OR OLD.city IS DISTINCT FROM NEW.city
     OR OLD.registration_number IS DISTINCT FROM NEW.registration_number
     OR OLD.key_characteristics IS DISTINCT FROM NEW.key_characteristics
     OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at
     OR OLD.account_id IS DISTINCT FROM NEW.account_id)
  EXECUTE FUNCTION account_knowledge_changed('ASSET', 'account');

-- ── Équipements, spécifications, pièces ────────────────────────────────────
DROP TRIGGER IF EXISTS t3_knowledge_equipments_ins_del ON equipments;
CREATE TRIGGER t3_knowledge_equipments_ins_del AFTER INSERT OR DELETE ON equipments
  FOR EACH ROW EXECUTE FUNCTION account_knowledge_changed('EQUIPMENT');
DROP TRIGGER IF EXISTS t3_knowledge_equipments_upd ON equipments;
CREATE TRIGGER t3_knowledge_equipments_upd
  AFTER UPDATE OF name, type, category, asset_id, substructure_id, archived_at, key_characteristics ON equipments
  FOR EACH ROW
  WHEN (OLD.name IS DISTINCT FROM NEW.name
     OR OLD.type IS DISTINCT FROM NEW.type
     OR OLD.category IS DISTINCT FROM NEW.category
     OR OLD.asset_id IS DISTINCT FROM NEW.asset_id
     OR OLD.substructure_id IS DISTINCT FROM NEW.substructure_id
     OR OLD.archived_at IS DISTINCT FROM NEW.archived_at
     OR OLD.key_characteristics IS DISTINCT FROM NEW.key_characteristics)
  EXECUTE FUNCTION account_knowledge_changed('EQUIPMENT');

DROP TRIGGER IF EXISTS t3_knowledge_equipment_specs_ins_del ON equipment_cil_specs;
CREATE TRIGGER t3_knowledge_equipment_specs_ins_del AFTER INSERT OR DELETE ON equipment_cil_specs
  FOR EACH ROW EXECUTE FUNCTION account_knowledge_changed('EQUIPMENT');
DROP TRIGGER IF EXISTS t3_knowledge_equipment_specs_upd ON equipment_cil_specs;
CREATE TRIGGER t3_knowledge_equipment_specs_upd
  AFTER UPDATE OF brand, model, serial_number ON equipment_cil_specs
  FOR EACH ROW
  WHEN (OLD.brand IS DISTINCT FROM NEW.brand OR OLD.model IS DISTINCT FROM NEW.model
     OR OLD.serial_number IS DISTINCT FROM NEW.serial_number)
  EXECUTE FUNCTION account_knowledge_changed('EQUIPMENT');

DROP TRIGGER IF EXISTS t3_knowledge_substructures_ins_del ON substructures;
CREATE TRIGGER t3_knowledge_substructures_ins_del AFTER INSERT OR DELETE ON substructures
  FOR EACH ROW EXECUTE FUNCTION account_knowledge_changed('ROOM');
DROP TRIGGER IF EXISTS t3_knowledge_substructures_upd ON substructures;
CREATE TRIGGER t3_knowledge_substructures_upd
  AFTER UPDATE OF name, asset_id, key_characteristics ON substructures
  FOR EACH ROW
  WHEN (OLD.name IS DISTINCT FROM NEW.name OR OLD.asset_id IS DISTINCT FROM NEW.asset_id
     OR OLD.key_characteristics IS DISTINCT FROM NEW.key_characteristics)
  EXECUTE FUNCTION account_knowledge_changed('ROOM');

-- ── Connaissance documentaire ──────────────────────────────────────────────
DROP TRIGGER IF EXISTS t3_knowledge_extractions_ins_del ON document_extractions;
CREATE TRIGGER t3_knowledge_extractions_ins_del AFTER INSERT OR DELETE ON document_extractions
  FOR EACH ROW EXECUTE FUNCTION account_knowledge_changed('ANALYSIS', 'account');
DROP TRIGGER IF EXISTS t3_knowledge_extractions_upd ON document_extractions;
CREATE TRIGGER t3_knowledge_extractions_upd
  AFTER UPDATE OF extracted_at, full_text, title, supplier_name, document_date ON document_extractions
  FOR EACH ROW
  WHEN (OLD.extracted_at IS DISTINCT FROM NEW.extracted_at OR OLD.full_text IS DISTINCT FROM NEW.full_text
     OR OLD.title IS DISTINCT FROM NEW.title OR OLD.supplier_name IS DISTINCT FROM NEW.supplier_name
     OR OLD.document_date IS DISTINCT FROM NEW.document_date)
  EXECUTE FUNCTION account_knowledge_changed('ANALYSIS', 'account');

DROP TRIGGER IF EXISTS t3_knowledge_facts_ins ON document_facts;
CREATE TRIGGER t3_knowledge_facts_ins AFTER INSERT ON document_facts
  REFERENCING NEW TABLE AS kn_new FOR EACH STATEMENT EXECUTE FUNCTION account_knowledge_facts_changed();
DROP TRIGGER IF EXISTS t3_knowledge_facts_upd ON document_facts;
CREATE TRIGGER t3_knowledge_facts_upd AFTER UPDATE ON document_facts
  REFERENCING OLD TABLE AS kn_old NEW TABLE AS kn_new FOR EACH STATEMENT EXECUTE FUNCTION account_knowledge_facts_changed();
DROP TRIGGER IF EXISTS t3_knowledge_facts_del ON document_facts;
CREATE TRIGGER t3_knowledge_facts_del AFTER DELETE ON document_facts
  REFERENCING OLD TABLE AS kn_old FOR EACH STATEMENT EXECUTE FUNCTION account_knowledge_facts_changed();

-- ── Rattachements et relations ─────────────────────────────────────────────
DROP TRIGGER IF EXISTS t3_knowledge_links_ins ON document_asset_links;
CREATE TRIGGER t3_knowledge_links_ins AFTER INSERT ON document_asset_links
  FOR EACH ROW EXECUTE FUNCTION account_knowledge_changed('LINK', 'account');
DROP TRIGGER IF EXISTS t3_knowledge_links_upd ON document_asset_links;
CREATE TRIGGER t3_knowledge_links_upd
  AFTER UPDATE OF status, link_role, origin, asset_id, equipment_id, substructure_id ON document_asset_links
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.link_role IS DISTINCT FROM NEW.link_role
     OR OLD.origin IS DISTINCT FROM NEW.origin OR OLD.asset_id IS DISTINCT FROM NEW.asset_id
     OR OLD.equipment_id IS DISTINCT FROM NEW.equipment_id OR OLD.substructure_id IS DISTINCT FROM NEW.substructure_id)
  EXECUTE FUNCTION account_knowledge_changed('LINK', 'account');

DROP TRIGGER IF EXISTS t3_knowledge_files_upd ON asset_files;
CREATE TRIGGER t3_knowledge_files_upd
  AFTER UPDATE OF asset_id, linked_asset_id, deleted_at, user_edited_fields ON asset_files
  FOR EACH ROW
  WHEN (OLD.asset_id IS DISTINCT FROM NEW.asset_id
     OR OLD.linked_asset_id IS DISTINCT FROM NEW.linked_asset_id
     OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at
     OR (OLD.user_edited_fields -> 'assetId') IS DISTINCT FROM (NEW.user_edited_fields -> 'assetId'))
  EXECUTE FUNCTION account_knowledge_changed('DOCUMENT_LINK', 'account');

-- ── « À traiter » résolus ──────────────────────────────────────────────────
DROP TRIGGER IF EXISTS t3_knowledge_actions_resolved ON to_process_actions;
CREATE TRIGGER t3_knowledge_actions_resolved
  AFTER UPDATE OF resolved_at ON to_process_actions
  FOR EACH ROW
  WHEN (OLD.resolved_at IS NULL AND NEW.resolved_at IS NOT NULL)
  EXECUTE FUNCTION account_knowledge_changed('ARBITRATION', 'account');
