-- Migration 0696 (index 1/1) : journal des reconsolidations ciblées lu par compte (BO, diagnostic, tests).
-- UNE instruction par fichier : `CREATE INDEX CONCURRENTLY` ne s'exécute pas
-- dans une transaction. Idempotente ; un index laissé INVALIDE est reconstruit
-- (`migration-index.ts`).
--
-- INDEX OPTIONNEL : sans lui, la lecture du journal d'un compte parcourt
-- davantage de lignes — plus lente, jamais fausse.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS business_operation_targeted_runs_account_idx
  ON business_operation_targeted_runs (account_id, started_at DESC);
