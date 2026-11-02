-- Migration 0921 (index 1/1) : journal de l'opposition à l'amélioration — lecture
-- par compte, du plus récent au plus ancien (Mon compte, BO).
-- UNE instruction par fichier : `CREATE INDEX CONCURRENTLY` ne s'exécute pas
-- dans une transaction. Idempotente ; un index laissé INVALIDE est reconstruit
-- (`migration-index.ts`).
--
-- INDEX OPTIONNEL : sans lui, la lecture parcourt la table — plus lent,
-- jamais faux.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS account_data_use_preference_events_account_idx
  ON account_data_use_preference_events (account_id, occurred_at DESC);
