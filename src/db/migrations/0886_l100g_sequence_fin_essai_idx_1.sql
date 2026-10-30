-- Migration 0886 (index 1/2) : séquence de fin d'essai — messages encore
-- ouverts (supervision BO, reprise des messages en attente).
-- UNE instruction par fichier : `CREATE INDEX CONCURRENTLY` ne s'exécute pas
-- dans une transaction. Idempotente ; un index laissé INVALIDE est reconstruit
-- (`migration-index.ts`).
--
-- INDEX OPTIONNEL : sans lui, la supervision parcourt la table — plus lent,
-- jamais faux.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS trial_lifecycle_messages_status_idx
  ON trial_lifecycle_messages (status, window_ends_at);
