-- Migration 0886 (index 2/2) : séquence de fin d'essai — sélection des essais
-- dont un jalon (J−2 … J+80) est dû, par date de fin d'essai.
-- UNE instruction par fichier : `CREATE INDEX CONCURRENTLY` ne s'exécute pas
-- dans une transaction. Idempotente ; un index laissé INVALIDE est reconstruit
-- (`migration-index.ts`).
--
-- INDEX OPTIONNEL : sans lui, la tâche horaire parcourt les abonnements — plus
-- lent, jamais faux.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS account_subscriptions_trial_ends_at_idx
  ON account_subscriptions (trial_ends_at) WHERE trial_ends_at IS NOT NULL;
