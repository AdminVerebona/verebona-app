-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0221 (déclencheur) : liens LEGACY_COLUMN tenus depuis asset_files
-- (CDC 15 X-01, plan D-11 « trigger SQL depuis asset_files, puis écriture
-- directe »).
--
-- `document_asset_links_sync_file(file_id)` recalcule, pour UN document, les
-- liens reflétant ses colonnes historiques :
--   · asset_id        → bien, PRIMARY ;
--   · linked_asset_id → bien, PRIMARY si asset_id est vide, SECONDARY sinon
--                       (ignoré s'il égale asset_id) ;
--   · linked_room_id  → pièce (et son bien), SECONDARY (PRIMARY si seul lien) ;
--   · equipment_id    → équipement (et son bien), SECONDARY (idem).
-- Document supprimé (deleted_at, y compris source secondaire regroupée) ou
-- ligne disparue : plus aucune cible.
--
-- Règles :
--   · seuls les liens origin = 'LEGACY_COLUMN' sont retirés ou requalifiés ;
--     un lien USER, AI ou MIGRATION n'est JAMAIS modifié ;
--   · une cible déjà liée ACTIVE (quelle que soit l'origine) n'est pas
--     dupliquée ;
--   · un retrait passe le lien en REMOVED (removed_at), jamais de DELETE.
-- La même fonction sert au rattrapage §14.8 (idempotente).
--
-- COÛT (mesuré au lot 13, PostgreSQL 16 local, table de 400 000 documents) :
--   · insertion unitaire : ~0,1 à 0,7 ms de plus par document ; en masse,
--     200 000 insertions 39 s au lieu de 12 s (+0,14 ms/ligne) ;
--   · rattachement modifié : 10 000 déplacements 2,5 s au lieu de 0,7 s,
--     dans UNE transaction, sans sous-transaction ;
--   · mise à jour hors rattachement (état d'analyse, titre…) : aucun coût,
--     le déclencheur ne se déclenche pas.
-- Le déclencheur ne travaille que sur la ligne modifiée —
-- une lecture de asset_files par clé primaire, au plus une de rooms et une
-- d'equipments par clé primaire, puis 2 à 3 instructions sur
-- document_asset_links servies par l'index unique partiel (file_id en tête).
-- Aucun balayage. Le déclencheur UPDATE ne se déclenche que si l'une des
-- cinq colonnes CHANGE (clause WHEN) : les mises à jour fréquentes d'état
-- d'analyse, de classement ou de titre ne le sollicitent pas.
--
-- SÛRETÉ SANS BLOC D'EXCEPTION : un bloc EXCEPTION ouvrirait une
-- sous-transaction par ligne — au-delà de 64 dans une même transaction
-- (déplacement en masse, suppression d'un bien ou d'un compte), les
-- instantanés se dégradent. Les conditions d'échec sont donc TESTÉES avant
-- d'écrire, et aucune erreur n'est attendue en fonctionnement normal :
--   · document sans compte : aucune écriture ;
--   · bien, pièce ou équipement introuvable ou d'un AUTRE compte : cible
--     ignorée (le rattrapage le signale) ;
--   · doublon concurrent (deux transactions sur le même document) :
--     ON CONFLICT DO NOTHING.
-- Aucun filet résiduel n'est nécessaire : la seule erreur restante serait
-- une clé étrangère supprimée entre le contrôle et l'écriture, or supprimer
-- le bien, la pièce ou le document supprime aussi le document ou le lien par
-- cascade (et l'équipement met la colonne à NULL, ce qui relance la
-- synchronisation).
--
-- Idempotente : CREATE OR REPLACE FUNCTION ; DROP TRIGGER IF EXISTS puis
-- CREATE TRIGGER (CREATE OR REPLACE TRIGGER exige PostgreSQL 14). Verrou
-- SHARE ROW EXCLUSIVE bref sur asset_files, borné par lock_timeout.
-- ──────────────────────────────────────────────────────────────────────────────

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION document_asset_links_sync_file(p_file_id INTEGER) RETURNS VOID
LANGUAGE plpgsql AS $fn$
DECLARE
  f          RECORD;
  v_room     RECORD;
  v_equip    RECORD;
  a_assets   INTEGER[] := '{}';
  a_rooms    INTEGER[] := '{}';
  a_equips   INTEGER[] := '{}';
  a_roles    TEXT[]    := '{}';
BEGIN
  SELECT id, account_id, asset_id, linked_asset_id, linked_room_id, equipment_id, deleted_at
    INTO f FROM asset_files WHERE id = p_file_id;

  IF FOUND AND f.deleted_at IS NULL AND f.account_id IS NOT NULL THEN
    IF f.asset_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM assets a WHERE a.id = f.asset_id AND a.account_id = f.account_id) THEN
      a_assets := a_assets || f.asset_id; a_rooms := a_rooms || NULL::INTEGER;
      a_equips := a_equips || NULL::INTEGER; a_roles := a_roles || 'PRIMARY'::TEXT;
    END IF;
    IF f.linked_asset_id IS NOT NULL AND f.linked_asset_id IS DISTINCT FROM f.asset_id
       AND EXISTS (SELECT 1 FROM assets a WHERE a.id = f.linked_asset_id AND a.account_id = f.account_id) THEN
      a_assets := a_assets || f.linked_asset_id; a_rooms := a_rooms || NULL::INTEGER;
      a_equips := a_equips || NULL::INTEGER;
      a_roles := a_roles || (CASE WHEN cardinality(a_roles) = 0 THEN 'PRIMARY' ELSE 'SECONDARY' END)::TEXT;
    END IF;
    IF f.linked_room_id IS NOT NULL THEN
      SELECT r.id, r.asset_id INTO v_room
        FROM rooms r JOIN assets a ON a.id = r.asset_id
       WHERE r.id = f.linked_room_id AND a.account_id = f.account_id;
      IF FOUND THEN
        a_assets := a_assets || v_room.asset_id; a_rooms := a_rooms || v_room.id;
        a_equips := a_equips || NULL::INTEGER;
        a_roles := a_roles || (CASE WHEN cardinality(a_roles) = 0 THEN 'PRIMARY' ELSE 'SECONDARY' END)::TEXT;
      END IF;
    END IF;
    IF f.equipment_id IS NOT NULL THEN
      SELECT e.id, e.asset_id INTO v_equip
        FROM equipments e JOIN assets a ON a.id = e.asset_id
       WHERE e.id = f.equipment_id AND a.account_id = f.account_id;
      IF FOUND THEN
        a_assets := a_assets || v_equip.asset_id; a_rooms := a_rooms || NULL::INTEGER;
        a_equips := a_equips || v_equip.id;
        a_roles := a_roles || (CASE WHEN cardinality(a_roles) = 0 THEN 'PRIMARY' ELSE 'SECONDARY' END)::TEXT;
      END IF;
    END IF;
  END IF;

  -- 1. Liens LEGACY_COLUMN qui ne reflètent plus les colonnes : retirés.
  UPDATE document_asset_links l
     SET status = 'REMOVED', removed_at = now(), updated_at = now()
   WHERE l.file_id = p_file_id AND l.status = 'ACTIVE' AND l.origin = 'LEGACY_COLUMN'
     AND NOT EXISTS (
       SELECT 1 FROM unnest(a_assets, a_rooms, a_equips) AS w(asset_id, room_id, equipment_id)
        WHERE COALESCE(w.asset_id, 0) = COALESCE(l.asset_id, 0)
          AND COALESCE(w.room_id, 0) = COALESCE(l.room_id, 0)
          AND COALESCE(w.equipment_id, 0) = COALESCE(l.equipment_id, 0));

  IF cardinality(a_roles) = 0 THEN RETURN; END IF;

  -- 2. Rôle d'un lien LEGACY_COLUMN existant ajusté (ex. linked_asset_id
  --    devenu seul lien → PRIMARY).
  UPDATE document_asset_links l
     SET link_role = w.link_role, updated_at = now()
    FROM unnest(a_assets, a_rooms, a_equips, a_roles) AS w(asset_id, room_id, equipment_id, link_role)
   WHERE l.file_id = p_file_id AND l.status = 'ACTIVE' AND l.origin = 'LEGACY_COLUMN'
     AND COALESCE(w.asset_id, 0) = COALESCE(l.asset_id, 0)
     AND COALESCE(w.room_id, 0) = COALESCE(l.room_id, 0)
     AND COALESCE(w.equipment_id, 0) = COALESCE(l.equipment_id, 0)
     AND l.link_role <> w.link_role;

  -- 3. Cibles sans lien ACTIF (toutes origines confondues) : lien LEGACY_COLUMN.
  INSERT INTO document_asset_links (account_id, file_id, asset_id, room_id, equipment_id, link_role, origin, confidence, status)
  SELECT f.account_id, p_file_id, w.asset_id, w.room_id, w.equipment_id, w.link_role, 'LEGACY_COLUMN', 1, 'ACTIVE'
    FROM unnest(a_assets, a_rooms, a_equips, a_roles) AS w(asset_id, room_id, equipment_id, link_role)
   WHERE NOT EXISTS (
     SELECT 1 FROM document_asset_links l
      WHERE l.file_id = p_file_id AND l.status = 'ACTIVE'
        AND COALESCE(w.asset_id, 0) = COALESCE(l.asset_id, 0)
        AND COALESCE(w.room_id, 0) = COALESCE(l.room_id, 0)
        AND COALESCE(w.equipment_id, 0) = COALESCE(l.equipment_id, 0))
  ON CONFLICT DO NOTHING;
END
$fn$;

CREATE OR REPLACE FUNCTION document_asset_links_on_asset_files() RETURNS TRIGGER
LANGUAGE plpgsql AS $fn$
BEGIN
  -- Pas de bloc EXCEPTION (sous-transaction par ligne) : voir « SÛRETÉ ».
  PERFORM document_asset_links_sync_file(CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END);
  RETURN NULL;
END
$fn$;

DROP TRIGGER IF EXISTS asset_files_document_asset_links_ins_del ON asset_files;
CREATE TRIGGER asset_files_document_asset_links_ins_del
  AFTER INSERT OR DELETE ON asset_files
  FOR EACH ROW EXECUTE FUNCTION document_asset_links_on_asset_files();

DROP TRIGGER IF EXISTS asset_files_document_asset_links_upd ON asset_files;
CREATE TRIGGER asset_files_document_asset_links_upd
  AFTER UPDATE OF asset_id, linked_asset_id, linked_room_id, equipment_id, deleted_at ON asset_files
  FOR EACH ROW
  WHEN (OLD.asset_id IS DISTINCT FROM NEW.asset_id
     OR OLD.linked_asset_id IS DISTINCT FROM NEW.linked_asset_id
     OR OLD.linked_room_id IS DISTINCT FROM NEW.linked_room_id
     OR OLD.equipment_id IS DISTINCT FROM NEW.equipment_id
     OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
  EXECUTE FUNCTION document_asset_links_on_asset_files();
