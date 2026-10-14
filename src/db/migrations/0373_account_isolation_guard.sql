-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0373 : isolation des comptes — garde d'intégrité EXHAUSTIVE en base
-- (lot 54, ticket SEC-P0-CORR, SEC-02 « Intégrité PostgreSQL exhaustive »).
--
-- La migration 0332 protège huit tables de liaison (déclencheurs
-- `*_cross_account_guard`, inchangés ici). Restaient sans garde en base les
-- références DIRECTES portées par les objets eux-mêmes (document → bien,
-- événement → équipement, preuve → document…), les liaisons Sinistres /
-- Opérations, les photos, et les CHANGEMENTS DE PROPRIÉTAIRE (bien qui change
-- de compte en laissant ses données derrière lui).
--
-- RÈGLE : aucune écriture — route, service, IA, migration, SQL direct — ne
-- peut créer ni modifier une relation entre deux comptes différents. Refus :
-- SQLSTATE 23514 (check_violation), message « CROSS_ACCOUNT_LINK: … » (même
-- code que 0332, déjà traduit par les appelants). Transaction entière
-- annulée : aucune écriture partielle.
--
-- ══════════════════════════════════════════════════════════════════════════
-- 1. Références directes des objets qui CHANGENT DE COMPTE avec leur bien
--    (déplacement Duo, lot 40 ; rattrapage `asset-account-backfill`)
--
--    Déclencheur de CONTRAINTE DIFFÉRÉ (DEFERRABLE INITIALLY DEFERRED) :
--    contrôlé à la VALIDATION de la transaction, sur l'état FINAL de la ligne
--    (relue par sa clé). Un transfert légitime déplace le bien PUIS ses
--    données dans la même transaction (états intermédiaires incohérents,
--    normaux) : seul compte le résultat. Tables et colonnes — mêmes règles
--    que le contrôle d'exploitation (`detection.ts`) :
--      asset_files            compte ↔ bien, bien lié, pièce, équipement, pièce historique
--      events, deadlines      compte ↔ bien, bien lié, pièce, équipement
--      document_asset_links   compte ↔ document, bien, pièce, équipement (ACTIVE)
--      agenda_item_sources    élément d'agenda ↔ document
--      agenda_items           compte ↔ document d'origine (origin_ref asset_file)
--      field_evidence         compte ↔ bien, document source (hors WITHDRAWN)
--      document_facts         compte ↔ document (status active)
--      ai_field_updates       compte ↔ bien
--      to_process_actions     compte ↔ cible (bien, document, équipement, agenda,
--                             fournisseur ; ouvertes)
--
--    Données HISTORIQUES incorrectes : jamais bloquantes. Une mise à jour qui
--    ne change NI la référence NI le compte de la ligne ne la contrôle pas ;
--    une ligne qui change de compte n'est refusée que si une référence
--    INCHANGÉE est restée dans l'ANCIEN compte (donnée laissée derrière lors
--    d'un déplacement). Leur recensement et leur correction relèvent de BO ›
--    Exploitation › Isolation des comptes / Rattrapages.
--
-- 2. Liaisons qui ne changent PAS de compte (Opérations, Sinistres, photos)
--    Déclencheur BEFORE immédiat sur INSERT et sur la mise à jour d'une
--    extrémité (jamais sur `account_id`, déplacé par le moteur Opérations) :
--      asset_photos                                bien ↔ document
--      equipment_suppliers                         équipement ↔ document source
--      business_operation_asset_links              compte ↔ bien
--      business_operation_equipment_links          compte ↔ équipement
--      business_operation_financial_components     compte ↔ bien / équipement cible
--      business_operation_claim_details            sinistre ↔ contrat (Opération), événement historique
--      business_operation_claim_actions            sinistre ↔ facture (document), Opération enfant
--      business_operation_claim_exchanges          sinistre ↔ document
--      business_operation_claim_damage_documents   dommage (sinistre) ↔ document
--      business_operation_claim_damage_photos      dommage (sinistre) ↔ photo
--    (Les liens Opération → Opération et Opération → table fille portant
--    `account_id` sont déjà impossibles : clés composées, migration 0316.)
--
-- 3. Changement de PROPRIÉTAIRE
--      assets (UPDATE OF account_id), différé : à la validation, aucune donnée
--        de l'ANCIEN compte ne peut encore citer le bien ou son arbre (pièces,
--        équipements, pièces historiques) — le transfert légitime
--        (`transferAssetDataInTx`) les déplace ou les détache dans la même
--        transaction ; un simple UPDATE du compte, lui, est refusé.
--      equipments, substructures (UPDATE OF asset_id), différé : jamais
--        rattachés à un bien d'un autre compte.
--
-- EXCEPTIONS
--   · restauration journalisée d'une correction (BO › Rattrapages, lot 53) :
--     `SET LOCAL verebona.cross_account_restore = 'on'` (transaction seule) ;
--   · extrémité sans compte (donnée historique) : non décidable → acceptée ;
--   · rôle de réplication (`session_replication_role = replica`, réservé au
--     superutilisateur : restauration de sauvegarde) — désactive tout
--     déclencheur, comme pour 0332.
--
-- COÛT : par ligne écrite, une relecture par clé primaire et une lecture par
-- clé primaire et par référence non nulle, à la validation. Aucun balayage.
-- Les colonnes non concernées ne déclenchent rien (UPDATE OF … / WHEN).
--
-- Idempotente : CREATE OR REPLACE FUNCTION ; DROP TRIGGER IF EXISTS puis
-- CREATE (CONSTRAINT) TRIGGER. Aucune donnée existante n'est lue ni modifiée
-- (pas de validation rétroactive : le contrôle quotidien les recense).
-- Retour arrière : DROP TRIGGER IF EXISTS <table>_isolation_guard ON <table>
-- (liste ci-dessous), puis DROP FUNCTION account_isolation_guard(),
-- account_isolation_link_guard(), account_isolation_owner_guard(),
-- account_isolation_reparent_guard(), account_owner_of(text, bigint),
-- account_owner_of_ref(text, bigint).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

-- Compte propriétaire d'un objet (NULL : introuvable ou sans compte).
CREATE OR REPLACE FUNCTION account_owner_of(p_kind TEXT, p_id BIGINT) RETURNS INTEGER
LANGUAGE sql STABLE AS $fn$
  SELECT CASE p_kind
    WHEN 'account'      THEN p_id::INTEGER
    WHEN 'asset'        THEN (SELECT account_id FROM assets WHERE id = p_id)
    WHEN 'file'         THEN (SELECT account_id FROM asset_files WHERE id = p_id)
    WHEN 'substructure' THEN (SELECT b.account_id FROM substructures s JOIN assets b ON b.id = s.asset_id WHERE s.id = p_id)
    WHEN 'equipment'    THEN (SELECT b.account_id FROM equipments e JOIN assets b ON b.id = e.asset_id WHERE e.id = p_id)
    WHEN 'room'         THEN (SELECT account_id FROM rooms WHERE id = p_id)
    WHEN 'supplier'     THEN (SELECT account_id FROM suppliers WHERE id = p_id)
    WHEN 'event'        THEN (SELECT account_id FROM events WHERE id = p_id)
    WHEN 'deadline'     THEN (SELECT account_id FROM deadlines WHERE id = p_id)
    WHEN 'agenda_item'  THEN (SELECT account_id FROM agenda_items WHERE id = p_id)
    WHEN 'operation'    THEN (SELECT account_id FROM business_operations WHERE id = p_id)
    WHEN 'photo'        THEN (SELECT b.account_id FROM asset_photos p JOIN assets b ON b.id = p.asset_id WHERE p.id = p_id)
    WHEN 'damage'       THEN (SELECT o.account_id FROM business_operation_claim_damages d JOIN business_operations o ON o.id = d.operation_id WHERE d.id = p_id)
  END
$fn$;

-- Référence polymorphe (type, identifiant) → compte. Type inconnu : NULL (non décidable).
CREATE OR REPLACE FUNCTION account_owner_of_ref(p_type TEXT, p_id BIGINT) RETURNS INTEGER
LANGUAGE sql STABLE AS $fn$
  SELECT CASE
    WHEN p_type IN ('ASSET', 'asset') THEN account_owner_of('asset', p_id)
    WHEN p_type IN ('DOCUMENT', 'document', 'asset_file', 'file', 'web_link') THEN account_owner_of('file', p_id)
    WHEN p_type IN ('EQUIPMENT', 'equipment') THEN account_owner_of('equipment', p_id)
    WHEN p_type IN ('AGENDA_ITEM', 'agenda_item') THEN account_owner_of('agenda_item', p_id)
    WHEN p_type IN ('SUPPLIER', 'supplier') THEN account_owner_of('supplier', p_id)
  END
$fn$;

-- ── 1. Garde DIFFÉRÉE des références directes ────────────────────────────────
-- TG_ARGV : [0] clé primaire ; [1] propriétaire 'type:colonne' ; [2] filtre
-- SQL sur l'alias t ('' : aucun) ; [3…] références 'type:colonne' ou
-- 'poly:colonne_type:colonne_id'.
CREATE OR REPLACE FUNCTION account_isolation_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_pk         TEXT := TG_ARGV[0];
  v_owner_kind TEXT := split_part(TG_ARGV[1], ':', 1);
  v_owner_col  TEXT := split_part(TG_ARGV[1], ':', 2);
  v_filter     TEXT := NULLIF(TG_ARGV[2], '');
  v_cur        JSONB;
  v_old        JSONB;
  v_old_ok     BOOLEAN;
  v_new_row    BOOLEAN := TRUE;
  v_owner      INTEGER;
  v_old_owner  INTEGER;
  v_spec       TEXT;
  v_kind       TEXT;
  v_col        TEXT;
  v_type_col   TEXT;
  v_ref        TEXT;
  v_old_ref    TEXT;
  a_ref        INTEGER;
  i            INTEGER;
BEGIN
  IF current_setting('verebona.cross_account_restore', true) = 'on' THEN RETURN NULL; END IF;
  -- État FINAL de la ligne (contrôle à la validation) ; ligne supprimée ou
  -- hors filtre (lien retiré, preuve retirée…) : rien à contrôler.
  EXECUTE format('SELECT to_jsonb(t) FROM %I.%I t WHERE t.%I = $1::bigint AND (%s)',
                 TG_TABLE_SCHEMA, TG_TABLE_NAME, v_pk, coalesce(v_filter, 'true'))
     INTO v_cur USING (to_jsonb(NEW) ->> v_pk);
  IF v_cur IS NULL THEN RETURN NULL; END IF;
  IF (v_cur ->> v_owner_col) IS NULL OR (v_cur ->> v_owner_col) !~ '^[0-9]{1,18}$' THEN RETURN NULL; END IF;
  v_owner := account_owner_of(v_owner_kind, (v_cur ->> v_owner_col)::BIGINT);
  IF v_owner IS NULL THEN RETURN NULL; END IF;

  IF TG_OP = 'UPDATE' THEN
    v_old := to_jsonb(OLD);
    IF v_filter IS NULL THEN
      v_old_ok := TRUE;
    ELSE
      EXECUTE format('SELECT (%s) FROM jsonb_populate_record(NULL::%I.%I, $1) t', v_filter, TG_TABLE_SCHEMA, TG_TABLE_NAME)
         INTO v_old_ok USING v_old;
    END IF;
    -- Ligne réactivée (filtre faux avant) : contrôlée comme une insertion.
    v_new_row := NOT coalesce(v_old_ok, FALSE);
    IF NOT v_new_row AND (v_old ->> v_owner_col) ~ '^[0-9]{1,18}$' THEN
      v_old_owner := account_owner_of(v_owner_kind, (v_old ->> v_owner_col)::BIGINT);
    END IF;
  END IF;

  FOR i IN 3 .. TG_NARGS - 1 LOOP
    v_spec := TG_ARGV[i];
    v_kind := split_part(v_spec, ':', 1);
    IF v_kind = 'poly' THEN
      v_type_col := split_part(v_spec, ':', 2);
      v_col := split_part(v_spec, ':', 3);
    ELSE
      v_type_col := NULL;
      v_col := split_part(v_spec, ':', 2);
    END IF;
    v_ref := v_cur ->> v_col;
    CONTINUE WHEN v_ref IS NULL OR v_ref !~ '^[0-9]{1,18}$';
    IF v_type_col IS NULL THEN
      a_ref := account_owner_of(v_kind, v_ref::BIGINT);
    ELSE
      a_ref := account_owner_of_ref(v_cur ->> v_type_col, v_ref::BIGINT);
    END IF;
    CONTINUE WHEN a_ref IS NULL OR a_ref = v_owner;
    IF NOT v_new_row THEN
      v_old_ref := v_old ->> v_col;
      IF v_old_ref IS NOT DISTINCT FROM v_ref
         AND (v_type_col IS NULL OR (v_old ->> v_type_col) IS NOT DISTINCT FROM (v_cur ->> v_type_col)) THEN
        -- Référence inchangée : relation historique tolérée, SAUF si la ligne a
        -- changé de compte en laissant la référence dans l'ANCIEN compte.
        CONTINUE WHEN (v_old ->> v_owner_col) IS NOT DISTINCT FROM (v_cur ->> v_owner_col);
        CONTINUE WHEN v_old_owner IS NULL OR a_ref <> v_old_owner;
      END IF;
    END IF;
    RAISE EXCEPTION 'CROSS_ACCOUNT_LINK: %#% (compte %) -> % % (compte %) — relation intercomptes refusée (%)',
      TG_TABLE_NAME, v_cur ->> v_pk, v_owner, coalesce(v_cur ->> v_type_col, v_kind), v_ref, a_ref, v_col
      USING ERRCODE = 'check_violation';
  END LOOP;
  RETURN NULL;
END
$fn$;

DROP TRIGGER IF EXISTS asset_files_isolation_guard ON asset_files;
CREATE CONSTRAINT TRIGGER asset_files_isolation_guard
  AFTER INSERT OR UPDATE OF account_id, asset_id, linked_asset_id, substructure_id, equipment_id, linked_room_id ON asset_files
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION account_isolation_guard('id', 'account:account_id', '',
    'asset:asset_id', 'asset:linked_asset_id', 'substructure:substructure_id', 'equipment:equipment_id', 'room:linked_room_id');

DROP TRIGGER IF EXISTS events_isolation_guard ON events;
CREATE CONSTRAINT TRIGGER events_isolation_guard
  AFTER INSERT OR UPDATE OF account_id, asset_id, linked_asset_id, substructure_id, equipment_id ON events
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION account_isolation_guard('id', 'account:account_id', '',
    'asset:asset_id', 'asset:linked_asset_id', 'substructure:substructure_id', 'equipment:equipment_id');

DROP TRIGGER IF EXISTS deadlines_isolation_guard ON deadlines;
CREATE CONSTRAINT TRIGGER deadlines_isolation_guard
  AFTER INSERT OR UPDATE OF account_id, asset_id, linked_asset_id, substructure_id, equipment_id ON deadlines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION account_isolation_guard('id', 'account:account_id', '',
    'asset:asset_id', 'asset:linked_asset_id', 'substructure:substructure_id', 'equipment:equipment_id');

DROP TRIGGER IF EXISTS document_asset_links_isolation_guard ON document_asset_links;
CREATE CONSTRAINT TRIGGER document_asset_links_isolation_guard
  AFTER INSERT OR UPDATE OF account_id, file_id, asset_id, substructure_id, equipment_id, status ON document_asset_links
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION account_isolation_guard('id', 'account:account_id', 't.status = ''ACTIVE''',
    'file:file_id', 'asset:asset_id', 'substructure:substructure_id', 'equipment:equipment_id');

DROP TRIGGER IF EXISTS agenda_item_sources_isolation_guard ON agenda_item_sources;
CREATE CONSTRAINT TRIGGER agenda_item_sources_isolation_guard
  AFTER INSERT OR UPDATE OF agenda_item_id, asset_file_id ON agenda_item_sources
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION account_isolation_guard('id', 'agenda_item:agenda_item_id', '', 'file:asset_file_id');

DROP TRIGGER IF EXISTS agenda_items_isolation_guard ON agenda_items;
CREATE CONSTRAINT TRIGGER agenda_items_isolation_guard
  AFTER INSERT OR UPDATE OF account_id, origin_ref_type, origin_ref_id ON agenda_items
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION account_isolation_guard('id', 'account:account_id', 't.origin_ref_type = ''asset_file''',
    'file:origin_ref_id');

DROP TRIGGER IF EXISTS field_evidence_isolation_guard ON field_evidence;
CREATE CONSTRAINT TRIGGER field_evidence_isolation_guard
  AFTER INSERT OR UPDATE OF account_id, asset_id, source_type, source_id, lifecycle_status ON field_evidence
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION account_isolation_guard('id', 'account:account_id', 't.lifecycle_status IS DISTINCT FROM ''WITHDRAWN''',
    'asset:asset_id', 'poly:source_type:source_id');

DROP TRIGGER IF EXISTS document_facts_isolation_guard ON document_facts;
CREATE CONSTRAINT TRIGGER document_facts_isolation_guard
  AFTER INSERT OR UPDATE OF account_id, file_id, status ON document_facts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION account_isolation_guard('id', 'account:account_id', 't.status = ''active''', 'file:file_id');

DROP TRIGGER IF EXISTS ai_field_updates_isolation_guard ON ai_field_updates;
CREATE CONSTRAINT TRIGGER ai_field_updates_isolation_guard
  AFTER INSERT OR UPDATE OF account_id, asset_id ON ai_field_updates
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION account_isolation_guard('id', 'account:account_id', '', 'asset:asset_id');

DROP TRIGGER IF EXISTS to_process_actions_isolation_guard ON to_process_actions;
CREATE CONSTRAINT TRIGGER to_process_actions_isolation_guard
  AFTER INSERT OR UPDATE OF account_id, target_type, target_id, resolved_at ON to_process_actions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION account_isolation_guard('id', 'account:account_id', 't.resolved_at IS NULL',
    'poly:target_type:target_id');

-- ── 2. Garde IMMÉDIATE des liaisons qui ne changent pas de compte ────────────
-- TG_ARGV : (type gauche, colonne gauche, type droit, colonne droite).
CREATE OR REPLACE FUNCTION account_isolation_link_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_row   JSONB := to_jsonb(NEW);
  v_left  TEXT := v_row ->> TG_ARGV[1];
  v_right TEXT := v_row ->> TG_ARGV[3];
  a_left  INTEGER;
  a_right INTEGER;
BEGIN
  IF v_left IS NULL OR v_right IS NULL THEN RETURN NEW; END IF;
  IF current_setting('verebona.cross_account_restore', true) = 'on' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE'
     AND (to_jsonb(OLD) ->> TG_ARGV[1]) IS NOT DISTINCT FROM v_left
     AND (to_jsonb(OLD) ->> TG_ARGV[3]) IS NOT DISTINCT FROM v_right THEN
    RETURN NEW;
  END IF;
  a_left  := account_owner_of(TG_ARGV[0], v_left::BIGINT);
  a_right := account_owner_of(TG_ARGV[2], v_right::BIGINT);
  IF a_left IS NOT NULL AND a_right IS NOT NULL AND a_left <> a_right THEN
    RAISE EXCEPTION 'CROSS_ACCOUNT_LINK: % % (compte %) / % % (compte %) — relation intercomptes refusée (%)',
      TG_ARGV[0], v_left, a_left, TG_ARGV[2], v_right, a_right, TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS equipment_suppliers_isolation_guard ON equipment_suppliers;
CREATE TRIGGER equipment_suppliers_isolation_guard
  BEFORE INSERT OR UPDATE OF equipment_id, source_document_id ON equipment_suppliers
  FOR EACH ROW EXECUTE FUNCTION account_isolation_link_guard('equipment', 'equipment_id', 'file', 'source_document_id');

DROP TRIGGER IF EXISTS asset_photos_isolation_guard ON asset_photos;
CREATE TRIGGER asset_photos_isolation_guard
  BEFORE INSERT OR UPDATE OF asset_id, file_id ON asset_photos
  FOR EACH ROW EXECUTE FUNCTION account_isolation_link_guard('asset', 'asset_id', 'file', 'file_id');

DROP TRIGGER IF EXISTS business_operation_asset_links_isolation_guard ON business_operation_asset_links;
CREATE TRIGGER business_operation_asset_links_isolation_guard
  BEFORE INSERT OR UPDATE OF asset_id ON business_operation_asset_links
  FOR EACH ROW EXECUTE FUNCTION account_isolation_link_guard('account', 'account_id', 'asset', 'asset_id');

DROP TRIGGER IF EXISTS business_operation_equipment_links_isolation_guard ON business_operation_equipment_links;
CREATE TRIGGER business_operation_equipment_links_isolation_guard
  BEFORE INSERT OR UPDATE OF equipment_id ON business_operation_equipment_links
  FOR EACH ROW EXECUTE FUNCTION account_isolation_link_guard('account', 'account_id', 'equipment', 'equipment_id');

DROP TRIGGER IF EXISTS business_operation_financial_components_isolation_guard ON business_operation_financial_components;
CREATE TRIGGER business_operation_financial_components_isolation_guard
  BEFORE INSERT OR UPDATE OF target_asset_id ON business_operation_financial_components
  FOR EACH ROW EXECUTE FUNCTION account_isolation_link_guard('account', 'account_id', 'asset', 'target_asset_id');

DROP TRIGGER IF EXISTS business_operation_financial_components_eq_isolation_guard ON business_operation_financial_components;
CREATE TRIGGER business_operation_financial_components_eq_isolation_guard
  BEFORE INSERT OR UPDATE OF target_equipment_id ON business_operation_financial_components
  FOR EACH ROW EXECUTE FUNCTION account_isolation_link_guard('account', 'account_id', 'equipment', 'target_equipment_id');

DROP TRIGGER IF EXISTS business_operation_claim_details_isolation_guard ON business_operation_claim_details;
CREATE TRIGGER business_operation_claim_details_isolation_guard
  BEFORE INSERT OR UPDATE OF insurance_contract_operation_id ON business_operation_claim_details
  FOR EACH ROW EXECUTE FUNCTION account_isolation_link_guard('operation', 'operation_id', 'operation', 'insurance_contract_operation_id');

DROP TRIGGER IF EXISTS business_operation_claim_details_ev_isolation_guard ON business_operation_claim_details;
CREATE TRIGGER business_operation_claim_details_ev_isolation_guard
  BEFORE INSERT OR UPDATE OF history_event_id ON business_operation_claim_details
  FOR EACH ROW EXECUTE FUNCTION account_isolation_link_guard('operation', 'operation_id', 'event', 'history_event_id');

DROP TRIGGER IF EXISTS business_operation_claim_actions_isolation_guard ON business_operation_claim_actions;
CREATE TRIGGER business_operation_claim_actions_isolation_guard
  BEFORE INSERT OR UPDATE OF invoice_file_id ON business_operation_claim_actions
  FOR EACH ROW EXECUTE FUNCTION account_isolation_link_guard('operation', 'operation_id', 'file', 'invoice_file_id');

DROP TRIGGER IF EXISTS business_operation_claim_actions_child_isolation_guard ON business_operation_claim_actions;
CREATE TRIGGER business_operation_claim_actions_child_isolation_guard
  BEFORE INSERT OR UPDATE OF child_operation_id ON business_operation_claim_actions
  FOR EACH ROW EXECUTE FUNCTION account_isolation_link_guard('operation', 'operation_id', 'operation', 'child_operation_id');

DROP TRIGGER IF EXISTS business_operation_claim_exchanges_isolation_guard ON business_operation_claim_exchanges;
CREATE TRIGGER business_operation_claim_exchanges_isolation_guard
  BEFORE INSERT OR UPDATE OF document_file_id ON business_operation_claim_exchanges
  FOR EACH ROW EXECUTE FUNCTION account_isolation_link_guard('operation', 'operation_id', 'file', 'document_file_id');

DROP TRIGGER IF EXISTS business_operation_claim_damage_documents_isolation_guard ON business_operation_claim_damage_documents;
CREATE TRIGGER business_operation_claim_damage_documents_isolation_guard
  BEFORE INSERT OR UPDATE OF damage_id, file_id ON business_operation_claim_damage_documents
  FOR EACH ROW EXECUTE FUNCTION account_isolation_link_guard('damage', 'damage_id', 'file', 'file_id');

DROP TRIGGER IF EXISTS business_operation_claim_damage_photos_isolation_guard ON business_operation_claim_damage_photos;
CREATE TRIGGER business_operation_claim_damage_photos_isolation_guard
  BEFORE INSERT OR UPDATE OF damage_id, photo_id ON business_operation_claim_damage_photos
  FOR EACH ROW EXECUTE FUNCTION account_isolation_link_guard('damage', 'damage_id', 'photo', 'photo_id');

-- ── 3. Changement de PROPRIÉTAIRE ───────────────────────────────────────────
-- Bien qui change de compte : à la validation, aucune donnée de l'ANCIEN
-- compte ne cite encore le bien ni son arbre (relations NOUVELLES créées par
-- le changement de propriétaire). Les relations historiques avec un TIERS
-- compte ne sont pas concernées.
CREATE OR REPLACE FUNCTION account_isolation_owner_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_asset   INTEGER := OLD.id;
  v_from    INTEGER := OLD.account_id;
  v_now     INTEGER;
  v_where   TEXT;
BEGIN
  IF current_setting('verebona.cross_account_restore', true) = 'on' THEN RETURN NULL; END IF;
  IF v_from IS NULL THEN RETURN NULL; END IF;
  SELECT account_id INTO v_now FROM assets WHERE id = v_asset;
  IF v_now IS NULL OR v_now = v_from THEN RETURN NULL; END IF;
  v_where := CASE
    WHEN EXISTS (SELECT 1 FROM asset_files f WHERE f.account_id = v_from
                   AND (f.asset_id = v_asset OR f.linked_asset_id = v_asset
                        OR f.equipment_id IN (SELECT id FROM equipments WHERE asset_id = v_asset)
                        OR f.substructure_id IN (SELECT id FROM substructures WHERE asset_id = v_asset)
                        OR f.linked_room_id IN (SELECT id FROM rooms WHERE asset_id = v_asset)))
      THEN 'asset_files'
    WHEN EXISTS (SELECT 1 FROM events e WHERE e.account_id = v_from
                   AND (e.asset_id = v_asset OR e.linked_asset_id = v_asset
                        OR e.equipment_id IN (SELECT id FROM equipments WHERE asset_id = v_asset)
                        OR e.substructure_id IN (SELECT id FROM substructures WHERE asset_id = v_asset)))
      THEN 'events'
    WHEN EXISTS (SELECT 1 FROM deadlines d WHERE d.account_id = v_from
                   AND (d.asset_id = v_asset OR d.linked_asset_id = v_asset
                        OR d.equipment_id IN (SELECT id FROM equipments WHERE asset_id = v_asset)
                        OR d.substructure_id IN (SELECT id FROM substructures WHERE asset_id = v_asset)))
      THEN 'deadlines'
    WHEN EXISTS (SELECT 1 FROM document_asset_links l WHERE l.account_id = v_from AND l.status = 'ACTIVE'
                   AND (l.asset_id = v_asset
                        OR l.equipment_id IN (SELECT id FROM equipments WHERE asset_id = v_asset)
                        OR l.substructure_id IN (SELECT id FROM substructures WHERE asset_id = v_asset)))
      THEN 'document_asset_links'
    WHEN EXISTS (SELECT 1 FROM field_evidence fe WHERE fe.account_id = v_from AND fe.asset_id = v_asset
                   AND fe.lifecycle_status IS DISTINCT FROM 'WITHDRAWN')
      THEN 'field_evidence'
    WHEN EXISTS (SELECT 1 FROM ai_field_updates u WHERE u.account_id = v_from AND u.asset_id = v_asset)
      THEN 'ai_field_updates'
    WHEN EXISTS (SELECT 1 FROM to_process_actions t WHERE t.account_id = v_from AND t.resolved_at IS NULL
                   AND t.target_type = 'ASSET' AND t.target_id = v_asset)
      THEN 'to_process_actions'
    WHEN EXISTS (SELECT 1 FROM agenda_asset_links l JOIN agenda_items i ON i.id = l.agenda_item_id
                  WHERE i.account_id = v_from AND l.asset_id = v_asset)
      OR EXISTS (SELECT 1 FROM agenda_equipment_links l JOIN agenda_items i ON i.id = l.agenda_item_id
                  JOIN equipments e ON e.id = l.equipment_id WHERE i.account_id = v_from AND e.asset_id = v_asset)
      OR EXISTS (SELECT 1 FROM agenda_room_links l JOIN agenda_items i ON i.id = l.agenda_item_id
                  JOIN substructures s ON s.id = l.substructure_id WHERE i.account_id = v_from AND s.asset_id = v_asset)
      THEN 'agenda'
    WHEN EXISTS (SELECT 1 FROM rooms r WHERE r.asset_id = v_asset AND r.account_id = v_from)
      THEN 'rooms'
  END;
  IF v_where IS NOT NULL THEN
    RAISE EXCEPTION 'CROSS_ACCOUNT_LINK: assets#% passé du compte % au compte % en laissant des données (%) dans l''ancien compte — changement de propriétaire refusé',
      v_asset, v_from, v_now, v_where
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$fn$;

DROP TRIGGER IF EXISTS assets_isolation_owner_guard ON assets;
CREATE CONSTRAINT TRIGGER assets_isolation_owner_guard
  AFTER UPDATE OF account_id ON assets
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (OLD.account_id IS NOT NULL AND NEW.account_id IS DISTINCT FROM OLD.account_id)
  EXECUTE FUNCTION account_isolation_owner_guard();

-- Pièce / équipement rattaché à un bien d'un AUTRE compte : refusé.
CREATE OR REPLACE FUNCTION account_isolation_reparent_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_cur   INTEGER;
  a_old   INTEGER;
  a_new   INTEGER;
BEGIN
  IF current_setting('verebona.cross_account_restore', true) = 'on' THEN RETURN NULL; END IF;
  EXECUTE format('SELECT asset_id FROM %I.%I WHERE id = $1', TG_TABLE_SCHEMA, TG_TABLE_NAME) INTO v_cur USING OLD.id;
  IF v_cur IS NULL OR v_cur = OLD.asset_id THEN RETURN NULL; END IF;
  a_old := account_owner_of('asset', OLD.asset_id);
  a_new := account_owner_of('asset', v_cur);
  IF a_old IS NOT NULL AND a_new IS NOT NULL AND a_old <> a_new THEN
    RAISE EXCEPTION 'CROSS_ACCOUNT_LINK: %#% rattaché(e) au bien % (compte %) depuis le bien % (compte %) — relation intercomptes refusée',
      TG_TABLE_NAME, OLD.id, v_cur, a_new, OLD.asset_id, a_old
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$fn$;

DROP TRIGGER IF EXISTS equipments_isolation_guard ON equipments;
CREATE CONSTRAINT TRIGGER equipments_isolation_guard
  AFTER UPDATE OF asset_id ON equipments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW.asset_id IS DISTINCT FROM OLD.asset_id)
  EXECUTE FUNCTION account_isolation_reparent_guard();

DROP TRIGGER IF EXISTS substructures_isolation_guard ON substructures;
CREATE CONSTRAINT TRIGGER substructures_isolation_guard
  AFTER UPDATE OF asset_id ON substructures
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW.asset_id IS DISTINCT FROM OLD.asset_id)
  EXECUTE FUNCTION account_isolation_reparent_guard();
