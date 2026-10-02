-- Migration 0229 (index 3/3) : retrait de l'ancienne unicité des liens actifs,
-- remplacée par document_asset_links_active_uniq2 (idx 2/3).
--
-- GARDE (revue lot 20) : l'ancien index n'est supprimé QUE si la colonne
-- `substructure_id` existe (0229 principal appliqué) ET si `..._uniq2` existe
-- et est VALIDE (idx 2/3 construit). Sinon : exception — le fichier n'est pas
-- marqué appliqué et sera retenté au démarrage suivant, APRÈS les fichiers
-- 0229 qui le précèdent (ordre lexicographique de `ensureMigrations`). Jamais
-- de fenêtre sans unicité.
--
-- Pas de CONCURRENTLY (impossible dans un bloc) : `DROP INDEX` prend un
-- verrou ACCESS EXCLUSIVE BREF sur document_asset_links (suppression d'un
-- fichier d'index, aucune lecture de table), borné par `lock_timeout`.
-- Idempotente : index déjà absent → rien.
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF to_regclass('document_asset_links_active_uniq') IS NULL THEN
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
                  AND table_name = 'document_asset_links' AND column_name = 'substructure_id') THEN
    RAISE EXCEPTION '0229 idx 3/3 : document_asset_links.substructure_id absente (0229 principal non appliqué) — ancienne unicité conservée, retentée au prochain démarrage';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
                  WHERE c.relname = 'document_asset_links_active_uniq2'
                    AND c.relnamespace = current_schema()::regnamespace AND i.indisvalid) THEN
    RAISE EXCEPTION '0229 idx 3/3 : document_asset_links_active_uniq2 absent ou invalide — ancienne unicité conservée, retentée au prochain démarrage';
  END IF;
  DROP INDEX IF EXISTS document_asset_links_active_uniq;
END $$;
