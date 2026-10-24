-- Migration 0720 (index 1/1) : appels d'interprétation T3 d'un compte sur 24 h (budget
-- `T3_KNOWLEDGE_QUERY_DAILY_MAX`) et lecture par document (contrôle de cohérence).
-- UNE instruction par fichier : `CREATE INDEX CONCURRENTLY` ne s'exécute pas
-- dans une transaction. Idempotente ; un index laissé INVALIDE est reconstruit
-- (`migration-index.ts`).
--
-- INDEX OPTIONNEL : sans lui, le décompte du budget parcourt davantage de
-- lignes — plus lent, jamais faux.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS t3_knowledge_queries_account_updated_idx
  ON t3_knowledge_queries (account_id, updated_at DESC);
