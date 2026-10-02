-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0229 : fusion des pièces sur `substructures` (décision PO D-G du
-- 01/10/2026 ; plan lot 20, chantier B).
--
-- Deux notions de « pièce » coexistaient : `rooms` (pièces T1, ciblées par
-- les faits, les preuves, le journal canonique, les cartes ENTITY-FIELD-ROOM
-- et la fiche canonique 0227) et `substructures` (les pièces de l'écran, de
-- l'agenda et des documents). La pièce est désormais la SOUS-STRUCTURE : une
-- cible « ROOM » (faits, preuves, journal, cartes À traiter, travaux T3)
-- désigne `substructures.id`. `rooms` est DÉPRÉCIÉE, conservée (lecture de
-- compatibilité, restauration) : aucune suppression ici.
--
-- Cette migration ne pose que le SCHÉMA et neutralise l'ambiguïté des
-- identifiants. Le déplacement des données est la reprise MANUELLE
-- `scripts/merge-rooms-into-substructures.ts` (simulation par défaut,
-- `--apply`, `--restore <runId>`, journal sans perte).
--
--   substructures.legacy_room_id   pièce `rooms` reprise (unique, index _idx_1) ;
--   substructures.room_type / area / description
--                                  reprise fidèle des colonnes de `rooms` ;
--   substructures.key_characteristics
--                                  fiche canonique de la pièce (0227 la portait
--                                  sur `rooms`) ; `area` = miroir de `roomArea` ;
--   document_asset_links.substructure_id
--                                  lien N-N document ↔ pièce ; `room_id` reste
--                                  lisible (historique, liens non repris) ;
--                                  unicité des liens actifs étendue (_idx_2/3) ;
--   document_asset_links_sync_file()
--                                  le déclencheur 0221 reflète aussi
--                                  `asset_files.substructure_id` ;
--   room_merge_runs / room_merge_changes
--                                  exécutions et journal de la reprise
--                                  (ancienne / nouvelle valeur par colonne :
--                                  rapport ET restauration) ;
--   canonical_field_writes_target_ck  admet LEGACY_ROOM.
--
-- AMBIGUÏTÉ DES IDENTIFIANTS (une seule fois : la table `room_merge_runs`
-- sert de marqueur) : les lignes existantes ciblées « ROOM » portent un
-- identifiant de `rooms`. Elles passent en `LEGACY_ROOM` (faits, preuves,
-- journal canonique, cartes À traiter — les cartes actives sont SUSPENDUES,
-- `trigger_context.dgSuspended`, et rouvertes par la reprise) ; les travaux
-- T3 « room » en attente sont annulés (relancés par la reprise). Désormais
-- « ROOM » = sous-structure ; une ligne LEGACY_ROOM n'est lue par aucun code.
-- Mises à jour servies par les index (target_type, target_entity_id) /
-- (target_type, target_id) : lignes ciblées seulement.
--
-- VERROUS : ADD COLUMN (défaut constant, sans réécriture) sous ACCESS
-- EXCLUSIVE, bref ; `lock_timeout` 5 s. Dépassé : échec signalé, retenté au
-- démarrage suivant (le fichier est une seule transaction implicite).
-- Index : 0229_*_idx_1..3.sql (CONCURRENTLY, une instruction par fichier).
-- Idempotente (IF NOT EXISTS, CREATE OR REPLACE, marqueur).
-- ──────────────────────────────────────────────────────────────────────────────

SET LOCAL lock_timeout = '5s';

-- 1. Neutralisation des anciens identifiants « ROOM », AVANT la création du
--    marqueur (une seconde exécution ne touche plus rien).
DO $$
BEGIN
  IF to_regclass('room_merge_runs') IS NULL THEN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
                AND table_name = 'field_evidence' AND column_name = 'target_type') THEN
      UPDATE field_evidence SET target_type = 'LEGACY_ROOM' WHERE target_type = 'ROOM';
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
                AND table_name = 'document_facts' AND column_name = 'target_type') THEN
      UPDATE document_facts SET target_type = 'LEGACY_ROOM' WHERE target_type = 'ROOM';
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
                AND table_name = 'canonical_field_writes' AND column_name = 'target_type') THEN
      ALTER TABLE canonical_field_writes DROP CONSTRAINT IF EXISTS canonical_field_writes_target_ck;
      UPDATE canonical_field_writes SET target_type = 'LEGACY_ROOM' WHERE target_type = 'ROOM';
    END IF;
    IF to_regclass('to_process_actions') IS NOT NULL THEN
      UPDATE to_process_actions
         SET target_type = 'LEGACY_ROOM',
             resolved_at = CASE WHEN resolved_at IS NULL THEN now() ELSE resolved_at END,
             resolution_reason = CASE WHEN resolved_at IS NULL THEN 'OBSOLETE' ELSE resolution_reason END,
             trigger_context = CASE WHEN resolved_at IS NULL
                                    THEN COALESCE(trigger_context, '{}'::jsonb) || '{"dgSuspended": true}'::jsonb
                                    ELSE trigger_context END,
             updated_at = now()
       WHERE target_type = 'ROOM';
    END IF;
    IF to_regclass('ai_job_queue') IS NOT NULL THEN
      UPDATE ai_job_queue
         SET status = 'CANCELLED', finished_at = now(),
             last_error = 'D-G : cible room (identifiant rooms) — relancée par la reprise des pièces'
       WHERE target_type = 'room' AND status = 'PENDING';
    END IF;
  END IF;
END $$;

-- 2. Exécutions et journal de la reprise (`services/migration/rooms-merge`).
CREATE TABLE IF NOT EXISTS room_merge_runs (
  run_id       UUID PRIMARY KEY,
  run_mode     TEXT NOT NULL,
  account_id   INTEGER,
  options      JSONB NOT NULL DEFAULT '{}'::jsonb,
  counts       JSONB NOT NULL DEFAULT '{}'::jsonb,
  status       TEXT NOT NULL DEFAULT 'RUNNING',
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ,
  restored_at  TIMESTAMPTZ,
  CONSTRAINT room_merge_runs_mode_check CHECK (run_mode IN ('dry_run', 'apply')),
  CONSTRAINT room_merge_runs_status_check CHECK (status IN ('RUNNING', 'DONE', 'FAILED', 'RESTORED'))
);

CREATE TABLE IF NOT EXISTS room_merge_changes (
  id           BIGSERIAL PRIMARY KEY,
  run_id       UUID NOT NULL,
  run_mode     TEXT NOT NULL,
  room_id      INTEGER NOT NULL,
  account_id   INTEGER,
  asset_id     INTEGER,
  decision     TEXT NOT NULL,
  table_name   TEXT NOT NULL,
  row_id       TEXT NOT NULL,
  column_name  TEXT NOT NULL,
  old_value    JSONB,
  new_value    JSONB,
  reason       TEXT,
  restored_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT room_merge_changes_mode_check CHECK (run_mode IN ('dry_run', 'apply')),
  CONSTRAINT room_merge_changes_decision_check
    CHECK (decision IN ('CREATED', 'MAPPED', 'REPOINTED', 'REOPENED', 'SUPERSEDED', 'CONFLICT', 'NO_CHANGE'))
);

CREATE INDEX IF NOT EXISTS room_merge_changes_run_idx ON room_merge_changes (run_id, id);
CREATE INDEX IF NOT EXISTS room_merge_changes_room_idx ON room_merge_changes (room_id, id);

-- 3. Colonnes de la pièce sur la sous-structure (défauts constants : aucune
--    réécriture de table, PG ≥ 11). Non déclarées dans Drizzle (comme 0227) :
--    lues et écrites en SQL après contrôle de présence.
ALTER TABLE substructures ADD COLUMN IF NOT EXISTS legacy_room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL;
ALTER TABLE substructures ADD COLUMN IF NOT EXISTS room_type TEXT;
ALTER TABLE substructures ADD COLUMN IF NOT EXISTS area TEXT;
ALTER TABLE substructures ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE substructures ADD COLUMN IF NOT EXISTS key_characteristics JSONB NOT NULL DEFAULT '{}'::jsonb;

-- 4. Lien N-N document ↔ pièce (sous-structure). Pièce supprimée : le lien
--    se REPLIE sur le bien (ON DELETE SET NULL, comme asset_files /
--    events / deadlines.substructure_id) au lieu de disparaître ; un lien qui
--    ferait alors doublon avec un lien actif au bien seul, ou un lien
--    LEGACY_COLUMN (recalculé depuis asset_files), est d'abord retiré
--    (REMOVED) par `substructures_links_before_delete`.
ALTER TABLE document_asset_links ADD COLUMN IF NOT EXISTS substructure_id INTEGER;
DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN SELECT con.conname FROM pg_constraint con
            JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
           WHERE con.conrelid = 'document_asset_links'::regclass AND con.contype = 'f' AND att.attname = 'substructure_id'
             AND con.conname <> 'document_asset_links_substructure_id_substructures_id_fk' LOOP
    EXECUTE format('ALTER TABLE document_asset_links DROP CONSTRAINT %I', c.conname);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_asset_links_substructure_id_substructures_id_fk'
                  AND conrelid = 'document_asset_links'::regclass AND confdeltype = 'n') THEN
    ALTER TABLE document_asset_links DROP CONSTRAINT IF EXISTS document_asset_links_substructure_id_substructures_id_fk;
    ALTER TABLE document_asset_links ADD CONSTRAINT document_asset_links_substructure_id_substructures_id_fk
      FOREIGN KEY (substructure_id) REFERENCES substructures(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION substructures_links_before_delete() RETURNS TRIGGER
LANGUAGE plpgsql AS $fn$
BEGIN
  UPDATE document_asset_links l
     SET status = 'REMOVED', removed_at = now(), updated_at = now()
   WHERE l.substructure_id = OLD.id AND l.status = 'ACTIVE'
     AND (l.origin = 'LEGACY_COLUMN'
          OR EXISTS (SELECT 1 FROM document_asset_links d
                      WHERE d.file_id = l.file_id AND d.status = 'ACTIVE' AND d.id <> l.id
                        AND COALESCE(d.asset_id, 0) = COALESCE(l.asset_id, 0)
                        AND COALESCE(d.room_id, 0) = COALESCE(l.room_id, 0)
                        AND COALESCE(d.equipment_id, 0) = COALESCE(l.equipment_id, 0)
                        AND d.substructure_id IS NULL));
  RETURN OLD;
END
$fn$;

DROP TRIGGER IF EXISTS substructures_links_before_delete ON substructures;
CREATE TRIGGER substructures_links_before_delete
  BEFORE DELETE ON substructures
  FOR EACH ROW EXECUTE FUNCTION substructures_links_before_delete();
ALTER TABLE document_asset_links DROP CONSTRAINT IF EXISTS document_asset_links_target_check;
ALTER TABLE document_asset_links ADD CONSTRAINT document_asset_links_target_check
  CHECK (asset_id IS NOT NULL OR room_id IS NOT NULL OR equipment_id IS NOT NULL OR substructure_id IS NOT NULL) NOT VALID;

-- 5. Journal canonique : LEGACY_ROOM admis (lignes antérieures neutralisées).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
              AND table_name = 'canonical_field_writes' AND column_name = 'target_type') THEN
    ALTER TABLE canonical_field_writes DROP CONSTRAINT IF EXISTS canonical_field_writes_target_ck;
    ALTER TABLE canonical_field_writes ADD CONSTRAINT canonical_field_writes_target_ck
      CHECK ((target_type IS NULL AND target_id IS NULL)
          OR (target_type IN ('EQUIPMENT', 'ROOM', 'LEGACY_ROOM') AND target_id IS NOT NULL)) NOT VALID;
  END IF;
END $$;

-- 6. Déclencheur 0221 : la sous-structure d'un document (`asset_files.
--    substructure_id`) devient une cible du lien N-N, comme `linked_room_id`
--    (historique, toujours reflété tant qu'il n'est pas repris). Mêmes règles
--    et même absence de bloc EXCEPTION que 0221 (voir son en-tête).
CREATE OR REPLACE FUNCTION document_asset_links_sync_file(p_file_id INTEGER) RETURNS VOID
LANGUAGE plpgsql AS $fn$
DECLARE
  f          RECORD;
  v_room     RECORD;
  v_sub      RECORD;
  v_equip    RECORD;
  a_assets   INTEGER[] := '{}';
  a_rooms    INTEGER[] := '{}';
  a_equips   INTEGER[] := '{}';
  a_subs     INTEGER[] := '{}';
  a_roles    TEXT[]    := '{}';
BEGIN
  SELECT id, account_id, asset_id, linked_asset_id, linked_room_id, equipment_id, substructure_id, deleted_at
    INTO f FROM asset_files WHERE id = p_file_id;

  IF FOUND AND f.deleted_at IS NULL AND f.account_id IS NOT NULL THEN
    IF f.asset_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM assets a WHERE a.id = f.asset_id AND a.account_id = f.account_id) THEN
      a_assets := a_assets || f.asset_id; a_rooms := a_rooms || NULL::INTEGER;
      a_equips := a_equips || NULL::INTEGER; a_subs := a_subs || NULL::INTEGER; a_roles := a_roles || 'PRIMARY'::TEXT;
    END IF;
    IF f.linked_asset_id IS NOT NULL AND f.linked_asset_id IS DISTINCT FROM f.asset_id
       AND EXISTS (SELECT 1 FROM assets a WHERE a.id = f.linked_asset_id AND a.account_id = f.account_id) THEN
      a_assets := a_assets || f.linked_asset_id; a_rooms := a_rooms || NULL::INTEGER;
      a_equips := a_equips || NULL::INTEGER; a_subs := a_subs || NULL::INTEGER;
      a_roles := a_roles || (CASE WHEN cardinality(a_roles) = 0 THEN 'PRIMARY' ELSE 'SECONDARY' END)::TEXT;
    END IF;
    IF f.linked_room_id IS NOT NULL THEN
      SELECT r.id, r.asset_id INTO v_room
        FROM rooms r JOIN assets a ON a.id = r.asset_id
       WHERE r.id = f.linked_room_id AND a.account_id = f.account_id;
      IF FOUND THEN
        a_assets := a_assets || v_room.asset_id; a_rooms := a_rooms || v_room.id;
        a_equips := a_equips || NULL::INTEGER; a_subs := a_subs || NULL::INTEGER;
        a_roles := a_roles || (CASE WHEN cardinality(a_roles) = 0 THEN 'PRIMARY' ELSE 'SECONDARY' END)::TEXT;
      END IF;
    END IF;
    IF f.substructure_id IS NOT NULL THEN
      SELECT s.id, s.asset_id INTO v_sub
        FROM substructures s JOIN assets a ON a.id = s.asset_id
       WHERE s.id = f.substructure_id AND a.account_id = f.account_id;
      IF FOUND THEN
        a_assets := a_assets || v_sub.asset_id; a_rooms := a_rooms || NULL::INTEGER;
        a_equips := a_equips || NULL::INTEGER; a_subs := a_subs || v_sub.id;
        a_roles := a_roles || (CASE WHEN cardinality(a_roles) = 0 THEN 'PRIMARY' ELSE 'SECONDARY' END)::TEXT;
      END IF;
    END IF;
    IF f.equipment_id IS NOT NULL THEN
      SELECT e.id, e.asset_id INTO v_equip
        FROM equipments e JOIN assets a ON a.id = e.asset_id
       WHERE e.id = f.equipment_id AND a.account_id = f.account_id;
      IF FOUND THEN
        a_assets := a_assets || v_equip.asset_id; a_rooms := a_rooms || NULL::INTEGER;
        a_equips := a_equips || v_equip.id; a_subs := a_subs || NULL::INTEGER;
        a_roles := a_roles || (CASE WHEN cardinality(a_roles) = 0 THEN 'PRIMARY' ELSE 'SECONDARY' END)::TEXT;
      END IF;
    END IF;
  END IF;

  -- 1. Liens LEGACY_COLUMN qui ne reflètent plus les colonnes : retirés.
  UPDATE document_asset_links l
     SET status = 'REMOVED', removed_at = now(), updated_at = now()
   WHERE l.file_id = p_file_id AND l.status = 'ACTIVE' AND l.origin = 'LEGACY_COLUMN'
     AND NOT EXISTS (
       SELECT 1 FROM unnest(a_assets, a_rooms, a_equips, a_subs) AS w(asset_id, room_id, equipment_id, substructure_id)
        WHERE COALESCE(w.asset_id, 0) = COALESCE(l.asset_id, 0)
          AND COALESCE(w.room_id, 0) = COALESCE(l.room_id, 0)
          AND COALESCE(w.equipment_id, 0) = COALESCE(l.equipment_id, 0)
          AND COALESCE(w.substructure_id, 0) = COALESCE(l.substructure_id, 0));

  IF cardinality(a_roles) = 0 THEN RETURN; END IF;

  -- 2. Rôle d'un lien LEGACY_COLUMN existant ajusté.
  UPDATE document_asset_links l
     SET link_role = w.link_role, updated_at = now()
    FROM unnest(a_assets, a_rooms, a_equips, a_subs, a_roles) AS w(asset_id, room_id, equipment_id, substructure_id, link_role)
   WHERE l.file_id = p_file_id AND l.status = 'ACTIVE' AND l.origin = 'LEGACY_COLUMN'
     AND COALESCE(w.asset_id, 0) = COALESCE(l.asset_id, 0)
     AND COALESCE(w.room_id, 0) = COALESCE(l.room_id, 0)
     AND COALESCE(w.equipment_id, 0) = COALESCE(l.equipment_id, 0)
     AND COALESCE(w.substructure_id, 0) = COALESCE(l.substructure_id, 0)
     AND l.link_role <> w.link_role;

  -- 3. Cibles sans lien ACTIF (toutes origines confondues) : lien LEGACY_COLUMN.
  INSERT INTO document_asset_links (account_id, file_id, asset_id, room_id, equipment_id, substructure_id, link_role, origin, confidence, status)
  SELECT f.account_id, p_file_id, w.asset_id, w.room_id, w.equipment_id, w.substructure_id, w.link_role, 'LEGACY_COLUMN', 1, 'ACTIVE'
    FROM unnest(a_assets, a_rooms, a_equips, a_subs, a_roles) AS w(asset_id, room_id, equipment_id, substructure_id, link_role)
   WHERE NOT EXISTS (
     SELECT 1 FROM document_asset_links l
      WHERE l.file_id = p_file_id AND l.status = 'ACTIVE'
        AND COALESCE(w.asset_id, 0) = COALESCE(l.asset_id, 0)
        AND COALESCE(w.room_id, 0) = COALESCE(l.room_id, 0)
        AND COALESCE(w.equipment_id, 0) = COALESCE(l.equipment_id, 0)
        AND COALESCE(w.substructure_id, 0) = COALESCE(l.substructure_id, 0))
  ON CONFLICT DO NOTHING;
END
$fn$;

DROP TRIGGER IF EXISTS asset_files_document_asset_links_upd ON asset_files;
CREATE TRIGGER asset_files_document_asset_links_upd
  AFTER UPDATE OF asset_id, linked_asset_id, linked_room_id, equipment_id, substructure_id, deleted_at ON asset_files
  FOR EACH ROW
  WHEN (OLD.asset_id IS DISTINCT FROM NEW.asset_id
     OR OLD.linked_asset_id IS DISTINCT FROM NEW.linked_asset_id
     OR OLD.linked_room_id IS DISTINCT FROM NEW.linked_room_id
     OR OLD.equipment_id IS DISTINCT FROM NEW.equipment_id
     OR OLD.substructure_id IS DISTINCT FROM NEW.substructure_id
     OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
  EXECUTE FUNCTION document_asset_links_on_asset_files();

COMMENT ON TABLE rooms IS
  'DÉPRÉCIÉE (D-G, lot 20) : les pièces sont des substructures. Conservée pour la compatibilité et la restauration de la reprise.';
COMMENT ON COLUMN substructures.legacy_room_id IS
  'Pièce rooms reprise par scripts/merge-rooms-into-substructures.ts (D-G, lot 20). Unique (index 0229_idx_1).';
COMMENT ON COLUMN substructures.key_characteristics IS
  'Fiche canonique de la pièce (CDC 15 T1-04, lots 18 et 20) : roomArea et son origine ; area = miroir.';
COMMENT ON COLUMN document_asset_links.substructure_id IS
  'Pièce (sous-structure) visée par le lien (D-G, lot 20). room_id : historique (rooms), liens non repris.';
COMMENT ON TABLE room_merge_changes IS
  'Journal de la reprise rooms → substructures : ancienne / nouvelle valeur par colonne (rapport et restauration).';
