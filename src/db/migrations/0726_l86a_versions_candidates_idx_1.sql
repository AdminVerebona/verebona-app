-- Migration 0726 (index 1/1) : candidates automatiques par clé de proposition (lot 86A).
-- UNE instruction par fichier : `CREATE INDEX CONCURRENTLY` ne s'exécute pas
-- dans une transaction. Idempotente ; un index laissé INVALIDE est reconstruit
-- (`migration-index.ts`).
--
-- INDEX OPTIONNEL : sans lui, la recherche d'une proposition déjà faite
-- parcourt les versions de l'environnement — plus lente, jamais fausse.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS ai_config_versions_candidate_key_idx
  ON ai_config_versions (environment, candidate_key) WHERE candidate_key IS NOT NULL;
