-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0332 : garde d'intégrité INTERCOMPTES sur les tables de relation
-- (lot 49, ticket SEC-P0 « isolation intercomptes », §4 : « étudier des
-- contraintes d'intégrité en base pour empêcher la création de relations
-- entre comptes différents, compatibles avec le partage et la transmission »).
--
-- Une relation ORDINAIRE ne relie que des objets du même compte (AC03). Les
-- contrôles applicatifs (`services/security/account-ownership`) refusent déjà
-- toute référence étrangère ; ce déclencheur est le filet de la base : une
-- insertion — ou une modification de l'une des deux extrémités — qui
-- relierait deux comptes différents est REFUSÉE (SQLSTATE 23514,
-- « CROSS_ACCOUNT_LINK »), quel que soit le chemin (route, service,
-- traitement asynchrone, script).
--
-- Tables couvertes (extrémités contrôlées) :
--   event_documents         événement      ↔ document
--   document_suppliers      document       ↔ fournisseur
--   equipment_suppliers     équipement     ↔ fournisseur
--   asset_suppliers         bien           ↔ fournisseur
--   agenda_asset_links      élément agenda ↔ bien
--   agenda_file_links       élément agenda ↔ document
--   agenda_room_links       élément agenda ↔ pièce (sous-structure)
--   agenda_equipment_links  élément agenda ↔ équipement
-- Compte d'une pièce / d'un équipement : celui de son bien porteur.
--
-- COMPATIBILITÉ (vérifiée sur les mécanismes existants) :
--   · déplacement Duo / changement de compte d'un bien (lots 39-40,
--     `asset-account-transfer.service`) : les fiches fournisseurs sont
--     réutilisées ou copiées DANS le nouveau compte avant d'être reliées, les
--     éléments d'agenda changent de compte par UPDATE de `agenda_items` (pas
--     de leurs liens), les liens qui franchiraient les comptes sont SUPPRIMÉS
--     — aucune insertion intercomptes ;
--   · transmission (copie dans le compte du destinataire) : le bien copié et
--     ses éléments d'agenda copiés sont dans le même compte ;
--   · relations historiques incorrectes : JAMAIS touchées ni bloquantes —
--     le contrôle ne porte que sur l'INSERT et sur un UPDATE qui change une
--     extrémité (clause WHEN) ; une mise à jour d'une autre colonne (ex.
--     `source_document_id`, `is_confirmed`) ne le déclenche pas. Leur
--     recensement relève du contrôle d'exploitation « Relations
--     intercomptes » (BO › Exploitation), sans correction automatique.
--   · extrémité sans compte (bien historique sans `account_id`) : non
--     décidable → acceptée (comportement antérieur).
--
-- Colonnes portées par les objets eux-mêmes (asset_files.asset_id, events.
-- asset_id…) : NON couvertes ici — elles changent en plusieurs étapes dans la
-- transaction d'un déplacement de bien (état intermédiaire légitime) ; elles
-- sont protégées par les contrôles applicatifs et recensées par le contrôle
-- d'exploitation.
--
-- COÛT : par ligne insérée, deux lectures par clé primaire ; aucun balayage.
--
-- Idempotente : CREATE OR REPLACE FUNCTION ; DROP TRIGGER IF EXISTS puis
-- CREATE TRIGGER. Verrou SHARE ROW EXCLUSIVE bref par table, borné par
-- lock_timeout. Retour arrière : DROP TRIGGER <table>_cross_account_guard ON
-- <table> pour chaque table, puis DROP FUNCTION cross_account_link_guard()
-- et cross_account_of(text, integer).
-- ──────────────────────────────────────────────────────────────────────────────

SET LOCAL lock_timeout = '5s';

-- Compte propriétaire d'un objet (NULL : introuvable ou sans compte).
CREATE OR REPLACE FUNCTION cross_account_of(p_kind TEXT, p_id INTEGER) RETURNS INTEGER
LANGUAGE sql STABLE AS $fn$
  SELECT CASE p_kind
    WHEN 'asset'       THEN (SELECT account_id FROM assets WHERE id = p_id)
    WHEN 'file'        THEN (SELECT account_id FROM asset_files WHERE id = p_id)
    WHEN 'substructure' THEN (SELECT b.account_id FROM substructures s JOIN assets b ON b.id = s.asset_id WHERE s.id = p_id)
    WHEN 'equipment'   THEN (SELECT b.account_id FROM equipments e JOIN assets b ON b.id = e.asset_id WHERE e.id = p_id)
    WHEN 'supplier'    THEN (SELECT account_id FROM suppliers WHERE id = p_id)
    WHEN 'event'       THEN (SELECT account_id FROM events WHERE id = p_id)
    WHEN 'agenda_item' THEN (SELECT account_id FROM agenda_items WHERE id = p_id)
  END
$fn$;

-- Déclencheur commun : TG_ARGV = (type gauche, colonne gauche, type droit, colonne droite).
CREATE OR REPLACE FUNCTION cross_account_link_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_row    JSONB := to_jsonb(NEW);
  v_left   INTEGER := (v_row ->> TG_ARGV[1])::INTEGER;
  v_right  INTEGER := (v_row ->> TG_ARGV[3])::INTEGER;
  a_left   INTEGER;
  a_right  INTEGER;
BEGIN
  IF v_left IS NULL OR v_right IS NULL THEN RETURN NEW; END IF;
  -- Mise à jour sans changement d'extrémité : rien à contrôler (une relation
  -- historique incorrecte ne bloque jamais une autre écriture).
  IF TG_OP = 'UPDATE'
     AND (to_jsonb(OLD) ->> TG_ARGV[1]) IS NOT DISTINCT FROM (v_row ->> TG_ARGV[1])
     AND (to_jsonb(OLD) ->> TG_ARGV[3]) IS NOT DISTINCT FROM (v_row ->> TG_ARGV[3]) THEN
    RETURN NEW;
  END IF;
  a_left  := cross_account_of(TG_ARGV[0], v_left);
  a_right := cross_account_of(TG_ARGV[2], v_right);
  IF a_left IS NOT NULL AND a_right IS NOT NULL AND a_left <> a_right THEN
    RAISE EXCEPTION 'CROSS_ACCOUNT_LINK: % % (compte %) / % % (compte %) — relation intercomptes refusée (%)',
      TG_ARGV[0], v_left, a_left, TG_ARGV[2], v_right, a_right, TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS event_documents_cross_account_guard ON event_documents;
CREATE TRIGGER event_documents_cross_account_guard
  BEFORE INSERT OR UPDATE OF event_id, file_id ON event_documents
  FOR EACH ROW EXECUTE FUNCTION cross_account_link_guard('event', 'event_id', 'file', 'file_id');

DROP TRIGGER IF EXISTS document_suppliers_cross_account_guard ON document_suppliers;
CREATE TRIGGER document_suppliers_cross_account_guard
  BEFORE INSERT OR UPDATE OF document_id, supplier_id ON document_suppliers
  FOR EACH ROW EXECUTE FUNCTION cross_account_link_guard('file', 'document_id', 'supplier', 'supplier_id');

DROP TRIGGER IF EXISTS equipment_suppliers_cross_account_guard ON equipment_suppliers;
CREATE TRIGGER equipment_suppliers_cross_account_guard
  BEFORE INSERT OR UPDATE OF equipment_id, supplier_id ON equipment_suppliers
  FOR EACH ROW EXECUTE FUNCTION cross_account_link_guard('equipment', 'equipment_id', 'supplier', 'supplier_id');

DROP TRIGGER IF EXISTS asset_suppliers_cross_account_guard ON asset_suppliers;
CREATE TRIGGER asset_suppliers_cross_account_guard
  BEFORE INSERT OR UPDATE OF asset_id, supplier_id ON asset_suppliers
  FOR EACH ROW EXECUTE FUNCTION cross_account_link_guard('asset', 'asset_id', 'supplier', 'supplier_id');

DROP TRIGGER IF EXISTS agenda_asset_links_cross_account_guard ON agenda_asset_links;
CREATE TRIGGER agenda_asset_links_cross_account_guard
  BEFORE INSERT OR UPDATE OF agenda_item_id, asset_id ON agenda_asset_links
  FOR EACH ROW EXECUTE FUNCTION cross_account_link_guard('agenda_item', 'agenda_item_id', 'asset', 'asset_id');

DROP TRIGGER IF EXISTS agenda_file_links_cross_account_guard ON agenda_file_links;
CREATE TRIGGER agenda_file_links_cross_account_guard
  BEFORE INSERT OR UPDATE OF agenda_item_id, asset_file_id ON agenda_file_links
  FOR EACH ROW EXECUTE FUNCTION cross_account_link_guard('agenda_item', 'agenda_item_id', 'file', 'asset_file_id');

DROP TRIGGER IF EXISTS agenda_room_links_cross_account_guard ON agenda_room_links;
CREATE TRIGGER agenda_room_links_cross_account_guard
  BEFORE INSERT OR UPDATE OF agenda_item_id, substructure_id ON agenda_room_links
  FOR EACH ROW EXECUTE FUNCTION cross_account_link_guard('agenda_item', 'agenda_item_id', 'substructure', 'substructure_id');

DROP TRIGGER IF EXISTS agenda_equipment_links_cross_account_guard ON agenda_equipment_links;
CREATE TRIGGER agenda_equipment_links_cross_account_guard
  BEFORE INSERT OR UPDATE OF agenda_item_id, equipment_id ON agenda_equipment_links
  FOR EACH ROW EXECUTE FUNCTION cross_account_link_guard('agenda_item', 'agenda_item_id', 'equipment', 'equipment_id');
