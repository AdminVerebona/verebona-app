-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0935 : « Prénom ou pseudo » NON unique (lot 103B, décision PO du
-- 31/10/2026). `users.username` est un nom d'affichage (« Bonjour Sophie »),
-- jamais un identifiant : plusieurs comptes peuvent s'appeler Sophie.
--
-- Contrainte réellement présente : aucune migration SQL ne l'a créée. Elle
-- vient du schéma Drizzle (`username: text('username').unique()`), matérialisé
-- par `drizzle-kit push` (base d'origine) et par le harnais E2E, sous le nom
-- `users_username_unique` (CONSTRAINT … UNIQUE("username"), index implicite du
-- même nom). On la supprime par son nom, puis, par sécurité, toute AUTRE
-- contrainte ou index UNIQUE portant SEULEMENT sur `username` (ex.
-- `users_username_key` d'une très ancienne création, index manuel sur
-- lower(username)) — identifiés dans le catalogue, jamais devinés.
--
-- NON touché : unicité de l'e-mail (`users_email_unique`), identités
-- Google / Apple (table des identités externes), clés primaires et toute contrainte
-- portant sur plusieurs colonnes ou sur une autre colonne.
--
-- Additive (aucune donnée modifiée), idempotente, rejouable.
-- Retour arrière (seulement si aucun doublon n'existe encore) :
--   ALTER TABLE users ADD CONSTRAINT users_username_unique UNIQUE (username);
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_username_unique;

DO $$
DECLARE
  tbl oid;
  col smallint;
  r record;
BEGIN
  SELECT c.oid INTO tbl
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relname = 'users' AND n.nspname = current_schema() AND c.relkind = 'r';
  IF tbl IS NULL THEN RETURN; END IF;
  SELECT a.attnum INTO col FROM pg_attribute a
   WHERE a.attrelid = tbl AND a.attname = 'username' AND NOT a.attisdropped;
  IF col IS NULL THEN RETURN; END IF;

  -- Contraintes UNIQUE dont la SEULE colonne est `username`.
  FOR r IN
    SELECT con.conname FROM pg_constraint con
     WHERE con.conrelid = tbl AND con.contype = 'u' AND con.conkey = ARRAY[col]::smallint[]
  LOOP
    EXECUTE format('ALTER TABLE users DROP CONSTRAINT IF EXISTS %I', r.conname);
    RAISE NOTICE '[0935] contrainte d''unicité supprimée : %', r.conname;
  END LOOP;

  -- Index UNIQUE hors contrainte, sur `username` seul (colonne ou expression).
  FOR r IN
    SELECT i.relname AS idx FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
     WHERE x.indrelid = tbl AND x.indisunique AND NOT x.indisprimary AND x.indnatts = 1
       AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = x.indexrelid)
       AND (
         x.indkey[0] = col
         OR (x.indkey[0] = 0 AND pg_get_expr(x.indexprs, x.indrelid) ~* '\musername\M'
             AND pg_get_expr(x.indexprs, x.indrelid) !~* '\memail\M')
       )
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS %I.%I', current_schema(), r.idx);
    RAISE NOTICE '[0935] index unique supprimé : %', r.idx;
  END LOOP;
END $$;
