-- Migration 0374 (index 1/1) : historique « Isolation des comptes » (lot 54,
-- SEC-07/08) — dernières exécutions et dernier contrôle complet, par date.
-- UNE instruction par fichier : `CREATE INDEX CONCURRENTLY` ne s'exécute pas
-- dans une transaction. Idempotente ; un index laissé INVALIDE est reconstruit
-- (`migration-index.ts`).
--
-- INDEX OPTIONNEL : petite table (une ligne par contrôle) ; sans lui la
-- lecture parcourt la table — plus lente, jamais fausse.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS account_isolation_checks_finished_idx
  ON account_isolation_checks (finished_at DESC, id DESC);
