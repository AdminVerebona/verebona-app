-- verebona:optional-index
-- Migration 0371 (index 1/1) : journal des réexamens « À traiter » T3 (lot
-- 54A) — lecture par compte (et action) ordonnée dans le temps, purge par
-- compte. UNE instruction par fichier : `CREATE INDEX CONCURRENTLY` ne
-- s'exécute pas dans une transaction. Idempotente ; un index laissé INVALIDE
-- est reconstruit (`migration-index.ts`).
CREATE INDEX CONCURRENTLY IF NOT EXISTS t3_open_action_evaluations_account_idx
  ON t3_open_action_evaluations (account_id, created_at);
