-- Migration 0859 (index 1/1) : lot 99A — dernier passage T3 réussi d'un compte,
-- lu par le préfiltre du balayage planifié (`t3-queue.ts`,
-- `listSweepAccountsFromDb`) pour ne remettre en file que les comptes qui ont
-- réellement changé depuis.
-- UNE instruction par fichier : `CREATE INDEX CONCURRENTLY` ne s'exécute pas
-- dans une transaction. Idempotente ; un index laissé INVALIDE est reconstruit
-- (`migration-index.ts`).
--
-- INDEX OPTIONNEL : sans lui, le préfiltre lit les passages du compte — plus
-- lent, jamais faux.
-- verebona:optional-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS account_reconciliation_runs_done_idx
  ON account_reconciliation_runs (account_id, finished_at DESC) WHERE status IN ('completed', 'partial');
