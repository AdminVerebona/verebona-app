-- Migration 0770 (index 1/1) : appels d'analyse T3 des propriétés manquantes d'un
-- compte sur 24 h (budget partagé `T3_KNOWLEDGE_QUERY_DAILY_MAX`) et lecture par objet.
-- UNE instruction par fichier : `CREATE INDEX CONCURRENTLY` ne s'exécute pas
-- dans une transaction. Idempotente ; un index laissé INVALIDE est reconstruit
-- (`migration-index.ts`).
--
-- INDEX OPTIONNEL : sans lui, le décompte du budget parcourt davantage de
-- lignes — plus lent, jamais faux.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS property_recovery_runs_account_updated_idx
  ON property_recovery_runs (account_id, updated_at DESC);
