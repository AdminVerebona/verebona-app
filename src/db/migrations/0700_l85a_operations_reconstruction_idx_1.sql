-- Migration 0700 (index 1/1) : dernière reconstruction d'un compte (idempotence : compte inchangé depuis → rien à refaire).
-- UNE instruction par fichier : `CREATE INDEX CONCURRENTLY` ne s'exécute pas
-- dans une transaction. Idempotente ; un index laissé INVALIDE est reconstruit
-- (`migration-index.ts`).
--
-- INDEX OPTIONNEL : sans lui, la recherche de la dernière reconstruction d'un
-- compte parcourt davantage de lignes — plus lente, jamais fausse.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS operations_rebuild_accounts_account_idx
  ON operations_rebuild_accounts (account_id, finished_at DESC);
