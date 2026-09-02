-- Migration 0126 — Réparation des actions référentielles vers agenda_items
--
-- ═════════════════════════════════════════════════════════════════════════════
-- POURQUOI CETTE MIGRATION
--
-- `0050_agenda_items.sql` déclare bien ON DELETE CASCADE sur les quatre tables
-- de liaison et ON DELETE SET NULL sur les colonnes de traçabilité. Mais elle
-- crée ces tables en CREATE TABLE IF NOT EXISTS : sur une base où elles
-- préexistaient, la migration passe en silence et les contraintes restent
-- telles qu'elles ont été posées à l'origine — en NO ACTION.
--
-- Deux tables ne sont créées par AUCUNE migration : `agenda_item_sources` et
-- `impact_queue` viennent d'un `drizzle-kit push`. Leur clé étrangère n'a
-- jamais été vérifiée par une migration.
--
-- Conséquence : DELETE FROM agenda_items lève une violation de contrainte dès
-- que l'élément porte une liaison — c'est-à-dire presque toujours.
--
-- ── CETTE MIGRATION NE PEUT RIEN CASSER ──────────────────────────────────────
--
-- Elle ne fait que REPOSER les contraintes déjà décrites dans `schema.ts`, avec
-- l'action de suppression que le code attend. Elle est idempotente : rejouée,
-- elle repose les mêmes clés. Les tables absentes sont ignorées.
--
-- Les colonnes passées en SET NULL sont toutes nullables — aucune ligne
-- existante ne peut devenir non conforme.
-- ═════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  cible    RECORD;
  existant TEXT;
BEGIN
  FOR cible IN
    SELECT * FROM (VALUES
      -- Liaisons : sans élément, elles n'ont plus d'objet.
      ('agenda_asset_links',     'agenda_item_id',        'CASCADE'),
      ('agenda_file_links',      'agenda_item_id',        'CASCADE'),
      ('agenda_room_links',      'agenda_item_id',        'CASCADE'),
      ('agenda_equipment_links', 'agenda_item_id',        'CASCADE'),
      -- Traçabilité : la trace survit à l'élément, le lien est détaché.
      ('agenda_data_conflicts',  'agenda_item_id',        'SET NULL'),
      ('agenda_data_conflicts',  'result_agenda_item_id', 'SET NULL'),
      ('agenda_item_sources',    'agenda_item_id',        'SET NULL'),
      ('energy_works',           'agenda_item_id',        'SET NULL'),
      ('impact_queue',           'agenda_item_id',        'SET NULL')
    ) AS t(nom_table, nom_colonne, action_suppression)
  LOOP
    -- Table absente de cette base : rien à réparer.
    CONTINUE WHEN to_regclass('public.' || cible.nom_table) IS NULL;

    -- Colonne absente : le schéma n'est pas à jour, on n'invente rien.
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name   = cible.nom_table
        AND column_name  = cible.nom_colonne
    );

    existant := NULL;

    SELECT con.conname INTO existant
    FROM pg_constraint con
    JOIN pg_class cl  ON cl.oid  = con.conrelid
    JOIN pg_class ref ON ref.oid = con.confrelid
    WHERE con.contype = 'f'
      AND cl.relname  = cible.nom_table
      AND ref.relname = 'agenda_items'
      AND (
        SELECT array_agg(att.attname::text)
        FROM unnest(con.conkey) AS k(attnum)
        JOIN pg_attribute att
          ON att.attrelid = cl.oid AND att.attnum = k.attnum
      ) = ARRAY[cible.nom_colonne]
    LIMIT 1;

    IF existant IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', cible.nom_table, existant);
    END IF;

    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) '
      'REFERENCES agenda_items(id) ON DELETE %s',
      cible.nom_table,
      cible.nom_table || '_' || cible.nom_colonne || '_agenda_items_fk',
      cible.nom_colonne,
      cible.action_suppression
    );

    RAISE NOTICE 'FK réparée : %.% → agenda_items ON DELETE %',
      cible.nom_table, cible.nom_colonne, cible.action_suppression;
  END LOOP;
END $$;

-- Contrôle : plus aucune clé étrangère vers agenda_items ne doit rester en
-- NO ACTION ('a'). Si l'une subsiste, la migration échoue plutôt que de
-- laisser croire à une réparation.
DO $$
DECLARE
  restantes INTEGER;
BEGIN
  SELECT count(*) INTO restantes
  FROM pg_constraint con
  JOIN pg_class ref ON ref.oid = con.confrelid
  WHERE con.contype = 'f'
    AND ref.relname = 'agenda_items'
    AND con.confdeltype = 'a';

  IF restantes > 0 THEN
    RAISE EXCEPTION
      '% clé(s) étrangère(s) vers agenda_items encore en NO ACTION', restantes;
  END IF;
END $$;
