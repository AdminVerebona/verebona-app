-- Migration 0297 (index 1/1) : faits d'une unité source (provenance inverse :
-- unité → faits produits). `document_facts` est VOLUMINEUSE : CONCURRENTLY,
-- UNE instruction par fichier. Idempotente ; un index laissé INVALIDE est
-- reconstruit (`migration-index.ts`).
--
-- INDEX OPTIONNEL : la provenance d'un document se lit par `file_id` (index
-- existant) ; sans celui-ci, seule la recherche inverse sur tout un compte est
-- plus lente — jamais fausse.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS document_facts_source_units_idx
  ON document_facts USING GIN (source_unit_ids)
  WHERE source_unit_ids IS NOT NULL;
