-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0346 : la suppression d'un bien n'emporte JAMAIS une donnée d'un
-- autre compte (lot 53, retour PO D23 — neutralisation des accès en
-- écriture par une relation intercomptes héritée).
--
-- Constat : `asset_files`, `events` et `deadlines` référencent le bien par
-- `asset_id` / `linked_asset_id` (et la pièce historique `linked_room_id`)
-- en ON DELETE CASCADE. Une relation intercomptes héritée (document du
-- compte B rattaché à tort au bien du compte A) faisait donc supprimer le
-- document de B quand A supprimait son bien (ou son compte) — écriture
-- intercomptes, perte de données.
--
-- Déclencheur BEFORE DELETE sur `assets` : avant la cascade, les lignes d'un
-- AUTRE compte (comptes tous deux connus et différents) qui citent le bien
-- ou l'une de ses pièces historiques sont DÉTACHÉES (colonne remise à NULL) ;
-- elles restent dans leur compte. Les lignes du compte du bien suivent la
-- règle produit inchangée (« tout est supprimé »). Bien ou ligne sans compte
-- (historique) : comportement antérieur.
--
-- Couvre tous les chemins : suppression du bien (`deleteAssetCompletely`),
-- cascade de la suppression d'un compte, scripts. Aucun flux Duo modifié :
-- un déplacement de bien change `account_id` (UPDATE), jamais un DELETE.
--
-- COÛT : par bien supprimé, neuf mises à jour servies par les index
-- existants (asset_files_asset_id_idx, …_linked_asset_id_idx,
-- …_linked_room_id_idx, events_*, deadlines_*). Aucun balayage.
-- Idempotente (CREATE OR REPLACE, DROP TRIGGER IF EXISTS). Retour arrière :
-- DROP TRIGGER IF EXISTS assets_detach_foreign_refs ON assets ;
-- DROP FUNCTION IF EXISTS assets_detach_foreign_refs().
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION assets_detach_foreign_refs() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  n INTEGER := 0;
  k INTEGER;
BEGIN
  IF OLD.account_id IS NULL THEN RETURN OLD; END IF;
  UPDATE asset_files SET asset_id = NULL
   WHERE asset_id = OLD.id AND account_id IS NOT NULL AND account_id <> OLD.account_id;
  GET DIAGNOSTICS k = ROW_COUNT; n := n + k;
  UPDATE asset_files SET linked_asset_id = NULL
   WHERE linked_asset_id = OLD.id AND account_id IS NOT NULL AND account_id <> OLD.account_id;
  GET DIAGNOSTICS k = ROW_COUNT; n := n + k;
  UPDATE asset_files SET linked_room_id = NULL
   WHERE linked_room_id IN (SELECT r.id FROM rooms r WHERE r.asset_id = OLD.id)
     AND account_id IS NOT NULL AND account_id <> OLD.account_id;
  GET DIAGNOSTICS k = ROW_COUNT; n := n + k;
  UPDATE events SET asset_id = NULL
   WHERE asset_id = OLD.id AND account_id IS NOT NULL AND account_id <> OLD.account_id;
  GET DIAGNOSTICS k = ROW_COUNT; n := n + k;
  UPDATE events SET linked_asset_id = NULL
   WHERE linked_asset_id = OLD.id AND account_id IS NOT NULL AND account_id <> OLD.account_id;
  GET DIAGNOSTICS k = ROW_COUNT; n := n + k;
  UPDATE deadlines SET asset_id = NULL
   WHERE asset_id = OLD.id AND account_id IS NOT NULL AND account_id <> OLD.account_id;
  GET DIAGNOSTICS k = ROW_COUNT; n := n + k;
  UPDATE deadlines SET linked_asset_id = NULL
   WHERE linked_asset_id = OLD.id AND account_id IS NOT NULL AND account_id <> OLD.account_id;
  GET DIAGNOSTICS k = ROW_COUNT; n := n + k;
  UPDATE events SET linked_room_id = NULL
   WHERE linked_room_id IN (SELECT r.id FROM rooms r WHERE r.asset_id = OLD.id)
     AND account_id IS NOT NULL AND account_id <> OLD.account_id;
  GET DIAGNOSTICS k = ROW_COUNT; n := n + k;
  UPDATE deadlines SET linked_room_id = NULL
   WHERE linked_room_id IN (SELECT r.id FROM rooms r WHERE r.asset_id = OLD.id)
     AND account_id IS NOT NULL AND account_id <> OLD.account_id;
  GET DIAGNOSTICS k = ROW_COUNT; n := n + k;
  IF n > 0 THEN
    RAISE LOG 'security.cross_account_detached asset=% account=% rows=%', OLD.id, OLD.account_id, n;
  END IF;
  RETURN OLD;
END
$fn$;

DROP TRIGGER IF EXISTS assets_detach_foreign_refs ON assets;
CREATE TRIGGER assets_detach_foreign_refs
  BEFORE DELETE ON assets
  FOR EACH ROW EXECUTE FUNCTION assets_detach_foreign_refs();
