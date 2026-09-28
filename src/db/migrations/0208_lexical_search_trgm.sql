-- =============================================================================
-- 0208 — Index trigrammes (pg_trgm) pour la recherche LEXICALE.
--
-- Décision produit (V1) : la recherche reste LEXICALE — Centre d'aide §4 et
-- assistant T2-008 (« recherche sémantique si utile et disponible ») : pas
-- d'embeddings en V1. Les recherches de l'assistant sur les données du
-- compte sont des `LIKE '%terme%'` insensibles à la casse et aux accents ;
-- un index B-tree ne sert pas un motif commençant par `%`, un index GIN
-- trigrammes, si.
--
-- 1. Extension pg_trgm : créée si possible. Hébergeur qui ne la fournit pas
--    (ou droits insuffisants) : simple NOTICE, la migration réussit, les
--    recherches fonctionnent sans index (parcours du compte, comme avant).
--
-- 2. `verebona_unaccent_lower(text)` : `unaccent` est STABLE, donc interdite
--    dans une expression d'index. Cette enveloppe IMMUTABLE (dictionnaire
--    nommé, schéma qualifié) donne la même valeur que
--    `unaccent(lower(coalesce(x, '')))`, forme qu'employaient les requêtes ;
--    les requêtes de l'assistant l'appellent désormais pour que l'index soit
--    utilisable. Elle est créée MÊME sans pg_trgm (les requêtes en
--    dépendent) ; sans l'extension unaccent, repli sur `lower(coalesce())`
--    — recherche alors sensible aux accents, mais jamais en erreur.
--
-- 3. Index GIN multi-colonnes, un par table, sur exactement les colonnes
--    interrogées par les adaptateurs de recherche de l'assistant
--    (registries/retrieval-adapters.ts, core/retrieval.service.ts) — créés
--    seulement si pg_trgm est présente et la table existe ; un échec
--    ponctuel n'interrompt pas les autres.
--
-- Idempotente : CREATE ... IF NOT EXISTS, CREATE OR REPLACE.
--
-- ⚠ NOTE D'EXPLOITATION — VERROU PENDANT LA CONSTRUCTION DES INDEX
-- `ensureMigrations` (src/db/index.ts) exécute chaque fichier en UNE requête
-- multi-instructions : PostgreSQL l'enveloppe dans une transaction implicite,
-- où `CREATE INDEX CONCURRENTLY` est refusé (vérifié). Les index sont donc
-- construits en mode normal : les ÉCRITURES de la table sont bloquées le
-- temps de la construction, au premier démarrage qui applique ce fichier.
-- La plus longue : asset_files, à cause du texte extrait (extracted_text).
-- Sur une base volumineuse, créer l'index À LA MAIN avant la mise en
-- production, hors transaction :
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS asset_files_search_trgm_idx
--     ON asset_files USING gin (verebona_unaccent_lower(retained_title) gin_trgm_ops, …);
-- (mêmes colonnes que ci-dessous) — la migration le trouvera alors déjà là
-- (IF NOT EXISTS) et ne bloquera rien.
-- =============================================================================

DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION WHEN others THEN
  RAISE NOTICE '[0208] extension pg_trgm indisponible (%), recherche lexicale sans index trigrammes', SQLERRM;
END $$;

-- Enveloppe IMMUTABLE. Chaque étape est protégée : un échec (droits sur le
-- schéma d'unaccent, fonction existante appartenant à un autre rôle…) ne
-- doit JAMAIS annuler tout le fichier. Ordre de repli :
--   1. unaccent (schéma qualifié) ;
--   2. lower(coalesce()) — sensible aux accents, jamais en erreur ;
--   3. rien (NOTICE) : l'application détecte l'absence de la fonction et
--      retombe sur `unaccent(lower(...))` / `lower(...)` en SQL
--      (services/verebona-assistant/core/search-sql.ts) ; les index ne sont alors pas créés.
DO $$
DECLARE
  schema_unaccent text;
BEGIN
  SELECT n.nspname INTO schema_unaccent
    FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
   WHERE e.extname = 'unaccent';
  IF schema_unaccent IS NULL THEN
    RAISE EXCEPTION 'extension unaccent absente';
  END IF;
  EXECUTE format(
    $f$CREATE OR REPLACE FUNCTION verebona_unaccent_lower(t text) RETURNS text
         LANGUAGE sql IMMUTABLE PARALLEL SAFE
         AS $b$ SELECT %I.unaccent(%L::regdictionary, lower(coalesce(t, ''))) $b$ $f$,
    schema_unaccent, schema_unaccent || '.unaccent');
EXCEPTION WHEN others THEN
  RAISE NOTICE '[0208] verebona_unaccent_lower avec unaccent impossible (%) : repli sur lower()', SQLERRM;
  BEGIN
    CREATE OR REPLACE FUNCTION verebona_unaccent_lower(t text) RETURNS text
      LANGUAGE sql IMMUTABLE PARALLEL SAFE
      AS $b$ SELECT lower(coalesce(t, '')) $b$;
  EXCEPTION WHEN others THEN
    RAISE NOTICE '[0208] verebona_unaccent_lower non créée (%) : repli SQL côté application, sans index', SQLERRM;
  END;
END $$;

DO $$
DECLARE
  schema_trgm text;
  idx record;
  colonnes text;
BEGIN
  SELECT n.nspname INTO schema_trgm
    FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
   WHERE e.extname = 'pg_trgm';
  IF schema_trgm IS NULL THEN
    RAISE NOTICE '[0208] pg_trgm absente : index trigrammes non créés';
    RETURN;
  END IF;
  IF to_regprocedure('verebona_unaccent_lower(text)') IS NULL THEN
    RAISE NOTICE '[0208] verebona_unaccent_lower absente : index trigrammes non créés';
    RETURN;
  END IF;

  FOR idx IN
    SELECT * FROM (VALUES
      ('assets_search_trgm_idx',             'assets',             ARRAY['name', 'city', 'category', 'subtype', 'registration_number']),
      ('asset_files_search_trgm_idx',        'asset_files',        ARRAY['retained_title', 'original_filename', 'supplier', 'description', 'document_type', 'extracted_text']),
      ('agenda_items_search_trgm_idx',       'agenda_items',       ARRAY['title', 'description']),
      ('equipments_search_trgm_idx',         'equipments',         ARRAY['name', 'type']),
      ('rooms_search_trgm_idx',              'rooms',              ARRAY['name']),
      ('suppliers_search_trgm_idx',          'suppliers',          ARRAY['name', 'city']),
      ('to_process_actions_search_trgm_idx', 'to_process_actions', ARRAY['question'])
    ) AS v(nom, tbl, cols)
  LOOP
    IF to_regclass(idx.tbl) IS NULL THEN
      RAISE NOTICE '[0208] table % absente : index % non créé', idx.tbl, idx.nom;
      CONTINUE;
    END IF;
    SELECT string_agg(format('verebona_unaccent_lower(%I) %I.gin_trgm_ops', c, schema_trgm), ', ')
      INTO colonnes FROM unnest(idx.cols) AS c;
    BEGIN
      EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I USING gin (%s)', idx.nom, idx.tbl, colonnes);
    EXCEPTION WHEN others THEN
      RAISE NOTICE '[0208] index % non créé : %', idx.nom, SQLERRM;
    END;
  END LOOP;
END $$;
